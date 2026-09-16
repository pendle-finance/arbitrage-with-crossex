import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { RebalanceBucket } from '../api/types';
import type { LiquidationLine } from '../lib/liquidation';
import { rebalanceViews, rebased } from '../test/fixtures';
import { borrowFacts, Facts, pickedRoute, roundOf, shownKeys, targetsOf } from './RebalanceHovers';

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
  [...fact(label).querySelectorAll('dd')].map((dd) => dd.textContent ?? '');

describe('borrow facts', () => {
  it('facts with no borrow', () => {
    const { container } = show(rebalanceViews.accountB.buckets, null);

    expect(container.querySelectorAll('dt')).toHaveLength(4);
    expect(lines('Borrowing')[0]).toBe('none');
    expect(lines('Interest now')[0]).toBe('$0.00 a day');
    expect(lines('Interest paid')[0]).toBe('$0.00');
    expect(lines('Liquidation')[0]).toBe('none');
  });

  it('one borrowing wallet', () => {
    show(rebalanceViews.oneBorrow.buckets);

    expect(lines('Borrowing')).toEqual(['132.00 USDC', 'USDC · Lighter']);
  });

  it('two borrowing wallets', () => {
    show(rebalanceViews.twoBorrows.buckets);

    expect(lines('Borrowing')).toEqual(['244.00 USDC', 'Lighter 132.00 · Hyperliquid 112.00']);
  });

  it('interest per wallet', () => {
    show(rebalanceViews.twoBorrows.buckets);

    expect(lines('Interest now')).toEqual([
      '$0.04 a day',
      'Lighter 10.95% a year, all of it pays interest',
      'Hyperliquid free to 10,000',
    ]);
  });

  it('hyperliquid free allowance', () => {
    show(rebalanceViews.hyperliquidFreeBorrow.buckets);

    expect(lines('Borrowing')).toEqual(['4,200.00 USDC', 'USDC · Hyperliquid']);
    expect(lines('Interest now')).toEqual(['$0.00 a day', 'Hyperliquid free to 10,000']);
  });

  it('lighter charges from the first dollar', () => {
    show(rebalanceViews.oneBorrow.buckets);

    const lighter = lines('Interest now')[1];
    expect(lighter).toBe('Lighter 10.95% a year, all of it pays interest');
    expect(lighter).not.toMatch(/free to/);
  });

  it('borrow comes from liability', () => {
    const { unmount } = show(rebalanceViews.gainOverNegativeCash.buckets);
    expect(lines('Borrowing')[0]).toBe('none');
    unmount();

    show(rebalanceViews.twoBorrows.buckets);
    expect(lines('Borrowing')[1]).toContain('Hyperliquid 112.00');
  });

  it('interest paid per wallet', () => {
    show(rebalanceViews.interestPaidSplit.buckets);

    expect(lines('Interest paid')).toEqual(['$1.86', 'all time', 'Lighter $1.55 · Hyperliquid $0.31']);
  });

  it('liquidation names the venue', () => {
    const line: LiquidationLine = { base: 'ETH', venue: 'Hyperliquid', price: 3150.4, move: 0.37 };
    show(rebalanceViews.twoBorrows.buckets, line);

    const block = fact('Liquidation');
    expect(lines('Liquidation')).toEqual(['ETH ~$3,150', '+37% away · ETH on Hyperliquid']);
    expect(block.textContent).not.toMatch(/\d+ lines?/);
  });

  it('liquidation reads not known without a read', () => {
    show(rebalanceViews.twoBorrows.buckets, 'unknown');

    expect(lines('Liquidation')).toEqual(['not known']);
  });

  it('borrow under one dollar', () => {
    show(rebalanceViews.borrowUnderOne.buckets);

    expect(lines('Borrowing')).toEqual(['0.40 USDC', 'USDC · Hyperliquid']);
    expect(lines('Interest now')[1]).toBe('Hyperliquid free to 10,000');
  });

  it('USDC borrow over 10,000 shows the daily cost', () => {
    show(withBorrow(rebalanceViews.accountA.buckets, 'USDC/HYPERLIQUID', 12_000, 0.27));

    expect(lines('Borrowing')[0]).toBe('12,000.00 USDC');
    expect(lines('Interest now')[0]).toBe('$0.27 a day');
    expect(lines('Interest now')[1]).toMatch(/^Hyperliquid .*% a year, free to 10,000$/);
  });

  it('a 2,000 USDT borrow shows $0.31 a day', () => {
    show(withBorrow(rebalanceViews.exampleE.buckets, 'USDT/CROSSEX', 2_000, 0.31));

    expect(lines('Borrowing')[0]).toBe('2,000.00 USDT');
    expect(lines('Interest now')[0]).toBe('$0.31 a day');
    expect(lines('Interest now')[1]).toMatch(/a year, all of it pays interest$/);
    expect(lines('Interest now').join(' ')).not.toMatch(/free to/);
  });

  it('interest paid stays after the borrow is repaid', () => {
    show(rebased(rebalanceViews.exampleC.buckets, { 'USDC/HYPERLIQUID': { interestPaidUsd: 3.2 } }));

    expect(lines('Interest paid')).toEqual(['$3.20', 'all time', 'Hyperliquid $3.20']);
    expect(lines('Borrowing')[0]).toBe('none');
    expect(lines('Interest now')[0]).toBe('$0.00 a day');
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
