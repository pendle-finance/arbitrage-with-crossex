import { describe, expect, it } from 'vitest';
import type { RebalanceJob } from './types';
import { rebalancePollMs } from './queries';

const NOW = 1_000_000;

function twapJob(over: Partial<RebalanceJob> = {}, nextAt: number | null = NOW + 60_000): RebalanceJob {
  return { id: 'j', kind: 'twap', status: 'running', child: null, twap: { slice: 3, of: 12, nextAt }, ...over } as unknown as RebalanceJob;
}

describe('rebalancePollMs', () => {
  it('polls every second while a slice is live', () => {
    expect(rebalancePollMs(twapJob({ child: { mode: 'OPENING' } as never }), NOW)).toBe(1_000);
  });

  it('slows down between slices, up to 10 s', () => {
    expect(rebalancePollMs(twapJob(), NOW)).toBe(10_000);
    expect(rebalancePollMs(twapJob({}, NOW + 4_000), NOW)).toBe(4_000);
    expect(rebalancePollMs(twapJob({}, NOW - 5_000), NOW)).toBe(1_000);
  });

  it('keeps 1 s while pausing or with no next slice time', () => {
    expect(rebalancePollMs(twapJob({ pauseRequested: true }), NOW)).toBe(1_000);
    expect(rebalancePollMs(twapJob({}, null), NOW)).toBe(1_000);
  });

  it('keeps 1 s for a running rebalance and 10 s with no running job', () => {
    expect(rebalancePollMs({ id: 'r', kind: 'move', status: 'running' } as unknown as RebalanceJob, NOW)).toBe(1_000);
    expect(rebalancePollMs(twapJob({ status: 'halted' }), NOW)).toBe(10_000);
    expect(rebalancePollMs(null, NOW)).toBe(10_000);
  });
});
