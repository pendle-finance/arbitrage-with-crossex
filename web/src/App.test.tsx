import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import type { OpenOrder, PositionsResponse, RebalanceBucket, TradesResponse, VenueFees } from './api/types';
import { ACTIVE_TAB_KEY } from './components/TabBar';
import { USER_GUIDE_RAW_URL } from './components/UserGuideModal';
import {
  account,
  agentStatus,
  baseHandlers,
  ethPosition,
  makeOpportunitiesResult,
  makeRebalanceView,
  opportunitiesHandler,
  rebalanceHandler,
  setupHandlers,
  telegramInfo,
  versionHandler,
} from './test/fixtures';
import { env, server } from './test/server';
import { renderWithClient } from './test/utils';

function order(id: string): OpenOrder {
  return {
    orderId: id,
    text: `web_${id}`,
    state: 'OPEN',
    symbol: 'GATE_FUTURE_ETH_USDT',
    side: 'BUY',
    type: 'LIMIT',
    timeInForce: 'GTC',
    qty: '1',
    price: '2500',
    executedQty: '0',
    executedAvgPrice: '',
    reduceOnly: false,
    createTime: 1_751_500_000,
  };
}

const agentOff = agentStatus();
const telegramOff = telegramInfo();

function mockApp({ orders = [] as OpenOrder[] } = {}) {
  server.use(
    ...setupHandlers(
      agentStatus({ configured: true, root: `0x${'ab'.repeat(20)}` }),
      telegramInfo({ connected: true, state: 'connected', settings: { liquidation: true, interest: true, maturity: true, rollover: true } }),
    ),
    http.get('/api/credentials', () =>
      HttpResponse.json(env({ configured: true, keyMasked: 'gk_****abcd' })),
    ),
    ...baseHandlers(),
    opportunitiesHandler(makeOpportunitiesResult()),
    http.get('/api/orders/open', () => HttpResponse.json(env(orders))),
    http.get('/api/trades', () =>
      HttpResponse.json(env<TradesResponse>({ trades: [], page: 1, limit: 100, hasMore: false })),
    ),
    http.get('/api/fees', () => HttpResponse.json(env<VenueFees[]>([]))),
    http.get('/api/baskets', () => HttpResponse.json(env([]))),
  );
}

function tab(name: RegExp): HTMLElement {
  return screen.getByRole('tab', { name });
}

function panel(id: string): HTMLElement {
  return document.getElementById(`panel-${id}`)!;
}

async function renderApp() {
  const result = renderWithClient(<App />);
  await screen.findByRole('tablist', { name: 'Sections' });
  return result;
}

afterEach(() => vi.restoreAllMocks());

describe('App tab shell', () => {
  it('defaults to Opportunities; the other panels are mounted but hidden', async () => {
    localStorage.setItem('crossex.strategy.v1', JSON.stringify({ address: null, walletUpgraded: true }));
    mockApp();
    await renderApp();

    expect(tab(/^Opportunities/)).toHaveAttribute('aria-selected', 'true');
    expect(tab(/^Positions/)).toHaveAttribute('aria-selected', 'false');

    // Inactive content is mounted (data loads, badges stay live) yet hidden.
    expect(await screen.findByText(/Your CrossEx fee rates/)).not.toBeVisible();
    // The positions home (asset view): with no tracked address it shows the
    // track-an-address empty state.
    expect(await screen.findByText('Connect your wallet to see your farm by asset')).not.toBeVisible();
  });

  it('lands on Positions instead when the account already holds some', async () => {
    mockApp();
    // Overrides baseHandlers' empty positions.
    server.use(
      http.get('/api/positions', () =>
        HttpResponse.json(env<PositionsResponse>({ positions: [ethPosition], exposure: [] })),
      ),
    );
    await renderApp();

    await waitFor(() => expect(tab(/^Positions/)).toHaveAttribute('aria-selected', 'true'));
    expect(tab(/^Opportunities/)).toHaveAttribute('aria-selected', 'false');
  });

  it('an explicit tab choice outranks the holds-positions default', async () => {
    localStorage.setItem(ACTIVE_TAB_KEY, JSON.stringify('fees'));
    mockApp();
    server.use(
      http.get('/api/positions', () =>
        HttpResponse.json(env<PositionsResponse>({ positions: [ethPosition], exposure: [] })),
      ),
    );
    await renderApp();

    expect(tab(/^Fees/)).toHaveAttribute('aria-selected', 'true');
    expect(tab(/^Positions/)).toHaveAttribute('aria-selected', 'false');
  });

  it('keeps the tab strip inside the sticky header, so it never hides under it', async () => {
    mockApp();
    await renderApp();

    // The header wraps to two rows on narrow screens; a tab strip pinned at a
    // fixed `top-16` below it would end up underneath.
    expect(screen.getByRole('tablist', { name: 'Sections' }).closest('header')).not.toBeNull();
  });

  it('leads with Opportunities — first tab, and the one panel on screen', async () => {
    mockApp();
    await renderApp();

    expect(screen.getAllByRole('tab')[0]).toHaveAccessibleName(/^Opportunities/);
    // The panel itself renders inside the tab panel (its cards land once the
    // /api/opportunities fixture resolves).
    expect(
      await within(panel('opportunities')).findByRole('button', {
        name: /^Open this strategy — ETH short/,
      }),
    ).toBeInTheDocument();
    expect(panel('opportunities')).toBeVisible();
  });

  it('persists the active tab across unmount + remount via localStorage', async () => {
    mockApp();
    const first = await renderApp();

    await userEvent.click(tab(/^Trades/));
    expect(tab(/^Trades/)).toHaveAttribute('aria-selected', 'true');
    expect(localStorage.getItem(ACTIVE_TAB_KEY)).toBe('"trades"');
    first.unmount();

    await renderApp();
    expect(tab(/^Trades/)).toHaveAttribute('aria-selected', 'true');
    expect(tab(/^Opportunities/)).toHaveAttribute('aria-selected', 'false');
  });

  it('clicking a tab swaps the visible panel and returns to the top', async () => {
    mockApp();
    const scrollSpy = vi.spyOn(window, 'scrollTo');
    await renderApp();

    await userEvent.click(tab(/^Fees/));

    expect(panel('fees')).toBeVisible();
    expect(panel('opportunities')).not.toBeVisible();
    // A tall tab must not leave a short one scrolled past its content.
    expect(scrollSpy).toHaveBeenCalledWith({ top: 0 });
  });

  it('shows the live order count on the tab while Open Orders is inactive', async () => {
    mockApp({ orders: [order('1'), order('2')] });
    await renderApp();

    const ordersTab = tab(/^Open Orders/);
    expect(ordersTab).toHaveAttribute('aria-selected', 'false');

    // The badge lands once the (still-mounted) query resolves.
    await waitFor(() => expect(within(ordersTab).getByText('2')).toBeInTheDocument());
    // The panel itself is mounted while hidden — its rows exist in the DOM.
    expect(await within(panel('orders')).findAllByText('Cancel')).toHaveLength(2);
  });

  it('falls back to the setup checklist (not the trading panels) when /credentials errors', async () => {
    server.use(
      http.get('/api/credentials', () =>
        HttpResponse.json(
          { ok: false, error: { category: 'unknown', message: 'credentials service down', retryable: true } },
          { status: 503 },
        ),
      ),
      ...baseHandlers(),
      ...setupHandlers(agentOff, telegramOff),
      http.get('/api/orders/open', () => HttpResponse.json(env<OpenOrder[]>([]))),
    );
    renderWithClient(<App />);

    expect(await screen.findByText('Set up the terminal')).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.queryByText('Connect your wallet to see your farm by asset')).not.toBeInTheDocument();
  });

  it('replaces the trading shell (tabs included) with the setup checklist when unconfigured', async () => {
    server.use(
      http.get('/api/credentials', () => HttpResponse.json(env({ configured: false, keyMasked: null }))),
      ...baseHandlers(),
      ...setupHandlers(agentOff, telegramOff),
      http.get('/api/orders/open', () => HttpResponse.json(env<OpenOrder[]>([]))),
    );
    renderWithClient(<App />);

    expect(await screen.findByText('Set up the terminal')).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Order ticket' })).not.toBeInTheDocument();
    expect(screen.queryByText('How to execute')).not.toBeInTheDocument();
  });
});

/** The Hyperliquid USDC bucket with `borrow` USDC lent by Gate. */
function borrowed(borrow: number): RebalanceBucket {
  return {
    coin: 'USDC',
    venue: 'HYPERLIQUID',
    cash: -borrow,
    upnl: 0,
    equity: -borrow,
    borrow,
    imHeldUsd: borrow * 0.2,
    mmHeldUsd: borrow * 0.1,
    interestPaidUsd: 0,
    interestPerDayUsd: 0,
    ratePerYear: 0.05,
  };
}

describe('borrow pill', () => {
  it('shows the USDC borrow in the header on every tab, and opens Balances on click', async () => {
    mockApp();
    server.use(rebalanceHandler(makeRebalanceView({ buckets: [borrowed(8.5)] })));
    await renderApp();

    const pill = await screen.findByText('Borrowing 8.50 USDC');
    expect(tab(/^Opportunities/)).toHaveAttribute('aria-selected', 'true');

    await userEvent.click(pill);

    expect(tab(/^Balances/)).toHaveAttribute('aria-selected', 'true');
    expect(panel('balances')).toBeVisible();
    expect(within(panel('balances')).getByRole('region', { name: 'Rebalance' })).toBeVisible();

    await userEvent.hover(pill);
    const card = await screen.findByRole('tooltip');
    const link = within(card).getByRole('button', { name: 'Rebalance on Balances' });
    await userEvent.click(link);

    expect(tab(/^Balances/)).toHaveAttribute('aria-selected', 'true');
  });

  it('shows a USDT borrow the same way, naming the CrossEx wallet', async () => {
    mockApp();
    const usdt: RebalanceBucket = { ...borrowed(300), coin: 'USDT', venue: 'CROSSEX' };
    const usdc: RebalanceBucket = { ...borrowed(0), cash: 500, equity: 500 };
    server.use(rebalanceHandler(makeRebalanceView({ buckets: [usdc, usdt] })));
    await renderApp();

    const pill = await screen.findByRole('button', { name: 'Borrowing 300.00 USDT' });
    await userEvent.hover(pill);

    const card = await screen.findByRole('tooltip');
    expect(within(card).getByText('USDT · CrossEx')).toBeInTheDocument();
    expect(within(card).queryByText('For')).toBeNull();
  });

  it('puts the nearest liquidation line in the margin gauges hover', async () => {
    mockApp();
    server.use(
      http.get('/api/account', () =>
        HttpResponse.json(
          env({
            ...account,
            marginBalance: '20000',
            maintenanceMargin: '2500',
            assets: [
              { coin: 'USDT', exchangeType: 'CROSSEX', balance: '20000', equity: '20000', availableBalance: '20000', upnl: '0', liability: '0' },
              { coin: 'USDC', exchangeType: 'HYPERLIQUID', balance: '0', equity: '0', availableBalance: '0', upnl: '0', liability: '0' },
            ],
          }),
        ),
      ),
      http.get('/api/positions', () =>
        HttpResponse.json(
          env<PositionsResponse>({
            positions: [
              { ...ethPosition, symbol: 'GATE_FUTURE_ETH_USDT', positionValue: '250000', markPrice: '2300', maintenanceMargin: '1250' },
              { ...ethPosition, symbol: 'HYPERLIQUID_FUTURE_ETH_USDC', positionValue: '250000', markPrice: '2300', maintenanceMargin: '1250' },
            ],
            exposure: [
              {
                base: 'ETH',
                legs: [
                  { symbol: 'GATE_FUTURE_ETH_USDT', exchange: 'GATE', quote: 'USDT', side: 'LONG', qty: 108.7, value: 250000 },
                  { symbol: 'HYPERLIQUID_FUTURE_ETH_USDC', exchange: 'HYPERLIQUID', quote: 'USDC', side: 'SHORT', qty: 108.7, value: 250000 },
                ],
                longValue: 250000,
                shortValue: 250000,
                netValue: 0,
                grossValue: 500000,
                neutral: true,
                singleLeg: false,
              },
            ],
          }),
        ),
      ),
    );
    await renderApp();

    // The header meters carry the whole margin story in one hover title.
    const gauges = screen.getByRole('img', { name: 'Initial and maintenance margin' });
    await waitFor(() =>
      expect(gauges).toHaveAttribute(
        'title',
        expect.stringContaining(
          'Nearest liquidation: ETH rises to $3,764 (+64%). Losing leg: Hyperliquid short. Estimate: other coins flat.',
        ),
      ),
    );
  });

  it('shows the pill under 1 USDC of borrow', async () => {
    mockApp();
    server.use(rebalanceHandler(makeRebalanceView({ buckets: [borrowed(0.4)] })));
    await renderApp();

    expect(await screen.findByRole('button', { name: 'Borrowing 0.40 USDC' })).toBeInTheDocument();
  });
});

describe('user guide', () => {
  it('keeps ordered-list numbering when a list is interrupted', async () => {
    mockApp();
    server.use(
      http.get(USER_GUIDE_RAW_URL, () =>
        // A paragraph between items splits this into TWO <ol>s; the second
        // arrives as <ol start="2"> and must not renumber from 1.
        HttpResponse.text('# G\n\n1. first\n\nbetween\n\n2. second\n3. third'),
      ),
    );
    await renderApp();
    await userEvent.click(screen.getByRole('button', { name: 'User guide' }));

    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('second');
    const lists = dialog.querySelectorAll('ol');
    expect(lists).toHaveLength(2);
    expect(lists[1]).toHaveAttribute('start', '2');
  });

  it('renders the guide in-app from GitHub instead of navigating away', async () => {
    mockApp();
    server.use(
      http.get(USER_GUIDE_RAW_URL, () =>
        HttpResponse.text('# User guide\n\nRead the **Opportunities** scan first.'),
      ),
    );
    await renderApp();

    // A button, not a link — clicking it must not leave the terminal.
    expect(screen.queryByRole('link', { name: 'User guide' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'User guide' }));

    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByRole('heading', { name: 'User guide', level: 1 })).toBeVisible();
    expect(within(dialog).getByText('Opportunities').tagName).toBe('STRONG');
  });

  it('is not fetched until the guide is actually opened', async () => {
    const calls: string[] = [];
    mockApp();
    server.use(
      http.get(USER_GUIDE_RAW_URL, () => {
        calls.push('hit');
        return HttpResponse.text('# User guide');
      }),
    );
    await renderApp();

    expect(calls).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'User guide' }));
    await screen.findByRole('dialog');
    await waitFor(() => expect(calls).toHaveLength(1));
  });

  it('falls back to the GitHub link when the fetch fails', async () => {
    mockApp();
    server.use(http.get(USER_GUIDE_RAW_URL, () => new HttpResponse(null, { status: 500 })));
    await renderApp();

    await userEvent.click(screen.getByRole('button', { name: 'User guide' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Couldn’t load the guide/);
    expect(within(alert).getByRole('link', { name: 'docs/USER_GUIDE.md' })).toHaveAttribute(
      'href',
      'https://github.com/pendle-finance/arbitrage-with-crossex/blob/main/docs/USER_GUIDE.md',
    );
  });
});

describe('update pill', () => {
  it('renders left of the User guide control when a newer version is published', async () => {
    mockApp();
    server.use(versionHandler({ latest: '9.9.9', updateAvailable: true, highlights: ['x'] }));
    await renderApp();

    const pill = await screen.findByRole('button', { name: 'Update v9.9.9' });
    const guide = screen.getByRole('button', { name: 'User guide' });
    // The pill precedes the guide control in DOM order (i.e. sits to its left).
    expect(pill.compareDocumentPosition(guide) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows no pill while up to date (the baseHandlers default)', async () => {
    mockApp();
    await renderApp();
    expect(screen.queryByRole('button', { name: /Update v/ })).toBeNull();
  });
});
