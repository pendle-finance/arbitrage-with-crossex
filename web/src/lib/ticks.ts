/** Tick/lot snapping helpers — FAITHFUL PORTS of src/core/numbers.ts
 * (decimalsOf, roundToStep, roundSigFigs, sigFigsDirectional, stripZeros,
 * formatLimitPrice, formatRestPrice).
 * Used to tick-snap limit prices client-side on blur, exactly the way the
 * backend resolver will snap them at preview/execute time. */

/** Number of significant decimal places implied by a step string (e.g. "0.001" -> 3). */
export function decimalsOf(step: string): number {
  const s = step.trim();
  // Scientific notation ("1e-5", "2.5e-4") has no '.', so plain-string counting would
  // return 0 and collapse prices/qtys to integers. Derive decimals from the exponent
  // exactly (float round-trips would introduce noise): decimals = mantissaFrac − exp.
  // CrossEx rule feeds really do return ticks this way (see src/engine/create.ts's
  // safeDec) and /api/symbols passes tickSize through verbatim.
  const sci = s.match(/^[+-]?\d+(?:\.(\d+))?[eE]([+-]?\d+)$/);
  if (sci) {
    const mantissaFrac = sci[1]?.length ?? 0;
    return Math.max(0, mantissaFrac - parseInt(sci[2], 10));
  }
  if (!s.includes('.')) return 0;
  return s.split('.')[1].replace(/0+$/, '').length;
}

/**
 * Round `value` to a multiple of `step`. `down` floors (order qty — never exceed
 * the requested notional); `up` ceils; `nearest` rounds (limit price). Returns a
 * string already trimmed to the step's precision.
 */
export function roundToStep(value: number, step: string, dir: 'down' | 'up' | 'nearest' = 'down'): string {
  const s = Number(step);
  if (!Number.isFinite(s) || s <= 0) return String(value);
  const r = value / s;
  // Float guard: 0.3/0.1 === 2.9999999999999996 — snap near-integer ratios first
  // (also keeps ceil from over-rounding 2.0000001 → 3).
  const nearest = Math.round(r);
  const snapped = Math.abs(r - nearest) < 1e-9 * Math.max(1, Math.abs(r));
  const mult = snapped ? nearest : dir === 'nearest' ? nearest : dir === 'up' ? Math.ceil(r) : Math.floor(r);
  return (mult * s).toFixed(decimalsOf(step));
}

/** Round to N significant figures. */
export function roundSigFigs(n: number, sig: number): number {
  if (!Number.isFinite(n) || n === 0) return 0;
  const mag = sig - Math.ceil(Math.log10(Math.abs(n)));
  const p = Math.pow(10, mag);
  return Math.round(n * p) / p;
}

/** Strip trailing zeros (and any dangling decimal point) from a decimal string. */
export function stripZeros(s: string): string {
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

/**
 * Format a limit price: snap to the symbol's tick, then apply venue precision caps
 * (Hyperliquid rejects prices with more than 5 significant figures).
 *
 * NEAREST-mode only — for a RESTING (post-only) price use formatRestPrice
 * instead: the nearest snap here can round a price ONTO/ACROSS the touch (e.g.
 * a 61717.6 resting BUY → 61718 = the ask), which the venue insta-rejects.
 */
export function formatLimitPrice(price: number, symbol: string, tickSize: string): string {
  const snapped = roundToStep(price, tickSize, 'nearest');
  if (symbol.startsWith('HYPERLIQUID_')) {
    const capped = roundSigFigs(Number(snapped), 5);
    return stripZeros(capped.toFixed(decimalsOf(tickSize)));
  }
  return stripZeros(snapped);
}

/** Round to N significant figures toward a direction (float-tolerant like
 * roundToStep). Faithful port of sigFigsDirectional in src/core/numbers.ts. */
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

/**
 * Format a RESTING (post-only) price, rounding AWAY from crossing so the snap can
 * never turn a maker order into a taker rejection. A resting BUY must stay at/below
 * the ask → round DOWN; a resting SELL must stay at/above the bid → round UP.
 * FAITHFUL PORT of formatRestPrice in src/core/numbers.ts — the server applies
 * the same function to POC prices, but its snap is a NO-OP on a price the client
 * already rounded to a valid tick multiple, so a client-side NEAREST snap (via
 * formatLimitPrice) would silently defeat it: HL BTC bid 61717/ask 61718, tick
 * 0.1 → 61717.6 typed as a resting BUY becomes 61718 = the ask → insta-reject,
 * with no "price adjusted" warning because price === input.price server-side.
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

/** Floor to cents, never negative. A figure a button acts on must not show
 * more than the button can move. */
export function floorCents(value: number): number {
  return Number(roundToStep(Math.max(0, value), '0.01', 'down'));
}
