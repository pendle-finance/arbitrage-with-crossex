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


async function clickEdit(name: string) {
  const user = userEvent.setup();
  await user.click(await within(row(name)).findByRole('button', { name: 'Expand' }));
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
  it('about links to the source on GitHub', async () => {
    mockAllDone();
    renderDrawer();
    await screen.findByText('Version 1.6.3');
    expect(screen.getByRole('link', { name: 'GitHub' })).toHaveAttribute(
      'href',
      'https://github.com/pendle-finance/arbitrage-with-crossex',
    );
  });

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
    expect(await within(row('Boros wallet')).findByText('Logged in')).toBeInTheDocument();
    expect(within(row('Boros wallet')).getByText('0xab18…ed9d')).toBeInTheDocument();
    expect(await within(row('Telegram alerts')).findByText('All on · synced 3 min ago')).toBeInTheDocument();
    for (const name of ['Gate API key', 'Boros wallet', 'Telegram alerts']) {
      expect(within(row(name)).getByRole('button', { name: 'Expand' })).toBeInTheDocument();
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
    const user = userEvent.setup();
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
    await user.hover(within(telegram).getByText('synced 3 min ago'));
    expect(await screen.findByText(CAVEAT)).toBeInTheDocument();
    expect(within(telegram).getByRole('button', { name: 'Disconnect this terminal' })).toBeInTheDocument();
    expect(within(telegram).getByRole('button', { name: 'Collapse' })).toBeInTheDocument();
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
    expect(within(telegram).queryByText(/Last sync failed at/)).toBeNull();
    await clickEdit('Telegram alerts');
    expect(
      await within(telegram).findByText('Last sync failed at 14:02. Alerts still use the sync from 11:40. Retrying.'),
    ).toBeInTheDocument();
    expect(within(telegram).queryByText('Last sync failed')).toBeNull();
  });

  it('not set up row', async () => {
    mockAllDone(telegramInfo());
    renderDrawer();
    const telegram = row('Telegram alerts');

    expect(await within(telegram).findByText('not set up')).toHaveClass('text-amber-400');
    expect(within(telegram).getByRole('button', { name: 'Set up' })).toBeInTheDocument();
    expect(within(telegram).queryByRole('button', { name: 'Expand' })).toBeNull();
  });

  it('replaced', async () => {
    mockAllDone(telegramInfo({ state: 'replaced' }));
    renderDrawer();
    const telegram = row('Telegram alerts');

    expect(await within(telegram).findByText('not set up')).toBeInTheDocument();
    expect(within(telegram).getByRole('button', { name: 'Set up' })).toBeInTheDocument();
    expect(within(telegram).queryByRole('button', { name: 'Expand' })).toBeNull();
  });

  it('removed', async () => {
    mockAllDone(telegramInfo({ state: 'removed' }));
    renderDrawer();
    const telegram = row('Telegram alerts');

    expect(await within(telegram).findByText('not set up')).toBeInTheDocument();
    expect(within(telegram).getByRole('button', { name: 'Set up' })).toBeInTheDocument();
    expect(within(telegram).queryByRole('button', { name: 'Expand' })).toBeNull();
  });

  it('edit wallet shows the login and log out', async () => {
    mockAllDone();
    renderDrawer();
    await clickEdit('Boros wallet');
    const wallet = row('Boros wallet');

    expect(await within(wallet).findByText(/The key cannot withdraw\.$/)).toBeInTheDocument();
    expect(within(wallet).getByRole('button', { name: 'Log out' })).toBeInTheDocument();
    expect(within(wallet).queryByRole('radio')).toBeNull();
    expect(within(wallet).getByRole('button', { name: 'Collapse' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Replace credentials' })).toBeNull();
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

    expect(await within(wallet).findByText('Login expired')).toBeInTheDocument();
    expect(within(wallet).getByRole('button', { name: 'Expand' })).toBeInTheDocument();
  });

  it('telegram says which wallet alerts follow', async () => {
    mockAllDone({ ...connectedTelegram(), alertWallet: WALLET });
    renderDrawer();
    await clickEdit('Telegram alerts');
    expect(await within(row('Telegram alerts')).findByText('Alerts for 0xab18…ed9d ·')).toBeInTheDocument();
  });

  it('telegram before the first sync reads "Checking…", not a green "None on"', async () => {
    mockAllDone({ ...connectedTelegram(), settings: null, lastSyncAt: null, lastSyncError: null });
    renderDrawer();
    const telegram = row('Telegram alerts');
    expect(await within(telegram).findByText('Checking…')).toBeInTheDocument();
    expect(within(telegram).queryByText(/None on/)).toBeNull();
    expect(within(telegram).queryByRole('button', { name: /Set up/ })).toBeNull();
  });

  it('telegram links to the Boros notifications page', async () => {
    mockAllDone({ ...connectedTelegram(), alertWallet: WALLET, alertsPageUrl: 'https://bot.example/alerts' });
    renderDrawer();
    await clickEdit('Telegram alerts');
    const link = await within(row('Telegram alerts')).findByRole('link', { name: 'Boros notifications' });
    expect(link).toHaveAttribute('href', 'https://bot.example/alerts');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('telegram is not set up for a wallet the bot has no link for', async () => {
    mockAllDone({ ...connectedTelegram(), alertWallet: WALLET, unlinkedWallet: PASTED });
    renderDrawer();
    const telegram = row('Telegram alerts');
    // Closed row: it reads like a row never set up; the opened row names the wallet.
    expect(await within(telegram).findByRole('button', { name: 'Set up' })).toBeInTheDocument();
    expect(within(telegram).getByText('not set up')).toBeInTheDocument();
  });

  it('telegram sets up alerts for the new wallet with the same key', async () => {
    const user = userEvent.setup();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    let linkBody: unknown = null;
    mockAllDone({ ...connectedTelegram(), alertWallet: WALLET, unlinkedWallet: PASTED });
    const url = 'https://bot.test/alerts?crossex=c';
    server.use(
      http.post('/api/telegram/link', async ({ request }) => {
        linkBody = await request.json();
        return HttpResponse.json(env({ url, expiresAt: Date.now() + 600_000 }));
      }),
      http.get('/api/telegram/link', () => HttpResponse.json(env({ status: 'pending', url, expiresAt: Date.now() + 600_000 }))),
    );
    try {
      renderWithClient(<FocusHarness initial="telegram" />);
      const telegram = row('Telegram alerts');
      expect(
        await within(telegram).findByText(
          'Telegram alerts are set up per wallet. Set up once for 0x3f2a…91c0. You can use the same Telegram chat.',
        ),
      ).toBeInTheDocument();
      expect(within(telegram).getByRole('button', { name: 'Disconnect this terminal' })).toBeInTheDocument();
      expect(within(telegram).queryByText(/Alerts for 0x/)).toBeNull();
      expect(within(telegram).queryByRole('switch')).toBeNull();
      await user.click(within(telegram).getByRole('button', { name: 'Set up alerts for 0x3f2a…91c0' }));
      await waitFor(() => expect(linkBody).toEqual({ addWallet: true }));
      expect(open).toHaveBeenCalledTimes(1);
      expect(
        await within(telegram).findByText('Waiting for you to confirm on the Boros notifications page'),
      ).toBeInTheDocument();
    } finally {
      open.mockRestore();
    }
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
    expect(within(row('Gate API key')).getByRole('button', { name: 'Expand' })).toBeInTheDocument();
  });
});

describe('SettingsDrawer · focus step', () => {
  it('focus step opens its row', async () => {
    mockAllDone(telegramInfo());
    renderWithClient(<FocusHarness initial="telegram" />);
    const telegram = row('Telegram alerts');

    expect(await within(telegram).findByText('a 20% price move would liquidate a leg')).toBeInTheDocument();
    expect(within(telegram).getByRole('button', { name: 'Collapse' })).toBeInTheDocument();
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
    expect(await screen.findByRole('button', { name: 'Log out' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'close' }));
    act(() => drive.setOpen(true));

    expect(await within(row('Telegram alerts')).findByText('a 20% price move would liquidate a leg')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Log out' })).toBeNull();
  });

  it('no focus step opens no row', async () => {
    mockAllDone(telegramInfo());
    renderWithClient(<FocusHarness initial={null} />);

    expect(await within(row('Telegram alerts')).findByRole('button', { name: 'Set up' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Collapse' })).toBeNull();
  });
});
