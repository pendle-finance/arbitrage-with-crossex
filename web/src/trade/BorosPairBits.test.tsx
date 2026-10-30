import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BorosPairSimulation, BorosSimulatedLeg } from '../api/types';
import { LiquidationRows, UnevenFillWarning } from './BorosPairBits';

const leg = (venue: string, liquidationApr: number | null, resultingSize: number): BorosSimulatedLeg =>
  ({
    venue,
    execApr: 0.09,
    liquidationApr,
    sizing: { resultingSize },
  }) as unknown as BorosSimulatedLeg;

describe('LiquidationRows', () => {
  it('shows the rate, N/A as the Boros app does when an open leg has none, and — for a flat leg', () => {
    const sim = {
      legs: [leg('Gate', 0.0996, -100), leg('Hyperliquid', null, 100), leg('Binance', null, 0)],
    } as unknown as BorosPairSimulation;
    render(<LiquidationRows sim={sim} />);
    expect(screen.getByText('9.96%')).toBeInTheDocument();
    expect(screen.getByText('N/A')).toHaveAttribute(
      'title',
      'Position risk is low, so there is no liquidation rate for the time being.',
    );
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});

describe('UnevenFillWarning', () => {
  const pair = (hedgedSize: number, unhedgedSize: number) =>
    ({
      legs: [leg('Gate', null, -1), leg('Hyperliquid', null, 1)],
      hedgedSize,
      unhedgedSize,
      collateral: 'ETH',
    }) as unknown as BorosPairSimulation;

  it('names the hedged and unhedged sizes and sets the size to the hedged one', () => {
    const onUse = vi.fn();
    render(<UnevenFillWarning sim={pair(0.775, 0.225)} onUse={onUse} />);
    expect(
      screen.getByText('Only 0.775 ETH fills on both legs. 0.225 ETH would be left unhedged.'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Use 0.775 ETH' }));
    expect(onUse).toHaveBeenCalledWith(0.775);
  });

  it('shows no button without a handler', () => {
    render(<UnevenFillWarning sim={pair(0.775, 0.225)} />);
    expect(screen.getByText(/would be left unhedged/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders nothing when both legs fill evenly, one leg fills nothing, or only one leg trades', () => {
    const { container, rerender } = render(<UnevenFillWarning sim={pair(1, 0)} onUse={() => {}} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<UnevenFillWarning sim={pair(0, 0.775)} onUse={() => {}} />);
    expect(container).toBeEmptyDOMElement();
    rerender(
      <UnevenFillWarning
        sim={{ ...pair(1, 0.2), legs: [leg('Gate', null, 1)] } as BorosPairSimulation}
        onUse={() => {}}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
