/**
 * The largest size a Boros order can open GIVEN the collateral behind it — the
 * "available" the tickets offer beside the size box.
 *
 * A bucket's `available` is collateral, not size: a YU leg only posts its
 * initial margin (plus the taker fee), a small fraction of its notional. So the
 * size a bucket funds is `available / openCostPerSize`, and a pair funds ONE
 * size on both legs:
 *   - two cross legs on the same token share one bucket, so both legs' costs
 *     come out of it together: S × (costA + costB) ≤ available;
 *   - an isolated leg has its own bucket, so each bucket caps S on its own;
 * and the pair's size is the smallest of those caps, so the legs still match.
 *
 * The part of an order that REDUCES an opposing position posts no new margin,
 * so each leg's `reducible` size is free; past it the leg costs as usual. The
 * margin a reduction releases is not credited, which keeps the figure on the
 * safe side. The simulator still gates the order itself.
 */
export interface MaxSizeLeg {
  /** Identifies the collateral bucket the leg draws on — legs that share one
   * key share one `available`. */
  bucket: string;
  /** What the bucket can still fund, in collateral units. */
  available: number | null;
  /** Collateral one unit of size costs to open (IM + taker fee). */
  costPerSize: number | null | undefined;
  /** Size this leg can trade by reducing an opposing position first. */
  reducible: number;
}

/** The size, or null when any leg's inputs are unknown (never a guess). */
export function maxOpenSize(legs: ReadonlyArray<MaxSizeLeg>): number | null {
  if (legs.length === 0) return null;
  const buckets = new Map<string, { available: number; legs: { cost: number; free: number }[] }>();
  for (const l of legs) {
    if (l.available === null || !Number.isFinite(l.available)) return null;
    if (l.costPerSize == null || !(l.costPerSize > 0)) return null;
    const b = buckets.get(l.bucket) ?? { available: l.available, legs: [] };
    b.legs.push({ cost: l.costPerSize, free: Math.max(0, l.reducible) });
    buckets.set(l.bucket, b);
  }
  let size = Infinity;
  for (const b of buckets.values()) size = Math.min(size, bucketCap(Math.max(0, b.available), b.legs));
  return Number.isFinite(size) ? size : null;
}

/**
 * The largest S with Σ cost × max(0, S − free) ≤ available. The need is
 * piecewise linear and rising in S, with a kink at each leg's `free`; walk the
 * kinks in order until the budget is spent.
 */
function bucketCap(available: number, legs: { cost: number; free: number }[]): number {
  const sorted = [...legs].sort((a, b) => a.free - b.free);
  let spent = 0;
  let slope = 0;
  for (let k = 0; k < sorted.length; k++) {
    slope += sorted[k].cost;
    const from = sorted[k].free;
    const to = k + 1 < sorted.length ? sorted[k + 1].free : Infinity;
    const atTo = spent + slope * (to - from);
    if (available <= atTo) return from + (available - spent) / slope;
    spent = atTo;
  }
  return Infinity;
}
