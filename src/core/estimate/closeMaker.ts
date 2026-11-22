export type MakerLegInput = {
  makerRate: number | null;
  takerRate: number | null;
  slippagePct: number | null;
};

export function pickCloseMakerLeg(a: MakerLegInput, b: MakerLegInput): 0 | 1 {
  if (
    a.makerRate !== null &&
    a.takerRate !== null &&
    b.makerRate !== null &&
    b.takerRate !== null
  ) {
    const restA = a.makerRate + b.takerRate;
    const restB = b.makerRate + a.takerRate;
    if (restB < restA - 1e-12) return 1;
    if (restA < restB - 1e-12) return 0;
  }
  return (b.slippagePct ?? 0) > (a.slippagePct ?? 0) + 1e-9 ? 1 : 0;
}
