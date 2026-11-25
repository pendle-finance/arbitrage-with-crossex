import { describe, expect, it } from 'vitest';
import { dealSlippage } from './dealSlippage';

describe('dealSlippage', () => {
  it('open sign', () => {
    const s = dealSlippage({ longAvg: 1729.84, shortAvg: 1730.21, qty: 1, close: false })!;
    expect(s.usd).toBeCloseTo(0.37, 6);
    expect(s.pct * 100).toBeCloseTo(0.0214, 3);
    expect(s.word).toBe('Favorable');
  });

  it('close sign', () => {
    const s = dealSlippage({ longAvg: 1729.84, shortAvg: 1730.21, qty: 1, close: true })!;
    expect(s.usd).toBeCloseTo(-0.37, 6);
    expect(s.pct).toBeLessThan(0);
    expect(s.word).toBe('Adverse');
  });

  it('scales with size at $6M', () => {
    const s = dealSlippage({ longAvg: 1729.84, shortAvg: 1730.21, qty: 3468, close: false })!;
    expect(s.usd).toBeCloseTo(0.37 * 3468, 4);
  });

  it('is null without both averages', () => {
    expect(dealSlippage({ longAvg: NaN, shortAvg: 1730, qty: 1, close: false })).toBeNull();
    expect(dealSlippage({ longAvg: 1730, shortAvg: 0, qty: 1, close: false })).toBeNull();
  });
});
