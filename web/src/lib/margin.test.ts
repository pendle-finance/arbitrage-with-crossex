import { describe, expect, it } from 'vitest';
import type { CrossexAccount } from '../api/types';
import { marginParts } from './margin';

/** Real-account shape where Gate's coverage-ratio fields look "reversed"
 * (maintenanceMarginRate > initialMarginRate). We ignore those fields. */
const acc: CrossexAccount = {
  marginBalance: '969.8236',
  availableMargin: '222.7514',
  initialMargin: '747.0722',
  maintenanceMargin: '268.5796',
  initialMarginRate: '1.2981', // coverage ratio — intentionally not used
  maintenanceMarginRate: '3.6109',
  accountMode: 'CROSS_EXCHANGE',
  positionMode: 'ONE_WAY',
  assets: [],
};

describe('marginParts', () => {
  it('computes utilization as margin ÷ balance (initial > maintenance, not reversed)', () => {
    const p = marginParts(acc);
    expect(p.imPct).toBeCloseTo(0.7703, 4);
    expect(p.mmPct).toBeCloseTo(0.2769, 4);
    expect(p.imPct).toBeGreaterThan(p.mmPct); // the fix: IM is the larger share
  });

  it('derives available so used + free closes the ring exactly', () => {
    const p = marginParts(acc);
    expect(p.initial + p.available).toBeCloseTo(p.balance, 6);
  });

  it('handles a funded account with no positions (no sentinel leakage)', () => {
    const flat = { ...acc, initialMargin: '0', maintenanceMargin: '0', availableMargin: '969.8236' };
    const p = marginParts(flat);
    expect(p.imPct).toBe(0);
    expect(p.mmPct).toBe(0);
    expect(p.available).toBeCloseTo(p.balance, 6);
  });

  it('guards a zero-balance account', () => {
    const empty = { ...acc, marginBalance: '0', initialMargin: '0', maintenanceMargin: '0', availableMargin: '0' };
    const p = marginParts(empty);
    expect(p.hasFunds).toBe(false);
    expect(p.imPct).toBe(0);
  });
});
