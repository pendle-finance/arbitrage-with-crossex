import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { RebalanceBucket } from '../api/types';
import { rebalanceViews, rebased } from '../test/fixtures';
import { borrowFacts, defaultGoal, Facts, isNotWorthIt, isWorthIt, pickedRoute, roundOf, shownKeys, stopsPerDayOf, targetsOf, worthLine } from './RebalanceHovers';

function show(buckets: RebalanceBucket[]) {
  return render(<Facts items={borrowFacts(buckets)} />);
}

const withBorrow = (buckets: RebalanceBucket[], key: string, borrow: number, interestPerDayUsd: number) =>
  rebased(buckets, { [key]: { cash: -borrow, equity: -borrow, borrow, interestPerDayUsd } });

function fact(label: string): HTMLElement {
  const dt = screen.getByText(label).closest('dt');
  return dt?.parentElement as HTMLElement;
}

const lines = (label: string): string[] => [...fact(label).querySelectorAll('dd')].map((dd) => dd.textContent ?? '');

/** The per-wallet lines sit in a hover on the figure, never under it. */
async function hoverRows(label: string): Promise<{ rows: { name: string; value: string }[]; grid: Element | null }> {
  expect(fact(label).querySelector('[data-fact-rows]')).toBeNull();
  const trigger = within(fact(label).querySelector('dd') as HTMLElement).queryByRole('button');
  if (!trigger) return { rows: [], grid: null };
  const user = userEvent.setup();
  await user.hover(trigger);
  const card = await screen.findByRole('tooltip');
  const grid = card.querySelector(`[data-fact-rows]`);
  const spans = [...(grid?.querySelectorAll('span') ?? [])];
  const out: { name: string; value: string }[] = [];
  for (let i = 0; i < spans.length; i += 2) out.push({ name: spans[i].textContent ?? '', value: spans[i + 1].textContent ?? '' });
  const kept = grid?.cloneNode(true) as Element | null;
  await user.unhover(trigger);
  await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  return { rows: out, grid: kept };
}

const rows = async (label: string) => (await hoverRows(label)).rows;

describe('borrow facts', () => {
  it('facts with no borrow: three facts, no Liquidation, no hovers on the figures', () => {
    const { container } = show(rebalanceViews.accountB.buckets);

    expect([...container.querySelectorAll('dt')].map((dt) => dt.textContent)).toEqual(['Borrowing', 'Interest now', 'Interest paid']);
    expect(lines('Borrowing')).toEqual(['none']);
    expect(lines('Interest now')[0]).toBe('$0.00 an hour');
    expect(lines('Interest paid')).toEqual(['$0.00']);
    for (const label of ['Borrowing', 'Interest now', 'Interest paid']) {
      expect(within(fact(label).querySelector('dd') as HTMLElement).queryByRole('button')).toBeNull();
    }
  });

  it('one borrowing wallet', () => {
    show(rebalanceViews.oneBorrow.buckets);

    expect(lines('Borrowing')).toEqual(['132.00 USDC', 'USDC · Lighter']);
  });

  it('two borrowing wallets', async () => {
    show(rebalanceViews.twoBorrows.buckets);

    expect(lines('Borrowing')).toEqual(['244.00 USDC']);
    expect(await rows('Borrowing')).toEqual([
      { name: 'Lighter', value: '132.00' },
      { name: 'Hyperliquid', value: '112.00' },
    ]);
  });

  it('two borrowing wallets render aligned rows in the hover', async () => {
    show(rebalanceViews.twoBorrows.buckets);

    const borrowingValues = [...((await hoverRows('Borrowing')).grid?.querySelectorAll('span:nth-child(2n)') ?? [])];
    const interestValues = [...((await hoverRows('Interest now')).grid?.querySelectorAll('span:nth-child(2n)') ?? [])];
    expect(borrowingValues).toHaveLength(2);
    expect(interestValues).toHaveLength(2);
    for (const span of borrowingValues) expect(span.className).toContain('text-right');
    for (const span of interestValues) expect(span.className).toContain('text-right');
  });

  it('a figure with a hover keeps its colour: amber for a borrow and its interest, white for interest paid', () => {
    show(rebased(rebalanceViews.twoBorrows.buckets, { 'USDC/LIGHTER': { interestPaidUsd: 1.55 } }));

    const figure = (label: string) => within(fact(label).querySelector('dd') as HTMLElement).getByRole('button').firstElementChild;
    expect(figure('Borrowing')).toHaveClass('text-amber-300');
    expect(figure('Interest now')).toHaveClass('text-amber-300');
    expect(figure('Interest paid')).toHaveClass('text-ink-100');
  });

  it('interest per wallet', async () => {
    show(rebalanceViews.twoBorrows.buckets);

    expect(lines('Interest now')).toEqual(['$0.0017 an hour']);
    expect(await rows('Interest now')).toEqual([
      { name: 'Lighter', value: '$0.0017 an hour' },
      { name: 'Hyperliquid', value: '$0.00 an hour' },
    ]);
  });

  it('a Hyperliquid borrow under 10,000 USDC costs $0.00 an hour', async () => {
    show(rebalanceViews.hyperliquidFreeBorrow.buckets);

    expect(lines('Borrowing')).toEqual(['4,200.00 USDC', 'USDC · Hyperliquid']);
    expect(lines('Interest now')).toEqual(['$0.00 an hour']);
    expect(await rows('Interest now')).toEqual([{ name: 'Hyperliquid', value: '$0.00 an hour' }]);
  });

  it('a failed rate read on a charged borrow reads rate unknown', async () => {
    show(rebased(rebalanceViews.oneBorrow.buckets, { 'USDC/LIGHTER': { ratePerYear: null, interestPerDayUsd: 0 } }));

    expect(await rows('Interest now')).toEqual([{ name: 'Lighter', value: 'rate unknown' }]);
  });

  it('a failed rate read on a Hyperliquid borrow under 10,000 USDC still costs $0.00 an hour', async () => {
    show(rebased(rebalanceViews.hyperliquidFreeBorrow.buckets, { 'USDC/HYPERLIQUID': { ratePerYear: null, interestPerDayUsd: 0 } }));

    expect(await rows('Interest now')).toEqual([{ name: 'Hyperliquid', value: '$0.00 an hour' }]);
  });

  it('Interest now hover shows the rate for every wallet, even with no borrow', async () => {
    show(rebalanceViews.interestPaidSplit.buckets);
    expect(lines('Borrowing')[0]).toBe('none');

    await userEvent.hover(screen.getByRole('button', { name: 'Interest now' }));
    const card = await screen.findByRole('tooltip');

    const lighterRow = within(card).getByText('USDC · Lighter').closest('tr')!;
    expect(within(lighterRow).getByText('10.95% a year')).toBeInTheDocument();
    const crossexRow = within(card).getByText('USDT · CrossEx').closest('tr')!;
    expect(within(crossexRow).getByText('5.64% a year')).toBeInTheDocument();
    const hyperliquidRow = within(card).getByText('USDC · Hyperliquid').closest('tr')!;
    expect(within(hyperliquidRow).getByText('5.00% a year')).toBeInTheDocument();
  });

  it('lighter charges from the first dollar', async () => {
    show(rebalanceViews.oneBorrow.buckets);

    expect(await rows('Interest now')).toEqual([{ name: 'Lighter', value: '$0.0017 an hour' }]);
  });

  it('borrow comes from liability', async () => {
    const { unmount } = show(rebalanceViews.gainOverNegativeCash.buckets);
    expect(lines('Borrowing')[0]).toBe('none');
    unmount();

    show(rebalanceViews.twoBorrows.buckets);
    expect((await rows('Borrowing')).find((row) => row.name === 'Hyperliquid')?.value).toBe('112.00');
  });

  it('interest paid per wallet', async () => {
    show(rebalanceViews.interestPaidSplit.buckets);

    expect(lines('Interest paid')).toEqual(['$1.86']);
    expect(lines('Interest paid').join(' ')).not.toMatch(/all time/);
    expect(await rows('Interest paid')).toEqual([
      { name: 'Lighter', value: '$1.55' },
      { name: 'Hyperliquid', value: '$0.31' },
    ]);
  });

  it('borrow under one dollar', async () => {
    show(rebalanceViews.borrowUnderOne.buckets);

    expect(lines('Borrowing')).toEqual(['0.40 USDC', 'USDC · Hyperliquid']);
    expect(await rows('Interest now')).toEqual([{ name: 'Hyperliquid', value: '$0.00 an hour' }]);
  });

  it('USDC borrow over 10,000 shows the hourly cost', async () => {
    show(withBorrow(rebalanceViews.accountA.buckets, 'USDC/HYPERLIQUID', 12_000, 0.27));

    expect(lines('Borrowing')[0]).toBe('12,000.00 USDC');
    expect(lines('Interest now')[0]).toBe('$0.0113 an hour');
    expect(await rows('Interest now')).toEqual([{ name: 'Hyperliquid', value: '$0.0113 an hour' }]);
  });

  it('a 2,000 USDT borrow shows $0.0129 an hour', async () => {
    show(withBorrow(rebalanceViews.exampleE.buckets, 'USDT/CROSSEX', 2_000, 0.31));

    expect(lines('Borrowing')[0]).toBe('2,000.00 USDT');
    expect(lines('Interest now')[0]).toBe('$0.0129 an hour');
    expect(await rows('Interest now')).toEqual([{ name: 'CrossEx', value: '$0.0129 an hour' }]);
  });

  it('interest an hour of $1 or more shows 2 decimals', () => {
    show(withBorrow(rebalanceViews.exampleE.buckets, 'USDT/CROSSEX', 500_000, 77.28));

    expect(lines('Interest now')[0]).toBe('$3.22 an hour');
  });

  it('interest an hour above zero and under $0.0001 reads under $0.0001', () => {
    show(withBorrow(rebalanceViews.exampleE.buckets, 'USDT/CROSSEX', 5, 0.001));

    expect(lines('Interest now')[0]).toBe('under $0.0001 an hour');
  });

  it('interest paid stays after the borrow is repaid', async () => {
    show(rebased(rebalanceViews.exampleC.buckets, { 'USDC/HYPERLIQUID': { interestPaidUsd: 3.2 } }));

    expect(lines('Interest paid')).toEqual(['$3.20']);
    expect(await rows('Interest paid')).toEqual([{ name: 'Hyperliquid', value: '$3.20' }]);
    expect(lines('Borrowing')[0]).toBe('none');
    expect(lines('Interest now')[0]).toBe('$0.00 an hour');
  });
});

describe('the current round', () => {
  it('round of the current step, null past the last step', () => {
    const job = rebalanceViews.accountARunning.job!;

    expect(roundOf(job)).toBe(3);
    expect(roundOf({ ...job, stepIndex: job.steps.length })).toBeNull();
  });
});

describe('balanced targets', () => {
  it('targets hold still during a run', () => {
    const before = rebalanceViews.twoBorrows;
    const running = rebalanceViews.accountARunning.job!;
    const during = {
      ...before,
      job: { ...running, status: 'running' as const, inTransit: { coin: 'USDC' as const, qty: 300, at: 'MOVING' as const } },
      buckets: rebased(before.buckets, { 'USDT/CROSSEX': { cash: 1087.45, equity: 1191.92 } }),
    };
    const cents = (targets: Map<string, number>) => [...targets].map(([key, value]) => [key, Math.round(value * 100)]);

    expect(cents(targetsOf(during))).toEqual(cents(targetsOf(before)));
    expect(cents(targetsOf({ ...during, job: { ...during.job, status: 'abandoned' } }))).not.toEqual(cents(targetsOf(before)));
  });
});

describe('route and wallet rules the card and the modal share', () => {
  it('picks the first open route, starting from the pick', () => {
    const plan = rebalanceViews.twoBorrows.plans.even;
    expect(pickedRoute(plan, null).name).toBe('mix');
    expect(pickedRoute(plan, 'convert').route).toBe(plan.routes.convert);
    expect(pickedRoute(rebalanceViews.hiddenRoute.plans.even, 'loop').name).not.toBe('loop');
  });

  it('shows the Gate wallet only while it holds a dollar of cash', () => {
    const view = rebalanceViews.accountA;
    expect(shownKeys(view, [])).toContain('USDC/GATE');
    const dust = { ...view, buckets: rebased(view.buckets, { 'USDC/GATE': { cash: 0.99, equity: 0.99 } }) };
    expect(shownKeys(dust, [])).not.toContain('USDC/GATE');
  });
});

describe('the 30-day rule the card and the modal share', () => {
  const oneBorrow = rebalanceViews.oneBorrow;
  const route = pickedRoute(oneBorrow.plans.even, null).route;
  // The route repays the whole Lighter borrow, so it stops all of its interest.
  const lighterAt = (interestPerDayUsd: number) => rebased(oneBorrow.buckets, { 'USDC/LIGHTER': { interestPerDayUsd } });
  const at = (costUsd: number, savesPerDayUsd = route.savesPerDayUsd) => ({ ...route, costUsd, savesPerDayUsd });

  it('a fee up to 30 whole days of the interest it stops is worth it, and a cent more is not', () => {
    expect(isWorthIt(at(3), lighterAt(0.1))).toBe(true);
    expect(isWorthIt(at(3.01), lighterAt(0.1))).toBe(false);
    expect(isWorthIt(at(20), lighterAt(0.1))).toBe(false);
    expect(isWorthIt(at(12_000), lighterAt(400))).toBe(true);
    expect(isWorthIt(at(12_000.01), lighterAt(400))).toBe(false);
    expect(worthLine(at(3), lighterAt(0.1))).toEqual({ text: 'Rebalance recommended.', tone: 'act', sub: 'The fee equals 30 days of the interest it saves.' });
  });

  it('weighs the interest each wallet stops, not the daily saving the server rounds to cents', () => {
    // 114.70 USDC borrowed on Lighter at 10.95% a year costs 0.03441 a day. The server sends 0.03.
    const small = rebased(oneBorrow.buckets, {
      'USDC/LIGHTER': { cash: -114.7, equity: -114.7, borrow: 114.7, interestPerDayUsd: (114.7 * 0.1095) / 365 },
    });
    expect(worthLine(at(1, 0.03), small)).toEqual({ text: 'Rebalance recommended.', tone: 'act', sub: 'The fee equals 30 days of the interest it saves.' });
    // 16 USDC costs 0.0048 a day. The server sends 0.00.
    const tiny = rebased(oneBorrow.buckets, { 'USDC/LIGHTER': { cash: -16, equity: -16, borrow: 16, interestPerDayUsd: 0.0048 } });
    expect(worthLine(at(0.03, 0), tiny)).toEqual({ text: 'Rebalance recommended.', tone: 'act', sub: 'The fee equals 7 days of the interest it saves.' });
  });

  it('a wallet in profit owes its cash, not minus its equity: the route stops only the part it repays', () => {
    // Cash -500 and +200 unrealized: equity -300, but Gate lends 500. Sending 300 repays 300 of 500.
    const inProfit = rebased(oneBorrow.buckets, {
      'USDC/LIGHTER': { cash: -500, upnl: 200, equity: -300, borrow: 500, interestPerDayUsd: 0.15 },
    });
    const sends300 = (costUsd: number) => ({
      ...at(costUsd),
      after: route.after.map((w) => (w.venue === 'LIGHTER' ? { ...w, cash: -200, equity: 0 } : w)),
    });
    expect(stopsPerDayOf(sends300(3.5), inProfit)).toBeCloseTo(0.09, 10);
    expect(worthLine(sends300(3.5), inProfit)?.tone).toBe('warn');
    expect(worthLine(sends300(2.7), inProfit)).toEqual({
      text: 'Rebalance recommended.',
      tone: 'act',
      sub: 'The fee equals 30 days of the interest it saves.',
    });
  });

  it('the line and the rule never disagree at the edge: a fee just past 30 days reads not worth it', () => {
    // 1.20 against 0.03999 a day is 30.008 days, so the line would say 31 days.
    expect(isWorthIt(at(1.2), lighterAt(0.03999))).toBe(false);
    expect(worthLine(at(1.2), lighterAt(0.03999))?.tone).toBe('warn');
    expect(worthLine(at(1.19), lighterAt(0.03999))).toEqual({
      text: 'Rebalance recommended.',
      tone: 'act',
      sub: 'The fee equals 30 days of the interest it saves.',
    });
  });

  it('a route that stops no interest is not worth any fee, and a free route gives no line', () => {
    const free = rebased(oneBorrow.buckets, { 'USDC/LIGHTER': { cash: -16, equity: -16, borrow: 16, interestPerDayUsd: 0.0048 } });
    const keepsBorrow = { ...at(0.46), after: route.after.map((w) => (w.venue === 'LIGHTER' ? { ...w, cash: -16, equity: -16 } : w)) };
    expect(isNotWorthIt(keepsBorrow, free)).toBe(true);
    expect(isWorthIt(at(0), lighterAt(0.1))).toBe(true);
    expect(worthLine(at(0), lighterAt(0.1))).toBeNull();
  });

  it('says less than a day and 1 day', () => {
    expect(worthLine(at(0.03), lighterAt(0.04))?.sub).toBe('The fee equals less than a day of the interest it saves.');
    expect(worthLine(at(0.04), lighterAt(0.04))?.sub).toBe('The fee equals 1 day of the interest it saves.');
    expect(worthLine(at(0.05), lighterAt(0.04))?.sub).toBe('The fee equals 2 days of the interest it saves.');
  });

  it('a borrow inside its free allowance keeps the blue no-interest line, whatever the goal', () => {
    const free = rebased(oneBorrow.buckets, {
      'USDC/HYPERLIQUID': { borrow: 5000, equity: -5000, cash: -5000, interestPerDayUsd: 0, ratePerYear: 0.05 },
      'USDC/LIGHTER': { borrow: 0, equity: 100, cash: 100, interestPerDayUsd: 0, imHeldUsd: 0, mmHeldUsd: 0 },
    });
    for (const goal of ['even', 'repay'] as const) {
      expect(worthLine(at(20), free, goal)).toEqual({ text: 'No interest payment yet. No transfer or rebalancing necessary.', tone: 'info' });
    }
  });

  it('says no borrow with no borrow, and names the failure when a borrow rate cannot be read', () => {
    expect(isNotWorthIt(at(20), rebalanceViews.accountB.buckets)).toBe(false);
    expect(worthLine(at(20), rebalanceViews.accountB.buckets)).toEqual({ text: 'No borrow. No transfer or rebalancing necessary.', tone: 'info' });
    const unknown = rebased(oneBorrow.buckets, { 'USDC/LIGHTER': { ratePerYear: null, interestPerDayUsd: 0 } });
    expect(isNotWorthIt(at(20), unknown)).toBe(false);
    // An unreadable rate is an error, not silence: the dialog still prices a fee.
    expect(worthLine(at(20), unknown)).toEqual({ text: 'Could not read the borrow interest rate. Check the fee before you move anything.', tone: 'warn' });
  });

  it('with no legs the borrow blocks a withdrawal, so no fee is weighed — whatever goal asks', () => {
    const withdrawBlocked = { text: 'Clear debt recommended.', tone: 'act', sub: 'Debt prevents you from withdrawing your cash.' };
    for (const goal of ['repay', 'custom', 'even'] as const) {
      expect(worthLine(at(3), lighterAt(0.1), goal, true)).toEqual(withdrawBlocked);
    }
    // A fee that dwarfs the interest still says repay: the cash is stuck either way.
    expect(worthLine(at(500), lighterAt(0.1), 'repay', true)).toEqual(withdrawBlocked);
  });

  it('with legs the fee-versus-interest weighing applies to a custom move as well', () => {
    expect(worthLine(at(3), lighterAt(0.1), 'custom', false)?.sub).toBe('The fee equals 30 days of the interest it saves.');
    expect(worthLine(at(500), lighterAt(0.1), 'custom', false)?.tone).toBe('warn');
  });
});

describe('defaultGoal — the card leads with whatever is worth doing', () => {
  const view = rebalanceViews.twoBorrows;
  const dear = (plan: typeof view.plans.even, costUsd: number) => ({
    ...plan,
    routes: Object.fromEntries(
      Object.entries(plan.routes).map(([k, r]) => [k, r && { ...r, costUsd }]),
    ) as typeof plan.routes,
  });

  it('leads with the preset whose verdict asks for the move', () => {
    // Both have work; only clearing the debt is worth its fee.
    const plans = { ...view.plans, even: dear(view.plans.even, 500), repay: dear(view.plans.even, 0.5) };
    expect(defaultGoal({ ...view, plans })).toBe('repay');
  });

  it('keeps Rebalance when it is worth doing', () => {
    const plans = { ...view.plans, even: dear(view.plans.even, 0.5), repay: dear(view.plans.even, 0.5) };
    expect(defaultGoal({ ...view, plans })).toBe('even');
  });

  it('keeps Rebalance when neither is worth doing', () => {
    const plans = { ...view.plans, even: dear(view.plans.even, 500), repay: dear(view.plans.even, 500) };
    expect(defaultGoal({ ...view, plans })).toBe('even');
  });

  it('falls to the preset that has anything to do at all', () => {
    const idle = { ...view.plans.even, balanced: true };
    const busy = dear(view.plans.even, 0.5);
    expect(defaultGoal({ ...view, plans: { ...view.plans, even: idle, repay: busy } })).toBe('repay');
    expect(defaultGoal({ ...view, plans: { ...view.plans, even: busy, repay: idle } })).toBe('even');
    // Nothing to do anywhere keeps the feature's own name.
    expect(defaultGoal({ ...view, plans: { ...view.plans, even: idle, repay: idle } })).toBe('even');
  });
});
