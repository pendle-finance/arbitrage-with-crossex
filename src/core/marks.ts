/** The positions read is cached 2 s and the screens poll every 4 s, so 60 s is 15 polls. */
export const MARK_MEMORY_MS = 60_000;

export interface MarkRow {
  symbol?: string;
  markPrice?: string;
}

export type MarkedRow<T> = T & { markStaleSinceMs?: number };

export interface MarkPatch<T> {
  rows: Array<MarkedRow<T>>;
  unknown: Map<string, number>;
}

interface Remembered {
  mark: number | null;
  atMs: number;
}

const store = new Map<string, Remembered>();

export function resetMarkMemory(): void {
  store.clear();
}

export function rememberMarks<T extends MarkRow>(rows: readonly T[], nowMs: number = Date.now()): MarkPatch<T> {
  const out: Array<MarkedRow<T>> = [];
  const unknown = new Map<string, number>();
  for (const row of rows) {
    const symbol = row.symbol ?? '';
    const mark = Number(row.markPrice);
    if (symbol.length === 0 || (Number.isFinite(mark) && mark > 0)) {
      if (symbol.length > 0) store.set(symbol, { mark, atMs: nowMs });
      out.push(row);
      continue;
    }
    const last = store.get(symbol);
    if (last && last.mark !== null && nowMs - last.atMs <= MARK_MEMORY_MS) {
      out.push({ ...row, markPrice: String(last.mark) });
      continue;
    }
    const sinceMs = last ? last.atMs : nowMs;
    if (!last) store.set(symbol, { mark: null, atMs: nowMs });
    unknown.set(symbol, sinceMs);
    out.push({ ...row, markStaleSinceMs: sinceMs });
  }
  return { rows: out, unknown };
}
