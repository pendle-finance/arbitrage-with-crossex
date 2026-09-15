/** The simulated CrossEx fee schedule (help/crossex/functional/49701,
 * 2026-07-14). Spot pins on the tiers the venue floors diverge at — if Gate
 * revises the page, these are the rows to re-read. */
import { describe, expect, it } from 'vitest';
import {
  CROSSEX_FEE_TIERS,
  feeRowsForTier,
  feeTierLabel,
  parseFeeTier,
} from '../../src/core/estimate/crossexFeeTiers';
import { resolveVenueFeeRates } from '../../src/core/estimate/fees';

const VENUES = ['GATE', 'BINANCE', 'OKX', 'BYBIT', 'KRAKEN', 'HYPERLIQUID', 'LIGHTER'];

const rates = (tier: Parameters<typeof feeRowsForTier>[0], venue: string) =>
  resolveVenueFeeRates(feeRowsForTier(tier, VENUES), venue);

describe('crossexFeeTiers', () => {
  it('publishes 17 tiers and one row for each venue it is given', () => {
    expect(CROSSEX_FEE_TIERS).toHaveLength(17);
    for (const tier of CROSSEX_FEE_TIERS) {
      const rows = feeRowsForTier(tier, VENUES);
      expect(rows.map((r) => r.exchangeType)).toEqual(VENUES);
      for (const row of rows) {
        const r = resolveVenueFeeRates(rows, row.exchangeType!);
        expect(r).not.toBeNull();
        expect(r!.makerRate).toBeGreaterThanOrEqual(0);
        expect(r!.takerRate).toBeGreaterThan(r!.makerRate);
      }
    }
  });

  it('VIP0–VIP10 are identical across venues, at the Gate ladder', () => {
    expect(rates('vip0', 'BINANCE')).toEqual({ makerRate: 0.0002, takerRate: 0.0005 });
    for (let level = 0; level <= 10; level += 1) {
      const tier = `vip${level}` as (typeof CROSSEX_FEE_TIERS)[number];
      const gate = rates(tier, 'GATE');
      for (const venue of VENUES) {
        expect(rates(tier, venue)).toEqual(gate);
      }
    }
  });

  it('fees never rise with the tier, per venue', () => {
    for (const venue of VENUES) {
      for (let level = 1; level <= 16; level += 1) {
        const prev = rates(`vip${level - 1}` as never, venue)!;
        const cur = rates(`vip${level}` as never, venue)!;
        expect(cur.makerRate).toBeLessThanOrEqual(prev.makerRate);
        expect(cur.takerRate).toBeLessThanOrEqual(prev.takerRate);
      }
    }
  });

  it('pins the published high-tier venue floors', () => {
    expect(rates('vip16', 'GATE')).toEqual({ makerRate: 0, takerRate: 0.00016 });
    expect(rates('vip16', 'BINANCE')).toEqual({ makerRate: 0.000018, takerRate: 0.00018 });
    expect(rates('vip16', 'OKX')).toEqual({ makerRate: 0, takerRate: 0.00025 });
    expect(rates('vip16', 'BYBIT')).toEqual({ makerRate: 0, takerRate: 0.0002 });
    expect(rates('vip16', 'KRAKEN')).toEqual({ makerRate: 0, takerRate: 0.0002 });
    // Hyperliquid flattens from VIP11 up.
    expect(rates('vip11', 'HYPERLIQUID')).toEqual({ makerRate: 0.000084, takerRate: 0.00028 });
    expect(rates('vip16', 'HYPERLIQUID')).toEqual({ makerRate: 0.000084, takerRate: 0.00028 });
    // OKX's taker floor arrives at VIP13.
    expect(rates('vip13', 'OKX')).toEqual({ makerRate: 0.00005, takerRate: 0.00025 });
  });

  it('a venue the help page has no column for takes the base ladder', () => {
    expect(rates('vip11', 'LIGHTER')).toEqual({ makerRate: 0.00008, takerRate: 0.00028 });
    expect(rates('vip16', 'LIGHTER')).toEqual(rates('vip16', 'GATE'));
    expect(feeRowsForTier('vip0', new Set(['LIGHTER']))).toEqual([
      { exchangeType: 'LIGHTER', futureMakerFee: '0.0002', futureTakerFee: '0.0005' },
    ]);
  });

  it('parseFeeTier: absent stays absent, tiers pass, junk is a validation error', () => {
    expect(parseFeeTier(undefined)).toBeUndefined();
    expect(parseFeeTier('')).toBeUndefined();
    expect(parseFeeTier('vip0')).toBe('vip0');
    expect(parseFeeTier('vip16')).toBe('vip16');
    expect(() => parseFeeTier('vip17')).toThrow(/invalid feeTier/);
    expect(() => parseFeeTier('VIP2')).toThrow(/invalid feeTier/);
    expect(feeTierLabel('vip3')).toBe('VIP 3');
  });
});
