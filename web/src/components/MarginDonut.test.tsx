import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CrossexAccount } from '../api/types';
import { accountBodies } from '../test/fixtures';
import { marginParts, MarginBreakdown } from './MarginDonut';

/** Real-account shape where Gate's coverage-ratio fields look "reversed"
 * (maintenanceMarginRate > initialMarginRate). We ignore those fields. */
const acc: CrossexAccount = {
  marginBalance: '969.8236',
  availableMargin: '222.7514',
  initialMargin: '747.0722',
  maintenanceMargin: '268.5796',
  initialMarginRate: '1.2981', // coverage ratio — intentionally not used
  maintenanceMarginRate: '3.6109',
  accountMode: 'CROSS_EXCHANGE',
  positionMode: 'ONE_WAY',
  assets: [],
};

describe('marginParts', () => {
  it('computes utilization as margin ÷ balance (initial > maintenance, not reversed)', () => {
    const p = marginParts(acc);
    expect(p.imPct).toBeCloseTo(0.7703, 4);
    expect(p.mmPct).toBeCloseTo(0.2769, 4);
    expect(p.imPct).toBeGreaterThan(p.mmPct); // the fix: IM is the larger share
  });

  it('derives available so used + free closes the ring exactly', () => {
    const p = marginParts(acc);
    expect(p.initial + p.available).toBeCloseTo(p.balance, 6);
  });

  it('handles a funded account with no positions (no sentinel leakage)', () => {
    const flat = { ...acc, initialMargin: '0', maintenanceMargin: '0', availableMargin: '969.8236' };
    const p = marginParts(flat);
    expect(p.imPct).toBe(0);
    expect(p.mmPct).toBe(0);
    expect(p.available).toBeCloseTo(p.balance, 6);
  });

  it('guards a zero-balance account', () => {
    const empty = { ...acc, marginBalance: '0', initialMargin: '0', maintenanceMargin: '0', availableMargin: '0' };
    const p = marginParts(empty);
    expect(p.hasFunds).toBe(false);
    expect(p.imPct).toBe(0);
  });
});

describe('MarginBreakdown', () => {
  it('full variant labels initial/available/maintenance and shows IM% > MM%', () => {
    render(<MarginBreakdown acc={acc} />);
    expect(screen.getByText('Initial margin (used)')).toBeInTheDocument();
    expect(screen.getByText('Available')).toBeInTheDocument();
    // Maintenance mini-pie center shows 28% (of balance), and the IM legend 77%.
    expect(screen.getByText('77%')).toBeInTheDocument();
    expect(screen.getByText('28%')).toBeInTheDocument();
    expect(screen.getByText('77%').getAttribute('title')).toBe('Share of balance');
  });

  it('compact variant renders both IM and MM shares', () => {
    render(<MarginBreakdown acc={acc} variant="compact" />);
    expect(screen.getByText('IM')).toBeInTheDocument();
    expect(screen.getByText('MM')).toBeInTheDocument();
    expect(screen.getByText('77%')).toBeInTheDocument();
    expect(screen.getByText('28%')).toBeInTheDocument();
  });

  it('initial margin is always green regardless of how high it is', () => {
    // IM at 77% would be "red" under a utilization threshold — but IM stays green.
    render(<MarginBreakdown acc={acc} />);
    expect(screen.getByText('77%').className).toContain('text-emerald-400');
  });

  it('clamps a maintenance ring that exceeds the balance (no negative dash gap)', () => {
    // Near-liquidation account: maintenance margin exceeds the whole margin
    // balance, so the mm segment value > its donut total. Un-clamped, the arc
    // dash would overshoot the circumference and `c - dash` go negative.
    const nearLiq: CrossexAccount = {
      ...acc,
      marginBalance: '100',
      initialMargin: '90',
      maintenanceMargin: '150',
      availableMargin: '10',
    };
    const { container } = render(<MarginBreakdown acc={nearLiq} />);
    const titleEl = [...container.querySelectorAll('circle > title')].find((t) =>
      /^Maintenance margin/.test(t.textContent ?? ''),
    );
    expect(titleEl).toBeTruthy();
    const circle = titleEl!.parentElement as unknown as SVGCircleElement;
    const [dash, gap] = (circle.getAttribute('stroke-dasharray') ?? '').split(' ').map(Number);
    // Maintenance mini-pie is size 68 / thickness 11 → r = 28.5.
    const circumference = 2 * Math.PI * ((68 - 11) / 2);
    expect(dash).toBeLessThanOrEqual(circumference + 1e-6); // clamped to the ring
    expect(gap).toBeGreaterThanOrEqual(-1e-6); // never a negative gap
  });

  it('maintenance margin is color-coded green < 50%, amber < 75%, red ≥ 75%', () => {
    const withMm = (maintenance: string) => ({ ...acc, maintenanceMargin: maintenance });
    // 268.58 / 969.82 = 28% → green
    const green = render(<MarginBreakdown acc={withMm('268.5796')} />);
    expect(green.getByText('28%').className).toContain('text-emerald-400');
    green.unmount();
    // 679 / 969.82 = 70% → amber
    const amber = render(<MarginBreakdown acc={withMm('679')} />);
    expect(amber.getByText('70%').className).toContain('text-amber-400');
    amber.unmount();
    // 800 / 969.82 = 82% → red
    const red = render(<MarginBreakdown acc={withMm('800')} />);
    expect(red.getByText('82%').className).toContain('text-rose-400');
  });

  it('splits initial margin into positions and borrow with the right $ and %', () => {
    const twoBorrows = render(<MarginBreakdown acc={accountBodies.twoBorrows} borrowImUsd={48.8} />);
    const positionsRow = twoBorrows.getByText('Initial margin · positions').closest('div')!;
    expect(within(positionsRow).getByText('$151.30')).toBeInTheDocument();
    expect(within(positionsRow).getByText('12%')).toBeInTheDocument();
    const borrowRow = twoBorrows.getByText('Initial margin · borrow').closest('div')!;
    expect(within(borrowRow).getByText('$48.80')).toBeInTheDocument();
    expect(within(borrowRow).getByText('4%')).toBeInTheDocument();
    expect(twoBorrows.queryByText('Utilization = margin ÷ balance')).toBeNull();
    expect(twoBorrows.queryByText(/of it is for the borrow/)).toBeNull();
    twoBorrows.unmount();

    const hyperliquidFreeBorrow = render(
      <MarginBreakdown acc={accountBodies.hyperliquidFreeBorrow} borrowImUsd={840} />,
    );
    const hlPositionsRow = hyperliquidFreeBorrow.getByText('Initial margin · positions').closest('div')!;
    expect(within(hlPositionsRow).getByText('$504.00')).toBeInTheDocument();
    expect(within(hlPositionsRow).getByText('12%')).toBeInTheDocument();
    const hlBorrowRow = hyperliquidFreeBorrow.getByText('Initial margin · borrow').closest('div')!;
    expect(within(hlBorrowRow).getByText('$840.00')).toBeInTheDocument();
    expect(within(hlBorrowRow).getByText('20%')).toBeInTheDocument();
    hyperliquidFreeBorrow.unmount();

    render(<MarginBreakdown acc={acc} borrowImUsd={0} />);
    expect(screen.getByText('Initial margin (used)')).toBeInTheDocument();
    expect(screen.queryByText('Utilization = margin ÷ balance')).toBeNull();
    expect(screen.queryByText('Initial margin · borrow')).toBeNull();
  });

  it('clamps a borrow margin above the account initial margin', () => {
    render(<MarginBreakdown acc={accountBodies.twoBorrows} borrowImUsd={9999} />);

    const positionsRow = screen.getByText('Initial margin · positions').closest('div')!;
    expect(within(positionsRow).getByText('$0.00')).toBeInTheDocument();
    expect(within(positionsRow).getByText('0%')).toBeInTheDocument();
    const borrowRow = screen.getByText('Initial margin · borrow').closest('div')!;
    expect(within(borrowRow).getByText('$200.10')).toBeInTheDocument();
    expect(within(borrowRow).getByText('16%')).toBeInTheDocument();
  });

  it('strip unchanged', () => {
    render(<MarginBreakdown acc={acc} variant="compact" borrowImUsd={500} />);
    expect(screen.getByText('IM')).toBeInTheDocument();
    expect(screen.getByText('MM')).toBeInTheDocument();
    expect(screen.getByText('77%')).toBeInTheDocument();
    expect(screen.getByText('28%')).toBeInTheDocument();
    expect(screen.queryByText(/of it is for the borrow/)).toBeNull();
  });
});
