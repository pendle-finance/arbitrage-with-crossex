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
  type CapitalBasis,
  type DealFillRecord,
  type PerpFundingEntry,
  type PerpFundingLedger,
  type PerpPositionLike,
} from '../../core/boros/returns';
import { decodeMembership, type PerpFillRecord } from '../../core/boros/partition';
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

/** How far before the earliest live position's open to ask for fills: an order
 * that rested as a maker was placed well before the position's first fill, and
 * a book rebuilt across venues reaches back further still. */
const FILL_LOOKBACK_MS = 48 * 3_600_000;

/** `from` is MILLISECONDS and the venue rejects anything before 2025-01-01
 * ("[from] must be greater than or equal to 1735689600000"), so a lookback
 * that runs off the start of the window has to be clamped, not sent. */
const FILL_FROM_FLOOR_MS = 1_735_689_600_000;

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

/**
 * The account's own fill history, which is what splits one venue's netted
 * position back into the strategies that built it.
 *
 * Each row carries the executed price, its OWN fee, and `text` — the client
 * order id this engine writes — so a fill rejoins its deal even when the local
 * journal is gone (a redeploy, a different machine). Fills from other clients
 * come back too; they simply carry no joinable id and fall through to the
 * proximity tier.
 *
 * Bounded the same way the funding ledger is: page to a hard cap, and if the
 * cap is hit, return what was read rather than a partial-looking whole — the
 * partition then reconciles on less evidence and says so.
 */
async function fetchPerpFills(
  deps: AppDeps,
  positions: PerpPositionLike[],
): Promise<{ fills: PerpFillRecord[]; capped: boolean } | null> {
  const opens = positions
    .map((p) => Number(p.createTime))
    .filter((n) => Number.isFinite(n) && n > 0)
    .map((n) => (n < 1e12 ? n * 1000 : n));
  if (!opens.length) return null;
  const from = Math.max(FILL_FROM_FLOOR_MS, Math.min(...opens) - FILL_LOOKBACK_MS);

  const out: PerpFillRecord[] = [];
  let capped = false;
  for (let page = 1; page <= BOOK_MAX_PAGES; page += 1) {
    const { body } = await deps.getClients().crossEx.listCrossexHistoryTrades({
      page,
      limit: BOOK_PAGE_LIMIT,
      from,
    });
    for (const t of body) {
      const qty = Number(t.qty);
      const price = Number(t.price);
      const time = Number(t.createTime);
      const side = String(t.side ?? '').toUpperCase();
      if (!(qty > 0) || !(price > 0) || !(time > 0)) continue;
      if (side !== 'BUY' && side !== 'SELL') continue;
      out.push({
        symbol: String(t.symbol ?? ''),
        side,
        qty,
        price,
        // The venue reports a fee per fill; sign is not documented, and it is
        // a cost either way (same doctrine as the position-level `fee`).
        feeUsd: Math.abs(Number(t.fee) || 0),
        timeSec: epochToSec(time),
        text: String(t.text ?? ''),
      });
    }
    if (body.length < BOOK_PAGE_LIMIT) break;
    if (page === BOOK_MAX_PAGES) capped = true;
  }
  return { fills: out, capped };
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
      const query = req.query as {
        fresh?: string;
        since?: string;
        partition?: string;
        capital?: string;
      };
      const fresh = query.fresh === '1';

      // User-asserted sizes for the split. Unreadable input degrades to the
      // solved proposal with a warning — never a 400: the rest of the view is
      // still correct, and a bad link must not take the page down.
      const partition = query.partition || '';
      const membership = partition ? decodeMembership(partition) : null;
      const partitionWarning =
        partition && membership === null
          ? "Couldn't read the saved position split — showing the automatic one."
          : undefined;

      // How much capital a Boros position is said to tie up. Default keeps the
      // posted-balance reading every existing number was computed on; `im`
      // counts only what the legs post, which is what a collateral account
      // shared with other trading needs.
      let capitalBasis: CapitalBasis = 'balance';
      if (query.capital !== undefined && query.capital !== '') {
        if (query.capital !== 'balance' && query.capital !== 'im') {
          throw new CoreError("invalid capital (expected 'balance' or 'im')", 'validation');
        }
        capitalBasis = query.capital;
      }

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
      /** Zones whose history came back truncated by the page cap. Grouping may
       * not reason from absence on these — see fetchBorosTransactions. */
      const truncatedZones: number[] = [];
      const txnsByToken = new Map<number, BorosTxn[]>(
        await Promise.all(
          activeTokenIds.map(async (tokenId): Promise<[number, BorosTxn[]]> => {
            const { value } = await deps.cache.get(
              `boros:txns:${address}:${tokenId}`,
              TTL.boros,
              () => fetchBorosTransactions(fetchImpl, address, tokenId),
              { fresh },
            );
            if (!value.complete) truncatedZones.push(tokenId);
            return [tokenId, value.txns];
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

      // Three reads that depend only on `perpPositions` and on nothing from
      // each other. Awaited in turn they cost up to 21 serialized Gate
      // round-trips (each history read pages up to BOOK_MAX_PAGES) on a route
      // the browser polls every 30 seconds; concurrently, about 10. Each keeps
      // its own catch, so one failing still degrades only its own feature.
      const hasPositions = perpPositions !== null && perpPositions.length > 0;
      const positions = perpPositions ?? [];
      const fillWarnings: string[] = [];
      if (truncatedZones.length > 0) {
        // Silence here would be the same lie the fill-history cap guards
        // against: the split degrades to proximity and the user cannot tell a
        // missing record from a page cap.
        fillWarnings.push(
          'Only the most recent Boros transactions could be read, so an older position may be split by proximity instead of by the fills that built it.',
        );
      }
      const [venueFees, perpFunding, perpFills] = await Promise.all([
        // Venue fee schedule for the exit-cost estimate (shared cache key with
        // /api/fees). Unavailable → feesUsd.future.perpExitFeesUsd reports
        // null, never a guess.
        (async (): Promise<VenueFeeRow[] | null> => {
          if (perpPositions === null) return null;
          try {
            const { value } = await deps.cache.get(
              'fees',
              TTL.static,
              async () => (await deps.getClients().crossEx.getCrossexFee()).body,
              { fresh },
            );
            return value as VenueFeeRow[];
          } catch {
            return null;
          }
        })(),
        // FUNDING_FEE ledger — lets returns.ts measure a perp leg's funding
        // from the strategy clock start when the position predates it.
        // Unavailable → the leg keeps Gate's since-open counter and warns.
        (async (): Promise<PerpFundingLedger | null> => {
          if (!hasPositions) return null;
          try {
            const { value } = await deps.cache.get(
              'fundingBook',
              TTL.historyOrders,
              () => fetchFundingLedger(deps, positions),
              { fresh },
            );
            return value;
          } catch {
            return null;
          }
        })(),
        // Venue fill history — the execution record the partition is rebuilt
        // from. Unavailable (rate limit, older account) → the split falls back
        // to price/time proximity and labels itself a proposal.
        (async (): Promise<PerpFillRecord[] | null> => {
          if (!hasPositions) return null;
          try {
            const { value } = await deps.cache.get(
              'fillHistory',
              TTL.fills,
              () => fetchPerpFills(deps, positions),
              { fresh },
            );
            if (value?.capped) {
              fillWarnings.push(
                "Only the most recent fills could be read from CrossEx, so an older position may be split by price and open-time proximity instead of by the fills that built it.",
              );
            }
            return value?.fills ?? null;
          } catch (err) {
            // Silence here would be a lie: the split falls back to proximity
            // and tells the user no execution record explained the position,
            // when in fact one exists and could not be read. Same doctrine as
            // the funding ledger — report the coverage, never imply absence.
            fillWarnings.push(
              `Couldn't read your CrossEx fill history right now (${classifyGateError(err).category}) — positions sharing a venue leg are split by price and open-time proximity until it returns.`,
            );
            return null;
          }
        })(),
      ]);

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
        perpFills,
        membership,
        capitalBasis,
        borosHistoryComplete: truncatedZones.length === 0,
        nowSec: Math.floor(Date.now() / 1000),
      });
      if (partitionWarning) fillWarnings.push(partitionWarning);
      if (fillWarnings.length) result.warnings = [...result.warnings, ...fillWarnings];
      return reply.ok(result, { stale: stalePerps });
    });
  };
}
