import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import App from './App';
import type { OpenOrder, TradesResponse, VenueFees } from './api/types';
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

function mockUpdatedApp() {
  server.use(
    http.get('/api/credentials', () => HttpResponse.json(env({ configured: true, keyMasked: '160e…4f80' }))),
    ...setupHandlers(agentStatus({ configured: true, root: `0xab18${'0'.repeat(32)}ed9d` }), telegramInfo()),
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

describe('settings after an update', () => {
  it('opens settings once', async () => {
    mockUpdatedApp();
    renderWithClient(<App />);

    const drawer = await screen.findByRole('dialog', { name: 'Settings' });
    const row = (name: string) => within(drawer).getByRole('region', { name });
    expect(within(row('Telegram alerts')).getByRole('button', { name: 'Collapse' })).toBeInTheDocument();
    expect(within(row('Boros wallet')).getByRole('button', { name: 'Expand' })).toBeInTheDocument();
    expect(localStorage.getItem(SETUP_SHOWN_KEY)).toBe('true');
  });

  it('only once', async () => {
    const user = userEvent.setup();
    mockUpdatedApp();
    const first = renderWithClient(<App />);
    const drawer = await screen.findByRole('dialog', { name: 'Settings' });
    await user.click(within(drawer).getByRole('button', { name: 'close' }));
    first.unmount();

    renderWithClient(<App />);
    expect(await screen.findByRole('button', { name: 'Finish setup 2/3' })).toBeInTheDocument();
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull();
  });
});
