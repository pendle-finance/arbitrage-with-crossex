/**
 * Unit coverage for the standalone cleanup script's attribution logic
 * (tests/live/cleanup-attribution.ts — extracted from cleanup.ts so it is
 * importable; cleanup.ts runs main()+process.exit on import, so it cannot itself
 * be imported from a test).
 *
 * GAP: main()'s process.exit orchestration (missing-state → exit 1 "manual review
 * required"; the per-symbol refuse-to-close loop) is NOT invoked directly here — it
 * is a top-level script with process.exit side effects. Its decisions are built
 * from the pure predicates below (isStateStale, isAttributable) plus readLastRun()→null,
 * which ARE covered; the orchestration wiring itself remains untested.
 */
import { describe, expect, it } from 'vitest';
import type { CrossexOrder } from 'gate-api';
import type { Clients } from '../../src/core/clients';
import {
  createTimeMs,
  isAttributable,
  isStateStale,
  MAX_STATE_AGE_MS,
  openingOrdersSince,
} from '../live/cleanup-attribution';

const order = (over: Partial<CrossexOrder>): CrossexOrder => over as CrossexOrder;

describe('createTimeMs', () => {
  it('scales a seconds timestamp (< 1e12) to ms', () => {
    expect(createTimeMs(order({ createTime: '1751490000' }))).toBe(1751490000000);
  });
  it('leaves a millisecond timestamp (>= 1e12) as-is', () => {
    expect(createTimeMs(order({ createTime: '1751490000000' }))).toBe(1751490000000);
  });
  it('returns 0 for a missing / non-numeric createTime', () => {
    expect(createTimeMs(order({ createTime: undefined }))).toBe(0);
    expect(createTimeMs(order({ createTime: 'not-a-number' }))).toBe(0);
  });
});

describe('openingOrdersSince', () => {
  const startedAt = 1_700_000_000_000; // ms

  function clientsReturning(body: Partial<CrossexOrder>[]): { clients: Clients; calls: Record<string, unknown>[] } {
    const calls: Record<string, unknown>[] = [];
    const clients = {
      crossEx: {
        listCrossexHistoryOrders: async (opts: Record<string, unknown>) => {
          calls.push(opts);
          return { body };
        },
      },
    } as unknown as Clients;
    return { clients, calls };
  }

  it('narrows the history page via `from` in ms, startedAt - 60,000, as Gate refuses seconds there', async () => {
    const { clients, calls } = clientsReturning([]);
    await openingOrdersSince(clients, 'GATE_FUTURE_ETH_USDT', startedAt);
    expect(calls[0]).toMatchObject({
      symbol: 'GATE_FUTURE_ETH_USDT',
      limit: 100,
      from: startedAt - 60_000,
    });
    expect(calls[0].from).toBe(1_699_999_940_000);
  });

  it('sends `from` 0 when the run started under 60 seconds after the epoch', async () => {
    const { clients, calls } = clientsReturning([]);
    await openingOrdersSince(clients, 'GATE_FUTURE_ETH_USDT', 30_000);
    expect(calls[0]).toMatchObject({ from: 0 });
  });

  it('drops reduce-only orders and orders older than the (startedAt − 60s) window; sorts newest first', async () => {
    const { clients } = clientsReturning([
      { orderId: 'old', createTime: String(startedAt - 120_000), reduceOnly: 'false', text: 'lt_a_0' }, // too old
      { orderId: 'reduce', createTime: String(startedAt + 5_000), reduceOnly: 'true', text: 'lt_a_1' }, // reduce-only
      { orderId: 'new', createTime: String(startedAt + 30_000), reduceOnly: 'false', text: 'lt_a_2' }, // keep
      { orderId: 'newer', createTime: String(startedAt + 90_000), reduceOnly: 'false', text: 'lt_a_3' }, // keep, newest
    ]);
    const out = await openingOrdersSince(clients, 'GATE_FUTURE_ETH_USDT', startedAt);
    expect(out.map((o) => o.orderId)).toEqual(['newer', 'new']); // newest-first, filtered
  });

  it('empty history → empty list', async () => {
    const { clients } = clientsReturning([]);
    expect(await openingOrdersSince(clients, 'GATE_FUTURE_ETH_USDT', startedAt)).toEqual([]);
  });
});

describe('isAttributable', () => {
  it('true only when the newest opening order carries the run tag prefix', () => {
    expect(isAttributable(order({ text: 'lt123_abc_0' }), 'lt123')).toBe(true);
    expect(isAttributable(order({ text: 'other_run_0' }), 'lt123')).toBe(false); // mismatch → refuse to close
    expect(isAttributable(order({ text: undefined }), 'lt123')).toBe(false);
    expect(isAttributable(undefined, 'lt123')).toBe(false); // no opening order found → refuse
  });
});

describe('isStateStale', () => {
  const now = 2_000_000_000_000;
  it('true when the run state is older than 24h (refuse to act)', () => {
    expect(isStateStale(now - MAX_STATE_AGE_MS - 1, now)).toBe(true);
  });
  it('false when the run state is within 24h', () => {
    expect(isStateStale(now - 60_000, now)).toBe(false);
    expect(isStateStale(now - MAX_STATE_AGE_MS + 1, now)).toBe(false);
  });
});
