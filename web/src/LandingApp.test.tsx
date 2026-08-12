/** The public shell (Variant A — "the number leads"): a hero APY number, a
 * shop-window opportunities strip with no Execute button (nothing to prefill
 * on a page nobody is logged into — see landing/TopOpportunities.tsx), three
 * CTA cards, a trust section, then the full step-by-step guide as the closer.
 * The old Execute-nudge flow lived on OpportunitiesPanel's per-card button,
 * which this shell no longer renders; LandingOnboardingGuide's own nudge
 * behaviour is still covered by its own test file. */
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LandingApp } from './LandingApp';
import { baseHandlers, makeOpportunitiesResult, opportunitiesHandler } from './test/fixtures';
import { server } from './test/server';
import { renderWithClient } from './test/utils';

describe('LandingApp', () => {
  it('renders the full scroll narrative: hero, opportunities, 3 things, trust, and the guide', async () => {
    server.use(...baseHandlers(), opportunitiesHandler(makeOpportunitiesResult()));
    renderWithClient(<LandingApp />);

    expect(await screen.findByText('Fixed APR on capital, right now')).toBeInTheDocument();
    expect(screen.getByText('Live spreads')).toBeInTheDocument();
    expect(screen.getByText('Three things')).toBeInTheDocument();
    expect(screen.getByText('Before you trust it with a key')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /^Install the terminal/ })).toBeInTheDocument();
  });

  it('exposes no credential surface anywhere on the public shell', async () => {
    server.use(...baseHandlers(), opportunitiesHandler(makeOpportunitiesResult()));
    renderWithClient(<LandingApp />);
    await screen.findByRole('button', { name: /^Install the terminal/ });

    expect(screen.queryByLabelText(/API key/i)).toBeNull();
    expect(screen.queryByLabelText(/API secret/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /Settings/i })).toBeNull();
  });
});
