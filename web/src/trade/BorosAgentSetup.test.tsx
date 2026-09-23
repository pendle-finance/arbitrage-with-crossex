/**
 * Boros agent setup. What matters here is what the user is told before two
 * wallet prompts, and that the generated key goes to localhost and nowhere
 * else — never rendered, never in a URL.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTelegram } from '../api/queries';
import { telegramInfo } from '../test/fixtures';
import { server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { BorosAgentSetup, BorosLogInButton } from './BorosAgentSetup';

const ROOT = '0x1111111111111111111111111111111111111111';
const AGENT_KEY = `0x${'a'.repeat(64)}`;
const AGENT_ADDRESS = '0x2222222222222222222222222222222222222222';
const env = <T,>(data: T) => ({ ok: true, data, meta: { ts: Date.now() } });
const NOTHING_TO_RESTORE = { ok: false, error: { category: 'unknown', message: 'Nothing to restore.', retryable: false } };

const status = (over: Record<string, unknown> = {}) => ({
  configured: false,
  root: null,
  rootMasked: null,
  accountId: null,
  expiry: null,
  expired: false,
  canProvision: true,
  ...over,
});

/** Order of effects, so the test can pin that the key is stored BEFORE a
 * year-long on-chain approval is submitted for it. */
const calls: string[] = [];
const approveAgent = vi.fn(async (_input: { expiry: number; agentAddress: string }) => {
  calls.push('approve');
  return { txHash: '0xtx' };
});
vi.mock('../lib/borosAgentApi', () => ({
  generateAgentKey: () => ({ privateKey: AGENT_KEY, address: AGENT_ADDRESS }),
  approveAgent,
}));

/** A minimal injected wallet that accepts everything. */
function installWallet(over: Partial<Record<string, unknown>> = {}) {
  const request = vi.fn(async ({ method }: { method: string }) => {
    if (method === 'eth_requestAccounts') return [ROOT];
    if (method === 'eth_chainId') return '0xa4b1'; // Arbitrum One
    return null;
  });
  (window as unknown as { ethereum?: unknown }).ethereum = { request, ...over };
  return request;
}

beforeEach(() => {
  delete (window as unknown as { ethereum?: unknown }).ethereum;
});
afterEach(() => {
  delete (window as unknown as { ethereum?: unknown }).ethereum;
  vi.clearAllMocks();
  calls.length = 0;
});

describe('BorosAgentSetup', () => {
  it('with no wallet, asks only to connect one', async () => {
    installWallet();
    server.use(http.get('/api/boros/agent', () => HttpResponse.json(env(status()))));
    renderWithClient(<BorosAgentSetup />);

    expect(await screen.findByRole('button', { name: 'Connect wallet' })).toBeInTheDocument();
    expect(screen.getByText('Connect the wallet that holds your Boros account.')).toBeInTheDocument();
    // The ticket's Log in button names the wallet; no card repeats it.
    expect(screen.queryByText(/Log in once/)).toBeNull();
  });

  it('Connect wallet only asks for the account: no chain switch, no signature, no key', async () => {
    const user = userEvent.setup();
    const request = installWallet();
    let stored = false;
    server.use(
      http.get('/api/boros/agent', () => HttpResponse.json(env(status()))),
      http.put('/api/boros/agent', () => {
        stored = true;
        return HttpResponse.json(env(status()));
      }),
    );
    renderWithClient(<BorosAgentSetup />);
    await user.click(await screen.findByRole('button', { name: 'Connect wallet' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Connect wallet' })).toBeNull());
    expect(request.mock.calls.map(([a]) => a.method)).not.toContain('eth_chainId');
    expect(stored).toBe(false);
    expect(approveAgent).not.toHaveBeenCalled();
  });

  it('sends the generated key to localhost and never renders it', async () => {
    const user = userEvent.setup();
    installWallet();
    let body: Record<string, unknown> | null = null;
    server.use(
      http.get('/api/boros/agent', () =>
        HttpResponse.json(env(body ? status({ configured: true, root: ROOT, approval: 'approved' }) : status())),
      ),
      http.put('/api/boros/agent', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        calls.push('store');
        return HttpResponse.json(env(status({ configured: true, root: ROOT, rootMasked: '0x1111…1111' })));
      }),
    );
    localStorage.setItem('crossex.strategy.v1', JSON.stringify({ address: ROOT, walletUpgraded: true }));
    renderWithClient(<BorosLogInButton />);

    await user.click(await screen.findByRole('button', { name: 'Log in to trade 0x1111…1111' }));
    await waitFor(() => expect(body).not.toBeNull());

    expect(body).toMatchObject({ root: ROOT, accountId: 0, agentPrivateKey: AGENT_KEY });
    // The key must not appear anywhere on screen.
    expect(document.body.textContent).not.toContain(AGENT_KEY);
    expect(document.body.textContent).not.toContain('aaaaaaaa');
  });

  it('submits the approval with an ABSOLUTE unix expiry, not a duration', async () => {
    const user = userEvent.setup();
    installWallet();
    let body: Record<string, unknown> | null = null;
    server.use(
      http.get('/api/boros/agent', () =>
        HttpResponse.json(env(body ? status({ configured: true, root: ROOT, approval: 'approved' }) : status())),
      ),
      http.put('/api/boros/agent', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        calls.push('store');
        return HttpResponse.json(env(status({ configured: true, root: ROOT })));
      }),
    );
    localStorage.setItem('crossex.strategy.v1', JSON.stringify({ address: ROOT, walletUpgraded: true }));
    renderWithClient(<BorosLogInButton />);
    await user.click(await screen.findByRole('button', { name: 'Log in to trade 0x1111…1111' }));
    await waitFor(() => expect(body).not.toBeNull());

    // A duration (31,536,000) is 1971 as a timestamp — the contract stores it
    // verbatim and every order then fails AuthAgentExpired().
    const expiry = (body as unknown as { expiry: number }).expiry;
    const now = Math.floor(Date.now() / 1000);
    expect(expiry).toBeGreaterThan(now);
    expect(expiry).toBeLessThan(now + 400 * 24 * 3600);

    // And the approval was actually SUBMITTED, for the same timestamp and the
    // key that was just stored.
    await waitFor(() => expect(approveAgent).toHaveBeenCalledTimes(1));
    expect(approveAgent.mock.calls[0][0]).toMatchObject({
      expiry,
      agentAddress: AGENT_ADDRESS,
      root: ROOT,
    });
  });

  it('stores the key BEFORE approving it on-chain', async () => {
    // Both orders have a failure window; only this one is recoverable. A key
    // stored without an approval is inert and the next attempt overwrites it,
    // while approving first and failing to store strands a live, year-long
    // approval for a key the browser is about to forget — gas spent, and
    // revocable only by hand in the Boros app.
    const user = userEvent.setup();
    installWallet();
    server.use(
      http.get('/api/boros/agent', () =>
        HttpResponse.json(
          env(calls.includes('store') ? status({ configured: true, root: ROOT, approval: 'approved' }) : status()),
        ),
      ),
      http.put('/api/boros/agent', async () => {
        calls.push('store');
        return HttpResponse.json(env(status({ configured: true, root: ROOT })));
      }),
    );
    localStorage.setItem('crossex.strategy.v1', JSON.stringify({ address: ROOT, walletUpgraded: true }));
    renderWithClient(<BorosLogInButton />);
    await user.click(await screen.findByRole('button', { name: 'Log in to trade 0x1111…1111' }));

    await waitFor(() => expect(calls).toEqual(['store', 'approve']));
  });

  it('reports a rejected wallet prompt without leaving the button spinning', async () => {
    const user = userEvent.setup();
    (window as unknown as { ethereum?: unknown }).ethereum = {
      request: vi.fn(async () => {
        throw Object.assign(new Error('User rejected the request'), { code: 4001 });
      }),
    };
    let rolledBack = false;
    server.use(
      http.get('/api/boros/agent', () => HttpResponse.json(env(status()))),
      http.post('/api/boros/agent/rollback', () => {
        rolledBack = true;
        return HttpResponse.json(NOTHING_TO_RESTORE, { status: 409 });
      }),
    );
    localStorage.setItem('crossex.strategy.v1', JSON.stringify({ address: ROOT, walletUpgraded: true }));
    renderWithClient(<BorosLogInButton />);

    await user.click(await screen.findByRole('button', { name: 'Log in to trade 0x1111…1111' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/rejected/i);
    // Recoverable: the button is live again, not stuck mid-step.
    expect(screen.getByRole('button', { name: 'Log in to trade 0x1111…1111' })).not.toBeDisabled();
    expect(rolledBack).toBe(false);
  });

  it('tells the user when there is no wallet at all, instead of offering a dead button', async () => {
    server.use(http.get('/api/boros/agent', () => HttpResponse.json(env(status()))));
    renderWithClient(<BorosAgentSetup />);
    expect(await screen.findByText('Install Rabby or MetaMask, then reload.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect wallet' })).not.toBeInTheDocument();
  });

  it.each([
    ['logged in', { approval: 'approved', expiry: 2_000_000_000 }],
    ['login not checked', { approval: 'unknown', expiry: 2_000_000_000 }],
    ['not approved', { approval: 'not-approved', expiry: 2_000_000_000 }],
    ['expired', { approval: 'expired', expiry: 1_700_000_000, expired: true }],
    ['ends in 5 days', { approval: 'approved', expiry: Math.floor(Date.now() / 1000) + 5 * 86400 }],
    ['view only', { approval: 'approved', expiry: 2_000_000_000, root: AGENT_ADDRESS }],
  ] as const)('shows nothing once a wallet is set (%s): the button and the header chip carry it', async (_, over) => {
    installWallet();
    localStorage.setItem('crossex.strategy.v1', JSON.stringify({ address: ROOT, walletUpgraded: true }));
    let served = false;
    server.use(
      http.get('/api/boros/agent', () => {
        served = true;
        return HttpResponse.json(env(status({ configured: true, root: ROOT, rootMasked: '0x1111…1111', ...over })));
      }),
    );
    const { container } = renderWithClient(<BorosAgentSetup />);
    await waitFor(() => expect(served).toBe(true));
    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent).toBe('');
    localStorage.clear();
  });

  it('says so plainly when the build cannot place orders at all', async () => {
    server.use(
      http.get('/api/boros/agent', () => HttpResponse.json(env(status({ canProvision: false })))),
    );
    renderWithClient(<BorosAgentSetup />);
    expect(await screen.findByText(/cannot place Boros orders/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect wallet' })).not.toBeInTheDocument();
  });
});

describe('BorosAgentSetup — no gas balance on the strip', () => {
  it('Log in to trade runs the approval in place for the wallet it names', async () => {
    const user = userEvent.setup();
    installWallet();
    localStorage.setItem('crossex.strategy.v1', JSON.stringify({ address: ROOT, walletUpgraded: true }));
    let body: Record<string, unknown> | null = null;
    server.use(
      http.get('/api/boros/agent', () =>
        HttpResponse.json(
          env(
            body
              ? status({ configured: true, root: ROOT, approval: 'approved' })
              : status({ configured: true, root: AGENT_ADDRESS, rootMasked: '0x2222…2222' }),
          ),
        ),
      ),
      http.put('/api/boros/agent', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(env(status({ configured: true, root: ROOT, rootMasked: '0x1111…1111' })));
      }),
    );
    renderWithClient(<BorosLogInButton />);

    await user.click(await screen.findByRole('button', { name: 'Log in to trade 0x1111…1111' }));
    // 0x2222 can trade now, so the terminal asks before logging it out.
    const ask = await screen.findByRole('alertdialog', { name: 'Log out 0x2222…2222 and log in 0x1111…1111?' });
    expect(ask).toHaveTextContent('Log out 0x2222…2222 and log in 0x1111…1111?');
    expect(ask).not.toHaveTextContent('Telegram alerts');
    expect(ask).toHaveTextContent('0x2222…2222 Boros legs stay open. Its Gate perps show unhedged until you log it back in.');
    expect(ask).not.toHaveTextContent('Close them in the Boros app');
    // The question's buttons are the only choices while it is open.
    expect(screen.queryByRole('button', { name: /Waiting for your answer/ })).toBeNull();
    expect(body).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Log in 0x1111…1111' }));
    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toMatchObject({ root: ROOT, accountId: 0 });
    await waitFor(() => expect(approveAgent).toHaveBeenCalledTimes(1));
    localStorage.clear();
  });

  it('with Telegram alerts linked, the question says alerts are per wallet', async () => {
    const user = userEvent.setup();
    installWallet();
    localStorage.setItem('crossex.strategy.v1', JSON.stringify({ address: ROOT, walletUpgraded: true }));
    server.use(
      http.get('/api/boros/agent', () =>
        HttpResponse.json(env(status({ configured: true, root: AGENT_ADDRESS, rootMasked: '0x2222…2222' }))),
      ),
      http.get('/api/telegram', () =>
        HttpResponse.json(env(telegramInfo({ connected: true, state: 'connected', alertWallet: AGENT_ADDRESS }))),
      ),
    );
    function TelegramRead() {
      useTelegram();
      return null;
    }
    renderWithClient(
      <>
        <TelegramRead />
        <BorosLogInButton />
      </>,
    );

    await user.click(await screen.findByRole('button', { name: 'Log in to trade 0x1111…1111' }));
    const ask = await screen.findByRole('alertdialog', { name: 'Log out 0x2222…2222 and log in 0x1111…1111?' });
    await waitFor(() =>
      expect(ask).toHaveTextContent('Telegram alerts are per wallet.'),
    );
    expect(ask).not.toHaveTextContent('same chat');
  });

  it('Log in to trade refuses a browser wallet other than the one it names', async () => {
    const user = userEvent.setup();
    installWallet();
    const OTHER = '0x3333333333333333333333333333333333333333';
    localStorage.setItem('crossex.strategy.v1', JSON.stringify({ address: OTHER, walletUpgraded: true }));
    let stored = false;
    server.use(
      http.get('/api/boros/agent', () =>
        HttpResponse.json(env(status({ configured: true, root: AGENT_ADDRESS, rootMasked: '0x2222…2222' }))),
      ),
      http.put('/api/boros/agent', () => {
        stored = true;
        return HttpResponse.json(env(status()));
      }),
    );
    renderWithClient(<BorosLogInButton />);

    await user.click(await screen.findByRole('button', { name: 'Log in to trade 0x3333…3333' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your browser wallet is 0x1111…1111. Switch it to 0x3333…3333 to log in.',
    );
    expect(stored).toBe(false);
    expect(approveAgent).not.toHaveBeenCalled();
    localStorage.clear();
  });
});

describe('BorosAgentSetup — the chain decides "logged in"', () => {
  const OTHER = '0x3333333333333333333333333333333333333333';
  afterEach(() => localStorage.clear());

  it('Cancel on the log-out question stores nothing and frees the button', async () => {
    const user = userEvent.setup();
    installWallet();
    localStorage.setItem('crossex.strategy.v1', JSON.stringify({ address: ROOT, walletUpgraded: true }));
    let stored = false;
    server.use(
      http.get('/api/boros/agent', () =>
        HttpResponse.json(env(status({ configured: true, root: OTHER, rootMasked: '0x3333…3333', approval: 'approved' }))),
      ),
      http.put('/api/boros/agent', () => {
        stored = true;
        return HttpResponse.json(env(status()));
      }),
    );
    renderWithClient(<BorosLogInButton />);
    await user.click(await screen.findByRole('button', { name: 'Log in to trade 0x1111…1111' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('button', { name: 'Log in to trade 0x1111…1111' })).toBeEnabled();
    expect(stored).toBe(false);
    expect(approveAgent).not.toHaveBeenCalled();
  });

  it('does not ask when the other login is already dead', async () => {
    const user = userEvent.setup();
    installWallet();
    localStorage.setItem('crossex.strategy.v1', JSON.stringify({ address: ROOT, walletUpgraded: true }));
    let stored = false;
    server.use(
      http.get('/api/boros/agent', () =>
        HttpResponse.json(
          env(
            stored
              ? status({ configured: true, root: ROOT, approval: 'approved' })
              : status({ configured: true, root: OTHER, rootMasked: '0x3333…3333', approval: 'not-approved' }),
          ),
        ),
      ),
      http.put('/api/boros/agent', () => {
        stored = true;
        return HttpResponse.json(env(status({ configured: true, root: ROOT })));
      }),
    );
    renderWithClient(<BorosLogInButton />);
    await user.click(await screen.findByRole('button', { name: 'Log in to trade 0x1111…1111' }));
    await waitFor(() => expect(stored).toBe(true));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    // Inline under the button, and as a toast.
    expect(await screen.findAllByText(/^Logged in 0x/)).toHaveLength(2);
  });

  it('says "Logged in" only once Boros shows the approval', async () => {
    const user = userEvent.setup();
    installWallet();
    localStorage.setItem('crossex.strategy.v1', JSON.stringify({ address: ROOT, walletUpgraded: true }));
    let reads = 0;
    server.use(
      http.get('/api/boros/agent', ({ request }) => {
        const fresh = new URL(request.url).searchParams.get('fresh') === '1';
        if (fresh) reads += 1;
        // The first fresh read comes before the relay lands.
        const approval = fresh && reads > 1 ? 'approved' : 'not-approved';
        return HttpResponse.json(
          env(status({ configured: reads > 0, root: reads > 0 ? ROOT : null, approval: reads > 0 ? approval : null })),
        );
      }),
      http.put('/api/boros/agent', () => HttpResponse.json(env(status({ configured: true, root: ROOT })))),
    );
    renderWithClient(<BorosLogInButton />);
    await user.click(await screen.findByRole('button', { name: 'Log in to trade 0x1111…1111' }));
    expect(
      await screen.findAllByText(/^Logged in 0x1111…1111 until/, {}, { timeout: 4000 }),
    ).toHaveLength(2);
    expect(reads).toBe(2);
  });

  it('a stored key the chain never approved: the login button says Log in', async () => {
    localStorage.setItem('crossex.strategy.v1', JSON.stringify({ address: ROOT, walletUpgraded: true }));
    installWallet();
    server.use(
      http.get('/api/boros/agent', () =>
        HttpResponse.json(
          env(status({ configured: true, root: ROOT, rootMasked: '0x1111…1111', expiry: 2_000_000_000, approval: 'not-approved' })),
        ),
      ),
    );
    renderWithClient(<BorosLogInButton />);
    expect(await screen.findAllByRole('button', { name: 'Log in to trade 0x1111…1111' })).toHaveLength(1);
  });

  it('an expired login: the login button reads Renew', async () => {
    localStorage.setItem('crossex.strategy.v1', JSON.stringify({ address: ROOT, walletUpgraded: true }));
    installWallet();
    server.use(
      http.get('/api/boros/agent', () =>
        HttpResponse.json(
          env(status({ configured: true, root: ROOT, rootMasked: '0x1111…1111', expiry: 1_700_000_000, expired: true, approval: 'expired' })),
        ),
      ),
    );
    renderWithClient(<BorosLogInButton />);
    expect(await screen.findByRole('button', { name: 'Renew login for 0x1111…1111' })).toBeInTheDocument();
  });

  it('a login that ends within 14 days offers Renew', async () => {
    localStorage.setItem('crossex.strategy.v1', JSON.stringify({ address: ROOT, walletUpgraded: true }));
    installWallet();
    const soon = Math.floor(Date.now() / 1000) + 5 * 86400;
    server.use(
      http.get('/api/boros/agent', () =>
        HttpResponse.json(
          env(status({ configured: true, root: ROOT, rootMasked: '0x1111…1111', expiry: soon, approval: 'approved' })),
        ),
      ),
    );
    renderWithClient(<BorosLogInButton renew />);
    expect(await screen.findByRole('button', { name: 'Renew login for 0x1111…1111' })).toBeInTheDocument();
  });
});

describe('BorosAgentSetup — a failed approval rolls back', () => {
  const OTHER = '0x3333333333333333333333333333333333333333';
  const rejected = () => Object.assign(new Error('User rejected the request'), { code: 4001 });
  afterEach(() => localStorage.clear());

  it('restores the previous login and says it is still logged in', async () => {
    const user = userEvent.setup();
    installWallet();
    localStorage.setItem('crossex.strategy.v1', JSON.stringify({ address: ROOT, walletUpgraded: true }));
    approveAgent.mockImplementationOnce(async () => {
      throw rejected();
    });
    const order: string[] = [];
    server.use(
      http.get('/api/boros/agent', () =>
        HttpResponse.json(env(status({ configured: true, root: OTHER, rootMasked: '0x3333…3333', approval: 'approved' }))),
      ),
      http.put('/api/boros/agent', () => {
        order.push('store');
        return HttpResponse.json(env(status({ configured: true, root: ROOT })));
      }),
      http.post('/api/boros/agent/rollback', () => {
        order.push('rollback');
        return HttpResponse.json(env(status({ configured: true, root: OTHER, approval: 'approved' })));
      }),
    );
    renderWithClient(<BorosLogInButton />);
    await user.click(await screen.findByRole('button', { name: 'Log in to trade 0x1111…1111' }));
    await user.click(await screen.findByRole('button', { name: 'Log in 0x1111…1111' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'You rejected the request in your wallet. 0x3333…3333 is still logged in.',
    );
    expect(order).toEqual(['store', 'rollback']);
    expect(screen.queryByText(/^Logged in 0x/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Log in to trade 0x1111…1111' })).toBeEnabled();
  });

  it('names the login the server restored, not the one on screen before', async () => {
    const user = userEvent.setup();
    installWallet();
    localStorage.setItem('crossex.strategy.v1', JSON.stringify({ address: ROOT, walletUpgraded: true }));
    approveAgent.mockImplementationOnce(async () => {
      throw rejected();
    });
    const OLDER = '0x4444444444444444444444444444444444444444';
    server.use(
      http.get('/api/boros/agent', () =>
        HttpResponse.json(env(status({ configured: true, root: OTHER, rootMasked: '0x3333…3333', approval: 'approved' }))),
      ),
      http.put('/api/boros/agent', () => HttpResponse.json(env(status({ configured: true, root: ROOT })))),
      http.post('/api/boros/agent/rollback', () =>
        HttpResponse.json(env(status({ configured: true, root: OLDER, approval: 'approved' }))),
      ),
    );
    renderWithClient(<BorosLogInButton />);
    await user.click(await screen.findByRole('button', { name: 'Log in to trade 0x1111…1111' }));
    await user.click(await screen.findByRole('button', { name: 'Log in 0x1111…1111' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'You rejected the request in your wallet. 0x4444…4444 is still logged in.',
    );
  });

  it('with no previous login, a 409 from the rollback is ignored and only the error shows', async () => {
    const user = userEvent.setup();
    installWallet();
    localStorage.setItem('crossex.strategy.v1', JSON.stringify({ address: ROOT, walletUpgraded: true }));
    approveAgent.mockImplementationOnce(async () => {
      throw rejected();
    });
    let rollbacks = 0;
    server.use(
      http.get('/api/boros/agent', () => HttpResponse.json(env(status()))),
      http.put('/api/boros/agent', () => HttpResponse.json(env(status({ configured: true, root: ROOT })))),
      http.post('/api/boros/agent/rollback', () => {
        rollbacks += 1;
        return HttpResponse.json(NOTHING_TO_RESTORE, { status: 409 });
      }),
    );
    renderWithClient(<BorosLogInButton />);
    await user.click(await screen.findByRole('button', { name: 'Log in to trade 0x1111…1111' }));

    await waitFor(() => expect(rollbacks).toBe(1));
    expect(await screen.findByRole('alert')).toHaveTextContent(/^You rejected the request in your wallet\.$/);
  });
});

describe('BorosAgentSetup — waiting for Boros', () => {
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  const seedRoot = () =>
    localStorage.setItem('crossex.strategy.v1', JSON.stringify({ address: ROOT, walletUpgraded: true }));

  it('keeps polling past a failed read and a read for another wallet', async () => {
    const user = userEvent.setup();
    installWallet();
    seedRoot();
    let fresh = 0;
    server.use(
      http.get('/api/boros/agent', ({ request }) => {
        if (new URL(request.url).searchParams.get('fresh') !== '1') return HttpResponse.json(env(status()));
        fresh += 1;
        if (fresh === 1) return HttpResponse.error();
        if (fresh === 2)
          return HttpResponse.json(env(status({ configured: true, root: AGENT_ADDRESS, approval: 'approved' })));
        return HttpResponse.json(env(status({ configured: true, root: ROOT.toUpperCase().replace('0X', '0x'), approval: 'approved' })));
      }),
      http.put('/api/boros/agent', () => HttpResponse.json(env(status({ configured: true, root: ROOT })))),
    );
    renderWithClient(<BorosLogInButton />);
    await user.click(await screen.findByRole('button', { name: 'Log in to trade 0x1111…1111' }));
    expect(await screen.findAllByText(/^Logged in 0x/, {}, { timeout: 6000 })).toHaveLength(2);
    expect(fresh).toBe(3);
  }, 10_000);

  it('an older server (no approval field) counts as logged in', async () => {
    const user = userEvent.setup();
    installWallet();
    seedRoot();
    let stored = false;
    server.use(
      http.get('/api/boros/agent', () =>
        HttpResponse.json(env(stored ? status({ configured: true, root: ROOT }) : status())),
      ),
      http.put('/api/boros/agent', () => {
        stored = true;
        return HttpResponse.json(env(status({ configured: true, root: ROOT })));
      }),
    );
    renderWithClient(<BorosLogInButton />);
    await user.click(await screen.findByRole('button', { name: 'Log in to trade 0x1111…1111' }));
    const expiryText = await screen.findAllByText(/^Logged in 0x1111…1111 until \d{1,2} \w+ \d{4}\.$/);
    expect(expiryText).toHaveLength(2);
  });

  it.each([
    ['unknown', 'Boros did not answer. If Log in shows again, log in again.'],
    ['not-approved', 'Boros has not confirmed yet. If Log in still shows in a minute, log in again.'],
  ] as const)('approval stays %s: says so, no "Logged in"', async (approval, text) => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout'] });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    installWallet();
    seedRoot();
    let stored = false;
    server.use(
      http.get('/api/boros/agent', () =>
        HttpResponse.json(env(stored ? status({ configured: true, root: ROOT, approval }) : status())),
      ),
      http.put('/api/boros/agent', () => {
        stored = true;
        return HttpResponse.json(env(status({ configured: true, root: ROOT })));
      }),
    );
    renderWithClient(<BorosLogInButton />);
    await user.click(await screen.findByRole('button', { name: 'Log in to trade 0x1111…1111' }));
    await waitFor(() => expect(stored).toBe(true));
    for (let i = 0; i < 25 && !screen.queryByRole('alert'); i++) {
      await vi.advanceTimersByTimeAsync(1500);
    }
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
    expect(screen.queryByText(/^Logged in 0x/)).toBeNull();
  });

  it('labels each step in the order it happens', async () => {
    const user = userEvent.setup();
    let giveAccount: (a: string[]) => void = () => {};
    installWallet({
      request: vi.fn(({ method }: { method: string }) => {
        if (method === 'eth_requestAccounts') return new Promise((r) => (giveAccount = r));
        if (method === 'eth_chainId') return Promise.resolve('0xa4b1');
        return Promise.resolve(null);
      }),
    });
    seedRoot();
    let finishStore: () => void = () => {};
    let finishApprove: () => void = () => {};
    let finishRead: () => void = () => {};
    let stored = false;
    approveAgent.mockImplementationOnce(
      () => new Promise((r) => (finishApprove = () => r({ txHash: '0xtx' }))),
    );
    server.use(
      http.get('/api/boros/agent', async ({ request }) => {
        const fresh = new URL(request.url).searchParams.get('fresh') === '1';
        if (fresh) await new Promise<void>((r) => (finishRead = r));
        const approval = fresh ? 'approved' : 'not-approved';
        return HttpResponse.json(env(stored ? status({ configured: true, root: ROOT, approval }) : status()));
      }),
      http.put('/api/boros/agent', async () => {
        await new Promise<void>((r) => (finishStore = r));
        stored = true;
        return HttpResponse.json(env(status({ configured: true, root: ROOT })));
      }),
    );
    renderWithClient(<BorosLogInButton />);
    await user.click(await screen.findByRole('button', { name: 'Log in to trade 0x1111…1111' }));

    expect(await screen.findByRole('button', { name: 'Open your wallet…' })).toBeDisabled();
    giveAccount([ROOT]);
    expect(await screen.findByRole('button', { name: 'Saving the key on this machine…' })).toBeDisabled();
    finishStore();
    expect(await screen.findByRole('button', { name: 'Sign in your wallet…' })).toBeDisabled();
    finishApprove();
    expect(await screen.findByRole('button', { name: 'Waiting for Boros…' })).toBeDisabled();
    finishRead();
    expect(await screen.findAllByText(/^Logged in 0x/)).toHaveLength(2);
  });
});
