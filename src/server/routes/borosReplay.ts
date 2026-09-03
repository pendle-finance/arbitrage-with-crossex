/**
 * POST /boros/replay — the LEDGER REPLAY behind the tracking preview's exact
 * numbers.
 *
 * The client sends its enrollment events (which slice of which leg, since
 * when); this route reconstructs each event's WINDOW from the venues' own
 * per-settlement records and returns exact sums. Nothing is stored — the
 * server stays a pure function of (events, venue history), which is what
 * makes the numbers deterministic across devices and sessions: the same
 * setup replays to the same figures anywhere.
 *
 * Sources:
 *  - Boros: /v1/accounts/settlement-events — one row per periodic settlement
 *    with the position size AT that settlement, so a partial share scales
 *    per-row (qty / that row's size), honestly through resizes. Amounts are
 *    in the market's settlement token; the CLIENT converts to USD with the
 *    price it already holds for the leg.
 *  - CrossEx: the account-book FUNDING_FEE ledger — one row per funding tick
 *    per position, USD-denominated. Shares scale by qty/venueQty (the book
 *    doesn't record per-tick size; flagged `sharedApprox` when partial).
 *
 * Both sources report their own coverage; a window older than what a venue
 * still serves comes back `exact: false` and the client keeps its cached
 * fallback for that event rather than presenting a hole as a zero.
 */
import type { FastifyInstance } from 'fastify';
import {
  fetchBorosCollaterals,
  fetchBorosTransactions,
  fetchSettlementEvents,
  norm18,
  resolveBorosFetch,
  type BorosSettlementEvent,
  type FetchLike,
} from '../../core/boros/client';
import type { AppDeps } from '../app';
import { TTL } from '../cache';

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const MAX_EVENTS = 200;

interface ReplayEventIn {
  id: string;
  kind: 'perp' | 'boros';
  symbol?: string;
  marketId?: number;
  qty: number;
  venueQty: number;
  /** Window start, unix sec. The window end is always "now". */
  t: number;
}

interface ReplayResultOut {
  id: string;
  exact: boolean;
  /** Oldest instant the source ledger covered; 0 = complete. */
  coveredFromSec: number;
  /** Boros events: token-denominated window sums (client converts to USD). */
  settleToken?: number;
  settleFeeToken?: number;
  /** Trade PnL (net of trade fees) and trade fees inside the window — the
   * fills carry timestamps, so these are exact too. */
  tradePnlToken?: number;
  tradeFeeToken?: number;
  /** Perp events: USD window funding, scaled PER TICK by the position size
   * reconstructed from fill history (a leg that was 1,555 ETH before being
   * cut to 325 charges this strategy only its share of the big-size ticks).
   * `sharedApprox` is set only when the fill history could not cover the
   * window, so per-tick sizes fell back to the current size. */
  fundingUsd?: number;
  sharedApprox?: boolean;
}

/** Structural subset of the SDK's account-book record (same as strategy.ts). */
interface AccountBookRowLike {
  businessId?: string;
  change?: string;
  createTime?: string;
}

const epochToSec = (n: number): number => (n < 1e12 ? Math.floor(n) : Math.floor(n / 1000));

const isEventIn = (v: unknown): v is ReplayEventIn => {
  if (!v || typeof v !== 'object') return false;
  const e = v as ReplayEventIn;
  if (typeof e.id !== 'string' || e.id.length === 0 || e.id.length > 64) return false;
  if (e.kind === 'perp' && (typeof e.symbol !== 'string' || !e.symbol)) return false;
  if (e.kind === 'boros' && !Number.isInteger(e.marketId)) return false;
  if (e.kind !== 'perp' && e.kind !== 'boros') return false;
  return (
    Number.isFinite(e.qty) && e.qty > 0 &&
    Number.isFinite(e.venueQty) && e.venueQty > 0 &&
    Number.isFinite(e.t) && e.t > 0
  );
};

export function borosReplayRoutes(deps: AppDeps) {
  return async function plugin(app: FastifyInstance): Promise<void> {
    app.post('/boros/replay', async (req, reply) => {
      const body = req.body as {
        address?: string;
        accountId?: number;
        events?: unknown[];
      };
      const address = String(body?.address ?? '');
      if (!EVM_ADDRESS_RE.test(address)) {
        return reply.code(400).send({
          ok: false,
          error: { category: 'validation', message: 'address must be a 0x-prefixed EVM address', retryable: false },
        });
      }
      const accountId = Number.isInteger(body?.accountId) ? (body.accountId as number) : 0;
      const rawEvents = Array.isArray(body?.events) ? body.events : [];
      if (rawEvents.length > MAX_EVENTS) {
        return reply.code(400).send({
          ok: false,
          error: { category: 'validation', message: `at most ${MAX_EVENTS} events per replay`, retryable: false },
        });
      }
      const events = rawEvents.filter(isEventIn);

      const results = new Map<string, ReplayResultOut>();
      const nowSec = Math.floor(Date.now() / 1000);

      // --- Boros: per-settlement rows, scaled per-row by the size THEN. ----
      const borosEvents = events.filter((e) => e.kind === 'boros');
      if (borosEvents.length) {
        const minT = Math.min(...borosEvents.map((e) => e.t));
        const fetchImpl: FetchLike = resolveBorosFetch(deps.borosFetch);
        // Cached on the same cadence as the strategy feed; keyed by address +
        // the window floor bucketed to the hour so ledger edits reuse it.
        const cacheKey = `boros:settlements:${address}:${accountId}:${Math.floor(minT / 3600)}`;
        const { value } = await deps.cache.get(cacheKey, TTL.boros, () =>
          fetchSettlementEvents(fetchImpl, address, accountId, minT - 3900),
        );
        const byMarket = new Map<number, BorosSettlementEvent[]>();
        for (const ev of value.events) {
          const list = byMarket.get(ev.marketId) ?? [];
          list.push(ev);
          byMarket.set(ev.marketId, list);
        }
        // Trade PnL windows: the fills carry timestamps, so in-window sums
        // are exact — fetch each zone's transactions once (cached) and index
        // by market.
        const txByMarket = new Map<number, Array<{ time: number; pnlTok: number; feeTok: number }>>();
        try {
          const { value: zones } = await deps.cache.get(
            `boros:collaterals:${address}`,
            TTL.boros,
            () => fetchBorosCollaterals(fetchImpl, address),
          );
          const tokenIds = [...new Set(zones.map((z) => z.tokenId))];
          for (const tokenId of tokenIds) {
            const { value: tx } = await deps.cache.get(
              `boros:txns:${address}:${tokenId}`,
              TTL.boros,
              () => fetchBorosTransactions(fetchImpl, address, tokenId),
            );
            for (const t of tx.txns) {
              const list = txByMarket.get(t.marketId) ?? [];
              list.push({ time: t.time, pnlTok: norm18(t.pnl), feeTok: Math.abs(norm18(t.fee)) });
              txByMarket.set(t.marketId, list);
            }
          }
        } catch {
          // Trade windows degrade to the client's estimate; settlements — the
          // dominant term — stay exact regardless.
        }
        for (const e of borosEvents) {
          const rows = byMarket.get(e.marketId as number) ?? [];
          let settleToken = 0;
          let feeToken = 0;
          for (const r of rows) {
            if (r.timeSec < e.t || r.timeSec > nowSec) continue;
            // The row records the position size AT that settlement — the
            // honest per-tick share, exact through DCA and partial exits.
            const scale = r.positionAbs > 0 ? Math.min(1, e.qty / r.positionAbs) : 0;
            settleToken += r.settlementToken * scale;
            feeToken += r.feeToken * scale;
          }
          const covered = value.coversFromSec === 0 || value.coversFromSec <= e.t;
          let tradePnlToken = 0;
          let tradeFeeToken = 0;
          let haveTrades = false;
          const txs = txByMarket.get(e.marketId as number);
          if (txs) {
            haveTrades = true;
            for (const t of txs) {
              if (t.time < e.t || t.time > nowSec) continue;
              // A fill belongs to the tranche that IS that fill; a blend
              // window owns every in-window fill. Scale by share of the
              // venue position for split legs.
              const scale = Math.min(1, e.qty / e.venueQty);
              tradePnlToken += t.pnlTok * scale;
              tradeFeeToken += t.feeTok * scale;
            }
          }
          results.set(e.id, {
            id: e.id,
            exact: covered,
            coveredFromSec: value.coversFromSec,
            settleToken,
            settleFeeToken: feeToken,
            ...(haveTrades ? { tradePnlToken, tradeFeeToken } : {}),
          });
        }
      }

      // --- Perp: account-book funding rows per position, scaled per tick ---
      const perpEvents = events.filter((e) => e.kind === 'perp');
      if (perpEvents.length) {
        const minT = Math.min(...perpEvents.map((e) => e.t));
        /**
         * Position size AT each funding tick, walked backward from the live
         * size through the fill history — the perp analogue of Boros's
         * per-settlement positionSize. Without it, a window inherits the
         * full-size funding of a position later cut down (the OKX case:
         * 1,555 ETH ticks billed to a 325 ETH strategy).
         */
        const { value: fillState } = await deps.cache.get(
          `replay:fills:${Math.floor(minT / 3600)}`,
          TTL.boros,
          async () => {
            const fills: Array<{ symbol: string; tMs: number; signed: number }> = [];
            let capped = false;
            // 25×200 = 5k fills — matches the Boros txn guard; the engine's
            // maker churn blows through 2k in a week.
            for (let page = 1; page <= 25; page += 1) {
              const { body } = await deps.getClients().crossEx.listCrossexHistoryTrades({
                page,
                limit: 200,
                from: minT * 1000 - 3_600_000,
              });
              for (const f of body as Array<Record<string, unknown>>) {
                const qty = Number(f.qty);
                const t = Number(f.createTime);
                const symbol = String(f.symbol ?? '');
                if (!(qty > 0) || !(t > 0) || !symbol) continue;
                const signed = String(f.side ?? '').toUpperCase() === 'BUY' ? qty : -qty;
                fills.push({ symbol, tMs: t < 1e12 ? t * 1000 : t, signed });
              }
              if ((body as unknown[]).length < 200) break;
              if (page === 25) capped = true;
            }
            return { fills, capped };
          },
        );
        const fromMs = (minT - 3600) * 1000;
        const cacheKey = `replay:funding:${Math.floor(minT / 3600)}`;
        const { value: ledger } = await deps.cache.get(cacheKey, TTL.boros, async () => {
          const rows: AccountBookRowLike[] = [];
          let capped = false;
          for (let page = 1; page <= 10; page += 1) {
            const { body: batch } = await deps.getClients().crossEx.listCrossexAccountBook({
              statementType: 'FUNDING_FEE',
              from: fromMs,
              limit: 200,
              page,
            });
            rows.push(...(batch as AccountBookRowLike[]));
            if ((batch as AccountBookRowLike[]).length < 200) break;
            if (page === 10) capped = true;
          }
          let oldest = Number.POSITIVE_INFINITY;
          const byPosition = new Map<string, Array<{ timeSec: number; changeUsd: number }>>();
          for (const r of rows) {
            const positionId = String(r.businessId ?? '').split('_')[0];
            const changeUsd = Number(r.change);
            const t = Number(r.createTime);
            if (!positionId || !Number.isFinite(changeUsd) || !Number.isFinite(t) || t <= 0) continue;
            const timeSec = epochToSec(t);
            oldest = Math.min(oldest, timeSec);
            const list = byPosition.get(positionId) ?? [];
            list.push({ timeSec, changeUsd });
            byPosition.set(positionId, list);
          }
          return { byPosition, coversFromSec: capped ? oldest : 0 };
        });
        // symbol → positionId via the live positions feed (cached at live TTL
        // by the positions route's own key when warm; cheap regardless).
        const { value: positions } = await deps.cache.get(
          'positions',
          TTL.live,
          async () => (await deps.getClients().crossEx.listCrossexPositions()).body,
        );
        const posBySymbol = new Map<string, { positionId?: string }>();
        for (const p of positions as Array<{ symbol?: string; positionId?: string }>) {
          if (p.symbol) posBySymbol.set(p.symbol, p);
        }
        // Per-symbol size(t): walk back from the live signed size.
        const stepsBySymbol = new Map<string, Array<{ tMs: number; sizeAfterAbs: number }>>();
        const sizeAt = (symbol: string, tMs: number, fallbackAbs: number): number => {
          const steps = stepsBySymbol.get(symbol);
          if (!steps) return fallbackAbs;
          for (const st of steps) if (tMs >= st.tMs) return st.sizeAfterAbs;
          return steps[steps.length - 1]?.sizeAfterAbs ?? fallbackAbs;
        };
        for (const e of perpEvents) {
          const pos = posBySymbol.get(e.symbol as string) as
            | { positionId?: string; positionQty?: string; positionSide?: string }
            | undefined;
          if (pos && !stepsBySymbol.has(e.symbol as string)) {
            const sign = String(pos.positionSide ?? '').toUpperCase() === 'SHORT' ? -1 : 1;
            let sSigned = sign * Math.abs(Number(pos.positionQty ?? 0));
            const steps: Array<{ tMs: number; sizeAfterAbs: number }> = [
              { tMs: Number.MAX_SAFE_INTEGER, sizeAfterAbs: Math.abs(sSigned) },
            ];
            const symFills = fillState.fills
              .filter((f) => f.symbol === e.symbol)
              .sort((a, b) => b.tMs - a.tMs);
            for (const f of symFills) {
              steps.push({ tMs: f.tMs, sizeAfterAbs: Math.abs(sSigned) });
              sSigned -= f.signed;
            }
            steps.push({ tMs: 0, sizeAfterAbs: Math.abs(sSigned) });
            stepsBySymbol.set(e.symbol as string, steps);
          }
          const rows = pos?.positionId ? (ledger.byPosition.get(pos.positionId) ?? []) : [];
          let fundingUsd = 0;
          for (const r of rows) {
            if (r.timeSec < e.t || r.timeSec > nowSec) continue;
            const size = sizeAt(e.symbol as string, r.timeSec * 1000 - 1, e.venueQty);
            const scale = size > 0 ? Math.min(1, e.qty / size) : 0;
            fundingUsd += r.changeUsd * scale;
          }
          const covered = ledger.coversFromSec === 0 || ledger.coversFromSec <= e.t;
          results.set(e.id, {
            id: e.id,
            exact: covered && pos?.positionId !== undefined && !fillState.capped,
            coveredFromSec: ledger.coversFromSec,
            fundingUsd,
            sharedApprox: fillState.capped,
          });
        }
      }

      return reply.ok({ results: [...results.values()] });
    });
  };
}
