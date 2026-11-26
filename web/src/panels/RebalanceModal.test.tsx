import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAccount, usePositions, useRebalance, useTransfer } from '../api/queries';
import type { CrossexAccount, PositionsResponse, RebalanceStep, RebalanceView, TransferView } from '../api/types';
import type { Pool, RebalanceJob, RouteName } from '../api/types';
import { plansOf, accountBodies, accountHandler, positionsBodies, REBALANCE_NOW, rebalanceViews, rebased, whaleRebalanceViews } from '../test/fixtures';
import { extraRebalanceViews, transferHandler, transferViews, twapFixtures } from '../test/fixtures';
import { env, server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { fmtApprox, fmtNotionalShort, fmtUsd, num, sigGrouped } from '../lib/fmt';
import { rebalanceHandler } from '../test/fixtures';
import { RebalanceModal, RebalanceModalHost } from './RebalanceModal';
import { RebalanceOpenerProvider, useRebalanceOpener, type RebalanceTab } from './rebalanceOpener';

const NO_POSITIONS: PositionsResponse = { positions: [], exposure: [] };

interface Over {
  transfer?: TransferView;
  account?: CrossexAccount;
  positions?: PositionsResponse;
  holdMs?: number;
}

function serve(over: Over) {
  server.use(
    transferHandler(over.transfer ?? transferViews.spotZero),
    accountHandler(over.account ?? accountBodies.accountA),
    http.get('/api/positions', () => HttpResponse.json(env(over.positions ?? NO_POSITIONS))),
  );
}

function show(view: RebalanceView, over: Over = {}) {
  serve(over);
  const onClose = vi.fn();
  const onTransfer = vi.fn();
  renderWithClient(<RebalanceModal view={view} onClose={onClose} onTransfer={onTransfer} holdMs={over.holdMs} />);
  return { onClose, onTransfer };
}

let poll: () => void = () => {};

function Polled({ views, onClose, holdMs }: { views: RebalanceView[]; onClose: () => void; holdMs?: number }) {
  const [index, setIndex] = useState(0);
  poll = () => setIndex(1);
  return <RebalanceModal view={views[index]} onClose={onClose} holdMs={holdMs} />;
}

function showPolled(views: RebalanceView[], over: Over = {}) {
  serve(over);
  const onClose = vi.fn();
  renderWithClient(<Polled views={views} onClose={onClose} holdMs={over.holdMs} />);
  return { onClose, next: async () => act(async () => poll()) };
}

const dialog = () => screen.getByRole('dialog');

const facts = (): Record<string, string> =>
  Object.fromEntries(
    [...dialog().querySelectorAll('dt')].map((dt) => [dt.textContent ?? '', dt.nextElementSibling?.textContent ?? '']),
  );

const subs = (label: string): string[] => {
  const dt = [...dialog().querySelectorAll('dt')].find((node) => node.textContent === label);
  return [...(dt?.parentElement?.querySelectorAll('dd') ?? [])].slice(1).map((dd) => dd.textContent ?? '');
};

const rowOf = (name: string) => screen.getByRole('radio', { name }).closest('label') as HTMLElement;

// The preset toggle is a radiogroup too, so route radios are read inside theirs.
const routeGroup = () => within(dialog()).getByRole('radiogroup', { name: 'Route' });

const pickedRow = () => within(routeGroup()).getByRole('radio', { checked: true }).closest('label') as HTMLElement;

const HOLD = /^Hold to (rebalance|clear debt|move)/;
const holdButton = () => screen.getByRole('button', { name: HOLD });

interface StartBody {
  route: string;
  costUsd: number;
}

function starts(): StartBody[] {
  const sent: StartBody[] = [];
  server.use(
    http.post('/api/rebalance', async ({ request }) => {
      sent.push((await request.json()) as StartBody);
      return HttpResponse.json(env({ id: rebalanceViews.accountADone.job.id }));
    }),
  );
  return sent;
}

function refuseStart(status: number, error: Record<string, unknown>): StartBody[] {
  const sent: StartBody[] = [];
  server.use(
    http.post('/api/rebalance', async ({ request }) => {
      sent.push((await request.json()) as StartBody);
      return HttpResponse.json({ ok: false, error }, { status });
    }),
  );
  return sent;
}

const PLAN_CHANGED_TEXT = 'The plan changed. Check the new route before you rebalance.';

const PLAN_CHANGED_ERROR = { category: 'validation', label: 'PLAN_CHANGED', message: PLAN_CHANGED_TEXT, retryable: true };

function Live({ holdMs }: { holdMs?: number }) {
  const view = useRebalance().data;
  return view ? <RebalanceModal view={view} onClose={() => undefined} holdMs={holdMs} /> : null;
}

function commands(answered: Promise<void> = Promise.resolve()): string[] {
  const sent: string[] = [];
  server.use(
    http.post('/api/rebalance/:id/:command', async ({ params }) => {
      sent.push(`${String(params.command)} ${String(params.id)}`);
      await answered;
      return HttpResponse.json(env(rebalanceViews.accountAHalted.job));
    }),
  );
  return sent;
}

function held(): { answer: () => void; answered: Promise<void> } {
  let answer: () => void = () => undefined;
  const answered = new Promise<void>((resolve) => {
    answer = resolve;
  });
  return { answer, answered };
}

const HALTED_ID = rebalanceViews.accountAHalted.job.id;

const line = (text: string) => screen.queryByText((_, el) => el?.tagName === 'P' && el.textContent === text);

const routeNames = () =>
  within(routeGroup()).getAllByRole('radio')
    .map((radio) => document.getElementById(radio.getAttribute('aria-labelledby') ?? '')?.textContent);

const innerItems = (): HTMLElement[] => {
  const items = within(dialog()).getAllByRole('listitem');
  const nested = items.filter((item) => item.parentElement?.closest('li'));
  return nested.length > 0 ? nested : items;
};

const stepTexts = () =>
  innerItems().map((row) =>
    [...row.children]
      .flatMap((el) => (el.children.length > 1 ? [...el.children] : [el]))
      .map((el) => el.textContent)
      .filter(Boolean),
  );

const moreSteps = () => screen.queryByRole('button', { name: 'Show all steps' });

async function openSteps(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement[]> {
  const more = moreSteps();
  if (more) await user.click(more);
  return innerItems();
}

function Loaded() {
  const reads = [useTransfer().data, useAccount().data, usePositions().data];
  return reads.every(Boolean) ? <span>reads loaded</span> : null;
}

async function hoverCard(user: ReturnType<typeof userEvent.setup>, name: string) {
  const [trigger] = await within(dialog()).findAllByRole('button', { name });
  const card = await waitFor(async () => {
    if (!screen.queryByRole('tooltip')) {
      await user.unhover(trigger);
      await user.hover(trigger);
    }
    return screen.getByRole('tooltip');
  });
  const shown = {
    text: card.textContent ?? '',
    terms: [...card.querySelectorAll('dt')].map((dt) => dt.textContent),
  };
  await user.unhover(trigger);
  await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  return shown;
}






function withMixCost(costUsd: number): RebalanceView {
  const view = rebalanceViews.twoBorrows;
  return { ...view, plans: plansOf({ ...view.plans.even, routes: { ...view.plans.even.routes, mix: { ...view.plans.even.routes.mix!, costUsd } } }) };
}

function withLoopTime(seconds: number): RebalanceView {
  const view = rebalanceViews.twoBorrows;
  const loop = { ...view.plans.even.routes.mix!, seconds, costUsd: 3.41 };
  return { ...view, plans: plansOf({ ...view.plans.even, recommended: 'loop', routes: { ...view.plans.even.routes, loop } }) };
}


const resumeButton = () => within(dialog()).getByRole('button', { name: /^Resum/ });

const abandonButton = () => within(dialog()).getByRole('button', { name: 'Hold to abandon' });

describe('RebalanceModal plan state', () => {
  beforeEach(() => {
    vi.setSystemTime(REBALANCE_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens in a modal that holds the options and locks the page behind it', async () => {
    show(rebalanceViews.twoBorrows);
    const modal = dialog();
    expect(modal).toHaveAttribute('aria-modal', 'true');
    expect(document.body.style.overflow).toBe('hidden');
    expect(within(modal).getByRole('radiogroup', { name: 'Route' })).toBeInTheDocument();
    expect(holdButton()).toBeInTheDocument();
  });

  it('opens with every route listed, the recommended one selected with its time and fee in the row', async () => {
    show(rebalanceViews.twoBorrows);
    expect(within(routeGroup()).getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByRole('radio', { name: 'Spot loop, then Convert' })).toBeChecked();
    expect(within(pickedRow()).getByText('Recommended')).toBeInTheDocument();
    expect(pickedRow()).toHaveTextContent('about 2 min');
    expect(pickedRow()).toHaveTextContent('Fee $0.46');
  });

  it.each([
    [30, 'about 30s'],
    [900, 'about 15 min'],
    [62520, 'about 17 h 22 m'],
  ])('the picked route row carries the fee and the %i second estimate', (seconds, time) => {
    show(withLoopTime(seconds));
    expect(pickedRow()).toHaveTextContent('Fee $3.41');
    expect(pickedRow()).toHaveTextContent(time);
  });

  it('says the route once: no summary line above the hold', () => {
    show(withLoopTime(62520));
    expect(within(dialog()).queryByText(/^Spot loop · Fee/)).toBeNull();
  });

  it('clicking the selected route row opens every route', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.twoBorrows);
    await user.click(pickedRow());
    expect(within(routeGroup()).getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByRole('radio', { name: 'Spot loop, then Convert' })).toBeChecked();
  });

  it('opens every route inline in the same modal', async () => {
    show(rebalanceViews.twoBorrows);
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(within(dialog()).getByRole('radiogroup', { name: 'Route' })).toBeInTheDocument();
    expect(within(routeGroup()).getAllByRole('radio').map((radio) => radio.getAttribute('value') ?? radio.id)).toHaveLength(2);
    expect(screen.getByRole('radio', { name: 'Spot loop, then Convert' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Convert' })).toBeInTheDocument();
  });

  it('greys a hidden route and shows its reason in place of its time', async () => {
    show(rebalanceViews.hiddenRoute);
    const row = rowOf('Spot loop');
    expect(screen.getByRole('radio', { name: 'Spot loop' })).toBeDisabled();
    expect(row.textContent).toContain('Gate paused USDC transfers.');
    expect(row.textContent).not.toContain('about');
  });

  it('picking a route row keeps every route open and moves the selection, with no separate control', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.twoBorrows);
    expect(screen.queryByRole('button', { name: 'Keep the recommended one' })).toBeNull();
    await user.click(screen.getByRole('radio', { name: 'Convert' }));
    expect(within(routeGroup()).getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByRole('radio', { name: 'Convert' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Spot loop, then Convert' })).not.toBeChecked();
    expect(screen.queryByRole('button', { name: 'Show all routes' })).toBeNull();
    await user.click(screen.getByRole('radio', { name: 'Spot loop, then Convert' }));
    expect(within(routeGroup()).getAllByRole('radio')).toHaveLength(2);
    expect(pickedRow()).toHaveTextContent('Fee $0.46');
  });

  it('hides Show all routes when one route is on the wire, and its row opens nothing', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.oneRouteOnly);
    expect(screen.queryByRole('button', { name: 'Show all routes' })).toBeNull();
    expect(screen.getByRole('radio', { name: 'Convert' })).toBeChecked();
    expect(pickedRow()).toHaveTextContent('Instant');
    expect(pickedRow()).toHaveTextContent('Fee $0.02');
    await user.click(pickedRow());
    expect(within(routeGroup()).getAllByRole('radio')).toHaveLength(1);
  });

  it('shows one or two steps with no fold, over one hold to confirm button', async () => {
    show(rebalanceViews.twoBorrows);
    expect(innerItems()).toHaveLength(2);
    expect(moreSteps()).toBeNull();
    expect(screen.getAllByRole('button', { name: HOLD })).toHaveLength(1);
  });

  it('carries only what the decision needs, never Borrowing or Interest paid', async () => {
    show(rebalanceViews.twoBorrows, { account: accountBodies.ethTwoVenues, positions: positionsBodies.ethTwoVenues });
    await screen.findByText('Total cost');
    expect(screen.queryByText('Borrowing')).toBeNull();
    expect(screen.queryByText('Interest paid')).toBeNull();
    expect(screen.queryByText('Interest now')).toBeNull();
  });

  it('explains a round and why more than one in the step control hover', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.twoBorrows);
    expect((await hoverCard(user, 'Steps')).text).toBe(
      'A round is one trip through Gate spot, capped by your free margin. Gate locks $48.80 of initial margin for your borrow. Each round repays some borrow, so the next round is bigger.',
    );
  });

  it('replaces the hold with Refresh route when the picked route moves money differently', async () => {
    const plan = rebalanceViews.twoBorrows.plans.even;
    const mix = plan.routes.mix!;
    const elsewhere: RebalanceView = {
      ...rebalanceViews.twoBorrows,
      plans: plansOf({ ...plan, routes: { ...plan.routes, mix: { ...mix, steps: mix.steps.map((step) => ({ ...step, to: 'HYPERLIQUID' as const })) } } }),
    };
    const user = userEvent.setup();
    const { next } = showPolled([rebalanceViews.twoBorrows, elsewhere]);
    expect(holdButton()).toBeEnabled();
    await next();
    expect(screen.queryByRole('button', { name: HOLD })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Refresh route' }));
    expect(holdButton()).toBeEnabled();
  });

  it('replaces the hold with Refresh route when the plan went stale on a cost change', async () => {
    const user = userEvent.setup();
    const { next } = showPolled([rebalanceViews.twoBorrows, withMixCost(4.12)]);
    expect(pickedRow()).toHaveTextContent('Fee $0.46');
    expect(holdButton()).toBeEnabled();
    await next();
    expect(pickedRow()).toHaveTextContent('Fee $4.12');
    expect(screen.queryByRole('button', { name: HOLD })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Refresh route' }));
    expect(holdButton()).toBeEnabled();
  });

  it('keeps the hold, the picked route and the row order when a poll only re-ranks the routes', async () => {
    // A poll every few seconds re-ranked two close routes and swapped the
    // hold for Refresh route before the trader could pick.
    const view = rebalanceViews.twoBorrows;
    const { next } = showPolled([view, { ...view, plans: plansOf({ ...view.plans.even, recommended: 'convert' }) }]);
    const order = () => within(routeGroup()).getAllByRole('radio').map((r) => r.getAttribute('aria-labelledby') && document.getElementById(r.getAttribute('aria-labelledby')!)?.textContent);
    const before = order();
    const picked = screen.getAllByRole('radio').find((r) => (r as HTMLInputElement).checked);
    await next();
    expect(holdButton()).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Refresh route' })).toBeNull();
    expect(screen.getAllByRole('radio').find((r) => (r as HTMLInputElement).checked)).toBe(picked);
    expect(order()).toEqual(before);
  });

  it('a fee that rose inside the server band, under a dollar and 5%, keeps the hold live', async () => {
    const { next } = showPolled([rebalanceViews.twoBorrows, withMixCost(1.4)]);
    await next();
    expect(pickedRow()).toHaveTextContent('Fee $1.40');
    expect(holdButton()).toBeEnabled();
  });

  it('a fee that rose by more than a dollar is a new plan', async () => {
    const { next } = showPolled([rebalanceViews.twoBorrows, withMixCost(1.47)]);
    await next();
    expect(pickedRow()).toHaveTextContent('Fee $1.47');
    expect(screen.queryByRole('button', { name: HOLD })).toBeNull();
    expect(screen.getByRole('button', { name: 'Refresh route' })).toBeInTheDocument();
  });

  it('a fee that fell keeps the hold live', async () => {
    const { next } = showPolled([rebalanceViews.twoBorrows, withMixCost(0.1)]);
    await next();
    expect(pickedRow()).toHaveTextContent('Fee $0.10');
    expect(holdButton()).toBeEnabled();
  });

  it('a cost change under one cent keeps the hold live', async () => {
    const { next } = showPolled([rebalanceViews.twoBorrows, withMixCost(0.463)]);
    await next();
    expect(pickedRow()).toHaveTextContent('Fee $0.46');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(holdButton()).toBeEnabled();
  });

  it('hold waits for a moving transfer or a running deal', async () => {
    show(rebalanceViews.twoBorrows, { transfer: transferViews.moving });
    expect(await within(dialog()).findByText('Transfer running')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Hold to/ })).toBeNull();
    cleanup();

    show(rebalanceViews.twoBorrows, { transfer: transferViews.lockDeal });
    expect(await within(dialog()).findByText('Deal running')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Hold to/ })).toBeNull();
  });
});

describe('RebalanceModal run states', () => {
  beforeEach(() => {
    vi.setSystemTime(REBALANCE_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a move past its usual time reads Longer than usual, never about 0s', async () => {
    const running = rebalanceViews.accountARunning;
    show({ ...running, job: { ...running.job, createdAt: REBALANCE_NOW - 3 * 3_600_000 } });
    expect(facts()['Time left']).toBe('Longer than usual');
  });

  it('shows the running state: route, round, time left, progress, wallets and the money on the way', async () => {
    show(rebalanceViews.accountARunning);
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(facts()).toEqual({ Route: 'Spot loop', Round: '3 of 5', 'Time left': 'about 6 min' });
    expect(subs('Time left')).toEqual(['4m 58s passed']);
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Now' })).toBeNull();
    expect(dialog().textContent).toContain('Move 36.58 USDC to the CrossEx Hyperliquid wallet');
  });

  it('says the running job keeps going after the modal closes', async () => {
    const { onClose } = show(rebalanceViews.accountARunning);
    expect(
      within(dialog()).getByText('Started 4m 58s ago. You can close this. The move keeps going.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'close' })).not.toBeInTheDocument();
    expect(within(tabRadio('Move cash')).getByText('Running')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows a halted state: the reason, where the money is, then Resume and Abandon', async () => {
    show(rebalanceViews.accountAHalted);
    expect(screen.getByText('Stopped')).toBeInTheDocument();
    expect(screen.getByRole('alert').textContent).toBe(
      'Stopped in round 3 of 5.Gate paused transfers into the CrossEx Hyperliquid wallet.',
    );
    expect(screen.queryByRole('group', { name: 'Where your money is' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Resume' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Hold to abandon' })).toBeEnabled();
    expect(within(dialog()).getByText('Abandon leaves the 36.58 USDC in Gate spot.')).toBeInTheDocument();
  });

  it('says the key cannot read Spot and shows no zero for an unknown balance', async () => {
    show(rebalanceViews.accountAHalted, { transfer: transferViews.noSpot });
    expect(await screen.findByText('Set Spot Trading to Read Only to see Gate spot balances.')).toBeInTheDocument();
    const note = within(dialog()).getByText('Abandon leaves the 36.58 USDC in Gate spot. This key cannot read Gate spot.');
    expect(note).toBeInTheDocument();
    expect(dialog().textContent).not.toMatch(/\$0\.00/);
  });

  it('flips to the finished state while open, and does not close itself', async () => {
    const running = rebalanceViews.accountARunning.job;
    const done: RebalanceView = {
      ...rebalanceViews.accountARunning,
      job: {
        ...running,
        status: 'done',
        inTransit: null,
        steps: running.steps.map(
          (step): RebalanceStep =>
            step.status === 'done'
              ? step
              : { ...step, status: 'done', qty: step.arrives ?? step.planned, doneAt: running.updatedAt },
        ),
      },
    };
    const { onClose, next } = showPolled([rebalanceViews.accountARunning, done]);
    expect(screen.getByText('Running')).toBeInTheDocument();
    await next();
    expect(screen.getAllByText('Done')[0]).toBeInTheDocument();
    expect(facts()).toEqual({ Route: 'Spot loop', Moved: '$175.63', Took: '4m 18s', 'Total cost': '$0.26' });
    expect(screen.queryByRole('group', { name: 'Now' })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    // Close is the one way out once the run has finished under the dialog.
    await userEvent.setup().click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

const USDT_WAY = { from: 'HYPERLIQUID', to: 'CROSSEX' } as const;
const USDC_WAY = { from: 'CROSSEX', to: 'HYPERLIQUID' } as const;

const landedStep = (
  name: string,
  qty: number,
  round: number | null,
  way: Pick<RebalanceStep, 'from' | 'to'>,
): RebalanceStep => ({ ...rebalanceViews.accountADone.job.steps[1], ...way, name, qty, round, planned: qty });

const doneJob = (route: RouteName, amount: number, costUsd: number, steps: RebalanceStep[]): RebalanceJob => ({
  ...rebalanceViews.accountADone.job,
  route,
  amount,
  costUsd,
  steps,
  stepIndex: steps.length - 1,
});

const TOWARD_USDT_MIX = doneJob('mix', 1745.44, 3.5, [
  landedStep('From Hyperliquid', 744.44, 1, USDT_WAY),
  landedStep('To Gate', 744.44, 1, USDT_WAY),
  landedStep('Sell USDC', 700, 1, USDT_WAY),
  landedStep('Sell USDC', 44.44, 1, USDT_WAY),
  landedStep('Sell USDC', 120, null, USDT_WAY),
  landedStep('Convert', 998, null, USDT_WAY),
]);

const FULL_50 = doneJob('loop', 50, 0.1, [
  landedStep('Buy USDC', 50, 1, USDC_WAY),
  landedStep('To spot', 50, 1, USDC_WAY),
  landedStep('To Hyperliquid', 49.95, 1, USDC_WAY),
]);

const SHORT_50 = doneJob('loop', 50, 0.1, [
  landedStep('Buy USDC', 30.02, 1, USDC_WAY),
  landedStep('To spot', 30.02, 1, USDC_WAY),
  landedStep('To Hyperliquid', 29.97, 1, USDC_WAY),
  landedStep('Buy USDC', 0, 2, USDC_WAY),
  landedStep('To spot', 0, 2, USDC_WAY),
  landedStep('To Hyperliquid', 0, 2, USDC_WAY),
]);

const SHORT_6M = doneJob('loop', 6_000_000, 3_000, [
  landedStep('From Hyperliquid', 5_999_999, 1, USDT_WAY),
  landedStep('To Gate', 5_999_999, 1, USDT_WAY),
  landedStep('Sell USDC', 1_103_426.61, 1, USDT_WAY),
]);

const QUOTE_6M = doneJob('convert', 6_000_000, 12_000, [
  landedStep('Sell USDC', 250_000, null, USDC_WAY),
  ...Array.from({ length: 12 }, () => landedStep('Convert', 498_500, null, USDC_WAY)),
]);

const QUOTE_6M_FRACTIONS = doneJob('convert', 6_000_000, 12_000, [
  ...Array.from({ length: 12 }, () => landedStep('Convert', 498_500.009, null, USDC_WAY)),
]);

const HELD_SHORT_6M = doneJob('loop', 4_896_572.39, 1_000, [
  landedStep('From Hyperliquid', 4_896_572.39, 1, USDT_WAY),
  { ...landedStep('To Gate', 4_896_572.39, 1, USDT_WAY), cashBefore: 2_937_943.43 },
  landedStep('Sell USDC', 2_937_943.43, 1, USDT_WAY),
  landedStep('Sell USDC', 2_937_943.43, 1, USDT_WAY),
]);

const HELD_SHORT_50 = doneJob('loop', 50, 1.1, [
  landedStep('From Hyperliquid', 50, 1, USDT_WAY),
  { ...landedStep('To Gate', 50, 1, USDT_WAY), cashBefore: 30 },
  landedStep('Sell USDC', 60, 1, USDT_WAY),
]);

const HELD_FULL = doneJob('loop', 1245.44, 2.5, [
  landedStep('From Hyperliquid', 744.44, 1, USDT_WAY),
  { ...landedStep('To Gate', 744.44, 1, USDT_WAY), cashBefore: 120.5 },
  landedStep('Sell USDC', 700, 1, USDT_WAY),
  landedStep('Sell USDC', 164.94, 1, USDT_WAY),
  landedStep('From Hyperliquid', 499, 2, USDT_WAY),
  { ...landedStep('To Gate', 499, 2, USDT_WAY), cashBefore: 0 },
  landedStep('Sell USDC', 499, 2, USDT_WAY),
]);

const HELD_FULL_6M = doneJob('loop', 4_896_573.39, 1_500, [
  landedStep('From Hyperliquid', 4_896_572.39, 1, USDT_WAY),
  { ...landedStep('To Gate', 4_896_572.39, 1, USDT_WAY), cashBefore: 2_937_943.43 },
  landedStep('Sell USDC', 7_834_515.82, 1, USDT_WAY),
]);

const HELD_LEGACY_50 = doneJob('loop', 50, 1.1, [
  landedStep('From Hyperliquid', 50, 1, USDT_WAY),
  landedStep('To Gate', 50, 1, USDT_WAY),
  landedStep('Sell USDC', 60, 1, USDT_WAY),
]);

const SELL_ONLY = doneJob('loop', 50, 0.1, [landedStep('Sell USDC', 49.9, 1, USDT_WAY)]);

describe('RebalanceModal is it worth it', () => {
  it('no borrow keeps the outline hold with its plain label, never anyway', () => {
    show(rebalanceViews.accountB);
    const hold = screen.getByRole('button', { name: HOLD });
    expect(hold.className).toContain('bg-transparent');
    expect(screen.queryByText(/anyway/)).toBeNull();
  });
});

describe('RebalanceModal moved amount', () => {
  async function finish(job: RebalanceJob) {
    const view = rebalanceViews.accountADone;
    const { next } = showPolled([{ ...view, job: { ...job, status: 'running' } }, { ...view, job }]);
    await next();
  }

  it.each([
    ['a Convert after an inserted Sell', 'Done', '$175.58', rebalanceViews.accountADone.job],
    ['the balancedDone fixture', 'Done', '$477.24', rebalanceViews.balancedDone.job],
    ['the mixDone fixture', 'Done', '$10,839.23', rebalanceViews.mixDone.job],
    ['the lighterConvertDone fixture', 'Done', '$498.00', rebalanceViews.lighterConvertDone.job],
    ['a toward-USDT loop, then a Convert after an inserted Sell', 'Done', '$1,742.44', TOWARD_USDT_MIX],
    ['$50 that all landed', 'Done', '$49.95', FULL_50],
    ['$50 that moved 29.97', 'Done', '$29.97', SHORT_50],
    ['$6M with a round of 4,896,572.39 unsold', 'Done', '$1,103,426.61', SHORT_6M],
    ['$6M Convert in 12 chunks of 500,000, each quoted 0.3% under spot', 'Done', '$5,982,000.00', QUOTE_6M],
    ['$6M Convert in 12 chunks that each landed 498,500.009, added before rounding', 'Done', '$5,982,000.10', QUOTE_6M_FRACTIONS],
    ['the short Account A fixture', 'Done', '$105.56', rebalanceViews.accountADoneShort.job],
    ['$6M round that sold held cash and left 1,958,628.96', 'Done', '$2,937,943.43', HELD_SHORT_6M],
    ['$50 round that sold held cash and left 20', 'Done', '$30.00', HELD_SHORT_50],
    ['a toward-USDT loop whose Sells cover held cash', 'Done', '$1,243.44', HELD_FULL],
    ['$6M round whose Sells cover held cash', 'Done', '$4,896,572.39', HELD_FULL_6M],
    ['a 1.6.1 round with no held cash on record', 'Done', '$50.00', HELD_LEGACY_50],
    ['a round Sell with no To Gate', 'Done', '$49.90', SELL_ONLY],
  ])('%s: chip %s, Moved %s', async (_, chip, moved, job) => {
    await finish(job);
    // "Balanced" is the green chip, "Done" is not. The tone token is `grass`
    // (the house green) — the chip no longer spells it `emerald`.
    expect(screen.getAllByText(chip).length).toBeGreaterThan(0);
    expect(screen.queryByText('Balanced')).toBeNull();
    expect(facts().Moved).toBe(moved);
  });
});

describe('RebalanceModal money controls', () => {
  it('hold sends the picked route', async () => {
    const user = userEvent.setup();
    const sent = starts();
    show(rebalanceViews.exampleD, { holdMs: 50 });
    await user.click(screen.getByRole('radio', { name: 'Convert' }));
    expect(within(dialog()).getByText('Convert')).toBeInTheDocument();
    fireEvent.pointerDown(holdButton());
    await waitFor(() => expect(sent).toEqual([{ kind: 'move', goal: 'even', route: 'convert', costUsd: rebalanceViews.exampleD.plans.even.routes.convert.costUsd }]));
  });

  it('the hold sends the cost of the route on screen', async () => {
    const sent = starts();
    show(withMixCost(4.12), { holdMs: 50 });
    expect(pickedRow()).toHaveTextContent('Fee $4.12');
    fireEvent.pointerDown(holdButton());
    await waitFor(() => expect(sent).toEqual([{ kind: 'move', goal: 'even', route: 'mix', costUsd: 4.12 }]));
  });

  it('a plan-changed refusal swaps the hold for Refresh route, so it cannot be sent twice', async () => {
    const sent = refuseStart(409, PLAN_CHANGED_ERROR);
    show(rebalanceViews.twoBorrows, { holdMs: 50 });
    fireEvent.pointerDown(holdButton());
    // The refusal makes the quote stale, which now swaps the hold out for
    // Refresh route — so a second submit is impossible, rather than merely
    // disabled. The guard itself (setAccepted(null)) is unchanged.
    expect(await screen.findByRole('button', { name: 'Refresh route' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: HOLD })).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(sent).toHaveLength(1);
  });

  it('after a plan-changed refusal, the new plan loads and Refresh route holds at its cost', async () => {
    const user = userEvent.setup();
    const shownCost = rebalanceViews.twoBorrows.plans.even.routes.mix!.costUsd;
    const sent: StartBody[] = [];
    let refused = false;
    serve({});
    server.use(
      http.get('/api/rebalance', () => HttpResponse.json(env(refused ? withMixCost(4.12) : rebalanceViews.twoBorrows))),
      http.post('/api/rebalance', async ({ request }) => {
        sent.push((await request.json()) as StartBody);
        if (refused) return HttpResponse.json(env({ id: rebalanceViews.accountADone.job.id }));
        refused = true;
        return HttpResponse.json({ ok: false, error: PLAN_CHANGED_ERROR }, { status: 409 });
      }),
    );
    renderWithClient(<Live holdMs={50} />);
    const group = await within(await screen.findByRole('dialog')).findByRole('radiogroup', { name: 'Route' });
    expect(within(group).getByRole('radio', { checked: true })).toBeInTheDocument();
    expect(pickedRow()).toHaveTextContent('Fee $0.46');
    fireEvent.pointerDown(holdButton());
    await waitFor(() => expect(pickedRow()).toHaveTextContent('Fee $4.12'));
    expect(screen.queryByRole('button', { name: HOLD })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Refresh route' }));
    expect(screen.queryByRole('button', { name: 'Refresh route' })).toBeNull();
    expect(holdButton()).toBeEnabled();
    fireEvent.pointerDown(holdButton());
    await waitFor(() =>
      expect(sent).toEqual([
        { kind: 'move', goal: 'even', route: 'mix', costUsd: shownCost },
        { kind: 'move', goal: 'even', route: 'mix', costUsd: 4.12 },
      ]),
    );
  });

  it('any other refusal shows its message and no plan-changed state', async () => {
    refuseStart(409, { category: 'validation', message: 'Rebalance waits until the transfer ends.', retryable: true });
    show(rebalanceViews.twoBorrows, { holdMs: 50 });
    fireEvent.pointerDown(holdButton());
    expect((await screen.findByRole('alert')).textContent).toBe('Rebalance waits until the transfer ends.');
    expect(screen.queryByRole('button', { name: 'Use the new plan' })).toBeNull();
    expect(screen.queryByText(PLAN_CHANGED_TEXT)).toBeNull();
    await waitFor(() => expect(holdButton()).toBeEnabled());
  });

  it('clicking a blocked row picks nothing', async () => {
    const user = userEvent.setup();
    const sent = starts();
    show(rebalanceViews.accountABlocked, { holdMs: 50 });
    await user.click(within(rowOf('Spot loop')).getByText('Spot loop'));
    expect(screen.getByRole('radio', { name: 'Spot loop' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: 'Convert' })).toBeChecked();
    fireEvent.pointerDown(holdButton());
    await waitFor(() => expect(sent).toEqual([{ kind: 'move', goal: 'even', route: 'convert', costUsd: rebalanceViews.accountABlocked.plans.even.routes.convert.costUsd }]));
  });

  it('blocked row is disabled and shows its reason', async () => {
    show(rebalanceViews.accountABlocked);
    expect(screen.getByRole('radio', { name: 'Spot loop' })).toBeDisabled();
    expect(rowOf('Spot loop')).toHaveTextContent('Gate paused USDC transfers.');
    expect(rowOf('Spot loop')).not.toHaveTextContent('5 rounds');
  });

  it('next run opens on recommended', async () => {
    const user = userEvent.setup();
    const sent = starts();
    const { next } = showPolled([rebalanceViews.accountA, rebalanceViews.accountADone], { holdMs: 50 });
    await user.click(screen.getByRole('radio', { name: 'Convert' }));
    fireEvent.pointerDown(holdButton());
    await waitFor(() => expect(sent).toEqual([{ kind: 'move', goal: 'even', route: 'convert', costUsd: rebalanceViews.accountA.plans.even.routes.convert.costUsd }]));
    await next();
    expect((await screen.findAllByText('Done'))[0]).toBeInTheDocument();
    expect(facts().Route).toBe('Convert');
    cleanup();

    show(rebalanceViews.accountA);
    expect(within(routeGroup()).getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByRole('radio', { name: 'Spot loop' })).toBeChecked();
    expect(within(dialog()).getByText('Recommended')).toBeInTheDocument();
  });

  it('refused hold shows the server message', async () => {
    refuseStart(409, { category: 'validation', message: 'Already even.', retryable: false });
    show(rebalanceViews.accountA, { holdMs: 50 });
    fireEvent.pointerDown(holdButton());
    expect((await screen.findByRole('alert')).textContent).toBe('Already even.');
    expect(within(dialog()).getByText('Spot loop')).toBeInTheDocument();
    await waitFor(() => expect(holdButton()).toBeEnabled());
  });

  it("a start error toast carries Gate's hint", async () => {
    refuseStart(401, {
      category: 'auth',
      message: 'Gate refused the API key.',
      hint: 'Check it in Settings.',
      retryable: false,
    });
    show(rebalanceViews.accountA, { holdMs: 50 });
    fireEvent.pointerDown(holdButton());
    expect((await screen.findByRole('alert')).textContent).toBe('Gate refused the API key. Check it in Settings.');
  });
});

describe('RebalanceModal stopped controls', () => {
  beforeEach(() => {
    vi.setSystemTime(REBALANCE_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('no stop while running', async () => {
    show(rebalanceViews.accountARunning);
    expect(facts().Round).toBe('3 of 5');
    expect(within(dialog()).queryByRole('button', { name: /^(Stop|Cancel|Abandon|Resume)$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: HOLD })).toBeNull();
  });

  it('halted buttons', async () => {
    show(rebalanceViews.accountAHalted);
    const resume = within(dialog()).getAllByRole('button', { name: 'Resume' });
    const abandon = within(dialog()).getAllByRole('button', { name: 'Hold to abandon' });
    expect(resume.map((el) => el.tagName)).toEqual(['BUTTON']);
    expect(abandon.map((el) => el.tagName)).toEqual(['BUTTON']);
    expect(screen.queryByRole('button', { name: HOLD })).toBeNull();
  });

  it('clicking the Resume text sends resume', async () => {
    const user = userEvent.setup();
    const sent = commands();
    show(rebalanceViews.accountAHalted);
    await user.click(within(resumeButton()).getByText('Resume'));
    await waitFor(() => expect(sent).toEqual([`resume ${HALTED_ID}`]));
  });

  it('resume reads Resuming while it runs', async () => {
    const user = userEvent.setup();
    const { answer, answered } = held();
    commands(answered);
    show(rebalanceViews.accountAHalted);
    const resume = resumeButton();
    await user.click(resume);
    await waitFor(() => expect(resume).toHaveAccessibleName('Resuming'));
    expect(resume.textContent).toBe('Resuming');
    answer();
    await waitFor(() => expect(resume).toHaveAccessibleName('Resume'));
  });

  it('buttons off while a command is pending', async () => {
    const user = userEvent.setup();
    const { answer, answered } = held();
    const sent = commands(answered);
    show(rebalanceViews.accountAHalted);
    const resume = resumeButton();
    const abandon = abandonButton();
    await user.click(resume);
    await waitFor(() => expect(resume).toBeDisabled());
    expect(abandon).toBeDisabled();
    await waitFor(() => expect(sent).toEqual([`resume ${HALTED_ID}`]));
    await user.click(abandon);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sent).toEqual([`resume ${HALTED_ID}`]);
    answer();
    await waitFor(() => expect(resume).toBeEnabled());
    expect(abandon).toBeEnabled();
  });

  it('halted buttons press from the keyboard', async () => {
    const user = userEvent.setup();
    const sent = commands();
    show(rebalanceViews.accountAHalted);
    for (const name of ['Resume']) {
      const button = within(dialog()).getByRole('button', { name });
      await waitFor(() => expect(button).toBeEnabled());
      button.focus();
      await user.keyboard('{Enter}');
      await waitFor(() => expect(sent).toContain(`${name.toLowerCase()} ${HALTED_ID}`));
    }
  });

});

describe('RebalanceModal where the money is', () => {
  beforeEach(() => {
    vi.setSystemTime(REBALANCE_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('halted with the money inside CrossEx', async () => {
    show(rebalanceViews.haltedInside);
    expect(screen.getByRole('alert').textContent).toBe(
      'Stopped in round 3 of 5.The app restarted during the run. Nothing failed. Press Resume.',
    );
    expect(screen.queryByRole('group', { name: 'Where your money is' })).toBeNull();
    expect(within(dialog()).getByText('End the rebalance for good. Funds stay where they are.')).toBeInTheDocument();
  });

  it('halted toward USDT on the way', async () => {
    const running = rebalanceViews.exampleERunning;
    show({
      ...running,
      job: {
        ...running.job,
        status: 'halted',
        haltReason: 'The app restarted during the run. Nothing failed. Press Resume.',
        inTransit: { coin: 'USDC', qty: 745.44, at: 'MOVING' },
      },
    });
    expect(within(dialog()).getByText('Abandon leaves 745.44 USDC in transit. It is not margin until it lands.')).toBeInTheDocument();
  });

  it('after abandon line', async () => {
    const user = userEvent.setup();
    const { onTransfer } = show(rebalanceViews.accountAAbandoned, { transfer: transferViews.noSpot });
    await waitFor(() => expect(line('The last rebalance left 36.58 USDC in Gate spot.')).toBeInTheDocument());
    await user.click(within(dialog()).getByRole('button', { name: 'Transfer' }));
    expect(onTransfer).toHaveBeenCalledWith('USDC', 'CROSSEX_HYPERLIQUID');
  });

  it('abandoned with money moving to Gate spot keeps the leftover line', async () => {
    const user = userEvent.setup();
    const running = rebalanceViews.exampleERunning;
    const moving = { coin: 'USDC', qty: 745.44, at: 'MOVING' } as const;
    const { onTransfer } = show(
      { ...running, job: { ...running.job, status: 'abandoned', inTransit: moving } },
      { transfer: transferViews.noSpot },
    );
    await waitFor(() => expect(line('The last rebalance left 745.44 USDC in Gate spot.')).toBeInTheDocument());
    await user.click(within(dialog()).getByRole('button', { name: 'Transfer' }));
    expect(onTransfer).toHaveBeenCalledWith('USDC', 'CROSSEX_GATE');
    cleanup();

    const intoCrossex = rebalanceViews.exampleEAbandoned;
    serve({ transfer: transferViews.noSpot });
    renderWithClient(
      <>
        <RebalanceModal
          view={{ ...intoCrossex, job: { ...intoCrossex.job, inTransit: { ...moving, qty: 744.44 } } }}
          onClose={vi.fn()}
        />
        <Loaded />
      </>,
    );
    await screen.findByText('reads loaded');
    expect(intoCrossex.job.steps[intoCrossex.job.stepIndex].name).toBe('To Gate');
    expect(screen.queryByText(/The last rebalance left/)).toBeNull();
  });

  it('money a stopped move to Lighter left in Gate spot goes to the Lighter wallet', async () => {
    const user = userEvent.setup();
    const { onTransfer } = show(rebalanceViews.lighterAcrossAbandoned, { transfer: transferViews.noSpot });
    await waitFor(() => expect(line('The last rebalance left 499.00 USDC in Gate spot.')).toBeInTheDocument());
    await user.click(within(dialog()).getByRole('button', { name: 'Transfer' }));
    expect(onTransfer).toHaveBeenCalledWith('USDC', 'CROSSEX_LIGHTER');
  });

  it('a two-half Convert that stopped, then finished, reads as one Convert', async () => {
    const done = rebalanceViews.lighterConvertDone;
    const halted: RebalanceView = {
      ...rebalanceViews.lighterAcross,
      job: {
        ...done.job,
        status: 'halted',
        stepIndex: 1,
        haltReason: 'Convert quote was more than 0.3% under the Gate spot price.',
        steps: [done.job.steps[0], { ...done.job.steps[1], qty: null, status: 'pending', startedAt: null, doneAt: null }],
      },
    };
    const { next } = showPolled([halted, done]);
    expect(screen.getByRole('alert').textContent).toBe('Stopped at Convert.Convert quote was more than 0.3% under the Gate spot price.');
    await next();
    expect(screen.getAllByText('Done')[0]).toBeInTheDocument();
    expect(facts()).toEqual({ Route: 'Convert', Moved: '$498.00', Took: '2s', 'Total cost': '$2.00' });
    const rows = within(dialog()).getAllByRole('listitem');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain(
      'Convert 500.00 USDC from the CrossEx Hyperliquid wallet to the CrossEx Lighter wallet',
    );
  });
});

describe('RebalanceModal route and step content', () => {
  beforeEach(() => {
    vi.setSystemTime(REBALANCE_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('D lists its route rows, recommended first', async () => {
    show(rebalanceViews.exampleD);
    expect(routeNames()).toEqual(['Spot loop, then Convert', 'Convert']);
  });

  it('D recommended is picked', async () => {
    show(rebalanceViews.exampleD);
    expect(within(dialog()).getByText('Spot loop, then Convert')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Spot loop, then Convert' })).toBeChecked();
  });

  it('D tag on mix only', async () => {
    show(rebalanceViews.exampleD);
    const tags = within(dialog()).getAllByText('Recommended');
    expect(tags).toHaveLength(1);
    expect(rowOf('Spot loop, then Convert')).toContainElement(tags[0]);
  });

  it('A two route rows', async () => {
    show(rebalanceViews.accountA);
    expect(routeNames()).toEqual(['Spot loop', 'Convert']);
  });

  it('A tag on spot loop', async () => {
    show(rebalanceViews.accountA);
    const tags = within(dialog()).getAllByText('Recommended');
    expect(tags).toHaveLength(1);
    expect(rowOf('Spot loop')).toContainElement(tags[0]);
  });

  it('D mix row text', async () => {
    show(rebalanceViews.exampleD);
    expect(rowOf('Spot loop, then Convert')).toHaveTextContent('about 13 min');
    expect(rowOf('Spot loop, then Convert').textContent).not.toMatch(/\d+ rounds?/);
    expect(rowOf('Spot loop, then Convert')).toHaveTextContent('$15.68');
  });

  it('E mix row text', async () => {
    show(rebalanceViews.exampleE);
    expect(rowOf('Spot loop, then Convert')).toHaveTextContent('about 6.5 min');
    expect(rowOf('Spot loop, then Convert')).toHaveTextContent('$2.04');
  });

  it('clicking anywhere in a route row picks it and keeps every route open', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.exampleD);
    await user.click(within(rowOf('Convert')).getByText('Convert'));
    expect(screen.getByRole('radio', { name: 'Convert' })).toBeChecked();
    expect(within(routeGroup()).getAllByRole('radio')).toHaveLength(2);
    await user.click(within(rowOf('Spot loop, then Convert')).getByText('Recommended'));
    expect(screen.getByRole('radio', { name: 'Spot loop, then Convert' })).toBeChecked();
    await user.click(within(rowOf('Convert')).getByText('Instant'));
    expect(screen.getByRole('radio', { name: 'Convert' })).toBeChecked();
    await user.click(within(rowOf('Spot loop, then Convert')).getByText('about 13 min'));
    expect(screen.getByRole('radio', { name: 'Spot loop, then Convert' })).toBeChecked();
    expect(within(routeGroup()).getAllByRole('radio')).toHaveLength(2);
  });

  it('three or more steps fold behind Show all steps, which opens all five and Hide steps folds again', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.accountA);
    expect(within(dialog()).queryAllByRole('listitem')).toHaveLength(0);
    expect(moreSteps()).toBeInTheDocument();
    expect(await openSteps(user)).toHaveLength(5);
    await user.click(screen.getByRole('button', { name: 'Hide steps' }));
    expect(within(dialog()).queryAllByRole('listitem')).toHaveLength(0);
  });

  it('round 4 text', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.accountA);
    const row = (await openSteps(user))[3];
    expect(within(row).getByText('Buy 23.77 USDC, move 44.71 USDC to the CrossEx Hyperliquid wallet')).toBeInTheDocument();
  });

  it('a planned step row carries no arrives or borrow line', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.accountA);
    await openSteps(user);
    expect(within(dialog()).queryByText(/arrives|borrow left|borrow paid/)).toBeNull();
  });

  it('a done job row carries no arrives line', async () => {
    const user = userEvent.setup();
    const job = rebalanceViews.balancedDone.job;
    const running: RebalanceView = {
      ...rebalanceViews.accountB,
      job: {
        ...job,
        status: 'running',
        steps: job.steps.map((step, index): RebalanceStep => {
          if (index === 2) return { ...step, qty: null, status: 'running', doneAt: null };
          return step;
        }),
      },
    };
    const { next } = showPolled([running, { ...rebalanceViews.accountB, job }]);
    await next();
    expect(screen.getAllByText('Done')[0]).toBeInTheDocument();
    const [row] = await openSteps(user);
    expect(within(row).queryByText(/arrives/)).toBeNull();
  });

  it('running mix at the Convert row', async () => {
    const user = userEvent.setup();
    const job = rebalanceViews.exampleDRunningConvert.job;
    show({
      ...rebalanceViews.exampleDRunningConvert,
      job: {
        ...job,
        stepIndex: 17,
        steps: job.steps.map((step, index): RebalanceStep => {
          if (index === 17) return { ...step, qty: null, status: 'running', doneAt: null };
          if (index === 18) return { ...step, status: 'pending', startedAt: null };
          return step;
        }),
      },
    });
    let rows = await openSteps(user);
    expect(rows).toHaveLength(7);
    expect(within(rows[6]).getByText('Instant')).toBeInTheDocument();
    expect(facts().Round).toBe('6 of 6');
    cleanup();

    show(rebalanceViews.exampleDRunningConvert);
    expect(facts().Route).toBe('Spot loop, then Convert');
    expect(facts()).not.toHaveProperty('Round');
    rows = await openSteps(user);
    expect(rows[6]).toHaveAttribute('aria-current', 'step');
    expect(within(rows[6]).getByText('Convert 7,521.59 USDT to USDC in the CrossEx Hyperliquid wallet')).toBeInTheDocument();
  });

  it('running round shows its leg', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.accountARunning);
    const rows = await openSteps(user);
    expect(within(rows[2]).getByText('Gate spot to the CrossEx Hyperliquid wallet')).toBeInTheDocument();
    expect(within(rows[3]).queryByText(/arrives/)).toBeNull();
  });

  it('each step names the wallet it moves to', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.lighterSplit);
    await openSteps(user);
    expect(stepTexts()).toEqual([
      ['1', 'Buy 249.83 USDC, move it to the CrossEx Hyperliquid wallet', 'about 2 min'],
      ['2', 'Convert 250.29 USDT to USDC in the CrossEx Lighter wallet', 'Instant'],
    ]);
    await user.click(screen.getByRole('radio', { name: 'Spot loop' }));
    expect(stepTexts()).toEqual([
      ['1', 'Buy 249.63 USDC, move it to the CrossEx Hyperliquid wallet', 'about 2 min'],
      ['2', 'Buy 250.61 USDC, move it to the CrossEx Lighter wallet', 'about 4 min'],
    ]);
  });

  it('a running move from Hyperliquid to Lighter shows one round with its leg and time', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.lighterAcrossRunning);
    expect(facts()).toMatchObject({ Route: 'Spot loop', Round: '1 of 1' });
    expect(subs('Time left')).toEqual(['6m 40s passed']);
    await openSteps(user);
    expect(stepTexts()).toEqual([
      [
        'Move 500.00 USDC from the CrossEx Hyperliquid wallet to the CrossEx Lighter wallet',
        'Gate spot to the CrossEx Lighter wallet',
        '6m 40s of about 10 min',
      ],
    ]);
  });
});

describe('RebalanceModal hovers and facts', () => {
  it('lists the recommended route first, then the rest by cost, with no rounds text', async () => {
    const view = rebalanceViews.accountA;
    show({ ...view, plans: plansOf({ ...view.plans.even, recommended: 'convert' }) });
    expect(routeNames()).toEqual(['Convert', 'Spot loop']);
    expect(dialog().textContent).not.toMatch(/\d+ rounds?/);
  });

  it('ranks the rows below Recommended by fee plus time, as the recommendation does', async () => {
    // Loop $20 over 4 h scores about $74 against Convert's $40 instant: by fee
    // alone Loop sits above Convert, by fee plus time it sits below.
    const view = rebalanceViews.twoBorrows;
    const routes = view.plans.even.routes;
    const mix = { ...routes.mix!, costUsd: 5, seconds: 600 };
    const loop = { ...routes.mix!, costUsd: 20, seconds: 4 * 3600 };
    const convert = { ...routes.convert!, costUsd: 40, seconds: 0 };
    show({ ...view, plans: plansOf({ ...view.plans.even, recommended: 'mix', routes: { mix, loop, convert } }) });
    expect(routeNames().slice(1)).toEqual(['Convert', 'Spot loop']);
  });

  it('the step control names the margin the borrow holds', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.exampleD);
    expect((await hoverCard(user, 'Steps')).text).toContain('Gate locks $1,922.48 of initial margin for your borrow.');
  });

  it('recommended hover', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.exampleD);
    expect((await hoverCard(user, 'Recommended')).text).toBe('Best balance of fee and time: a longer route has to save more, and each extra hour counts for more than the last.');
    expect((await hoverCard(user, 'Recommended')).text).toBe('Best balance of fee and time: a longer route has to save more, and each extra hour counts for more than the last.');
  });

  it('blocked reason has no hover', async () => {
    show(rebalanceViews.accountABlocked);
    const reason = within(dialog()).getByText('Gate paused USDC transfers.');
    expect(reason.closest('[role="button"]')).toBeNull();
    expect(reason.closest('.border-dotted')).toBeNull();
  });

  it('every term in the modal has its hover', async () => {
    const user = userEvent.setup();
    const check = async (terms: [string, string][]) => {
      for (const [name, text] of terms) expect((await hoverCard(user, name)).text).toContain(text);
    };

    show(rebalanceViews.accountA, { transfer: transferViews.accountB });
    await within(dialog()).findByRole('button', { name: 'Transfer' });
    await check([
      ['Recommended', 'Best balance of fee and time: a longer route has to save more, and each extra hour counts for more than the last.'],
      ['Gate spot', 'Not margin.'],
    ]);
    await check([
      [
        'Spot loop',
        'Buy USDC in CrossEx, move it through Gate spot into the CrossEx Hyperliquid wallet. Gate has no direct transfer between CrossEx wallets. Repeats in rounds.',
      ],
      ['Convert', 'Instant swap between your CrossEx USDT and USDC wallets. 0.2% fee.'],
    ]);
    cleanup();

    show(rebalanceViews.exampleD);
    await check([
      ['Spot loop, then Convert', 'Spot loop for up to 6 rounds, then Convert the rest.'],
    ]);
  }, 60_000);

  it('hovers for a move into two wallets', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.lighterSplit);
    expect((await hoverCard(user, 'Spot loop')).text).toBe(
      'Buy USDC in CrossEx, move it through Gate spot into the CrossEx Hyperliquid wallet and the CrossEx Lighter wallet. Gate has no direct transfer between CrossEx wallets. Repeats in rounds.',
    );
  });

  it('hovers for a move from Hyperliquid to Lighter', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.lighterAcross);
    expect((await hoverCard(user, 'Spot loop')).text).toBe(
      'Move USDC from the CrossEx Hyperliquid wallet through Gate spot into the CrossEx Lighter wallet. Gate has no direct transfer between CrossEx wallets. Repeats in rounds.',
    );
    expect((await hoverCard(user, 'Convert')).text).toBe(
      'Instant swap between your CrossEx USDT and USDC wallets. 0.2% fee. USDC between Hyperliquid and Lighter swaps twice, through USDT.',
    );
  });










});

describe('RebalanceModal Gate spot lines', () => {
  it('one spot line per coin', async () => {
    const user = userEvent.setup();
    const { onTransfer } = show(rebalanceViews.accountB, { transfer: transferViews.spotBoth });
    await waitFor(() => expect(within(dialog()).getAllByRole('button', { name: 'Transfer' })).toHaveLength(2));
    const lines = [...dialog().querySelectorAll('p')]
      .map((p) => p.textContent)
      .filter((text) => text?.startsWith('Gate spot has'));
    expect(lines).toEqual([
      'Gate spot has 318.42 USDT. Move it in to use it.',
      'Gate spot has 25.00 USDC. Move it in to use it.',
    ]);
    await user.click(within(dialog()).getAllByRole('button', { name: 'Transfer' })[1]);
    expect(onTransfer).toHaveBeenCalledWith('USDC', 'CROSSEX_HYPERLIQUID');
  });

  it('spot money line', async () => {
    const user = userEvent.setup();
    const { onTransfer } = show(rebalanceViews.accountB, { transfer: transferViews.accountB });
    await waitFor(() => expect(line('Gate spot has 318.42 USDT. Move it in to use it.')).toBeInTheDocument());
    await user.click(within(dialog()).getByRole('button', { name: 'Transfer' }));
    expect(onTransfer).toHaveBeenCalledWith('USDT', 'CROSSEX');
  });

  it('the spot money line sits above the pinned hold, so nothing scrolls under it', async () => {
    show(rebalanceViews.accountB, { transfer: transferViews.accountB });
    await waitFor(() => expect(line('Gate spot has 318.42 USDT. Move it in to use it.')).toBeInTheDocument());
    const spot = line('Gate spot has 318.42 USDT. Move it in to use it.') as HTMLElement;
    const hold = within(dialog()).getByRole('button', { name: /^Hold to/ });
    expect(spot.compareDocumentPosition(hold) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('no spot line under 1', async () => {
    serve({ transfer: transferViews.spotDust });
    renderWithClient(
      <>
        <RebalanceModal view={rebalanceViews.accountB} onClose={vi.fn()} />
        <Loaded />
      </>,
    );
    await screen.findByText('reads loaded');
    expect(within(dialog()).queryByRole('button', { name: 'Transfer' })).toBeNull();
    expect(within(dialog()).queryByText(/Gate spot has/)).toBeNull();
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

describe('RebalanceModal presets and custom amount', () => {
  const presets = () => within(dialog()).getByRole('radiogroup', { name: 'Preset' });

  it('opens on Clear debt when the card leads with it, with Balance positions off and every label worded for it', () => {
    show(NO_LEGS_BORROW);
    expect(within(presets()).getByRole('radio', { name: /^Clear debt/ })).toBeChecked();
    const even = within(presets()).getByRole('radio', { name: 'Balance positions' });
    expect(even).toBeDisabled();
    expect(even).toHaveAttribute('title', 'No open positions');
    expect(screen.getByRole('button', { name: 'Hold to move' })).toBeInTheDocument();
    expect(within(dialog()).queryByText('Position share')).toBeNull();
  });

  it('stuck by margin with legs: the dialog names the cause the card names, never a short wallet', () => {
    // The even split is off and nothing moves, but the wallets are not
    // short: what would move is margin for open positions. The card says
    // so; the preset hover and the body must not say "$203.64 more than the
    // wallet holds." (audit 2026-09-24).
    show({
      ...rebalanceViews.balancedNoJob,
      plans: plansOf({ ...rebalanceViews.balancedNoJob.plans.even, shortOfEven: 203.64 }),
    });
    const even = within(presets()).getByRole('radio', { name: 'Balance positions' });
    expect(even).toBeDisabled();
    expect(even).toHaveAttribute('title', 'Equity unbalanced but no available cash to move.');
    expect(within(dialog()).queryByText(/more than the wallet holds/)).toBeNull();
    expect(within(dialog()).queryByText(/\$203\.64/)).toBeNull();
  });

  it('with legs, opens on Balance positions', () => {
    show(rebalanceViews.twoBorrows);
    expect(within(presets()).getByRole('radio', { name: 'Balance positions' })).toBeChecked();
    expect(within(presets()).getByRole('radio', { name: /^Clear debt/ })).toBeDisabled();
    expect(holdButton()).toBeInTheDocument();
  });

  it('Custom amount turns the line into fields seeded from the preset, prices the move, and the hold sends it', async () => {
    const user = userEvent.setup();
    const view = NO_LEGS_BORROW;
    const custom = { ...view.plans.repay, goal: { kind: 'custom' as const, from: 'HYPERLIQUID' as const, to: 'CROSSEX' as const, amount: 50 } };
    server.use(
      http.get('/api/rebalance', ({ request }) => {
        const url = new URL(request.url);
        return HttpResponse.json(env(url.searchParams.get('from') ? { ...view, plans: { ...view.plans, custom } } : view));
      }),
    );
    const sent = starts();
    show(view, { holdMs: 50 });
    await user.click(screen.getByRole('radio', { name: 'Custom amount' }));
    expect(within(presets()).getByRole('radio', { checked: true })).toHaveAccessibleName('Custom amount');
    expect(screen.getByRole('textbox', { name: 'Amount' })).toHaveValue('22.18');
    expect(screen.getByRole('button', { name: 'From' })).toHaveTextContent('USDC · Hyperliquid');
    expect(screen.getByRole('button', { name: 'To' })).toHaveTextContent('USDT · CrossEx');
    await user.clear(screen.getByRole('textbox', { name: 'Amount' }));
    await user.type(screen.getByRole('textbox', { name: 'Amount' }), '50');
    const hold = await screen.findByRole('button', { name: /^Hold to move/ }, { timeout: 3000 });
    expect(within(dialog()).queryByText('Position share')).toBeNull();
    fireEvent.pointerDown(hold);
    await waitFor(() =>
      expect(sent).toEqual([{ kind: 'move', goal: 'custom', route: 'convert', costUsd: 0.04, from: 'HYPERLIQUID', to: 'CROSSEX', amount: 50 }]),
    );
  });

  it('a second edit takes its own quote: the hold waits while it is priced, then returns, never Refresh route', async () => {
    const user = userEvent.setup();
    const view = NO_LEGS_BORROW;
    // Echo the amount asked for, so each edit brings back a different quote.
    server.use(
      http.get('/api/rebalance', ({ request }) => {
        const amount = Number(new URL(request.url).searchParams.get('amount'));
        if (!amount) return HttpResponse.json(env(view));
        const custom = { ...view.plans.repay, goal: { kind: 'custom' as const, from: 'HYPERLIQUID' as const, to: 'CROSSEX' as const, amount } };
        return HttpResponse.json(env({ ...view, plans: { ...view.plans, custom } }));
      }),
    );
    const sent = starts();
    show(view, { holdMs: 50 });
    await user.click(screen.getByRole('radio', { name: 'Custom amount' }));
    await user.clear(screen.getByRole('textbox', { name: 'Amount' }));
    await user.type(screen.getByRole('textbox', { name: 'Amount' }), '50');
    await waitFor(() => expect(screen.getByRole('button', { name: /^Hold to move/ })).toBeEnabled(), { timeout: 3000 });
    await user.clear(screen.getByRole('textbox', { name: 'Amount' }));
    await user.type(screen.getByRole('textbox', { name: 'Amount' }), '60');
    // The last quote stays on screen, but it was priced for 50: the hold
    // waits rather than send it, and says why.
    expect(screen.getByRole('button', { name: 'Pricing the move.' })).toBeDisabled();
    await waitFor(() => expect(screen.getByRole('button', { name: /^Hold to move/ })).toBeEnabled(), { timeout: 3000 });
    expect(screen.queryByRole('button', { name: 'Refresh route' })).toBeNull();
    expect(screen.queryByText('Pricing the move.')).toBeNull();
    fireEvent.pointerDown(screen.getByRole('button', { name: /^Hold to move/ }));
    await waitFor(() => expect(sent).toEqual([expect.objectContaining({ goal: 'custom', amount: 60 })]));
  });

  it('a custom quote that moves under the dialog while it polls still asks for Refresh route', async () => {
    const user = userEvent.setup();
    const view = NO_LEGS_BORROW;
    let costUsd = 0.04;
    server.use(
      http.get('/api/rebalance', ({ request }) => {
        const amount = Number(new URL(request.url).searchParams.get('amount'));
        if (!amount) return HttpResponse.json(env(view));
        const repay = view.plans.repay;
        const custom = {
          ...repay,
          goal: { kind: 'custom' as const, from: 'HYPERLIQUID' as const, to: 'CROSSEX' as const, amount },
          routes: { ...repay.routes, convert: { ...repay.routes.convert, costUsd } },
        };
        return HttpResponse.json(env({ ...view, plans: { ...view.plans, custom } }));
      }),
    );
    show(view, { holdMs: 50 });
    await user.click(screen.getByRole('radio', { name: 'Custom amount' }));
    await user.clear(screen.getByRole('textbox', { name: 'Amount' }));
    await user.type(screen.getByRole('textbox', { name: 'Amount' }), '50');
    await waitFor(() => expect(screen.getByRole('button', { name: /^Hold to move/ })).toBeEnabled(), { timeout: 3000 });
    costUsd = 9;
    // Quotes poll every 10 s.
    expect(await screen.findByRole('button', { name: 'Refresh route' }, { timeout: 12_000 })).toBeInTheDocument();
  }, 20_000);

  it('an empty custom amount asks for one, and Use a preset goes back', async () => {
    const user = userEvent.setup();
    show(NO_LEGS_BORROW);
    await user.click(screen.getByRole('radio', { name: 'Custom amount' }));
    await user.clear(screen.getByRole('textbox', { name: 'Amount' }));
    expect(await screen.findByText('Type an amount to move.', {}, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Hold to/ })).toBeNull();
    await user.click(screen.getByRole('radio', { name: /^Clear debt/ }));
    expect(within(presets()).getByRole('radio', { name: /^Clear debt/ })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Hold to move' })).toBeInTheDocument();
  });

  it('a running or finished job names its goal', async () => {
    const running = rebalanceViews.accountARunning;
    show({ ...running, job: { ...running.job, goal: 'repay' } });
    expect(screen.getByText('Move cash · Clear debt')).toBeInTheDocument();
    cleanup();
    const done = rebalanceViews.convertDone;
    show({ ...done, job: { ...done.job, goal: 'custom' } });
  });
});

const totalCard = () => screen.getByText('Total cost').closest('.card') as HTMLElement;

function customPlans(plans: Record<number, RebalanceView['plans']['custom']>) {
  const view = rebalanceViews.ownerBook;
  server.use(
    http.get('/api/rebalance', ({ request }) => {
      const amount = Number(new URL(request.url).searchParams.get('amount'));
      const custom = plans[amount] ?? null;
      return HttpResponse.json(env(custom ? { ...view, plans: { ...view.plans, custom } } : view));
    }),
  );
}

async function typeCustom(user: ReturnType<typeof userEvent.setup>, amount: string) {
  await user.clear(screen.getByRole('textbox', { name: 'Amount' }));
  await user.type(screen.getByRole('textbox', { name: 'Amount' }), amount);
}

describe('RebalanceModal close and reopen, before the hold', () => {

  it('days line is the After card last row: Pays back in, then the days in the After column', () => {
    show(rebalanceViews.ownerBook);
    const last = screen.getByRole('table').lastElementChild as HTMLElement;
    expect(last.getAttribute('role')).toBe('row');
    expect(last.className).toContain('border-t');
    expect(within(last).getByRole('rowheader').textContent).toBe('Pays back in');
    const cell = within(last).getByRole('cell');
    expect(cell.dataset.column).toBe('after');
    expect(cell.textContent).toBe('21 days');
  });

  it('above the most shows the amber line, and above the most disables the hold', async () => {
    const user = userEvent.setup();
    const custom = rebalanceViews.ownerBook.plans.custom!;
    customPlans({ 50000: { ...custom, goal: { kind: 'custom', from: 'HYPERLIQUID', to: 'CROSSEX', amount: 50000 } } });
    show(rebalanceViews.ownerBook);
    await user.click(screen.getByRole('radio', { name: 'Custom amount' }));
    await typeCustom(user, '50000');
    expect(await screen.findByText('Up to 3,140 USDC from this wallet.', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Hold to move/ })).toBeDisabled();
    expect(screen.queryByText('Total cost')).toBeNull();
  });

  it('above the most on a $6,000,000 book names the whole 10,500,000 cap', async () => {
    const user = userEvent.setup();
    const custom = whaleRebalanceViews.realizeWhale.plans.custom!;
    customPlans({ 12000000: { ...custom, goal: { kind: 'custom', from: 'HYPERLIQUID', to: 'CROSSEX', amount: 12000000 } } });
    show(whaleRebalanceViews.realizeWhale);
    await user.click(screen.getByRole('radio', { name: 'Custom amount' }));
    await typeCustom(user, '12000000');
    expect(await screen.findByText('Up to 10,500,000 USDC from this wallet.', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Hold to move/ })).toBeDisabled();
  });

});

function showOn(view: RebalanceView, tab?: RebalanceTab) {
  serve({});
  renderWithClient(<RebalanceModal view={view} tab={tab} onClose={vi.fn()} />);
}

const tabRadio = (name: string) => within(screen.getByRole('radiogroup', { name: 'Reduce borrow' })).getByRole('radio', { name: new RegExp(`^${name}`) });
const boxOf = (label: string) => screen.getByText(label, { selector: 'span' }).closest('.card') as HTMLElement;
const owner = rebalanceViews.ownerAccount;
const amountPresets = () => within(screen.getByRole('radiogroup', { name: 'Amount presets' })).getAllByRole('radio');
const ownerSlices = owner.realize!.sliceOptions;

function Opener({ tab }: { tab?: RebalanceTab }) {
  const open = useRebalanceOpener();
  return <button type="button" onClick={() => open(tab ? { tab } : undefined)}>open</button>;
}

describe('RebalanceModal tabs', () => {
  it('three tabs in the header, in order, with no Rebalance title', () => {
    showOn(owner);
    const radios = within(screen.getByRole('radiogroup', { name: 'Reduce borrow' })).getAllByRole('radio');
    expect(radios.map((radio) => radio.textContent)).toEqual(['Move cash', 'Realize uPnL', 'Delever']);
    expect(within(dialog()).queryByText('Rebalance')).toBeNull();
  });

  it('an abandoned delever with a boros gap still opens on its run view with the close hold', async () => {
    showOn(extraRebalanceViews.deleverAbandonedGap);
    expect(tabRadio('Delever')).toHaveAttribute('aria-checked', 'true');
    expect(await screen.findByText(/^Boros [\d.,]+ YU has no perp behind it$/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Hold to close [\d.,]+ YU on Boros/ })).toBeInTheDocument();
  });

  it('opens on the tab that clears it', () => {
    showOn(rebalanceViews.recommendedCashOnly);
    expect(tabRadio('Move cash')).toHaveAttribute('aria-checked', 'true');
    cleanup();
    showOn(owner);
    expect(tabRadio('Realize uPnL')).toHaveAttribute('aria-checked', 'true');
    cleanup();
    showOn(owner, 'move');
    expect(tabRadio('Move cash')).toHaveAttribute('aria-checked', 'true');
  });

  it('opens on the tab that clears it from the opener, or on the tab the opener names', async () => {
    serve({});
    server.use(rebalanceHandler(owner));
    renderWithClient(
      <RebalanceOpenerProvider>
        <Opener />
        <RebalanceModalHost />
      </RebalanceOpenerProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'open' }));
    expect(await screen.findByRole('radio', { name: 'Realize uPnL' })).toHaveAttribute('aria-checked', 'true');
    cleanup();
    serve({});
    server.use(rebalanceHandler(owner));
    renderWithClient(
      <RebalanceOpenerProvider>
        <Opener tab="move" />
        <RebalanceModalHost />
      </RebalanceOpenerProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'open' }));
    expect(await screen.findByRole('radio', { name: 'Move cash' })).toHaveAttribute('aria-checked', 'true');
  });

  it('other tabs wait while a job runs', async () => {
    showOn(rebalanceViews.ownerRealizeRunning, 'move');
    expect(tabRadio('Realize uPnL')).toHaveAttribute('aria-checked', 'true');
    cleanup();
    showOn({ ...owner, job: rebalanceViews.moveRunning.job });
    expect(tabRadio('Move cash')).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(tabRadio('Realize uPnL'));
    expect(screen.getByText('New deals and transfers wait until it ends.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Hold to realize/ })).toBeNull();
    cleanup();
    showOn(rebalanceViews.ownerRealizeRunning, 'move');
    await userEvent.click(tabRadio('Move cash'));
    expect(screen.getByText('New deals and transfers wait until it ends.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Hold to/ })).toBeNull();
  });
});

describe('RebalanceModal Move cash tab', () => {
  it('from row', () => {
    showOn(owner, 'move');
    const from = boxOf('From');
    expect(from.textContent).toContain('USDC · Hyperliquid');
    expect(from.textContent).toContain('55.98');
  });

  it('to row', () => {
    showOn(owner, 'move');
    const to = boxOf('To');
    expect(to.textContent).toContain('USDT · CrossEx');
    expect(to.textContent).toContain('repays the borrow');
    const route = owner.plans.repay.routes.convert;
    const usdtAfter = route.after.find((row) => row.venue === 'CROSSEX')!.equity;
    const usdtBefore = owner.buckets.find((bucket) => bucket.venue === 'CROSSEX')!.equity;
    expect(to.textContent).toContain(num(usdtAfter - usdtBefore));
  });

  it('cost rows per fee', () => {
    showOn(owner, 'move');
    const text = totalCard().textContent ?? '';
    const at = ['Convert fee', 'Price impact', 'Total cost'].map((label) => text.indexOf(label));
    expect(at.every((index) => index >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it('interest a month in move cash', () => {
    showOn(rebalanceViews.recommendedCashOnly, 'move');
    const row = screen.getByText('Interest a month').parentElement!.parentElement as HTMLElement;
    expect(row.textContent).toMatch(/\$[\d,.]+.*\$0\.06/);
  });

  it('cash short line', async () => {
    showOn(rebalanceViews.cashShort, 'move');
    await userEvent.click(screen.getByRole('radio', { name: /^Clear debt/ }));
    expect(screen.getByText(/^[\d,.]+ USDT of borrow left\. No more cash in USDC · Hyperliquid\.$/)).toBeInTheDocument();
  });

  it('cash short link switches tab', async () => {
    showOn(rebalanceViews.cashShort, 'move');
    await userEvent.click(screen.getByRole('radio', { name: /^Clear debt/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Realize uPnL' }));
    expect(tabRadio('Realize uPnL')).toHaveAttribute('aria-checked', 'true');
  });

  it('move blocked by IM links delever', async () => {
    const view = rebalanceViews.imFull;
    const fromCrossex = (plan: typeof view.plans.repay) => ({
      ...plan,
      routes: { ...plan.routes, convert: { ...plan.routes.convert, steps: plan.routes.convert.steps.map((step) => ({ ...step, from: 'CROSSEX' as const, to: 'HYPERLIQUID' as const })) } },
    });
    showOn({ ...view, plans: { ...view.plans, repay: fromCrossex(view.plans.repay), even: fromCrossex(view.plans.even) } }, 'move');
    expect(screen.getByText('IM used 91.4%')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: HOLD })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Delever a pair' }));
    expect(tabRadio('Delever')).toHaveAttribute('aria-checked', 'true');
  });
});

describe('RebalanceModal Realize uPnL tab', () => {
  const orders = () => within(screen.getByRole('radiogroup', { name: 'Orders' })).getAllByRole('radio');
  const slices = () => within(screen.getByRole('radiogroup', { name: 'Slice size' })).getAllByRole('radio');
  const nameOf = (el: HTMLElement) =>
    el.closest('label')?.textContent ?? '';
  const pick = ownerSlices.find((option) => option.sizeUsd === owner.realize!.defaultSliceUsd)!;
  const impactPair = () => screen.getAllByText('Price impact').map((el) => el.closest('span.ml-auto')).find((el) => el !== null) as HTMLElement;
  it('Realize shows no Max not hedged, as a row, a column or a yellow warning', () => {
    showOn(owner);
    expect(screen.queryByText('Max not hedged')).toBeNull();
    expect(screen.queryByText(/Not hedged/)).toBeNull();
    expect(document.querySelector('.text-gold')).toBeNull();
  });

  it('Limit + hedge has the maker settings, and the start sends them; Market has none', async () => {
    serve({});
    const sent = starts();
    renderWithClient(<RebalanceModal view={owner} onClose={vi.fn()} holdMs={50} />);
    fireEvent.click(screen.getByRole('button', { name: /Maker settings/ }));
    fireEvent.click(await screen.findByRole('radio', { name: 'Never' }));
    fireEvent.click(await screen.findByRole('radio', { name: 'Off' }));
    const hold = screen.getByRole('button', { name: 'Hold to realize' });
    await waitFor(() => expect(hold).toBeEnabled());
    fireEvent.pointerDown(hold);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect((sent[0] as { maker?: unknown }).maker).toEqual({ takerAfterSec: null, repegBehindBp: null });
    await userEvent.click(orders()[1]!);
    expect(screen.queryByRole('button', { name: /Maker settings/ })).toBeNull();
  });

  it('a 10 min wait before taker shows as about 10 min per slice', async () => {
    showOn(owner);
    fireEvent.click(screen.getByRole('button', { name: /Maker settings/ }));
    fireEvent.click(await screen.findByRole('radio', { name: '10m' }));
    expect(orders()[0]).toHaveTextContent(/· 10 min per slice$/);
  });

  it('limit + hedge first and default', () => {
    showOn(owner);
    expect(orders()[0]!.textContent).toMatch(/^Limit \+ hedge about \$[\d,]+ · /);
    expect(orders()[0]!.textContent).toContain(`· ${fmtApprox(pick.seconds.maker / pick.count)} per slice`);
    expect(orders()[0]).toHaveAttribute('aria-checked', 'true');
  });

  it('market second', () => {
    showOn(owner);
    expect(orders()[1]!.textContent).toMatch(/^Market about \$[\d,]+ · /);
    expect(orders()[1]!.textContent).toContain(`· ${fmtApprox(pick.seconds.market / pick.count)} per slice`);
  });

  it('a $6M realize at $50k slices reads about 5 min per slice', () => {
    const view = whaleRebalanceViews.realizeWhale;
    const tab = view.realize!;
    const option = tab.sliceOptions.find((o) => o.sizeUsd === 50_000)!;
    expect(tab.clearDebt!.legs[0]!.realizedUsd).toBeGreaterThan(5_900_000);
    expect(option.count).toBeGreaterThan(100);
    showOn(view, 'realize');
    expect(orders()[0]!.textContent).toContain(`· ${fmtApprox(300)} per slice`);
    expect(orders()[0]!.textContent).not.toContain(fmtApprox(option.seconds.maker));
    expect(screen.getByRole('switch', { name: 'Split the close' })).toHaveAttribute('aria-checked', 'true');
    expect(nameOf(slices().find((radio) => (radio as HTMLInputElement).checked)!)).toContain(fmtNotionalShort(50_000));
  });

  it('a custom slice below the venue minimum shows the slice raised to the minimum', async () => {
    const raised = { ...ownerSlices.find((o) => !o.custom)!, sizeUsd: 11, custom: true, count: 640 };
    const sliced = { ...owner, realize: { ...owner.realize!, sliceOptions: [...ownerSlices.filter((o) => !o.custom), raised] } };
    serve({});
    server.use(http.get('/api/rebalance', () => HttpResponse.json(env(sliced))));
    renderWithClient(<RebalanceModal view={owner} onClose={vi.fn()} />);
    await userEvent.type(screen.getByRole('textbox', { name: 'Custom' }), '1');
    await waitFor(() => expect(nameOf(slices().at(-1)!)).toContain('640'), { timeout: 3000 });
    expect(slices().at(-1)).toBeChecked();
  });

  it('a non-default preset slice judges the plan the server prices at that slice', async () => {
    const other = ownerSlices.find((o) => !o.custom && o.sizeUsd !== owner.realize!.defaultSliceUsd)!;
    const refused = { reason: 'past-book' as const, bp: null };
    const tab = owner.realize!;
    const sliced = {
      ...owner,
      realize: { ...tab, clearDebt: tab.clearDebt ? { ...tab.clearDebt, refused } : null, all: tab.all ? { ...tab.all, refused } : null },
    };
    const asked: string[] = [];
    serve({});
    server.use(http.get('/api/rebalance', ({ request }) => {
      asked.push(new URL(request.url).search);
      return HttpResponse.json(env(sliced));
    }));
    renderWithClient(<RebalanceModal view={owner} onClose={vi.fn()} />);
    await userEvent.click(slices().find((radio) => nameOf(radio).includes(fmtNotionalShort(other.sizeUsd)))!);
    await waitFor(() => expect(asked.some((query) => query.includes(`sliceUsd=${other.sizeUsd}`))).toBe(true), { timeout: 3000 });
    expect(await screen.findByText('Order book too thin to price.', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Hold to realize/ })).toBeNull();
    expect(screen.getByRole('radiogroup', { name: 'Slice size' })).toBeInTheDocument();
  });

  it('a preset slice the server marks past the book refuses in place of the hold and keeps the slice table', async () => {
    const other = ownerSlices.find((o) => !o.custom && o.sizeUsd !== owner.realize!.defaultSliceUsd)!;
    const marked = { ...owner, realize: { ...owner.realize!, sliceOptions: ownerSlices.map((o) => (o.sizeUsd === other.sizeUsd ? { ...o, pastBook: true } : o)) } };
    serve({});
    server.use(http.get('/api/rebalance', () => HttpResponse.json(env(marked))));
    renderWithClient(<RebalanceModal view={marked} onClose={vi.fn()} />);
    await userEvent.click(slices().find((radio) => nameOf(radio).includes(fmtNotionalShort(other.sizeUsd)))!);
    expect(await screen.findByText('Pick a smaller slice size.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Hold to realize/ })).toBeNull();
    expect(screen.getByRole('radiogroup', { name: 'Slice size' })).toBeInTheDocument();
  });

  it('realize amount: the box holds the lit preset, and typing lights none', async () => {
    const asked: string[] = [];
    serve({});
    server.use(http.get('/api/rebalance', ({ request }) => {
      asked.push(new URL(request.url).search);
      return HttpResponse.json(env(owner));
    }));
    renderWithClient(<RebalanceModal view={owner} onClose={vi.fn()} />);
    const chips = amountPresets();
    expect(chips.map((chip) => chip.textContent)).toEqual([expect.stringMatching(/^Debt \([\d,]+ USDC\)$/), expect.stringMatching(/^All \([\d,]+ USDC\)$/)]);
    expect(chips[0]).toHaveAttribute('aria-checked', 'true');
    const box = screen.getByRole('textbox', { name: 'Amount to realize' });
    expect(box).toHaveValue(chips[0]!.textContent!.match(/[\d,]+/)![0].replaceAll(',', ''));
    await userEvent.click(chips[1]!);
    const allText = chips[1]!.textContent!.match(/[\d,]+/)![0].replaceAll(',', '');
    expect(box).toHaveValue(allText);
    await userEvent.type(box, '{backspace}');
    expect(amountPresets().every((chip) => chip.getAttribute('aria-checked') === 'false')).toBe(true);
    expect(screen.queryByText('Type an amount to realize.')).toBeNull();
    await userEvent.type(box, allText.slice(-1));
    expect(amountPresets()[1]).toHaveAttribute('aria-checked', 'true');
    await userEvent.clear(box);
    await userEvent.type(box, '999999999');
    expect(amountPresets().every((chip) => chip.getAttribute('aria-checked') === 'false')).toBe(true);
    await waitFor(() => expect(asked.some((search) => search.includes('realizeUsd='))).toBe(true));
    const query = new URLSearchParams(asked.find((search) => search.includes('realizeUsd=')));
    expect(Number(query.get('realizeUsd'))).toBeLessThan(999999999);
    expect(query.get('realizePool')).toBe('HYPERLIQUID');
  });

  it('realize wallet: one wallet in profit shows the same picker, with that one wallet', async () => {
    showOn(owner);
    const picker = screen.getByRole('button', { name: 'Wallet' });
    expect(picker).toHaveTextContent(/^USDC · HyperliquiduPnL [\d,]+ USDC$/);
    expect(picker.querySelector(".text-emerald-400")).not.toBeNull();
    await userEvent.click(picker);
    const options = within(screen.getByRole('listbox', { name: 'Wallet' })).getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([expect.stringMatching(/^USDC · HyperliquiduPnL [\d,]+ USDC$/)]);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('combobox', { name: 'Wallet' })).toBeNull();
    expect(screen.queryByText(/^Wallet: /)).toBeNull();
  });

  it('realize wallet: two wallets in profit give a picker, and the pick prices and starts from that wallet', async () => {
    const twoPools = { ...owner, realize: { ...owner.realize!, pools: ['HYPERLIQUID', 'CROSSEX'] as Pool[] } };
    const onCrossex = { ...twoPools, realize: { ...twoPools.realize, pool: 'CROSSEX' as Pool, clearDebt: null } };
    const asked: string[] = [];
    serve({});
    const sent = starts();
    server.use(http.get('/api/rebalance', ({ request }) => {
      const search = new URL(request.url).search;
      asked.push(search);
      return HttpResponse.json(env(search.includes('realizePool=CROSSEX') ? onCrossex : twoPools));
    }));
    renderWithClient(<RebalanceModal view={twoPools} onClose={vi.fn()} holdMs={50} />);
    await userEvent.click(screen.getByRole('button', { name: 'Wallet' }));
    const options = within(screen.getByRole('listbox', { name: 'Wallet' })).getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringMatching(/^USDC · HyperliquiduPnL [\d,]+ USDC$/),
      expect.stringMatching(/^USDT · CrossExuPnL [\d,]+ USDT$/),
    ]);
    await userEvent.click(options[1]);
    await waitFor(() => expect(asked.some((search) => search.includes('realizePool=CROSSEX'))).toBe(true));
    const chips = await waitFor(() => {
      const found = amountPresets();
      expect(found[0]).toBeDisabled();
      expect(found[0]).toHaveTextContent(/^Debt \(0 USDT\)$/);
      return found;
    });
    expect(chips[1]).toHaveAttribute('aria-checked', 'true');
    fireEvent.pointerDown(screen.getByRole('button', { name: /^Hold to realize/ }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ kind: 'realize', realizeTarget: 'all', realizePool: 'CROSSEX' });
  });

  it('realize All: the After box shows the Convert paying down the borrow in the target wallet', async () => {
    showOn(owner);
    const chips = amountPresets();
    await userEvent.click(chips[1]!);
    const legs = owner.realize!.all!.legs;
    const landed = legs.reduce((total, leg) => total + (leg.convert ? leg.convert.amount - leg.convert.feeUsd : 0), 0);
    const borrow = owner.buckets.find((b) => b.coin === 'USDT' && b.venue === 'CROSSEX')!.borrow;
    expect(landed).toBeGreaterThan(0);
    const usdt = await screen.findByRole('rowgroup', { name: 'USDT · CrossEx' });
    const row = within(usdt).getAllByRole('row').find((r) => within(r).queryByRole('rowheader')?.textContent === 'Borrow')!;
    const [before, after] = within(row).getAllByRole('cell');
    expect(before!.textContent).toBe(sigGrouped(borrow));
    expect(after!.textContent).toBe(sigGrouped(Math.max(0, borrow - landed)));
  });

  it('realize hold label', () => {
    showOn(owner);
    expect(screen.getByRole('button', { name: 'Hold to realize' })).toBeInTheDocument();
  });

  it('while a new custom amount prices, the hold reads Pricing and nothing above or below it moves', async () => {
    serve({});
    server.use(http.get('/api/rebalance', () => new Promise(() => {})));
    renderWithClient(<RebalanceModal view={owner} onClose={vi.fn()} />);
    await screen.findByRole('switch', { name: 'Split the close' });
    const box = screen.getByRole('textbox', { name: 'Amount to realize' });
    await userEvent.clear(box);
    await userEvent.type(box, '5000');
    expect(screen.queryByRole('button', { name: 'Hold to realize' })).toBeNull();
    expect(screen.getAllByText('Pricing the move.')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /Pricing the move\./ })).toBeDisabled();
  });

  it('slice rows show one row per slice count, smallest size first, then Custom', async () => {
    showOn(owner);
    expect(ownerSlices.filter((o) => !o.custom && !o.whole).map((o) => o.count)).toEqual([2, 1, 1, 1]);
    const names = slices().map(nameOf);
    expect(names).toHaveLength(3);
    ['$25k', '$50k', 'Custom'].forEach((label, index) => expect(names[index]).toContain(label));
  });

  it('Split the close is on by default when the recommended size gives 2 or more slices, with price impact one order to sliced', () => {
    showOn(owner);
    const whole = ownerSlices.find((o) => o.whole)!;
    expect(pick.count).toBeGreaterThan(1);
    expect(screen.getByRole('switch', { name: 'Split the close' })).toHaveAttribute('aria-checked', 'true');
    const pair = impactPair();
    expect(pair).toHaveTextContent(`${fmtUsd(whole.reopenImpactUsd, 0)}`);
    expect(pair.querySelector('.text-grass')).toHaveTextContent(fmtUsd(pick.reopenImpactUsd, 0));
  });

  it('Split the close off hides the table, keeps price impact one order to recommended, and starts one order', async () => {
    const starts: { sliceUsd?: number }[] = [];
    const asked: string[] = [];
    serve({});
    server.use(
      http.get('/api/rebalance', ({ request }) => {
        asked.push(new URL(request.url).search);
        return HttpResponse.json(env(owner));
      }),
      http.post('/api/rebalance', async ({ request }) => {
        starts.push((await request.json()) as { sliceUsd?: number });
        return HttpResponse.json(env({ id: 'real0001' }));
      }),
    );
    renderWithClient(<RebalanceModal view={owner} onClose={vi.fn()} />);
    const whole = ownerSlices.find((o) => o.whole)!;
    await userEvent.click(screen.getByRole('switch', { name: 'Split the close' }));
    expect(screen.getByRole('switch', { name: 'Split the close' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByRole('radiogroup', { name: 'Slice size' })).toBeNull();
    const pair = impactPair();
    expect(pair.querySelector('.text-grass')).toHaveTextContent(fmtUsd(pick.reopenImpactUsd, 0));
    expect(orders()[0]!.textContent).not.toContain('per slice');
    await waitFor(() => expect(asked.some((query) => query.includes(`sliceUsd=${whole.sizeUsd}`))).toBe(true));
    const hold = screen.getByRole('button', { name: 'Hold to realize' });
    await waitFor(() => expect(hold).toBeEnabled());
    fireEvent.pointerDown(hold);
    await waitFor(() => expect(starts).toHaveLength(1));
    expect(starts[0]!.sliceUsd).toBe(whole.sizeUsd);
  });

  it('Split the close cannot turn on when every size gives one slice, and the hover says why', async () => {
    const single = ownerSlices.map((o) => ({ ...o, count: 1 }));
    const small = { ...owner, realize: { ...owner.realize!, sliceOptions: single } };
    showOn(small);
    const toggle = screen.getByRole('switch', { name: 'Split the close' });
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByRole('radiogroup', { name: 'Slice size' })).toBeNull();
    fireEvent.mouseEnter(toggle.parentElement as HTMLElement);
    expect(await screen.findByText('Too small to split. One order of this size fits in one slice.')).toBeInTheDocument();
  });

  it('one order past the book with Split the close off points at the switch', async () => {
    const marked = { ...owner, realize: { ...owner.realize!, sliceOptions: ownerSlices.map((o) => (o.whole ? { ...o, pastBook: true } : o)) } };
    showOn(marked);
    await userEvent.click(screen.getByRole('switch', { name: 'Split the close' }));
    expect(await screen.findByText('Turn on Split the close.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Hold to realize/ })).toBeNull();
    const pair = impactPair();
    expect(pair).toHaveTextContent('Book too thin to price');
  });

  it('slice columns', async () => {
    showOn(owner);
    ['Count', 'Est. time', 'Price impact', 'Max slippage 0.25%'].forEach((head) => expect(screen.getAllByText(head).length).toBeGreaterThan(0));
    expect(screen.queryByText('Max not hedged')).toBeNull();
    const before = nameOf(slices()[0]!);
    await userEvent.click(orders()[1]!);
    expect(nameOf(slices()[0]!)).not.toBe(before);
  });

  it('slice default row', async () => {
    showOn(owner);
    const checked = slices().find((radio) => (radio as HTMLInputElement).checked);
    expect(nameOf(checked!)).toContain(fmtNotionalShort(owner.realize!.defaultSliceUsd));
  });

  it('slice row updates cost', async () => {
    showOn(owner);
    const other = ownerSlices.find((option) => !option.custom && !option.whole && option.sizeUsd !== pick.sizeUsd)!;
    const before = totalCard().textContent;
    const row = slices().find((radio) => nameOf(radio).includes(fmtNotionalShort(other.sizeUsd)))!;
    await userEvent.click(row);
    expect((row as HTMLInputElement).checked).toBe(true);
    if (other.impactUsd !== pick.impactUsd) expect(totalCard().textContent).not.toBe(before);
  });

  it('a realize past the book shows why in place of the hold and keeps the split controls', () => {
    showOn(rebalanceViews.realizeRefused);
    expect(screen.queryByRole('button', { name: /^Hold to realize/ })).toBeNull();
    expect(screen.getAllByText('Order book too thin to price.').length).toBeGreaterThan(0);
    expect(screen.getByRole('radiogroup', { name: 'Orders' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Split the close' })).toBeInTheDocument();
  });

  it('a margin refusal wins over a thin book, and hides the orders', () => {
    const view = rebalanceViews.imFull;
    const options = view.realize!.sliceOptions.map((o) => ({ ...o, pastBook: true }));
    showOn({ ...view, realize: { ...view.realize!, sliceOptions: options } });
    expect(screen.queryByText('Order book too thin to price.')).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: 'Orders' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Hold to realize/ })).toBeNull();
  });

  it('a recommended size that is not a preset starts with Split the close off, and on picks the largest size that splits', async () => {
    const view = { ...owner, realize: { ...owner.realize!, defaultSliceUsd: 40_000 } };
    showOn(view);
    const toggle = screen.getByRole('switch', { name: 'Split the close' });
    expect(toggle).toBeEnabled();
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(impactPair().querySelector('.text-grass')).toHaveTextContent(fmtUsd(pick.reopenImpactUsd, 0));
    fireEvent.mouseEnter(toggle.parentElement as HTMLElement);
    expect(await screen.findByText(new RegExp(`Recommended: ${fmtNotionalShort(pick.sizeUsd).replace('$', '\\$')}, ${pick.count} slices`))).toBeInTheDocument();
    await userEvent.click(toggle);
    const checked = slices().find((radio) => (radio as HTMLInputElement).checked);
    expect(nameOf(checked!)).toContain(fmtNotionalShort(pick.sizeUsd));
  });

  it('All can split when the debt amount fits in one slice', async () => {
    const single = ownerSlices.map((o) => ({ ...o, count: 1 }));
    const small = { ...owner, realize: { ...owner.realize!, sliceOptions: single } };
    showOn(small);
    expect(screen.getByRole('switch', { name: 'Split the close' })).toBeDisabled();
    await userEvent.click(amountPresets()[1]!);
    expect(screen.getByRole('switch', { name: 'Split the close' })).toBeEnabled();
  });
});

describe('RebalanceModal TWAP run', () => {
  const closeText = () => within(dialog()).getByText('Close', { selector: 'button' });

  it('shows a stopped TWAP on the first open after a reload, with Close, then the form', () => {
    const { onClose } = show(twapFixtures.normal.stopped.rebalance);
    expect(screen.getByText(/^Stopped at slice \d+ of \d+$/)).toBeTruthy();
    fireEvent.click(closeText());
    expect(onClose).toHaveBeenCalled();
    cleanup();
    show(twapFixtures.normal.stopped.rebalance);
    expect(screen.queryByText(/^Stopped at slice/)).toBeNull();
  });

  it('shows a done TWAP on the first open after a reload', () => {
    show(twapFixtures.normal.done.rebalance);
    expect(screen.getByText('Took')).toBeTruthy();
    expect(closeText()).toBeTruthy();
  });

  it('a TWAP run has no tab row and one state chip', () => {
    show(twapFixtures.normal.refused.rebalance);
    expect(within(dialog()).queryByText('Move cash')).toBeNull();
    expect(within(dialog()).getAllByText(/^(Paused|Stopped|Running|Not hedged)$/)).toHaveLength(1);
  });

  it('a refused pause on a slice run says why', async () => {
    server.use(
      http.post('/api/rebalance/:id/pause', () =>
        HttpResponse.json({ ok: false, error: { category: 'validation', label: 'NOT_RUNNING', message: 'Nothing to pause.', retryable: false } }, { status: 409 }),
      ),
    );
    show(rebalanceViews.deleverRunning);
    fireEvent.click(screen.getByRole('button', { name: 'Pause after this slice' }));
    expect(await screen.findByText('Nothing to pause.')).toBeTruthy();
  });
});
