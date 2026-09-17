import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { PositionsResponse, RebalanceBucket } from '../api/types';
import type { LiquidationLine } from '../lib/liquidation';
import { accountBodies, rebalanceViews, rebased } from '../test/fixtures';
import { borrowFacts, Facts, liquidationNow, pickedRoute, roundOf, shownKeys, targetsOf } from './RebalanceHovers';

function show(buckets: RebalanceBucket[], line: LiquidationLine | null | 'unknown' = null) {
  return render(<Facts items={borrowFacts(buckets, line)} />);
}

const withBorrow = (buckets: RebalanceBucket[], key: string, borrow: number, interestPerDayUsd: number) =>
  rebased(buckets, { [key]: { cash: -borrow, equity: -borrow, borrow, interestPerDayUsd } });

function fact(label: string): HTMLElement {
  const dt = screen.getByText(label).closest('dt');
  return dt?.parentElement as HTMLElement;
}

const lines = (label: string): string[] =>
  [...fact(label).querySelectorAll('dd:not([data-fact-rows])')].map((dd) => dd.textContent ?? '');

function rows(label: string): { name: string; value: string }[] {
  const grid = fact(label).querySelector('[data-fact-rows]');
  if (!grid) return [];
  const spans = [...grid.querySelectorAll('span')];
  const out: { name: string; value: string }[] = [];
  for (let i = 0; i < spans.length; i += 2) out.push({ name: spans[i].textContent ?? '', value: spans[i + 1].textContent ?? '' });
  return out;
}

describe('borrow facts', () => {
  it('facts with no borrow', () => {
    const { container } = show(rebalanceViews.accountB.buckets, null);

    expect(container.querySelectorAll('dt')).toHaveLength(4);
    expect(lines('Borrowing')[0]).toBe('none');
    expect(lines('Interest now')[0]).toBe('$0.00 an hour');
    expect(lines('Interest paid')[0]).toBe('$0.00');
    expect(lines('Liquidation')[0]).toBe('none');
  });

  it('one borrowing wallet', () => {
    show(rebalanceViews.oneBorrow.buckets);

    expect(lines('Borrowing')).toEqual(['132.00 USDC', 'USDC · Lighter']);
  });

  it('two borrowing wallets', () => {
    show(rebalanceViews.twoBorrows.buckets);

    expect(lines('Borrowing')).toEqual(['244.00 USDC']);
    expect(rows('Borrowing')).toEqual([
      { name: 'Lighter', value: '132.00' },
      { name: 'Hyperliquid', value: '112.00' },
    ]);
  });

  it('two borrowing wallets render aligned rows', () => {
    show(rebalanceViews.twoBorrows.buckets);

    const borrowingValues = [...fact('Borrowing').querySelectorAll('[data-fact-rows] span:nth-child(2n)')];
    const interestValues = [...fact('Interest now').querySelectorAll('[data-fact-rows] span:nth-child(2n)')];
    expect(borrowingValues).toHaveLength(2);
    expect(interestValues).toHaveLength(2);
    for (const span of borrowingValues) expect(span.className).toContain('text-right');
    for (const span of interestValues) expect(span.className).toContain('text-right');
  });

  it('interest per wallet', () => {
    show(rebalanceViews.twoBorrows.buckets);

    expect(lines('Interest now')).toEqual(['$0.0017 an hour']);
    expect(rows('Interest now')).toEqual([
      { name: 'Lighter', value: '$0.0017 an hour' },
      { name: 'Hyperliquid', value: '$0.00 an hour' },
    ]);
  });

  it('a Hyperliquid borrow under 10,000 USDC costs $0.00 an hour', () => {
    show(rebalanceViews.hyperliquidFreeBorrow.buckets);

    expect(lines('Borrowing')).toEqual(['4,200.00 USDC', 'USDC · Hyperliquid']);
    expect(lines('Interest now')).toEqual(['$0.00 an hour']);
    expect(rows('Interest now')).toEqual([{ name: 'Hyperliquid', value: '$0.00 an hour' }]);
  });

  it('a failed rate read on a charged borrow reads rate unknown', () => {
    show(rebased(rebalanceViews.oneBorrow.buckets, { 'USDC/LIGHTER': { ratePerYear: null, interestPerDayUsd: 0 } }));

    expect(rows('Interest now')).toEqual([{ name: 'Lighter', value: 'rate unknown' }]);
  });

  it('a failed rate read on a Hyperliquid borrow under 10,000 USDC still costs $0.00 an hour', () => {
    show(rebased(rebalanceViews.hyperliquidFreeBorrow.buckets, { 'USDC/HYPERLIQUID': { ratePerYear: null, interestPerDayUsd: 0 } }));

    expect(rows('Interest now')).toEqual([{ name: 'Hyperliquid', value: '$0.00 an hour' }]);
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

  it('lighter charges from the first dollar', () => {
    show(rebalanceViews.oneBorrow.buckets);

    expect(rows('Interest now')).toEqual([{ name: 'Lighter', value: '$0.0017 an hour' }]);
  });

  it('borrow comes from liability', () => {
    const { unmount } = show(rebalanceViews.gainOverNegativeCash.buckets);
    expect(lines('Borrowing')[0]).toBe('none');
    unmount();

    show(rebalanceViews.twoBorrows.buckets);
    expect(rows('Borrowing').find((row) => row.name === 'Hyperliquid')?.value).toBe('112.00');
  });

  it('interest paid per wallet', () => {
    show(rebalanceViews.interestPaidSplit.buckets);

    expect(lines('Interest paid')).toEqual(['$1.86']);
    expect(lines('Interest paid').join(' ')).not.toMatch(/all time/);
    expect(rows('Interest paid')).toEqual([
      { name: 'Lighter', value: '$1.55' },
      { name: 'Hyperliquid', value: '$0.31' },
    ]);
  });

  it('liquidation names the venue', () => {
    const line: LiquidationLine = { base: 'ETH', venue: 'Hyperliquid', side: 'short', price: 3150.4, move: 0.37 };
    show(rebalanceViews.twoBorrows.buckets, line);

    const block = fact('Liquidation');
    expect(lines('Liquidation')).toEqual(['ETH ~$3,150', '+37% away · ETH on Hyperliquid']);
    expect(block.textContent).not.toMatch(/\d+ lines?/);
  });

  it('liquidation reads unknown without a read', () => {
    show(rebalanceViews.twoBorrows.buckets, 'unknown');

    expect(lines('Liquidation')).toEqual(['unknown']);
  });

  it('borrow under one dollar', () => {
    show(rebalanceViews.borrowUnderOne.buckets);

    expect(lines('Borrowing')).toEqual(['0.40 USDC', 'USDC · Hyperliquid']);
    expect(rows('Interest now')).toEqual([{ name: 'Hyperliquid', value: '$0.00 an hour' }]);
  });

  it('USDC borrow over 10,000 shows the hourly cost', () => {
    show(withBorrow(rebalanceViews.accountA.buckets, 'USDC/HYPERLIQUID', 12_000, 0.27));

    expect(lines('Borrowing')[0]).toBe('12,000.00 USDC');
    expect(lines('Interest now')[0]).toBe('$0.0113 an hour');
    expect(rows('Interest now')).toEqual([{ name: 'Hyperliquid', value: '$0.0113 an hour' }]);
  });

  it('a 2,000 USDT borrow shows $0.0129 an hour', () => {
    show(withBorrow(rebalanceViews.exampleE.buckets, 'USDT/CROSSEX', 2_000, 0.31));

    expect(lines('Borrowing')[0]).toBe('2,000.00 USDT');
    expect(lines('Interest now')[0]).toBe('$0.0129 an hour');
    expect(rows('Interest now')).toEqual([{ name: 'CrossEx', value: '$0.0129 an hour' }]);
  });

  it('interest an hour of $1 or more shows 2 decimals', () => {
    show(withBorrow(rebalanceViews.exampleE.buckets, 'USDT/CROSSEX', 500_000, 77.28));

    expect(lines('Interest now')[0]).toBe('$3.22 an hour');
  });

  it('interest an hour above zero and under $0.0001 reads under $0.0001', () => {
    show(withBorrow(rebalanceViews.exampleE.buckets, 'USDT/CROSSEX', 5, 0.001));

    expect(lines('Interest now')[0]).toBe('under $0.0001 an hour');
  });

  it('interest paid stays after the borrow is repaid', () => {
    show(rebased(rebalanceViews.exampleC.buckets, { 'USDC/HYPERLIQUID': { interestPaidUsd: 3.2 } }));

    expect(lines('Interest paid')).toEqual(['$3.20']);
    expect(rows('Interest paid')).toEqual([{ name: 'Hyperliquid', value: '$3.20' }]);
    expect(lines('Borrowing')[0]).toBe('none');
    expect(lines('Interest now')[0]).toBe('$0.00 an hour');
  });
});

describe('the liquidation rule the card and the modal share', () => {
  const noPositions: PositionsResponse = { positions: [], exposure: [] };

  it('is unknown without both reads or with margin figures that are not numbers, and null with no line', () => {
    expect(liquidationNow(undefined, noPositions)).toBe('unknown');
    expect(liquidationNow(accountBodies.accountA, undefined)).toBe('unknown');
    expect(liquidationNow({ ...accountBodies.accountA, maintenanceMargin: 'n/a' }, noPositions)).toBe('unknown');
    expect(liquidationNow(accountBodies.accountA, noPositions)).toBeNull();
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
    const plan = rebalanceViews.twoBorrows.plan;
    expect(pickedRoute(plan, null).name).toBe('mix');
    expect(pickedRoute(plan, 'convert').route).toBe(plan.routes.convert);
    expect(pickedRoute(rebalanceViews.hiddenRoute.plan, 'loop').name).not.toBe('loop');
  });

  it('shows the Gate wallet only while it holds a dollar of cash', () => {
    const view = rebalanceViews.accountA;
    expect(shownKeys(view, [])).toContain('USDC/GATE');
    const dust = { ...view, buckets: rebased(view.buckets, { 'USDC/GATE': { cash: 0.99, equity: 0.99 } }) };
    expect(shownKeys(dust, [])).not.toContain('USDC/GATE');
  });
});
