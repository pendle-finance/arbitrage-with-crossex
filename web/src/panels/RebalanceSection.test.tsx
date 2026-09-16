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
  it('the card holds bars, four facts, one verdict and one button, and no route, after bars or steps', async () => {
    await show(rebalanceViews.twoBorrows);
    expect(Object.keys(facts())).toEqual(['Borrowing', 'Interest now', 'Interest paid', 'Liquidation']);
    expect(within(region()).getByRole('group', { name: /Now against target/ })).toBeInTheDocument();
    expect(within(region()).getByRole('group', { name: 'Position share' })).toBeInTheDocument();
    expect(cardButtons().map((button) => button.textContent)).toEqual(['Rebalance · $0.46']);
    expect(within(region()).queryByRole('radiogroup')).toBeNull();
    expect(within(region()).queryByText(/After rebalance|Hold to rebalance|Show the steps|^Frees$|^Saves$/)).toBeNull();
  });

  it('every bar carries a target', async () => {
    await show(rebalanceViews.twoBorrows);
    const rows = [...region().querySelectorAll('[data-bar-row]')];
    expect(rows.map((row) => row.getAttribute('data-bar-row'))).toEqual(['USDT/CROSSEX', 'USDC/HYPERLIQUID', 'USDC/LIGHTER']);
    for (const row of rows) expect(row.querySelector('[data-bar-target]')).not.toBeNull();
  });

  it('subtitle', async () => {
    await show(rebalanceViews.accountA);
    expect(within(region()).getByText('Split your CrossEx equity by position size')).toBeInTheDocument();
  });

  it('the button opens the modal', async () => {
    const user = userEvent.setup();
    await show(rebalanceViews.twoBorrows);
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(within(region()).getByRole('button', { name: 'Rebalance · $0.46' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('transfer link closes the rebalance modal', async () => {
    const user = userEvent.setup();
    const onTransfer = await show(rebalanceViews.twoBorrows, transferViews.accountB);
    await user.click(await within(region()).findByRole('button', { name: 'Rebalance · $0.46' }));
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
    expect(line('No borrow. Rebalance saves nothing today. $868.42 would move.')).toBeInTheDocument();
  });

  it('verdict uses the recommended route', async () => {
    await show(OTHER_ROUTE_LEAVES_BORROW);
    expect(line('Repays 244.00 USDC. Stops $0.04 a day of interest.')).toBeInTheDocument();
    expect(within(region()).getByRole('button', { name: 'Rebalance · $0.46' })).toBeEnabled();
    expect(within(region()).queryByText(/\$1\.74|pays back|would move/)).toBeNull();
  });

  it('verdict repays what the route repays', async () => {
    await show(RECOMMENDED_LEAVES_BORROW);
    expect(line('Repays 212.00 USDC. Stops $0.03 a day of interest.')).toBeInTheDocument();
  });

  it('verdict under a cent a day', async () => {
    await show(UNDER_A_CENT);
    expect(line('Repays 16.00 USDC. Stops less than $0.01 a day of interest.')).toBeInTheDocument();
  });

  it('verdict when the route repays no borrow', async () => {
    await show(REPAYS_NOTHING);
    expect(line('Rebalance evens the wallets. It repays no borrow.')).toBeInTheDocument();
    expect(within(region()).queryByText(/Repays|No borrow/)).toBeNull();
  });

  it('rate unknown on a failed rate read', async () => {
    await show(RATE_READ_FAILED);
    expect(line('Repays 244.00 USDC.')).toBeInTheDocument();
    expect(within(region()).getByText('Lighter rate unknown, all of it pays interest')).toBeInTheDocument();
  });

  it('balanced verdict, chip and a disabled button', async () => {
    await show(rebalanceViews.balancedNoJob);
    expect(line('Every wallet is on its share. Nothing to move.')).toBeInTheDocument();
    expect(within(region()).getByText('Balanced')).toBeInTheDocument();
    expect(cardButtons().map((button) => button.textContent)).toEqual(['Rebalance']);
    expect(cardButtons()[0]).toBeDisabled();
  });

  it('free borrow saves no interest', async () => {
    await show(rebalanceViews.hyperliquidFreeBorrow);
    expect(region().querySelector('p.num')?.textContent).toMatch(
      /^Repays [\d,.]+ USDC\. This borrow is free today\.$/,
    );
  });

  it('balanced by cash shows as even as cash allows', async () => {
    await show(CASH_LIMITED_EVEN);
    expect(line('As even as cash allows. $203.64 is margin for open positions.')).toBeInTheDocument();
    expect(line('Every wallet is on its share. Nothing to move.')).toBeNull();
    expect(within(region()).getByText('Balanced')).toBeInTheDocument();
    expect(cardButtons()[0]).toBeDisabled();
  });

  it('balanced short under 1 keeps Balanced', async () => {
    await show({ ...CASH_LIMITED_EVEN, plan: { ...CASH_LIMITED_EVEN.plan, shortOfEven: 0.99 } });
    expect(line('Every wallet is on its share. Nothing to move.')).toBeInTheDocument();
    expect(within(region()).queryByText(/As even as cash allows/)).toBeNull();
    expect(within(region()).getByText('Balanced')).toBeInTheDocument();
  });

  it('the button says it waits for the transfer, with no chip', async () => {
    await show(rebalanceViews.twoBorrows, transferViews.moving);
    const button = await within(region()).findByRole('button', { name: 'Waits for the transfer' });
    expect(button).toBeDisabled();
    expect(within(region()).getAllByText('Waits for the transfer')).toEqual([button]);
    expect(cardButtons().map((el) => el.textContent)).toEqual(['Waits for the transfer']);
  });

  it('the button says it waits for the deal, with no chip', async () => {
    await show(rebalanceViews.twoBorrows, transferViews.lockDeal);
    const button = await within(region()).findByRole('button', { name: 'Waits for the deal' });
    expect(button).toBeDisabled();
    expect(within(region()).getAllByText('Waits for the deal')).toEqual([button]);
    expect(cardButtons().map((el) => el.textContent)).toEqual(['Waits for the deal']);
  });
});

describe('RebalanceSection liquidation fact', () => {
  it('liquidation reads none after both reads succeed with no line', async () => {
    await show(rebalanceViews.twoBorrows);
    await waitFor(() => expect(facts().Liquidation).toBe('none'));
  });

  it('liquidation reads not known when the account read fails', async () => {
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
    expect(facts().Liquidation).toBe('not known');
  });

  it('liquidation reads not known when the positions read fails', async () => {
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
    expect(facts().Liquidation).toBe('not known');
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
    expect(verdict).toMatch(/^A rebalance is running\. Round 3 of 5, about .+ left\. Open it to follow each step\.$/);
    expect(verdict).not.toMatch(/repays|would move/);
  });

  it('halted chip and button', async () => {
    await show(rebalanceViews.accountAHalted);
    expect(within(region()).getByText('Stopped')).toBeInTheDocument();
    expect(within(region()).getByRole('button', { name: 'Stopped · open' })).toBeEnabled();
    expect(line('A rebalance stopped in round 3. Open it to see where your money is.')).toBeInTheDocument();
  });
});

describe('RebalanceSection gate spot and freshness', () => {
  it('gate spot line', async () => {
    await show(rebalanceViews.twoBorrows, transferViews.accountB);
    const spot = await within(region()).findByText('318.42 USDT');
    expect(spot.parentElement).toHaveTextContent('318.42 USDT in Gate spot · not margin');
  });

  it('no spot read', async () => {
    await show(rebalanceViews.twoBorrows, transferViews.noSpot);
    expect(await within(region()).findByText('Add Spot read permission to see spot balances.')).toBeInTheDocument();
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
