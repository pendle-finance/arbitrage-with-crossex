import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import App from './App';
import type { OpenOrder, PositionsResponse, TradesResponse, VenueFees } from './api/types';
import { TAB_IDS } from './components/TabBar';
import { SETUP_SHOWN_KEY } from './panels/setup/setupState';
import { baseHandlers, ethPosition, makeOpportunitiesResult, opportunitiesHandler } from './test/fixtures';
import { env, server } from './test/server';
import { renderWithClient } from './test/utils';

type User = ReturnType<typeof userEvent.setup>;

function mockFirstRun() {
  let keyConfigured = false;
  server.use(
    http.get('/api/credentials', () =>
      HttpResponse.json(env({ configured: keyConfigured, keyMasked: keyConfigured ? '160e…4f80' : null })),
    ),
    http.put('/api/credentials', () => {
      keyConfigured = true;
      return HttpResponse.json(env({ configured: true, keyMasked: '160e…4f80' }));
    }),
    ...baseHandlers(),
    opportunitiesHandler(makeOpportunitiesResult()),
    http.get('/api/orders/open', () => HttpResponse.json(env<OpenOrder[]>([]))),
    http.get('/api/trades', () =>
      HttpResponse.json(env<TradesResponse>({ trades: [], page: 1, limit: 100, hasMore: false })),
    ),
    http.get('/api/fees', () => HttpResponse.json(env<VenueFees[]>([]))),
    http.get('/api/baskets', () => HttpResponse.json(env([]))),
  );
  server.use(
    http.get('/api/positions', () =>
      HttpResponse.json(env<PositionsResponse>({ positions: [ethPosition], exposure: [] })),
    ),
  );
}

async function saveKey(user: User) {
  await user.type(await screen.findByPlaceholderText('Gate API key'), 'key-160e4f80');
  await user.type(screen.getByPlaceholderText('Gate API secret'), 'secret');
  await user.click(screen.getByRole('button', { name: 'Check key' }));
  await within(screen.getByRole('region', { name: 'Gate API key' })).findByText('160e…4f80 · works');
}

async function skipOpenRow(user: User) {
  await user.click(await screen.findByRole('button', { name: 'Skip, not recommended' }));
  await user.click(screen.getByRole('button', { name: 'Skip anyway' }));
}

describe('first run', () => {
  it('checklist stays until finish', async () => {
    const user = userEvent.setup();
    mockFirstRun();
    renderWithClient(<App />);

    await saveKey(user);
    expect(
      await within(screen.getByRole('region', { name: 'Boros wallet' })).findByText('Install Rabby or MetaMask, then reload.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Set up the terminal')).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).toBeNull();

    await skipOpenRow(user);
    expect(await screen.findByRole('button', { name: 'Set up ↗' })).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).toBeNull();

    await skipOpenRow(user);
    const tabs = await screen.findByRole('tablist', { name: 'Sections' });
    expect(within(tabs).getByRole('tab', { name: /^Opportunities/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByText('Set up the terminal')).toBeNull();
    expect(localStorage.getItem(SETUP_SHOWN_KEY)).toBe('true');
    expect(await screen.findByRole('button', { name: 'Finish setup 1/3' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull();
  });

  it('no rail', async () => {
    const user = userEvent.setup();
    mockFirstRun();
    renderWithClient(<App />);
    await saveKey(user);
    await skipOpenRow(user);
    await skipOpenRow(user);
    await screen.findByRole('tablist', { name: 'Sections' });

    for (const id of TAB_IDS) {
      await user.click(document.getElementById(`tab-${id}`)!);
      expect(document.getElementById(`tab-${id}`)).toHaveAttribute('aria-selected', 'true');
      expect(screen.queryByText('How to execute')).toBeNull();
      expect(screen.queryByRole('complementary', { name: 'Setup guide' })).toBeNull();
    }
  });
});
