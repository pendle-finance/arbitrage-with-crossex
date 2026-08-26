/**
 * Gate CrossEx adapter for the VenuePort.
 *
 * Classification doctrine: a create failure is a DEFINITE reject only when the
 * venue answered with an ALLOWLISTED business label; every other shape — network
 * error, timeout, ANY 5xx, unmatched label — is UNKNOWN (per Binance's own
 * doctrine: "execution status is UNKNOWN and could have been a success").
 */
import { CrossexOrderRequest } from 'gate-api';
import type { Clients } from '../core/clients';
import { fetchVenueBook, refMidOf } from '../core/estimate/books';
import { formatRestPrice, parseSymbol } from '../core/numbers';
import {
  TUNING,
  type CancelOutcome,
  type CreateOutcome,
  type OrderSnapshot,
  type ReadOutcome,
  type Side,
  type SweepResult,
  type VenuePort,
} from './types';

/** Venue labels that constitute a DEFINITE business rejection of a create. */
const DEFINITE_REJECT = [
  /POST_ONLY|POC_|IMMEDIATE/i,
  /BALANCE|MARGIN|INSUFFICIENT_(BALANCE|MARGIN|AVAILABLE|FUND)|NOT_ENOUGH/i,
  /MIN_NOTIONAL|SIZE_TOO_SMALL|MIN_SIZE|TOO_SMALL/i,
  /MAX_MARKET_SIZE|MAX_LIMIT_SIZE|SIZE_TOO_LARGE|TOO_LARGE/i,
  /SIGNIFICANT_FIGURES|PRICE/i,
  /REDUCE_ONLY/i,
  /LEVERAGE|RISK_LIMIT/i,
  /INVALID_PARAM|BAD_REQUEST|CONTRACT_NOT_FOUND|SYMBOL/i,
];

/** Labels meaning "no further fills can occur" on a CANCEL (success-equivalent). */
const CANCEL_GONE = /ORDER_NOT_FOUND|ORDER_CLOSED|ORDER_FINISHED|CLIENT_ID_NOT_FOUND|NOT_FOUND/i;
/** Labels meaning "this order does not exist" on a READ. Deliberately EXCLUDES
 * ORDER_CLOSED/ORDER_FINISHED: those mean "exists and is terminal" — mapping
 * them to not-found would make every routinely-finished order read as absent
 * (quarantining healthy pairs). They classify as read errors instead, so the
 * loop keeps probing and the resolution ladder's history sweep finds the truth. */
const READ_GONE = /ORDER_NOT_FOUND|CLIENT_ID_NOT_FOUND/i;

interface GateErr {
  response?: { status?: number; data?: { label?: string; message?: string } };
  message?: string;
}

function labelOf(err: unknown): string | null {
  const e = err as GateErr;
  const label = e?.response?.data?.label;
  const status = e?.response?.status;
  // Only 4xx responses with a label are candidates for a definitive verdict: a
  // 5xx may have been emitted AFTER the venue processed the request.
  if (!label || status === undefined || status >= 500) return null;
  return label;
}

function snapshotOf(o: {
  orderId?: unknown;
  state?: unknown;
  reason?: unknown;
  executedQty?: unknown;
  executedAvgPrice?: unknown;
}): OrderSnapshot {
  return {
    venueOrderId: String(o.orderId ?? ''),
    rawStatus: String(o.state ?? ''),
    cumQty: String(o.executedQty ?? '0') || '0',
    // executed_avg_price is '0'/'' until a fill; numToDec caps it to an
    // fx-safe plain decimal (no exponent, ≤12 dp) or null → '0'.
    avgFillPrice: numToDec(o.executedAvgPrice) ?? '0',
    reason: String(o.reason ?? ''),
  };
}

/** Format a float price as a plain decimal string the exact-arithmetic layer
 * accepts: never exponential notation, capped at 12 decimals. Null for
 * non-positive/non-finite values. */
function numToDec(px: unknown): string | null {
  const n = Number(px);
  if (!Number.isFinite(n) || n <= 0) return null;
  const s = n.toFixed(12).replace(/0+$/, '').replace(/\.$/, '');
  return s === '0' ? null : s;
}

export function gateVenue(getClients: () => Clients): VenuePort {
  const crossEx = () => getClients().crossEx;

  // Short-TTL memo for the slow public book fetches (esp. Hyperliquid): the loop
  // may re-tick every ~150ms while actively hedging, and a fresh book that often
  // adds no value but can stall the whole loop on a slow venue. 1s keeps prices
  // fresh enough for sizing/pegging while making back-to-back ticks cheap.
  const PRICE_TTL_MS = 1_000;
  const priceCache = new Map<string, { at: number; value: string | null }>();
  const cachedPrice = async (key: string, fetch: () => Promise<string | null>): Promise<string | null> => {
    const hit = priceCache.get(key);
    const nowMs = Date.now();
    if (hit && nowMs - hit.at < PRICE_TTL_MS) return hit.value;
    const value = await fetch();
    priceCache.set(key, { at: nowMs, value });
    return value;
  };

  const getByVenueId = async (venueOrderId: string): Promise<ReadOutcome> => {
    try {
      const { body } = await crossEx().getCrossexOrder(venueOrderId);
      return { kind: 'found', snapshot: snapshotOf(body) };
    } catch (err) {
      const label = labelOf(err);
      if (label && READ_GONE.test(label)) return { kind: 'notFound' };
      return { kind: 'error', message: (err as Error).message ?? String(err) };
    }
  };

  return {
    async create(req): Promise<CreateOutcome> {
      const order = new CrossexOrderRequest();
      order.symbol = req.contract;
      order.side = req.side === 'BUY' ? CrossexOrderRequest.Side.BUY : CrossexOrderRequest.Side.SELL;
      order.type = req.price ? CrossexOrderRequest.Type.LIMIT : CrossexOrderRequest.Type.MARKET;
      order.timeInForce =
        req.tif === 'poc' ? CrossexOrderRequest.TimeInForce.POC : CrossexOrderRequest.TimeInForce.IOC;
      order.qty = req.qty;
      if (req.price) order.price = req.price;
      if (req.reduceOnly) order.reduceOnly = CrossexOrderRequest.ReduceOnly.True;
      order.text = req.clientText;
      try {
        const { body } = await crossEx().createCrossexOrder({ crossexOrderRequest: order });
        // The create response carries ONLY {orderId, text} (CrossexOrderActionResponse)
        // — no status/fill. Follow up with one read so the loop gets a real
        // snapshot (this is also what detects a POC accepted-then-insta-cancel).
        const venueOrderId = String(body.orderId ?? '');
        try {
          const { body: full } = await crossEx().getCrossexOrder(venueOrderId);
          return { kind: 'ok', snapshot: snapshotOf(full) };
        } catch {
          // The order IS accepted (create succeeded); the confirm read just
          // failed. 'NEW' is safe: the loop marks it OPEN and observes the real
          // state next tick.
          return {
            kind: 'ok',
            snapshot: { venueOrderId, rawStatus: 'NEW', cumQty: '0', avgFillPrice: '0', reason: '' },
          };
        }
      } catch (err) {
        const label = labelOf(err);
        if (label && DEFINITE_REJECT.some((re) => re.test(label))) {
          return { kind: 'reject', label, message: (err as GateErr).response?.data?.message ?? label };
        }
        return { kind: 'unknown', message: (err as Error).message ?? String(err) };
      }
    },

    async cancel(ref): Promise<CancelOutcome> {
      const id = ref.venueOrderId ?? ref.clientText;
      try {
        await crossEx().cancelCrossexOrder(id);
        return { kind: 'ok' };
      } catch (err) {
        const label = labelOf(err);
        if (label && CANCEL_GONE.test(label)) return { kind: 'ok' }; // already terminal = success
        return { kind: 'unknown', message: (err as Error).message ?? String(err) };
      }
    },

    async getOrder(ref): Promise<ReadOutcome> {
      // Live-verified (2026-07-23 smoke): getCrossexOrder accepts the client
      // text as the order-id path param — while the order is live AND well past
      // the documented 60s post-terminal window. One authoritative GET either
      // way; no listing scans in the hot path.
      return getByVenueId(ref.venueOrderId ?? ref.clientText);
    },

    async sweepForOrder(contract, clientText, fromMs): Promise<SweepResult> {
      // Live-verified (2026-07-23 smoke, both runs): /crossex/history_orders
      // takes `from` in MILLISECONDS — seconds get 400/COMMON_PARAM_BIND_ERROR.
      // Symbol-filtered + ms-time-bounded + paginated to exhaustion: 'covered'
      // is true only when every read succeeded and the final page was short
      // (the listing provably spanned [fromMs, now]). The direct GET-by-text
      // pre-check resolves most in-doubt orders before any listing is touched.
      try {
        const byText = await getByVenueId(clientText); // cheap authoritative pre-check
        if (byText.kind === 'found') return { covered: true, found: byText.snapshot };
        const open = (await crossEx().listCrossexOpenOrders({ symbol: contract })).body ?? [];
        const liveHit = open.find((o) => String(o.text ?? '') === clientText);
        if (liveHit) return { covered: true, found: snapshotOf(liveHit) };
        const limit = 100;
        for (let page = 1; page <= 50; page++) {
          const rows =
            (await crossEx().listCrossexHistoryOrders({ symbol: contract, from: fromMs, limit, page }))
              .body ?? [];
          const hit = rows.find((o) => String(o.text ?? '') === clientText);
          if (hit) return { covered: true, found: snapshotOf(hit) };
          if (rows.length < limit) return { covered: true }; // exhausted the window
        }
        return { covered: false }; // page cap hit — do NOT claim absence
      } catch {
        return { covered: false };
      }
    },

    async touch(contract: string, side: Side, tick: string): Promise<string | null> {
      return cachedPrice(`touch:${contract}:${side}:${tick}`, async () => {
      try {
        const { exchange, base, quote } = parseSymbol(contract);
        const book = await fetchVenueBook(exchange, base, quote);
        const bid = Number(book?.bids?.[0]?.[0]);
        const ask = Number(book?.asks?.[0]?.[0]);
        // The maker rests ONE bid–ask gap BEHIND the touch: BUY at
        // bid − (ask − bid), SELL at ask + (ask − bid). Degenerate books
        // (one-sided, crossed, or an offset that would go non-positive) fall
        // back to the plain same-side touch. The result is formatted for the
        // venue (tick-snap + Hyperliquid 5-sig-fig cap) — a raw HL touch with
        // 6 sig figs is rejected at create.
        let px: number;
        if (Number.isFinite(bid) && Number.isFinite(ask) && ask > bid) {
          const behind = side === 'BUY' ? 2 * bid - ask : 2 * ask - bid;
          px = behind > 0 ? behind : side === 'BUY' ? bid : ask;
        } else {
          px = side === 'BUY' ? bid : ask;
        }
        if (!Number.isFinite(px) || px <= 0) return null;
        // formatRestPrice, not formatLimitPrice: this price is about to REST
        // post-only. A nearest-tick snap (and the nearest-mode 5-sig-fig cap)
        // can push a BUY up onto the ask, which the venue insta-rejects as
        // would-cross — and with pricePolicy 'fixed' the same price is re-placed
        // every retry until the POC budget kills the deal.
        return formatRestPrice(px, side, contract, tick);
      } catch {
        return null;
      }
      });
    },

    async refPrice(contract: string): Promise<string | null> {
      return cachedPrice(`ref:${contract}`, async () => {
        try {
          const { exchange, base, quote } = parseSymbol(contract);
          const book = await fetchVenueBook(exchange, base, quote);
          return numToDec(refMidOf(book, TUNING.MAX_BOOK_SPREAD));
        } catch {
          return null;
        }
      });
    },
  };
}
