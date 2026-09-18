import { describe, expect, it } from 'vitest';
import { fetchBorosTransactions, type FetchLike } from '../../src/core/boros/client';

const MARKET_ACC = '0x' + 'ab'.repeat(20) + '00' + '0003' + 'ffffff';

const fill = (id: string, timestamp: number) => ({
  id,
  marketId: 155,
  timestamp,
  fee: '1',
  pnl: '-1',
  tradeRate: 0.05,
  prevPositionS: '0',
  postPositionS: '1',
});

function feed(rows: Array<ReturnType<typeof fill>>, calls: string[]): FetchLike {
  return async (url: string) => {
    const u = new URL(url);
    const from = Number(u.searchParams.get('resumeToken') ?? 0);
    calls.push(String(from));
    const to = from + Number(u.searchParams.get('limit'));
    const body = { results: rows.slice(from, to), resumeToken: to < rows.length ? String(to) : null };
    return { ok: true, status: 200, json: async () => body };
  };
}

const history = Array.from({ length: 500 }, (_, i) => fill(`f${500 - i}`, 10_000 - i));

describe('fetchBorosTransactions with fills already held', () => {
  it('a second read with no new fills reads one page', async () => {
    const calls: string[] = [];
    const first = await fetchBorosTransactions(feed(history, calls), MARKET_ACC, 155);
    expect(calls).toHaveLength(3);
    calls.length = 0;
    const second = await fetchBorosTransactions(feed(history, calls), MARKET_ACC, 155, { prev: first });
    expect(calls).toHaveLength(1);
    expect(second).toEqual(first);
  });

  it('reads only the fills newer than the held ones', async () => {
    const first = await fetchBorosTransactions(feed(history, []), MARKET_ACC, 155);
    const calls: string[] = [];
    const newer = [fill('f502', 10_002), fill('f501', 10_001)];
    const next = await fetchBorosTransactions(feed([...newer, ...history], calls), MARKET_ACC, 155, {
      prev: first,
    });
    expect(calls).toHaveLength(1);
    expect(next.txns.map((t) => t.id)).toEqual(['f502', 'f501', ...first.txns.map((t) => t.id)]);
    expect(next.complete).toBe(true);
  });

  it('keeps a capped read marked incomplete', async () => {
    const endless: FetchLike = async (url: string) => {
      const n = Number(new URL(url).searchParams.get('resumeToken') ?? 0);
      const body = { results: [fill(`e${100 - n}`, 1_000 - n)], resumeToken: String(n + 1) };
      return { ok: true, status: 200, json: async () => body };
    };
    const capped = await fetchBorosTransactions(endless, MARKET_ACC, 155);
    expect(capped.txns).toHaveLength(30);
    expect(capped.complete).toBe(false);
    const again = await fetchBorosTransactions(endless, MARKET_ACC, 155, { prev: capped });
    expect(again).toEqual(capped);
  });

  it('paces every page', async () => {
    let paced = 0;
    await fetchBorosTransactions(feed(history, []), MARKET_ACC, 155, {
      pace: async () => {
        paced += 1;
      },
    });
    expect(paced).toBe(3);
  });
});
