/** The public shell (Variant A — "the number leads"): a bare hero number, the
 * live 4-leg diagram that explains it, a shop-window spreads list, "three
 * things you need" as the OVERVIEW's only setup surface, and an FAQ holding the
 * caveats.
 *
 * These cover the `overview` route. The page also has a `#/rates` route
 * (RatesExplorer: the full opportunities panel plus the restored
 * LandingOnboardingGuide rail) — see useHashRoute.test.tsx and
 * RatesExplorer.test.tsx. The terminal's own OnboardingGuide is a different
 * component and is untouched. */
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LandingApp } from './LandingApp';
import { baseHandlers, makeOpportunitiesResult, opportunitiesHandler } from './test/fixtures';
import { server } from './test/server';
import { renderWithClient } from './test/utils';

describe('LandingApp', () => {
  it('renders the scroll narrative: hero, live mechanism, spreads, 3 things, FAQ', async () => {
    server.use(...baseHandlers(), opportunitiesHandler(makeOpportunitiesResult()));
    renderWithClient(<LandingApp />);

    // The h1 spans two lines ("…arbitrage." / "Leveraged."), so match the
    // heading by role rather than its full text.
    expect(
      await screen.findByRole('heading', { level: 1, name: /funding rate arbitrage/i }),
    ).toBeInTheDocument();
    expect(screen.getByText('Also live')).toBeInTheDocument();
    expect(screen.getByText('Three things you need')).toBeInTheDocument();
    expect(screen.getByText('Questions & caveats')).toBeInTheDocument();
    expect(screen.getByText('The terminal')).toBeInTheDocument();
  });

  it('states the caveats without a doubt-first headline', async () => {
    server.use(...baseHandlers(), opportunitiesHandler(makeOpportunitiesResult()));
    renderWithClient(<LandingApp />);
    await screen.findByRole('heading', { level: 1, name: /funding rate arbitrage/i });

    // The concerns survived the move into the FAQ...
    expect(screen.getByText('Who built this?')).toBeInTheDocument();
    expect(screen.getByText('Who holds my funds and keys?')).toBeInTheDocument();
    expect(screen.getByText('Can it lose money?')).toBeInTheDocument();
    // ...but the section no longer leads with the objection as a headline.
    expect(screen.queryByText('Before you trust it with a key')).toBeNull();
  });

  it('has one setup surface, not a duplicate step rail', async () => {
    server.use(...baseHandlers(), opportunitiesHandler(makeOpportunitiesResult()));
    renderWithClient(<LandingApp />);
    await screen.findByText('Three things you need');

    expect(screen.queryByText("Ready? Here's every step")).toBeNull();
    expect(screen.queryByRole('button', { name: /^Install the terminal/ })).toBeNull();
    // The rail's instructions still exist — inside the cards.
    expect(screen.getByText('Cross-Exchange, Read and Write')).toBeInTheDocument();
  });

  it('exposes no credential surface anywhere on the public shell', async () => {
    server.use(...baseHandlers(), opportunitiesHandler(makeOpportunitiesResult()));
    renderWithClient(<LandingApp />);
    await screen.findByText('Three things you need');

    expect(screen.queryByLabelText(/API key/i)).toBeNull();
    expect(screen.queryByLabelText(/API secret/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /Settings/i })).toBeNull();
  });
});
