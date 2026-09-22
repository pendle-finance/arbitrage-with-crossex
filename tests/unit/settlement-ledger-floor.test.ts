import { describe, expect, it } from 'vitest';
import {
  createRequestPacer,
  settlementWindow,
  syncSettlementLedger,
  type BorosSettlementLedger,
  type FetchLike,
} from '../../src/core/boros/client';

const ROOT = '0x' + 'ab'.repeat(20);
const MARKET_ACC = ROOT + '00' + '0003' + 'ffffff';
const FLOOR = Date.UTC(2026, 2, 3) / 1000;
const STEP = 1_800;
const noWait = async (): Promise<void> => {};

interface WireRow {
  id: string;
  timestamp: number;
  marketAcc: string;
  marketId: number;
  positionSize: string;
  settlement: string;
  fee: string;
  settlementRate: number;
}

function history(afterFloor: number, beforeFloor: number, prefix = 's'): WireRow[] {
  const total = afterFloor + beforeFloor;
  return Array.from({ length: total }, (_, i) => ({
    id: `${prefix}${total - i}`,
    timestamp: FLOOR + (afterFloor - 1 - i) * STEP + (i < afterFloor ? 1 : -STEP),
    marketAcc: MARKET_ACC,
    marketId: 155,
    positionSize: '1000000000000000000',
    settlement: '1000000000000000',
    fee: '0',
    settlementRate: 0.1,
  }));
}

function feed(rows: WireRow[], onPage: (url: URL) => void = () => {}): FetchLike {
  return async (url: string) => {
    const u = new URL(url);
    onPage(u);
    const from = Number(u.searchParams.get('resumeToken') ?? 0);
    const to = from + Number(u.searchParams.get('limit'));
    const body = { results: rows.slice(from, to), resumeToken: to < rows.length ? String(to) : null };
    return { ok: true, status: 200, json: async () => body };
  };
}

describe('syncSettlementLedger floor', () => {
  it('reads past the old 30-page cap', async () => {
    let pages = 0;
    const ledger = await syncSettlementLedger(
      feed(history(12_000, 200), () => (pages += 1)),
      ROOT,
      0,
      undefined,
      { floorSec: FLOOR, pace: noWait },
    );
    expect(pages).toBe(61);
    expect(ledger.rows.filter((r) => r.timeSec >= FLOOR)).toHaveLength(12_000);
    expect(ledger.coversFromSec).toBeLessThan(FLOOR);
    expect(settlementWindow(ledger, FLOOR).coversFromSec).toBe(0);
  });

  it('stops at the floor', async () => {
    let pages = 0;
    const ledger = await syncSettlementLedger(
      feed(history(1_100, 5_000), () => (pages += 1)),
      ROOT,
      0,
      undefined,
      { floorSec: FLOOR, pace: noWait },
    );
    expect(pages).toBe(6);
    expect(ledger.rows).toHaveLength(1_200);
    expect(ledger.rows.filter((r) => r.timeSec >= FLOOR)).toHaveLength(1_100);
    expect(settlementWindow(ledger, FLOOR).coversFromSec).toBe(0);
    expect(settlementWindow(ledger, FLOOR - 1_000 * STEP).coversFromSec).toBe(ledger.coversFromSec);
  });

  it('at most 30 pages a minute', async () => {
    let clock = 0;
    const sentAt: number[] = [];
    const pace = createRequestPacer({
      perMinute: 30,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    await syncSettlementLedger(
      feed(history(30_000, 0), () => sentAt.push(clock)),
      ROOT,
      0,
      undefined,
      { floorSec: FLOOR, pace },
    );
    expect(sentAt).toHaveLength(150);
    for (let i = 0; i + 30 < sentAt.length; i += 1) {
      expect(sentAt[i + 30]! - sentAt[i]!).toBeGreaterThanOrEqual(60_000);
    }
  });

  it('reads below a ledger that stopped at a later floor, with no row twice', async () => {
    const all = history(2_000, 1_000);
    const laterFloor = FLOOR + 1_000 * STEP;
    const prev: BorosSettlementLedger = await syncSettlementLedger(feed(all), ROOT, 0, undefined, {
      floorSec: laterFloor,
      pace: noWait,
    });
    expect(prev.coversFromSec).toBeGreaterThan(FLOOR);

    const newer = history(2_050, 0, 'n').slice(0, 50);
    const next = await syncSettlementLedger(feed([...newer, ...all]), ROOT, 0, prev, {
      floorSec: FLOOR,
      pace: noWait,
    });
    const ids = next.rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(next.rows[0]!.id).toBe(newer[0]!.id);
    expect(next.rows.filter((r) => r.timeSec >= FLOOR)).toHaveLength(2_050);
    expect(settlementWindow(next, FLOOR).coversFromSec).toBe(0);
  });

  it('refreshes only the head when the ledger already reaches the floor', async () => {
    const all = history(400, 200);
    const prev = await syncSettlementLedger(feed(all), ROOT, 0, undefined, { floorSec: FLOOR, pace: noWait });
    let pages = 0;
    const next = await syncSettlementLedger(
      feed(all, () => (pages += 1)),
      ROOT,
      0,
      prev,
      { floorSec: FLOOR, pace: noWait },
    );
    expect(pages).toBe(1);
    expect(next).toEqual(prev);
  });
});
