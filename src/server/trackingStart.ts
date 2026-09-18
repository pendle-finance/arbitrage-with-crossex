import * as path from 'node:path';
import { isSupportedCoin } from '../core/coins';
import { parseSymbol } from '../core/numbers';
import { readOwnerJson, writeOwnerOnlyJson } from './secretFile';

export interface TrackingStart {
  userId: string;
  firstOpenMs: number;
}

function parseStart(raw: unknown): TrackingStart | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.userId !== 'string' || typeof r.firstOpenMs !== 'number' || !(r.firstOpenMs > 0)) return null;
  return { userId: r.userId, firstOpenMs: r.firstOpenMs };
}

export class TrackingStartFile {
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'tracking-start.json');
  }

  read(): TrackingStart | null {
    return readOwnerJson(this.file, parseStart);
  }

  write(start: TrackingStart): void {
    writeOwnerOnlyJson(this.file, start);
  }
}

export function earliestSupportedOpenMs(rows: Array<{ symbol?: string; createTime?: string }>): number | null {
  let earliest: number | null = null;
  for (const row of rows) {
    if (!isSupportedCoin(parseSymbol(row.symbol ?? '').base)) continue;
    const n = Number(row.createTime);
    if (!Number.isFinite(n) || n <= 0) continue;
    const ms = n < 1e12 ? n * 1000 : n;
    if (earliest === null || ms < earliest) earliest = ms;
  }
  return earliest;
}
