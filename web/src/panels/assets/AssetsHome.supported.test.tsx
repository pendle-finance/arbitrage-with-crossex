import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AssetGroup, AssetPerpOpen, AssetViewResponse, VenueFees } from '../../api/types';
import { baseHandlers } from '../../test/fixtures';
import { env, server } from '../../test/server';
import { renderWithClient } from '../../test/utils';
import { STRATEGY_STORAGE_KEY } from '../HomeControls';
import { AssetsHome } from './AssetsHome';

const ADDRESS = '0x' + 'ab'.repeat(20);
const NOW = Date.UTC(2026, 8, 18, 12) / 1000;
const JUNE = Date.UTC(2026, 5, 23, 12) / 1000;

const perp = (base: string, fundingUsd: number): AssetPerpOpen => ({
  symbol: `GATE_FUTURE_${base}_USDT`,
  venue: 'GATE',
  side: 'LONG',
  qty: 1,
  notionalUsd: 100,
  entryPrice: 100,
  markPrice: 100,
  leverage: 5,
  upnlUsd: 0,
  fundingUsd,
  feesUsd: 0,
  imUsd: 20,
  openedAt: JUNE,
});

const group = (base: string, over: Partial<AssetGroup>): AssetGroup => ({
  base,
  supported: true,
  priceUsd: 100,
  earliestSec: JUNE,
  perpOpen: [],
  perpClosed: [],
  borosOpen: [],
  borosHistory: [],
  ...over,
});

const assetView: AssetViewResponse = {
  sinceSec: JUNE,
  nowSec: NOW,
  defaultSinceSec: JUNE,
  assets: [
    group('ETH', { perpOpen: [perp('ETH', 5)] }),
    group('SOL', { supported: false, perpOpen: [perp('SOL', 12)] }),
    group('BTC', {
      perpClosed: [
        {
          symbol: 'GATE_FUTURE_BTC_USDT',
          venue: 'GATE',
          closedPnlUsd: 0.2,
          fundingUsd: 0,
          feesUsd: 0,
          count: 1,
          lastClosedAt: JUNE,
          dedupedIntoOpen: false,
          rows: [],
        },
      ],
    }),
  ],
  supportedCoins: ['ETH', 'HYPE', 'BTC'],
  earliestSec: JUNE,
  coverage: { settlementsFromSec: 0, perpClosedFromSec: 0, borosTxnsComplete: true, backfilling: false },
  warnings: [],
};

let requested: URL[] = [];

describe('AssetsHome with a held coin the terminal does not support', () => {
  beforeEach(() => {
    requested = [];
    localStorage.setItem(STRATEGY_STORAGE_KEY, JSON.stringify({ address: ADDRESS }));
    server.use(
      ...baseHandlers(),
      http.get('/api/credentials', () => HttpResponse.json(env({ configured: true, keyMasked: 'gk_****abcd' }))),
      http.get('/api/fees', () => HttpResponse.json(env<VenueFees[]>([]))),
      http.get('/api/asset-view/:address', ({ request }) => {
        requested.push(new URL(request.url));
        return HttpResponse.json(env(assetView));
      }),
    );
  });

  it('adds the SOL leg PnL to the totals strip, held coin counts in totals', async () => {
    renderWithClient(<AssetsHome />);
    await screen.findByText('SOL');
    const strip = screen.getAllByText('Total Account PnL')[0].nextElementSibling!;
    expect(strip).toHaveTextContent('$17.20');
  });

  it('keeps every digit of a $6M SOL leg in the totals strip, held coin counts in totals', async () => {
    const whale = group('SOL', { supported: false, perpOpen: [{ ...perp('SOL', 6_000_000.37), notionalUsd: 30_000_000 }] });
    server.use(http.get('/api/asset-view/:address', () => HttpResponse.json(env({ ...assetView, assets: [whale] }))));
    renderWithClient(<AssetsHome />);
    await screen.findByText('SOL');
    const strip = screen.getAllByText('Total Account PnL')[0].nextElementSibling!;
    expect(strip).toHaveTextContent('$6,000,000.37');
  });

  it('asks the server for its default date when no date is stored, held coin counts in totals', async () => {
    renderWithClient(<AssetsHome />);
    await screen.findByText('SOL');
    expect(requested.length).toBeGreaterThan(0);
    expect(requested.every((u) => !u.searchParams.has('since'))).toBe(true);
  });

  it('shows every coin as a card with no dust line, no dust fold', async () => {
    renderWithClient(<AssetsHome />);
    await screen.findByText('ETH');
    await userEvent.click(screen.getByRole('checkbox', { name: /Hide inactive pairs/ }));
    await screen.findByText('BTC');
    expect(screen.queryByText(/dust asset/)).toBeNull();
  });
});
