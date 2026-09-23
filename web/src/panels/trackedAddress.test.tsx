import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentStatus, mockWorld, telegramInfo, versionHandler } from '../test/fixtures';
import { installFakeWallet, removeFakeWallet } from '../test/fakeWallet';
import { env, server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { STRATEGY_STORAGE_KEY } from './HomeControls';
import { SettingsDrawer } from './SettingsDrawer';
import { SetupPage } from './setup/SetupPage';
import { useTrackedAddress } from './trackedAddress';

const WALLET = `0xab18${'0'.repeat(32)}ed9d`;
const SECOND = `0x7f11${'4'.repeat(32)}5444`;
const PASTED = `0x3f2a${'1'.repeat(32)}91c0`;

vi.mock('../lib/borosAgentApi', () => ({
  generateAgentKey: () => ({ privateKey: `0x${'a'.repeat(64)}`, address: `0x${'3'.repeat(40)}` }),
  approveAgent: vi.fn(async () => ({ txHash: '0xtx' })),
}));

const stored = (): Record<string, unknown> | null => JSON.parse(localStorage.getItem(STRATEGY_STORAGE_KEY) ?? 'null');
const seed = (value: Record<string, unknown>) => localStorage.setItem(STRATEGY_STORAGE_KEY, JSON.stringify(value));
const row = () => screen.getByRole('region', { name: 'Boros wallet' });

function Probe() {
  const { address, followWallet } = useTrackedAddress();
  return <p data-testid="probe">{`${address ?? 'none'}|${followWallet ? 'follow' : 'fixed'}`}</p>;
}

beforeEach(() => {
  removeFakeWallet();
});
afterEach(() => {
  removeFakeWallet();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('follow the browser wallet', () => {
  it('Connect wallet turns follow on and the row says so', async () => {
    const user = userEvent.setup();
    installFakeWallet({ accounts: [WALLET] });
    const world = mockWorld({ keyConfigured: true });
    server.use(
      http.put('/api/boros/agent', () => {
        world.agent = agentStatus({ configured: true, root: WALLET, rootMasked: '0xab18…ed9d', accountId: 0 });
        return HttpResponse.json(env(world.agent));
      }),
    );
    renderWithClient(<SetupPage onFinish={vi.fn()} onOpenGuide={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'Connect wallet' }));

    expect(await within(row()).findByText('0xab18…ed9d · can trade · follows your wallet')).toBeInTheDocument();
    expect(stored()).toEqual({ address: WALLET, walletUpgraded: true, followWallet: true });
  });

  it('accountsChanged switches the active wallet, lowercase', async () => {
    const wallet = installFakeWallet({ accounts: [WALLET] });
    seed({ address: WALLET, walletUpgraded: true, followWallet: true });
    mockWorld({ keyConfigured: true, agent: agentStatus({ configured: true, root: WALLET }) });
    renderWithClient(<Probe />);
    await waitFor(() => expect(wallet.listenerCount()).toBe(1));

    act(() => wallet.emitAccounts([SECOND.toUpperCase().replace('0X', '0x')]));
    expect(await screen.findByText(`${SECOND}|follow`)).toBeInTheDocument();
    expect(stored()).toMatchObject({ address: SECOND, followWallet: true });
  });

  it('an empty account list keeps the current wallet', async () => {
    const wallet = installFakeWallet({ accounts: [WALLET] });
    seed({ address: WALLET, walletUpgraded: true, followWallet: true });
    mockWorld({ keyConfigured: true, agent: agentStatus({ configured: true, root: WALLET }) });
    renderWithClient(<Probe />);
    await waitFor(() => expect(wallet.listenerCount()).toBe(1));

    act(() => wallet.emitAccounts([]));
    expect(screen.getByTestId('probe')).toHaveTextContent(`${WALLET}|follow`);
    expect(stored()).toMatchObject({ address: WALLET, followWallet: true });
  });

  it('Paste address turns follow off and later wallet switches are ignored', async () => {
    const user = userEvent.setup();
    const wallet = installFakeWallet({ accounts: [WALLET] });
    seed({ address: WALLET, walletUpgraded: true, followWallet: true });
    mockWorld({ keyConfigured: true, agent: agentStatus({ configured: true, root: WALLET }), telegram: telegramInfo() });
    server.use(versionHandler({ current: '1.6.3', latest: '1.6.3' }));
    renderWithClient(
      <>
        <SettingsDrawer open onClose={vi.fn()} />
        <Probe />
      </>,
    );
    expect(await within(row()).findByText('0xab18…ed9d · can trade · follows your wallet')).toBeInTheDocument();
    await waitFor(() => expect(wallet.listenerCount()).toBe(1));
    await user.click(within(row()).getByRole('button', { name: 'Edit' }));
    await user.click(await within(row()).findByRole('radio', { name: 'Paste address' }));
    const input = within(row()).getByPlaceholderText('0x…');
    await user.clear(input);
    await user.type(input, PASTED);
    await user.click(within(row()).getByRole('button', { name: 'Track address' }));

    expect(await within(row()).findByText('0x3f2a…91c0 · view only')).toBeInTheDocument();
    expect(stored()).toEqual({ address: PASTED, walletUpgraded: true });
    expect(wallet.listenerCount()).toBe(0);
    act(() => wallet.emitAccounts([SECOND]));
    expect(screen.getByTestId('probe')).toHaveTextContent(`${PASTED}|fixed`);
  });

  it('on load, eth_accounts switches to the browser account without a prompt', async () => {
    const wallet = installFakeWallet({ accounts: [SECOND] });
    seed({ address: WALLET, walletUpgraded: true, followWallet: true });
    mockWorld({ keyConfigured: true, agent: agentStatus({ configured: true, root: WALLET }) });
    renderWithClient(<Probe />);

    expect(await screen.findByText(`${SECOND}|follow`)).toBeInTheDocument();
    expect(wallet.methods()).toContain('eth_accounts');
    expect(wallet.methods()).not.toContain('eth_requestAccounts');
  });

  it('eth_accounts hanging past 3 s keeps the stored wallet', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const wallet = installFakeWallet({ ethAccounts: () => new Promise(() => {}) });
    seed({ address: WALLET, walletUpgraded: true, followWallet: true });
    mockWorld({ keyConfigured: true, agent: agentStatus({ configured: true, root: WALLET }) });
    renderWithClient(<Probe />);
    await waitFor(() => expect(wallet.methods()).toContain('eth_accounts'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    expect(screen.getByTestId('probe')).toHaveTextContent(`${WALLET}|follow`);
    expect(wallet.methods()).not.toContain('eth_requestAccounts');

    act(() => wallet.emitAccounts([SECOND]));
    expect(await screen.findByText(`${SECOND}|follow`)).toBeInTheDocument();
  });

  it('with follow off, nothing listens and nothing is read on load', async () => {
    const wallet = installFakeWallet({ accounts: [SECOND] });
    seed({ address: WALLET, walletUpgraded: true });
    mockWorld({ keyConfigured: true, agent: agentStatus({ configured: true, root: WALLET }) });
    renderWithClient(<Probe />);

    expect(await screen.findByText(`${WALLET}|fixed`)).toBeInTheDocument();
    expect(wallet.listenerCount()).toBe(0);
    expect(wallet.methods()).toEqual([]);
  });

  it('the one-time upgrade turns follow on when the browser account is the root', async () => {
    installFakeWallet({ accounts: [WALLET] });
    seed({ address: PASTED });
    mockWorld({ keyConfigured: true, agent: agentStatus({ configured: true, root: WALLET }) });
    renderWithClient(<Probe />);

    expect(await screen.findByText(`${WALLET}|follow`)).toBeInTheDocument();
    expect(stored()).toEqual({ address: WALLET, walletUpgraded: true, walletUpgradeNote: WALLET, followWallet: true });
  });

  it('the one-time upgrade leaves follow off when the browser shows another account', async () => {
    const wallet = installFakeWallet({ accounts: [SECOND] });
    seed({ address: PASTED });
    mockWorld({ keyConfigured: true, agent: agentStatus({ configured: true, root: WALLET }) });
    renderWithClient(<Probe />);

    expect(await screen.findByText(`${WALLET}|fixed`)).toBeInTheDocument();
    await waitFor(() => expect(wallet.methods()).toContain('eth_accounts'));
    expect(screen.getByTestId('probe')).toHaveTextContent(`${WALLET}|fixed`);
    expect(wallet.methods()).not.toContain('eth_requestAccounts');
  });
});
