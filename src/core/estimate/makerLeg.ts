export type MakerLegInput = {
  makerRate: number | null;
  takerRate: number | null;
  slippagePct: number | null;
  pastBookDepth?: number | null;
};

export type MakerLegPick = { leg: 'a' | 'b'; why: 'fees' | 'book' };

function thinnerBook(a: MakerLegInput, b: MakerLegInput): 'a' | 'b' {
  const depthA = a.pastBookDepth ?? null;
  const depthB = b.pastBookDepth ?? null;
  if (depthA !== null && depthB !== null) return depthB < depthA ? 'b' : 'a';
  if (depthA !== null) return 'a';
  if (depthB !== null) return 'b';
  return (b.slippagePct ?? 0) > (a.slippagePct ?? 0) + 1e-9 ? 'b' : 'a';
}

export function pickMakerLeg(a: MakerLegInput, b: MakerLegInput): MakerLegPick {
  if (
    a.makerRate !== null &&
    a.takerRate !== null &&
    b.makerRate !== null &&
    b.takerRate !== null
  ) {
    const restA = a.makerRate + b.takerRate;
    const restB = b.makerRate + a.takerRate;
    if (restB < restA - 1e-12) return { leg: 'b', why: 'fees' };
    if (restA < restB - 1e-12) return { leg: 'a', why: 'fees' };
  }
  return { leg: thinnerBook(a, b), why: 'book' };
}
