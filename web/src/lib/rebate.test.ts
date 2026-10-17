import { describe, expect, it } from 'vitest';
import type { Rebate } from '../api/types';
import { rebateAccountLabel, rebateAppliesTo, rebatedSettleApr, rebateChipLabel, rebateLegsNote } from './rebate';

const relative = (over: Partial<Rebate> = {}): Rebate => ({
  mode: 'relative',
  settlementFeePercentage: 0.8, // pays 80%, rebates 20%
  rebateBps: 2000,
  startTimestamp: 1790294400,
  endTimestamp: null,
  marketIds: null,
  active: true,
  ...over,
});

const absolute = (over: Partial<Rebate> = {}): Rebate => ({
  mode: 'absolute',
  settlementFeePercentage: 0.05, // cap the fee APR at 5%
  rebateBps: null,
  startTimestamp: 1790294400,
  endTimestamp: null,
  marketIds: null,
  active: true,
  ...over,
});

describe('rebateAppliesTo', () => {
  it('applies to any market when active and unscoped', () => {
    expect(rebateAppliesTo(relative(), 155)).toBe(true);
  });

  it('does not apply when null, inactive, or the market is out of scope', () => {
    expect(rebateAppliesTo(null, 155)).toBe(false);
    expect(rebateAppliesTo(relative({ active: false }), 155)).toBe(false);
    expect(rebateAppliesTo(relative({ marketIds: [1, 2] }), 155)).toBe(false);
    expect(rebateAppliesTo(relative({ marketIds: [155] }), 155)).toBe(true);
  });
});

describe('rebatedSettleApr — relative', () => {
  it('multiplies the settle-fee APR by the fee-paid fraction', () => {
    expect(rebatedSettleApr(0.001, relative(), 1)).toBeCloseTo(0.0008, 12);
    expect(rebatedSettleApr(0.0075, relative({ settlementFeePercentage: 0.5 }), 1)).toBeCloseTo(0.00375, 12);
  });
});

describe('rebatedSettleApr — absolute', () => {
  it('caps the settle-fee APR at the rebate rate', () => {
    expect(rebatedSettleApr(0.08, absolute(), 1)).toBeCloseTo(0.05, 12); // capped
    expect(rebatedSettleApr(0.02, absolute(), 1)).toBeCloseTo(0.02, 12); // already below cap
  });
});

describe('rebatedSettleApr — no-op cases', () => {
  it('is unchanged with no rebate, when inactive, or out of scope', () => {
    expect(rebatedSettleApr(0.001, null, 1)).toBe(0.001);
    expect(rebatedSettleApr(0.001, relative({ active: false }), 1)).toBe(0.001);
    expect(rebatedSettleApr(0.001, relative({ marketIds: [2] }), 1)).toBe(0.001);
  });
});

describe('rebateChipLabel', () => {
  it('renders the rebated percent for relative, the cap for absolute', () => {
    expect(rebateChipLabel(relative())).toBe('20% fee rebate');
    expect(rebateChipLabel(relative({ settlementFeePercentage: 0.5, rebateBps: 5000 }))).toBe('50% fee rebate');
    expect(rebateChipLabel(absolute())).toBe('Fee capped at 5%');
  });

  it('falls back to 1 − pct when rebateBps is absent', () => {
    expect(rebateChipLabel(relative({ rebateBps: null }))).toBe('20% fee rebate');
  });
});

describe('per-market overrides', () => {
  const nayt = relative({
    settlementFeePercentage: 0.6,
    rebateBps: 4000,
    marketIds: [1, 232, 233],
    marketFeeOverrides: [
      { marketId: 232, settlementFeePercentage: 0.5, rebateBps: 5000 },
      { marketId: 233, settlementFeePercentage: 0.5, rebateBps: 5000 },
    ],
  });

  it('prices an overridden market at its own rate and others at the base rate', () => {
    expect(rebatedSettleApr(0.001, nayt, 232)).toBeCloseTo(0.0005, 12);
    expect(rebatedSettleApr(0.001, nayt, 1)).toBeCloseTo(0.0006, 12);
  });

  it('caps an absolute override at its own rate', () => {
    const abs = absolute({ marketFeeOverrides: [{ marketId: 7, settlementFeePercentage: 0.02, rebateBps: null }] });
    expect(rebatedSettleApr(0.08, abs, 7)).toBeCloseTo(0.02, 12);
    expect(rebatedSettleApr(0.08, abs, 8)).toBeCloseTo(0.05, 12);
  });

  it('does not let an override reach a market outside marketIds', () => {
    const scoped = relative({ marketIds: [1], marketFeeOverrides: [{ marketId: 9, settlementFeePercentage: 0.5, rebateBps: 5000 }] });
    expect(rebatedSettleApr(0.001, scoped, 9)).toBe(0.001);
  });

  it('labels a card by the rates of its own markets', () => {
    expect(rebateChipLabel(nayt, [232])).toBe('50% fee rebate');
    expect(rebateChipLabel(nayt, [1])).toBe('40% fee rebate');
    expect(rebateChipLabel(nayt, [232, 233])).toBe('50% fee rebate');
    expect(rebateChipLabel(nayt, [1, 232])).toBe('40-50% fee rebate');
    expect(rebateChipLabel(nayt, [232, 1])).toBe('40-50% fee rebate');
    expect(rebateChipLabel(nayt)).toBe('40% fee rebate');
    const abs = absolute({ marketFeeOverrides: [{ marketId: 7, settlementFeePercentage: 0.02, rebateBps: null }] });
    expect(rebateChipLabel(abs, [7, 8])).toBe('Fee capped at 2-5%');
  });

  it('names each leg rate only when the legs differ', () => {
    const short = { marketId: 1, venue: 'Hyperliquid', side: 'SHORT' as const };
    const long = { marketId: 232, venue: 'Gate', side: 'LONG' as const };
    expect(rebateLegsNote(nayt, [short, long])).toBe('• Hyperliquid short: 40%\n• Gate long: 50%');
    expect(rebateLegsNote(nayt, [{ ...short, marketId: 233 }, long])).toBe('');
  });

  it('lists the differing market rates in the account label', () => {
    expect(rebateAccountLabel(nayt)).toBe('40% fee rebate, 50% on markets 232, 233');
    expect(rebateAccountLabel(relative())).toBe('20% fee rebate');
  });
});
