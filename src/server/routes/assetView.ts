/**
 * GET /api/asset-view/:address — the ASSET-GROUPED tracking view.
 *
 * No strategies, no enrollment, no maturity lifecycle: every leg (perp and
 * Boros) is grouped by its underlying asset (ETH, BTC, …) and the numbers are
 * LIFETIME sums since a caller-chosen start instant, taken from the venues'
 * own records:
 *
 *  - Open perps: the live positions feed — upnl / cumulative fundingFee /
 *    fee / initialMargin are all venue-reported for the current position.
 *  - Closed perps: /crossex/history_positions — the venue reports each closed
 *    position's whole-lifetime closedPnl, fundingFee and fee directly.
 *  - Boros (open AND closed, uniformly): the per-settlement event ledger plus
 *    /pnl/transactions fills, both timestamped, summed per market since the
 *    start instant. The live zones feed adds the open legs' MtM and IM.
 *
 * Nothing is reconstructed and nothing is stored: the response is a pure
 * function of (address, since, venue records), so the same inputs render the
 * same numbers on any device.
 *
 * Double-count guard: a Boros OPEN leg's cumulative `rateSettlementPnl` and
 * the settlement-events sums cover the same flows. The per-leg figure is
 * returned for display only; PnL totals must be built from `borosHistory`
 * (which also covers closed/matured positions) — never from both.
 *
 * Coverage honesty (same doctrine as the strategy feed): every history source
 * reports how far back it actually read. A window older than what a venue
 * still serves comes back flagged, never silently zeroed.
 */
import type { FastifyInstance } from 'fastify';
import {
  fetchBorosCollaterals,
  fetchBorosMarket,
  fetchBorosMarkets,
  fetchBorosTransactions,
  fetchSettlementEvents,
  norm18,
  resolveBorosFetch,
  resolveCollateralPricesUsd,
  BOROS_TOKEN_SYMBOLS,
  type BorosMarket,
  type FetchLike,
} from '../../core/boros/client';
import { normalizeVenue, type PerpPositionLike } from '../../core/boros/returns';
import { classifyGateError, CoreError } from '../../core/errors';
import { parseSymbol } from '../../core/numbers';
import type { AppDeps } from '../app';
import { TTL } from '../cache';

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const PAGE_LIMIT = 200;
const MAX_PAGES = 10;

const fin = (v: string | number | undefined | null): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const epochToSec = (n: number): number => (n < 1e12 ? Math.floor(n) : Math.floor(n / 1000));

// ---------------------------------------------------------------------------
// Response shape (mirrored in web/src/api/types.ts)
// ---------------------------------------------------------------------------

export interface AssetPerpOpenOut {
  symbol: string;
  venue: string;
  side: 'LONG' | 'SHORT';
  /** |qty| in the base coin. */
  qty: number;
  notionalUsd: number;
  entryPrice: number;
  markPrice: number;
  leverage: number;
  upnlUsd: number;
  /** Venue-reported cumulative funding for the CURRENT position (signed,
   * positive = received). Whole position lifetime — not windowed to `since`. */
  fundingUsd: number;
  /** Cumulative trading fees, positive cost. */
  feesUsd: number;
  imUsd: number;
  openedAt: number | null;
}

/** Closed positions since `since`, aggregated per symbol. Whole-lifetime
 * venue numbers per position; a position closed after `since` but opened
 * before it counts in full (documented approximation of the start date). */
export interface AssetPerpClosedRowOut {
  closedAt: number | null;
  qty: number;
  openPx: number;
  closePx: number;
  priceUsd: number;
  fundingUsd: number;
  feesUsd: number;
  /** COMPLETE_CLOSED = the position ended (a later reopen is a NEW id, with
   * its own books); anything else is a partial slice of a live id. */
  complete: boolean;
  /** Funding/fees booked on the surviving open row (same position id). */
  dedupedIntoOpen: boolean;
}

export interface AssetPerpClosedOut {
  symbol: string;
  venue: string;
  closedPnlUsd: number;
  fundingUsd: number;
  feesUsd: number;
  count: number;
  lastClosedAt: number | null;
  /** True when this batch's funding/fees were zeroed because the SURVIVING
   * open position's cumulatives already carry them (split-position dedupe) —
   * the close wasn't free, its costs are just booked on the open row. */
  dedupedIntoOpen?: boolean;
  /** The individual closed rows (newest first, capped) — feeds the
   * completed-history section. */
  rows: AssetPerpClosedRowOut[];
}

export interface AssetBorosOpenOut {
  marketId: number;
  venue: string;
  maturity: number;
  collateral: string;
  /** LONG = pays fixed, receives floating (hedges a LONG perp's funding). */
  side: 'LONG' | 'SHORT';
  /** |notionalSize| in the collateral token. */
  sizeToken: number;
  notionalUsd: number;
  entryApr: number;
  markApr: number;
  floatingApr: number;
  /** Cumulative settlement of the CURRENT position, net of settle fees.
   * DISPLAY ONLY — totals come from borosHistory (see the double-count
   * guard in the header). */
  settleUsd: number;
  /** Mark value of the remaining rate stream (excluded from headline PnL). */
  mtmUsd: number;
  imUsd: number;
}

/** Per-market history sums since `since` — covers open, closed and matured
 * positions uniformly (settlements and fills are account-level events). */
export interface AssetBorosHistoryOut {
  marketId: number;
  venue: string;
  maturity: number;
  /** Σ settlement amounts, net of per-settlement fees (the venue reports net). */
  settleUsd: number;
  /** The fees inside that net, positive cost (display; do not re-subtract). */
  settleFeeUsd: number;
  /** Σ realized trade PnL, net of trade fees. */
  tradePnlUsd: number;
  /** The trade fees inside that net, positive cost (display; do not re-subtract). */
  tradeFeeUsd: number;
}

export interface AssetGroupOut {
  base: string;
  /** USD price of the underlying (0 = no live market to price it from). */
  priceUsd: number;
  /** Earliest activity instant that entered THIS asset's sums (APR clock). */
  earliestSec: number | null;
  perpOpen: AssetPerpOpenOut[];
  perpClosed: AssetPerpClosedOut[];
  borosOpen: AssetBorosOpenOut[];
  borosHistory: AssetBorosHistoryOut[];
}

export interface AssetViewOut {
  sinceSec: number;
  nowSec: number;
  assets: AssetGroupOut[];
  /** Earliest activity instant that entered any sum (unix sec) — the APR
   * clock floor; null when nothing was found at all. */
  earliestSec: number | null;
  coverage: {
    /** Oldest settlement row read when the page cap was hit; 0 = complete. */
    settlementsFromSec: number;
    /** Oldest closed-position row read when the page cap was hit; 0 = complete. */
    perpClosedFromSec: number;
    borosTxnsComplete: boolean;
  };
  warnings: string[];
}

// ---------------------------------------------------------------------------

/** Structural subset of the SDK's CrossexHistoricalPosition. */
interface HistoryPositionLike {
  symbol?: string;
  positionId?: string;
  closedType?: string;
  closedPnl?: string;
  fundingFee?: string;
  fee?: string;
  liqFee?: string;
  openAvgPrice?: string;
  closedAvgPrice?: string;
  closedQty?: string;
  updateTime?: string;
}

async function fetchClosedPositions(
  deps: AppDeps,
): Promise<{ rows: HistoryPositionLike[]; coversFromSec: number }> {
  const rows: HistoryPositionLike[] = [];
  let capped = false;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    // ⚠ NO `from` here: the venue filters that parameter by the position's
    // OPEN time, so a window starting mid-life dropped the very closed row
    // whose realized price PnL offsets the surviving legs' uPnL (an Aug-24
    // window lost the Jul-31-opened +\$831k close and reported −\$829k).
    // The route already windows by CLOSE time (updateTime) after the fetch.
    const { body } = await deps.getClients().crossEx.listCrossexHistoryPositions({
      page,
      limit: PAGE_LIMIT,
    });
    const batch = body as HistoryPositionLike[];
    rows.push(...batch);
    if (batch.length < PAGE_LIMIT) break;
    if (page === MAX_PAGES) capped = true;
  }
  let oldest = Number.POSITIVE_INFINITY;
  for (const r of rows) {
    const t = fin(r.updateTime);
    if (t > 0) oldest = Math.min(oldest, epochToSec(t));
  }
  return { rows, coversFromSec: capped && Number.isFinite(oldest) ? oldest : 0 };
}

export function assetViewRoutes(deps: AppDeps) {
  const fetchImpl: FetchLike = resolveBorosFetch(deps.borosFetch);

  return async function plugin(app: FastifyInstance): Promise<void> {
    app.get('/asset-view/:address', async (req, reply) => {
      const raw = (req.params as { address: string }).address;
      if (!EVM_ADDRESS_RE.test(raw)) {
        throw new CoreError('invalid EVM address (expected 0x + 40 hex chars)', 'validation');
      }
      const address = raw.toLowerCase();
      const query = req.query as { since?: string; fresh?: string };
      const fresh = query.fresh === '1';
      const nowSec = Math.floor(Date.now() / 1000);

      let sinceSec = 0;
      if (query.since !== undefined && query.since !== '') {
        const n = /^\d+$/.test(query.since)
          ? Number(query.since)
          : Math.floor(Date.parse(query.since) / 1000);
        if (!Number.isFinite(n) || n < 0) {
          throw new CoreError('invalid since (expected unix seconds or an ISO date)', 'validation');
        }
        if (n >= nowSec) {
          throw new CoreError('since must be in the past', 'validation');
        }
        sinceSec = n;
      }

      const warnings: string[] = [];

      // --- Boros reads (shared cache keys with the strategy feed) ----------
      const [markets, zones, settlements] = await Promise.all([
        deps.cache
          .get('boros:markets', TTL.boros, () => fetchBorosMarkets(fetchImpl), { fresh })
          .then((r) => r.value),
        deps.cache
          .get(`boros:collaterals:${address}`, TTL.boros, () => fetchBorosCollaterals(fetchImpl, address), {
            fresh,
          })
          .then((r) => r.value),
        deps.cache
          .get(
            `boros:settlements:${address}:0:${Math.floor(sinceSec / 3600)}`,
            TTL.boros,
            () => fetchSettlementEvents(fetchImpl, address, 0, sinceSec),
            { fresh },
          )
          .then((r) => r.value),
      ]);

      const marketById = new Map<number, BorosMarket>(markets.map((m) => [m.marketId, m]));
      const collateralPriceUsd = resolveCollateralPricesUsd(markets);
      const tokenPrice = (tokenId: number): number | null => collateralPriceUsd.get(tokenId) ?? null;

      // Txns for EVERY zone the account has — history sums must include
      // markets whose positions are long gone, and a fill's zone is the
      // token it settled in, position or not.
      const txnsComplete: boolean[] = [];
      const txnsByToken = new Map<
        number,
        Array<{ marketId: number; time: number; pnlTok: number; feeTok: number }>
      >(
        await Promise.all(
          zones.map(async (z): Promise<[number, Array<{ marketId: number; time: number; pnlTok: number; feeTok: number }>]> => {
            const { value } = await deps.cache.get(
              `boros:txns:${address}:${z.tokenId}`,
              TTL.boros,
              () => fetchBorosTransactions(fetchImpl, address, z.tokenId),
              { fresh },
            );
            txnsComplete.push(value.complete);
            return [
              z.tokenId,
              value.txns.map((t) => ({
                marketId: t.marketId,
                time: t.time,
                pnlTok: norm18(t.pnl),
                feeTok: Math.abs(norm18(t.fee)),
              })),
            ];
          }),
        ),
      );

      // The listing serves LIVE markets only — a matured market drops out of
      // it, taking its history's asset/venue mapping with it. Resolve every
      // id the account's history references but the listing lacks through the
      // by-id endpoint (which still serves matured markets); metadata of a
      // matured market is immutable, so these ride the long static TTL.
      {
        const referenced = new Set<number>();
        for (const ev of settlements.events) referenced.add(ev.marketId);
        for (const txns of txnsByToken.values()) for (const t of txns) referenced.add(t.marketId);
        const unknown = [...referenced].filter((id) => !marketById.has(id));
        const resolved = await Promise.all(
          unknown.map(async (id) => {
            try {
              const { value } = await deps.cache.get(`boros:market:${id}`, TTL.static, () =>
                fetchBorosMarket(fetchImpl, id),
              );
              return value;
            } catch {
              return null; // stays unmapped; counted into the warning below
            }
          }),
        );
        for (const m of resolved) if (m) marketById.set(m.marketId, m);
      }

      // --- Perp reads (degrade to Boros-only, same doctrine as /strategy) --
      let perpPositions: PerpPositionLike[] = [];
      let perpAvailable = true;
      try {
        const { value } = await deps.cache.get(
          'positions',
          TTL.live,
          async () => (await deps.getClients().crossEx.listCrossexPositions()).body,
          { fresh },
        );
        perpPositions = value as PerpPositionLike[];
      } catch (err) {
        perpAvailable = false;
        const category = classifyGateError(err).category;
        if (category !== 'not-configured') {
          warnings.push(
            `Couldn't load Gate positions right now (${category}) — showing the Boros side only.`,
          );
        }
      }

      /**
       * WINDOWED open-leg funding and fees (only when a start date is set).
       * The venue's cumulative fundingFee/fee cover the position's whole
       * life; a window starting mid-life must count only in-window flows.
       * The account book has one FUNDING_FEE row per tick per position —
       * and each row is the amount actually paid AT THE SIZE OF THAT TICK,
       * so summing in-window rows is exact through resizes (a 1000→500 cut
       * before the window contributes only 500-sized rows inside it). Fees
       * come from the per-fill history the same way. If a ledger cannot
       * reach the window start, the cumulative stands with a warning.
       */
      let fundingWindow: Map<string, number> | null = null; // positionId → USD
      let feesWindow: Map<string, number> | null = null; // symbol → USD
      if (perpAvailable && sinceSec > 0) {
        try {
          const { value } = await deps.cache.get(
            `crossex:funding-window:${Math.floor(sinceSec / 3600)}`,
            TTL.boros,
            async () => {
              const rows: Array<{ businessId?: string; change?: string; createTime?: string }> = [];
              for (let page = 1; page <= 25; page += 1) {
                const { body } = await deps.getClients().crossEx.listCrossexAccountBook({
                  statementType: 'FUNDING_FEE',
                  from: sinceSec * 1000 - 3_600_000,
                  limit: PAGE_LIMIT,
                  page,
                });
                rows.push(...(body as typeof rows));
                if ((body as unknown[]).length < PAGE_LIMIT) break;
              }
              const byPosition = new Map<string, number>();
              for (const r of rows) {
                const pid = String(r.businessId ?? '').split('_')[0];
                const t = fin(r.createTime);
                const usd = Number(r.change);
                if (!pid || !Number.isFinite(usd) || epochToSec(t) < sinceSec) continue;
                byPosition.set(pid, (byPosition.get(pid) ?? 0) + usd);
              }
              return byPosition;
            },
            { fresh },
          );
          fundingWindow = value;
        } catch {
          warnings.push(
            'Funding ledger unavailable — open-leg funding shows whole-position cumulatives despite the start date.',
          );
        }
        try {
          const { value } = await deps.cache.get(
            `crossex:fees-window:${Math.floor(sinceSec / 3600)}`,
            TTL.boros,
            async () => {
              const bySymbol = new Map<string, number>();
              for (let page = 1; page <= 25; page += 1) {
                const { body } = await deps.getClients().crossEx.listCrossexHistoryTrades({
                  page,
                  limit: PAGE_LIMIT,
                  from: sinceSec * 1000,
                });
                for (const f of body as Array<{ symbol?: string; fee?: string }>) {
                  const sym = String(f.symbol ?? '');
                  if (!sym) continue;
                  bySymbol.set(sym, (bySymbol.get(sym) ?? 0) + Math.abs(Number(f.fee) || 0));
                }
                if ((body as unknown[]).length < PAGE_LIMIT) break;
              }
              return bySymbol;
            },
            { fresh },
          );
          feesWindow = value;
        } catch {
          warnings.push(
            'Fill history unavailable — perp fees show whole-position cumulatives despite the start date.',
          );
        }
      }

      let closedRows: HistoryPositionLike[] = [];
      let perpClosedFromSec = 0;
      if (perpAvailable) {
        try {
          const { value } = await deps.cache.get(
            'crossex:closed-positions',
            TTL.boros,
            () => fetchClosedPositions(deps),
            { fresh },
          );
          closedRows = value.rows;
          perpClosedFromSec = value.coversFromSec;
        } catch (err) {
          const category = classifyGateError(err).category;
          warnings.push(
            `Couldn't load closed-position history (${category}) — totals cover open positions and Boros only.`,
          );
        }
      }

      // --- Group by asset --------------------------------------------------
      const groups = new Map<string, AssetGroupOut>();
      const groupFor = (base: string): AssetGroupOut => {
        const key = base.toUpperCase();
        let g = groups.get(key);
        if (!g) {
          g = {
            base: key,
            priceUsd: 0,
            earliestSec: null,
            perpOpen: [],
            perpClosed: [],
            borosOpen: [],
            borosHistory: [],
          };
          groups.set(key, g);
        }
        return g;
      };
      let earliestSec = Number.POSITIVE_INFINITY;
      const seen = (g: AssetGroupOut, t: number | null | undefined): void => {
        if (!t || !Number.isFinite(t) || t <= 0) return;
        earliestSec = Math.min(earliestSec, t);
        if (g.earliestSec === null || t < g.earliestSec) g.earliestSec = t;
      };

      // Open perps.
      for (const pos of perpPositions) {
        const qty = fin(pos.positionQty);
        if (qty === 0) continue;
        const { exchange, base } = parseSymbol(pos.symbol ?? '');
        if (!base) continue;
        const openedAtRaw = fin(pos.createTime);
        const openedAt = openedAtRaw > 0 ? epochToSec(openedAtRaw) : null;
        const notionalUsd = Math.abs(fin(pos.positionValue));
        const absQty = Math.abs(qty);
        const g = groupFor(base);
        seen(g, openedAt);
        if (g.priceUsd === 0 && absQty > 0) g.priceUsd = notionalUsd / absQty;
        const pid = (pos as { positionId?: string }).positionId ?? '';
        g.perpOpen.push({
          symbol: pos.symbol ?? '',
          venue: normalizeVenue(exchange),
          side: (pos.positionSide ?? '').toUpperCase() === 'SHORT' || qty < 0 ? 'SHORT' : 'LONG',
          qty: absQty,
          notionalUsd,
          entryPrice: fin(pos.entryPrice),
          markPrice: fin((pos as { markPrice?: string }).markPrice),
          leverage: fin(pos.leverage),
          upnlUsd: fin(pos.upnl),
          fundingUsd:
            fundingWindow !== null && pid ? (fundingWindow.get(pid) ?? 0) : fin(pos.fundingFee),
          feesUsd:
            feesWindow !== null && pos.symbol
              ? (feesWindow.get(pos.symbol) ?? 0)
              : Math.abs(fin(pos.fee)),
          imUsd: Math.abs(fin(pos.initialMargin)),
          openedAt,
        });
      }

      // Closed perps since T0, aggregated per symbol.
      //
      // ⚠ SPLIT-POSITION DEDUPE, BY POSITION ID (ledger-verified 2026-09-04):
      // a PARTIAL close's funding/fee ride the SURVIVING open row's
      // cumulatives (the open row's cumulative equals the account-book total
      // exactly), so counting the closed slice again double-charges it. The
      // match is by position id — a close-and-REOPEN mints a new id, and the
      // old COMPLETE_CLOSED row rightly keeps its own funding/fees (an
      // earlier symbol-based match would have swallowed them).
      const openIds = new Set(
        perpPositions.map((p) => (p as { positionId?: string }).positionId ?? '').filter(Boolean),
      );
      const closedBySymbol = new Map<string, AssetPerpClosedOut>();
      for (const r of closedRows) {
        const closedAtRaw = fin(r.updateTime);
        const closedAt = closedAtRaw > 0 ? epochToSec(closedAtRaw) : null;
        if (sinceSec > 0 && closedAt !== null && closedAt < sinceSec) continue;
        const { exchange, base } = parseSymbol(r.symbol ?? '');
        if (!base) continue;
        seen(groupFor(base), closedAt);
        const key = r.symbol ?? '';
        let agg = closedBySymbol.get(key);
        if (!agg) {
          agg = {
            symbol: key,
            venue: normalizeVenue(exchange),
            closedPnlUsd: 0,
            fundingUsd: 0,
            feesUsd: 0,
            count: 0,
            lastClosedAt: null,
            rows: [],
          };
          closedBySymbol.set(key, agg);
          groupFor(base).perpClosed.push(agg);
        }
        const deduped = r.positionId !== undefined && openIds.has(r.positionId);
        agg.closedPnlUsd += fin(r.closedPnl);
        if (!deduped) {
          agg.fundingUsd +=
            fundingWindow !== null && r.positionId
              ? (fundingWindow.get(r.positionId) ?? 0)
              : fin(r.fundingFee);
          agg.feesUsd += Math.abs(fin(r.fee)) + Math.abs(fin(r.liqFee));
        } else {
          agg.dedupedIntoOpen = true;
        }
        if (agg.rows.length < 20) {
          agg.rows.push({
            closedAt,
            qty: fin(r.closedQty),
            openPx: fin(r.openAvgPrice),
            closePx: fin(r.closedAvgPrice),
            priceUsd: fin(r.closedPnl),
            fundingUsd: deduped
              ? 0
              : fundingWindow !== null && r.positionId
                ? (fundingWindow.get(r.positionId) ?? 0)
                : fin(r.fundingFee),
            feesUsd: deduped ? 0 : Math.abs(fin(r.fee)) + Math.abs(fin(r.liqFee)),
            complete: String(r.closedType ?? '') === 'COMPLETE_CLOSED',
            dedupedIntoOpen: deduped,
          });
        }
        agg.count += 1;
        if (closedAt !== null && (agg.lastClosedAt === null || closedAt > agg.lastClosedAt)) {
          agg.lastClosedAt = closedAt;
        }
      }

      // Open Boros legs.
      let unpricedZones = 0;
      for (const zone of zones) {
        const px = tokenPrice(zone.tokenId);
        const zoneGroups = [...(zone.cross ? [zone.cross] : []), ...zone.isolated];
        const hasPositions = zoneGroups.some((mg) => mg.marketPositions.some((p) => norm18(p.notionalSize) !== 0));
        if (px === null) {
          if (hasPositions) unpricedZones += 1;
          continue;
        }
        for (const mg of zoneGroups) {
          for (const p of mg.marketPositions) {
            const sizeSigned = norm18(p.notionalSize);
            if (sizeSigned === 0) continue;
            const market = marketById.get(p.marketId);
            if (!market) continue;
            const g = groupFor(market.base);
            if (g.priceUsd === 0 && market.assetMarkPriceUsd > 0) g.priceUsd = market.assetMarkPriceUsd;
            g.borosOpen.push({
              marketId: p.marketId,
              venue: normalizeVenue(market.venue),
              maturity: market.maturity,
              collateral: BOROS_TOKEN_SYMBOLS[zone.tokenId] ?? `token${zone.tokenId}`,
              side: p.side === 0 || sizeSigned > 0 ? 'LONG' : 'SHORT',
              sizeToken: Math.abs(sizeSigned),
              notionalUsd: Math.abs(sizeSigned) * px,
              entryApr: p.fixedApr,
              markApr: p.markApr,
              floatingApr: market.floatingApr,
              settleUsd: norm18(p.pnl.rateSettlementPnl) * px,
              mtmUsd: norm18(p.pnl.unrealisedPnl) * px,
              imUsd: norm18(p.positionInitialMargin ?? p.initialMargin) * px,
            });
          }
        }
      }
      if (unpricedZones > 0) {
        warnings.push(
          `${unpricedZones} Boros collateral zone(s) hold positions in a token with no live USD price — their legs are excluded from the view.`,
        );
      }

      // Boros history sums per market: settlements + fills since T0.
      interface HistAgg extends AssetBorosHistoryOut {
        _base: string;
      }
      const histByMarket = new Map<number, HistAgg>();
      let unknownMarketRows = 0;
      const histFor = (marketId: number): HistAgg | null => {
        let h = histByMarket.get(marketId);
        if (h) return h;
        const market = marketById.get(marketId);
        if (!market) return null;
        h = {
          marketId,
          venue: normalizeVenue(market.venue),
          maturity: market.maturity,
          settleUsd: 0,
          settleFeeUsd: 0,
          tradePnlUsd: 0,
          tradeFeeUsd: 0,
          _base: market.base,
        };
        histByMarket.set(marketId, h);
        return h;
      };
      for (const ev of settlements.events) {
        if (ev.timeSec < sinceSec) continue;
        const market = marketById.get(ev.marketId);
        const px = market ? tokenPrice(market.tokenId) : null;
        const h = histFor(ev.marketId);
        if (!h || px === null) {
          unknownMarketRows += 1;
          continue;
        }
        seen(groupFor(h._base), ev.timeSec);
        h.settleUsd += ev.settlementToken * px;
        h.settleFeeUsd += ev.feeToken * px;
      }
      for (const [tokenId, txns] of txnsByToken) {
        const px = tokenPrice(tokenId);
        for (const t of txns) {
          if (t.time < sinceSec) continue;
          const h = histFor(t.marketId);
          if (!h || px === null) {
            unknownMarketRows += 1;
            continue;
          }
          seen(groupFor(h._base), t.time);
          h.tradePnlUsd += t.pnlTok * px;
          h.tradeFeeUsd += t.feeTok * px;
        }
      }
      if (unknownMarketRows > 0) {
        warnings.push(
          `${unknownMarketRows} Boros history row(s) reference a market that is no longer listed or cannot be priced — they are excluded from the sums.`,
        );
      }
      for (const h of histByMarket.values()) {
        const { _base, ...out } = h;
        groupFor(_base).borosHistory.push(out);
      }

      // Stable order: biggest live footprint first, then name.
      const assets = [...groups.values()].sort((a, b) => {
        const foot = (g: AssetGroupOut): number =>
          g.perpOpen.reduce((s, l) => s + l.notionalUsd, 0) +
          g.borosOpen.reduce((s, l) => s + l.notionalUsd, 0);
        return foot(b) - foot(a) || a.base.localeCompare(b.base);
      });

      const out: AssetViewOut = {
        sinceSec,
        nowSec,
        assets,
        earliestSec: Number.isFinite(earliestSec) ? earliestSec : null,
        coverage: {
          settlementsFromSec: settlements.coversFromSec,
          perpClosedFromSec,
          borosTxnsComplete: txnsComplete.every(Boolean),
        },
        warnings,
      };
      return reply.ok(out);
    });
  };
}
