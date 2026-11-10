import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BorosPairBlocker, BorosPairSimulation, BorosSimulatedLeg } from '../api/types';
import { AvailableMarginLines, BlockerList, blockerButtonReason, LiquidationLines, liqWarnOf, PairCosts, SuggestedTopUpLines } from './BorosPairBits';

const leg = (venue: string, liquidationApr: number | null, resultingSize: number): BorosSimulatedLeg =>
  ({
    venue,
    execApr: 0.09,
    liquidationApr,
    sizing: { resultingSize },
  }) as unknown as BorosSimulatedLeg;

describe('LiquidationLines', () => {
  it('shows the rate, N/A as the Boros app does when an open leg has none, and — for a flat leg', () => {
    const sim = {
      legs: [leg('Gate', 0.0996, -100), leg('Hyperliquid', null, 100), leg('Binance', null, 0)],
    } as unknown as BorosPairSimulation;
    render(<LiquidationLines sim={sim} />);
    expect(screen.getByText('9.96%')).toBeInTheDocument();
    expect(screen.getByText('N/A')).toHaveAttribute(
      'title',
      'Position risk is low, so there is no liquidation rate for the time being.',
    );
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('adds the suggested rate only to a leg that would liquidate closer to the mark', () => {
    const sim = {
      legs: [
        { ...leg('Gate', 0.0996, -100), suggestedLiquidationApr: 0.135 },
        { ...leg('Hyperliquid', -0.3, 100), suggestedLiquidationApr: 0.003 },
      ],
    } as unknown as BorosPairSimulation;
    render(<LiquidationLines sim={sim} />);
    expect(screen.getByText('9.96%')).toHaveAttribute(
      'title',
      'Suggested liquidation APR: ≥ 13.50%. The suggested top-up gets it there.',
    );
    expect(screen.getByText('-30.00%')).not.toHaveAttribute('title');
  });

  it("keeps a short leg quiet when its account's free margin already covers the top-up", () => {
    const sim = { legs: [{ ...leg('Gate', 0.0996, -100), suggestedLiquidationApr: 0.135 }] } as unknown as BorosPairSimulation;
    render(<LiquidationLines sim={sim} warn={() => false} />);
    expect(screen.getByText('9.96%')).not.toHaveAttribute('title');
  });
});

describe('PairCosts', () => {
  const sim = {
    legs: [
      { ...leg('Gate', 0.0996, -100), marginRequired: 1 },
      { ...leg('Hyperliquid', null, 100), marginRequired: 0.5 },
    ],
    marginRequiredTotal: 1.5,
    collateral: 'ETH',
    collateralPriceUsd: 2000,
    costToCrossSize: 0.25,
  } as unknown as BorosPairSimulation;

  it('leads with the margin, legs on its hover, then what sits under it, then the fee', () => {
    render(<PairCosts sim={sim} afterMargin={<span>top-up</span>} />);
    const order = [...document.body.querySelectorAll('span')].map((e) => e.textContent);
    expect(order.indexOf('Margin usage')).toBeLessThan(order.indexOf('top-up'));
    expect(order.indexOf('top-up')).toBeLessThan(order.indexOf('Trade fee · 2 markets'));
    const margin = screen.getByText('Margin usage').closest('[title]')!;
    expect(margin.textContent).toMatch(/1\.5 ETH/);
    expect(margin.getAttribute('title')).toMatch(/\nGate 1 ETH\nHyperliquid 0\.5 ETH$/);
    expect(screen.getByText('Trade fee · 2 markets').closest('[title]')!.textContent).toMatch(/0\.25 ETH/);
  });
});

describe('AvailableMarginLines / SuggestedTopUpLines', () => {
  const sim = { collateral: 'ETH', collateralPriceUsd: 2000 } as unknown as BorosPairSimulation;
  const nameOf = (id: number | null) => (id === null ? 'Cross' : `Market ${id}`);
  const cross = { marketId: null, availableBefore: 12.5, availableAfter: 5, suggestedTopUp: 3.25 };

  it('shows free margin before → after, and the top-up when one is needed', () => {
    render(
      <>
        <AvailableMarginLines sim={sim} funding={[cross]} nameOf={nameOf} fallback={null} unit="ETH" />
        <SuggestedTopUpLines sim={sim} funding={[cross]} nameOf={nameOf} />
      </>,
    );
    expect(screen.getByText('Available margin').parentElement!.textContent).toMatch(/12\.5→5 ETH/);
    expect(screen.getByText('Suggested top-up amount').parentElement!.textContent).toMatch(/\+3\.25 ETH/);
  });

  it('before a quote shows the free margin alone', () => {
    render(<AvailableMarginLines sim={null} funding={undefined} nameOf={nameOf} fallback={7} unit="ETH" />);
    expect(screen.getByText('Available margin').parentElement!.textContent).toBe('Available margin7 ETH');
  });

  it('shows no top-up when free margin covers it, and names each account when there are two', () => {
    const funding = [
      { ...cross, suggestedTopUp: 0 },
      { marketId: 7, availableBefore: 1, availableAfter: 0.5, suggestedTopUp: 0 },
    ];
    render(
      <>
        <AvailableMarginLines sim={sim} funding={funding} nameOf={nameOf} fallback={null} unit="ETH" />
        <SuggestedTopUpLines sim={sim} funding={funding} nameOf={nameOf} />
      </>,
    );
    expect(screen.queryByText('Suggested top-up amount')).toBeNull();
    expect(screen.getByText('Available margin · Cross')).toBeInTheDocument();
    expect(screen.getByText('Available margin · Market 7')).toBeInTheDocument();
  });
});

describe('liqWarnOf', () => {
  it("warns a leg only when its OWN account still needs a top-up", () => {
    const funding = [
      { marketId: null, availableBefore: 10, availableAfter: 5, suggestedTopUp: 0 },
      { marketId: 7, availableBefore: 1, availableAfter: 0, suggestedTopUp: 2 },
    ];
    const warn = liqWarnOf(funding);
    expect(warn({ marketId: 3 } as BorosSimulatedLeg)).toBe(false); // cross, covered
    expect(warn({ marketId: 7 } as BorosSimulatedLeg)).toBe(true); // its isolated account is short
    expect(liqWarnOf(undefined)({ marketId: 3 } as BorosSimulatedLeg)).toBe(true); // older server
  });
});

describe('blocked sizes', () => {
  const b = (code: string, maxSize?: number): BorosPairBlocker => ({ code, message: `${code} message`, maxSize });

  it('names the most specific reason for the button, and none for a blocker without one', () => {
    expect(blockerButtonReason([b('cross-short-margin'), b('insufficient-depth', 5)])).toBe('Insufficient liquidity');
    expect(blockerButtonReason([b('rate-bound-out-of-range', 5)])).toBe('Executed rate out of range');
    expect(blockerButtonReason([b('flip-unacknowledged')])).toBeNull();
  });

  it('folds every size blocker into one fillable line, rounded down, and keeps the rest', () => {
    const onUse = vi.fn();
    render(
      <BlockerList
        blockers={[b('insufficient-depth', 58.926), b('slippage-exceeds-max', 58.926), b('cross-short-margin')]}
        onUseSize={onUse}
        unit="BTC"
      />,
    );
    expect(screen.queryByText(/insufficient-depth message/)).toBeNull();
    expect(screen.getByText('cross-short-margin message')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '58.92 BTC' }));
    expect(onUse).toHaveBeenCalledWith(58.92);
  });
  it('a margin blocker keeps its own message and adds the size the margin funds', () => {
    const onUse = vi.fn();
    render(
      <BlockerList
        blockers={[b('cross-short-margin', 259.87), b('insufficient-depth', 8365)]}
        onUseSize={onUse}
        unit="ETH"
      />,
    );
    const cross = screen.getByText(/cross-short-margin message/).closest('li')!;
    expect(cross.textContent).toBe('cross-short-margin message Max size your margin funds: 259.8 ETH');
    // The book's own limit still has its line.
    expect(screen.getByText(/Max fillable size/).closest('li')!.textContent).toBe('Max fillable size: 8,365 ETH');
    fireEvent.click(screen.getByRole('button', { name: '259.8 ETH' }));
    expect(onUse).toHaveBeenCalledWith(259.8);
  });

  it('only the smallest size is a button; a larger limit is text', () => {
    const sizes = (blockers: BorosPairBlocker[]) => {
      cleanup();
      render(<BlockerList blockers={blockers} onUseSize={() => {}} unit="ETH" />);
      return screen.queryAllByRole('button').map((x) => x.textContent);
    };
    // The margin funds less than the book fills.
    expect(sizes([b('insufficient-depth', 8365), b('cross-short-margin', 763)])).toEqual(['763 ETH']);
    expect(screen.getByText(/Max fillable size/).closest('li')!.textContent).toBe('Max fillable size: 8,365 ETH');
    // The book fills less than the margin funds.
    expect(sizes([b('insufficient-depth', 300), b('cross-short-margin', 763)])).toEqual(['300 ETH']);
    expect(screen.getByText(/cross-short-margin message/).closest('li')!.textContent).toMatch(/funds: 763 ETH$/);
    // Nothing in the book fills: no size to press.
    expect(sizes([b('insufficient-depth', 0), b('cross-short-margin', 763)])).toEqual([]);
  });

  it('a margin blocker with no size, or a ticket that cannot resize, shows the message alone', () => {
    render(<BlockerList blockers={[b('cross-short-margin')]} onUseSize={() => {}} unit="ETH" />);
    expect(screen.getByText('cross-short-margin message').closest('li')!.textContent).toBe('cross-short-margin message');
    cleanup();
    render(<BlockerList blockers={[b('cross-short-margin', 259.87)]} unit="ETH" />);
    expect(screen.getByText('cross-short-margin message').closest('li')!.textContent).toBe('cross-short-margin message');
  });

  it.each([
    ['insufficient-depth', 'Insufficient liquidity'],
    ['slippage-exceeds-max', 'Slippage above max'],
    ['rate-bound-out-of-range', 'Executed rate out of range'],
  ])('the button names the margin when it funds less than %s allows, and the book when it does not', (code, bookReason) => {
    expect(blockerButtonReason([b(code, 8365), b('cross-short-margin', 763)])).toBe('Insufficient margin');
    expect(blockerButtonReason([b(code, 300), b('cross-short-margin', 763)])).toBe(bookReason);
    expect(blockerButtonReason([b(code, 300), b('cross-short-margin')])).toBe(bookReason);
  });
  it('says which limit stopped the size: nothing more for a thin book, slippage, or Boros\'s band', () => {
    const line = (blockers: BorosPairBlocker[]) => {
      cleanup();
      render(<BlockerList blockers={blockers} onUseSize={() => {}} unit="BTC" />);
      return screen.getByText(/Max fillable size/).closest('li')!.textContent;
    };
    expect(line([b('insufficient-depth', 10), b('slippage-exceeds-max', 10)])).toBe('Max fillable size: 10 BTC');
    expect(line([b('slippage-exceeds-max', 10)])).toBe('Raise max slippage or reduce the size. Max fillable size: 10 BTC');
    expect(line([{ ...b('rate-bound-out-of-range', 10), limitApr: 0.0612 }])).toBe(
      'Boros only fills this market up to 6.12% right now. Max fillable size: 10 BTC',
    );
  });
});
