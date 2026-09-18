import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import App from '../App';
import type { BorosAgentStatus, OpenOrder, TelegramInfo, TradesResponse, VenueFees } from '../api/types';
import { STRATEGY_STORAGE_KEY } from '../panels/HomeControls';
import { SETUP_SHOWN_KEY } from '../panels/setup/setupState';
import { agentStatus, assetView, baseHandlers, makeOpportunitiesResult, opportunitiesHandler, telegramInfo } from '../test/fixtures';
import { env, server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { FinishSetupPill } from './FinishSetupPill';

const PASTED = `0x3f2a${'1'.repeat(32)}91c0`;

const agentOff = agentStatus();
const agentOn = agentStatus({ configured: true, root: `0xab18${'0'.repeat(32)}ed9d` });

const telegramOff = telegramInfo();
const telegramOn = telegramInfo({ connected: true, state: 'connected', settings: { liquidation: true, interest: true } });

let served = new Set<string>();

function mockApp(agent: BorosAgentStatus, telegram: TelegramInfo) {
  served = new Set();
  localStorage.setItem(SETUP_SHOWN_KEY, 'true');
  server.use(
    http.get('/api/credentials', () => HttpResponse.json(env({ configured: true, keyMasked: '160e…4f80' }))),
    http.get('/api/boros/agent', () => {
      served.add('agent');
      return HttpResponse.json(env(agent));
    }),
    http.get('/api/telegram', () => {
      served.add('telegram');
      return HttpResponse.json(env(telegram));
    }),
    ...baseHandlers(),
    opportunitiesHandler(makeOpportunitiesResult()),
    http.get('/api/orders/open', () => HttpResponse.json(env<OpenOrder[]>([]))),
    http.get('/api/trades', () =>
      HttpResponse.json(env<TradesResponse>({ trades: [], page: 1, limit: 100, hasMore: false })),
    ),
    http.get('/api/fees', () => HttpResponse.json(env<VenueFees[]>([]))),
    http.get('/api/baskets', () => HttpResponse.json(env([]))),
    http.get('/api/asset-view/:address', () => HttpResponse.json(env(assetView))),
  );
}

async function renderSettled() {
  renderWithClient(<App />);
  await screen.findByRole('tablist', { name: 'Sections' });
  await waitFor(() => expect(served.has('agent') && served.has('telegram')).toBe(true));
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
}

describe('FinishSetupPill', () => {
  it('shows the done count', async () => {
    mockApp(agentOn, telegramOff);
    renderWithClient(<App />);

    const pill = await screen.findByRole('button', { name: 'Finish setup 2/3' });
    expect(pill.closest('header')).not.toBeNull();
    expect(pill).toHaveClass('text-amber-400');
  });

  it('pasted address counts', async () => {
    localStorage.setItem(STRATEGY_STORAGE_KEY, JSON.stringify({ address: PASTED }));
    mockApp(agentOff, telegramOn);
    await renderSettled();

    expect(screen.queryByRole('button', { name: /^Finish setup/ })).toBeNull();
  });

  it('hidden when done', async () => {
    mockApp(agentOn, telegramOn);
    await renderSettled();
    expect(screen.queryByRole('button', { name: /^Finish setup/ })).toBeNull();

    const { container } = render(<FinishSetupPill doneCount={3} onOpen={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('opens settings at the first missing row', async () => {
    const user = userEvent.setup();
    mockApp(agentOff, telegramOn);
    renderWithClient(<App />);

    await user.click(await screen.findByRole('button', { name: 'Finish setup 2/3' }));

    const drawer = await screen.findByRole('dialog', { name: 'Settings' });
    const row = (name: string) => within(drawer).getByRole('region', { name });
    expect(within(row('Boros wallet')).getByRole('button', { name: 'Done' })).toBeInTheDocument();
    expect(within(row('Gate API key')).getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(await within(row('Telegram alerts')).findByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  it('replaced counts as not done', async () => {
    mockApp(agentOn, { ...telegramOn, state: 'replaced' });
    renderWithClient(<App />);

    expect(await screen.findByRole('button', { name: 'Finish setup 2/3' })).toBeInTheDocument();
  });
});
