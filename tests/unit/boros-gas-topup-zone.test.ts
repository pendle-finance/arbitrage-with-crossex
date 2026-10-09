/**
 * Which cross margin pays a hand-made gas top-up. `payTreasury` is charged in
 * the token of the market it names, so a zone the user does not fund refuses
 * it — the zone must be the traded one, or the best-funded, never USDT by
 * default.
 */
import { describe, expect, it } from 'vitest';
import { chooseGasTopUpZone } from '../../src/core/boros/pair';

const plain = { state: 'Normal', spreadVenues: null };
const markets = [
  { marketId: 10, tokenId: 3, ...plain }, // USDT
  { marketId: 20, tokenId: 2, ...plain }, // ETH
  { marketId: 21, tokenId: 2, ...plain },
  { marketId: 30, tokenId: 1, ...plain }, // BTC
];
const prices = new Map<number, number | null>([[3, 1], [2, 2500], [1, 100_000]]);

describe('chooseGasTopUpZone', () => {
  it('pays from the traded market, an ETH-only account included', () => {
    const zone = chooseGasTopUpZone({
      amountUsd: 5,
      markets,
      freeCrossByToken: new Map([[2, 0.5]]), // 0.5 ETH = $1,250, no USDT at all
      pricesUsd: prices,
      preferMarketId: 21,
    });
    expect(zone).toMatchObject({ ok: true, marketId: 21, tokenId: 2, symbol: 'ETH', freeUsd: 1250 });
  });

  it('falls back to the best-funded zone when the traded zone cannot spare the dollars', () => {
    const zone = chooseGasTopUpZone({
      amountUsd: 5,
      markets,
      freeCrossByToken: new Map([[2, 0.001], [3, 1000]]), // $2.50 of ETH free
      pricesUsd: prices,
      preferMarketId: 20,
    });
    expect(zone).toMatchObject({ ok: true, marketId: 10, tokenId: 3, symbol: 'USDT', freeUsd: 1000 });
  });

  it.each([
    ['$50', 1.02, 0.0004, 0.5],
    ['$6M', 1.02, -40, 0.9],
  ])('refuses when neither the traded zone nor any other can pay (%s book)', (_size, amountUsd, ethFree, usdtFree) => {
    const zone = chooseGasTopUpZone({
      amountUsd,
      markets,
      freeCrossByToken: new Map([[2, ethFree], [3, usdtFree]]),
      pricesUsd: prices,
      preferMarketId: 20,
    });
    expect(zone.ok).toBe(false);
    if (!zone.ok) expect(zone.message).toMatch(/No Boros cross margin has \$1\.02 free/);
  });

  it('names a live single market of the paying coin, never a spread or a paused one', () => {
    const zone = chooseGasTopUpZone({
      amountUsd: 5,
      markets: [
        { marketId: 20, tokenId: 2, ...plain },
        { marketId: 59, tokenId: 3, state: 'Normal', spreadVenues: ['HYPERLIQUID', 'GATE'] as [string, string] },
        { marketId: 11, tokenId: 3, state: 'Paused', spreadVenues: null },
        { marketId: 12, tokenId: 3, ...plain },
      ],
      freeCrossByToken: new Map([[2, 0.001], [3, 1000]]),
      pricesUsd: prices,
      preferMarketId: 20,
    });
    expect(zone).toMatchObject({ ok: true, marketId: 12, tokenId: 3 });
  });

  it.each([
    ['$50', 0.0004, 60],
    ['$6M', 0.0004, 6_000_000],
  ])('skips a coin with no live single market as the payer (%s of USDT)', (_size, ethFree, usdtFree) => {
    const zone = chooseGasTopUpZone({
      amountUsd: 1.02,
      markets: [
        { marketId: 20, tokenId: 2, ...plain },
        { marketId: 59, tokenId: 3, state: 'Normal', spreadVenues: ['HYPERLIQUID', 'GATE'] as [string, string] },
        { marketId: 11, tokenId: 3, state: 'CloseOnly', spreadVenues: null },
      ],
      freeCrossByToken: new Map([[2, ethFree], [3, usdtFree]]),
      pricesUsd: prices,
      preferMarketId: 20,
    });
    expect(zone.ok).toBe(false);
  });

  it('keeps the traded zone when it can pay, even if another zone holds more', () => {
    const zone = chooseGasTopUpZone({
      amountUsd: 1.02,
      markets,
      freeCrossByToken: new Map([[2, 0.01], [3, 6_000_000]]), // $25 of ETH vs $6M of USDT
      pricesUsd: prices,
      preferMarketId: 21,
    });
    expect(zone).toMatchObject({ ok: true, marketId: 21, tokenId: 2 });
  });

  it('refuses an unpriced zone rather than treating tokens as dollars', () => {
    const zone = chooseGasTopUpZone({
      amountUsd: 5,
      markets,
      freeCrossByToken: new Map([[2, 10]]),
      pricesUsd: new Map([[2, null]]),
      preferMarketId: 20,
    });
    expect(zone.ok).toBe(false);
  });

  it('without a market, picks the zone with the most free margin in USD', () => {
    const zone = chooseGasTopUpZone({
      amountUsd: 5,
      markets,
      freeCrossByToken: new Map([[3, 40], [2, 0.1], [1, 0.0001]]), // $40, $250, $10
      pricesUsd: prices,
    });
    expect(zone).toMatchObject({ ok: true, tokenId: 2, symbol: 'ETH' });
  });

  it('without a market, refuses when no zone can cover it', () => {
    const zone = chooseGasTopUpZone({
      amountUsd: 50,
      markets,
      freeCrossByToken: new Map([[3, 10], [2, 0.004]]),
      pricesUsd: prices,
    });
    expect(zone.ok).toBe(false);
    if (!zone.ok) expect(zone.message).toMatch(/the most is about \$10\.00/);
  });

  it('refuses an unlisted market', () => {
    const zone = chooseGasTopUpZone({
      amountUsd: 5,
      markets,
      freeCrossByToken: new Map([[3, 100]]),
      pricesUsd: prices,
      preferMarketId: 999,
    });
    expect(zone.ok).toBe(false);
  });
});
