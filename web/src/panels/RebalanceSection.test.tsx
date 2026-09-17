import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRebalance } from '../api/queries';
import type { PositionsResponse, RebalanceView, RoutePlan, TransferView } from '../api/types';
import {
  accountBodies,
  accountHandler,
  REBALANCE_NOW,
  rebalanceHandler,
  rebalanceViews,
  rebased,
  transferHandler,
  transferViews,
} from '../test/fixtures';
import { env, server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { RebalanceSection } from './RebalanceSection';

type User = ReturnType<typeof userEvent.setup>;

const NO_POSITIONS: PositionsResponse = { positions: [], exposure: [] };

const GATE_ERROR = { ok: false, error: { category: 'network', message: 'Gate did not answer.', retryable: true } };

const NO_BORROW: RebalanceView = {
  ...rebalanceViews.twoBorrows,
  buckets: rebased(rebalanceViews.twoBorrows.buckets, {
    'USDC/HYPERLIQUID': { cash: 100, upnl: 12, equity: 112, borrow: 0, imHeldUsd: 0, mmHeldUsd: 0, interestPerDayUsd: 0 },
    'USDC/LIGHTER': { cash: 132, upnl: 0, equity: 132, borrow: 0, imHeldUsd: 0, mmHeldUsd: 0, interestPerDayUsd: 0 },
  }),
};

const CASH_LIMITED_EVEN: RebalanceView = {
  ...rebalanceViews.balancedNoJob,
  plan: { ...rebalanceViews.balancedNoJob.plan, shortOfEven: 203.64 },
};

const TWO_PLAN = rebalanceViews.twoBorrows.plan;

const lighterLeft = (route: RoutePlan): RoutePlan => ({
  ...route,
  after: route.after.map((w) => (w.venue === 'LIGHTER' ? { ...w, cash: -20, equity: -32 } : w)),
});

const OTHER_ROUTE_LEAVES_BORROW: RebalanceView = {
  ...rebalanceViews.twoBorrows,
  plan: { ...TWO_PLAN, routes: { ...TWO_PLAN.routes, convert: lighterLeft(TWO_PLAN.routes.convert) } },
};

const RECOMMENDED_LEAVES_BORROW: RebalanceView = {
  ...rebalanceViews.twoBorrows,
  plan: { ...TWO_PLAN, routes: { ...TWO_PLAN.routes, mix: lighterLeft(TWO_PLAN.routes.mix!) } },
};

const keepsBorrow = (route: RoutePlan): RoutePlan => ({
  ...route,
  after: route.after.map((w) => (w.coin === 'USDC' ? { ...w, cash: -100, equity: -132 } : w)),
});

const REPAYS_NOTHING: RebalanceView = {
  ...rebalanceViews.twoBorrows,
  plan: { ...TWO_PLAN, routes: { ...TWO_PLAN.routes, mix: keepsBorrow(TWO_PLAN.routes.mix!) } },
};

const UNDER_A_CENT: RebalanceView = {
  ...rebalanceViews.twoBorrows,
  buckets: rebased(rebalanceViews.twoBorrows.buckets, {
    'USDC/HYPERLIQUID': { cash: 100, upnl: 12, equity: 112, borrow: 0, imHeldUsd: 0, mmHeldUsd: 0, interestPerDayUsd: 0 },
    'USDC/LIGHTER': { cash: -4, upnl: -12, equity: -16, borrow: 16, imHeldUsd: 3.2, mmHeldUsd: 1.6, interestPerDayUsd: 0.0048 },
  }),
};

const RATE_READ_FAILED: RebalanceView = {
  ...rebalanceViews.twoBorrows,
  buckets: rebased(rebalanceViews.twoBorrows.buckets, { 'USDC/LIGHTER': { interestPerDayUsd: 0 } }),
};

function serve(rebalance: RebalanceView, transfer: TransferView = transferViews.spotZero) {
  server.use(
    rebalanceHandler(rebalance),
    transferHandler(transfer),
    accountHandler(accountBodies.accountA),
    http.get('/api/positions', () => HttpResponse.json(env(NO_POSITIONS))),
  );
}

async function show(view: RebalanceView, transfer?: TransferView) {
  serve(view, transfer);
  const onTransfer = vi.fn();
  renderWithClient(<RebalanceSection onTransfer={onTransfer} />);
  await screen.findByRole('region', { name: 'Rebalance' });
  return onTransfer;
}

const region = () => screen.getByRole('region', { name: 'Rebalance' });

const facts = (): Record<string, string | undefined> =>
  Object.fromEntries(
    [...region().querySelectorAll('dt')].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent ?? undefined]),
  );

const line = (text: string) => screen.queryByText((_, el) => el?.tagName === 'P' && el.textContent === text);

const factRows = (key: string): string[][] => {
  const spans = [...region().querySelectorAll(`[data-fact-rows="${key}"] span`)].map((el) => el.textContent ?? '');
  const rows: string[][] = [];
  for (let i = 0; i < spans.length; i += 2) rows.push([spans[i], spans[i + 1]]);
  return rows;
};

const cardButtons = () =>
  within(region())
    .getAllByRole('button')
    .filter((el) => el.tagName === 'BUTTON' && el.className.includes('btn'));

async function hoverCard(user: User, name: string, scope: HTMLElement = document.body) {
  const [trigger] = await within(scope).findAllByRole('button', { name });
  await user.hover(trigger);
  const card = await screen.findByRole('tooltip');
  const shown = {
    text: card.textContent ?? '',
    rows: [...card.querySelectorAll('tbody tr')].map((tr) => tr.firstElementChild?.textContent),
  };
  await user.keyboard('{Escape}');
  await user.unhover(trigger);
  await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  return shown;
}

function ReadAgain() {
  const query = useRebalance();
  return (
    <button type="button" onClick={() => void query.refetch()}>
      read again
    </button>
  );
}

function TabSwitch() {
  const [shown, setShown] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setShown(!shown)}>
        switch tab
      </button>
      {shown && <RebalanceSection />}
    </>
  );
}

describe('RebalanceSection card', () => {
  it('the card holds bars, four facts, no verdict while a wallet borrows, and one button, with no route, after bars or steps', async () => {
    await show(rebalanceViews.twoBorrows);
    expect(Object.keys(facts())).toEqual(['Borrowing', 'Interest now', 'Interest paid', 'Liquidation']);
    expect(within(region()).getByRole('group', { name: /Equity \(cash \+ unrealized PnL\)/ })).toBeInTheDocument();
    expect(within(region()).getByRole('group', { name: 'Position share' })).toBeInTheDocument();
    expect(cardButtons().map((button) => button.textContent)).toEqual(['Rebalance · Fee $0.46']);
    expect(within(region()).queryByRole('radiogroup')).toBeNull();
    expect(region().querySelector('p.num')).toBeNull();
    expect(within(region()).queryByText(/After rebalance|Hold to rebalance|Show steps|^Frees$|^Saves$/)).toBeNull();
  });

  it('orders the facts above the bars, and the button row last', async () => {
    await show(rebalanceViews.twoBorrows);
    const dl = region().querySelector('dl') as HTMLElement;
    const bars = within(region()).getByRole('group', { name: /Equity/ });
    const [button] = cardButtons();
    expect(dl.compareDocumentPosition(bars) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(bars.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('every bar carries a target', async () => {
    await show(rebalanceViews.twoBorrows);
    const rows = [...region().querySelectorAll('[data-bar-row]')];
    expect(rows.map((row) => row.getAttribute('data-bar-row'))).toEqual(['USDT/CROSSEX', 'USDC/HYPERLIQUID', 'USDC/LIGHTER']);
    for (const row of rows) expect(row.querySelector('[data-bar-target]')).not.toBeNull();
  });

  it('has no subtitle under the title', async () => {
    await show(rebalanceViews.accountA);
    expect(within(region()).queryByText(/Match each wallet/)).toBeNull();
    expect(within(region()).queryByText(/Split your CrossEx equity/)).toBeNull();
  });

  it('the button opens the modal', async () => {
    const user = userEvent.setup();
    await show(rebalanceViews.twoBorrows);
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(within(region()).getByRole('button', { name: 'Rebalance · Fee $0.46' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('transfer link closes the rebalance modal', async () => {
    const user = userEvent.setup();
    const onTransfer = await show(rebalanceViews.twoBorrows, transferViews.accountB);
    await user.click(await within(region()).findByRole('button', { name: 'Rebalance · Fee $0.46' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(await within(dialog).findByRole('button', { name: 'Transfer ▸' }));
    expect(onTransfer).toHaveBeenCalledWith('USDT', 'CROSSEX');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('gate wallet shows when cash is stuck', async () => {
    await show(rebalanceViews.accountA);
    const gate = region().querySelector('[data-bar-row="USDC/GATE"]');
    expect(gate).not.toBeNull();
    expect(gate?.querySelector('[data-bar-target]')).not.toBeNull();
    cleanup();
    await show({ ...rebalanceViews.accountA, buckets: rebased(rebalanceViews.accountA.buckets, { 'USDC/GATE': { cash: 0.99, equity: 0.99 } }) });
    expect(region().querySelector('[data-bar-row="USDC/GATE"]')).toBeNull();
  });

  it('no open positions says so and cannot start', async () => {
    await show(rebalanceViews.noLegs);
    expect(line('No open positions. Nothing to rebalance.')).toBeInTheDocument();
    expect(within(region()).queryByText('Balanced')).toBeNull();
    expect(within(region()).queryByRole('group', { name: 'Position share' })).toBeNull();
    expect(cardButtons().map((button) => button.textContent)).toEqual(['Rebalance']);
    expect(cardButtons()[0]).toBeDisabled();
  });
});

describe('RebalanceSection verdict', () => {
  it('no borrow verdict names the amount that would move', async () => {
    await show(NO_BORROW);
    expect(line('No borrow. Rebalance saves no interest. It moves $868.42.')).toBeInTheDocument();
  });

  it('no verdict while any wallet still borrows and the plan is not balanced', async () => {
    for (const view of [OTHER_ROUTE_LEAVES_BORROW, RECOMMENDED_LEAVES_BORROW, UNDER_A_CENT, REPAYS_NOTHING, rebalanceViews.hyperliquidFreeBorrow]) {
      await show(view);
      expect(region().querySelector('p.num')).toBeNull();
      expect(within(region()).queryByText(/Repays|Stops|No borrow|This borrow is free today|would move/)).toBeNull();
      cleanup();
    }
    await show(OTHER_ROUTE_LEAVES_BORROW);
    expect(within(region()).getByRole('button', { name: 'Rebalance · Fee $0.46' })).toBeEnabled();
  });

  it('a failed rate read shows as an Interest now row, not a verdict', async () => {
    await show(RATE_READ_FAILED);
    expect(factRows('interest')).toEqual([
      ['Lighter', 'rate unknown'],
      ['Hyperliquid', '$0.00 an hour'],
    ]);
    expect(region().querySelector('p.num')).toBeNull();
  });

  it('balanced verdict, chip and a disabled button', async () => {
    await show(rebalanceViews.balancedNoJob);
    expect(line('Wallets match their position share. Nothing to move.')).toBeInTheDocument();
    expect(within(region()).getByText('Balanced')).toBeInTheDocument();
    expect(cardButtons().map((button) => button.textContent)).toEqual(['Rebalance']);
    expect(cardButtons()[0]).toBeDisabled();
  });

  it('balanced by cash names the amount stuck', async () => {
    await show(CASH_LIMITED_EVEN);
    expect(line('$203.64 cannot move. It is margin for open positions.')).toBeInTheDocument();
    expect(line('Wallets match their position share. Nothing to move.')).toBeNull();
    expect(within(region()).getByText('Balanced')).toBeInTheDocument();
    expect(cardButtons()[0]).toBeDisabled();
  });

  it('balanced short under 1 keeps Balanced', async () => {
    await show({ ...CASH_LIMITED_EVEN, plan: { ...CASH_LIMITED_EVEN.plan, shortOfEven: 0.99 } });
    expect(line('Wallets match their position share. Nothing to move.')).toBeInTheDocument();
    expect(within(region()).queryByText(/cannot move/)).toBeNull();
    expect(within(region()).getByText('Balanced')).toBeInTheDocument();
  });

  it('the button says it waits for the transfer, with no chip', async () => {
    await show(rebalanceViews.twoBorrows, transferViews.moving);
    const button = await within(region()).findByRole('button', { name: 'Transfer running' });
    expect(button).toBeDisabled();
    expect(within(region()).getAllByText('Transfer running')).toEqual([button]);
    expect(cardButtons().map((el) => el.textContent)).toEqual(['Transfer running']);
  });

  it('the button says it waits for the deal, with no chip', async () => {
    await show(rebalanceViews.twoBorrows, transferViews.lockDeal);
    const button = await within(region()).findByRole('button', { name: 'Deal running' });
    expect(button).toBeDisabled();
    expect(within(region()).getAllByText('Deal running')).toEqual([button]);
    expect(cardButtons().map((el) => el.textContent)).toEqual(['Deal running']);
  });
});

describe('RebalanceSection liquidation fact', () => {
  it('liquidation reads none after both reads succeed with no line', async () => {
    await show(rebalanceViews.twoBorrows);
    await waitFor(() => expect(facts().Liquidation).toBe('none'));
  });

  it('liquidation reads unknown when the account read fails', async () => {
    let reads = 0;
    serve(rebalanceViews.twoBorrows);
    server.use(
      http.get('/api/account', () => {
        reads += 1;
        return HttpResponse.json(GATE_ERROR, { status: 500 });
      }),
    );
    renderWithClient(<RebalanceSection />);
    await waitFor(() => expect(facts().Borrowing).toBe('244.00 USDC'));
    await waitFor(() => expect(reads).toBe(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(facts().Liquidation).toBe('unknown');
  });

  it('liquidation reads unknown when the positions read fails', async () => {
    let reads = 0;
    serve(rebalanceViews.twoBorrows);
    server.use(
      http.get('/api/positions', () => {
        reads += 1;
        return HttpResponse.json(GATE_ERROR, { status: 500 });
      }),
    );
    renderWithClient(<RebalanceSection />);
    await waitFor(() => expect(facts().Borrowing).toBe('244.00 USDC'));
    await waitFor(() => expect(reads).toBe(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(facts().Liquidation).toBe('unknown');
  });
});

describe('RebalanceSection bar tooltip', () => {
  it('the bar tooltip names the wallet in plain text, and the label keeps its hover', async () => {
    await show(rebalanceViews.twoBorrows);
    const row = region().querySelector<HTMLElement>('[data-bar-row="USDC/LIGHTER"]');
    const hit = row?.querySelector<HTMLElement>('[data-bar-hit]');
    if (!row || !hit) throw new Error('no Lighter bar');
    fireEvent.mouseMove(hit, { clientX: 100, clientY: 40 });
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip.textContent?.startsWith('USDC · Lighter')).toBe(true);
    expect(tooltip.querySelector('[class*="border-dotted"], [class*="decoration-dotted"]')).toBeNull();
    expect(within(tooltip).queryByRole('button')).toBeNull();
    expect(within(row).getByRole('button', { name: 'USDC · Lighter' })).toBeInTheDocument();
  });

  it('a negative cash bar reads red, a positive one reads green, and PnL keeps its stripe', async () => {
    await show(rebalanceViews.twoBorrows);
    const crossex = region().querySelector('[data-bar-row="USDT/CROSSEX"]') as HTMLElement;
    const lighter = region().querySelector('[data-bar-row="USDC/LIGHTER"]') as HTMLElement;
    expect(crossex.querySelector('[data-bar-cash]')?.className).toContain('bg-grass');
    expect(crossex.querySelector('[data-bar-pnl]')?.className).toContain('bar-pnl-gain');
    expect(lighter.querySelector('[data-bar-cash]')?.className).toContain('bg-guava');
    expect(lighter.querySelector('[data-bar-pnl]')?.className).toContain('bar-pnl-loss');
  });

  it('the zero line is a separate mark taller than the bar track', async () => {
    await show(rebalanceViews.twoBorrows);
    const zero = region().querySelector('[data-bar-row="USDT/CROSSEX"] [data-zero-line]');
    expect(zero?.className).toContain('bg-ink-200');
    expect(zero?.className).toContain('-translate-x-1/2');
  });
});

describe('RebalanceSection facts rows', () => {
  it('Borrowing gives one row per wallet when two or more borrow', async () => {
    await show(rebalanceViews.twoBorrows);
    expect(factRows('borrowing')).toEqual([
      ['Lighter', '132.00'],
      ['Hyperliquid', '112.00'],
    ]);
  });

  it('Interest now gives one row per borrowing wallet, as money an hour, with the yearly rate only in the hover', async () => {
    const user = userEvent.setup();
    await show(rebalanceViews.twoBorrows);
    expect(factRows('interest')).toEqual([
      ['Lighter', '$0.0017 an hour'],
      ['Hyperliquid', '$0.00 an hour'],
    ]);
    const card = await hoverCard(user, 'Interest now', region());
    expect(card.rows).toEqual(['USDT · CrossEx', 'USDC · Hyperliquid', 'USDC · Lighter']);
  });

  it('Interest paid gives one row per wallet that has paid, with no all-time sub line', async () => {
    await show(rebalanceViews.interestPaidSplit);
    expect(factRows('paid')).toEqual([
      ['Lighter', '$1.55'],
      ['Hyperliquid', '$0.31'],
    ]);
    expect(within(region()).queryByText('all time')).toBeNull();
  });
});

describe('RebalanceSection run states', () => {
  beforeEach(() => {
    vi.setSystemTime(REBALANCE_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('running chip and button', async () => {
    await show(rebalanceViews.accountARunning);
    expect(within(region()).getByText('Running')).toBeInTheDocument();
    expect(within(region()).getByRole('button', { name: 'Running · round 3 of 5' })).toBeEnabled();
    const verdict = region().querySelector('p.num')?.textContent ?? '';
    expect(verdict).toMatch(/^Rebalance running, about .+ left\.$/);
    expect(verdict).not.toMatch(/repays|would move/);
  });

  it('halted chip and button', async () => {
    await show(rebalanceViews.accountAHalted);
    expect(within(region()).getByText('Stopped')).toBeInTheDocument();
    expect(within(region()).getByRole('button', { name: 'Stopped · open' })).toBeEnabled();
    expect(line('Rebalance stopped in round 3.')).toBeInTheDocument();
  });
});

describe('RebalanceSection gate spot and freshness', () => {
  it('the card has no Gate spot line; the Assets table owns that', async () => {
    await show(rebalanceViews.twoBorrows, transferViews.accountB);
    expect(within(region()).queryByText(/318\.42 USDT/)).toBeNull();
    expect(within(region()).queryByText(/in Gate spot/)).toBeNull();
    expect(within(region()).queryByText(/not margin/)).toBeNull();
  });

  it('no spot read shows nothing on the card, but still on the modal', async () => {
    await show(rebalanceViews.twoBorrows, transferViews.noSpot);
    expect(within(region()).queryByText('Add Spot read permission to see spot balances.')).toBeNull();
    expect(within(region()).queryByText(/not margin/)).toBeNull();
    expect(within(region()).queryByText(/0\.00 USD/)).toBeNull();
    cleanup();

    const user = userEvent.setup();
    await show(rebalanceViews.accountAHalted, transferViews.noSpot);
    await user.click(within(region()).getByRole('button', { name: 'Stopped · open' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/^Abandon leaves .+ in Gate spot\. This key cannot read Gate spot\.$/)).toBeInTheDocument();
    expect(dialog.textContent).not.toMatch(/\$0\.00/);
  });

  it('stale on error', async () => {
    const user = userEvent.setup();
    serve(rebalanceViews.twoBorrows);
    renderWithClient(
      <>
        <RebalanceSection />
        <ReadAgain />
      </>,
    );
    await waitFor(() => expect(facts().Borrowing).toBe('244.00 USDC'));
    expect(within(region()).queryByText(/ago$|retrying$/)).toBeNull();
    server.use(http.get('/api/rebalance', () => HttpResponse.json(GATE_ERROR, { status: 500 })));
    await user.click(screen.getByRole('button', { name: 'read again' }));
    expect(await within(region()).findByText(/^stale \d+s · retrying$/)).toBeInTheDocument();
    expect(facts().Borrowing).toBe('244.00 USDC');
    expect(within(region()).queryByRole('alert')).toBeNull();
  });

  it('returns from hidden', async () => {
    const user = userEvent.setup();
    serve(rebalanceViews.twoBorrows);
    renderWithClient(<TabSwitch />);
    await waitFor(() => expect(facts().Borrowing).toBe('244.00 USDC'));
    expect(within(region()).queryByText(/ago$/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'switch tab' }));
    const pending: { land?: () => void } = {};
    server.use(
      http.get(
        '/api/rebalance',
        () =>
          new Promise<Response>((resolve) => {
            pending.land = () => resolve(HttpResponse.json(env(rebalanceViews.twoBorrows)));
          }),
      ),
    );
    await user.click(screen.getByRole('button', { name: 'switch tab' }));
    expect(facts().Borrowing).toBe('244.00 USDC');
    expect(within(region()).getByText(/^⟳ \d+s ago$/)).toBeInTheDocument();
    await waitFor(() => expect(pending.land).toBeDefined());
    pending.land?.();
    await waitFor(() => expect(within(region()).queryByText(/^⟳ \d+s ago$/)).toBeNull());
  });

  it('load error shows the message and Retry reads again', async () => {
    const user = userEvent.setup();
    let reads = 0;
    serve(rebalanceViews.accountA);
    server.use(
      http.get('/api/rebalance', () => {
        reads += 1;
        if (reads > 1) return HttpResponse.json(env(rebalanceViews.accountA));
        return HttpResponse.json(GATE_ERROR, { status: 500 });
      }),
    );
    renderWithClient(<RebalanceSection />);
    await waitFor(() => expect(line('Could not load Rebalance. Gate did not answer.')).toBeInTheDocument());
    await user.click(within(region()).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(Object.keys(facts())).toHaveLength(4));
    expect(reads).toBe(2);
    expect(line('Could not load Rebalance. Gate did not answer.')).toBeNull();
  });

  it('load error stays while the retry poll runs', async () => {
    const user = userEvent.setup();
    let reads = 0;
    serve(rebalanceViews.accountA);
    server.use(
      http.get('/api/rebalance', () => {
        reads += 1;
        if (reads === 1) return HttpResponse.json(GATE_ERROR, { status: 500 });
        return new Promise(() => undefined);
      }),
    );
    renderWithClient(<RebalanceSection />);
    await waitFor(() => expect(line('Could not load Rebalance. Gate did not answer.')).toBeInTheDocument());
    await user.click(within(region()).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(reads).toBe(2));
    expect(line('Could not load Rebalance. Gate did not answer.')).toBeInTheDocument();
    expect(within(region()).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});

describe('RebalanceSection info card', () => {
  it('info card', async () => {
    const user = userEvent.setup();
    await show(rebalanceViews.accountA);
    const card = await hoverCard(user, 'Rebalance', region());
    expect(card.text.startsWith('Rebalance splits CrossEx equity by position size at mark price.')).toBe(true);
    expect(card.rows).toEqual([
      'USDT · CrossEx',
      'USDC · Hyperliquid',
      'USDC · Lighter',
      'Spot loop',
      'Hyperliquid to USDT',
      'USDT to Lighter',
      'Lighter to USDT',
      'Hyperliquid to Lighter',
      'Lighter to Hyperliquid',
      'Convert',
      'Hyperliquid ↔ Lighter',
    ]);
  });

  it('info card cost is a floor', async () => {
    const user = userEvent.setup();
    await show(rebalanceViews.accountA);
    const card = await hoverCard(user, 'Rebalance', region());
    expect(card.text).toContain('USDT to Hyperliquidabout 2 minfrom $0.05');
    expect(card.text).toContain('Hyperliquid to Lighterabout 10 minfrom $2.03');
  });

  it('info card names the borrow interest of each wallet', async () => {
    const user = userEvent.setup();
    await show(rebalanceViews.accountA);
    const card = await hoverCard(user, 'Rebalance', region());
    expect(card.text).toContain('USDC · HyperliquidHyperliquidfree up to 10,000 USDC, then about 5% a year');
    expect(card.text).toContain('USDC · LighterLighterfrom the first dollar, about 11% a year');
    expect(card.text).toContain('USDT · CrossExGate, Binance, OKX, Bybitfrom the first dollar');
  });
});
