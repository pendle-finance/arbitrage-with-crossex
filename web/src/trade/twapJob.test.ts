import { describe, expect, it } from 'vitest';
import { isTwapChildId } from './twapJob';

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
