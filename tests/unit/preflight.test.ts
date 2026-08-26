/**
 * Margin preflight — pure-logic unit tests with injected reads (no network).
 * The preflight is the money-safety gate that stops a pair from opening one leg
 * when the account can only fund one (H1). Verifies: reduce-only legs never count,
 * market-leg pricing via the ref-price seam, the venue-leverage fallback, the
 * buffer/fee arithmetic, and fail-open on every read failure.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ResolvedAction } from '../../src/core/actions';
import type { Clients } from '../../src/core/clients';
import { CoreError } from '../../src/core/errors';
import { PREFLIGHT_MARGIN_BUFFER, preflightMargin, TAKER_FEE_RESERVE } from '../../src/core/preflight';

const clients = {} as Clients; // never touched — every read is injected via deps

function leg(over: Partial<ResolvedAction>): ResolvedAction {
  return {
    index: 0,
    input: { kind: 'open-market', symbol: over.symbol ?? 'GATE_FUTURE_ETH_USDT', side: 'BUY' } as ResolvedAction['input'],
    symbol: 'GATE_FUTURE_ETH_USDT',
    side: 'BUY',
    type: 'MARKET',
    tif: 'IOC',
    reduceOnly: false,
    qty: '1',
    estNotional: 0,
    violations: [],
    warnings: [],
    ...over,
  };
}

const acct = (availableMargin: string, positionMode = 'SINGLE') => ({ availableMargin, positionMode }) as Awaited<ReturnType<NonNullable<Parameters<typeof preflightMargin>[2]>['getAccount'] & object>>;

/** required for a single leg, per the documented formula, so tests read as intent. */
const requiredFor = (notional: number, lev: number) =>
  (notional / lev) * PREFLIGHT_MARGIN_BUFFER + notional * TAKER_FEE_RESERVE;

describe('preflightMargin', () => {
  it('blocks when required (limit leg, own price) exceeds available', async () => {
    const legs = [
      leg({ index: 0, symbol: 'GATE_FUTURE_ETH_USDT', type: 'LIMIT', estNotional: 2500, leverage: { requested: 10, max: 50 } }),
    ];
    const need = requiredFor(2500, 10); // 262.5 + 2.5 = 265
    await expect(
      preflightMargin(clients, legs, { getAccount: async () => acct(String(need - 1)) }),
    ).rejects.toMatchObject({ category: 'insufficient-margin' });
    // just above the requirement → passes
    await expect(
      preflightMargin(clients, legs, { getAccount: async () => acct(String(need + 1)) }),
    ).resolves.toBeUndefined();
  });

  describe('netting an open leg against the live opposite position', () => {
    // The pair ticket unwinds with two ORDINARY opens: no reduceOnly, but no new IM.
    const unwind = [
      leg({ index: 0, symbol: 'HYPERLIQUID_FUTURE_ETH_USDC', side: 'BUY', qty: '1', estNotional: 2457.8, leverage: { requested: 25, max: 25 } }),
      leg({ index: 1, symbol: 'BINANCE_FUTURE_ETH_USDT', side: 'SELL', qty: '1', estNotional: 2457.26, leverage: { requested: 25, max: 25 } }),
    ];
    const book = async () => [
      { symbol: 'HYPERLIQUID_FUTURE_ETH_USDC', positionQty: '-25.25' }, // short → a BUY nets down
      { symbol: 'BINANCE_FUTURE_ETH_USDT', positionQty: '10.579' }, // long → a SELL nets down
    ];

    it('does not block a fully offsetting pair on a NEGATIVE available margin', async () => {
      await expect(
        preflightMargin(clients, unwind, { getAccount: async () => acct('-3824.76'), getPositions: book }),
      ).resolves.toBeUndefined();
    });

    it('charges only the excess PAST flat', async () => {
      // BUY 30 against a 25.25 short: 4.75 of it opens a new long.
      const over = [leg({ index: 0, symbol: 'HYPERLIQUID_FUTURE_ETH_USDC', side: 'BUY', qty: '30', estNotional: 30 * 2457.8, leverage: { requested: 25, max: 25 } })];
      const need = requiredFor(4.75 * 2457.8, 25);
      await expect(
        preflightMargin(clients, over, { getAccount: async () => acct(String(need - 1)), getPositions: book }),
      ).rejects.toMatchObject({ category: 'insufficient-margin' });
      await expect(
        preflightMargin(clients, over, { getAccount: async () => acct(String(need + 1)), getPositions: book }),
      ).resolves.toBeUndefined();
    });

    it('charges an ALIGNED leg in full (adding to a position is a real open)', async () => {
      const add = [leg({ index: 0, symbol: 'BINANCE_FUTURE_ETH_USDT', side: 'BUY', qty: '1', estNotional: 2457.26, leverage: { requested: 25, max: 25 } })];
      await expect(
        preflightMargin(clients, add, { getAccount: async () => acct('50'), getPositions: book }),
      ).rejects.toMatchObject({ category: 'insufficient-margin' });
    });

    // In hedge mode that BUY opens a SEPARATE long at full IM, so netting would
    // under-require and leave leg B rejected with leg A filled. Unknown modes too.
    it.each(['DUAL_SIDE', 'SOMETHING_NEW', ''])('does NOT net when positionMode is %j', async (mode) => {
      await expect(
        preflightMargin(clients, unwind, { getAccount: async () => acct('-3824.76', mode), getPositions: book }),
      ).rejects.toMatchObject({ category: 'insufficient-margin' });
    });

    it('matches the position regardless of the venue symbol casing', async () => {
      const lower = async () => [
        { symbol: 'hyperliquid_future_eth_usdc', positionQty: '-25.25' },
        { symbol: 'binance_future_eth_usdt', positionQty: '10.579' },
      ];
      await expect(
        preflightMargin(clients, unwind, { getAccount: async () => acct('-3824.76'), getPositions: lower }),
      ).resolves.toBeUndefined();
    });

    it('charges every leg in full when the positions read fails (safe direction)', async () => {
      await expect(
        preflightMargin(clients, unwind, {
          getAccount: async () => acct('-3824.76'),
          getPositions: async () => {
            throw new Error('boom');
          },
        }),
      ).rejects.toMatchObject({ category: 'insufficient-margin' });
    });
  });

  it('prices a MARKET open leg (estNotional 0 at execute) via the ref-price seam', async () => {
    const legs = [leg({ symbol: 'GATE_FUTURE_ETH_USDT', qty: '2', estNotional: 0, leverage: { requested: 5, max: 50 } })];
    const getReferencePrice = vi.fn(async () => 1000); // notional = 2 * 1000 = 2000
    const need = requiredFor(2000, 5); // 420 + 2 = 422
    await expect(
      preflightMargin(clients, legs, { getReferencePrice, getAccount: async () => acct(String(need - 1)) }),
    ).rejects.toBeInstanceOf(CoreError);
    expect(getReferencePrice).toHaveBeenCalledWith('ETH_USDT');
  });

  it('excludes reduce-only (close) legs entirely — a close is never blocked', async () => {
    const legs = [
      leg({ index: 0, reduceOnly: true, type: 'LIMIT', tif: 'IOC', estNotional: 1_000_000, leverage: { requested: 1, max: 50 } }),
      leg({ index: 1, symbol: 'OKX_FUTURE_ETH_USDT', reduceOnly: true, estNotional: 1_000_000 }),
    ];
    const getAccount = vi.fn(async () => acct('0.01'));
    await expect(preflightMargin(clients, legs, { getAccount })).resolves.toBeUndefined();
    expect(getAccount).not.toHaveBeenCalled(); // exited before any read
  });

  it('sums a pair and blocks when combined margin exceeds available (the H1 case)', async () => {
    const legs = [
      leg({ index: 0, symbol: 'GATE_FUTURE_ETH_USDT', type: 'LIMIT', estNotional: 2500, leverage: { requested: 10, max: 50 } }),
      leg({ index: 1, symbol: 'OKX_FUTURE_ETH_USDT', type: 'LIMIT', estNotional: 2500, leverage: { requested: 10, max: 50 } }),
    ];
    const need = 2 * requiredFor(2500, 10); // ~530
    // Enough for ONE leg (~265) but not both → must block.
    await expect(
      preflightMargin(clients, legs, { getAccount: async () => acct(String(need / 2 + 5)) }),
    ).rejects.toMatchObject({ category: 'insufficient-margin' });
  });

  it('falls back to venue leverage when a leg carries no requested leverage', async () => {
    const legs = [leg({ symbol: 'GATE_FUTURE_ETH_USDT', type: 'LIMIT', estNotional: 3000, leverage: undefined })];
    const getPositionLeverage = vi.fn(async () => ({ GATE_FUTURE_ETH_USDT: '3' }));
    const need = requiredFor(3000, 3); // 1050 + 3
    await expect(
      preflightMargin(clients, legs, { getPositionLeverage, getAccount: async () => acct(String(need - 1)) }),
    ).rejects.toBeInstanceOf(CoreError);
    expect(getPositionLeverage).toHaveBeenCalledWith(['GATE_FUTURE_ETH_USDT']);
  });

  describe('fail-open (a read failure never blocks — only removes a failure mode)', () => {
    const legs = [leg({ type: 'LIMIT', estNotional: 1_000_000, leverage: { requested: 1, max: 50 } })];

    it('account read throws → skip (resolves)', async () => {
      await expect(
        preflightMargin(clients, legs, { getAccount: async () => { throw new Error('429'); } }),
      ).resolves.toBeUndefined();
    });

    it('account.availableMargin not a number → skip', async () => {
      await expect(
        preflightMargin(clients, legs, { getAccount: async () => acct('not-a-number') }),
      ).resolves.toBeUndefined();
    });

    it('unpriceable market leg is exempted (not blocked)', async () => {
      const mkt = [leg({ estNotional: 0, qty: '5', leverage: { requested: 1, max: 50 } })];
      const getAccount = vi.fn(async () => acct('0.01'));
      await expect(
        preflightMargin(clients, mkt, { getReferencePrice: async () => null, getAccount }),
      ).resolves.toBeUndefined();
      expect(getAccount).not.toHaveBeenCalled(); // priced.length 0 → returned before the account read
    });

    it('leverage read fails and leg has no requested leverage → exempted', async () => {
      const noLev = [leg({ type: 'LIMIT', estNotional: 1_000_000, leverage: undefined })];
      await expect(
        preflightMargin(clients, noLev, {
          getPositionLeverage: async () => { throw new Error('down'); },
          getAccount: async () => acct('0.01'),
        }),
      ).resolves.toBeUndefined();
    });
  });

  it('mixed open+close basket sizes only the open leg', async () => {
    const legs = [
      leg({ index: 0, symbol: 'GATE_FUTURE_ETH_USDT', type: 'LIMIT', estNotional: 2000, leverage: { requested: 10, max: 50 } }),
      leg({ index: 1, symbol: 'OKX_FUTURE_ETH_USDT', reduceOnly: true, estNotional: 999_999 }),
    ];
    const openNeed = requiredFor(2000, 10); // ~212
    await expect(
      preflightMargin(clients, legs, { getAccount: async () => acct(String(openNeed + 5)) }),
    ).resolves.toBeUndefined(); // close leg ignored, open leg fits
    await expect(
      preflightMargin(clients, legs, { getAccount: async () => acct(String(openNeed - 5)) }),
    ).rejects.toBeInstanceOf(CoreError);
  });
});
