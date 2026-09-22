import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { TelegramInfo } from '../api/types';
import {
  agentStatus,
  mockWorld as mockSetupWorld,
  telegramInfo,
  versionHandler,
  type SetupWorld,
} from '../test/fixtures';
import { env, server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { SettingsDrawer } from './SettingsDrawer';
import type { SetupStep } from './setup/setupState';

const WALLET = `0xab18${'0'.repeat(32)}ed9d`;
const PASTED = `0x3f2a${'1'.repeat(32)}91c0`;
const CAVEAT =
  "Alerts use the terminal's last sync, at most 5 min old. A trade made outside the terminal reaches the alerts after the next sync.";

const connectedTelegram = (settings = { liquidation: true, interest: true, maturity: true, rollover: true }): TelegramInfo =>
  telegramInfo({ connected: true, state: 'connected', settings, lastSyncAt: Date.now() - 180_000 });

const at = (hours: number, minutes: number) => new Date(2026, 8, 18, hours, minutes).getTime();

function mockWorld(over: Partial<SetupWorld> = {}): SetupWorld {
  const world = mockSetupWorld(over);
  server.use(versionHandler({ current: '1.6.3', latest: '1.6.3' }));
  return world;
}

function mockAllDone(telegram: TelegramInfo = connectedTelegram()): SetupWorld {
  localStorage.setItem('crossex.strategy.v1', JSON.stringify({ address: WALLET }));
  return mockWorld({ keyConfigured: true, agent: agentStatus({ configured: true, root: WALLET }), telegram });
}

const renderDrawer = () => renderWithClient(<SettingsDrawer open onClose={vi.fn()} />);

const row = (name: string) => screen.getByRole('region', { name });

const trackedInStorage = (): unknown => JSON.parse(localStorage.getItem('crossex.strategy.v1') ?? 'null');

async function clickEdit(name: string) {
  const user = userEvent.setup();
  await user.click(await within(row(name)).findByRole('button', { name: 'Edit' }));
  return user;
}

const drive: { focus: (step: SetupStep | null) => void; setOpen: (open: boolean) => void } = {
  focus: () => undefined,
  setOpen: () => undefined,
};

function FocusHarness({ initial }: { initial: SetupStep | null }) {
  const [step, setStep] = useState<SetupStep | null>(initial);
  const [open, setOpen] = useState(true);
  drive.focus = setStep;
  drive.setOpen = setOpen;
  return <SettingsDrawer open={open} onClose={() => setOpen(false)} focusStep={step} />;
}

describe('SettingsDrawer', () => {
  it('setup rows', async () => {
    mockAllDone();
    renderDrawer();
    const version = await screen.findByText('Version 1.6.3');

    expect(screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))).toEqual([
      'Gate API key',
      'Boros wallet',
      'Telegram alerts',
    ]);
    expect(await within(row('Gate API key')).findByText('160e…4f80 · works')).toBeInTheDocument();
    expect(await within(row('Boros wallet')).findByText('0xab18…ed9d · trading enabled · tracked')).toBeInTheDocument();
    expect(await within(row('Telegram alerts')).findByText('All on · synced 3 min ago')).toBeInTheDocument();
    for (const name of ['Gate API key', 'Boros wallet', 'Telegram alerts']) {
      expect(within(row(name)).getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    }
    expect(row('Telegram alerts').compareDocumentPosition(version) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Replace credentials' })).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('telegram state line', async () => {
    mockAllDone();
    renderDrawer();
    expect(await within(row('Telegram alerts')).findByText('All on · synced 3 min ago')).toBeInTheDocument();
  });

  it('one alert off', async () => {
    mockAllDone(connectedTelegram({ liquidation: true, interest: false, maturity: true, rollover: true }));
    renderDrawer();
    expect(await within(row('Telegram alerts')).findByText('3 of 4 on · synced 3 min ago')).toBeInTheDocument();
  });

  it('edit telegram', async () => {
    mockAllDone();
    renderDrawer();
    await clickEdit('Telegram alerts');
    const telegram = row('Telegram alerts');

    expect(await within(telegram).findByRole('switch', { name: 'Close to liquidation' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(within(telegram).getByRole('switch', { name: 'Started paying interest' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(within(telegram).getByText('Last synced 3 min ago')).toBeInTheDocument();
    expect(within(telegram).getByText(CAVEAT)).toBeInTheDocument();
    expect(within(telegram).getByRole('button', { name: 'Disconnect this terminal' })).toBeInTheDocument();
    expect(within(telegram).getByRole('button', { name: 'Done' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Skip/ })).toBeNull();
  });

  it('switch saves', async () => {
    let patched: unknown = null;
    mockAllDone();
    server.use(
      http.patch('/api/telegram/settings', async ({ request }) => {
        patched = await request.json();
        return HttpResponse.json(env(connectedTelegram({ liquidation: true, interest: false, maturity: true, rollover: true })));
      }),
    );
    renderDrawer();
    const user = await clickEdit('Telegram alerts');
    await user.click(await screen.findByRole('switch', { name: 'Started paying interest' }));

    await waitFor(() => expect(patched).toEqual({ interest: false }));
  });

  it('four switches, and roll-over saves', async () => {
    let patched: unknown = null;
    mockAllDone();
    server.use(
      http.patch('/api/telegram/settings', async ({ request }) => {
        patched = await request.json();
        return HttpResponse.json(
          env(connectedTelegram({ liquidation: true, interest: true, maturity: true, rollover: false })),
        );
      }),
    );
    renderDrawer();
    const user = await clickEdit('Telegram alerts');
    const telegram = row('Telegram alerts');

    await within(telegram).findByRole('switch', { name: 'Close to liquidation' });
    expect(within(telegram).getAllByRole('switch').map((s) => s.textContent)).toEqual([
      'Close to liquidation',
      'Started paying interest',
      'Close to maturity',
      'Roll-over opportunity',
    ]);
    expect(within(telegram).getByText('daily in the last 7 days before a pair settles, with the better maturities to roll to')).toBeInTheDocument();
    expect(
      within(telegram).getByText('a later maturity pays a better APR'),
    ).toBeInTheDocument();
    await user.click(within(telegram).getByRole('switch', { name: 'Roll-over opportunity' }));

    await waitFor(() => expect(patched).toEqual({ rollover: false }));
  });

  it('sync failed', async () => {
    mockAllDone(
      telegramInfo({
        connected: true,
        state: 'connected',
        settings: { liquidation: true, interest: true, maturity: true, rollover: true },
        lastSyncAt: at(11, 40),
        lastSyncError: { at: at(14, 2), message: 'timeout' },
      }),
    );
    renderDrawer();
    const telegram = row('Telegram alerts');

    expect(await within(telegram).findByText('Last sync failed')).toBeInTheDocument();
    expect(
      within(telegram).getByText('Last sync failed at 14:02. Alerts still use the sync from 11:40. Retrying.'),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Last sync failed')).toHaveLength(1);
  });

  it('not set up row', async () => {
    mockAllDone(telegramInfo());
    renderDrawer();
    const telegram = row('Telegram alerts');

    expect(await within(telegram).findByText('not set up')).toHaveClass('text-amber-400');
    expect(within(telegram).getByRole('button', { name: 'Set up ↗' })).toBeInTheDocument();
    expect(within(telegram).queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('replaced', async () => {
    mockAllDone(telegramInfo({ state: 'replaced' }));
    renderDrawer();
    const telegram = row('Telegram alerts');

    expect(await within(telegram).findByText('Connected on another terminal')).toBeInTheDocument();
    expect(within(telegram).getByRole('button', { name: 'Set up ↗' })).toBeInTheDocument();
    expect(within(telegram).queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('removed', async () => {
    mockAllDone(telegramInfo({ state: 'removed' }));
    renderDrawer();
    const telegram = row('Telegram alerts');

    expect(await within(telegram).findByText('Removed on the Boros notifications page')).toBeInTheDocument();
    expect(within(telegram).getByRole('button', { name: 'Set up ↗' })).toBeInTheDocument();
    expect(within(telegram).queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('edit wallet opens the setup form', async () => {
    mockAllDone();
    renderDrawer();
    await clickEdit('Boros wallet');
    const wallet = row('Boros wallet');

    expect(await within(wallet).findByRole('radio', { name: 'Connect wallet' })).toBeInTheDocument();
    expect(within(wallet).getByRole('radio', { name: 'Paste address' })).toBeInTheDocument();
    expect(within(wallet).getByRole('button', { name: 'Close' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Replace credentials' })).toBeNull();
  });

  it('stop tracking stays', async () => {
    localStorage.setItem('crossex.strategy.v1', JSON.stringify({ address: PASTED }));
    mockWorld({ keyConfigured: true, telegram: connectedTelegram() });
    renderDrawer();
    const user = await clickEdit('Boros wallet');
    await user.click(await within(row('Boros wallet')).findByRole('button', { name: 'Stop tracking' }));

    expect(trackedInStorage()).toEqual({ address: null });
    expect(await within(row('Boros wallet')).findByText('not set up')).toBeInTheDocument();
  });

  it('approval expired', async () => {
    mockAllDone();
    server.use(
      http.get('/api/boros/agent', () =>
        HttpResponse.json(env(agentStatus({ configured: true, root: WALLET, expired: true, expiry: 1_700_000_000 }))),
      ),
    );
    renderDrawer();
    const wallet = row('Boros wallet');

    expect(await within(wallet).findByText('Approval expired')).toBeInTheDocument();
    expect(within(wallet).getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  it('edit key', async () => {
    mockAllDone();
    renderDrawer();
    await clickEdit('Gate API key');
    const key = row('Gate API key');

    expect(await within(key).findByRole('button', { name: 'Replace credentials' })).toBeInTheDocument();
    expect(within(key).getByPlaceholderText('Gate API key')).toBeInTheDocument();
    expect(within(key).getByPlaceholderText('Gate API secret')).toBeInTheDocument();
  });

  it('saved key closes the row', async () => {
    mockAllDone();
    server.use(
      http.put('/api/credentials', () => HttpResponse.json(env({ configured: true, keyMasked: '160e…4f80' }))),
    );
    renderDrawer();
    const user = await clickEdit('Gate API key');
    await user.type(await screen.findByPlaceholderText('Gate API key'), 'key-160e4f80');
    await user.type(screen.getByPlaceholderText('Gate API secret'), 'secret');
    await user.click(screen.getByRole('button', { name: 'Replace credentials' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Replace credentials' })).toBeNull());
    expect(within(row('Gate API key')).getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });
});

describe('SettingsDrawer · focus step', () => {
  it('focus step opens its row', async () => {
    mockAllDone(telegramInfo());
    renderWithClient(<FocusHarness initial="telegram" />);
    const telegram = row('Telegram alerts');

    expect(await within(telegram).findByText('a 20% price move would liquidate a leg')).toBeInTheDocument();
    expect(within(telegram).getByRole('button', { name: 'Done' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Replace credentials' })).toBeNull();
    expect(screen.queryByRole('radio', { name: 'Paste address' })).toBeNull();
  });

  it('new focus step opens the new row', async () => {
    mockAllDone(telegramInfo());
    renderWithClient(<FocusHarness initial="telegram" />);
    await within(row('Telegram alerts')).findByText('a 20% price move would liquidate a leg');
    act(() => drive.focus('gateKey'));

    expect(await screen.findByRole('button', { name: 'Replace credentials' })).toBeInTheDocument();
    expect(within(row('Telegram alerts')).queryByText('a 20% price move would liquidate a leg')).toBeNull();
  });

  it('reopening opens the focus step again', async () => {
    mockAllDone(telegramInfo());
    renderWithClient(<FocusHarness initial="telegram" />);
    const user = await clickEdit('Boros wallet');
    expect(await screen.findByRole('radio', { name: 'Paste address' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'close' }));
    act(() => drive.setOpen(true));

    expect(await within(row('Telegram alerts')).findByText('a 20% price move would liquidate a leg')).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Paste address' })).toBeNull();
  });

  it('no focus step opens no row', async () => {
    mockAllDone(telegramInfo());
    renderWithClient(<FocusHarness initial={null} />);

    expect(await within(row('Telegram alerts')).findByRole('button', { name: 'Set up ↗' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
  });
});
