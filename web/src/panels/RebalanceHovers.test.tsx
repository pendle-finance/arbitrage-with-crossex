import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { RebalanceBucket } from '../api/types';
import type { LiquidationLine } from '../lib/liquidation';
import { rebalanceViews, rebased } from '../test/fixtures';
import { borrowFacts, Facts } from './RebalanceHovers';

function show(buckets: RebalanceBucket[], line: LiquidationLine | null = null) {
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

    expect(lines('Borrowing')).toEqual(['132.00 USDC', 'Lighter 132.00']);
  });

  it('two borrowing wallets', () => {
    show(rebalanceViews.twoBorrows.buckets);

    expect(lines('Borrowing')).toEqual(['244.00 USDC', 'Lighter 132.00 · Hyperliquid 112.00']);
  });

  it('interest per wallet', () => {
    show(rebalanceViews.twoBorrows.buckets);

    expect(lines('Interest now')).toEqual([
      '$0.04 a day',
      'Lighter 10.95% a year, no free allowance',
      'Hyperliquid 5% a year, free to 10,000',
    ]);
  });

  it('hyperliquid free allowance', () => {
    show(rebalanceViews.hyperliquidFreeBorrow.buckets);

    expect(lines('Borrowing')).toEqual(['4,200.00 USDC', 'Hyperliquid 4,200.00']);
    expect(lines('Interest now')).toEqual(['$0.00 a day', 'Hyperliquid 5% a year, free to 10,000']);
  });

  it('lighter charges from the first dollar', () => {
    show(rebalanceViews.oneBorrow.buckets);

    const lighter = lines('Interest now')[1];
    expect(lighter).toBe('Lighter 10.95% a year, no free allowance');
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

  it('borrow under one dollar', () => {
    show(rebalanceViews.borrowUnderOne.buckets);

    expect(lines('Borrowing')).toEqual(['0.40 USDC', 'Hyperliquid 0.40']);
    expect(lines('Interest now')[1]).toBe('Hyperliquid 5% a year, free to 10,000');
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
    expect(lines('Interest now')[1]).toMatch(/a year, no free allowance$/);
    expect(lines('Interest now').join(' ')).not.toMatch(/free to/);
  });

  it('interest paid stays after the borrow is repaid', () => {
    show(rebased(rebalanceViews.exampleC.buckets, { 'USDC/HYPERLIQUID': { interestPaidUsd: 3.2 } }));

    expect(lines('Interest paid')).toEqual(['$3.20', 'all time', 'Hyperliquid $3.20']);
    expect(lines('Borrowing')[0]).toBe('none');
    expect(lines('Interest now')[0]).toBe('$0.00 a day');
  });
});
