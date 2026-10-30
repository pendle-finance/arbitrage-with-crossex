import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { AssetBorosOpen, AssetGroup, AssetPerpOpen } from '../api/types';
import { useTradeFlowOptional } from '../trade/TradeFlow';
import { server } from './server';

export const ADDRESS = '0x1111111111111111111111111111111111111111';
export const PX = 2500;
export const NOW = Math.floor(Date.UTC(2026, 9, 23) / 1000);
export const DATES: Record<string, number> = {
  O: Date.UTC(2026, 9, 30, 8) / 1000,
  N: Date.UTC(2026, 10, 27, 8) / 1000,
  D: Date.UTC(2026, 11, 11, 8) / 1000,
};
export const VENUES: Record<string, string> = { G: 'GATE', H: 'HYPERLIQUID', LI: 'LIGHTER' };

export function groupOf(spec: string[], patch: Record<number, Partial<AssetBorosOpen>> = {}): AssetGroup {
  const perpOpen: AssetPerpOpen[] = [];
  const borosOpen: AssetBorosOpen[] = [];
  let id = 100;
  for (const token of spec) {
    const [code, side, sizeText, date] = token.split(' ');
    const size = Number(sizeText);
    if (side === 'L' || side === 'S') {
      perpOpen.push({
        symbol: `${VENUES[code]}_FUTURE_ETH_USDT`,
        venue: VENUES[code],
        side: side === 'L' ? 'LONG' : 'SHORT',
        qty: size,
        notionalUsd: size * PX,
        entryPrice: PX,
        markPrice: PX,
        leverage: 10,
        upnlUsd: 0,
        fundingUsd: 0,
        feesUsd: 0,
        imUsd: size * 100,
        openedAt: NOW - 86_400,
      });
      continue;
    }
    id += 1;
    const venues = code.split('-').map((c) => VENUES[c]);
    borosOpen.push({
      marketId: id,
      venue: venues[0],
      spreadVenues: venues.length > 1 ? [venues[0], venues[1]] : null,
      side: side as 'LONG' | 'SHORT',
      sizeToken: size,
      maturity: DATES[date],
      collateral: 'ETH',
      notionalUsd: size * PX,
      entryApr: 0.03,
      markApr: 0.03,
      floatingApr: 0.03,
      settleUsd: 0,
      mtmUsd: 0,
      imUsd: 10,
      ...patch[id],
    });
  }
  return { base: 'ETH', supported: true, priceUsd: PX, earliestSec: NOW - 864_000, perpOpen, perpClosed: [], borosOpen, borosHistory: [] };
}

export const spreadRow = (maturity: number, closeOnly = false) => ({
  marketId: 900 + maturity,
  name: 'ETH Spread',
  venue: 'HL-GATE',
  base: 'ETH',
  tokenId: 2,
  collateral: 'ETH',
  maturity,
  midApr: 0.03,
  markApr: 0.03,
  maxRateDeviationApr: 0.02,
  spreadVenues: ['HYPERLIQUID', 'GATE'],
  isolatedOnly: false,
  onIsolatedMargin: false,
  isolatedHasPositionOrOrders: false,
  currentSize: 0,
  collateralPriceUsd: PX,
  closeOnly,
});

export function listMarkets(spreadMarkets: ReturnType<typeof spreadRow>[]) {
  server.use(
    http.get('/api/boros/pair/context', () =>
      HttpResponse.json({
        ok: true,
        data: { markets: [], spreadMarkets, crossByToken: [], isolatedByMarket: [], defaultSlippageApr: 0.0025, maxSlippageApr: 0.1 },
      }),
    ),
  );
}

export const prefill: { current: unknown } = { current: null };
export function PrefillProbe() {
  prefill.current = useTradeFlowOptional()?.borosOpenPrefill ?? null;
  return null;
}

export const cardList = () =>
  Array.from(document.getElementById('asset-ETH-panel-pairs')?.querySelectorAll<HTMLElement>('div.overflow-x-auto') ?? []).filter(
    (el) => !el.parentElement?.closest('div.overflow-x-auto') && el.querySelector(':scope > table'),
  );
export const textOf = (el: HTMLElement) => el.textContent ?? '';
export const cardsTitled = (title: RegExp) => cardList().filter((el) => title.test(textOf(el)));
export const hedgedCards = () => cardList().filter((el) => /Gate|Hyperliquid/.test(textOf(el)) && !/missing|Ungrouped legs/.test(textOf(el)));

export async function showPairs(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('tab', { name: /^Fixed Rate Pairs/ }));
}

export async function expand(user: ReturnType<typeof userEvent.setup>, card: HTMLElement) {
  const toggle = card.querySelector<HTMLElement>('button[aria-expanded]');
  if (toggle?.getAttribute('aria-expanded') === 'false') await user.click(toggle);
}
