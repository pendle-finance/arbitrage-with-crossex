import type { BorosLegFill, BorosOrderClient } from '../../src/core/boros/orders';
import { imInputs, marketAcc, raw } from './boros-fixtures';

export const NOW = Math.floor(Date.now() / 1000);
export const DAY = 86_400;
export const MATURITY = NOW + 30 * DAY;
export const ADDRESS = '0x1111111111111111111111111111111111111111';
export const HL = 155;
export const BN = 158;
export const OK = 161;

export const wei = (tokens: number): string => (BigInt(tokens) * 10n ** 18n).toString();

export const market = (marketId: number, platformName: string, midApr: number, status = 2) => ({
  marketId,
  tokenId: 3,
  imData: {
    name: `${platformName} ETH 30d`,
    maturity: MATURITY,
    iTickThresh: imInputs.imTickThresh,
    tickStep: imInputs.imTickStep,
  },
  extConfig: { settleFeeRate: '1000000000000000', paymentPeriod: 3600 },
  platform: { platformId: platformName },
  metadata: { underlyingSymbol: 'ETH' },
  config: {
    status,
    takerFee: '500000000000000',
    kIM: raw(imInputs.kIM),
    tThresh: imInputs.tThreshSec,
  },
  data: { midApr, markApr: midApr, floatingApr: 0.05, notionalOI: 12_000_000, assetMarkPrice: 1900 },
});

export const wireBook = (bidTick: number, askTick: number, size = 20_000_000) => ({
  short: { ia: [askTick], sz: [raw(size)] },
  long: { ia: [bidTick], sz: [raw(size)] },
});

export function account(
  netBalance: number,
  positions: Array<{ marketId: number; size: number | string }> = [],
): Record<string, unknown> {
  const size = (s: number | string) => (typeof s === 'string' ? s : raw(s));
  const acc = marketAcc(ADDRESS, 3);
  return {
    '/apis/v1/accounts/market-acc-infos-by-root': {
      results: [
        {
          marketAcc: acc,
          netBalance: raw(netBalance),
          initialMargin: raw(0),
          positions: positions.map((p) => ({
            marketId: p.marketId,
            signedSize: size(p.size),
            initialMargin: raw(0),
            orders: [],
          })),
        },
      ],
    },
    '/apis/v1/accounts/active-positions': {
      results: positions.map((p) => ({
        marketAcc: acc,
        marketId: p.marketId,
        side: Number(p.size) >= 0 ? 0 : 1,
        fixedApr: 0,
        signedSize: size(p.size),
        unrealisedPnl: '0',
        settlementPnl: '0',
      })),
    },
  };
}

export const fillFor = (r: { marketId: number; direction: 'long' | 'short'; size: number }): BorosLegFill => ({
  marketId: r.marketId,
  direction: r.direction,
  filledSize: r.size,
  shortfallSize: 0,
  execApr: 0.09,
  feeSize: 4,
  failure: null,
});

export function relay(calls: string[], close: BorosOrderClient['closePosition'] = async (r) => fillFor(r)): BorosOrderClient {
  return {
    placeMarketOrders: async (reqs) => {
      calls.push('place');
      return reqs.map(fillFor);
    },
    cancelOrders: async () => {
      calls.push('cancel');
    },
    closePosition: async (r) => {
      calls.push('close');
      return close(r);
    },
  };
}
