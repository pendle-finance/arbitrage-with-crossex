import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AssetBorosOpen, AssetGroup, AssetPerpOpen, AssetViewResponse, VenueFees } from '../../api/types';
import { agentStatus, baseHandlers } from '../../test/fixtures';
import { env, server } from '../../test/server';
import { renderWithClient } from '../../test/utils';
import { STRATEGY_STORAGE_KEY } from '../HomeControls';
import { AssetsHome } from './AssetsHome';

const ROOT = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const NOW = Date.UTC(2026, 8, 18, 12) / 1000;
const JUNE = Date.UTC(2026, 5, 23, 12) / 1000;
const DEC = Date.UTC(2026, 11, 25, 8) / 1000;

const perp = (base: string, notionalUsd: number): AssetPerpOpen => ({
  symbol: `GATE_FUTURE_${base}_USDT`,
  venue: 'GATE',
  side: 'LONG',
  qty: notionalUsd / 100,
  notionalUsd,
  entryPrice: 100,
  markPrice: 100,
  leverage: 5,
  upnlUsd: 0,
  fundingUsd: 3,
  feesUsd: 0,
  imUsd: notionalUsd / 5,
  openedAt: JUNE,
});

const boros = (notionalUsd: number): AssetBorosOpen => ({
  marketId: 7,
  venue: 'BINANCE',
  maturity: DEC,
  collateral: 'USDT',
  side: 'LONG',
  sizeToken: notionalUsd,
  notionalUsd,
  entryApr: 0.08,
  markApr: 0.08,
  floatingApr: 0.08,
  settleUsd: 0,
  mtmUsd: 0,
  imUsd: notionalUsd / 10,
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

const view = (notionalUsd: number): AssetViewResponse => ({
  sinceSec: JUNE,
  nowSec: NOW,
  defaultSinceSec: JUNE,
  assets: [
    group('ETH', { borosOpen: [boros(notionalUsd)] }),
    group('SOL', { perpOpen: [perp('SOL', notionalUsd)] }),
  ],
  supportedCoins: ['ETH', 'SOL'],
  earliestSec: JUNE,
  coverage: { settlementsFromSec: 0, perpClosedFromSec: 0, borosTxnsComplete: true, backfilling: false },
  interest: { paidUsd: 12, byCoin: { USDT: 12 }, coversFromSec: JUNE, available: true },
  warnings: [],
});

function serve(address: string, notionalUsd: number) {
  localStorage.setItem(STRATEGY_STORAGE_KEY, JSON.stringify({ address, walletUpgraded: true }));
  server.use(
    http.get('/api/boros/agent', () =>
      HttpResponse.json(env(agentStatus({ configured: true, root: ROOT, rootMasked: '0x1111…1111' }))),
    ),
    http.get('/api/fees', () => HttpResponse.json(env<VenueFees[]>([]))),
    http.get('/api/asset-view/:address', () => HttpResponse.json(env(view(notionalUsd)))),
    ...baseHandlers(),
  );
}

afterEach(() => localStorage.clear());

describe.each([50, 6_000_000])('Positions for a view-only wallet at $%d', (size) => {
  beforeEach(() => serve(OTHER, size));

  it('says whose legs these are and hides every Gate leg', async () => {
    renderWithClient(<AssetsHome />);
    expect(
      await screen.findByText(
        (_, el) => el?.tagName === 'P' && el.textContent === 'Boros legs only. Gate perps show for 0x1111…1111.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText((_, el) => el?.tagName === 'DIV' && el.textContent === 'Boros PnL · 0x2222…2222')).toHaveAttribute(
      'title',
      'Boros legs only. Gate is not included.',
    );
    expect(screen.queryByText('Total Account PnL')).toBeNull();
    expect(await screen.findByText('ETH')).toBeInTheDocument();
    expect(screen.queryByText('SOL')).toBeNull();
  });

  it('does not call the Boros leg unhedged because the perps are hidden', async () => {
    renderWithClient(<AssetsHome />);
    await screen.findByText('ETH');
    expect(screen.queryByText('Missing hedge')).toBeNull();
    expect(screen.queryByText(/Boros legs? missing/)).toBeNull();
    expect(screen.queryByText(/borrow interest/)).toBeNull();
  });
});

describe('Positions for the wallet that trades', () => {
  beforeEach(() => serve(ROOT, 50));

  it('shows the Gate legs and no viewing line', async () => {
    renderWithClient(<AssetsHome />);
    expect(await screen.findByText('SOL')).toBeInTheDocument();
    expect(screen.getByText('ETH')).toBeInTheDocument();
    expect(screen.queryByText(/Gate perps show for/)).toBeNull();
    expect(screen.getByText('Total Account PnL')).toBeInTheDocument();
    expect(screen.getByText(/after .* borrow interest/)).toBeInTheDocument();
  });
});
