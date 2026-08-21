/**
 * GET /api/strategy/:address — 4-leg strategy returns for an EVM address.
 * Boros legs come from the public Boros backend (no auth); perp legs reuse the
 * connected Gate account's positions. Works Boros-only when Gate has no keys —
 * the feature is address-driven and must not 503 behind Gate configuration.
 */
import type { FastifyInstance } from 'fastify';
import {
  fetchBorosCollaterals,
  fetchBorosMarkets,
  fetchBorosTransactions,
  resolveBorosFetch,
  resolveCollateralPricesUsd,
  type BorosTxn,
  type FetchLike,
} from '../../core/boros/client';
import {
  buildStrategies,
  type DealFillRecord,
  type PerpFundingEntry,
  type PerpFundingLedger,
  type PerpPositionLike,
} from '../../core/boros/returns';
import type { VenueFeeRow } from '../../core/estimate/fees';
import { classifyGateError, CoreError } from '../../core/errors';
import type { AppDeps } from '../app';
import { TTL } from '../cache';

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Structural subset of the SDK's CrossexAccountBookRecord. */
interface AccountBookRowLike {
  statementType?: string;
  businessId?: string;
  change?: string;
  createTime?: string;
}

const epochToSec = (n: number): number => (n < 1e12 ? Math.floor(n) : Math.floor(n / 1000));

const BOOK_PAGE_LIMIT = 200;
const BOOK_MAX_PAGES = 10;

/**
 * Per-position FUNDING_FEE ledger from the CrossEx account book (businessId =
 * `{positionId}_{fundingTs}`). Fetched from just before the earliest open of
 * the CURRENT positions — funding cannot predate its position, so an
 * uncapped fetch is complete for them (coversFromSec 0). If pagination hits
 * the cap, coverage is bounded by the oldest fetched row — reported honestly
 * so returns.ts falls back (with a warning) instead of under-counting.
 */
async function fetchFundingLedger(
  deps: AppDeps,
  positions: PerpPositionLike[],
): Promise<PerpFundingLedger | null> {
  const opens = positions
    .map((p) => Number(p.createTime))
    .filter((n) => Number.isFinite(n) && n > 0)
    .map((n) => (n < 1e12 ? n * 1000 : n));
  if (!opens.length) return null;
  const fromMs = Math.min(...opens) - 3_600_000;

  const rows: AccountBookRowLike[] = [];
  let capped = false;
  for (let page = 1; page <= BOOK_MAX_PAGES; page += 1) {
    const { body } = await deps.getClients().crossEx.listCrossexAccountBook({
      statementType: 'FUNDING_FEE',
      from: fromMs,
      limit: BOOK_PAGE_LIMIT,
      page,
    });
    const batch = body as AccountBookRowLike[];
    rows.push(...batch);
    if (batch.length < BOOK_PAGE_LIMIT) break;
    if (page === BOOK_MAX_PAGES) capped = true;
  }

  const byPosition = new Map<string, PerpFundingEntry[]>();
  let oldestSec = Number.POSITIVE_INFINITY;
  for (const r of rows) {
    const positionId = String(r.businessId ?? '').split('_')[0];
    const changeUsd = Number(r.change);
    const t = Number(r.createTime);
    if (!positionId || !Number.isFinite(changeUsd) || !Number.isFinite(t) || t <= 0) continue;
    const timeSec = epochToSec(t);
    oldestSec = Math.min(oldestSec, timeSec);
    const list = byPosition.get(positionId) ?? [];
    list.push({ positionId, timeSec, changeUsd });
    byPosition.set(positionId, list);
  }
  return { byPosition, coversFromSec: capped ? oldestSec : 0 };
}

export function strategyRoutes(deps: AppDeps) {
  const fetchImpl: FetchLike = resolveBorosFetch(deps.borosFetch);

  return async function plugin(app: FastifyInstance): Promise<void> {
    app.get('/strategy/:address', async (req, reply) => {
      const raw = (req.params as { address: string }).address;
      if (!EVM_ADDRESS_RE.test(raw)) {
        throw new CoreError('invalid EVM address (expected 0x + 40 hex chars)', 'validation');
      }
      const address = raw.toLowerCase();
      const query = req.query as { fresh?: string; since?: string };
      const fresh = query.fresh === '1';

      // Optional APR-clock override: unix seconds or a Date.parse-able date.
      let clockStartOverrideSec: number | undefined;
      if (query.since !== undefined && query.since !== '') {
        const n = /^\d+$/.test(query.since)
          ? Number(query.since)
          : Math.floor(Date.parse(query.since) / 1000);
        if (!Number.isFinite(n) || n <= 0) {
          throw new CoreError('invalid since (expected unix seconds or an ISO date)', 'validation');
        }
        if (n >= Math.floor(Date.now() / 1000)) {
          throw new CoreError('since must be in the past', 'validation');
        }
        clockStartOverrideSec = n;
      }

      const [markets, zones] = await Promise.all([
        deps.cache
          .get('boros:markets', TTL.boros, () => fetchBorosMarkets(fetchImpl), { fresh })
          .then((r) => r.value),
        deps.cache
          .get(`boros:collaterals:${address}`, TTL.boros, () => fetchBorosCollaterals(fetchImpl, address), {
            fresh,
          })
          .then((r) => r.value),
      ]);

      // Txn history only for zones that actually hold positions (fees + open times).
      const activeTokenIds = zones
        .filter((z) =>
          [...(z.cross ? [z.cross] : []), ...z.isolated].some((g) =>
            g.marketPositions.some((p) => Number(p.notionalSize) !== 0),
          ),
        )
        .map((z) => z.tokenId);
      const txnsByToken = new Map<number, BorosTxn[]>(
        await Promise.all(
          activeTokenIds.map(async (tokenId): Promise<[number, BorosTxn[]]> => {
            const { value } = await deps.cache.get(
              `boros:txns:${address}:${tokenId}`,
              TTL.boros,
              () => fetchBorosTransactions(fetchImpl, address, tokenId),
              { fresh },
            );
            return [tokenId, value];
          }),
        ),
      );

      // Perp legs are an overlay from the CONNECTED Gate account (possibly a
      // different owner than the entered address). Gate being unconfigured or
      // failing must degrade to a Boros-only response, not an error — but a
      // transient failure (429/network) must not masquerade as "no credentials".
      let perpPositions: PerpPositionLike[] | null = null;
      let perpsUnavailableWarning: string | undefined;
      let stalePerps = false;
      try {
        const { value, stale } = await deps.cache.get(
          'positions',
          TTL.live,
          async () => (await deps.getClients().crossEx.listCrossexPositions()).body,
          { fresh },
        );
        perpPositions = value as PerpPositionLike[];
        stalePerps = stale;
      } catch (err) {
        const category = classifyGateError(err).category;
        if (category !== 'not-configured') {
          perpsUnavailableWarning = `Couldn't load Gate positions right now (${category}) — showing the Boros legs only; the perp overlay will return on the next refresh.`;
        }
      }

      // Venue fee schedule for the exit-cost estimate (shared cache key with
      // /api/fees). Unavailable → feesUsd.future.perpExitFeesUsd reports null,
      // never a guess.
      let venueFees: VenueFeeRow[] | null = null;
      if (perpPositions !== null) {
        try {
          const { value } = await deps.cache.get(
            'fees',
            TTL.static,
            async () => (await deps.getClients().crossEx.getCrossexFee()).body,
            { fresh },
          );
          venueFees = value as VenueFeeRow[];
        } catch {
          venueFees = null;
        }
      }

      // FUNDING_FEE ledger — lets returns.ts measure a perp leg's funding from
      // the strategy clock start when the position predates it. Unavailable →
      // the leg keeps Gate's since-open counter and carries a warning.
      let perpFunding: PerpFundingLedger | null = null;
      if (perpPositions !== null && perpPositions.length > 0) {
        const positions = perpPositions;
        try {
          const { value } = await deps.cache.get(
            'fundingBook',
            TTL.historyOrders,
            () => fetchFundingLedger(deps, positions),
            { fresh },
          );
          perpFunding = value;
        } catch {
          perpFunding = null;
        }
      }

      // Finished deals from the local journal — lets returns.ts chain the true
      // entry slippage of a book rebuilt across venues. A synchronous local
      // SQLite read (no cache, no network); absent engine (public mode) or any
      // read failure degrades silently to the live-entries-only behavior.
      let dealFills: DealFillRecord[] | null = null;
      if (deps.engine && perpPositions !== null && perpPositions.length > 0) {
        try {
          dealFills = deps.engine.store
            .dealFillReports()
            .map((r) => ({
              dealId: r.dealId,
              aContract: r.aContract,
              aSide: r.aSide as DealFillRecord['aSide'],
              bContract: r.bContract,
              bSide: r.bSide as DealFillRecord['bSide'],
              aFilled: Number(r.aFilled),
              bFilled: Number(r.bFilled),
              aAvgFill: Number(r.aAvgFill),
              bAvgFill: Number(r.bAvgFill),
              createdAtSec: epochToSec(r.createdAtMs),
            }))
            .filter(
              (d) =>
                (d.aSide === 'BUY' || d.aSide === 'SELL') &&
                (d.bSide === 'BUY' || d.bSide === 'SELL') &&
                [d.aFilled, d.bFilled, d.aAvgFill, d.bAvgFill].every(
                  (n) => Number.isFinite(n) && n > 0,
                ),
            );
        } catch {
          dealFills = null;
        }
      }

      const result = buildStrategies({
        address,
        zones,
        markets,
        txnsByToken,
        pricesUsd: resolveCollateralPricesUsd(markets),
        perpPositions,
        perpsUnavailableWarning,
        clockStartOverrideSec,
        venueFees,
        perpFunding,
        dealFills,
        nowSec: Math.floor(Date.now() / 1000),
      });
      return reply.ok(result, { stale: stalePerps });
    });
  };
}
