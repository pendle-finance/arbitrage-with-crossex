import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TelegramInfo } from '../../api/types';
import { agentStatus, mockWorld, telegramInfo, type SetupWorld } from '../../test/fixtures';
import { env, server } from '../../test/server';
import { renderWithClient } from '../../test/utils';
import { BorosWalletRow } from './BorosWalletRow';
import { SetupPage } from './SetupPage';
import type { SetupRowProps } from './setupState';
import { TelegramRow } from './TelegramRow';

const WALLET = `0xab18${'0'.repeat(32)}ed9d`;
const PASTED = `0x3f2a${'1'.repeat(32)}91c0`;
const OTHER = `0x5c1f${'2'.repeat(32)}a2e0`;
const LINK_URL = 'https://boros-bot-notification.pendle.finance/alerts?crossex=abc123';
const BOT_DOWN = 'Telegram alerts are not available yet. Try again later.';
const ALERTS_URL = 'https://boros-bot-notification.pendle.finance/alerts';
const BOT_UNREACHABLE = 'Could not reach the bot. Try again, or use Disconnect terminal on the Boros notifications page.';

const approveAgent = vi.fn(async () => ({ txHash: '0xtx' }));
vi.mock('../../lib/borosAgentApi', () => ({
  generateAgentKey: () => ({ privateKey: `0x${'a'.repeat(64)}`, address: `0x${'3'.repeat(40)}` }),
  approveAgent,
}));

const connectedTelegram = (over: Partial<TelegramInfo> = {}): TelegramInfo =>
  telegramInfo({
    connected: true,
    state: 'connected',
    settings: { liquidation: true, interest: true, maturity: true, rollover: true },
    lastSyncAt: Date.now() - 12_000,
    ...over,
  });

const trackedInStorage = (): unknown => JSON.parse(localStorage.getItem('crossex.strategy.v1') ?? 'null');

function installWallet() {
  (window as unknown as { ethereum?: unknown }).ethereum = {
    request: vi.fn(async ({ method }: { method: string }) => {
      if (method === 'eth_requestAccounts') return [WALLET];
      if (method === 'eth_chainId') return '0xa4b1';
      return null;
    }),
  };
}

function renderSetup() {
  const onFinish = vi.fn();
  const onOpenGuide = vi.fn();
  renderWithClient(<SetupPage onFinish={onFinish} onOpenGuide={onOpenGuide} />);
  return { onFinish, onOpenGuide };
}

const row = (name: string) => screen.getByRole('region', { name });

function openTelegramStep(): SetupWorld {
  localStorage.setItem('crossex.strategy.v1', JSON.stringify({ address: WALLET }));
  return mockWorld({ keyConfigured: true, agent: agentStatus({ configured: true, root: WALLET }) });
}

function stubNewTab(): { location: { href: string }; opener: unknown; close: () => void } {
  const tab = { location: { href: '' }, opener: {}, close: vi.fn() };
  vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
  return tab;
}

beforeEach(() => {
  delete (window as unknown as { ethereum?: unknown }).ethereum;
});

afterEach(() => {
  delete (window as unknown as { ethereum?: unknown }).ethereum;
  vi.restoreAllMocks();
  approveAgent.mockClear();
});

describe('SetupPage · Gate API key', () => {
  it('first run shows three rows', async () => {
    mockWorld();
    renderSetup();
    expect(screen.getByText('Set up the terminal')).toBeInTheDocument();
    expect(row('Gate API key')).toBeInTheDocument();
    expect(row('Boros wallet')).toBeInTheDocument();
    expect(row('Telegram alerts')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Check key' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Paste address' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Set up ↗' })).toBeNull();
  });

  it('checked key opens step 2', async () => {
    const user = userEvent.setup();
    const world = mockWorld();
    server.use(
      http.put('/api/credentials', () => {
        world.keyConfigured = true;
        return HttpResponse.json(env({ configured: true, keyMasked: '160e…4f80' }));
      }),
    );
    renderSetup();
    await user.type(await screen.findByPlaceholderText('Gate API key'), 'key-160e4f80');
    await user.type(screen.getByPlaceholderText('Gate API secret'), 'secret');
    await user.click(screen.getByRole('button', { name: 'Check key' }));

    expect(await within(row('Gate API key')).findByText('160e…4f80 · works')).toBeInTheDocument();
    expect(await screen.findByRole('radio', { name: 'Paste address' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check key' })).toBeNull();
  });

  it('refused key', async () => {
    const user = userEvent.setup();
    mockWorld();
    server.use(
      http.put('/api/credentials', () =>
        HttpResponse.json(
          { ok: false, error: { category: 'auth', message: 'Invalid key provided', label: 'INVALID_KEY', retryable: false } },
          { status: 401 },
        ),
      ),
    );
    renderSetup();
    await user.type(await screen.findByPlaceholderText('Gate API key'), 'bad');
    await user.type(screen.getByPlaceholderText('Gate API secret'), 'bad');
    await user.click(screen.getByRole('button', { name: 'Check key' }));

    expect(
      await screen.findByText('Gate refused this key: INVALID_KEY. Check you pasted the whole key.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Paste address' })).toBeNull();
  });

  it('no skip on the key', async () => {
    mockWorld();
    renderSetup();
    await screen.findByRole('button', { name: 'Check key' });
    expect(screen.queryByRole('button', { name: /Skip/ })).toBeNull();
  });

  it('how to make a key opens the guide', async () => {
    const user = userEvent.setup();
    mockWorld();
    const { onOpenGuide } = renderSetup();
    await user.click(await screen.findByRole('button', { name: 'How to make a key' }));
    expect(onOpenGuide).toHaveBeenCalledTimes(1);
  });
});

describe('SetupPage · Boros wallet', () => {
  it('wallet becomes tracked', async () => {
    const user = userEvent.setup();
    installWallet();
    const world = mockWorld({ keyConfigured: true });
    server.use(
      http.put('/api/boros/agent', () => {
        world.agent = agentStatus({ configured: true, root: WALLET, rootMasked: '0xab18…ed9d', accountId: 0 });
        return HttpResponse.json(env(world.agent));
      }),
    );
    renderSetup();
    await user.click(await screen.findByRole('button', { name: 'Connect wallet' }));

    expect(await within(row('Boros wallet')).findByText('0xab18…ed9d · can trade')).toBeInTheDocument();
    expect(approveAgent).toHaveBeenCalledTimes(1);
    expect(trackedInStorage()).toEqual({ address: WALLET, walletUpgraded: true });
    expect(await screen.findByRole('button', { name: 'Set up ↗' })).toBeInTheDocument();
  });

  it('approval cost free', async () => {
    installWallet();
    mockWorld({ keyConfigured: true });
    renderSetup();
    expect(await screen.findByRole('button', { name: 'Connect wallet' })).toBeInTheDocument();
    expect(screen.getByText('Approval cost: free')).toBeInTheDocument();
    expect(screen.queryByText(/gas/i)).toBeNull();
  });

  it('connect tab is one line, as the artboard draws it', async () => {
    installWallet();
    mockWorld({ keyConfigured: true });
    renderSetup();
    await screen.findByRole('button', { name: 'Connect wallet' });
    const wallet = row('Boros wallet');
    expect(within(wallet).getByText('Connect the wallet that holds your Boros account.')).toBeInTheDocument();
    expect(within(wallet).queryByText('Enable Boros trading')).toBeNull();
    expect(within(wallet).queryByText(/delegated agent key|one on-chain transaction|cannot deposit or withdraw/i)).toBeNull();
  });

  it('paste address', async () => {
    const user = userEvent.setup();
    mockWorld({ keyConfigured: true });
    renderSetup();
    await user.click(await screen.findByRole('radio', { name: 'Paste address' }));
    expect(screen.getByText('View only. Log in to trade.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Track address' })).toBeInTheDocument();
  });

  it('paste address done', async () => {
    const user = userEvent.setup();
    mockWorld({ keyConfigured: true });
    renderSetup();
    await user.click(await screen.findByRole('radio', { name: 'Paste address' }));
    await user.type(screen.getByPlaceholderText('0x…'), PASTED);
    await user.click(screen.getByRole('button', { name: 'Track address' }));

    expect(await within(row('Boros wallet')).findByText('0x3f2a…91c0 · view only')).toBeInTheDocument();
    expect(trackedInStorage()).toEqual({ address: PASTED });
    expect(screen.queryByRole('button', { name: 'Track address' })).toBeNull();
  });

  it('upgrade switches to the trading wallet once', async () => {
    const user = userEvent.setup();
    localStorage.setItem('crossex.strategy.v1', JSON.stringify({ address: OTHER }));
    mockWorld({ keyConfigured: true, agent: agentStatus({ configured: true, root: WALLET }) });
    renderSetup();

    expect(await within(row('Boros wallet')).findByText('0xab18…ed9d · can trade')).toBeInTheDocument();
    expect(screen.getByText('0xab18…ed9d', { selector: 'span.num' })).toBeInTheDocument();
    expect(trackedInStorage()).toEqual({ address: WALLET, walletUpgraded: true, walletUpgradeNote: WALLET });
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/the wallet that trades/)).toBeNull();
    expect(trackedInStorage()).toEqual({ address: WALLET, walletUpgraded: true });
  });

  it('upgrade does not run twice', async () => {
    localStorage.setItem('crossex.strategy.v1', JSON.stringify({ address: OTHER, walletUpgraded: true }));
    mockWorld({ keyConfigured: true, agent: agentStatus({ configured: true, root: WALLET }) });
    renderSetup();

    expect(await within(row('Boros wallet')).findByText('0x5c1f…a2e0 · view only')).toBeInTheDocument();
    expect(screen.queryByText(/the wallet that trades/)).toBeNull();
  });


  it('skip asks once', async () => {
    const user = userEvent.setup();
    mockWorld({ keyConfigured: true });
    renderSetup();
    await user.click(await screen.findByRole('button', { name: 'Skip, not recommended' }));

    expect(screen.getByText('Not recommended.')).toBeInTheDocument();
    expect(
      screen.getByText('Without a Boros wallet the terminal cannot open Boros legs, and Positions cannot show them.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Skip anyway' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('radio', { name: 'Paste address' })).toBeInTheDocument();
  });

  it('skip anyway', async () => {
    const user = userEvent.setup();
    mockWorld({ keyConfigured: true });
    renderSetup();
    await user.click(await screen.findByRole('button', { name: 'Skip, not recommended' }));
    await user.click(screen.getByRole('button', { name: 'Skip anyway' }));

    expect(within(row('Boros wallet')).getByText('not set up')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set up ↗' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Paste address' })).toBeNull();
  });
});

describe('SetupPage · Telegram alerts', () => {
  it('step 3 names the alerts', async () => {
    openTelegramStep();
    renderSetup();
    expect(await screen.findByRole('button', { name: 'Set up ↗' })).toBeInTheDocument();
    const telegram = row('Telegram alerts');
    expect(within(telegram).getByText('Close to liquidation')).toBeInTheDocument();
    expect(within(telegram).getByText('a 20% price move would liquidate a leg')).toBeInTheDocument();
    expect(within(telegram).getByText('Started paying interest')).toBeInTheDocument();
  });

  it('interest hover', async () => {
    const user = userEvent.setup();
    openTelegramStep();
    renderSetup();
    await screen.findByRole('button', { name: 'Set up ↗' });
    await user.hover(screen.getByText('borrowing'));

    expect(await screen.findByText('USDT CrossEx wallet · equity under $0')).toBeInTheDocument();
    expect(screen.getByText('USDC Lighter wallet · equity under $0')).toBeInTheDocument();
    expect(screen.getByText('USDC Hyperliquid wallet · borrows more than $10,000, the first $10,000 is free')).toBeInTheDocument();
  });

  it('waiting state', async () => {
    const user = userEvent.setup();
    openTelegramStep();
    const tab = stubNewTab();
    server.use(
      http.post('/api/telegram/link', () => HttpResponse.json(env({ url: LINK_URL, expiresAt: Date.now() + 600_000 }))),
      http.get('/api/telegram/link', () =>
        HttpResponse.json(env({ status: 'pending', url: LINK_URL, expiresAt: Date.now() + 600_000 })),
      ),
    );
    renderSetup();
    await user.click(await screen.findByRole('button', { name: 'Set up ↗' }));

    expect(await screen.findByText('Waiting for you to confirm on the Boros notifications page')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the page again ↗' })).toHaveAttribute('href', LINK_URL);
    expect(tab.location.href).toBe(LINK_URL);
    expect(within(row('Telegram alerts')).queryByText(/\d+:\d{2}|expires|left/i)).toBeNull();
  });

  it('connected state', async () => {
    const user = userEvent.setup();
    const world = openTelegramStep();
    stubNewTab();
    server.use(
      http.post('/api/telegram/link', () => HttpResponse.json(env({ url: LINK_URL, expiresAt: Date.now() + 600_000 }))),
      http.get('/api/telegram/link', () => {
        world.telegram = connectedTelegram();
        return HttpResponse.json(env({ status: 'confirmed', url: null, expiresAt: null }));
      }),
    );
    const { onFinish } = renderSetup();
    await user.click(await screen.findByRole('button', { name: 'Set up ↗' }));

    expect(await screen.findByRole('switch', { name: 'Close to liquidation' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('switch', { name: 'Started paying interest' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('a 20% price move would liquidate a leg')).toBeInTheDocument();
    expect(screen.getAllByText('borrowing').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/a wallet starts/).length).toBeGreaterThan(0);
    await user.hover(screen.getByText(/^Last synced \d+ s ago$/));
    expect(
      await screen.findByText(
        "Alerts use the terminal's last sync, at most 5 min old. A trade made outside the terminal reaches the alerts after the next sync.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Skip/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Finish' }));
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it('expired', async () => {
    const user = userEvent.setup();
    openTelegramStep();
    stubNewTab();
    server.use(
      http.post('/api/telegram/link', () => HttpResponse.json(env({ url: LINK_URL, expiresAt: Date.now() + 600_000 }))),
      http.get('/api/telegram/link', () => HttpResponse.json(env({ status: 'expired', url: null, expiresAt: null }))),
    );
    renderSetup();
    await user.click(await screen.findByRole('button', { name: 'Set up ↗' }));

    expect(await screen.findByText('Link expired. Set up again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set up ↗' })).toBeInTheDocument();
  });

  it('lost link', async () => {
    const user = userEvent.setup();
    openTelegramStep();
    stubNewTab();
    server.use(
      http.post('/api/telegram/link', () => HttpResponse.json(env({ url: LINK_URL, expiresAt: Date.now() + 600_000 }))),
      http.get('/api/telegram/link', () => HttpResponse.json(env({ status: 'none', url: null, expiresAt: null }))),
    );
    renderSetup();
    await user.click(await screen.findByRole('button', { name: 'Set up ↗' }));

    await waitFor(() => expect(screen.queryByText('Waiting for you to confirm on the Boros notifications page')).toBeNull());
    expect(screen.getByRole('button', { name: 'Set up ↗' })).toBeInTheDocument();
  });

  it('bot down', async () => {
    const user = userEvent.setup();
    openTelegramStep();
    const tab = stubNewTab();
    server.use(
      http.post('/api/telegram/link', () =>
        HttpResponse.json(
          { ok: false, error: { category: 'network', message: BOT_DOWN, retryable: true } },
          { status: 503 },
        ),
      ),
    );
    const { onFinish } = renderSetup();
    await user.click(await screen.findByRole('button', { name: 'Set up ↗' }));

    expect(await screen.findByText(BOT_DOWN)).toBeInTheDocument();
    expect(tab.close).toHaveBeenCalled();
    expect(screen.queryByText('Waiting for you to confirm on the Boros notifications page')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Finish' })).toBeNull();
    expect(onFinish).not.toHaveBeenCalled();
  });

  it('skip telegram', async () => {
    const user = userEvent.setup();
    openTelegramStep();
    const { onFinish } = renderSetup();
    await user.click(await screen.findByRole('button', { name: 'Skip, not recommended' }));

    expect(
      screen.getByText('Without Telegram alerts nothing warns you near liquidation, when interest starts, or before a pair matures.'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Skip anyway' }));
    expect(onFinish).toHaveBeenCalledTimes(1);
  });
});

describe('setup rows in Settings', () => {
  const settingsRow = (over: Partial<SetupRowProps> = {}): SetupRowProps => ({
    open: false,
    onOpen: vi.fn(),
    onClose: vi.fn(),
    onDone: vi.fn(),
    variant: 'settings',
    ...over,
  });
  const at = (hours: number, minutes: number) => new Date(2026, 8, 18, hours, minutes).getTime();

  it.each([
    [{ connected: true, state: 'connected', settings: { liquidation: true, interest: true, maturity: true, rollover: true }, lastSyncAt: Date.now() - 180_000 }, 'All on · synced 3 min ago'],
    [{ connected: true, state: 'connected', settings: { liquidation: true, interest: false, maturity: true, rollover: false }, lastSyncAt: Date.now() - 180_000 }, '2 of 4 on · synced 3 min ago'],
    [{ connected: true, state: 'connected', settings: { liquidation: true, interest: true, maturity: true, rollover: true }, lastSyncAt: at(11, 40), lastSyncError: { at: at(14, 2), message: 'timeout' } }, 'Last sync failed'],
    [{ state: 'replaced' }, 'Connected on another terminal'],
    [{ state: 'removed' }, 'Removed on the Boros notifications page'],
    [{}, 'not set up'],
  ] as [Partial<TelegramInfo>, string][])('telegram state line %#', async (over, line) => {
    mockWorld({ telegram: telegramInfo(over) });
    renderWithClient(<TelegramRow {...settingsRow()} />);
    expect(await within(row('Telegram alerts')).findByText(line)).toBeInTheDocument();
    const action = over.connected ? 'Edit' : 'Set up ↗';
    expect(screen.getByRole('button', { name: action })).toBeInTheDocument();
  });

  it.each([
    ['the bot did not answer', 'The Telegram bot did not answer: fetch failed'],
    ['the terminal could not read Gate', 'Gate did not answer.'],
    ['the bot refused a stale sync', 'syncedAt is not newer than the last sync'],
  ])('sync failed names both times when %s', async (_cause, message) => {
    mockWorld({
      telegram: telegramInfo({
        connected: true,
        state: 'connected',
        settings: { liquidation: true, interest: true, maturity: true, rollover: true },
        lastSyncAt: at(11, 40),
        lastSyncError: { at: at(14, 2), message },
      }),
    });
    renderWithClient(<TelegramRow {...settingsRow({ open: true })} />);
    expect(
      await screen.findByText('Last sync failed at 14:02. Alerts still use the sync from 11:40. Retrying.'),
    ).toBeInTheDocument();
  });

  it('edit telegram shows switches, caveat and disconnect', async () => {
    const user = userEvent.setup();
    let patched: unknown = null;
    mockWorld({ telegram: connectedTelegram() });
    server.use(
      http.patch('/api/telegram/settings', async ({ request }) => {
        patched = await request.json();
        return HttpResponse.json(env(connectedTelegram()));
      }),
    );
    const onClose = vi.fn();
    renderWithClient(<TelegramRow {...settingsRow({ open: true, onClose })} />);
    await user.click(await screen.findByRole('switch', { name: 'Started paying interest' }));
    await waitFor(() => expect(patched).toEqual({ interest: false }));
    expect(screen.getByRole('button', { name: 'Disconnect this terminal' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Skip/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('approval expired', async () => {
    mockWorld({ agent: agentStatus({ configured: true, root: WALLET, expired: true, expiry: 1_700_000_000 }) });
    renderWithClient(<BorosWalletRow {...settingsRow()} />);
    expect(await within(row('Boros wallet')).findByText('Approval expired')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  it('stop tracking clears the address', async () => {
    const user = userEvent.setup();
    localStorage.setItem('crossex.strategy.v1', JSON.stringify({ address: PASTED }));
    mockWorld();
    renderWithClient(<BorosWalletRow {...settingsRow({ open: true })} />);
    await user.click(await screen.findByRole('button', { name: 'Stop tracking' }));
    expect(trackedInStorage()).toEqual({ address: null });
  });

  it('a disconnect the bot could not answer keeps the row connected', async () => {
    const user = userEvent.setup();
    mockWorld({ telegram: connectedTelegram() });
    server.use(
      http.delete('/api/telegram', () =>
        HttpResponse.json(
          { ok: false, error: { category: 'network', message: BOT_UNREACHABLE, retryable: true } },
          { status: 503 },
        ),
      ),
    );
    renderWithClient(<TelegramRow {...settingsRow({ open: true })} />);
    await user.click(await screen.findByRole('button', { name: 'Disconnect this terminal' }));

    expect((await screen.findByRole('alert')).textContent).toBe(BOT_UNREACHABLE);
    expect(screen.getByRole('link', { name: 'Boros notifications page' })).toHaveAttribute('href', ALERTS_URL);
    expect(screen.getByRole('button', { name: 'Disconnect this terminal' })).toBeInTheDocument();
  });

  it('a disconnect error links to the alerts page the API configured', async () => {
    const user = userEvent.setup();
    const STAGING_ALERTS_URL = 'https://staging.boros-bot.example/alerts';
    mockWorld({ telegram: connectedTelegram({ alertsPageUrl: STAGING_ALERTS_URL }) });
    server.use(
      http.delete('/api/telegram', () =>
        HttpResponse.json(
          { ok: false, error: { category: 'network', message: BOT_UNREACHABLE, retryable: true } },
          { status: 503 },
        ),
      ),
    );
    renderWithClient(<TelegramRow {...settingsRow({ open: true })} />);
    await user.click(await screen.findByRole('button', { name: 'Disconnect this terminal' }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Boros notifications page' })).toHaveAttribute('href', STAGING_ALERTS_URL);
  });

  it('unknown settings read as alerts off, not both on', async () => {
    mockWorld({ telegram: telegramInfo({ connected: true, state: 'connected', settings: null, lastSyncAt: null }) });
    renderWithClient(<TelegramRow {...settingsRow()} />);
    expect(await within(row('Telegram alerts')).findByText('None on')).toBeInTheDocument();
  });

  it('unknown settings leave both switches off', async () => {
    mockWorld({ telegram: telegramInfo({ connected: true, state: 'connected', settings: null, lastSyncAt: null }) });
    renderWithClient(<TelegramRow {...settingsRow({ open: true })} />);
    expect(await screen.findByRole('switch', { name: 'Close to liquidation' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('switch', { name: 'Started paying interest' })).toHaveAttribute('aria-checked', 'false');
  });

  it('a failed status read shows the error', async () => {
    const readFailed = 'Could not read the Telegram status.';
    mockWorld();
    server.use(
      http.get('/api/telegram', () =>
        HttpResponse.json({ ok: false, error: { category: 'network', message: readFailed, retryable: true } }, { status: 502 }),
      ),
    );
    renderWithClient(<TelegramRow {...settingsRow()} />);
    expect(await within(row('Telegram alerts')).findByText(readFailed)).toBeInTheDocument();
  });
});

describe('TelegramRow · cancel while waiting', () => {
  const pendingLink = () => ({ status: 'pending', url: LINK_URL, expiresAt: Date.now() + 600_000 });

  async function startWaiting(onCancel: () => Response) {
    const user = userEvent.setup();
    openTelegramStep();
    stubNewTab();
    server.use(
      http.post('/api/telegram/link', () => HttpResponse.json(env({ url: LINK_URL, expiresAt: Date.now() + 600_000 }))),
      http.get('/api/telegram/link', () => HttpResponse.json(env(pendingLink()))),
      http.delete('/api/telegram/link', onCancel),
    );
    renderSetup();
    await user.click(await screen.findByRole('button', { name: 'Set up ↗' }));
    await screen.findByText('Waiting for you to confirm on the Boros notifications page');
    await user.click(within(row('Telegram alerts')).getByRole('button', { name: 'Cancel' }));
  }

  it('cancel drops the link on the server and leaves the waiting screen', async () => {
    let cancels = 0;
    await startWaiting(() => {
      cancels += 1;
      return HttpResponse.json(env({ status: 'none', url: null, expiresAt: null }));
    });
    await waitFor(() => expect(cancels).toBe(1));
    await waitFor(() => expect(screen.queryByText('Waiting for you to confirm on the Boros notifications page')).toBeNull());
  });

  it('a failed cancel says why and keeps waiting', async () => {
    await startWaiting(() =>
      HttpResponse.json({ ok: false, error: { category: 'network', message: BOT_DOWN, retryable: true } }, { status: 503 }),
    );
    expect(await screen.findByText(BOT_DOWN)).toBeInTheDocument();
    expect(screen.getByText('Waiting for you to confirm on the Boros notifications page')).toBeInTheDocument();
  });
});
