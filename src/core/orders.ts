/** CrossEx order/domain helpers: sizing, pricing, leverage, and order construction. */
import { CrossexLeverageRequest } from 'gate-api';
import type { CrossExApi } from 'gate-api';
import type { Clients } from './clients';
import { coarsestLot, formatCrossPrice, roundToStep } from './numbers';

export type Side = 'BUY' | 'SELL';


/** Direction of a position; in one-way mode infer from the qty sign. */
export function direction(side: string | undefined, qty: number | string): 'LONG' | 'SHORT' {
  const s = (side ?? '').toUpperCase();
  if (s === 'LONG' || s === 'SHORT') return s;
  return Number(qty) >= 0 ? 'LONG' : 'SHORT';
}

/** A reference price for notional→qty sizing: Gate spot last, else futures mark/last. */
async function getReferencePrice(clients: Clients, pair: string): Promise<number | null> {
  try {
    const t = await clients.spot.listTickers({ currencyPair: pair });
    const last = Number(t.body?.[0]?.last);
    if (Number.isFinite(last) && last > 0) return last;
  } catch {
    /* fall through to futures */
  }
  try {
    const t = await clients.futures.listFuturesTickers('usdt', { contract: pair });
    const px = Number(t.body?.[0]?.markPrice ?? t.body?.[0]?.last);
    if (Number.isFinite(px) && px > 0) return px;
  } catch {
    /* no price available */
  }
  return null;
}

/**
 * Resolve a sizing reference price: the first pair that quotes on Gate. Pairs with
 * non-USDT quotes (KRAKEN_…_USD, HYPERLIQUID_…_USDC) usually don't exist on Gate
 * spot/futures, so fall back to the BASE_USDT proxy — USD/USDC≈USDT is well inside
 * sizing tolerance; the source labels the proxy.
 */
export async function resolveReferencePrice(
  clients: Clients,
  opts: { pairs: string[] },
): Promise<{ price: number; source: string }> {
  for (const pair of opts.pairs) {
    const px = await getReferencePrice(clients, pair);
    if (px != null) return { price: px, source: `gate ${pair}` };
  }
  // Quote-normalized fallback: BASE_USDT for each distinct base.
  const bases = [...new Set(opts.pairs.map((pair) => pair.split('_').slice(0, -1).join('_')))];
  for (const base of bases) {
    const proxy = `${base}_USDT`;
    if (opts.pairs.includes(proxy)) continue; // already tried above
    const px = await getReferencePrice(clients, proxy);
    if (px != null) return { price: px, source: `gate ${proxy} (quote proxy)` };
  }
  throw new Error(`could not fetch a reference price for ${opts.pairs.join('/')}`);
}

export interface QtyLeg {
  lotSize: string;
  minSize: number;
  minNotional: number;
  /** Venue, so a violation can name the leg at fault. Every message here is
   * rendered verbatim in the browser, so "a leg" is not good enough. */
  symbol?: string;
}

/** Possessive venue name for a message, when the caller supplied one. */
const legName = (l: QtyLeg): string => (l.symbol ? `${l.symbol}'s` : "a leg's");

/**
 * Resolve one base-asset quantity valid for every leg: from a coin size, or from a
 * dollar size and refPrice; floored to the coarsest lot, then checked against each
 * leg's lot/min-size/min-notional.
 * One leg = single open; two legs = a pair sharing the same qty. Throws on any violation.
 *
 * Every message thrown here reaches a trader in the browser — resolveActions renders
 * it verbatim in the ticket's violation list. There is no CLI any more, so no message
 * may name a `--flag`, and one that blames a leg must say which leg.
 */
export function resolveQty(opts: {
  notional?: string;
  qty?: string;
  refPrice?: number;
  legs: QtyLeg[];
}): { qtyStr: string; qty: number; estNotional: number } {
  if (opts.notional && opts.qty) throw new Error('size this order in coins or in dollars, not both');
  if (!opts.notional && !opts.qty) throw new Error('enter a size, in coins or in dollars');

  let raw: number;
  if (opts.qty) {
    raw = Number(opts.qty);
    if (!Number.isFinite(raw) || raw <= 0) throw new Error('size must be a positive number');
  } else {
    const n = Number(opts.notional);
    if (!Number.isFinite(n) || n <= 0) throw new Error('the dollar size must be a positive number');
    raw = n / (opts.refPrice ?? 0);
  }

  const coarserLot = coarsestLot(opts.legs.map((l) => l.lotSize)) ?? opts.legs[0].lotSize;
  const qtyStr = roundToStep(raw, coarserLot, 'down');
  const qty = Number(qtyStr);
  if (qty <= 0) throw new Error(`this size rounds down to zero — ${coarserLot} is the smallest step available`);

  for (const l of opts.legs) {
    if (!isMultipleOf(qty, l.lotSize)) {
      throw new Error(`lot sizes do not fit together (${opts.legs.map((x) => x.lotSize).join(', ')}) — no size works on every leg`);
    }
    if (qty < l.minSize) throw new Error(`size ${qtyStr} is below ${legName(l)} minimum size of ${l.minSize}`);
  }
  const estNotional = qty * (opts.refPrice ?? 0);
  for (const l of opts.legs) {
    if (l.minNotional > 0 && estNotional > 0 && estNotional < l.minNotional) {
      throw new Error(`this size is worth ${estNotional.toFixed(2)}, below ${legName(l)} minimum order value of ${l.minNotional} — increase it`);
    }
  }
  return { qtyStr, qty, estNotional };
}

/** True if `qty` is an integer multiple of `step` (within float tolerance). */
export function isMultipleOf(qty: number, step: string): boolean {
  const s = Number(step);
  if (!Number.isFinite(s) || s <= 0) return true;
  const r = qty / s;
  return Math.abs(r - Math.round(r)) < 1e-9;
}

/** Marketable limit price: cross the spread by `slippagePct` so the order fills now.
 * Closing a long (SELL) prices below mark; closing a short (BUY) prices above.
 * Rounds the crossed price AWAY from mark (via formatCrossPrice) so a coarse tick can
 * never snap it back across mark and leave a reduce-only IOC that fills 0. */
export function marketableClosePrice(
  markPrice: number,
  closeSide: Side,
  slippagePct: number,
  symbol: string,
  tickSize: string,
): string {
  const factor = closeSide === 'SELL' ? 1 - slippagePct / 100 : 1 + slippagePct / 100;
  return formatCrossPrice(markPrice * factor, closeSide, symbol, tickSize);
}

/** Max settable leverage per symbol (highest `leverage_max` across risk tiers).
 * One call covers many symbols (comma-joined). */
export async function getLeverageMax(crossEx: CrossExApi, symbols: string[]): Promise<Map<string, number>> {
  const { body } = await crossEx.listCrossexRuleRiskLimits(symbols.join(','));
  const map = new Map<string, number>();
  for (const r of body ?? []) {
    const max = Math.max(0, ...(r.tiers ?? []).map((t) => Number(t.leverageMax) || 0));
    if (r.symbol) map.set(r.symbol, max);
  }
  return map;
}

/** Set position leverage for a symbol; returns the confirmed {symbol, leverage}. */
export async function setLeverage(
  crossEx: CrossExApi,
  symbol: string,
  leverage: number | string,
): Promise<{ symbol: string; leverage: string }> {
  const lev = new CrossexLeverageRequest();
  lev.symbol = symbol;
  lev.leverage = String(Number(leverage));
  const { body } = await crossEx.updateCrossexPositionsLeverage({ crossexLeverageRequest: lev });
  return body;
}
