import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BorosSettlementLedger, BorosSettlementRow } from '../core/boros/client';
import { writeOwnerOnlyJson } from './secretFile';

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function parseRow(raw: unknown): BorosSettlementRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.marketAcc !== 'string') return null;
  if (r.tokenId !== null && !isNumber(r.tokenId)) return null;
  if (![r.marketId, r.timeSec, r.positionAbs, r.settlementToken, r.feeToken].every(isNumber)) return null;
  return {
    id: r.id,
    marketAcc: r.marketAcc,
    tokenId: r.tokenId as number | null,
    marketId: r.marketId as number,
    timeSec: r.timeSec as number,
    positionAbs: r.positionAbs as number,
    settlementToken: r.settlementToken as number,
    feeToken: r.feeToken as number,
    settlementRate: isNumber(r.settlementRate) ? r.settlementRate : Number.NaN,
  };
}

function parseLedger(raw: unknown): BorosSettlementLedger | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!isNumber(r.coversFromSec) || !Array.isArray(r.rows)) return null;
  const rows: BorosSettlementRow[] = [];
  for (const item of r.rows) {
    const row = parseRow(item);
    if (!row) return null;
    rows.push(row);
  }
  return { rows, coversFromSec: r.coversFromSec };
}

export class LedgerStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = dataDir;
  }

  private fileFor(address: string): string {
    return path.join(this.dir, `boros-ledger-${address.toLowerCase()}.json`);
  }

  read(address: string): BorosSettlementLedger | null {
    try {
      return parseLedger(JSON.parse(fs.readFileSync(this.fileFor(address), 'utf8')));
    } catch {
      return null;
    }
  }

  write(address: string, ledger: BorosSettlementLedger): void {
    writeOwnerOnlyJson(this.fileFor(address), ledger);
  }
}
