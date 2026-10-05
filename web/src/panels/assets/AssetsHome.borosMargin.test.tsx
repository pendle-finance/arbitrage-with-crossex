/**
 * Positions no longer carries a Boros margin block: every account's margin
 * lives on Accounts. Positions only says so, in one line, when an account is
 * in trouble.
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

function serve(response: AssetViewResponse, borosMargin: AssetBorosMargin[] = response.borosMargin ?? []) {
  localStorage.setItem(STRATEGY_STORAGE_KEY, JSON.stringify({ address: ROOT, walletUpgraded: true }));
  server.use(
    http.get('/api/boros/agent', () =>
      HttpResponse.json(env(agentStatus({ configured: true, root: ROOT, rootMasked: '0x1111…1111' }))),
    ),
    http.get('/api/fees', () => HttpResponse.json(env<VenueFees[]>([]))),
    http.get('/api/asset-view/:address', () => HttpResponse.json(env(response))),
    http.get('/api/boros/margin/:address', () => HttpResponse.json(env({ borosMargin }))),
    ...baseHandlers(),
  );
}

afterEach(() => localStorage.clear());

describe('AssetsHome and account health', () => {
  it('shows no Boros margin block: healthy accounts say nothing here', async () => {
    serve(view([bucket({ maintMarginUsd: 1000, equityUsd: 5000 })]));
    renderWithClient(<AssetsHome />);
    await screen.findByText('ETH');
    expect(screen.queryByText('Boros account')).toBeNull();
    expect(screen.queryByRole('button', { name: /View accounts/ })).toBeNull();
  });

  it('one line points at Accounts when an account nears liquidation, naming it', async () => {
    // 4,700 of maintenance on 5,000 of balance: 94% used, past the 91% line.
    serve(view([bucket({ maintMarginUsd: 4700, equityUsd: 5000 })]));
    renderWithClient(<AssetsHome />);
    const line = await screen.findByRole('button', { name: /View accounts/ });
    expect(line).toHaveTextContent('1 account near liquidation');
    expect(line).toHaveTextContent('Boros USDT cross at 94% MM used');
  });
});
