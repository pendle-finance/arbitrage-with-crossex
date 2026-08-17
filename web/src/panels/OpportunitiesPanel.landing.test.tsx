import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeOpportunitiesResult, opportunitiesHandler } from '../test/fixtures';
import { server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { OpportunitiesPanel, OPPORTUNITIES_STORAGE_KEY } from './OpportunitiesPanel';

/**
 * The LANDING build's two deviations from the terminal, both invisible to the
 * rest of the suite because `IS_LANDING` is false there.
 *
 * `IS_LANDING` is a module constant read at import time, so it is mocked at the
 * top of the module graph — `vi.mock` is hoisted above the imports above.
 */
vi.mock('../lib/landing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/landing')>();
  return { ...actual, IS_LANDING: true };
});

beforeEach(() => {
  localStorage.clear();
});

describe('OpportunitiesPanel — landing build', () => {
  it('persists under its OWN storage key, so the two builds cannot overwrite each other', () => {
    // The panel writes on MOUNT (the debounced-size effect fires immediately
    // because useDebounced seeds its state), so a shared key let whichever
    // build painted last silently re-set the other's controls — making each
    // build's own defaults unreachable after one visit to the other.
    expect(OPPORTUNITIES_STORAGE_KEY).toBe('crossex.opportunities.landing.v2');
  });

  it('a terminal-written blob cannot reach this build', async () => {
    localStorage.setItem(
      'crossex.opportunities.v2',
      JSON.stringify({
        notionalChoice: '10k',
        customNotionalUsd: 10_000,
        borosEntry: 'market',
        entryMode: 'both-market',
        exitMode: 'close',
        feeTier: 'vip0',
      }),
    );
    server.use(opportunitiesHandler(makeOpportunitiesResult()));
    renderWithClient(<OpportunitiesPanel unconfigured />);

    // $100k, not the terminal blob's $10k: the landing prices its headline at
    // LANDING_NOTIONAL_USD and the panel behind it must agree.
    await waitFor(() => expect(screen.getByText(/\$100k notional/)).toBeInTheDocument());
  });

  it('renders no Execute button — executing needs the terminal on your machine', async () => {
    server.use(opportunitiesHandler(makeOpportunitiesResult()));
    renderWithClient(<OpportunitiesPanel unconfigured />);

    // Details is the control that DOES work without keys, so its presence is
    // what proves the cards rendered at all.
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /details/i }).length).toBeGreaterThan(0),
    );
    expect(screen.queryByRole('button', { name: /execute it/i })).toBeNull();
  });
});
