import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRebalance } from '../api/queries';
import type { CrossexPosition, FullPlan, PositionsResponse, RealizeRefusal, RebalanceJob, RebalanceView, TransferView } from '../api/types';
import { fmtUsd } from '../lib/fmt';
import {
  makeCrossexPosition,
  accountBodies,
  accountHandler,
  auditRebalanceViews,
  REBALANCE_NOW,
  rebalanceHandler,
  rebalanceViews,
  rebased,
  OWNER_BEFORE_PERPS,
  REALIZE_HALTED_LEG_OPEN_JOB,
  REALIZE_ROUTE_JOB,
  REALIZE_RETRYING_JOB,
  REALIZE_RUNNING_JOB,
  transferHandler,
  transferViews,
  whaleRebalanceViews,
} from '../test/fixtures';
import { env, server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { RebalanceOpenerProvider, useRebalanceOpenState } from './rebalanceOpener';
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

function OpenProbe() {
  const state = useRebalanceOpenState();
  return <output data-testid="opened">{state.open ? (state.tab ?? 'no tab') : 'closed'}</output>;
}

const withOpener = (ui: ReactNode) => (
  <RebalanceOpenerProvider>
    {ui}
    <OpenProbe />
  </RebalanceOpenerProvider>
);

const opened = () => screen.getByTestId('opened').textContent;

async function show(view: RebalanceView, transfer?: TransferView) {
  serve(view, transfer);
  renderWithClient(withOpener(<RebalanceSection />));
  await screen.findByRole('region', { name: 'Borrow' });
}

const region = () => screen.getByRole('region', { name: 'Borrow' });

const facts = (): Record<string, string | undefined> =>
  Object.fromEntries(
    [...region().querySelectorAll('dt')].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent ?? undefined]),
  );

const line = (text: string) => {
  const hits = screen.queryAllByText((_, el) => {
    if (el?.tagName !== 'P' && el?.tagName !== 'SPAN') return false;
    const shown = [...el.childNodes]
      .filter((n) => !(n instanceof HTMLElement && n.classList.contains('sr-only')))
      .map((n) => n.textContent ?? '')
      .join('');
    return shown === text;
  });
  return hits.find((el) => !hits.some((other) => other !== el && el.contains(other))) ?? null;
};

const sub = () => region().querySelector('.num.text-\\[11px\\]')?.textContent ?? null;

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
    .filter((el) => el.tagName === 'BUTTON' && el.className.includes('btn') && !el.className.includes('btn-link'));

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

const fullPlanOf = (view: RebalanceView): FullPlan => view.fullPlan as FullPlan;

const planText = (plan: FullPlan): string =>
  `${plan.needsRealize ? 'Realize uPnL, then Move cash' : 'Move cash'} · Total cost ${fmtUsd(plan.costUsd)} · Interest a month ${fmtUsd(plan.interestPerMonthUsd)} → 0`;

const refusedWith = (refused: RealizeRefusal): RebalanceView => {
  const view = rebalanceViews.realizeRefused;
  return { ...view, fullPlan: { ...fullPlanOf(view), refused } };
};

describe('RebalanceSection card', () => {
  it('section title is Borrow', async () => {
    await show(rebalanceViews.recommendedRealize);
    const heading = within(region()).getByRole('heading', { level: 2 });
    expect(within(heading).getByRole('button', { name: 'Borrow' })).toBeInTheDocument();
    expect(within(region()).queryByText(/^Rebalance$/)).toBeNull();
  });

  it('button reads Reduce borrow', async () => {
    for (const view of [rebalanceViews.recommendedRealize, rebalanceViews.notRecommended, rebalanceViews.interestFree]) {
      await show(view);
      expect(cardButtons().map((button) => button.textContent)).toEqual(['Reduce borrow']);
      expect(cardButtons()[0]).toBeEnabled();
      cleanup();
    }
  });

  it('the block holds three facts, the verdict and one button, with no route, bars or steps', async () => {
    await show(rebalanceViews.recommendedRealize);
    expect(Object.keys(facts())).toEqual(['Borrowing', 'Interest now', 'Interest paid']);
    expect(within(region()).queryByRole('group')).toBeNull();
    expect(region().querySelector('[data-bar-row]')).toBeNull();
    expect(within(region()).queryByRole('radiogroup')).toBeNull();
    expect(within(region()).queryByText(/Position share|Hold to|Show steps|Balanced/)).toBeNull();
  });

  it('orders the facts above the button row, and the actions after the Reduce borrow button', async () => {
    serve(rebalanceViews.twoBorrows);
    renderWithClient(<RebalanceSection actions={<button type="button" className="btn">Manual Transfer</button>} />);
    await screen.findByRole('region', { name: 'Borrow' });
    await within(region()).findByRole('button', { name: 'Manual Transfer' });
    const [reduce] = cardButtons();
    const dl = region().querySelector('dl') as HTMLElement;
    const transfer = within(region()).getByRole('button', { name: 'Manual Transfer' });
    expect(dl.compareDocumentPosition(reduce) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(reduce.compareDocumentPosition(transfer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(reduce.parentElement).toBe(transfer.parentElement);
  });

  it('shows the actions while it loads and after it fails to load', async () => {
    const actions = <button type="button">Manual Transfer</button>;
    serve(rebalanceViews.twoBorrows);
    server.use(http.get('/api/rebalance', () => new Promise<Response>(() => undefined)));
    renderWithClient(<RebalanceSection actions={actions} />);
    expect(await within(await screen.findByRole('region', { name: 'Borrow' })).findByRole('button', { name: 'Manual Transfer' })).toBeInTheDocument();
    expect(within(region()).queryByRole('button', { name: /^Reduce borrow/ })).toBeNull();
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

  it('the button calls the opener with no tab, and the card mounts no dialog', async () => {
    const user = userEvent.setup();
    await show(rebalanceViews.recommendedRealize);
    expect(opened()).toBe('closed');
    await user.click(cardButtons()[0]);
    expect(opened()).toBe('no tab');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('with no borrow the button reads Move cash and opens the Move cash tab', async () => {
    const user = userEvent.setup();
    for (const view of [rebalanceViews.noBorrow, NO_BORROW]) {
      await show(view);
      expect(cardButtons().map((button) => button.textContent)).toEqual(['Move cash']);
      await user.click(cardButtons()[0]);
      expect(opened()).toBe('move');
      cleanup();
    }
  });

  it('a stopped run opens through the opener too', async () => {
    const user = userEvent.setup();
    await show(rebalanceViews.accountAHalted);
    await user.click(within(region()).getByRole('button', { name: 'Stopped · open' }));
    expect(opened()).toBe('no tab');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('RebalanceSection verdict', () => {
  it('no borrow shows a muted No borrow line and no box', async () => {
    for (const view of [rebalanceViews.noBorrow, NO_BORROW]) {
      await show(view);
      expect(line('No borrow')).toHaveClass('text-ink-400');
      expect(region().querySelector('.alert-blue, .alert-amber, .alert-red')).toBeNull();
      expect(cardButtons()[0].className).not.toContain('btn-primary');
      cleanup();
    }
  });

  it('a borrow inside the interest-free allowance shows the muted interest-free line', async () => {
    for (const view of [rebalanceViews.interestFree, rebalanceViews.hyperliquidFreeBorrow]) {
      await show(view);
      expect(line('Interest-free under 10,000 USDC')).toHaveClass('text-ink-400');
      expect(region().querySelector('.alert-blue, .alert-amber, .alert-red')).toBeNull();
      expect(cardButtons()[0].className).not.toContain('btn-primary');
      cleanup();
    }
  });

  it('recommended tone and line', async () => {
    const view = rebalanceViews.recommendedRealize;
    await show(view);
    const verdict = line(`Reduce borrow recommended · cost = ${fullPlanOf(view).days} days of interest`);
    expect(verdict).toHaveClass('text-pastel-blue');
    expect(verdict?.closest('.alert-blue')).not.toBeNull();
    expect(region().querySelector('.lucide-check')).not.toBeNull();
    expect(region().querySelector('.lucide-triangle-alert')).toBeNull();
    expect(region().querySelector('.alert-red')).toBeNull();
  });

  it('recommended button primary', async () => {
    await show(rebalanceViews.recommendedRealize);
    expect(cardButtons()[0].className).toContain('btn-primary');
    cleanup();
    await show(rebalanceViews.recommendedCashOnly);
    expect(cardButtons()[0].className).toContain('btn-primary');
  });

  it('line two with realize', async () => {
    const view = rebalanceViews.recommendedRealize;
    expect(fullPlanOf(view).needsRealize).toBe(true);
    await show(view);
    expect(sub()).toBe(planText(fullPlanOf(view)));
    expect(sub()).toMatch(/^Realize uPnL, then Move cash · Total cost \$[\d,.]+ · Interest a month \$[\d,.]+ → 0$/);
  });

  it('line two cash only', async () => {
    const view = rebalanceViews.recommendedCashOnly;
    expect(fullPlanOf(view).needsRealize).toBe(false);
    await show(view);
    expect(line(`Reduce borrow recommended · cost = ${fullPlanOf(view).days} days of interest`)).not.toBeNull();
    expect(sub()).toBe(planText(fullPlanOf(view)));
    expect(sub()).toMatch(/^Move cash · Total cost \$[\d,.]+ · Interest a month \$[\d,.]+ → 0$/);
  });

  it('above the 30 day limit', async () => {
    const plan = fullPlanOf(rebalanceViews.ownerAccount);
    expect(plan.days).toBe(36);
    await show(rebalanceViews.ownerAccount);
    expect(line('Not recommended: cost = 36 days of interest (limit 30)')).toHaveClass('text-gold');
    expect(sub()).toBe(`Needs Realize uPnL, then Move cash · Total cost $41.82 · Interest a month ${fmtUsd(plan.interestPerMonthUsd)} → 0`);
    expect(cardButtons()[0].className).not.toContain('btn-primary');
    expect(region().querySelector('.alert-blue')).toBeNull();
    cleanup();
    const cashOnly = rebalanceViews.recommendedCashOnly;
    await show({ ...cashOnly, fullPlan: { ...fullPlanOf(cashOnly), days: 31 } });
    expect(line('Not recommended: cost = 31 days of interest (limit 30)')).not.toBeNull();
    expect(sub()).toBe(`Needs ${planText(fullPlanOf(cashOnly))}`);
    cleanup();
    await show({ ...cashOnly, fullPlan: { ...fullPlanOf(cashOnly), days: 30 } });
    expect(line('Reduce borrow recommended · cost = 30 days of interest')).not.toBeNull();
  });

  it('part clear never colors', async () => {
    await show(rebalanceViews.realizeRefused);
    const blocked = line('Realize uPnL blocked: book too thin to price');
    expect(blocked).toHaveClass('text-gold');
    expect(region().querySelector('.alert-blue, .alert-red')).toBeNull();
    expect(cardButtons()[0].className).not.toContain('btn-primary');
    cleanup();
    await show(rebalanceViews.cashShort);
    expect(fullPlanOf(rebalanceViews.cashShort).clearsBorrow).toBe(false);
    expect(region().querySelector('.alert-blue, .alert-red')).toBeNull();
    expect(within(region()).queryByText(/recommended/)).toBeNull();
    expect(cardButtons()[0].className).not.toContain('btn-primary');
  });

  it('cash short with no uPnL says how much cash clears', async () => {
    await show(rebalanceViews.cashShort);
    expect(fullPlanOf(rebalanceViews.cashShort).needsRealize).toBe(false);
    expect(line('Cash clears 600.00 of 2,000.00.')).toHaveClass('text-ink-400');
    expect(region().querySelector('.alert-blue, .alert-amber, .alert-red')).toBeNull();
  });

  it('refusal reason per code', async () => {
    for (const [refused, reason] of [
      [{ reason: 'no-margin', bp: null }, 'no margin to reopen'],
      [{ reason: 'no-fee-rate', bp: null }, 'fee rate not loaded'],
      [{ reason: 'past-book', bp: null }, 'book too thin to price'],
      [{ reason: 'over-cap', bp: null, capUsd: 250_000 }, 'above the $250,000 market-order cap'],
    ] as const) {
      await show(refusedWith(refused));
      expect(line(`Realize uPnL blocked: ${reason}`)).toHaveClass('text-gold');
      expect(within(region()).queryByRole('button', { name: 'Delever a pair' })).toBeNull();
      cleanup();
    }
  });

  it('IM full links delever', async () => {
    const user = userEvent.setup();
    await show(rebalanceViews.imFull);
    expect(line('Realize uPnL blocked: IM used 91.4%')?.closest('.text-gold')).not.toBeNull();
    expect(line('Realize uPnL blocked: no margin to reopen')).toBeNull();
    const link = within(region()).getByRole('button', { name: 'Delever a pair' });
    expect(opened()).toBe('closed');
    await user.click(link);
    expect(opened()).toBe('delever');
    cleanup();
    const atStop = { ...rebalanceViews.imFull, imUsed: [{ account: 'CROSSEX' as const, pct: 0.89 }] };
    await show(atStop);
    expect(line('Realize uPnL blocked: no margin to reopen')).not.toBeNull();
    expect(within(region()).queryByRole('button', { name: 'Delever a pair' })).toBeNull();
    cleanup();
    await show({ ...rebalanceViews.imFull, imUsed: undefined });
    expect(line('Realize uPnL blocked: no margin to reopen')).not.toBeNull();
  });

  it('a borrow with no full plan gives no box', async () => {
    await show(rebalanceViews.twoBorrows);
    expect(region().querySelector('.alert-blue, .alert-amber, .alert-red')).toBeNull();
    expect(cardButtons()[0].className).not.toContain('btn-primary');
  });

  it('whale account figures keep every digit', async () => {
    const view = whaleRebalanceViews.ownerAccount;
    await show(view);
    const plan = fullPlanOf(view);
    expect(sub()).toContain(`Total cost ${fmtUsd(plan.costUsd)} · Interest a month ${fmtUsd(plan.interestPerMonthUsd)}`);
    expect(sub()).not.toMatch(/\d[KM]\b/);
  });

  it('a failed rate read shows in the Interest now hover AND says so on the card', async () => {
    const user = userEvent.setup();
    await show(RATE_READ_FAILED);
    expect(await factRows(user, 'interest', '$0.00 an hour')).toEqual([
      ['Lighter', 'Rate unknown'],
      ['Hyperliquid', '$0.00 an hour'],
    ]);
    expect(line('Could not read the borrow interest rate. Check the fee before you move anything.')).toHaveClass('text-gold');
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

  it('a run past its usual time says longer than usual, never about 0s left', async () => {
    const running = rebalanceViews.accountARunning;
    await show({ ...running, job: { ...running.job, createdAt: REBALANCE_NOW - 3 * 3_600_000 } });
    expect(verdictLine()).toBe('Rebalance running, longer than usual.');
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
    expect(within(region()).queryByText('Set Spot Trading to Read Only to see Gate spot balances.')).toBeNull();
    expect(within(region()).queryByText(/not margin/)).toBeNull();
    expect(within(region()).queryByText(/0\.00 USD/)).toBeNull();
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
    expect(await within(region()).findByText(/^Stale \d+s · retrying$/)).toBeInTheDocument();
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

describe('RebalanceSection run lines', () => {
  it('a running repay says so on the card', async () => {
    vi.setSystemTime(REBALANCE_NOW);
    const running = rebalanceViews.accountARunning;
    await show({ ...running, job: { ...running.job, goal: 'repay' } });
    expect(within(region()).getByText(/^Clear debt running, about .+ left\.$/)).toBeInTheDocument();
    vi.useRealTimers();
  });
});

const HL_ETH = 'HYPERLIQUID_FUTURE_ETH_USDC';

const GATE_ETH = 'GATE_FUTURE_ETH_USDT';

function servePositions(view: RebalanceView, positions: CrossexPosition[]) {
  serve(view);
  server.use(http.get('/api/positions', () => HttpResponse.json(env({ positions, exposure: [] }))));
}

function serveMark(view: RebalanceView) {
  servePositions(view, [makeCrossexPosition({ symbol: HL_ETH, markPrice: '1821' })]);
}

describe('RebalanceSection profit step', () => {
  beforeEach(() => {
    vi.setSystemTime(REBALANCE_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('card names step 1', async () => {
    await show({ ...rebalanceViews.realizeRunning });
    expect(within(region()).getByRole('button', { name: 'Running · step 1 of 2' })).toBeEnabled();
    expect(REALIZE_RUNNING_JOB.steps[REALIZE_RUNNING_JOB.stepIndex]?.name).toBe('Close');
    cleanup();
    await show(rebalanceViews.realizeRoute);
    expect(within(region()).getByRole('button', { name: 'Running · step 2 of 2' })).toBeEnabled();
  });

  it('card while a reopen retries', async () => {
    serveMark(rebalanceViews.realizeRetrying);
    renderWithClient(<RebalanceSection />);
    await screen.findByRole('region', { name: 'Borrow' });
    const gap = await waitFor(() => {
      const hit = line('Hyperliquid short 53.8 ETH smaller · $97,970 not hedged · reopening.');
      expect(hit).not.toBeNull();
      return hit!;
    });
    expect(gap).toHaveClass('text-gold');
    expect(sub()).toBeNull();
    expect(REALIZE_RETRYING_JOB.steps[REALIZE_RETRYING_JOB.stepIndex]?.retry?.convertAmount).toBe(1500);
  });

  it('card stop with the leg open', async () => {
    servePositions(rebalanceViews.realizeHaltedLegOpen, [
      makeCrossexPosition({ symbol: HL_ETH, positionSide: 'SHORT', positionQty: '12.2', markPrice: '1821' }),
      makeCrossexPosition({ symbol: GATE_ETH, positionSide: 'LONG', positionQty: '66', markPrice: '1821' }),
    ]);
    renderWithClient(<RebalanceSection />);
    await screen.findByRole('region', { name: 'Borrow' });
    const box = await waitFor(() => {
      const hit = line('Hyperliquid short is 53.8 ETH smaller than the Gate long.');
      expect(hit).not.toBeNull();
      return hit!;
    });
    expect(box).toHaveClass('text-guava');
    expect(sub()).toBe('$97,970 not hedged.');
    expect(cardButtons()[0]).toHaveTextContent(/^Reduce borrow$/);
    expect(cardButtons()[0]).toBeEnabled();
    expect(REALIZE_HALTED_LEG_OPEN_JOB.status).toBe('halted');
  });

  it('abandoned run names the open gap', async () => {
    const abandoned = auditRebalanceViews.realizeAbandonedLegOpen;
    const gateLong = (qty: string) => makeCrossexPosition({ symbol: GATE_ETH, positionSide: 'LONG', positionQty: qty, markPrice: '1821' });
    const hlShort = (qty: string) => makeCrossexPosition({ symbol: HL_ETH, positionSide: 'SHORT', positionQty: qty, markPrice: '1821' });
    const text = '53.8 ETH short not reopened, $97,970 not hedged';
    servePositions(abandoned, [hlShort('-12.2'), gateLong('66')]);
    renderWithClient(<RebalanceSection />);
    const gap = await within(await screen.findByRole('region', { name: 'Borrow' })).findByText(text);
    expect(gap).toHaveClass('text-guava');
    expect(gap.compareDocumentPosition(cardButtons()[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    cleanup();
    servePositions(abandoned, [hlShort('-66'), gateLong('66')]);
    renderWithClient(<RebalanceSection />);
    await screen.findByRole('region', { name: 'Borrow' });
    await waitFor(() => expect(within(region()).queryByText(/not reopened/)).toBeNull());
    expect(cardButtons()[0]).toHaveTextContent('Reduce borrow');
    cleanup();
    const before = { ...abandoned, job: { ...abandoned.job!, before: { buckets: abandoned.buckets, perps: OWNER_BEFORE_PERPS } } };
    servePositions(before, [hlShort('-12.2'), gateLong('12.2')]);
    renderWithClient(<RebalanceSection />);
    await screen.findByRole('region', { name: 'Borrow' });
    await waitFor(() => expect(within(region()).queryByText(/not reopened/)).toBeNull());
    cleanup();
    servePositions(before, [hlShort('-12.2'), gateLong('66')]);
    renderWithClient(<RebalanceSection />);
    expect(await within(await screen.findByRole('region', { name: 'Borrow' })).findByText(text)).toBeInTheDocument();
  });

  it('a new job keeps the abandoned gap line until positions are whole', async () => {
    const done = rebalanceViews.realizeDone;
    const gateLong = (qty: string) => makeCrossexPosition({ symbol: GATE_ETH, positionSide: 'LONG', positionQty: qty, markPrice: '1821' });
    const hlShort = (qty: string) => makeCrossexPosition({ symbol: HL_ETH, positionSide: 'SHORT', positionQty: qty, markPrice: '1821' });
    const carried: RebalanceView = {
      ...done,
      job: {
        ...done.job!,
        openGaps: [
          {
            leg: { symbol: HL_ETH, base: 'ETH', exchange: 'HYPERLIQUID', side: 'SHORT', positionQty: 119.8, hedge: 'GATE' },
            qty: 53.8,
            hedges: [{ symbol: GATE_ETH, exchange: 'GATE', side: 'LONG', qty: 66 }],
          },
        ],
      },
    };
    servePositions(carried, [hlShort('-66'), gateLong('66')]);
    renderWithClient(<RebalanceSection />);
    const gap = await within(await screen.findByRole('region', { name: 'Borrow' })).findByText('53.8 ETH short not reopened, $97,970 not hedged');
    expect(gap).toHaveClass('text-guava');
    cleanup();
    servePositions(carried, [hlShort('-66'), gateLong('12.2')]);
    renderWithClient(<RebalanceSection />);
    await screen.findByRole('region', { name: 'Borrow' });
    await waitFor(() => expect(within(region()).queryByText(/not reopened/)).toBeNull());
  });

  it('card gap with no positions read says the size', async () => {
    await show(rebalanceViews.realizeRetrying);
    expect(line('Hyperliquid short 53.8 ETH smaller · reopening.')).toHaveClass('text-gold');
  });

  it('part fill shows the gap', async () => {
    serveMark(rebalanceViews.realizePartFill);
    renderWithClient(<RebalanceSection />);
    await screen.findByRole('region', { name: 'Borrow' });
    await waitFor(() => expect(line('Hyperliquid short 30.0 ETH smaller · $54,630 not hedged · reopening.')).not.toBeNull());
  });

  it('route convert reads step 2', async () => {
    const steps = REALIZE_ROUTE_JOB.steps.map((step, index) => (index === REALIZE_ROUTE_JOB.stepIndex ? { ...step, name: 'Convert' } : step));
    await show({ ...rebalanceViews.realizeRoute, job: { ...REALIZE_ROUTE_JOB, route: 'convert', steps } });
    expect(within(region()).getByRole('button', { name: 'Running · step 2 of 2' })).toBeEnabled();
  });

  it('one-step run reads Running', async () => {
    await show(auditRebalanceViews.realizeOnlyRunning);
    expect(cardButtons()[0]).toHaveTextContent(/^Running$/);
  });

  it('stop before the close', async () => {
    await show(rebalanceViews.realizeHaltedBeforeClose);
    expect(line('Stopped before the close')).not.toBeNull();
    expect(within(region()).getByRole('button', { name: 'Stopped · open' })).toBeEnabled();
  });

  it('stop after a close that was sent reads like the modal', async () => {
    await show(auditRebalanceViews.realizeHaltedCloseSent);
    expect(line('Stopped after sending the close')).not.toBeNull();
    expect(line('Stopped before the close')).toBeNull();
  });

  it('card sizes use one decimal', async () => {
    await show(whaleRebalanceViews.realizeWhaleRetrying);
    expect(line('Hyperliquid short 11,000.0 ETH smaller · reopening.')).not.toBeNull();
  });
});

describe('Borrow card names the job by kind and state', () => {
  it('a running Realize reads Realize uPnL running', async () => {
    serve(rebalanceViews.ownerRealizeRunning);
    renderWithClient(withOpener(<RebalanceSection />));
    expect(await within(await screen.findByRole('region', { name: 'Borrow' })).findByText('Realize uPnL running.')).toBeInTheDocument();
    expect(screen.queryByText(/^Clear debt/)).toBeNull();
  });

  it('a paused Delever reads paused and shows its Boros gap', async () => {
    serve(rebalanceViews.deleverPausedGap);
    renderWithClient(withOpener(<RebalanceSection />));
    const card = await screen.findByRole('region', { name: 'Borrow' });
    expect(await within(card).findByText('Delever paused.')).toBeInTheDocument();
    expect(within(card).getByText('Paused')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Paused · open' })).toBeInTheDocument();
    expect(within(card).getByText(/^Boros .+ YU has no perp behind it$/)).toBeInTheDocument();
  });
});
