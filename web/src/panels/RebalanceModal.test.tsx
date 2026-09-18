import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAccount, usePositions, useRebalance, useTransfer } from '../api/queries';
import type { CrossexAccount, PositionsResponse, RebalanceStep, RebalanceView, TransferView } from '../api/types';
import type { RebalanceJob, RouteName } from '../api/types';
import { accountBodies, accountHandler, positionsBodies, REBALANCE_NOW, rebalanceViews, rebased } from '../test/fixtures';
import { transferHandler, transferViews } from '../test/fixtures';
import { env, server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { RebalanceModal } from './RebalanceModal';

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

const barRows = (name: string): string[] =>
  [...screen.getByRole('group', { name }).querySelectorAll('[data-bar-row]')].map((row) => row.textContent ?? '');

const rowOf = (name: string) => screen.getByRole('radio', { name }).closest('label') as HTMLElement;

const pickedRow = () => screen.getByRole('radio', { checked: true }).closest('label') as HTMLElement;

const holdButton = () => screen.getByRole('button', { name: 'Hold to rebalance' });

const allRoutes = () => screen.getByRole('button', { name: 'Show all routes' });

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
  screen
    .getAllByRole('radio')
    .map((radio) => document.getElementById(radio.getAttribute('aria-labelledby') ?? '')?.textContent);

const stepTexts = () =>
  within(dialog())
    .getAllByRole('listitem')
    .map((row) => [...row.querySelectorAll('span')].map((span) => span.textContent).filter(Boolean));

async function openSteps(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement[]> {
  await user.click(screen.getByRole('button', { name: 'Show steps' }));
  return within(dialog()).getAllByRole('listitem');
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
  return { ...view, plan: { ...view.plan, routes: { ...view.plan.routes, mix: { ...view.plan.routes.mix!, costUsd } } } };
}

function withConvertAfter(hyperliquidEquity: number, marginFreedUsd: number): RebalanceView {
  const view = rebalanceViews.twoBorrows;
  const convert = view.plan.routes.convert!;
  const after = [
    convert.after[0],
    { coin: 'USDC', venue: 'HYPERLIQUID', cash: hyperliquidEquity + 12, equity: hyperliquidEquity },
    { coin: 'USDC', venue: 'LIGHTER', cash: -120, equity: -132 },
  ];
  const routes = { ...view.plan.routes, convert: { ...convert, marginFreedUsd, savesPerDayUsd: 0, after } };
  return { ...view, plan: { ...view.plan, routes } };
}


const resumeButton = () => within(dialog()).getByRole('button', { name: /^Resum/ });

const abandonButton = () => within(dialog()).getByRole('button', { name: 'Abandon' });

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
    expect(within(modal).getByText('Route')).toBeInTheDocument();
    expect(allRoutes()).toBeInTheDocument();
    expect(holdButton()).toBeInTheDocument();
  });

  it('opens with the picked route as one selected route row, its time and fee in the row', async () => {
    show(rebalanceViews.twoBorrows);
    expect(screen.getAllByRole('radio')).toHaveLength(1);
    expect(screen.getByRole('radio', { name: 'Spot loop, then Convert' })).toBeChecked();
    expect(within(pickedRow()).getByText('Recommended')).toBeInTheDocument();
    expect(pickedRow()).toHaveTextContent('about 2 min');
    expect(pickedRow()).toHaveTextContent('Fee $0.46');
    expect(allRoutes().textContent).toBe('Show all routes');
    expect(allRoutes().compareDocumentPosition(pickedRow()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('clicking the selected route row opens every route', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.twoBorrows);
    await user.click(pickedRow());
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByRole('radio', { name: 'Spot loop, then Convert' })).toBeChecked();
  });

  it('opens every route inline in the same modal', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.twoBorrows);
    await user.click(allRoutes());
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(within(dialog()).getByRole('radiogroup', { name: 'Route' })).toBeInTheDocument();
    expect(screen.getAllByRole('radio').map((radio) => radio.getAttribute('value') ?? radio.id)).toHaveLength(2);
    expect(screen.getByRole('radio', { name: 'Spot loop, then Convert' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Convert' })).toBeInTheDocument();
  });

  it('greys a hidden route and shows its reason in place of its time', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.hiddenRoute);
    await user.click(allRoutes());
    const row = rowOf('Spot loop');
    expect(screen.getByRole('radio', { name: 'Spot loop' })).toBeDisabled();
    expect(row.textContent).toContain('Gate paused USDC transfers.');
    expect(row.textContent).not.toContain('about');
  });

  it('picking a route row keeps every route open and moves the selection, with no separate control', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.twoBorrows);
    await user.click(allRoutes());
    expect(screen.queryByRole('button', { name: 'Keep the recommended one' })).toBeNull();
    await user.click(screen.getByRole('radio', { name: 'Convert' }));
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByRole('radio', { name: 'Convert' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Spot loop, then Convert' })).not.toBeChecked();
    expect(screen.queryByRole('button', { name: 'Show all routes' })).toBeNull();
    await user.click(screen.getByRole('radio', { name: 'Spot loop, then Convert' }));
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(pickedRow()).toHaveTextContent('Fee $0.46');
  });

  it('hides Show all routes when one route is on the wire, and its row opens nothing', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.oneRouteOnly);
    expect(screen.queryByRole('button', { name: 'Show all routes' })).toBeNull();
    expect(screen.getByRole('radio', { name: 'Convert' })).toBeChecked();
    expect(pickedRow()).toHaveTextContent('instant');
    expect(pickedRow()).toHaveTextContent('Fee $0.02');
    await user.click(pickedRow());
    expect(screen.getAllByRole('radio')).toHaveLength(1);
  });

  it('shows one After rebalance row per wallet, each on its gold mark', async () => {
    show(rebalanceViews.twoBorrows);
    const group = screen.getByRole('group', { name: 'After rebalance' });
    expect(barRows('After rebalance')).toEqual([
      'USDT · CrossEx623.50',
      'USDC · Hyperliquid549.08',
      'USDC · Lighter74.88',
    ]);
    expect(group.querySelectorAll('[data-bar-target]')).toHaveLength(3);
  });

  it('a negative cash bar reads red and a positive one reads green', async () => {
    show(rebalanceViews.accountARunning);
    const now = screen.getByRole('group', { name: 'Now' });
    expect(now.querySelector('[data-bar-row="USDT/CROSSEX"] [data-bar-cash]')?.className).toContain('bg-grass');
    expect(now.querySelector('[data-bar-row="USDC/HYPERLIQUID"] [data-bar-cash]')?.className).toContain('bg-guava');
    cleanup();

    show(rebalanceViews.twoBorrows);
    const after = screen.getByRole('group', { name: 'After rebalance' });
    expect(after.querySelector('[data-bar-row="USDC/LIGHTER"] [data-bar-cash]')?.className).toContain('bg-grass');
  });

  it('the On the way bar keeps its gold mark, not a cash color', async () => {
    const running = rebalanceViews.exampleERunning;
    show({ ...running, job: { ...running.job, inTransit: { coin: 'USDC', qty: 745.44, at: 'MOVING' } } });
    const row = screen.getByRole('group', { name: 'Now' }).querySelector('[data-bar-row="spot"]') as HTMLElement;
    expect(row.querySelector('[data-bar-cash]')?.className).toContain('bg-gold');
    expect(row.querySelector('[data-zero-line]')?.className).toContain('bg-ink-200');
  });

  it('gives a wallet with no position share three numbers and a gold mark at zero', async () => {
    show(rebalanceViews.accountARunning);
    const row = screen.getByRole('group', { name: 'Now' }).querySelector('[data-bar-row="USDC/GATE"]') as HTMLElement;
    expect(row.querySelector('[data-bar-target]')).not.toBeNull();
    fireEvent.mouseMove(row.querySelector('[data-bar-hit]') as HTMLElement, { clientX: 100, clientY: 40 });
    const tip = screen.getByRole('tooltip');
    expect(tip.textContent).toMatch(/Cash.*Unrealized PnL.*Balanced target/);
    const numbers = [...tip.querySelectorAll('.num')].map((el) => el.textContent);
    expect(numbers).toHaveLength(3);
    expect(numbers[2]).toBe('0.00');
  });

  it('shows interest a month now and after, the fee and Frees as three labelled facts, with no sub-lines', async () => {
    show(rebalanceViews.twoBorrows, { account: accountBodies.ethTwoVenues, positions: positionsBodies.ethTwoVenues });
    await waitFor(() => expect(facts().Interest).toBe('$1.19 → $0.00 a month'));
    const shown = facts();
    expect(shown.Fee).toBe('$0.46');
    expect(shown.Frees).toBe('$48.80');
    // Liquidation is an ACCOUNT fact, not a property of this route, and it
    // read as a fourth cost of rebalancing — so it is not here.
    expect(shown.Liquidation).toBeUndefined();
    for (const label of ['Interest', 'Fee', 'Frees']) expect(subs(label)).toEqual([]);
  });

  it('shows the position share of each wallet beside the After rebalance bars', async () => {
    show(rebalanceViews.twoBorrows);
    const share = screen.getByRole('group', { name: 'Position share' });
    const after = screen.getByRole('group', { name: 'After rebalance' });
    const cells = [...share.querySelectorAll('span.num')].map((el) => el.textContent);
    expect(cells).toHaveLength(after.querySelectorAll('[data-bar-row]').length);
    expect(cells.every((text) => /^\d+% · \$[\d,]+$/.test(text ?? ''))).toBe(true);
    cleanup();

    show(rebalanceViews.noLegs);
    expect(screen.queryByRole('group', { name: 'Position share' })).toBeNull();
  });

  it('folds the step list behind one control, over one hold to confirm button', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.twoBorrows);
    expect(dialog().querySelector('ol')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Hold to rebalance' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Show steps' }));
    expect(within(dialog()).getAllByRole('listitem')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Hide steps' }));
    expect(dialog().querySelector('ol')).toBeNull();
  });

  it('carries only what the decision needs, never Borrowing or Interest paid', async () => {
    show(rebalanceViews.twoBorrows, { account: accountBodies.ethTwoVenues, positions: positionsBodies.ethTwoVenues });
    await waitFor(() => expect(facts().Interest).toMatch(/→/));
    expect(screen.queryByText('Borrowing')).toBeNull();
    expect(screen.queryByText('Interest paid')).toBeNull();
    expect(screen.queryByText('Interest now')).toBeNull();
    expect(Object.keys(facts())).toEqual(['Interest', 'Fee', 'Frees']);
  });

  it('explains a round and why more than one in the step control hover', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.twoBorrows);
    expect((await hoverCard(user, 'Show steps')).text).toBe(
      'A round is one trip through Gate spot, capped by your free margin. Gate locks $48.80 of initial margin for your borrow. Each round repays some borrow, so the next round is bigger.',
    );
  });

  it('replaces the hold with Refresh route when the picked route moves money differently', async () => {
    const plan = rebalanceViews.twoBorrows.plan;
    const mix = plan.routes.mix!;
    const elsewhere: RebalanceView = {
      ...rebalanceViews.twoBorrows,
      plan: { ...plan, routes: { ...plan.routes, mix: { ...mix, steps: mix.steps.map((step) => ({ ...step, to: 'HYPERLIQUID' as const })) } } },
    };
    const user = userEvent.setup();
    const { next } = showPolled([rebalanceViews.twoBorrows, elsewhere]);
    expect(holdButton()).toBeEnabled();
    await next();
    expect(screen.queryByRole('button', { name: 'Hold to rebalance' })).toBeNull();
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
    expect(screen.queryByRole('button', { name: 'Hold to rebalance' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Refresh route' }));
    expect(holdButton()).toBeEnabled();
  });

  it('replaces the hold with Refresh route when the plan went stale on a new recommended route', async () => {
    const user = userEvent.setup();
    const view = rebalanceViews.twoBorrows;
    const { next } = showPolled([view, { ...view, plan: { ...view.plan, recommended: 'convert' } }]);
    await user.click(allRoutes());
    await user.click(screen.getByRole('radio', { name: 'Convert' }));
    expect(holdButton()).toBeEnabled();
    await next();
    expect(screen.queryByRole('button', { name: 'Hold to rebalance' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Refresh route' }));
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
    expect(holdButton()).toBeDisabled();
    cleanup();

    show(rebalanceViews.twoBorrows, { transfer: transferViews.lockDeal });
    expect(await within(dialog()).findByText('Deal running')).toBeInTheDocument();
    expect(holdButton()).toBeDisabled();
  });
});

describe('RebalanceModal run states', () => {
  beforeEach(() => {
    vi.setSystemTime(REBALANCE_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the running state: route, round, time left, progress, wallets and the money on the way', async () => {
    show(rebalanceViews.accountARunning);
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(facts()).toEqual({ Route: 'Spot loop', Round: '3 of 5', 'Time left': 'about 6 min' });
    expect(subs('Time left')).toEqual(['4m 58s gone']);
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    expect(barRows('Now')).toEqual([
      'USDT · CrossEx92.54',
      'USDC · Hyperliquid-92.71',
      'USDC · Gate20.94',
      'On the way36.58',
    ]);
  });

  it('says the running job keeps going after the modal closes', async () => {
    const { onClose } = show(rebalanceViews.accountARunning);
    expect(
      within(dialog()).getByText('Started 4m 58s ago. You can close this. The run keeps going.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'close' })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows a halted state: the reason, where the money is, then Resume and Abandon', async () => {
    show(rebalanceViews.accountAHalted);
    expect(screen.getByText('Stopped')).toBeInTheDocument();
    expect(screen.getByRole('alert').textContent).toBe(
      'Stopped in round 3 of 5.Gate paused transfers into the CrossEx Hyperliquid wallet.',
    );
    expect(barRows('Where your money is')).toContain('Gate spot36.58');
    expect(screen.getByRole('button', { name: 'Resume' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Abandon' })).toBeEnabled();
    expect(within(dialog()).getByText('Abandon leaves the 36.58 USDC in Gate spot.')).toBeInTheDocument();
  });

  it('says the key cannot read Spot and shows no zero for an unknown balance', async () => {
    show(rebalanceViews.accountAHalted, { transfer: transferViews.noSpot });
    expect(await screen.findByText('Add Spot read permission to see spot balances.')).toBeInTheDocument();
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
    expect(screen.getByText('Balanced')).toBeInTheDocument();
    expect(facts()).toEqual({ Route: 'Spot loop', Moved: '$175.63', Took: '4m 18s', Cost: '$0.26' });
    expect(barRows('Now')).toContain('USDT · CrossEx92.54');
    expect(onClose).not.toHaveBeenCalled();
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

const withFee = (view: RebalanceView, costUsd: number): RebalanceView => ({
  ...view,
  plan: {
    ...view.plan,
    routes: {
      ...view.plan.routes,
      ...(view.plan.routes.mix ? { mix: { ...view.plan.routes.mix, costUsd } } : {}),
      convert: { ...view.plan.routes.convert, costUsd },
    },
  },
});

/**
 * The verdict, now a boxed VerdictAlert shared with the Balances card rather
 * than a bare <p>. Returns its sentence, its tone, and the supporting sub-line
 * where the verdict has one. The `sr-only` severity prefix is dropped so
 * expectations read as the trader sees them.
 */
const worth = () => {
  const facts = dialog().querySelector('dl')?.parentElement as HTMLElement;
  const TONE: Record<string, string> = { 'alert-blue': 'info', 'alert-amber': 'warn', 'alert-red': 'act' };
  return [...facts.querySelectorAll(':scope > div[class*="alert-"]')].map((box) => {
    const [head, sub] = [...box.querySelectorAll(':scope > span:not([aria-hidden]) > span')];
    const visible = [...(head?.childNodes ?? [])]
      .filter((n) => !(n instanceof HTMLElement && n.classList.contains('sr-only')))
      .map((n) => n.textContent ?? '')
      .join('');
    const tone = Object.keys(TONE).find((cls) => box.className.includes(cls));
    return { text: visible, tone: tone ? TONE[tone] : null, ...(sub ? { sub: sub.textContent } : {}) };
  });
};

describe('RebalanceModal is it worth it', () => {
  // Lighter's borrow at a round 0.04 a day. The mix route repays all of it.
  const at4c = { ...rebalanceViews.twoBorrows, buckets: rebased(rebalanceViews.twoBorrows.buckets, { 'USDC/LIGHTER': { interestPerDayUsd: 0.04 } }) };

  it.each([
    ['a $0.46 fee against $0.04 a day', 0.46, 'The fee equals 12 days of the interest it saves.'],
    ['a fee of exactly 30 days', 1.2, 'The fee equals 30 days of the interest it saves.'],
    ['a fee of exactly 1 day', 0.04, 'The fee equals 1 day of the interest it saves.'],
    ['a fee under 1 day', 0.03, 'The fee equals less than a day of the interest it saves.'],
  ])('%s says how many days of interest the fee equals', (_, fee, text) => {
    show(withFee(at4c, fee));
    expect(worth()).toEqual([{ text: 'Rebalance is recommended.', tone: 'act', sub: text }]);
    expect(facts().Fee).toBe(`$${fee.toFixed(2)}`);
    expect(facts().Interest).toBe('$1.20 → $0.00 a month');
  });

  it.each([
    ['a fee a cent over 30 days', 1.21],
    ['a $20 fee against $0.04 a day', 20],
  ])('%s says it is not worth it yet, and the hold still works', async (_, fee) => {
    const sent = starts();
    show(withFee(at4c, fee), { holdMs: 50 });
    expect(worth()).toEqual([{ text: 'Not worth it yet. The fee is more than 30 days of the interest it saves.', tone: 'warn' }]);
    expect(facts().Interest).toBe('$1.20 → $0.00 a month');
    fireEvent.pointerDown(holdButton());
    await waitFor(() => expect(sent).toHaveLength(1));
  });

  it('uses the interest the route stops, not the daily saving the server rounds to cents', () => {
    // 114.70 USDC on Lighter at 10.95% costs 0.03441 a day; the server rounds it to 0.03.
    const view = withFee(
      {
        ...rebalanceViews.twoBorrows,
        buckets: rebased(rebalanceViews.twoBorrows.buckets, {
          'USDC/LIGHTER': { cash: -114.7, equity: -114.7, borrow: 114.7, interestPerDayUsd: (114.7 * 0.1095) / 365 },
        }),
      },
      1,
    );
    const mix = { ...view.plan.routes.mix!, savesPerDayUsd: 0.03 };
    show({ ...view, plan: { ...view.plan, routes: { ...view.plan.routes, mix } } });
    expect(facts().Interest).toBe('$1.03 → $0.00 a month');
    expect(worth()).toEqual([{ text: 'Rebalance is recommended.', tone: 'act', sub: 'The fee equals 30 days of the interest it saves.' }]);
  });

  it('a Hyperliquid borrow under 10,000 USDC costs nothing, so it says so instead of weighing the fee', () => {
    show(rebalanceViews.hyperliquidFreeBorrow);
    expect(facts().Interest).toBe('$0.00 → $0.00 a month');
    // It used to read "the fee is more than 30 days of the interest it saves"
    // against that very $0.00 — a judgement divided by zero interest.
    expect(worth()).toEqual([
      { text: 'No interest payment yet. No transfer or rebalancing necessary.', tone: 'info' },
    ]);
  });

  it('no borrow says so', () => {
    show(rebalanceViews.accountB);
    expect(worth()).toEqual([{ text: 'No borrow. No transfer or rebalancing necessary.', tone: 'info' }]);
  });

  it('an unknown borrow rate shows rate unknown and no verdict', () => {
    const view = rebalanceViews.twoBorrows;
    show(withFee({ ...view, buckets: rebased(view.buckets, { 'USDC/LIGHTER': { ratePerYear: null, interestPerDayUsd: 0 } }) }, 20));
    expect(facts().Interest).toBe('rate unknown');
    expect(worth()).toEqual([]);
  });

  it('a free route gives no verdict', () => {
    show(withFee(at4c, 0));
    expect(facts().Fee).toBe('$0.00');
    expect(worth()).toEqual([]);
  });

  it('with every route blocked, the window gives no verdict', () => {
    const { plan } = at4c;
    const blocked = Object.fromEntries(
      Object.entries(plan.routes).map(([name, route]) => [name, route && { ...route, available: false, reason: 'Gate is closed for spot.' }]),
    ) as typeof plan.routes;
    show({ ...at4c, plan: { ...plan, routes: blocked } });
    expect(worth()).toEqual([]);
  });

  it('a $6M book: $5,502.59 against $170.62 a day is not worth it yet, and the month figures keep every digit', () => {
    show(rebalanceViews.bigBorrows);
    expect(facts().Interest).toBe('$5,118.60 → $0.00 a month');
    expect(facts().Fee).toBe('$5,502.59');
    expect(worth()).toEqual([{ text: 'Not worth it yet. The fee is more than 30 days of the interest it saves.', tone: 'warn' }]);
    cleanup();

    show(withFee(rebalanceViews.bigBorrows, 5118.6));
    expect(worth()).toEqual([{ text: 'Rebalance is recommended.', tone: 'act', sub: 'The fee equals 30 days of the interest it saves.' }]);
    cleanup();

    show(withFee(rebalanceViews.bigBorrows, 5118.61));
    expect(worth()).toEqual([{ text: 'Not worth it yet. The fee is more than 30 days of the interest it saves.', tone: 'warn' }]);
  });
});

describe('RebalanceModal moved amount', () => {
  async function finish(job: RebalanceJob) {
    const view = rebalanceViews.accountADone;
    const { next } = showPolled([{ ...view, job: { ...job, status: 'running' } }, { ...view, job }]);
    await next();
  }

  it.each([
    ['a Convert after an inserted Sell', 'Balanced', '$175.58', rebalanceViews.accountADone.job],
    ['the balancedDone fixture', 'Balanced', '$477.24', rebalanceViews.balancedDone.job],
    ['the mixDone fixture', 'Balanced', '$10,839.23', rebalanceViews.mixDone.job],
    ['the lighterConvertDone fixture', 'Balanced', '$498.00', rebalanceViews.lighterConvertDone.job],
    ['a toward-USDT loop, then a Convert after an inserted Sell', 'Balanced', '$1,742.44', TOWARD_USDT_MIX],
    ['$50 that all landed', 'Balanced', '$49.95', FULL_50],
    ['$50 that moved 29.97', 'Done', '$29.97', SHORT_50],
    ['$6M with a round of 4,896,572.39 unsold', 'Done', '$1,103,426.61', SHORT_6M],
    ['$6M Convert in 12 chunks of 500,000, each quoted 0.3% under spot', 'Balanced', '$5,982,000.00', QUOTE_6M],
    ['$6M Convert in 12 chunks that each landed 498,500.009, added before rounding', 'Balanced', '$5,982,000.10', QUOTE_6M_FRACTIONS],
    ['the short Account A fixture', 'Done', '$105.56', rebalanceViews.accountADoneShort.job],
    ['$6M round that sold held cash and left 1,958,628.96', 'Done', '$2,937,943.43', HELD_SHORT_6M],
    ['$50 round that sold held cash and left 20', 'Done', '$30.00', HELD_SHORT_50],
    ['a toward-USDT loop whose Sells cover held cash', 'Balanced', '$1,243.44', HELD_FULL],
    ['$6M round whose Sells cover held cash', 'Balanced', '$4,896,572.39', HELD_FULL_6M],
    ['a 1.6.1 round with no held cash on record', 'Balanced', '$50.00', HELD_LEGACY_50],
    ['a round Sell with no To Gate', 'Balanced', '$49.90', SELL_ONLY],
  ])('%s: chip %s, Moved %s', async (_, chip, moved, job) => {
    await finish(job);
    expect(screen.getByText(chip).className.includes('emerald')).toBe(chip === 'Balanced');
    expect(screen.queryByText(chip === 'Done' ? 'Balanced' : 'Done')).toBeNull();
    expect(facts().Moved).toBe(moved);
  });
});

describe('RebalanceModal money controls', () => {
  it('hold sends the picked route', async () => {
    const user = userEvent.setup();
    const sent = starts();
    show(rebalanceViews.exampleD, { holdMs: 50 });
    await user.click(allRoutes());
    await user.click(screen.getByRole('radio', { name: 'Convert' }));
    expect(within(dialog()).getByText('Convert')).toBeInTheDocument();
    fireEvent.pointerDown(holdButton());
    await waitFor(() => expect(sent).toEqual([{ route: 'convert', costUsd: rebalanceViews.exampleD.plan.routes.convert.costUsd }]));
  });

  it('the hold sends the cost of the route on screen', async () => {
    const sent = starts();
    show(withMixCost(4.12), { holdMs: 50 });
    expect(pickedRow()).toHaveTextContent('Fee $4.12');
    fireEvent.pointerDown(holdButton());
    await waitFor(() => expect(sent).toEqual([{ route: 'mix', costUsd: 4.12 }]));
  });

  it('a plan-changed refusal swaps the hold for Refresh route, so it cannot be sent twice', async () => {
    const sent = refuseStart(409, PLAN_CHANGED_ERROR);
    show(rebalanceViews.twoBorrows, { holdMs: 50 });
    fireEvent.pointerDown(holdButton());
    // The refusal makes the quote stale, which now swaps the hold out for
    // Refresh route — so a second submit is impossible, rather than merely
    // disabled. The guard itself (setAccepted(null)) is unchanged.
    expect(await screen.findByRole('button', { name: 'Refresh route' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Hold to rebalance' })).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(sent).toHaveLength(1);
  });

  it('after a plan-changed refusal, the new plan loads and Refresh route holds at its cost', async () => {
    const user = userEvent.setup();
    const shownCost = rebalanceViews.twoBorrows.plan.routes.mix!.costUsd;
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
    expect(await screen.findByRole('radio', { checked: true })).toBeInTheDocument();
    expect(pickedRow()).toHaveTextContent('Fee $0.46');
    fireEvent.pointerDown(holdButton());
    await waitFor(() => expect(pickedRow()).toHaveTextContent('Fee $4.12'));
    expect(screen.queryByRole('button', { name: 'Hold to rebalance' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Refresh route' }));
    expect(screen.queryByRole('button', { name: 'Refresh route' })).toBeNull();
    expect(holdButton()).toBeEnabled();
    fireEvent.pointerDown(holdButton());
    await waitFor(() =>
      expect(sent).toEqual([
        { route: 'mix', costUsd: shownCost },
        { route: 'mix', costUsd: 4.12 },
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
    await user.click(allRoutes());
    await user.click(within(rowOf('Spot loop')).getByText('Spot loop'));
    expect(screen.getByRole('radio', { name: 'Spot loop' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: 'Convert' })).toBeChecked();
    fireEvent.pointerDown(holdButton());
    await waitFor(() => expect(sent).toEqual([{ route: 'convert', costUsd: rebalanceViews.accountABlocked.plan.routes.convert.costUsd }]));
  });

  it('blocked row is disabled and shows its reason', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.accountABlocked);
    await user.click(allRoutes());
    expect(screen.getByRole('radio', { name: 'Spot loop' })).toBeDisabled();
    expect(rowOf('Spot loop')).toHaveTextContent('Gate paused USDC transfers.');
    expect(rowOf('Spot loop')).not.toHaveTextContent('5 rounds');
  });

  it('next run opens on recommended', async () => {
    const user = userEvent.setup();
    const sent = starts();
    const { next } = showPolled([rebalanceViews.accountA, rebalanceViews.accountADone], { holdMs: 50 });
    await user.click(allRoutes());
    await user.click(screen.getByRole('radio', { name: 'Convert' }));
    fireEvent.pointerDown(holdButton());
    await waitFor(() => expect(sent).toEqual([{ route: 'convert', costUsd: rebalanceViews.accountA.plan.routes.convert.costUsd }]));
    await next();
    expect(await screen.findByText('Balanced')).toBeInTheDocument();
    expect(facts().Route).toBe('Convert');
    cleanup();

    show(rebalanceViews.accountA);
    expect(screen.getAllByRole('radio')).toHaveLength(1);
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
    expect(screen.queryByRole('button', { name: 'Hold to rebalance' })).toBeNull();
  });

  it('halted buttons', async () => {
    show(rebalanceViews.accountAHalted);
    const resume = within(dialog()).getAllByRole('button', { name: 'Resume' });
    const abandon = within(dialog()).getAllByRole('button', { name: 'Abandon' });
    expect(resume.map((el) => el.tagName)).toEqual(['BUTTON']);
    expect(abandon.map((el) => el.tagName)).toEqual(['BUTTON']);
    expect(screen.queryByRole('button', { name: 'Hold to rebalance' })).toBeNull();
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
    for (const name of ['Resume', 'Abandon']) {
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
    expect(barRows('Where your money is')).toEqual([
      'USDT · CrossEx92.54',
      'USDC · Hyperliquid-92.71',
      'USDC · Gate57.52',
    ]);
    expect(within(dialog()).getByText('Stop the run. Funds stay where they are.')).toBeInTheDocument();
  });

  it('running toward USDT shows on the way', async () => {
    const running = rebalanceViews.exampleERunning;
    show({ ...running, job: { ...running.job, inTransit: { coin: 'USDC', qty: 745.44, at: 'MOVING' } } });
    expect(barRows('Now')).toContain('On the way745.44');
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
    const rows = barRows('Where your money is');
    expect(rows).toContain('On the way745.44');
    expect(rows.filter((row) => row.startsWith('Gate spot'))).toEqual([]);
    expect(within(dialog()).getByText('Abandon leaves 745.44 USDC in transit. It is not margin until it lands.')).toBeInTheDocument();
  });

  it('after abandon line', async () => {
    const user = userEvent.setup();
    const { onTransfer } = show(rebalanceViews.accountAAbandoned, { transfer: transferViews.noSpot });
    await waitFor(() => expect(line('Last run left 36.58 USDC in Gate spot.')).toBeInTheDocument());
    await user.click(within(dialog()).getByRole('button', { name: 'Transfer ▸' }));
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
    await waitFor(() => expect(line('Last run left 745.44 USDC in Gate spot.')).toBeInTheDocument());
    await user.click(within(dialog()).getByRole('button', { name: 'Transfer ▸' }));
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
    expect(screen.queryByText(/Last run left/)).toBeNull();
  });

  it('money a stopped move to Lighter left in Gate spot goes to the Lighter wallet', async () => {
    const user = userEvent.setup();
    const { onTransfer } = show(rebalanceViews.lighterAcrossAbandoned, { transfer: transferViews.noSpot });
    await waitFor(() => expect(line('Last run left 499.00 USDC in Gate spot.')).toBeInTheDocument());
    await user.click(within(dialog()).getByRole('button', { name: 'Transfer ▸' }));
    expect(onTransfer).toHaveBeenCalledWith('USDC', 'CROSSEX_LIGHTER');
  });

  it('a two-half Convert that stopped, then finished, reads as one Convert', async () => {
    const user = userEvent.setup();
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
    expect(screen.getByText('Balanced')).toBeInTheDocument();
    expect(facts()).toEqual({ Route: 'Convert', Moved: '$498.00', Took: '2s', Cost: '$2.00' });
    await user.click(screen.getByRole('button', { name: 'Show steps' }));
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

  it('D two route rows, with no Spot loop over 15 min', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.exampleD);
    expect(allRoutes().textContent).toBe('Show all routes');
    await user.click(allRoutes());
    expect(routeNames()).toEqual(['Spot loop, then Convert', 'Convert']);
  });

  it('D recommended is picked', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.exampleD);
    expect(within(dialog()).getByText('Spot loop, then Convert')).toBeInTheDocument();
    await user.click(allRoutes());
    expect(screen.getByRole('radio', { name: 'Spot loop, then Convert' })).toBeChecked();
  });

  it('D tag on mix only', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.exampleD);
    await user.click(allRoutes());
    const tags = within(dialog()).getAllByText('Recommended');
    expect(tags).toHaveLength(1);
    expect(rowOf('Spot loop, then Convert')).toContainElement(tags[0]);
  });

  it('A two route rows', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.accountA);
    await user.click(allRoutes());
    expect(routeNames()).toEqual(['Spot loop', 'Convert']);
  });

  it('A tag on spot loop', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.accountA);
    await user.click(allRoutes());
    const tags = within(dialog()).getAllByText('Recommended');
    expect(tags).toHaveLength(1);
    expect(rowOf('Spot loop')).toContainElement(tags[0]);
  });

  it('D mix row text', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.exampleD);
    await user.click(allRoutes());
    expect(rowOf('Spot loop, then Convert')).toHaveTextContent('about 13 min');
    expect(rowOf('Spot loop, then Convert').textContent).not.toMatch(/\d+ rounds?/);
    expect(rowOf('Spot loop, then Convert')).toHaveTextContent('$15.68');
  });

  it('E mix row text', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.exampleE);
    await user.click(allRoutes());
    expect(rowOf('Spot loop, then Convert')).toHaveTextContent('about 6.5 min');
    expect(rowOf('Spot loop, then Convert')).toHaveTextContent('$2.04');
  });

  it('clicking anywhere in a route row picks it and keeps every route open', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.exampleD);
    await user.click(allRoutes());
    await user.click(within(rowOf('Convert')).getByText('Convert'));
    expect(screen.getByRole('radio', { name: 'Convert' })).toBeChecked();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    await user.click(within(rowOf('Spot loop, then Convert')).getByText('Recommended'));
    expect(screen.getByRole('radio', { name: 'Spot loop, then Convert' })).toBeChecked();
    await user.click(within(rowOf('Convert')).getByText('instant'));
    expect(screen.getByRole('radio', { name: 'Convert' })).toBeChecked();
    await user.click(within(rowOf('Spot loop, then Convert')).getByText('about 13 min'));
    expect(screen.getByRole('radio', { name: 'Spot loop, then Convert' })).toBeChecked();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
  });

  it('convert pick redraws after bars', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.accountA);
    await user.click(allRoutes());
    await user.click(screen.getByRole('radio', { name: 'Convert' }));
    expect(barRows('After rebalance')).toEqual(['USDT · CrossEx28.54', 'USDC · Hyperliquid28.53', 'USDC · Gate0.00']);
  });

  it('five rounds shown', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.accountA);
    expect(await openSteps(user)).toHaveLength(5);
  });

  it('round 4 text', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.accountA);
    const row = (await openSteps(user))[3];
    expect(within(row).getByText('Buy 23.77 USDC, move 44.71 USDC to the CrossEx Hyperliquid wallet')).toBeInTheDocument();
  });

  it('round 4 sub text', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.accountA);
    const row = (await openSteps(user))[3];
    expect(within(row).getByText('44.66 arrives · borrow left 11.53')).toBeInTheDocument();
  });

  it('last round pays the borrow', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.accountA);
    const row = (await openSteps(user))[4];
    expect(within(row).getByText('40.10 arrives · borrow paid')).toBeInTheDocument();
  });

  it('no borrow shows arrives only', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.accountB);
    const [row] = await openSteps(user);
    expect(within(row).getByText('477.24 arrives')).toBeInTheDocument();
    expect(within(dialog()).queryByText(/borrow paid/)).toBeNull();
  });

  it('no borrow job row shows arrives only', async () => {
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
    expect(screen.getByText('Balanced')).toBeInTheDocument();
    const [row] = await openSteps(user);
    expect(within(row).getByText('477.24 arrives')).toBeInTheDocument();
    expect(within(dialog()).queryByText(/borrow paid/)).toBeNull();
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
    expect(within(rows[6]).getByText('Convert')).toBeInTheDocument();
    expect(within(rows[6]).getByText('instant')).toBeInTheDocument();
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
    expect(within(rows[3]).getByText('44.66 arrives · borrow left 11.53')).toBeInTheDocument();
  });

  it('each step names the wallet it moves to', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.lighterSplit);
    await openSteps(user);
    expect(stepTexts()).toEqual([
      ['Round 1', 'Buy 249.83 USDC, move it to the CrossEx Hyperliquid wallet', '249.78 arrives', 'about 2 min'],
      ['Convert', 'Convert 250.29 USDT to USDC in the CrossEx Lighter wallet', '249.78 arrives', 'instant'],
    ]);

    await user.click(allRoutes());
    await user.click(screen.getByRole('radio', { name: 'Spot loop' }));
    expect(stepTexts()).toEqual([
      ['Round 1', 'Buy 249.63 USDC, move it to the CrossEx Hyperliquid wallet', '249.58 arrives', 'about 2 min'],
      ['Round 2', 'Buy 250.61 USDC, move it to the CrossEx Lighter wallet', '249.58 arrives', 'about 4 min'],
    ]);
  });

  it('a running move from Hyperliquid to Lighter shows one round with its leg and time', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.lighterAcrossRunning);
    expect(facts()).toMatchObject({ Route: 'Spot loop', Round: '1 of 1' });
    expect(subs('Time left')).toEqual(['6m 40s gone']);
    await openSteps(user);
    expect(stepTexts()).toEqual([
      [
        'Round 1',
        'Move 500.00 USDC from the CrossEx Hyperliquid wallet to the CrossEx Lighter wallet',
        'Gate spot to the CrossEx Lighter wallet',
        '6m 40s of about 10 min',
      ],
    ]);
    expect(barRows('Now')).toEqual(expect.arrayContaining(['USDC · Lighter0.00', 'On the way499.00']));
  });
});

describe('RebalanceModal hovers and facts', () => {
  it('lists the recommended route first, then the rest by cost, with no rounds text', async () => {
    const user = userEvent.setup();
    const view = rebalanceViews.accountA;
    show({ ...view, plan: { ...view.plan, recommended: 'convert' } });
    await user.click(allRoutes());
    expect(routeNames()).toEqual(['Convert', 'Spot loop']);
    expect(dialog().textContent).not.toMatch(/\d+ rounds?/);
  });

  it('the step control names the margin the borrow holds', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.exampleD);
    expect((await hoverCard(user, 'Show steps')).text).toContain('Gate locks $1,922.48 of initial margin for your borrow.');
  });

  it('recommended hover', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.exampleD);
    expect((await hoverCard(user, 'Recommended')).text).toBe('Cheapest route that takes 15 min or less.');
    await user.click(allRoutes());
    expect((await hoverCard(user, 'Recommended')).text).toBe('Cheapest route that takes 15 min or less.');
  });

  it('blocked reason has no hover', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.accountABlocked);
    await user.click(allRoutes());
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
    await within(dialog()).findByRole('button', { name: 'Transfer ▸' });
    await check([
      ['Route', 'How the money moves. The fee includes Gate fees and the spot spread. Spot loop shows only when it costs less than Convert.'],
      ['Recommended', 'Cheapest route that takes 15 min or less.'],
      ['USDT · CrossEx', 'CrossEx wallet. Margin for Gate, Binance, OKX and Bybit legs.'],
      ['USDC · Hyperliquid', 'CrossEx wallet. Margin for Hyperliquid legs.'],
      ['USDC · Gate', 'CrossEx wallet. USDC left from a spot buy. Still margin. Rebalance empties it.'],
      ['Frees', 'Initial margin the repaid borrow no longer locks.'],
      ['Interest', "Borrow interest for 30 days at today's rates, now and after this rebalance."],
      ['Gate spot', 'Not margin.'],
    ]);
    await user.click(allRoutes());
    await check([
      [
        'Spot loop',
        'Buy USDC in CrossEx, move it through Gate spot into the CrossEx Hyperliquid wallet. Gate has no direct transfer between CrossEx wallets. Repeats in rounds.',
      ],
      ['Convert', 'Instant swap between your CrossEx USDT and USDC wallets. 0.2% fee.'],
    ]);
    cleanup();

    show(rebalanceViews.exampleD);
    await user.click(allRoutes());
    await check([
      ['Spot loop, then Convert', 'Spot loop for up to 6 rounds, then Convert the rest.'],
    ]);
    cleanup();

    show(rebalanceViews.accountARunning);
    await check([
      ['Now', 'Equity = cash + unrealized PnL.'],
      ['On the way', 'In transit through Gate spot. Not margin.'],
    ]);
    cleanup();

    show(rebalanceViews.accountAHalted);
    await check([['Gate spot', 'Not margin.']]);
  }, 60_000);

  it('hovers for a move into two wallets', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.lighterSplit);
    expect((await hoverCard(user, 'USDC · Lighter')).text).toBe('CrossEx wallet. Margin for Lighter legs.');
    await user.click(allRoutes());
    expect((await hoverCard(user, 'Spot loop')).text).toBe(
      'Buy USDC in CrossEx, move it through Gate spot into the CrossEx Hyperliquid wallet and the CrossEx Lighter wallet. Gate has no direct transfer between CrossEx wallets. Repeats in rounds.',
    );
  });

  it('hovers for a move from Hyperliquid to Lighter', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.lighterAcross);
    if (screen.queryByRole('button', { name: 'Show all routes' })) await user.click(allRoutes());
    expect((await hoverCard(user, 'Spot loop')).text).toBe(
      'Move USDC from the CrossEx Hyperliquid wallet through Gate spot into the CrossEx Lighter wallet. Gate has no direct transfer between CrossEx wallets. Repeats in rounds.',
    );
    expect((await hoverCard(user, 'Convert')).text).toBe(
      'Instant swap between your CrossEx USDT and USDC wallets. 0.2% fee. USDC between Hyperliquid and Lighter swaps twice, through USDT.',
    );
  });




  it('has no lead line, but still names what a picked route that repays no borrow frees and saves', async () => {
    const user = userEvent.setup();
    show(withConvertAfter(-112, 0));
    expect(screen.queryByText(/^Moves \$/)).toBeNull();
    await user.click(allRoutes());
    await user.click(screen.getByRole('radio', { name: 'Convert' }));
    expect(screen.queryByText(/^Moves \$/)).toBeNull();
    expect(facts().Frees).toBe('$0.00');
    expect(dialog().textContent).not.toMatch(/repays [\d$]|interest stops|No borrow|no borrow to repay|no interest to stop/);
    cleanup();

    show(rebalanceViews.accountB);
  });

  it('the Frees and Interest facts change with the route the trader picks, with no lead line', async () => {
    const user = userEvent.setup();
    show(withConvertAfter(-12, 20));
    expect(screen.queryByText(/^Moves \$/)).toBeNull();
    await user.click(allRoutes());
    await user.click(screen.getByRole('radio', { name: 'Convert' }));
    expect(screen.queryByText(/^Moves \$/)).toBeNull();
    expect(facts().Frees).toBe('$20.00');
    await user.click(screen.getByRole('radio', { name: 'Spot loop, then Convert' }));
  });







});

describe('RebalanceModal Gate spot lines', () => {
  it('one spot line per coin', async () => {
    const user = userEvent.setup();
    const { onTransfer } = show(rebalanceViews.accountB, { transfer: transferViews.spotBoth });
    await waitFor(() => expect(within(dialog()).getAllByRole('button', { name: 'Transfer ▸' })).toHaveLength(2));
    const lines = [...dialog().querySelectorAll('p')]
      .map((p) => p.textContent)
      .filter((text) => text?.startsWith('Gate spot has'));
    expect(lines).toEqual([
      'Gate spot has 318.42 USDT. Move it in to use it.',
      'Gate spot has 25.00 USDC. Move it in to use it.',
    ]);
    await user.click(within(dialog()).getAllByRole('button', { name: 'Transfer ▸' })[1]);
    expect(onTransfer).toHaveBeenCalledWith('USDC', 'CROSSEX_HYPERLIQUID');
  });

  it('spot money line', async () => {
    const user = userEvent.setup();
    const { onTransfer } = show(rebalanceViews.accountB, { transfer: transferViews.accountB });
    await waitFor(() => expect(line('Gate spot has 318.42 USDT. Move it in to use it.')).toBeInTheDocument());
    await user.click(within(dialog()).getByRole('button', { name: 'Transfer ▸' }));
    expect(onTransfer).toHaveBeenCalledWith('USDT', 'CROSSEX');
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
    expect(within(dialog()).queryByRole('button', { name: 'Transfer ▸' })).toBeNull();
    expect(within(dialog()).queryByText(/Gate spot has/)).toBeNull();
  });
});
