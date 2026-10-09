/**
 * Which cross margin pays a hand-made gas top-up. `payTreasury` is charged in
 * the token of the market it names, so a zone the user does not fund refuses
 * it — the zone must be the traded one, or the best-funded, never USDT by
 * default.
 */
import { describe, expect, it } from 'vitest';
import { chooseGasTopUpZone } from '../../src/core/boros/pair';

const markets = [
  { marketId: 10, tokenId: 3 }, // USDT
  { marketId: 20, tokenId: 2 }, // ETH
  { marketId: 21, tokenId: 2 },
  { marketId: 30, tokenId: 1 }, // BTC
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

  it('refuses when the traded zone cannot spare the dollars, even if another can', () => {
    const zone = chooseGasTopUpZone({
      amountUsd: 5,
      markets,
      freeCrossByToken: new Map([[2, 0.001], [3, 1000]]), // $2.50 of ETH free
      pricesUsd: prices,
      preferMarketId: 20,
    });
    expect(zone.ok).toBe(false);
    if (!zone.ok) expect(zone.message).toMatch(/ETH cross margin has about \$2\.50 free/);
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
