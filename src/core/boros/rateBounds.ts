/** Native MarketOrderAndOtc checks the LAST MATCHED rate against this band.
 * A declared order limit outside the band is not itself a rejection. */
export interface BorosRateBand {
  low: number;
  high: number;
}

function wireNumber(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** max(k_iThresh, abs(rMark)) * maxRateDeviationFactorBase1e4 / 10000.
 * Missing inputs remain unknown; a genuine zero mark/factor remains valid. */
export function nativeRateDeviationApr(input: {
  markApr: unknown;
  iTickThresh: unknown;
  tickStep: unknown;
  factorBase1e4: unknown;
}): number | null {
  const mark = wireNumber(input.markApr);
  const threshold = wireNumber(input.iTickThresh);
  const step = wireNumber(input.tickStep);
  const factor = wireNumber(input.factorBase1e4);
  if (mark === null || threshold === null || step === null || factor === null) return null;
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 32767 ||
      !Number.isInteger(step) || step < 0 || step >= 16 ||
      !Number.isInteger(factor) || factor < 0 || factor > 65535) return null;
  const floor = 1.00005 ** (threshold * step) - 1;
  const cap = Math.max(floor, Math.abs(mark)) * factor / 10000;
  return Number.isFinite(cap) ? cap : null;
}

export function borosRateBand(market: {
  markApr: number;
  maxRateDeviationApr: number | null;
}): BorosRateBand | null {
  const { markApr: mark, maxRateDeviationApr: cap } = market;
  if (!Number.isFinite(mark) || cap === null || !Number.isFinite(cap) || cap < 0) return null;
  return { low: mark - cap, high: mark + cap };
}

export function rateInsideBand(rate: number, band: BorosRateBand): boolean {
  return Number.isFinite(rate) && rate >= band.low && rate <= band.high;
}
