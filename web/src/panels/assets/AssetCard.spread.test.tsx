import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AssetBorosHistory, AssetBorosOpen, AssetGroup, AssetPerpOpen } from '../../api/types';
import { server } from '../../test/server';
import { renderWithClient } from '../../test/utils';
import { useTradeFlowOptional } from '../../trade/TradeFlow';
import { STRATEGY_STORAGE_KEY } from '../HomeControls';
import { AssetCard } from './AssetCard';
import { deriveAsset } from './assetModel';

const ADDRESS = '0x1111111111111111111111111111111111111111';
const DAY = 86_400;
const PX = 2500;
const NOW = Math.floor(Date.now() / 1000);
const MATURITY = NOW + 50 * DAY;
const SPREAD = 59;

const perp = (venue: string, side: 'LONG' | 'SHORT', qty: number): AssetPerpOpen => ({
  symbol: `${venue}_FUTURE_ETH_USDT`,
  venue,
  side,
  qty,
  notionalUsd: qty * PX,
  entryPrice: PX,
  markPrice: PX,
  leverage: 10,
  upnlUsd: 0,
  fundingUsd: 0,
  feesUsd: 0,
  imUsd: qty * 104,
  openedAt: NOW - 2 * DAY,
});

const spreadLeg: AssetBorosOpen = {
  marketId: SPREAD,
  venue: 'HYPERLIQUID',
  spreadVenues: ['HYPERLIQUID', 'GATE'],
  side: 'SHORT',
  sizeToken: 0.555,
  maturity: MATURITY,
  collateral: 'ETH',
  notionalUsd: 0.555 * PX,
  entryApr: 0.0348,
  markApr: 0.034,
  floatingApr: 0.04,
  settleUsd: 0.05,
  mtmUsd: 0,
  imUsd: 20,
};

const spreadHistory: AssetBorosHistory = {
  marketId: SPREAD,
  venue: 'HYPERLIQUID',
  spreadVenues: ['HYPERLIQUID', 'GATE'],
  maturity: MATURITY,
  settleUsd: 12.34,
  settleFeeUsd: 0,
  tradePnlUsd: 0,
  tradeFeeUsd: 0,
};

const book = (borosOpen: AssetBorosOpen[], borosHistory: AssetBorosHistory[] = []): AssetGroup => ({
  base: 'ETH',
  supported: true,
  priceUsd: PX,
  earliestSec: NOW - 10 * DAY,
  perpOpen: [perp('HYPERLIQUID', 'SHORT', 0.555), perp('GATE', 'LONG', 0.555)],
  perpClosed: [],
  borosOpen,
  borosHistory,
});

const spreadRow = {
  marketId: SPREAD,
  name: 'ETH Spread',
  venue: 'HL-Gate',
  base: 'ETH',
  tokenId: 2,
  collateral: 'ETH',
  maturity: MATURITY,
  midApr: 0.0348,
  markApr: 0.0348,
  maxRateDeviationApr: 0.02,
  spreadVenues: ['HYPERLIQUID', 'GATE'],
  isolatedOnly: false,
  onIsolatedMargin: false,
  isolatedHasPositionOrOrders: false,
  currentSize: 0,
  collateralPriceUsd: PX,
  closeOnly: false,
};

let lastPrefill: unknown = null;
function PrefillProbe() {
  lastPrefill = useTradeFlowOptional()?.borosOpenPrefill ?? null;
  return null;
}

const cardTree = (group: AssetGroup) => (
  <>
    <AssetCard
      group={group}
      derived={deriveAsset(group, {}, 0, NOW)}
      sinceSec={0}
      windowPending={false}
      storedSinceSec={undefined}
      defaultSinceSec={null}
      backfilling={false}
      supportedCoins={['ETH']}
      onChangeSince={() => {}}
      exclusions={{}}
      onExclude={() => {}}
    />
    <PrefillProbe />
  </>
);
const renderCard = (group: AssetGroup) => renderWithClient(cardTree(group));

const showPairs = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('tab', { name: /^Pairs/ }));
};
const showBundles = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('tab', { name: /^Funding Bundles/ }));
};
const bundleRow = (name: RegExp) => screen.getByRole('button', { name }).closest('tr') as HTMLElement;

beforeEach(() => {
  lastPrefill = null;
  localStorage.setItem(STRATEGY_STORAGE_KEY, JSON.stringify({ address: ADDRESS }));
  server.use(
    http.get('/api/positions', () => HttpResponse.json({ positions: [] })),
    http.get('/api/boros/pair/context', () =>
      HttpResponse.json({
        ok: true,
        data: {
          markets: [],
          spreadMarkets: [spreadRow],
          crossByToken: [],
          isolatedByMarket: [],
          defaultSlippageApr: 0.0025,
          maxSlippageApr: 0.1,
        },
      }),
    ),
  );
});

describe('AssetCard with a spread leg', () => {
  it('pair row reads HL-Gate', async () => {
    const user = userEvent.setup();
    renderCard(book([spreadLeg]));
    await showPairs(user);
    await user.click(screen.getByRole('button', { name: /^Gate\s*LONG/ }));
    const table = screen.getByRole('columnheader', { name: 'Leg' }).closest('table') as HTMLElement;
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    const borosRow = rows.find((r) => within(r).queryByText('HL-Gate'))!;
    expect(within(borosRow).getByText('Boros')).toBeInTheDocument();
    expect(within(borosRow).getByText('SHORT')).toBeInTheDocument();
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/HL-GATE|Hyperliquid-gate|HYPERLIQUID-GATE/);
  });

  it('tab reads Pairs', () => {
    renderCard(book([spreadLeg]));
    expect(screen.getByRole('tab', { name: /^Pairs \(\d+\)$/ })).toBeInTheDocument();
    expect(screen.queryByText(/4 Leg Pairs/)).toBeNull();
  });

  it('missing offers the spread', async () => {
    const user = userEvent.setup();
    renderCard(book([]));
    await showPairs(user);
    expect((await screen.findAllByText('Boros leg missing')).length).toBeGreaterThan(0);
    const open = await screen.findByRole('button', { name: 'Open Boros leg' });
    expect(screen.queryByRole('button', { name: 'Open leg' })).toBeNull();
    expect(screen.queryByText('Open both Boros legs')).toBeNull();
    expect(screen.getAllByText('HL-Gate').length).toBeGreaterThan(0);
    await user.click(open);
    await waitFor(() => expect(lastPrefill).not.toBeNull());
    expect(lastPrefill).toMatchObject({ base: 'ETH', longVenue: 'GATE', shortVenue: 'HYPERLIQUID' });
  });

  it('missing with a close-only spread keeps the spread row, with no fall back to two singles', async () => {
    server.use(
      http.get('/api/boros/pair/context', () =>
        HttpResponse.json({
          ok: true,
          data: {
            markets: [],
            spreadMarkets: [{ ...spreadRow, closeOnly: true }],
            crossByToken: [],
            isolatedByMarket: [],
            defaultSlippageApr: 0.0025,
            maxSlippageApr: 0.1,
          },
        }),
      ),
    );
    const user = userEvent.setup();
    renderCard(book([]));
    await showPairs(user);
    expect(await screen.findByRole('button', { name: 'Open Boros leg' })).toBeInTheDocument();
    expect(screen.queryByText('Open both Boros legs')).toBeNull();
    expect(screen.getAllByText('HL-Gate').length).toBeGreaterThan(0);
  });

  it('missing pair shows a skeleton while the spread lookup loads', async () => {
    server.use(
      http.get('/api/boros/pair/context', async () => {
        await delay('infinite');
        return HttpResponse.json({});
      }),
    );
    const user = userEvent.setup();
    const { container } = renderCard(book([]));
    await showPairs(user);
    expect(container.querySelector('.animate-pulse.h-12')).not.toBeNull();
    expect(screen.queryByText('Open both Boros legs')).toBeNull();
    expect(screen.queryByText('Open Boros leg')).toBeNull();
  });

  it('missing pair shows the dev card with Close perps while a failed spread lookup retries', async () => {
    let asked = 0;
    server.use(
      http.get('/api/boros/pair/context', () => {
        asked += 1;
        return HttpResponse.json({ ok: false, error: 'down' }, { status: 500 });
      }),
    );
    const retrying = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchInterval: false, refetchOnWindowFocus: false } },
    });
    retrying.setQueryDefaults(['boros', 'pair', 'context'], { retry: 3, retryDelay: 60_000 });
    const user = userEvent.setup();
    const { container } = renderWithClient(<QueryClientProvider client={retrying}>{cardTree(book([]))}</QueryClientProvider>);
    await showPairs(user);
    await waitFor(() => expect(asked).toBe(1));
    expect(await screen.findByText('Open both Boros legs')).toBeInTheDocument();
    expect(retrying.getQueryState(['boros', 'pair', 'context', ADDRESS])).toMatchObject({ status: 'pending', fetchFailureCount: 1 });
    expect(screen.getAllByRole('button', { name: 'Close perps' }).length).toBeGreaterThan(0);
    expect(container.querySelector('.animate-pulse.h-12')).toBeNull();
  });

  it('missing pair with no spread at its maturity offers both singles once loaded', async () => {
    server.use(
      http.get('/api/boros/pair/context', () =>
        HttpResponse.json({
          ok: true,
          data: {
            markets: [],
            spreadMarkets: [],
            crossByToken: [],
            isolatedByMarket: [],
            defaultSlippageApr: 0.0025,
            maxSlippageApr: 0.1,
          },
        }),
      ),
    );
    const user = userEvent.setup();
    const { container } = renderCard(book([]));
    await showPairs(user);
    expect(await screen.findByText('Open both Boros legs')).toBeInTheDocument();
    expect(container.querySelector('.animate-pulse.h-12')).toBeNull();
  });

  it('bundles put the spread venue first and count the spread on both cards', async () => {
    const user = userEvent.setup();
    renderCard(book([spreadLeg]));
    await showBundles(user);
    const hl = screen.getByRole('button', { name: /^Hyperliquid\s*SHORT/ });
    const gate = screen.getByRole('button', { name: /^Gate\s*LONG/ });
    expect(hl.compareDocumentPosition(gate) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(hl.textContent).toContain('1 active');
    expect(gate.textContent).toContain('1 active');
  });

  it('spread sits on the first venue', async () => {
    const user = userEvent.setup();
    renderCard(book([spreadLeg], [spreadHistory]));
    await showBundles(user);
    const hl = bundleRow(/^Hyperliquid\s*SHORT/);
    expect(hl.textContent).toContain('$12.34');
    expect(bundleRow(/^Gate\s*LONG/).textContent).not.toContain('12.34');
    expect(within(hl).getByText(/receive/).textContent).toMatch(/receive\s*3\.48%/);
    await user.click(screen.getByRole('button', { name: /^Hyperliquid\s*SHORT/ }));
    const spreadRows = (await screen.findAllByText('HL-Gate')).map((el) => el.closest('tr') as HTMLElement);
    expect(spreadRows).toHaveLength(1);
    expect(spreadRows[0].textContent).toMatch(/3\.48%/);
    expect(spreadRows[0].textContent).not.toContain('in Hyperliquid');
  });

  it('second venue shows in Hyperliquid', async () => {
    const user = userEvent.setup();
    renderCard(book([spreadLeg]));
    await showBundles(user);
    const gate = bundleRow(/^Gate\s*LONG/);
    expect(within(gate).getAllByText('—').length).toBeGreaterThan(0);
    expect(within(gate).queryByText(/receive|pay /)).toBeNull();
    await user.click(screen.getByRole('button', { name: /^Gate\s*LONG/ }));
    await waitFor(() => expect(screen.getAllByText('in Hyperliquid')).toHaveLength(2));
    for (const el of screen.getAllByText('in Hyperliquid')) {
      expect(el.closest('tr')?.textContent).toContain('HL-Gate');
    }
  });

  it('either row closes the spread', async () => {
    const user = userEvent.setup();
    renderCard(book([spreadLeg]));
    await showBundles(user);
    await user.click(screen.getByRole('button', { name: /^Gate\s*LONG/ }));
    await user.click(screen.getByRole('button', { name: /^Hyperliquid\s*SHORT/ }));
    const closes = await screen.findAllByRole('button', { name: 'Close HL-Gate spread' });
    expect(closes).toHaveLength(2);
    await user.click(closes[closes.length - 1]);
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Close HL-Gate spread');
    expect(dialog.textContent).toMatch(/0\.555/);
  });

  it('the close form for a hedged spread pair is titled for the Boros leg, not the pair', async () => {
    const user = userEvent.setup();
    renderCard(book([spreadLeg]));
    await showPairs(user);
    await user.click(screen.getByRole('button', { name: /^Gate\s*LONG/ }));
    await user.click(await screen.findByRole('button', { name: 'Close Boros' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toMatch(/^Close Boros leg/);
    expect(dialog.textContent).not.toContain('Close pair');
  });

  it('a spread-only pair closes one Boros leg', async () => {
    const user = userEvent.setup();
    renderCard({ ...book([spreadLeg]), perpOpen: [] });
    await showPairs(user);
    const close = await screen.findByRole('button', { name: 'Close Boros leg' });
    expect(close).toHaveAttribute('title', expect.stringMatching(/^Close the Boros leg of this unit/));
    expect(screen.queryByRole('button', { name: 'Close Boros legs' })).toBeNull();
  });
});
