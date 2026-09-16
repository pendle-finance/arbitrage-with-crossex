import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAccount, usePositions, useTransfer } from '../api/queries';
import type { CrossexAccount, PositionsResponse, RebalanceStep, RebalanceView, TransferView } from '../api/types';
import { accountBodies, accountHandler, makeCrossexPosition, positionsBodies, REBALANCE_NOW, rebalanceViews, rebased } from '../test/fixtures';
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

const holdButton = () => screen.getByRole('button', { name: 'Hold to rebalance' });

const changeRoute = () => screen.getByRole('button', { name: /Change route/ });

function starts(): { route: string }[] {
  const sent: { route: string }[] = [];
  server.use(
    http.post('/api/rebalance', async ({ request }) => {
      sent.push((await request.json()) as { route: string });
      return HttpResponse.json(env({ id: rebalanceViews.accountADone.job.id }));
    }),
  );
  return sent;
}

function refuseStart(status: number, error: Record<string, unknown>) {
  server.use(http.post('/api/rebalance', () => HttpResponse.json({ ok: false, error }, { status })));
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
  await user.click(screen.getByRole('button', { name: 'Show the steps' }));
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

const hypeLeg = (symbol: string, positionSide: 'LONG' | 'SHORT') =>
  makeCrossexPosition({
    symbol,
    positionSide,
    positionValue: '2000',
    markPrice: '44.35',
    maintenanceMargin: '20',
    initialMargin: '40',
  });

const HYPE_PAIR: PositionsResponse = {
  positions: [hypeLeg('GATE_FUTURE_HYPE_USDT', 'LONG'), hypeLeg('HYPERLIQUID_FUTURE_HYPE_USDC', 'SHORT')],
  exposure: [
    {
      base: 'HYPE',
      legs: [
        { symbol: 'GATE_FUTURE_HYPE_USDT', exchange: 'GATE', quote: 'USDT', side: 'LONG', qty: 45.1, value: 2000 },
        { symbol: 'HYPERLIQUID_FUTURE_HYPE_USDC', exchange: 'HYPERLIQUID', quote: 'USDC', side: 'SHORT', qty: 45.1, value: 2000 },
      ],
      longValue: 2000,
      shortValue: 2000,
      netValue: 0,
      grossValue: 4000,
      neutral: true,
      singleLeg: false,
    },
  ],
};

const HYPE_ACCOUNT: CrossexAccount = {
  ...accountBodies.accountA,
  marginBalance: '145.91',
  initialMargin: '109.41',
  maintenanceMargin: '54.705',
};

const FAR_AFTER_ACCOUNT: CrossexAccount = {
  ...accountBodies.accountA,
  marginBalance: '2140',
  maintenanceMargin: '40',
  assets: accountBodies.accountA.assets.map((asset) => {
    if (asset.exchangeType === 'CROSSEX') return { ...asset, balance: '2000', equity: '2000' };
    if (asset.exchangeType === 'HYPERLIQUID') return { ...asset, balance: '-1000', equity: '-1000' };
    return asset;
  }),
};

const FAR_AFTER_VIEW: RebalanceView = {
  ...rebalanceViews.accountA,
  buckets: rebalanceViews.accountA.buckets.map((bucket) => {
    if (bucket.venue === 'CROSSEX') return { ...bucket, cash: 2000, equity: 2000 };
    if (bucket.venue === 'HYPERLIQUID') return { ...bucket, cash: -1000, equity: -1000, borrow: 1000 };
    return bucket;
  }),
  plan: {
    ...rebalanceViews.accountA.plan,
    routes: {
      ...rebalanceViews.accountA.plan.routes,
      loop: {
        ...rebalanceViews.accountA.plan.routes.loop!,
        after: [
          { coin: 'USDT', venue: 'CROSSEX', cash: 1000, equity: 1000 },
          { coin: 'USDC', venue: 'HYPERLIQUID', cash: 0, equity: 0 },
          { coin: 'USDC', venue: 'GATE', cash: 0, equity: 0 },
        ],
      },
    },
  },
};

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
    expect(changeRoute()).toBeInTheDocument();
    expect(holdButton()).toBeInTheDocument();
  });

  it('opens with the route collapsed, its cost and time beside it', async () => {
    show(rebalanceViews.twoBorrows);
    expect(within(dialog()).getByText('Spot loop, then Convert')).toBeInTheDocument();
    expect(within(dialog()).getByText('Recommended')).toBeInTheDocument();
    expect(within(dialog()).getByText('about 2 min · $0.46')).toBeInTheDocument();
    expect(changeRoute().textContent).toBe('Change route · 1 more');
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });

  it('opens every route inline in the same modal', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.twoBorrows);
    await user.click(changeRoute());
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(within(dialog()).getByRole('radiogroup', { name: 'Route' })).toBeInTheDocument();
    expect(screen.getAllByRole('radio').map((radio) => radio.getAttribute('value') ?? radio.id)).toHaveLength(2);
    expect(screen.getByRole('radio', { name: 'Spot loop, then Convert' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Convert' })).toBeInTheDocument();
  });

  it('greys a hidden route and shows its reason in place of its time', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.hiddenRoute);
    await user.click(changeRoute());
    const row = rowOf('Spot loop');
    expect(screen.getByRole('radio', { name: 'Spot loop' })).toBeDisabled();
    expect(row.textContent).toContain('Gate paused USDC transfers.');
    expect(row.textContent).not.toContain('about');
  });

  it('closes the route list again with one control', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.twoBorrows);
    await user.click(changeRoute());
    await user.click(screen.getByRole('button', { name: 'Keep the recommended one' }));
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(within(dialog()).getByText('about 2 min · $0.46')).toBeInTheDocument();
  });

  it('hides Change route when one route is on the wire', async () => {
    show(rebalanceViews.oneRouteOnly);
    expect(screen.queryByRole('button', { name: /Change route/ })).toBeNull();
    expect(within(dialog()).getByText('Convert')).toBeInTheDocument();
    expect(within(dialog()).getByText('instant · $0.02')).toBeInTheDocument();
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

  it('gives a wallet with no position share three numbers and a gold mark at zero', async () => {
    show(rebalanceViews.accountARunning);
    const row = screen.getByRole('group', { name: 'Now' }).querySelector('[data-bar-row="USDC/GATE"]') as HTMLElement;
    expect(row.querySelector('[data-bar-target]')).not.toBeNull();
    fireEvent.mouseMove(row.querySelector('[data-bar-hit]') as HTMLElement, { clientX: 100, clientY: 40 });
    const tip = screen.getByRole('tooltip');
    expect(tip.textContent).toMatch(/Cash.*Unrealized PnL.*Balanced equity/);
    const numbers = [...tip.querySelectorAll('.num')].map((el) => el.textContent);
    expect(numbers).toHaveLength(3);
    expect(numbers[2]).toBe('0.00');
  });

  it('shows Frees, Saves and the liquidation change as three labelled facts', async () => {
    show(rebalanceViews.twoBorrows, { account: accountBodies.ethTwoVenues, positions: positionsBodies.ethTwoVenues });
    await screen.findByText(/→/);
    const shown = facts();
    expect(shown.Frees).toBe('$48.80');
    expect(shown.Saves).toBe('$0.04 a day');
    expect(shown.Liquidation).toMatch(/^~\$[\d,]+ → /);
    expect(subs('Frees')).toEqual(['margin the repay returns']);
    expect(subs('Saves')).toEqual(['Lighter interest stops']);
    expect(subs('Liquidation')).toEqual(['ETH, if only ETH moves']);
  });

  it('folds the step list behind one control, over one hold to confirm button', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.twoBorrows);
    expect(dialog().querySelector('ol')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Hold to rebalance' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Show the steps' }));
    expect(within(dialog()).getAllByRole('listitem')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Hide the steps' }));
    expect(dialog().querySelector('ol')).toBeNull();
  });

  it('carries only what the decision needs, never Borrowing or Interest paid', async () => {
    show(rebalanceViews.twoBorrows, { account: accountBodies.ethTwoVenues, positions: positionsBodies.ethTwoVenues });
    await screen.findByText(/→/);
    expect(screen.queryByText('Borrowing')).toBeNull();
    expect(screen.queryByText('Interest paid')).toBeNull();
    expect(screen.queryByText('Interest now')).toBeNull();
    expect(Object.keys(facts())).toEqual(['Frees', 'Saves', 'Liquidation']);
  });

  it('explains a round and why more than one in the step control hover', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.twoBorrows);
    await user.hover(screen.getByRole('button', { name: 'Show the steps' }));
    const card = await screen.findByRole('tooltip');
    expect(card.textContent).toBe(
      'A round is one trip through Gate spot, capped by your free margin. Gate holds $48.80 of initial margin against your borrow. Each round repays borrow, so the next is bigger.',
    );
  });

  it('disables the hold when the picked route moves money differently, until the trader accepts', async () => {
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
    expect(holdButton()).toBeDisabled();
    expect(screen.getByRole('alert').textContent).toBe('The plan changed. Check the new route before you rebalance.');
    await user.click(screen.getByRole('button', { name: 'Use the new plan' }));
    expect(holdButton()).toBeEnabled();
  });

  it('disables the hold when the plan went stale on a cost change, until the trader accepts', async () => {
    const user = userEvent.setup();
    const { next } = showPolled([rebalanceViews.twoBorrows, withMixCost(4.12)]);
    expect(within(dialog()).getByText('about 2 min · $0.46')).toBeInTheDocument();
    expect(holdButton()).toBeEnabled();
    await next();
    expect(within(dialog()).getByText('about 2 min · $4.12')).toBeInTheDocument();
    expect(holdButton()).toBeDisabled();
    expect(screen.getByRole('alert').textContent).toBe('The plan changed. Check the new route before you rebalance.');
    await user.click(screen.getByRole('button', { name: 'Use the new plan' }));
    expect(holdButton()).toBeEnabled();
  });

  it('disables the hold when the plan went stale on a new recommended route, until the trader accepts', async () => {
    const user = userEvent.setup();
    const view = rebalanceViews.twoBorrows;
    const { next } = showPolled([view, { ...view, plan: { ...view.plan, recommended: 'convert' } }]);
    await user.click(changeRoute());
    await user.click(screen.getByRole('radio', { name: 'Convert' }));
    expect(holdButton()).toBeEnabled();
    await next();
    expect(holdButton()).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Use the new plan' }));
    expect(holdButton()).toBeEnabled();
  });

  it('a cost change under one cent keeps the hold live', async () => {
    const { next } = showPolled([rebalanceViews.twoBorrows, withMixCost(0.463)]);
    await next();
    expect(within(dialog()).getByText('about 2 min · $0.46')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(holdButton()).toBeEnabled();
  });

  it('hold waits for a moving transfer or a running deal', async () => {
    show(rebalanceViews.twoBorrows, { transfer: transferViews.moving });
    expect(await within(dialog()).findByText('Waits for the transfer')).toBeInTheDocument();
    expect(holdButton()).toBeDisabled();
    cleanup();

    show(rebalanceViews.twoBorrows, { transfer: transferViews.lockDeal });
    expect(await within(dialog()).findByText('Waits for the deal')).toBeInTheDocument();
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
    const done: RebalanceView = {
      ...rebalanceViews.accountARunning,
      job: { ...rebalanceViews.accountARunning.job, status: 'done' },
    };
    const { onClose, next } = showPolled([rebalanceViews.accountARunning, done]);
    expect(screen.getByText('Running')).toBeInTheDocument();
    await next();
    expect(screen.getByText('Balanced')).toBeInTheDocument();
    expect(facts()).toEqual({ Route: 'Spot loop', Moved: '$175.88', Took: '4m 18s', Cost: '$0.26' });
    expect(barRows('Now')).toContain('USDT · CrossEx92.54');
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('RebalanceModal money controls', () => {
  it('hold sends the picked route', async () => {
    const user = userEvent.setup();
    const sent = starts();
    show(rebalanceViews.exampleD, { holdMs: 50 });
    await user.click(changeRoute());
    await user.click(screen.getByRole('radio', { name: 'Convert' }));
    expect(screen.getByRole('radio', { name: 'Convert' })).toBeChecked();
    fireEvent.pointerDown(holdButton());
    await waitFor(() => expect(sent).toEqual([{ route: 'convert' }]));
  });

  it('clicking a blocked row picks nothing', async () => {
    const user = userEvent.setup();
    const sent = starts();
    show(rebalanceViews.accountABlocked, { holdMs: 50 });
    await user.click(changeRoute());
    await user.click(within(rowOf('Spot loop')).getByText('Spot loop'));
    expect(screen.getByRole('radio', { name: 'Spot loop' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: 'Convert' })).toBeChecked();
    fireEvent.pointerDown(holdButton());
    await waitFor(() => expect(sent).toEqual([{ route: 'convert' }]));
  });

  it('blocked row is disabled and shows its reason', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.accountABlocked);
    await user.click(changeRoute());
    expect(screen.getByRole('radio', { name: 'Spot loop' })).toBeDisabled();
    expect(rowOf('Spot loop')).toHaveTextContent('Gate paused USDC transfers.');
    expect(rowOf('Spot loop')).not.toHaveTextContent('5 rounds');
  });

  it('next run opens on recommended', async () => {
    const user = userEvent.setup();
    const sent = starts();
    const { next } = showPolled([rebalanceViews.accountA, rebalanceViews.accountADone], { holdMs: 50 });
    await user.click(changeRoute());
    await user.click(screen.getByRole('radio', { name: 'Convert' }));
    fireEvent.pointerDown(holdButton());
    await waitFor(() => expect(sent).toEqual([{ route: 'convert' }]));
    await next();
    expect(await screen.findByText('Balanced')).toBeInTheDocument();
    expect(facts().Route).toBe('Convert');
    cleanup();

    show(rebalanceViews.accountA);
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(within(dialog()).getByText('Spot loop')).toBeInTheDocument();
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
        haltReason: 'Convert quote was more than 0.3% under market.',
        steps: [done.job.steps[0], { ...done.job.steps[1], qty: null, status: 'pending', startedAt: null, doneAt: null }],
      },
    };
    const { next } = showPolled([halted, done]);
    expect(screen.getByRole('alert').textContent).toBe('Stopped at Convert.Convert quote was more than 0.3% under market.');
    await next();
    expect(screen.getByText('Balanced')).toBeInTheDocument();
    expect(facts()).toEqual({ Route: 'Convert', Moved: '$500.00', Took: '2s', Cost: '$2.00' });
    await user.click(screen.getByRole('button', { name: 'Show the steps' }));
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
    expect(changeRoute().textContent).toBe('Change route · 1 more');
    await user.click(changeRoute());
    expect(routeNames()).toEqual(['Spot loop, then Convert', 'Convert']);
  });

  it('D recommended is picked', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.exampleD);
    expect(within(dialog()).getByText('Spot loop, then Convert')).toBeInTheDocument();
    await user.click(changeRoute());
    expect(screen.getByRole('radio', { name: 'Spot loop, then Convert' })).toBeChecked();
  });

  it('D tag on mix only', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.exampleD);
    await user.click(changeRoute());
    const tags = within(dialog()).getAllByText('Recommended');
    expect(tags).toHaveLength(1);
    expect(rowOf('Spot loop, then Convert')).toContainElement(tags[0]);
  });

  it('A two route rows', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.accountA);
    await user.click(changeRoute());
    expect(routeNames()).toEqual(['Spot loop', 'Convert']);
  });

  it('A tag on spot loop', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.accountA);
    await user.click(changeRoute());
    const tags = within(dialog()).getAllByText('Recommended');
    expect(tags).toHaveLength(1);
    expect(rowOf('Spot loop')).toContainElement(tags[0]);
  });

  it('D mix row text', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.exampleD);
    await user.click(changeRoute());
    expect(rowOf('Spot loop, then Convert')).toHaveTextContent('about 13 min');
    expect(rowOf('Spot loop, then Convert').textContent).not.toMatch(/\d+ rounds?/);
    expect(rowOf('Spot loop, then Convert')).toHaveTextContent('$15.68');
  });

  it('E mix row text', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.exampleE);
    await user.click(changeRoute());
    expect(rowOf('Spot loop, then Convert')).toHaveTextContent('about 6.5 min');
    expect(rowOf('Spot loop, then Convert')).toHaveTextContent('$2.04');
  });

  it('clicking row text picks the route', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.exampleD);
    await user.click(changeRoute());
    await user.click(within(rowOf('Convert')).getByText('Convert'));
    expect(screen.getByRole('radio', { name: 'Convert' })).toBeChecked();
    await user.click(within(rowOf('Spot loop, then Convert')).getByText('Recommended'));
    expect(screen.getByRole('radio', { name: 'Spot loop, then Convert' })).toBeChecked();
    await user.click(within(rowOf('Convert')).getByText('Convert'));
    await user.click(within(rowOf('Spot loop, then Convert')).getByText('about 13 min'));
    expect(screen.getByRole('radio', { name: 'Spot loop, then Convert' })).toBeChecked();
  });

  it('convert pick redraws after bars', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.accountA);
    await user.click(changeRoute());
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

    await user.click(changeRoute());
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
    await user.click(changeRoute());
    expect(routeNames()).toEqual(['Convert', 'Spot loop']);
    expect(dialog().textContent).not.toMatch(/\d+ rounds?/);
  });

  it('the step control names the margin the borrow holds', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.exampleD);
    expect((await hoverCard(user, 'Show the steps')).text).toContain('Gate holds $1,922.48 of initial margin against your borrow.');
  });

  it('recommended hover', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.exampleD);
    expect((await hoverCard(user, 'Recommended')).text).toBe('Cheapest route that takes 15 min or less.');
    await user.click(changeRoute());
    expect((await hoverCard(user, 'Recommended')).text).toBe('Cheapest route that takes 15 min or less.');
  });

  it('blocked reason has no hover', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.accountABlocked);
    await user.click(changeRoute());
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
      ['Route', 'How the money moves. Cost includes Gate fees and spot spread. Spot loop shows only when it costs less than Convert.'],
      ['Recommended', 'Cheapest route that takes 15 min or less.'],
      ['USDT · CrossEx', 'CrossEx wallet. Margin for Gate, Binance, OKX and Bybit legs.'],
      ['USDC · Hyperliquid', 'CrossEx wallet. Margin for Hyperliquid legs.'],
      ['USDC · Gate', 'CrossEx wallet. USDC left from a spot buy. Still margin. Rebalance empties it.'],
      ['Frees', 'Initial margin the repaid borrow no longer locks.'],
      ['Saves', 'Borrow interest per day this stops.'],
      ['Gate spot', 'Not margin.'],
    ]);
    await user.click(changeRoute());
    await check([
      [
        'Spot loop',
        'Buy USDC in CrossEx, move it through Gate spot into the CrossEx Hyperliquid wallet. Gate has no direct transfer between CrossEx wallets. Repeats in rounds.',
      ],
      ['Convert', 'Instant swap between your CrossEx USDT and USDC wallets. 0.2% fee.'],
    ]);
    cleanup();

    show(rebalanceViews.exampleD);
    await user.click(changeRoute());
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
    await user.click(changeRoute());
    expect((await hoverCard(user, 'Spot loop')).text).toBe(
      'Buy USDC in CrossEx, move it through Gate spot into the CrossEx Hyperliquid wallet and the CrossEx Lighter wallet. Gate has no direct transfer between CrossEx wallets. Repeats in rounds.',
    );
  });

  it('hovers for a move from Hyperliquid to Lighter', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.lighterAcross);
    if (screen.queryByRole('button', { name: /Change route/ })) await user.click(changeRoute());
    expect((await hoverCard(user, 'Spot loop')).text).toBe(
      'Move USDC from the CrossEx Hyperliquid wallet through Gate spot into the CrossEx Lighter wallet. Gate has no direct transfer between CrossEx wallets. Repeats in rounds.',
    );
    expect((await hoverCard(user, 'Convert')).text).toBe(
      'Instant swap between your CrossEx USDT and USDC wallets. 0.2% fee. USDC between Hyperliquid and Lighter swaps twice, through USDT.',
    );
  });

  it('frees fact', async () => {
    show(rebalanceViews.accountA);
    expect(within(dialog()).getByText('Spot loop')).toBeInTheDocument();
    expect(facts().Frees).toBe('$29.41');
    expect(subs('Frees')).toEqual(['margin the repay returns']);
  });

  it('saves fact', async () => {
    show(rebalanceViews.accountA);
    expect(facts().Saves).toBe('$0.00 a day');
    expect(subs('Saves')).toEqual(['no interest to stop']);
  });

  it('a borrow in a wallet the plan pays into shows what it frees', async () => {
    show(rebalanceViews.lighterSplit);
    expect(subs('Frees')).toEqual(['no borrow to repay']);
    expect(subs('Saves')).toEqual(['no interest to stop']);
    cleanup();

    const view = rebalanceViews.lighterSplit;
    show({
      ...view,
      buckets: rebased(view.buckets, { 'USDC/LIGHTER': { cash: -50, equity: -50, borrow: 50, interestPerDayUsd: 0.02 } }),
    });
    expect(subs('Frees')).toEqual(['margin the repay returns']);
    expect(subs('Saves')).toEqual(['Lighter interest stops']);
  });

  it('a picked route that repays no borrow claims no repay and no interest that stops', async () => {
    const user = userEvent.setup();
    show(withConvertAfter(-112, 0));
    expect(line('Moves $868.42 and repays 244.00 USDC across two wallets.')).toBeInTheDocument();
    await user.click(changeRoute());
    await user.click(screen.getByRole('radio', { name: 'Convert' }));
    expect(line('Moves $868.42 so each wallet matches its position share.')).toBeInTheDocument();
    expect(facts().Frees).toBe('$0.00');
    expect(subs('Frees')).toEqual(['repays no borrow']);
    expect(subs('Saves')).toEqual(['stops no interest']);
    expect(dialog().textContent).not.toMatch(/repays [\d$]|interest stops|No borrow|no borrow to repay|no interest to stop/);
    cleanup();

    show(rebalanceViews.accountB);
    expect(subs('Frees')).toEqual(['no borrow to repay']);
    expect(subs('Saves')).toEqual(['no interest to stop']);
  });

  it('the lead and the Saves line change with the route the trader picks', async () => {
    const user = userEvent.setup();
    show(withConvertAfter(-12, 20));
    expect(line('Moves $868.42 and repays 244.00 USDC across two wallets.')).toBeInTheDocument();
    expect(subs('Saves')).toEqual(['Lighter interest stops']);
    await user.click(changeRoute());
    await user.click(screen.getByRole('radio', { name: 'Convert' }));
    expect(line('Moves $868.42 and repays 100.00 USDC on Hyperliquid.')).toBeInTheDocument();
    expect(facts().Frees).toBe('$20.00');
    expect(subs('Frees')).toEqual(['margin the repay returns']);
    expect(subs('Saves')).toEqual(['no interest to stop']);
    await user.click(screen.getByRole('radio', { name: 'Spot loop, then Convert' }));
    expect(line('Moves $868.42 and repays 244.00 USDC across two wallets.')).toBeInTheDocument();
    expect(subs('Saves')).toEqual(['Lighter interest stops']);
  });

  it('no liquidation without a position', async () => {
    serve({ account: HYPE_ACCOUNT, positions: NO_POSITIONS });
    renderWithClient(
      <>
        <RebalanceModal view={rebalanceViews.accountA} onClose={vi.fn()} />
        <Loaded />
      </>,
    );
    await screen.findByText('reads loaded');
    expect(facts().Frees).toBe('$29.41');
    expect(facts().Liquidation).toBe('none');
    expect(subs('Liquidation')).toEqual([]);
  });

  it('liquidation before and after', async () => {
    show(rebalanceViews.accountA, { account: HYPE_ACCOUNT, positions: HYPE_PAIR });
    const pattern = /^(~\$[\d,.]+) → (~\$[\d,.]+)$/;
    await waitFor(() => expect(facts().Liquidation).toMatch(pattern));
    const [, before, after] = pattern.exec(facts().Liquidation) ?? [];
    expect(before).not.toBe(after);
    expect(subs('Liquidation')).toEqual(['HYPE, if only HYPE moves']);
  });

  it('liquidation after reads none when far', async () => {
    show(FAR_AFTER_VIEW, { account: FAR_AFTER_ACCOUNT, positions: HYPE_PAIR });
    await waitFor(() => expect(facts().Liquidation).toMatch(/^~\$[\d,.]+ → none$/));
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
