import { fireEvent, screen } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { server } from '../test/server';
import { setLoginInFlight } from '../lib/loginInFlight';
import { renderWithClient } from '../test/utils';
import { ActiveWalletChip } from './ActiveWalletChip';

const ROOT = '0x1111111111111111111111111111111111111111';
const OTHER = '0x3333333333333333333333333333333333333333';
const env = <T,>(data: T) => ({ ok: true, data, meta: { ts: Date.now() } });
const nowSec = () => Math.floor(Date.now() / 1000);

const show = (active: string, agent: Record<string, unknown>, onOpen: () => void = () => {}) => {
  localStorage.setItem('crossex.strategy.v1', JSON.stringify({ address: active, walletUpgraded: true }));
  server.use(
    http.get('/api/boros/agent', () =>
      HttpResponse.json(
        env({ configured: true, root: ROOT, rootMasked: '0x1111…1111', accountId: 0, expiry: null, expired: false, canProvision: true, ...agent }),
      ),
    ),
  );
  renderWithClient(<ActiveWalletChip onOpen={onOpen} />);
};

afterEach(() => {
  localStorage.clear();
  setLoginInFlight(false);
});

describe('ActiveWalletChip', () => {
  const STATUS_WORDS = ['Logged in', 'View only', 'Not approved', 'Logging in…', 'Login expired', 'Login not checked', 'Not logged in'];
  const noWords = () => {
    for (const w of STATUS_WORDS) expect(screen.queryByText(w)).toBeNull();
    expect(screen.queryByText(/^Renew by/)).toBeNull();
  };
  const wallet = (addr: string) => screen.findByRole('button', { name: new RegExp(`Boros wallet ${addr}`) });

  it('logged-in wallet: the address and a green dot, no word', async () => {
    show(ROOT, { approval: 'approved', expiry: nowSec() + 200 * 86400 });
    expect(await screen.findByRole('img', { name: 'Logged in' })).toBeInTheDocument();
    expect(screen.getByRole('button')).toHaveTextContent('0x1111…1111');
    noWords();
  });

  it('a login ending soon still reads as logged in: the dot, no renew tag', async () => {
    show(ROOT, { approval: 'approved', expiry: nowSec() + 3 * 86400 });
    expect(await screen.findByRole('img', { name: 'Logged in' })).toBeInTheDocument();
    noWords();
  });

  it.each([
    ['another wallet', OTHER, { approval: 'approved' }],
    ['a key the chain never approved', ROOT, { approval: 'not-approved', expiry: nowSec() + 300 * 86400 }],
    ['an ended login', ROOT, { approval: 'expired', expired: true, expiry: nowSec() - 60 }],
    ['Boros could not be read', ROOT, { approval: 'unknown', expiry: nowSec() + 200 * 86400 }],
    ['no login at all', OTHER, { configured: false, root: null, rootMasked: null }],
  ] as const)('%s: the address, no dot, no status word', async (_label, addr, agent) => {
    show(addr, agent);
    const button = await wallet(addr);
    expect(button).toHaveTextContent(`${addr.slice(0, 6)}…${addr.slice(-4)}`);
    expect(screen.queryByRole('img', { name: 'Logged in' })).toBeNull();
    noWords();
  });

  it('a login still signing: no dot, no word', async () => {
    setLoginInFlight(true);
    show(ROOT, { approval: 'not-approved', expiry: nowSec() + 300 * 86400 });
    await wallet(ROOT);
    expect(screen.queryByRole('img', { name: 'Logged in' })).toBeNull();
    noWords();
  });

  it('is the Settings button: the gear sits in it and a click opens Settings', async () => {
    const onOpen = vi.fn();
    show(ROOT, { approval: 'approved', expiry: nowSec() + 200 * 86400 }, onOpen);
    const button = await wallet(ROOT);
    expect(button).toHaveAccessibleName(/^Settings/);
    expect(button.querySelector('.lucide-settings')).not.toBeNull();
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('with no wallet to show: the plain gear, still opening Settings', () => {
    const onOpen = vi.fn();
    renderWithClient(<ActiveWalletChip onOpen={onOpen} showWallet={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('carries no Boros mark: just the gear and the address', async () => {
    show(ROOT, { approval: 'approved', expiry: nowSec() + 200 * 86400 });
    const button = await wallet(ROOT);
    expect(button.querySelectorAll('svg')).toHaveLength(1);
    expect(button.querySelector('svg')).toHaveClass('lucide-settings');
  });
});
