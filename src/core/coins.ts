export const SUPPORTED_COINS = ['ETH', 'HYPE', 'BTC'] as const;

export const COIN_NOT_SUPPORTED_TEXT = 'This coin is not supported. Pick ETH, HYPE or BTC.';

export type SupportedCoin = (typeof SUPPORTED_COINS)[number];

export function isSupportedCoin(base: string): boolean {
  const upper = base.toUpperCase();
  return SUPPORTED_COINS.some((coin) => coin === upper);
}
