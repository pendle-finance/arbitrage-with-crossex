import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRebalance } from '../api/queries';
import type { PositionsResponse, RebalanceJob, RebalanceView, RoutePlan, TransferView } from '../api/types';
import {
  plansOf,
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
  plans: plansOf({ ...rebalanceViews.balancedNoJob.plans.even, shortOfEven: 203.64 }),
};

const TWO_PLAN = rebalanceViews.twoBorrows.plans.even;

const lighterLeft = (route: RoutePlan): RoutePlan => ({
  ...route,
  after: route.after.map((w) => (w.venue === 'LIGHTER' ? { ...w, cash: -20, equity: -32 } : w)),
});

const OTHER_ROUTE_LEAVES_BORROW: RebalanceView = {
  ...rebalanceViews.twoBorrows,
  plans: plansOf({ ...TWO_PLAN, routes: { ...TWO_PLAN.routes, convert: lighterLeft(TWO_PLAN.routes.convert) } }),
};

const RECOMMENDED_LEAVES_BORROW: RebalanceView = {
  ...rebalanceViews.twoBorrows,
  plans: plansOf({ ...TWO_PLAN, routes: { ...TWO_PLAN.routes, mix: lighterLeft(TWO_PLAN.routes.mix!) } }),
};

const keepsBorrow = (route: RoutePlan): RoutePlan => ({
  ...route,
  after: route.after.map((w) => (w.coin === 'USDC' ? { ...w, cash: -100, equity: -132 } : w)),
});

const REPAYS_NOTHING: RebalanceView = {
  ...rebalanceViews.twoBorrows,
  plans: plansOf({ ...TWO_PLAN, routes: { ...TWO_PLAN.routes, mix: keepsBorrow(TWO_PLAN.routes.mix!) } }),
};

const UNDER_A_CENT: RebalanceView = {
  ...rebalanceViews.twoBorrows,
  buckets: rebased(rebalanceViews.twoBorrows.buckets, {
    'USDC/HYPERLIQUID': { cash: 100, upnl: 12, equity: 112, borrow: 0, imHeldUsd: 0, mmHeldUsd: 0, interestPerDayUsd: 0 },
    'USDC/LIGHTER': { cash: -4, upnl: -12, equity: -16, borrow: 16, imHeldUsd: 3.2, mmHeldUsd: 1.6, interestPerDayUsd: 0.0048 },
  }),
};

// Lighter's borrow at a round 0.04 a day. The mix route repays all of it.
const AT_4C: RebalanceView = {
  ...rebalanceViews.twoBorrows,
  buckets: rebased(rebalanceViews.twoBorrows.buckets, { 'USDC/LIGHTER': { interestPerDayUsd: 0.04 } }),
};

const feeOf = (view: RebalanceView, costUsd: number): RebalanceView => ({
  ...view,
  plans: plansOf({
    ...view.plans.even,
    routes: {
      ...view.plans.even.routes,
      ...(view.plans.even.routes.mix ? { mix: { ...view.plans.even.routes.mix, costUsd } } : {}),
      convert: { ...view.plans.even.routes.convert, costUsd },
    },
  }),
});

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

/**
 * The card's one-line status. The verdict moved from a bare <p> into a boxed
 * VerdictAlert, whose sentence is a <span>; the job/balanced lines are still
 * <p>. Match either, and compare on the VISIBLE text so an `sr-only` severity
 * prefix ("Warning:") does not have to be repeated in every expectation.
 */
const line = (text: string) => {
  const hits = screen.queryAllByText((_, el) => {
    if (el?.tagName !== 'P' && el?.tagName !== 'SPAN') return false;
    const shown = [...el.childNodes]
      .filter((n) => !(n instanceof HTMLElement && n.classList.contains('sr-only')))
      .map((n) => n.textContent ?? '')
      .join('');
    return shown === text;
  });
  // A <p> and the <span> inside it can both match; take the innermost, which
  // is the element actually carrying the sentence.
  return hits.find((el) => !hits.some((other) => other !== el && el.contains(other))) ?? null;
};

/** The verdict's supporting sub-line, e.g. the days-to-payback figure. */
const sub = () => region().querySelector('.num.text-\\[11px\\]')?.textContent ?? null;

/** The per-wallet lines of a card figure: never under it, only in its hover. */
async function factRows(user: User, key: string, figure: string): Promise<string[][]> {
  expect(document.querySelector(`[data-fact-rows="${key}"]`)).toBeNull();
  const trigger = within(region()).getByRole('button', { name: figure });
  await user.hover(trigger);
  const card = await screen.findByRole('tooltip');
  const spans = [...card.querySelectorAll(`[data-fact-rows="${key}"] span`)].map((el) => el.textContent ?? '');
  const rows: string[][] = [];
  for (let i = 0; i < spans.length; i += 2) rows.push([spans[i], spans[i + 1]]);
  await user.unhover(trigger);
  await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  return rows;
}

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
  it('the block holds three facts, no bars, the days the fee pays back in, and one primary button, with no route, after bars or steps', async () => {
    await show(rebalanceViews.twoBorrows);
    expect(Object.keys(facts())).toEqual(['Borrowing', 'Interest now', 'Interest paid']);
    expect(within(region()).queryByRole('group')).toBeNull();
    expect(region().querySelector('[data-bar-row]')).toBeNull();
    expect(within(region()).queryByText(/Position share|Equity \(cash/)).toBeNull();
    expect(cardButtons().map((button) => button.textContent)).toEqual(['Rebalance']);
    expect(cardButtons()[0].className).toContain('btn-primary');
    expect(within(region()).queryByRole('radiogroup')).toBeNull();
    expect(line('Rebalance recommended.')).toBeInTheDocument();
    // The payback figure is the supporting sub-line under the recommendation.
    expect(sub()).toBe('The fee equals 12 days of the interest it saves.');
    expect(within(region()).queryByText(/After rebalance|Hold to rebalance|Show steps|^Frees$|^Saves$/)).toBeNull();
  });

  it('orders the facts above the button row, and the actions after the Rebalance button', async () => {
    serve(rebalanceViews.twoBorrows);
    renderWithClient(<RebalanceSection actions={<button type="button" className="btn">Manual Transfer</button>} />);
    await screen.findByRole('region', { name: 'Rebalance' });
    await within(region()).findByRole('button', { name: 'Manual Transfer' });
    const [rebalance] = cardButtons();
    const dl = region().querySelector('dl') as HTMLElement;
    const transfer = within(region()).getByRole('button', { name: 'Manual Transfer' });
    expect(dl.compareDocumentPosition(rebalance) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(rebalance.compareDocumentPosition(transfer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(rebalance.parentElement).toBe(transfer.parentElement);
  });

  it('shows the actions while Rebalance loads and after it fails to load', async () => {
    const actions = <button type="button">Manual Transfer</button>;
    serve(rebalanceViews.twoBorrows);
    server.use(http.get('/api/rebalance', () => new Promise<Response>(() => undefined)));
    renderWithClient(<RebalanceSection actions={actions} />);
    expect(await within(await screen.findByRole('region', { name: 'Rebalance' })).findByRole('button', { name: 'Manual Transfer' })).toBeInTheDocument();
    expect(within(region()).queryByRole('button', { name: /^Rebalance/ })).toBeNull();
    cleanup();

    serve(rebalanceViews.twoBorrows);
    server.use(http.get('/api/rebalance', () => HttpResponse.json(GATE_ERROR, { status: 500 })));
    renderWithClient(<RebalanceSection actions={actions} />);
    await waitFor(() => expect(line('Could not load Rebalance. Gate did not answer.')).toBeInTheDocument());
    expect(within(region()).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(within(region()).getByRole('button', { name: 'Manual Transfer' })).toBeInTheDocument();
  });

  it('with no actions and nothing loaded yet, renders nothing', async () => {
    serve(rebalanceViews.twoBorrows);
    server.use(http.get('/api/rebalance', () => new Promise<Response>(() => undefined)));
    const { container } = renderWithClient(<RebalanceSection />);
    await new Promise((r) => setTimeout(r, 50));
    expect(container.textContent).toBe('');
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
    await user.click(cardButtons()[0]);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('transfer link closes the rebalance modal', async () => {
    const user = userEvent.setup();
    const onTransfer = await show(rebalanceViews.twoBorrows, transferViews.accountB);
    await waitFor(() => expect(cardButtons().length).toBeGreaterThan(0));
    await user.click(cardButtons()[0]);
    const dialog = await screen.findByRole('dialog');
    await user.click(await within(dialog).findByRole('button', { name: 'Transfer' }));
    expect(onTransfer).toHaveBeenCalledWith('USDT', 'CROSSEX');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('no open positions says so, and the button still opens the dialog', async () => {
    await show(rebalanceViews.noLegs);
    expect(line('No open positions. Nothing to rebalance.')).toBeInTheDocument();
    expect(within(region()).queryByText('Balanced')).toBeNull();
    expect(cardButtons().map((button) => button.textContent)).toEqual(['Rebalance']);
    expect(cardButtons()[0]).toBeEnabled();
  });
});

describe('RebalanceSection verdict', () => {
  it('no borrow verdict says no rebalancing is necessary, without naming an amount', async () => {
    await show(NO_BORROW);
    expect(line('No borrow. No transfer or rebalancing necessary.')).toBeInTheDocument();
    // The amount is deliberately NOT here: it argued for the move the sentence
    // says is unnecessary. It stays on the button and in the modal.
    expect(within(region()).queryByText(/It moves/)).toBeNull();
  });

  it('a borrow inside the interest-free allowance says so, and never weighs the fee against zero interest', async () => {
    await show(rebalanceViews.hyperliquidFreeBorrow);
    expect(line('No interest payment yet. No transfer or rebalancing necessary.')).toBeInTheDocument();
    // The regression this guards: a wholly-free borrow used to fall through to
    // isNotWorthIt and print "the fee is more than 30 days of the interest it
    // saves" directly beneath a "$0.00 an hour" reading.
    expect(line('Not worth it yet. The fee is more than 30 days of the interest it saves.')).toBeNull();
    expect(line('No interest payment yet. No transfer or rebalancing necessary.')).toHaveClass('text-pastel-blue');
    const [button] = cardButtons();
    expect(button.className).not.toContain('btn-primary');
    expect(button).toBeEnabled();
  });

  it('while a wallet still borrows and the fee is worth it, the card says how many days of saved interest pay the fee', async () => {
    for (const [view, days] of [
      [OTHER_ROUTE_LEAVES_BORROW, '12 days'],
      // The picked route leaves 32 of the 132 Lighter borrow, so it stops 0.03 a day, not 0.0396.
      [RECOMMENDED_LEAVES_BORROW, '16 days'],
      [feeOf(AT_4C, 1.2), '30 days'],
      [feeOf(AT_4C, 0.04), '1 day'],
      [feeOf(AT_4C, 0.03), 'less than a day'],
    ] as const) {
      await show(view);
      expect(sub()).toBe(`The fee equals ${days} of the interest it saves.`);
      expect(line('Rebalance recommended.')).toHaveClass('text-guava');
      expect(within(region()).queryByText(/Repays|Stops|No borrow|This borrow is free today|would move|worth/)).toBeNull();
      expect(cardButtons()[0].className).toContain('btn-primary');
      cleanup();
    }
    await show(OTHER_ROUTE_LEAVES_BORROW);
    expect(cardButtons()[0]).toBeEnabled();
  });

  it.each([
    ['a fee a cent over 30 days of the interest it stops', feeOf(AT_4C, 1.21), 'Rebalance'],
    ['a $20 fee against $0.04 a day', feeOf(rebalanceViews.twoBorrows, 20), 'Rebalance'],
    ['a route that leaves the whole borrow', REPAYS_NOTHING, 'Rebalance'],
    ['a $0.46 fee against a 16 USDC borrow at $0.0048 a day', UNDER_A_CENT, 'Rebalance'],
  ])('%s says it is not worth it yet, and the button is not primary but still opens', async (_, view, name) => {
    const user = userEvent.setup();
    await show(view);
    expect(line('Not worth it yet. The fee is more than 30 days of the interest it saves.')).toHaveClass('text-gold');
    const [button] = cardButtons();
    if (name !== null) expect(button.textContent).toBe(name);
    expect(button.className).not.toContain('btn-primary');
    expect(button).toBeEnabled();
    await user.click(button);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('with every route blocked, no verdict and no primary button', async () => {
    const plan = rebalanceViews.twoBorrows.plans.even;
    const routes = Object.fromEntries(
      Object.entries(plan.routes).map(([name, route]) => [name, route && { ...route, available: false, reason: 'Gate is closed for spot.' }]),
    ) as typeof plan.routes;
    await show({ ...rebalanceViews.twoBorrows, plans: plansOf({ ...plan, routes }) });
    expect(region().querySelector('p.num')).toBeNull();
    expect(cardButtons()[0].className).not.toContain('btn-primary');
    expect(cardButtons()[0]).toBeEnabled();
  });

  it('a free route with a borrow gives no verdict', async () => {
    await show(feeOf(AT_4C, 0));
    expect(region().querySelector('p.num')).toBeNull();
    expect(cardButtons()[0].textContent).toBe('Rebalance');
  });

  it('a failed rate read shows in the Interest now hover AND says so on the card', async () => {
    const user = userEvent.setup();
    await show(feeOf(RATE_READ_FAILED, 20));
    expect(await factRows(user, 'interest', '$0.00 an hour')).toEqual([
      ['Lighter', 'rate unknown'],
      ['Hyperliquid', '$0.00 an hour'],
    ]);
    expect(line('Could not read the borrow interest rate. Check the fee before you move anything.')).toHaveClass('text-gold');
  });

  it('balanced verdict, chip, and the button still opens the dialog', async () => {
    await show(rebalanceViews.balancedNoJob);
    expect(line('Wallets match their position share. Nothing to move.')).toBeInTheDocument();
    expect(within(region()).getByText('Balanced')).toBeInTheDocument();
    expect(cardButtons().map((button) => button.textContent)).toEqual(['Rebalance']);
    expect(cardButtons()[0]).toBeEnabled();
  });

  it('stuck by margin is a warning with no amount, and no chip: never "Balanced"', async () => {
    await show(CASH_LIMITED_EVEN);
    expect(line('Equity unbalanced but no available cash to move')).toHaveClass('text-gold');
    expect(within(region()).queryByText(/\$203\.64/)).toBeNull();
    expect(line('Wallets match their position share. Nothing to move.')).toBeNull();
    // Nothing moves, but the wallets do not match: the chip must not say so.
    expect(within(region()).queryByText('Balanced')).toBeNull();
    expect(within(region()).queryByText('Uneven')).toBeNull();
    expect(cardButtons()[0]).toBeEnabled();
  });

  it('balanced short under 1 keeps Balanced', async () => {
    await show({ ...CASH_LIMITED_EVEN, plans: plansOf({ ...CASH_LIMITED_EVEN.plans.even, shortOfEven: 0.99 }) });
    expect(line('Wallets match their position share. Nothing to move.')).toBeInTheDocument();
    expect(line('Equity unbalanced but no available cash to move')).toBeNull();
    expect(within(region()).getByText('Balanced')).toBeInTheDocument();
    expect(within(region()).queryByText('Uneven')).toBeNull();
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

describe('RebalanceSection has no liquidation fact', () => {
  it('shows no Liquidation fact and reads no positions for it', async () => {
    let reads = 0;
    serve(rebalanceViews.twoBorrows);
    server.use(
      http.get('/api/positions', () => {
        reads += 1;
        return HttpResponse.json(env(NO_POSITIONS));
      }),
    );
    renderWithClient(<RebalanceSection />);
    await waitFor(() => expect(facts().Borrowing).toBe('244.00 USDC'));
    await new Promise((r) => setTimeout(r, 50));
    expect(Object.keys(facts())).not.toContain('Liquidation');
    expect(reads).toBe(0);
  });
});

describe('RebalanceSection facts rows', () => {
  it('Borrowing gives one row per wallet in the hover when two or more borrow', async () => {
    const user = userEvent.setup();
    await show(rebalanceViews.twoBorrows);
    expect(await factRows(user, 'borrowing', '244.00 USDC')).toEqual([
      ['Lighter', '132.00'],
      ['Hyperliquid', '112.00'],
    ]);
  });

  it('Interest now gives one row per borrowing wallet in the hover, as money an hour, with the yearly rate only in the label hover', async () => {
    const user = userEvent.setup();
    await show(rebalanceViews.twoBorrows);
    expect(await factRows(user, 'interest', '$0.0017 an hour')).toEqual([
      ['Lighter', '$0.0017 an hour'],
      ['Hyperliquid', '$0.00 an hour'],
    ]);
    const card = await hoverCard(user, 'Interest now', region());
    expect(card.rows).toEqual(['USDT · CrossEx', 'USDC · Hyperliquid', 'USDC · Lighter']);
  });

  it('Interest paid gives one row per wallet that has paid in the hover, with no line under the figure', async () => {
    const user = userEvent.setup();
    await show(rebalanceViews.interestPaidSplit);
    expect(facts()['Interest paid']).toBe('$1.86');
    expect(await factRows(user, 'paid', '$1.86')).toEqual([
      ['Lighter', '$1.55'],
      ['Hyperliquid', '$0.31'],
    ]);
    expect(within(region()).queryByText('all time')).toBeNull();
  });
});

const verdictLine = (): string =>
  region().querySelector('.alert-blue span:not([aria-hidden]) span')?.textContent ?? '';

const slowJob = (job: RebalanceJob, rounds: number): RebalanceJob => ({
  ...job,
  createdAt: REBALANCE_NOW,
  stepIndex: 0,
  steps: Array.from({ length: rounds }, (_, i) => ({
    ...job.steps[0], round: i + 1, from: 'HYPERLIQUID' as const, to: 'CROSSEX' as const,
  })),
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
    // The job line rides the same VerdictAlert as every other verdict now, so
    // it is the box's sentence rather than a bare <p>.
    const verdict = verdictLine();
    expect(verdict).toMatch(/^Rebalance running, about .+ left\.$/);
    expect(verdict).not.toMatch(/repays|would move/);
  });

  it('past an hour the running line says hours and minutes in the same words as the minutes form', async () => {
    const running = rebalanceViews.accountARunning;
    await show({ ...running, job: slowJob(running.job, 10) });
    expect(verdictLine()).toBe('Rebalance running, about 1 hour 7 minutes left.');
  });

  it('a whole hour left says the hour and no zero minutes', async () => {
    const running = rebalanceViews.accountARunning;
    await show({ ...running, job: slowJob(running.job, 9) });
    expect(verdictLine()).toBe('Rebalance running, about 1 hour left.');
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
    expect(within(region()).getByText(/^\d+s ago$/)).toBeInTheDocument();
    await waitFor(() => expect(pending.land).toBeDefined());
    pending.land?.();
    await waitFor(() => expect(within(region()).queryByText(/^\d+s ago$/)).toBeNull());
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
    await waitFor(() => expect(Object.keys(facts())).toHaveLength(3));
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

// No legs, one borrow: the state the Rebalance card used to answer with
// "Nothing to rebalance" while the interest line above it kept counting.
const EXAMPLE_C = rebalanceViews.exampleC;
const NO_LEGS_BORROW: RebalanceView = {
  buckets: rebased(EXAMPLE_C.buckets, {
    'USDT/CROSSEX': { cash: -22.18, upnl: 0, equity: -22.18, borrow: 22.18, imHeldUsd: 4.44, mmHeldUsd: 2.22, interestPerDayUsd: 0.04, ratePerYear: 0.06 },
  }),
  plans: {
    even: { ...EXAMPLE_C.plans.repay, goal: { kind: 'even' }, noLegs: true },
    repay: {
      ...EXAMPLE_C.plans.even,
      goal: { kind: 'repay' },
      noLegs: true,
      targets: [
        { coin: 'USDT', venue: 'CROSSEX', equity: 0 },
        { coin: 'USDC', venue: 'HYPERLIQUID', equity: 203.64 },
      ],
    },
    custom: null,
  },
  job: null,
};

describe('RebalanceSection presets', () => {
  it('with no legs and a borrow, leads with Clear debt and its fee, and the button opens', async () => {
    await show(NO_LEGS_BORROW);
    expect(line('No open positions. Nothing to rebalance.')).toBeNull();
    expect(line('Clear debt recommended.')).toBeInTheDocument();
    expect(within(region()).getByText('Debt prevents you from withdrawing your cash.')).toBeInTheDocument();
    expect(cardButtons().map((button) => button.textContent)).toEqual(['Clear debt']);
    expect(cardButtons()[0]).toBeEnabled();
  });

  it('with legs and a borrow, leads with whichever preset is worth doing', async () => {
    await show(rebalanceViews.twoBorrows);
    expect(cardButtons()[0].textContent).toBe('Rebalance');
  });

  it('a running repay says so on the card', async () => {
    const running = rebalanceViews.accountARunning;
    await show({ ...running, job: { ...running.job, goal: 'repay' } });
    expect(within(region()).getByText(/^Clear debt running, about .+ left\.$/)).toBeInTheDocument();
  });
});
