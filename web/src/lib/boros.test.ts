import { describe, expect, it } from 'vitest';
import { isUsdCollateral, sizeUnitForBase } from './boros';

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
