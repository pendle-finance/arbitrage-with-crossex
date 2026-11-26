export function dealSlippage(input: {
  longAvg: number;
  shortAvg: number;
  qty: number;
  close: boolean;
}): { usd: number; pct: number; word: 'Favorable' | 'Adverse' } | null {
  const { longAvg, shortAvg, qty, close } = input;
  if (![longAvg, shortAvg, qty].every(Number.isFinite) || longAvg <= 0 || shortAvg <= 0 || qty <= 0) {
    return null;
  }
  const sign = close ? -1 : 1;
  const diff = (shortAvg - longAvg) * sign;
  const ref = (longAvg + shortAvg) / 2;
  return { usd: diff * qty, pct: diff / ref, word: diff >= 0 ? 'Favorable' : 'Adverse' };
}
