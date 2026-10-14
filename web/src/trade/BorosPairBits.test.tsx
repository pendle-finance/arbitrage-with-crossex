import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { BorosPairSimulation, BorosSimulatedLeg } from '../api/types';
import { LiquidationRows } from './BorosPairBits';

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
