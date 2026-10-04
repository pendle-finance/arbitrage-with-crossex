/**
 * The account hero's Boros margin readout: one tile per collateral bucket —
 * health (equity / maintenance, coloured red < 1.1 / amber < 1.5) and free
 * margin. Shown read-only even for a view-only wallet; absent when the server
 * sends no borosMargin.
 */
import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type { AssetBorosMargin, AssetBorosOpen, AssetGroup, AssetViewResponse, VenueFees } from '../../api/types';
import { agentStatus, baseHandlers } from '../../test/fixtures';
import { env, server } from '../../test/server';
import { renderWithClient } from '../../test/utils';
import { STRATEGY_STORAGE_KEY } from '../HomeControls';
import { AssetsHome } from './AssetsHome';

const ROOT = '0x1111111111111111111111111111111111111111';
const NOW = Date.UTC(2026, 8, 18, 12) / 1000;
const JUNE = Date.UTC(2026, 5, 23, 12) / 1000;
const DEC = Date.UTC(2026, 11, 25, 8) / 1000;

const boros: AssetBorosOpen = {
  marketId: 7,
  venue: 'BINANCE',
  maturity: DEC,
  collateral: 'USDT',
  side: 'LONG',
  sizeToken: 1000,
  notionalUsd: 1000,
  entryApr: 0.08,
  markApr: 0.08,
  floatingApr: 0.08,
  settleUsd: 0,
  mtmUsd: 0,
  imUsd: 100,
};

const group: AssetGroup = {
  base: 'ETH',
  supported: true,
  priceUsd: 100,
  earliestSec: JUNE,
  perpOpen: [],
  perpClosed: [],
  borosOpen: [boros],
  borosHistory: [],
};

const bucket = (over: Partial<AssetBorosMargin>): AssetBorosMargin => ({
  tokenId: 3,
  collateral: 'USDT',
  isCross: true,
  healthFactor: 2.5,
  availableToken: 1234,
  availableUsd: 1234,
  equityUsd: 5000,
  maintMarginUsd: 2000,
  ...over,
});

const view = (borosMargin?: AssetBorosMargin[]): AssetViewResponse => ({
  sinceSec: JUNE,
  nowSec: NOW,
  defaultSinceSec: JUNE,
  assets: [group],
  borosMargin,
  supportedCoins: ['ETH'],
  earliestSec: JUNE,
  coverage: { settlementsFromSec: 0, perpClosedFromSec: 0, borosTxnsComplete: true, backfilling: false },
  interest: { paidUsd: 0, byCoin: {}, coversFromSec: JUNE, available: true },
  warnings: [],
});

function serve(response: AssetViewResponse) {
  localStorage.setItem(STRATEGY_STORAGE_KEY, JSON.stringify({ address: ROOT, walletUpgraded: true }));
  server.use(
    http.get('/api/boros/agent', () =>
      HttpResponse.json(env(agentStatus({ configured: true, root: ROOT, rootMasked: '0x1111…1111' }))),
    ),
    http.get('/api/fees', () => HttpResponse.json(env<VenueFees[]>([]))),
    http.get('/api/asset-view/:address', () => HttpResponse.json(env(response))),
    ...baseHandlers(),
  );
}

afterEach(() => localStorage.clear());

describe('AssetsHome Boros margin readout', () => {
  it('shows one bucket tile with its health and free margin, coloured by threshold', async () => {
    serve(
      view([
        bucket({ isCross: true, healthFactor: 1.05, availableUsd: 1234, availableToken: 1234 }),
        bucket({ isCross: false, marketId: 7, healthFactor: 1.3, availableUsd: 500, availableToken: 500 }),
        bucket({ tokenId: 2, collateral: 'ETH', isCross: true, healthFactor: 2.5, availableUsd: null, availableToken: 4 }),
      ]),
    );
    renderWithClient(<AssetsHome />);

    expect(await screen.findByText('Boros account')).toBeInTheDocument();
    // Red below 1.1, amber below 1.5, plain ink otherwise.
    expect(screen.getByText('1.05').className).toContain('text-rose-300');
    expect(screen.getByText('1.30').className).toContain('text-amber-200');
    expect(screen.getByText('2.50').className).toContain('text-ink-50');
    // Free margin: priced in USD, or in the token when there is no USD price.
    expect(screen.getByText('$1,234.00')).toBeInTheDocument();
    expect(screen.getByText('4.00 ETH')).toBeInTheDocument();
    expect(screen.getByText('USDT cross')).toBeInTheDocument();
    expect(screen.getByText('USDT isolated')).toBeInTheDocument();
  });

  it('renders a null health factor as a dash', async () => {
    serve(view([bucket({ healthFactor: null })]));
    renderWithClient(<AssetsHome />);
    await screen.findByText('Boros account');
    expect(screen.getByText('Health').nextElementSibling?.textContent).toBe('—');
  });

  it('renders nothing when the server sends no borosMargin', async () => {
    serve(view(undefined));
    renderWithClient(<AssetsHome />);
    await screen.findByText('ETH');
    expect(screen.queryByText('Boros account')).toBeNull();
  });
});
