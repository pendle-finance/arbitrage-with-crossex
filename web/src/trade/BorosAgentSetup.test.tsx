/**
 * Boros agent setup. What matters here is what the user is told before two
 * wallet prompts, and that the generated key goes to localhost and nowhere
 * else — never rendered, never in a URL.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { BorosAgentSetup, BorosLogInButton } from './BorosAgentSetup';

const ROOT = '0x1111111111111111111111111111111111111111';
const AGENT_KEY = `0x${'a'.repeat(64)}`;
const AGENT_ADDRESS = '0x2222222222222222222222222222222222222222';
const env = <T,>(data: T) => ({ ok: true, data, meta: { ts: Date.now() } });

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
  it('explains the delegation and its limits BEFORE any wallet prompt', async () => {
    installWallet();
    server.use(http.get('/api/boros/agent', () => HttpResponse.json(env(status()))));
    renderWithClient(<BorosAgentSetup />);

    expect(await screen.findByRole('button', { name: 'Connect wallet' })).toBeInTheDocument();
    // The two things a user must know before signing anything.
    expect(screen.getByText(/cannot deposit or withdraw/i)).toBeInTheDocument();
    expect(screen.getByText(/never asks for your wallet's key/i)).toBeInTheDocument();
    // And that there IS an on-chain transaction coming.
    expect(screen.getByText(/one on-chain transaction/i)).toBeInTheDocument();
    expect(screen.getByText('Enable Boros trading')).toBeInTheDocument();
    expect(screen.getByText('Connect the wallet that holds your Boros account.')).toBeInTheDocument();
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
      http.get('/api/boros/agent', () => HttpResponse.json(env(status()))),
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
      http.get('/api/boros/agent', () => HttpResponse.json(env(status()))),
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
      http.get('/api/boros/agent', () => HttpResponse.json(env(status()))),
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

  it('shows an expired approval as the blocker it is', async () => {
    server.use(
      http.get('/api/boros/agent', () =>
        HttpResponse.json(
          env(
            status({
              configured: true,
              root: ROOT,
              rootMasked: '0x1111…1111',
              expiry: 1_700_000_000,
              expired: true,
            }),
          ),
        ),
      ),
    );
    renderWithClient(<BorosAgentSetup />);
    expect(await screen.findByText('Login expired')).toBeInTheDocument();
    expect(screen.getByText(/Boros refuses every order until you renew it/)).toBeInTheDocument();
    expect(screen.queryByText(/Remove the key and connect again/)).toBeNull();
    // Status only: the ticket's own Log in button, where Confirm sits, is the
    // one login. A second one here showed two buttons for one action.
    expect(screen.queryByRole('button', { name: /Log in|Renew login/ })).toBeNull();
  });

  it('reports a rejected wallet prompt without leaving the button spinning', async () => {
    const user = userEvent.setup();
    (window as unknown as { ethereum?: unknown }).ethereum = {
      request: vi.fn(async () => {
        throw Object.assign(new Error('User rejected the request'), { code: 4001 });
      }),
    };
    server.use(http.get('/api/boros/agent', () => HttpResponse.json(env(status()))));
    localStorage.setItem('crossex.strategy.v1', JSON.stringify({ address: ROOT, walletUpgraded: true }));
    renderWithClient(<BorosLogInButton />);

    await user.click(await screen.findByRole('button', { name: 'Log in to trade 0x1111…1111' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/rejected/i);
    // Recoverable: the button is live again, not stuck mid-step.
    expect(screen.getByRole('button', { name: 'Log in to trade 0x1111…1111' })).not.toBeDisabled();
  });

  it('tells the user when there is no wallet at all, instead of offering a dead button', async () => {
    server.use(http.get('/api/boros/agent', () => HttpResponse.json(env(status()))));
    renderWithClient(<BorosAgentSetup />);
    expect(await screen.findByText('Install Rabby or MetaMask, then reload.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect wallet' })).not.toBeInTheDocument();
  });

  it('shows the configured state with a masked address, never the key', async () => {
    server.use(
      http.get('/api/boros/agent', () =>
        HttpResponse.json(
          env(status({ configured: true, root: ROOT, rootMasked: '0x1111…1111', accountId: 0 })),
        ),
      ),
    );
    renderWithClient(<BorosAgentSetup />);

    expect(await screen.findByText('Can trade')).toBeInTheDocument();
    expect(screen.getByText('0x1111…1111')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Log out' })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(AGENT_KEY);
  });

  it('says that logging out does not revoke the approval', async () => {
    const user = userEvent.setup();
    const note = 'The key is gone from this machine. The on-chain approval is still live until you revoke it in the Boros app or it expires.';
    server.use(
      http.get('/api/boros/agent', () =>
        HttpResponse.json(env(status({ configured: true, root: ROOT, rootMasked: '0x1111…1111' }))),
      ),
      http.delete('/api/boros/agent', () => HttpResponse.json(env({ configured: false, note }))),
    );
    renderWithClient(<BorosAgentSetup />);

    await user.click(await screen.findByRole('button', { name: 'Log out' }));
    expect(await screen.findByText(/stays live on-chain until you revoke it/i)).toBeInTheDocument();
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
  it('never mentions gas: orders fund their own gas, so there is nothing to watch', async () => {
    server.use(
      http.get('/api/boros/agent', () =>
        HttpResponse.json(env(status({ configured: true, root: ROOT, rootMasked: '0x1111…1111' }))),
      ),
    );
    renderWithClient(<BorosAgentSetup />);
    expect(await screen.findByText('0x1111…1111')).toBeInTheDocument();
    expect(screen.queryByText(/gas/i)).toBeNull();
  });

  it('Log in to trade runs the approval in place for the wallet it names', async () => {
    const user = userEvent.setup();
    installWallet();
    localStorage.setItem('crossex.strategy.v1', JSON.stringify({ address: ROOT, walletUpgraded: true }));
    let body: Record<string, unknown> | null = null;
    server.use(
      http.get('/api/boros/agent', () =>
        HttpResponse.json(env(status({ configured: true, root: AGENT_ADDRESS, rootMasked: '0x2222…2222' }))),
      ),
      http.put('/api/boros/agent', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(env(status({ configured: true, root: ROOT, rootMasked: '0x1111…1111' })));
      }),
    );
    renderWithClient(<BorosLogInButton />);

    await user.click(await screen.findByRole('button', { name: 'Log in to trade 0x1111…1111' }));
    // 0x2222 can trade now, so the terminal asks before logging it out.
    const ask = await screen.findByRole('alertdialog', { name: 'Log out 0x2222…2222?' });
    expect(ask).toHaveTextContent('Trading moves to 0x1111…1111.');
    expect(ask).toHaveTextContent('To close 0x2222…2222 positions, use the Boros app.');
    // The question's buttons are the only choices while it is open.
    expect(screen.queryByRole('button', { name: /Waiting for your answer/ })).toBeNull();
    expect(body).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Log in 0x1111…1111' }));
    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toMatchObject({ root: ROOT, accountId: 0 });
    await waitFor(() => expect(approveAgent).toHaveBeenCalledTimes(1));
    localStorage.clear();
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
    expect(await screen.findAllByText(/^Logged in\./)).toHaveLength(2);
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
      await screen.findAllByText(/^Logged in\. This terminal can trade 0x1111…1111 until/, {}, { timeout: 4000 }),
    ).toHaveLength(2);
    expect(reads).toBe(2);
  });

  it('a stored key the chain never approved: the card says "not approved", the login button says Log in', async () => {
    localStorage.setItem('crossex.strategy.v1', JSON.stringify({ address: ROOT, walletUpgraded: true }));
    installWallet();
    server.use(
      http.get('/api/boros/agent', () =>
        HttpResponse.json(
          env(status({ configured: true, root: ROOT, rootMasked: '0x1111…1111', expiry: 2_000_000_000, approval: 'not-approved' })),
        ),
      ),
    );
    renderWithClient(
      <>
        <BorosAgentSetup />
        <BorosLogInButton />
      </>,
    );
    expect(await screen.findByText('Not approved')).toBeInTheDocument();
    expect(screen.getByText(/The wallet prompt was rejected, or the login was revoked/)).toBeInTheDocument();
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

  it('warns 14 days before the login ends, with a Renew button', async () => {
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
    renderWithClient(
      <>
        <BorosAgentSetup />
        <BorosLogInButton renew />
      </>,
    );
    expect(await screen.findByText(/Your login ends on .*\. Renew it in Settings to keep trading\./)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Renew login for 0x1111…1111' })).toBeInTheDocument();
  });
});
