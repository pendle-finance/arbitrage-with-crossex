import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import App from './App';
import type { OpenOrder, TradesResponse, VenueFees } from './api/types';
import { ACTIVE_TAB_KEY } from './components/TabBar';
import { SETUP_SHOWN_KEY } from './panels/setup/setupState';
import {
  agentStatus,
  baseHandlers,
  makeOpportunitiesResult,
  opportunitiesHandler,
  setupHandlers,
  telegramInfo,
} from './test/fixtures';
import { env, server } from './test/server';
import { renderWithClient } from './test/utils';

function mockApp() {
  localStorage.setItem(SETUP_SHOWN_KEY, 'true');
  server.use(
    http.get('/api/credentials', () => HttpResponse.json(env({ configured: true, keyMasked: '160e…4f80' }))),
    ...setupHandlers(
      agentStatus({ configured: true, root: `0xab18${'0'.repeat(32)}ed9d` }),
      telegramInfo({ connected: true, state: 'connected', settings: { liquidation: true, interest: true } }),
    ),
    ...baseHandlers(),
    opportunitiesHandler(makeOpportunitiesResult()),
    http.get('/api/orders/open', () => HttpResponse.json(env<OpenOrder[]>([]))),
    http.get('/api/trades', () =>
      HttpResponse.json(env<TradesResponse>({ trades: [], page: 1, limit: 100, hasMore: false })),
    ),
    http.get('/api/fees', () => HttpResponse.json(env<VenueFees[]>([]))),
    http.get('/api/baskets', () => HttpResponse.json(env([]))),
  );
}

async function selectedTab(): Promise<HTMLElement> {
  await screen.findByRole('tablist', { name: 'Sections' });
  return screen.getByRole('tab', { selected: true });
}

afterEach(() => window.history.replaceState(null, '', '/'));

describe('deep link', () => {
  it('tab from the URL', async () => {
    window.history.replaceState(null, '', '/?tab=balances');
    localStorage.setItem(ACTIVE_TAB_KEY, JSON.stringify('fees'));
    mockApp();
    renderWithClient(<App />);

    expect(await selectedTab()).toHaveAccessibleName(/^Balances/);
  });

  it('an unknown tab in the URL keeps the stored tab', async () => {
    window.history.replaceState(null, '', '/?tab=nope');
    localStorage.setItem(ACTIVE_TAB_KEY, JSON.stringify('fees'));
    mockApp();
    renderWithClient(<App />);

    expect(await selectedTab()).toHaveAccessibleName(/^Fees/);
  });

  it('drops the tab param from the URL after reading it, so a reload trusts the stored tab', async () => {
    window.history.replaceState(null, '', '/?tab=balances');
    localStorage.setItem(ACTIVE_TAB_KEY, JSON.stringify('fees'));
    mockApp();
    renderWithClient(<App />);

    await selectedTab();
    expect(window.location.search).toBe('');
  });
});
