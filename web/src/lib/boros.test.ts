import { describe, expect, it } from 'vitest';
import { daysToMaturity, isUsdCollateral, maturityFillPct, sizeUnitForBase } from './boros';

describe('daysToMaturity', () => {
  const NOW = 1_800_000_000;
  const DAY = 86_400;
  it('rounds UP, so a live leg never reads 0d and no two screens differ by a day', () => {
    expect(daysToMaturity(NOW + 9 * DAY, NOW)).toBe(9);
    // 9.4 days was "9d" to a nearest-rounding screen and "10d" to the rest.
    expect(daysToMaturity(NOW + 9.4 * DAY, NOW)).toBe(10);
    expect(daysToMaturity(NOW + 60, NOW)).toBe(1);
  });

  it('is 0 once matured, never negative', () => {
    expect(daysToMaturity(NOW, NOW)).toBe(0);
    expect(daysToMaturity(NOW - 3 * DAY, NOW)).toBe(0);
  });
});

describe('maturityFillPct', () => {
  const NOW = 1_800_000_000;
  const DAY = 86_400;
  const H = 90;

  it('reads fuller the nearer the maturity, on the shared horizon', () => {
    // The bug: fill tracked each pair's own open span, so a fresh far leg and
    // an old near leg could read the same. Against a fixed horizon the near
    // leg is plainly further along.
    const near = maturityFillPct(NOW + 4 * DAY, NOW, H);
    const far = maturityFillPct(NOW + 27 * DAY, NOW, H);
    expect(near).toBeGreaterThan(far);
  });

  it('gives equal maturities equal fill, whatever their open dates', () => {
    expect(maturityFillPct(NOW + 30 * DAY, NOW, H)).toBe(maturityFillPct(NOW + 30 * DAY, NOW, H));
  });

  it('clamps to 100 at and after maturity', () => {
    expect(maturityFillPct(NOW, NOW, H)).toBe(100);
    expect(maturityFillPct(NOW - 5 * DAY, NOW, H)).toBe(100);
  });

  it('clamps to 0 beyond the horizon and never leaves 0..100', () => {
    expect(maturityFillPct(NOW + 200 * DAY, NOW, H)).toBe(0);
    for (const d of [-10, 0, 4, 45, 90, 120, 365]) {
      const pct = maturityFillPct(NOW + d * DAY, NOW, H);
      expect(pct).toBeGreaterThanOrEqual(0);
      expect(pct).toBeLessThanOrEqual(100);
    }
  });

  it('rises monotonically as maturity nears', () => {
    const steps = [60, 45, 30, 15, 4, 0].map((d) => maturityFillPct(NOW + d * DAY, NOW, H));
    for (let i = 1; i < steps.length; i++) expect(steps[i]).toBeGreaterThanOrEqual(steps[i - 1]);
  });

  it('rounds whole days exactly as daysToMaturity does', () => {
    // 9.4 days rounds UP to 10d; the bar fills from that same 10, not 9.4.
    const mat = NOW + 9.4 * DAY;
    expect(maturityFillPct(mat, NOW, H)).toBe((1 - daysToMaturity(mat, NOW) / H) * 100);
  });
});

describe('sizeUnitForBase', () => {
  it('sizes the coin-margined coins in their own token', () => {
    // ETH and BTC are the coin-collateral markets on Boros, so the perp box
    // must match the Boros leg's unit or the hedge needs an eyeballed FX step.
    expect(sizeUnitForBase('ETH')).toBe('base');
    expect(sizeUnitForBase('BTC')).toBe('base');
    expect(sizeUnitForBase('eth')).toBe('base');
  });

  it('sizes every other coin in dollars', () => {
    // HYPE and the rest are USDT-collateral on Boros: a token unit here is a
    // conversion imposed for nothing.
    expect(sizeUnitForBase('HYPE')).toBe('usd');
    expect(sizeUnitForBase('SOL')).toBe('usd');
    expect(sizeUnitForBase(null)).toBe('usd');
    expect(sizeUnitForBase(undefined)).toBe('usd');
  });
});

describe('isUsdCollateral', () => {
  it('counts USDC as dollars, not just USDT', () => {
    // The bug this replaced tested `!== 'USDT'` alone, so a USDC-collateral
    // group was handed a token quantity and armed the tickets in base units.
    expect(isUsdCollateral('USDT')).toBe(true);
    expect(isUsdCollateral('USDC')).toBe(true);
    expect(isUsdCollateral('usdc')).toBe(true);
    expect(isUsdCollateral('ETH')).toBe(false);
    expect(isUsdCollateral('')).toBe(false);
    expect(isUsdCollateral(null)).toBe(false);
  });
});
