import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TelegramInfo } from '../../api/types';
import { fmtDateShort } from '../../lib/fmt';
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
const BOT_UNREACHABLE = 'Could not reach the bot. Try again, or stop alerts for each wallet on the Boros notifications page.';

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
    expect(within(row('Telegram alerts')).queryByRole('button', { name: 'Set up' })).toBeNull();
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
    expect(await screen.findByText('Install Rabby or MetaMask, then reload.')).toBeInTheDocument();
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

  it('lists the Gate steps before the key, with the detail on hover', async () => {
    const user = userEvent.setup();
    mockWorld();
    renderSetup();
    await screen.findByRole('button', { name: 'Check key' });
    const steps = within(screen.getByRole('list', { name: 'Before the key' }));
    expect(steps.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      '1Fund Gategate.com/signup',
      '2Enable CrossExgate.com/crossex',
      '3Fund CrossExgate.com/crossex',
    ]);

    await user.hover(steps.getByText('Enable CrossEx'));
    expect(await screen.findByText(/The Cross-Exchange key permission and transfers need it first\./)).toBeInTheDocument();
  });

  it('hides the Gate steps once the key works', async () => {
    mockWorld({ keyConfigured: true });
    renderSetup();
    expect(await within(row('Gate API key')).findByText(/works/)).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Before the key' })).toBeNull();
  });
});

describe('SetupPage · Boros wallet', () => {
  it('connect wallet only reads the account and follows it', async () => {
    const user = userEvent.setup();
    installWallet();
    mockWorld({ keyConfigured: true });
    renderSetup();
    await user.click(await screen.findByRole('button', { name: 'Connect wallet' }));

    const wallet = row('Boros wallet');
    expect(await within(wallet).findByText('0xab18…ed9d')).toBeInTheDocument();
    expect(within(wallet).getByText('Not logged in')).toBeInTheDocument();
    expect(within(wallet).queryByText('View only')).toBeNull();
    expect(approveAgent).not.toHaveBeenCalled();
    const request = (window as unknown as { ethereum: { request: ReturnType<typeof vi.fn> } }).ethereum.request;
    const methods = request.mock.calls.map(([arg]) => (arg as { method: string }).method);
    expect(methods).toContain('eth_requestAccounts');
    expect(methods.filter((m) => m !== 'eth_requestAccounts' && m !== 'eth_accounts')).toEqual([]);
    expect(trackedInStorage()).toEqual({ address: WALLET, followWallet: true });
    expect(within(wallet).getByRole('button', { name: 'Log in to trade 0xab18…ed9d' })).toBeInTheDocument();
    expect(within(row('Telegram alerts')).queryByRole('button', { name: 'Set up' })).toBeNull();
  });

  it('the row has no paste form and no approval cost', async () => {
    installWallet();
    mockWorld({ keyConfigured: true });
    renderSetup();
    expect(await screen.findByRole('button', { name: 'Connect wallet' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Paste address' })).toBeNull();
    expect(screen.queryByRole('radio', { name: 'Connect wallet' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Track address' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop tracking' })).toBeNull();
    expect(screen.queryByText('Approval cost: free')).toBeNull();
    expect(screen.queryByText(/gas/i)).toBeNull();
  });

  it('no wallet installed asks for one', async () => {
    mockWorld({ keyConfigured: true });
    renderSetup();
    expect(await within(row('Boros wallet')).findByText('Install Rabby or MetaMask, then reload.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect wallet' })).toBeNull();
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

  it('upgrade switches to the trading wallet once', async () => {
    const user = userEvent.setup();
    localStorage.setItem('crossex.strategy.v1', JSON.stringify({ address: OTHER }));
    mockWorld({ keyConfigured: true, agent: agentStatus({ configured: true, root: WALLET }) });
    renderSetup();

    const wallet = row('Boros wallet');
    expect(await within(wallet).findByText('Logged in')).toBeInTheDocument();
    expect(within(wallet).getAllByText('0xab18…ed9d', { selector: 'span.num' }).length).toBeGreaterThan(0);
    expect(screen.getByText(/the wallet that trades/)).toBeInTheDocument();
    expect(trackedInStorage()).toEqual({ address: WALLET, walletUpgraded: true, walletUpgradeNote: WALLET });
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/the wallet that trades/)).toBeNull();
    expect(trackedInStorage()).toEqual({ address: WALLET, walletUpgraded: true });
  });

  it('upgrade does not run twice', async () => {
    localStorage.setItem('crossex.strategy.v1', JSON.stringify({ address: OTHER, walletUpgraded: true }));
    mockWorld({ keyConfigured: true, agent: agentStatus({ configured: true, root: WALLET }) });
    renderSetup();

    const wallet = row('Boros wallet');
    expect(await within(wallet).findByText('View only')).toBeInTheDocument();
    expect(within(wallet).getByText('0x5c1f…a2e0')).toBeInTheDocument();
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
    expect(screen.getByText('Install Rabby or MetaMask, then reload.')).toBeInTheDocument();
  });

  it('skip anyway', async () => {
    const user = userEvent.setup();
    mockWorld({ keyConfigured: true });
    renderSetup();
    await user.click(await screen.findByRole('button', { name: 'Skip, not recommended' }));
    await user.click(screen.getByRole('button', { name: 'Skip anyway' }));

    expect(within(row('Boros wallet')).getByText('not set up')).toBeInTheDocument();
    expect(within(row('Telegram alerts')).getByRole('button', { name: 'Set up' })).toBeInTheDocument();
    expect(screen.queryByText('Install Rabby or MetaMask, then reload.')).toBeNull();
  });
});

describe('SetupPage · Telegram alerts', () => {
  it('step 3 names the alerts', async () => {
    openTelegramStep();
    renderSetup();
    expect(await within(row('Telegram alerts')).findByRole('button', { name: 'Set up' })).toBeInTheDocument();
    const telegram = row('Telegram alerts');
    expect(within(telegram).getByText('Close to liquidation')).toBeInTheDocument();
    expect(within(telegram).getByText('a 20% price move would liquidate a leg')).toBeInTheDocument();
    expect(within(telegram).getByText('Started paying interest')).toBeInTheDocument();
  });

  it('interest hover', async () => {
    const user = userEvent.setup();
    openTelegramStep();
    renderSetup();
    await within(row('Telegram alerts')).findByRole('button', { name: 'Set up' });
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
    await user.click(await within(row('Telegram alerts')).findByRole('button', { name: 'Set up' }));

    expect(await screen.findByText('Waiting for you to confirm on the Boros notifications page')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the page again' })).toHaveAttribute('href', LINK_URL);
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
    await user.click(await within(row('Telegram alerts')).findByRole('button', { name: 'Set up' }));

    expect(await screen.findByRole('switch', { name: 'Close to liquidation' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('switch', { name: 'Started paying interest' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('a 20% price move would liquidate a leg')).toBeInTheDocument();
    expect(screen.getAllByText('borrowing').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/a wallet starts/).length).toBeGreaterThan(0);
    await user.hover(screen.getByText(/^synced \d+ s ago$/));
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
    await user.click(await within(row('Telegram alerts')).findByRole('button', { name: 'Set up' }));

    expect(await screen.findByText('Link expired. Set up again.')).toBeInTheDocument();
    expect(within(row('Telegram alerts')).getByRole('button', { name: 'Set up' })).toBeInTheDocument();
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
    await user.click(await within(row('Telegram alerts')).findByRole('button', { name: 'Set up' }));

    await waitFor(() => expect(screen.queryByText('Waiting for you to confirm on the Boros notifications page')).toBeNull());
    expect(within(row('Telegram alerts')).getByRole('button', { name: 'Set up' })).toBeInTheDocument();
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
    await user.click(await within(row('Telegram alerts')).findByRole('button', { name: 'Set up' }));

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
    [{ state: 'replaced' }, 'not set up'],
    [{ state: 'removed' }, 'not set up'],
    [{}, 'not set up'],
  ] as [Partial<TelegramInfo>, string][])('telegram state line %#', async (over, line) => {
    mockWorld({ telegram: telegramInfo(over) });
    renderWithClient(<TelegramRow {...settingsRow()} />);
    expect(await within(row('Telegram alerts')).findByText(line)).toBeInTheDocument();
    const action = over.connected ? 'Expand' : 'Set up';
    expect(within(row('Telegram alerts')).getByRole('button', { name: action })).toBeInTheDocument();
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
    await user.click(screen.getByRole('button', { name: 'Collapse' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  const day = (unix: number) => fmtDateShort(unix, { year: 'numeric' });
  const header = (name: string) => within(row(name)).getByText(name).parentElement as HTMLElement;
  const dot = (name: string) => header(name).firstElementChild?.textContent;

  it('approval expired', async () => {
    mockWorld({ agent: agentStatus({ configured: true, root: WALLET, expired: true, expiry: 1_700_000_000 }) });
    renderWithClient(<BorosWalletRow {...settingsRow()} />);
    expect(await within(row('Boros wallet')).findByText('Login expired')).toBeInTheDocument();
    expect(within(header('Boros wallet')).getByText('0xab18…ed9d')).toBeInTheDocument();
    expect(dot('Boros wallet')).toBe('!');
    expect(screen.getByRole('button', { name: 'Expand' })).toBeInTheDocument();
  });

  it('an expired login offers a renewal', async () => {
    installWallet();
    mockWorld({ agent: agentStatus({ configured: true, root: WALLET, expired: true, expiry: 1_700_000_000 }) });
    renderWithClient(<BorosWalletRow {...settingsRow({ open: true })} />);
    expect(await screen.findByText(`Login ended ${day(1_700_000_000)}. Boros refuses orders.`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Renew login for 0xab18…ed9d' })).toBeInTheDocument();
  });

  it('a key the chain never approved reads "not approved", not "can trade"', async () => {
    mockWorld({ agent: agentStatus({ configured: true, root: WALLET, approval: 'not-approved', expiry: 2_000_000_000 }) });
    renderWithClient(<BorosWalletRow {...settingsRow()} />);
    expect(await within(row('Boros wallet')).findByText('Not approved')).toBeInTheDocument();
    expect(within(row('Boros wallet')).queryByText('Logged in')).toBeNull();
    expect(dot('Boros wallet')).toBe('!');
  });

  it('a key the chain never approved offers a login', async () => {
    installWallet();
    mockWorld({ agent: agentStatus({ configured: true, root: WALLET, approval: 'not-approved', expiry: 2_000_000_000 }) });
    renderWithClient(<BorosWalletRow {...settingsRow({ open: true })} />);
    expect(await screen.findByText('Boros shows no approval for this login. Log in again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Log in to trade 0xab18…ed9d' })).toBeInTheDocument();
  });

  it('can trade names the key limits and logs out', async () => {
    const user = userEvent.setup();
    const world = mockWorld({ agent: agentStatus({ configured: true, root: WALLET, expiry: 2_000_000_000 }) });
    server.use(
      http.delete('/api/boros/agent', () => {
        world.agent = agentStatus();
        return HttpResponse.json(env({ configured: false, note: '' }));
      }),
    );
    renderWithClient(<BorosWalletRow {...settingsRow({ open: true })} />);
    expect(await within(row('Boros wallet')).findByText('Logged in')).toBeInTheDocument();
    expect(
      screen.getByText(`Trades only. Cannot deposit or withdraw. Login ends ${day(2_000_000_000)}.`),
    ).toBeInTheDocument();
    expect(dot('Boros wallet')).toBe('✓');
    expect(screen.queryByRole('button', { name: 'Remove key' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Log out' }));
    const ask = screen.getByRole('alertdialog', { name: 'Log out 0xab18…ed9d?' });
    expect(ask).toHaveTextContent('Log out 0xab18…ed9d? This terminal stops trading it. Open positions stay open.');
    expect(world.agent.configured).toBe(true);
    await user.click(within(ask).getByRole('button', { name: 'Log out' }));
    expect(
      await screen.findByText('Logged out. The approval stays live on-chain until you revoke it in the Boros app.'),
    ).toBeInTheDocument();
  });

  it('a failed log-out shows the error and keeps the question open', async () => {
    const user = userEvent.setup();
    mockWorld({ agent: agentStatus({ configured: true, root: WALLET, expiry: 2_000_000_000 }) });
    server.use(
      http.delete('/api/boros/agent', () =>
        HttpResponse.json({ ok: false, error: { category: 'network', message: 'Could not write .env', retryable: true } }, { status: 503 }),
      ),
    );
    renderWithClient(<BorosWalletRow {...settingsRow({ open: true })} />);
    await user.click(await screen.findByRole('button', { name: 'Log out' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Log out' }));
    expect(await within(row('Boros wallet')).findByRole('alert')).toHaveTextContent('Could not write .env');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.queryByText(/^Logged out\./)).toBeNull();
  });

  it('Cancel on the log-out question keeps the login', async () => {
    const user = userEvent.setup();
    let deleted = false;
    mockWorld({ agent: agentStatus({ configured: true, root: WALLET, expiry: 2_000_000_000 }) });
    server.use(
      http.delete('/api/boros/agent', () => {
        deleted = true;
        return HttpResponse.json(env({ configured: false, note: '' }));
      }),
    );
    renderWithClient(<BorosWalletRow {...settingsRow({ open: true })} />);
    await user.click(await screen.findByRole('button', { name: 'Log out' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Log out' })).toBeInTheDocument();
    expect(deleted).toBe(false);
  });

  it('Boros could not be read: "Login not checked", still trades', async () => {
    mockWorld({ agent: agentStatus({ configured: true, root: WALLET, expiry: 2_000_000_000, approval: 'unknown' }) });
    renderWithClient(<BorosWalletRow {...settingsRow({ open: true })} />);
    expect(await within(row('Boros wallet')).findByText('Login not checked')).toBeInTheDocument();
    expect(screen.getByText(`Trades only. Cannot deposit or withdraw. Login ends ${day(2_000_000_000)}.`)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Log in to trade/ })).toBeNull();
  });

  it('a wallet that cannot trade gets no green check in Settings', async () => {
    localStorage.setItem('crossex.strategy.v1', JSON.stringify({ address: OTHER, walletUpgraded: true }));
    const world = mockWorld({ agent: agentStatus({ configured: true, root: WALLET, expiry: 2_000_000_000 }) });
    const { unmount } = renderWithClient(<BorosWalletRow {...settingsRow()} />);
    expect(await within(row('Boros wallet')).findByText('View only')).toBeInTheDocument();
    expect(dot('Boros wallet')).toBe('2');
    unmount();

    world.agent = agentStatus();
    renderWithClient(<BorosWalletRow {...settingsRow()} />);
    expect(await within(row('Boros wallet')).findByText('Not logged in')).toBeInTheDocument();
    expect(dot('Boros wallet')).toBe('2');
  });

  it('view only names the wallet logged in here', async () => {
    installWallet();
    localStorage.setItem('crossex.strategy.v1', JSON.stringify({ address: OTHER, walletUpgraded: true }));
    mockWorld({ agent: agentStatus({ configured: true, root: WALLET, expiry: 2_000_000_000 }) });
    renderWithClient(<BorosWalletRow {...settingsRow({ open: true })} />);
    expect(await screen.findByText(/^Logged in here:/)).toHaveTextContent('Logged in here: 0xab18…ed9d');
    expect(screen.getByText('It trades on this terminal.')).toBeInTheDocument();
    expect(screen.queryByText('It gets the Telegram alerts.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Log in to trade 0x5c1f…a2e0' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use my browser wallet' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Log out' })).toBeNull();
  });

  it('view only says the other login syncs Telegram alerts when they are linked', async () => {
    installWallet();
    localStorage.setItem('crossex.strategy.v1', JSON.stringify({ address: OTHER, walletUpgraded: true }));
    mockWorld({ agent: agentStatus({ configured: true, root: WALLET, expiry: 2_000_000_000 }), telegram: connectedTelegram() });
    renderWithClient(
      <>
        <BorosWalletRow {...settingsRow({ open: true })} />
        <TelegramRow {...settingsRow()} />
      </>,
    );
    expect(await screen.findByText('It gets the Telegram alerts.')).toBeInTheDocument();
    expect(screen.getByText('It trades on this terminal.')).toBeInTheDocument();
  });

  it('view only with no login asks to log in once', async () => {
    installWallet();
    localStorage.setItem('crossex.strategy.v1', JSON.stringify({ address: PASTED }));
    mockWorld();
    renderWithClient(<BorosWalletRow {...settingsRow({ open: true })} />);
    expect(await screen.findByRole('button', { name: 'Log in to trade 0x3f2a…91c0' })).toBeInTheDocument();
    expect(screen.getByText('Log in once to trade. The agent key cannot deposit or withdraw.')).toBeInTheDocument();
  });

  it('use my browser wallet hides without a wallet or while following', async () => {
    localStorage.setItem('crossex.strategy.v1', JSON.stringify({ address: PASTED }));
    mockWorld();
    renderWithClient(<BorosWalletRow {...settingsRow({ open: true })} />);
    expect(await screen.findByText('Install Rabby or MetaMask to log in.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use my browser wallet' })).toBeNull();
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
    await user.click(within(screen.getByRole('alertdialog', { name: 'Disconnect this terminal?' })).getByRole('button', { name: 'Disconnect' }));

    expect((await screen.findByRole('alert')).textContent).toBe(BOT_UNREACHABLE);
    expect(screen.getByRole('link', { name: 'Boros notifications page' })).toHaveAttribute('href', ALERTS_URL);
    expect(screen.getByRole('button', { name: 'Disconnect this terminal' })).toBeInTheDocument();
  });

  it('Disconnect asks first; Cancel sends nothing', async () => {
    const user = userEvent.setup();
    let deletes = 0;
    mockWorld({ telegram: connectedTelegram() });
    server.use(
      http.delete('/api/telegram', () => {
        deletes += 1;
        return HttpResponse.json({ ok: true, data: null });
      }),
    );
    renderWithClient(<TelegramRow {...settingsRow({ open: true })} />);
    await user.click(await screen.findByRole('button', { name: 'Disconnect this terminal' }));
    const ask = screen.getByRole('alertdialog', { name: 'Disconnect this terminal?' });
    expect(ask).toHaveTextContent('Disconnect this terminal? Telegram alerts stop for every wallet on it.');
    await user.click(within(ask).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(deletes).toBe(0);
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
    await user.click(within(screen.getByRole('alertdialog', { name: 'Disconnect this terminal?' })).getByRole('button', { name: 'Disconnect' }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Boros notifications page' })).toHaveAttribute('href', STAGING_ALERTS_URL);
  });

  it('unknown settings read as alerts off, not both on', async () => {
    mockWorld({ telegram: telegramInfo({ connected: true, state: 'connected', settings: null, lastSyncAt: Date.now() }) });
    renderWithClient(<TelegramRow {...settingsRow()} />);
    expect(await within(row('Telegram alerts')).findByText(/^None on/)).toBeInTheDocument();
  });

  it('unknown settings leave both switches off', async () => {
    mockWorld({ telegram: telegramInfo({ connected: true, state: 'connected', settings: null, lastSyncAt: Date.now() }) });
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
    await user.click(await within(row('Telegram alerts')).findByRole('button', { name: 'Set up' }));
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
