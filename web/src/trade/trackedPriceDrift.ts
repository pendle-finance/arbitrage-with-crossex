/**
 * Does a preview still describe the order, when the only thing that moved is
 * the maker price the ticket auto-tracks from the book?
 *
 * In Limit + hedge mode the maker price follows the touch that each preview
 * reports, so every preview can change the actions and key a new one. Treating
 * each tick as a new order left Execute disabled for as long as the book moved
 * (measured: 63% of 30 s on a live ETH pair). A tracked price is not the order's
 * price, though: the maker leg goes out as `pricePolicy: 'touch'` and the engine
 * places it at the live touch (see engine/decide.ts). The one thing a stale
 * preview price still reaches is a USDT-sized quantity (notional ÷ preview
 * price), identical on both legs, so the drift is capped tightly.
 */

/** 5 bps: above an ETH book's per-cycle noise (~0.5–2 bps), and a USDT-sized
 * quantity can be at most 0.05% off. His call, 2026-09-29. */
export const TRACKED_PRICE_TOLERANCE = 0.0005;

type Action = Record<string, unknown>;

const isTrackedMaker = (a: Action): boolean => a.kind === 'open-limit' && a.pairRole === 'maker';

/** Stable text of an action without its price — key order never matters. */
const withoutPrice = (a: Action): string =>
  JSON.stringify(
    Object.keys(a)
      .filter((k) => k !== 'price')
      .sort()
      .map((k) => [k, a[k]]),
  );

/**
 * True when `current` differs from `shown` (the actions the displayed preview
 * was computed for) ONLY in the tracked maker leg's price, and by no more than
 * `tolerance` of the current price. Anything else changed ⇒ false.
 */
export function withinTrackedDrift(
  shownActions: ReadonlyArray<object>,
  currentActions: ReadonlyArray<object>,
  tolerance: number,
): boolean {
  const shown = shownActions as ReadonlyArray<Action>;
  const current = currentActions as ReadonlyArray<Action>;
  if (shown.length === 0 || shown.length !== current.length) return false;
  return shown.every((s, i) => {
    const c = current[i];
    if (!isTrackedMaker(s) || !isTrackedMaker(c)) return JSON.stringify(s) === JSON.stringify(c);
    if (withoutPrice(s) !== withoutPrice(c)) return false;
    const from = Number(s.price);
    const to = Number(c.price);
    if (!(from > 0) || !(to > 0)) return false;
    return Math.abs(to - from) / to <= tolerance;
  });
}
