/** Pure number/price/symbol helpers shared by the server, the live suite, and tests. */

/** Fallback lot/tick step when a symbol rule doesn't carry one. */
export const DEFAULT_STEP = '0.0001';

/** Number of significant decimal places implied by a step string (e.g. "0.001" -> 3). */
export function decimalsOf(step: string): number {
  const s = step.trim();
  // Scientific notation ("1e-5", "2.5e-4") has no '.', so plain-string counting would
  // return 0 and collapse prices/qtys to integers. Derive decimals from the exponent
  // exactly (float round-trips would introduce noise): decimals = mantissaFrac − exp.
  const sci = s.match(/^[+-]?\d+(?:\.(\d+))?[eE]([+-]?\d+)$/);
  if (sci) {
    const mantissaFrac = sci[1]?.length ?? 0;
    return Math.max(0, mantissaFrac - parseInt(sci[2], 10));
  }
  if (!s.includes('.')) return 0;
  return s.split('.')[1].replace(/0+$/, '').length;
}

/**
 * Round `value` to a multiple of `step`. `down` floors (used for order qty so we
 * never exceed the requested notional); `nearest` rounds (used for limit price).
 * Returns a string already trimmed to the step's precision.
 */
export function roundToStep(value: number, step: string, dir: 'down' | 'up' | 'nearest' = 'down'): string {
  const s = Number(step);
  if (!Number.isFinite(s) || s <= 0) return String(value);
  const decimals = decimalsOf(step);
  const r = value / s;
  if (dir === 'nearest') return (Math.round(r) * s).toFixed(decimals);
  const at = (mult: number): number => Number((mult * s).toFixed(decimals));
  let below = Math.floor(r);
  if (at(below) > value) below -= 1;
  else if (at(below + 1) <= value) below += 1;
  const noise = Math.min(1e-3 * s, Math.max(1e-9 * Math.min(1, s), 4 * Number.EPSILON * Math.abs(value)));
  const mult =
    dir === 'down'
      ? at(below + 1) - value <= noise
        ? below + 1
        : below
      : value - at(below) <= noise
        ? below
        : below + 1;
  return (mult * s).toFixed(decimals);
}

/** The coarsest (largest) of the given lot steps; undefined when none is a
 * positive number. Pair legs snap shared quantities to this so a sub-lot
 * difference between venues reads as hedged, not as an imbalance. */
export function coarsestLot(lots: Array<string | undefined>): string | undefined {
  const valid = lots.filter((l): l is string => Boolean(l) && Number(l) > 0);
  return valid.length ? valid.reduce((x, y) => (Number(y) > Number(x) ? y : x)) : undefined;
}

/** Round to N significant figures. */
export function roundSigFigs(n: number, sig: number): number {
  if (!Number.isFinite(n) || n === 0) return 0;
  const mag = sig - Math.ceil(Math.log10(Math.abs(n)));
  const p = Math.pow(10, mag);
  return Math.round(n * p) / p;
}

/** Strip trailing zeros (and any dangling decimal point) from a decimal string.
 * Operates on the string only, so it never introduces float artifacts; safe on integers. */
export function stripZeros(s: string): string {
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

/**
 * Format a limit price: snap to the symbol's tick, then apply venue precision caps.
 * Hyperliquid rejects prices with more than 5 significant figures
 * (TRADE_HYPERLIQUID_PRICE_SIGNIFICANT_FIGURES_ERROR), so cap those. Returns a clean
 * string (no trailing zeros), which remains a multiple of the (power-of-10) tick.
 */
export function formatLimitPrice(price: number, symbol: string, tickSize: string): string {
  const snapped = roundToStep(price, tickSize, 'nearest'); // tick-precise, float-error-free string
  if (symbol.startsWith('HYPERLIQUID_')) {
    const capped = roundSigFigs(Number(snapped), 5);
    return stripZeros(capped.toFixed(decimalsOf(tickSize)));
  }
  return stripZeros(snapped);
}

/**
 * Format an already-crossed marketable price, rounding AWAY from mark so it stays on
 * the marketable side. A plain nearest-tick snap can push a coarse-tick price back
 * across mark (e.g. mark 2.00, tick 0.05, +0.5% → 2.01 → nearest → 2.00), leaving a
 * reduce-only IOC that doesn't cross and fills 0. SELL (closing a long) rounds down,
 * BUY (closing a short) rounds up.
 */
export function formatCrossPrice(price: number, side: 'BUY' | 'SELL', symbol: string, tickSize: string): string {
  const dir = side === 'SELL' ? 'down' : 'up';
  let snapped = roundToStep(price, tickSize, dir);
  if (symbol.startsWith('HYPERLIQUID_')) {
    // Re-snap in the same direction so the 5-sig-fig cap can't round back across mark.
    snapped = roundToStep(roundSigFigs(Number(snapped), 5), tickSize, dir);
  }
  return stripZeros(snapped);
}

/**
 * Format a RESTING (post-only) price, rounding AWAY from crossing so the snap can
 * never turn a maker order into a taker rejection. A resting BUY must stay at/below
 * the ask → round DOWN; a resting SELL must stay at/above the bid → round UP.
 * formatLimitPrice's 'nearest' snap (plus Hyperliquid's 5-sig-fig cap) can push a
 * bid ABOVE the ask on a tight spread, guaranteeing a POC reject loop — this is the
 * mirror of formatCrossPrice for the passive side.
 */
export function formatRestPrice(price: number, side: 'BUY' | 'SELL', symbol: string, tickSize: string): string {
  const dir = side === 'BUY' ? 'down' : 'up';
  let snapped = roundToStep(price, tickSize, dir);
  if (symbol.startsWith('HYPERLIQUID_')) {
    // The nearest-mode 5-sig-fig cap could bump the price in the UNSAFE direction
    // by more than a tick (61717.8 → 61718 is up), so the cap itself must round
    // directionally, then re-snap to the tick the same way.
    snapped = roundToStep(sigFigsDirectional(Number(snapped), 5, dir), tickSize, dir);
  }
  return stripZeros(snapped);
}

/** Round to N significant figures toward a direction (float-tolerant like roundToStep). */
export function sigFigsDirectional(n: number, sig: number, dir: 'down' | 'up'): number {
  if (!Number.isFinite(n) || n === 0) return 0;
  const mag = sig - Math.ceil(Math.log10(Math.abs(n)));
  const p = Math.pow(10, mag);
  const r = n * p;
  const nearest = Math.round(r);
  const snapped = Math.abs(r - nearest) < 1e-9 * Math.max(1, Math.abs(r));
  const m = snapped ? nearest : dir === 'down' ? Math.floor(r) : Math.ceil(r);
  return m / p;
}

/** Parse `{EXCHANGE}_{BUSINESS}_{BASE}_{QUOTE}` into parts. */
export function parseSymbol(symbol: string): {
  exchange: string;
  business: string;
  base: string;
  quote: string;
  pair: string; // BASE_QUOTE
} {
  const parts = symbol.split('_');
  const exchange = parts[0] ?? '';
  const business = parts[1] ?? '';
  const quote = parts[parts.length - 1] ?? '';
  const base = parts.slice(2, -1).join('_');
  return { exchange, business, base, quote, pair: `${base}_${quote}` };
}
