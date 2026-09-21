import { beforeEach, describe, expect, it } from 'vitest';
import { MARK_MEMORY_MS, rememberMarks, resetMarkMemory } from '../../src/core/marks';

const t0 = Date.parse('2026-09-21T14:32:00Z');
const eth = (markPrice: string) => ({ symbol: 'GATE_FUTURE_ETH_USDT', markPrice });

describe('the last mark Gate sent', () => {
  beforeEach(resetMarkMemory);

  it('carries a leg through a blank, a zero and a non-number for 60 s', () => {
    rememberMarks([eth('2300')], t0);
    for (const [bad, at] of [
      ['', 1_000],
      ['0', 30_000],
      ['n/a', MARK_MEMORY_MS],
    ] as const) {
      const { rows, unknown } = rememberMarks([eth(bad)], t0 + at);
      expect(rows[0].markPrice).toBe('2300');
      expect(rows[0].markStaleSinceMs).toBeUndefined();
      expect(unknown.size).toBe(0);
    }
  });

  it('gives up past 60 s and reports when the price was last seen', () => {
    rememberMarks([eth('2300')], t0);
    const { rows, unknown } = rememberMarks([eth('')], t0 + MARK_MEMORY_MS + 1);
    expect(rows[0].markPrice).toBe('');
    expect(rows[0].markStaleSinceMs).toBe(t0);
    expect(unknown.get('GATE_FUTURE_ETH_USDT')).toBe(t0);
  });

  it('is unknown at once for a leg that never had a price', () => {
    const { rows, unknown } = rememberMarks([eth('')], t0);
    expect(rows[0].markStaleSinceMs).toBe(t0);
    expect(unknown.get('GATE_FUTURE_ETH_USDT')).toBe(t0);
  });

  it('takes the next real price and drops the stale stamp', () => {
    rememberMarks([eth('')], t0);
    const back = rememberMarks([eth('2400')], t0 + 5_000);
    expect(back.rows[0].markStaleSinceMs).toBeUndefined();
    expect(rememberMarks([eth('')], t0 + 10_000).rows[0].markPrice).toBe('2400');
  });

  it('remembers a $0.00004321 mark and a $6,000,000 one exactly', () => {
    const rows = [
      { symbol: 'GATE_FUTURE_PEPE_USDT', markPrice: '0.00004321' },
      { symbol: 'GATE_FUTURE_BTC_USDT', markPrice: '6000000' },
    ];
    rememberMarks(rows, t0);
    const back = rememberMarks(
      rows.map((r) => ({ ...r, markPrice: '' })),
      t0 + 1_000,
    );
    expect(back.rows.map((r) => r.markPrice)).toEqual(['0.00004321', '6000000']);
  });

  it('leaves a row with no symbol alone', () => {
    const { rows, unknown } = rememberMarks([{ markPrice: '' }], t0);
    expect(rows[0].markStaleSinceMs).toBeUndefined();
    expect(unknown.size).toBe(0);
  });
});
