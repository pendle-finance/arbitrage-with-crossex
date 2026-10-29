import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  makeOpportunitiesResult,
  makeOpportunityBorosLeg,
  makeOpportunityGroup,
  makeSpreadOpportunityPair,
  opportunitiesHandler,
  SPREAD_OPP_MATURITY,
  SPREAD_OPP_NOW,
} from '../test/fixtures';
import { server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { OpportunitiesPanel } from './OpportunitiesPanel';

const toggles = () => screen.getAllByRole('button', { name: /^(Show|Hide) details for/ });

const spreadResult = (pair = makeSpreadOpportunityPair()) =>
  makeOpportunitiesResult({
    groups: [
      makeOpportunityGroup({
        tokenId: 2,
        collateral: 'ETH',
        collateralPriceUsd: 1900,
        maturity: SPREAD_OPP_MATURITY,
        secondsToMaturity: SPREAD_OPP_MATURITY - SPREAD_OPP_NOW,
        pairs: [pair],
      }),
    ],
  });

describe('OpportunitiesPanel — spread market', () => {
  it('spread details', async () => {
    server.use(opportunitiesHandler(spreadResult()));
    renderWithClient(<OpportunitiesPanel />);
    await waitFor(() => expect(toggles()).toHaveLength(1));
    await userEvent.click(toggles()[0]);

    expect(screen.getByText(/2 perps \+ 1 spread position ·/)).toBeInTheDocument();
    expect(screen.queryByText(/2 perps \+ 2 Boros positions ·/)).not.toBeInTheDocument();

    const borosLinks = screen.getAllByRole('link', { name: /funding on Boros/ });
    expect(borosLinks).toHaveLength(1);
    expect(borosLinks[0]).toHaveAccessibleName('Short ETH Spread HL-GATE funding on Boros');
    expect(borosLinks[0]).toHaveAttribute(
      'href',
      'https://boros.pendle.finance/markets/59?form=market&direction=short',
    );

    const legLabels = ['Short ETH', 'Long ETH', 'Short ETH Spread HL-GATE'].map((label) => screen.getByText(label));
    expect(legLabels[0].compareDocumentPosition(legLabels[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(legLabels[1].compareDocumentPosition(legLabels[2]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('ETH Spread HL-GATE')).toBeInTheDocument();
    expect(screen.getAllByText(/ fixed$/)).toHaveLength(1);

    expect(screen.getByText('Boros spread margin')).toBeInTheDocument();
    expect(screen.queryByText('Boros short margin')).not.toBeInTheDocument();
    expect(screen.queryByText('Boros long margin')).not.toBeInTheDocument();
  });

  it.each([
    ['SHORT', 0.0348, 0.0343],
    ['LONG', -0.0348, -0.0343],
  ] as const)('shows a %s spread the trader receives as green and unsigned', async (side, midApr, execApr) => {
    const base = makeSpreadOpportunityPair();
    const pair = {
      ...base,
      borosLegs: [{ ...makeOpportunityBorosLeg({ ...base.borosLegs[0], side, midApr, execApr }) }],
    };
    server.use(opportunitiesHandler(spreadResult(pair)));
    renderWithClient(<OpportunitiesPanel />);
    await waitFor(() => expect(toggles()).toHaveLength(1));
    await userEvent.click(toggles()[0]);

    const chip = screen.getByText(/ fixed$/);
    expect(chip).toHaveTextContent(/^3\.4% fixed$/);
    expect(chip.className).toContain('text-grass');
    expect(screen.getAllByTitle(/^Modeled minimum capital .+ across the 2 perps and the spread position$/)).toHaveLength(2);
    expect(screen.getByTitle('The minimum capital this trade posts across the 2 perps and the spread position.')).toBeInTheDocument();
  });

  it('keeps one capital bar per Boros market for two single markets', async () => {
    server.use(opportunitiesHandler(makeOpportunitiesResult()));
    renderWithClient(<OpportunitiesPanel />);
    await waitFor(() => expect(toggles()).toHaveLength(1));
    await userEvent.click(toggles()[0]);

    expect(screen.getByText(/2 perps \+ 2 Boros positions ·/)).toBeInTheDocument();
    expect(screen.getByText('Boros short margin')).toBeInTheDocument();
    expect(screen.getByText('Boros long margin')).toBeInTheDocument();
    expect(screen.queryByText('Boros spread margin')).not.toBeInTheDocument();
    expect(screen.getAllByText(/ fixed$/)).toHaveLength(2);
    expect(screen.getAllByTitle(/^Modeled minimum capital .+ across the 2 perps and the 2 Boros positions$/)).toHaveLength(2);
    expect(screen.getByTitle('The minimum capital this trade posts across the 2 perps and the 2 Boros positions.')).toBeInTheDocument();
  });
});
