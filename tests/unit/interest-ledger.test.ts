import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CoreError } from '../../src/core/errors';
import {
  GATE_HISTORY_FLOOR_MS,
  INTEREST_MAX_PAGES,
  INTEREST_OVERFLOW,
  INTEREST_PAGE_SIZE,
  InterestFile,
  syncInterest,
  type InterestQuery,
  type InterestRowLike,
} from '../../src/server/interestLedger';

const dir = () => mkdtempSync(path.join(tmpdir(), 'interest-'));

const row = (id: string, createTime: number, interest: string, coin = 'USDC', venue = 'HYPERLIQUID'): InterestRowLike => ({
  interestId: id,
  liabilityCoin: coin,
  exchangeType: venue,
  interest,
  createTime: String(createTime),
});

/** A Gate that serves `rows` newest first, paged, and records every query. */
function gate(rows: InterestRowLike[]) {
  const queries: InterestQuery[] = [];
  const list = async (q: InterestQuery): Promise<InterestRowLike[]> => {
    queries.push(q);
    const inRange = rows.filter((r) => Number(r.createTime) >= q.from && Number(r.createTime) <= q.to);
    const newestFirst = [...inRange].sort((a, b) => Number(b.createTime) - Number(a.createTime));
    return newestFirst.slice((q.page - 1) * q.limit, q.page * q.limit);
  };
  return { list, queries };
}

const T0 = GATE_HISTORY_FLOOR_MS + 1_000_000;
const HOUR = 3_600_000;

describe('syncInterest', () => {
  it('counts every row since the floor on the first sync, by wallet, and writes the ledger', async () => {
    const file = new InterestFile(dir());
    const g = gate([
      row('a', T0, '1.5'),
      row('b', T0 + HOUR, '2.25'),
      row('c', T0 + HOUR, '4', 'USDT', 'CROSSEX'),
      row('d', T0 + 2 * HOUR, '0.5'),
    ]);

    const paid = await syncInterest(file, '1', g.list, T0 + 3 * HOUR);

    expect(paid).toEqual({ 'USDC/HYPERLIQUID': 4.25, 'USDT/CROSSEX': 4 });
    expect(g.queries).toEqual([{ from: GATE_HISTORY_FLOOR_MS, to: T0 + 3 * HOUR, page: 1, limit: INTEREST_PAGE_SIZE }]);
    expect(file.read()).toEqual({ userId: '1', through: T0 + 2 * HOUR, seenAtThrough: ['d'], paid });
  });

  it('pages until a short page', async () => {
    const file = new InterestFile(null);
    const rows = Array.from({ length: INTEREST_PAGE_SIZE + 5 }, (_, i) => row(`r${i}`, T0 + i * HOUR, '0.01'));
    const g = gate(rows);

    const paid = await syncInterest(file, '1', g.list, T0 + 2000 * HOUR);

    expect(paid['USDC/HYPERLIQUID']).toBeCloseTo((INTEREST_PAGE_SIZE + 5) * 0.01, 6);
    expect(g.queries.map((q) => q.page)).toEqual([1, 2]);
  });

  it('reads only the rows since the newest one it has, and does not count that one twice', async () => {
    const file = new InterestFile(dir());
    const rows = [row('a', T0, '1'), row('b', T0 + HOUR, '2'), row('b2', T0 + HOUR, '3', 'USDT', 'CROSSEX')];
    const g = gate(rows);
    await syncInterest(file, '1', g.list, T0 + HOUR);

    rows.push(row('c', T0 + 2 * HOUR, '4'));
    const paid = await syncInterest(file, '1', g.list, T0 + 2 * HOUR);

    expect(paid).toEqual({ 'USDC/HYPERLIQUID': 7, 'USDT/CROSSEX': 3 });
    expect(g.queries[1]).toMatchObject({ from: T0 + HOUR, page: 1 });
    expect(file.read()).toMatchObject({ through: T0 + 2 * HOUR, seenAtThrough: ['c'] });
  });

  it('counts a late row at the newest timestamp once, by id', async () => {
    const file = new InterestFile(null);
    const rows = [row('a', T0 + HOUR, '1')];
    const g = gate(rows);
    await syncInterest(file, '1', g.list, T0 + HOUR);

    rows.push(row('late', T0 + HOUR, '2', 'USDT', 'CROSSEX'));
    await syncInterest(file, '1', g.list, T0 + HOUR);
    const paid = await syncInterest(file, '1', g.list, T0 + HOUR);

    expect(paid).toEqual({ 'USDC/HYPERLIQUID': 1, 'USDT/CROSSEX': 2 });
    expect(file.read()).toMatchObject({ seenAtThrough: ['a', 'late'] });
  });

  it('writes nothing when there are no new rows', async () => {
    const d = dir();
    const file = new InterestFile(d);
    const g = gate([row('a', T0, '1')]);
    await syncInterest(file, '1', g.list, T0);
    const before = readFileSync(path.join(d, 'interest.json'), 'utf8');

    await syncInterest(file, '1', g.list, T0 + HOUR);

    expect(readFileSync(path.join(d, 'interest.json'), 'utf8')).toBe(before);
  });

  it('starts a fresh ledger for another Gate account', async () => {
    const file = new InterestFile(dir());
    const g = gate([row('a', T0, '1')]);
    await syncInterest(file, '1', g.list, T0);

    const paid = await syncInterest(file, '2', g.list, T0);

    expect(paid).toEqual({ 'USDC/HYPERLIQUID': 1 });
    expect(g.queries[1]).toMatchObject({ from: GATE_HISTORY_FLOOR_MS });
    expect(file.read()).toMatchObject({ userId: '2' });
  });

  it('starts from the floor again when the file is not a ledger', async () => {
    const d = dir();
    writeFileSync(path.join(d, 'interest.json'), '{"through": "yesterday"}');
    const file = new InterestFile(d);
    const g = gate([row('a', T0, '1')]);

    expect(file.read()).toBeNull();
    expect(await syncInterest(file, '1', g.list, T0)).toEqual({ 'USDC/HYPERLIQUID': 1 });
  });

  it('ignores a row Gate sends from before the window, and a row with no time', async () => {
    const file = new InterestFile(null);
    const list = async () => [row('old', GATE_HISTORY_FLOOR_MS - 1, '9'), { ...row('x', T0, '5'), createTime: undefined }, row('a', T0, '1')];

    expect(await syncInterest(file, '1', list, T0)).toEqual({ 'USDC/HYPERLIQUID': 1 });
  });

  it('refuses to count a partial read: throws the overflow error and leaves the ledger alone', async () => {
    const file = new InterestFile(null);
    const g = gate([row('a', T0, '1')]);
    await syncInterest(file, '1', g.list, T0);
    const before = file.read();
    let pages = 0;
    const endless = async (q: InterestQuery) => {
      pages += 1;
      return Array.from({ length: q.limit }, (_, i) => row(`p${q.page}-${i}`, T0 + HOUR + q.page * 1000 + i, '0.01'));
    };

    await expect(syncInterest(file, '1', endless, T0 + 2 * HOUR)).rejects.toSatisfy(
      (e: unknown) => e instanceof CoreError && e.details === INTEREST_OVERFLOW,
    );
    expect(pages).toBe(INTEREST_MAX_PAGES);
    expect(file.read()).toEqual(before);
  });
});
