/** Left-pane shell: one tab panel visible at a time, switched from the sticky
 * header tab strip. Inactive panels stay MOUNTED but hidden so their queries
 * keep polling; the active tab persists to localStorage. */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import type { OpenOrder, PositionsResponse, TradesResponse, VenueFees } from './api/types';
import { ACTIVE_TAB_KEY } from './components/TabBar';
import { USER_GUIDE_RAW_URL } from './components/UserGuideModal';
import {
  baseHandlers,
  ethPosition,
  makeOpportunitiesResult,
  makeOpportunityGroup,
  makeOpportunityLeg,
  makeOpportunityPair,
  opportunitiesHandler,
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

/** Everything a configured App shell fetches on mount. */
function mockApp({ orders = [] as OpenOrder[] } = {}) {
  server.use(
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
    mockApp();
    await renderApp();

    expect(tab(/^Opportunities/)).toHaveAttribute('aria-selected', 'true');
    expect(tab(/^Positions/)).toHaveAttribute('aria-selected', 'false');

    // Inactive content is mounted (data loads, badges stay live) yet hidden.
    expect(await screen.findByText(/Your CrossEx fee rates/)).not.toBeVisible();
    // The 4-leg home base: with no tracked address it shows the address empty
    // state and makes NO /api/strategy request.
    expect(await screen.findByText('Track your 4-leg strategy')).not.toBeVisible();
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
      await within(panel('opportunities')).findByRole('button', { name: /^Execute ETH short/ }),
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

  it('falls back to the first-run view (not the trading panels) when /credentials errors', async () => {
    // A persistent /credentials failure must NOT leak the live trading UI —
    // `data` is undefined, so we cannot confirm the account is configured.
    server.use(
      http.get('/api/credentials', () =>
        HttpResponse.json(
          { ok: false, error: { category: 'unknown', message: 'credentials service down', retryable: true } },
          { status: 503 },
        ),
      ),
      ...baseHandlers(),
      opportunitiesHandler(makeOpportunitiesResult()),
      http.get('/api/orders/open', () => HttpResponse.json(env<OpenOrder[]>([]))),
    );
    renderWithClient(<App />);

    expect(await screen.findByRole('complementary', { name: 'Setup guide' })).toBeInTheDocument();
    // Neither the tab strip nor the Positions home base is rendered.
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.queryByText('Track your 4-leg strategy')).not.toBeInTheDocument();
  });

  it('replaces the trading shell (tabs included) with opportunities + guide when unconfigured', async () => {
    server.use(
      http.get('/api/credentials', () =>
        HttpResponse.json(env({ configured: false, keyMasked: null })),
      ),
      ...baseHandlers(),
      opportunitiesHandler(makeOpportunitiesResult()),
      http.get('/api/orders/open', () => HttpResponse.json(env<OpenOrder[]>([]))),
    );
    renderWithClient(<App />);

    expect(await screen.findByRole('complementary', { name: 'Setup guide' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Live fixed rates, up for grabs' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    // The order ticket only exists once credentials do.
    expect(screen.queryByRole('complementary', { name: 'Order ticket' })).not.toBeInTheDocument();
  });

  it('unconfigured: shows degraded live opportunities and Execute nudges the API-key form', async () => {
    // The unconfigured wire shape: legs without CrossEx symbols (no keys → no
    // mapping) but APRs still priced via the simulated VIP tier, the server's
    // fee-simulation warning on top. (A group with NO priced APR would be
    // filtered out of the list entirely.)
    const degraded = makeOpportunitiesResult({
      groups: [
        makeOpportunityGroup({
          pairs: [
            makeOpportunityPair({
              shortLeg: makeOpportunityLeg({ crossexSymbol: '' }),
              longLeg: makeOpportunityLeg({
                marketId: 102,
                venue: 'BINANCE',
                crossexVenue: 'BINANCE',
                crossexSymbol: '',
                midApr: 0.045,
                execApr: 0.0455,
              }),
            }),
          ],
        }),
      ],
      warnings: [
        'Perp fees assume the VIP 0 Gate CrossEx schedule — everything else here is live. Your real rates follow your Gate VIP tier; connect Gate keys to price from them.',
      ],
    });
    server.use(
      http.get('/api/credentials', () =>
        HttpResponse.json(env({ configured: false, keyMasked: null })),
      ),
      ...baseHandlers(),
      opportunitiesHandler(degraded),
      http.get('/api/orders/open', () => HttpResponse.json(env<OpenOrder[]>([]))),
    );
    renderWithClient(<App />);

    expect(await screen.findByText(/Perp fees assume the VIP 0 Gate CrossEx schedule/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Fund Gate' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Execute' })).toBeInTheDocument();

    // The VIP simulator only exists while unconfigured — and the knobs now live
    // behind the collapsed assumptions strip, so open it first.
    await userEvent.click(screen.getByRole('button', { name: /with these assumptions/ }));
    expect(screen.getByLabelText('Gate VIP tier')).toBeInTheDocument();

    // Symbols are expectedly absent — the button stays enabled as the guide's nudge.
    const execute = screen.getByRole('button', { name: /^Execute ETH short/ });
    expect(execute).toBeEnabled();
    await userEvent.click(execute);
    await waitFor(() => expect(screen.getByLabelText('API key')).toHaveFocus());
    // The guide flashes the key form's ring on the same nonce bump.
    expect(document.querySelector('.flash-ring')).not.toBeNull();
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
