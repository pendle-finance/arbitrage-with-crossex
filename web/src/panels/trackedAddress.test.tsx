import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentStatus, mockWorld } from '../test/fixtures';
import { installFakeWallet, removeFakeWallet } from '../test/fakeWallet';
import { renderWithClient } from '../test/utils';
import { STRATEGY_STORAGE_KEY } from './HomeControls';
import { SetupPage } from './setup/SetupPage';
import { useActiveWallet, useTrackedAddress } from './trackedAddress';

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

let tracked: ReturnType<typeof useTrackedAddress> | null = null;

function Probe() {
  tracked = useTrackedAddress();
  const { address, followWallet } = tracked;
  return <p data-testid="probe">{`${address ?? 'none'}|${followWallet ? 'follow' : 'fixed'}`}</p>;
}

function StateProbe() {
  const w = useActiveWallet();
  return <p data-testid="state">{`${w.state}|${w.canTrade ? 'trade' : 'no-trade'}|${w.viewOnly ? 'hide-gate' : 'show-gate'}|${w.loginLabel ?? '-'}`}</p>;
}

beforeEach(() => {
  removeFakeWallet();
});
afterEach(() => {
  removeFakeWallet();
  tracked = null;
  localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('follow the browser wallet', () => {
  it('Connect wallet only asks for the account and turns follow on', async () => {
    const user = userEvent.setup();
    const wallet = installFakeWallet({ accounts: [WALLET], ethAccounts: async () => [] });
    mockWorld({ keyConfigured: true });
    renderWithClient(<SetupPage onFinish={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'Connect wallet' }));

    expect(await within(row()).findByText('0xab18…ed9d')).toBeInTheDocument();
    expect(within(row()).getByText('Not logged in')).toBeInTheDocument();
    expect(within(row()).queryByRole('button', { name: 'Use my browser wallet' })).toBeNull();
    expect(stored()).toEqual({ address: WALLET, followWallet: true });
    expect(wallet.methods().filter((m) => m !== 'eth_accounts')).toEqual(['eth_requestAccounts']);
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

  it('an old pin with no manual flag follows the browser account on load', async () => {
    const wallet = installFakeWallet({ accounts: [SECOND] });
    seed({ address: WALLET, walletUpgraded: true });
    mockWorld({ keyConfigured: true, agent: agentStatus({ configured: true, root: WALLET }) });
    renderWithClient(<Probe />);

    expect(await screen.findByText(`${SECOND}|follow`)).toBeInTheDocument();
    expect(stored()).toEqual({ address: SECOND, walletUpgraded: true, followWallet: true });
    expect(wallet.methods()).not.toContain('eth_requestAccounts');
  });

  it('the upgrade follows the browser account when it is not the root, with no note', async () => {
    const wallet = installFakeWallet({ accounts: [SECOND] });
    seed({ address: PASTED });
    mockWorld({ keyConfigured: true, agent: agentStatus({ configured: true, root: WALLET }) });
    renderWithClient(<Probe />);

    expect(await screen.findByText(`${SECOND}|follow`)).toBeInTheDocument();
    expect(stored()).toEqual({ address: SECOND, walletUpgraded: true, followWallet: true });
    expect(tracked?.upgradeNote).toBeNull();
    expect(wallet.methods()).not.toContain('eth_requestAccounts');
  });

  it('the upgrade follows the browser account when it is the root, with no note', async () => {
    installFakeWallet({ accounts: [WALLET] });
    seed({ address: PASTED });
    mockWorld({ keyConfigured: true, agent: agentStatus({ configured: true, root: WALLET }) });
    renderWithClient(<Probe />);

    expect(await screen.findByText(`${WALLET}|follow`)).toBeInTheDocument();
    expect(stored()).toEqual({ address: WALLET, walletUpgraded: true, followWallet: true });
  });

  it('with no browser account, the upgrade shows the root once, with the note', async () => {
    installFakeWallet({ accounts: [] });
    seed({ address: PASTED });
    mockWorld({ keyConfigured: true, agent: agentStatus({ configured: true, root: WALLET }) });
    const first = renderWithClient(<Probe />);

    expect(await screen.findByText(`${WALLET}|fixed`)).toBeInTheDocument();
    expect(stored()).toEqual({ address: WALLET, walletUpgraded: true, walletUpgradeNote: WALLET });
    expect(tracked?.upgradeNote).toBe(WALLET);
    first.unmount();

    seed({ address: PASTED, walletUpgraded: true });
    renderWithClient(<Probe />);
    await waitFor(() => expect(tracked?.address).toBe(PASTED));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('probe')).toHaveTextContent(`${PASTED}|fixed`);
    expect(stored()).toEqual({ address: PASTED, walletUpgraded: true });
  });

  it('with no browser wallet at all, the upgrade shows the root with the note', async () => {
    seed({ address: PASTED });
    mockWorld({ keyConfigured: true, agent: agentStatus({ configured: true, root: WALLET }) });
    renderWithClient(<Probe />);

    expect(await screen.findByText(`${WALLET}|fixed`)).toBeInTheDocument();
    expect(stored()).toEqual({ address: WALLET, walletUpgraded: true, walletUpgradeNote: WALLET });
  });

  it('a wallet locked at load follows the account it switches to', async () => {
    const wallet = installFakeWallet({ accounts: [] });
    seed({ address: WALLET, walletUpgraded: true });
    mockWorld({ keyConfigured: true, agent: agentStatus({ configured: true, root: WALLET }) });
    renderWithClient(<Probe />);
    await waitFor(() => expect(wallet.listenerCount()).toBe(1));
    await waitFor(() => expect(wallet.methods()).toContain('eth_accounts'));
    expect(screen.getByTestId('probe')).toHaveTextContent(`${WALLET}|fixed`);

    act(() => wallet.emitAccounts([SECOND]));
    expect(await screen.findByText(`${SECOND}|follow`)).toBeInTheDocument();
    expect(stored()).toEqual({ address: SECOND, walletUpgraded: true, followWallet: true });
  });

  it('a manual Track ends when the browser wallet switches account', async () => {
    const wallet = installFakeWallet({ accounts: [WALLET] });
    seed({ address: WALLET, walletUpgraded: true, followWallet: true });
    mockWorld({ keyConfigured: true, agent: agentStatus({ configured: true, root: WALLET }) });
    renderWithClient(<Probe />);
    await waitFor(() => expect(wallet.listenerCount()).toBe(1));

    act(() => tracked?.setAddress(PASTED));
    expect(await screen.findByText(`${PASTED}|fixed`)).toBeInTheDocument();
    expect(stored()).toEqual({ address: PASTED, walletUpgraded: true, manual: true });

    act(() => wallet.emitAccounts([SECOND]));
    expect(await screen.findByText(`${SECOND}|follow`)).toBeInTheDocument();
    expect(stored()).toEqual({ address: SECOND, walletUpgraded: true, followWallet: true });
  });

  it('a manual Track survives a reload while the wallet stays on its account', async () => {
    const wallet = installFakeWallet({ accounts: [SECOND] });
    seed({ address: PASTED, walletUpgraded: true, manual: true });
    mockWorld({ keyConfigured: true, agent: agentStatus({ configured: true, root: WALLET }) });
    renderWithClient(<Probe />);
    await waitFor(() => expect(wallet.methods()).toContain('eth_accounts'));
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByTestId('probe')).toHaveTextContent(`${PASTED}|fixed`);
    expect(stored()).toEqual({ address: PASTED, walletUpgraded: true, manual: true });
    expect(wallet.listenerCount()).toBe(1);
  });

  it('Use my browser wallet clears a manual Track', async () => {
    installFakeWallet({ accounts: [SECOND] });
    seed({ address: PASTED, walletUpgraded: true, manual: true });
    mockWorld({ keyConfigured: true, agent: agentStatus({ configured: true, root: WALLET }) });
    renderWithClient(<Probe />);
    expect(await screen.findByText(`${PASTED}|fixed`)).toBeInTheDocument();

    act(() => tracked?.followBrowserWallet(SECOND));
    expect(await screen.findByText(`${SECOND}|follow`)).toBeInTheDocument();
    expect(stored()).toEqual({ address: SECOND, walletUpgraded: true, followWallet: true });
  });
});

describe('useActiveWallet states', () => {
  afterEach(() => localStorage.clear());

  it.each([
    ['own login, Boros read ok', { configured: true, root: WALLET, approval: 'approved' as const }, 'can-trade|trade|show-gate|-'],
    ['own login, Boros not read', { configured: true, root: WALLET, approval: 'unknown' as const }, 'unchecked|trade|show-gate|-'],
    ['another wallet logged in', { configured: true, root: SECOND, approval: 'approved' as const }, 'view-only|no-trade|hide-gate|Log in to trade 0xab18…ed9d'],
    ['no login at all', { configured: false }, 'not-logged-in|no-trade|show-gate|Log in to trade 0xab18…ed9d'],
  ])('%s', async (_name, agent, expected) => {
    seed({ address: WALLET, walletUpgraded: true });
    mockWorld({ agent: agentStatus(agent) });
    renderWithClient(<StateProbe />);
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent(expected));
  });
});
