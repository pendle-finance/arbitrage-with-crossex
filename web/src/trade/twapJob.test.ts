import { describe, expect, it } from 'vitest';
import type { RebalanceJob } from '../api/types';
import { isTwapChildId, liveTwapJob } from './twapJob';

describe('isTwapChildId', () => {
  it('accepts a slice child id', () => {
    expect(isTwapChildId('job1-s3-1', 'job1')).toBe(true);
    expect(isTwapChildId('job1-s12-2', 'job1')).toBe(true);
  });

  it('accepts an unwind or add-back child id', () => {
    expect(isTwapChildId('job1-f1', 'job1')).toBe(true);
    expect(isTwapChildId('job1-f14', 'job1')).toBe(true);
  });

  it('refuses another job, a zero index or a plain deal id', () => {
    expect(isTwapChildId('job2-s3-1', 'job1')).toBe(false);
    expect(isTwapChildId('job1-s0-1', 'job1')).toBe(false);
    expect(isTwapChildId('job1-f0', 'job1')).toBe(false);
    expect(isTwapChildId('job1-s3', 'job1')).toBe(false);
    expect(isTwapChildId('deal-abc', 'job1')).toBe(false);
    expect(isTwapChildId('-s3-1', '')).toBe(false);
  });
});

describe('liveTwapJob', () => {
  const job = (over: Partial<RebalanceJob>) => ({ id: 'j', status: 'running', twap: { slice: 1, of: 2 }, ...over }) as unknown as RebalanceJob;

  it('takes a TWAP and a Delever TWAP while running or halted', () => {
    expect(liveTwapJob(job({ kind: 'twap' }))).not.toBeNull();
    expect(liveTwapJob(job({ kind: 'delever', status: 'halted' }))).not.toBeNull();
    expect(liveTwapJob(job({ kind: 'realize' }))).not.toBeNull();
    expect(liveTwapJob(job({ kind: 'realize', twap: undefined }))).toBeNull();
  });

  it('skips a Delever without TWAP and an ended run', () => {
    expect(liveTwapJob(job({ kind: 'delever', twap: undefined }))).toBeNull();
    expect(liveTwapJob(job({ kind: 'twap', status: 'done' }))).toBeNull();
  });
});
