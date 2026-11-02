const PIVOT_CAP = 5_000;
const TINY = 1e-12;

export function maximize(c: number[], A: number[][], b: number[]): number[] {
  const m = A.length;
  const n = c.length;
  const width = n + m;
  const T = A.map((row, i) => [...row, ...Array.from({ length: m }, (_, j) => (i === j ? 1 : 0)), b[i]]);
  const z = [...c.map((v) => -v), ...Array<number>(m).fill(0), 0];
  const basis = Array.from({ length: m }, (_, i) => n + i);
  for (let pivots = 0; ; pivots++) {
    const entering = z.findIndex((v, j) => j < width && v < -TINY);
    if (entering < 0) break;
    if (pivots === PIVOT_CAP) throw new Error('grouping: solve did not finish');
    let leaving = -1;
    let best = Infinity;
    for (let i = 0; i < m; i++) {
      if (T[i][entering] <= TINY) continue;
      const ratio = T[i][width] / T[i][entering];
      if (ratio < best - TINY || (Math.abs(ratio - best) <= TINY && basis[i] < basis[leaving])) {
        best = ratio;
        leaving = i;
      }
    }
    if (leaving < 0) throw new Error('grouping: program is unbounded');
    const pivotRow = T[leaving];
    const pivot = pivotRow[entering];
    for (let j = 0; j <= width; j++) pivotRow[j] /= pivot;
    for (let i = 0; i < m; i++) {
      const f = T[i][entering];
      if (i === leaving || f === 0) continue;
      for (let j = 0; j <= width; j++) T[i][j] -= f * pivotRow[j];
    }
    const f = z[entering];
    for (let j = 0; j <= width; j++) z[j] -= f * pivotRow[j];
    basis[leaving] = entering;
  }
  const x = Array<number>(n).fill(0);
  basis.forEach((v, i) => {
    if (v < n) x[v] = T[i][width];
  });
  return x;
}
