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
import { BorosAgentSetup } from './BorosAgentSetup';

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
    renderWithClient(<BorosAgentSetup />);

    await user.click(await screen.findByRole('button', { name: 'Connect wallet' }));
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
    renderWithClient(<BorosAgentSetup />);
    await user.click(await screen.findByRole('button', { name: 'Connect wallet' }));
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
    renderWithClient(<BorosAgentSetup />);
    await user.click(await screen.findByRole('button', { name: 'Connect wallet' }));

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
    expect(await screen.findByText('approval expired')).toBeInTheDocument();
    expect(screen.getByText(/every order will be refused/i)).toBeInTheDocument();
  });

  it('reports a rejected wallet prompt without leaving the button spinning', async () => {
    const user = userEvent.setup();
    (window as unknown as { ethereum?: unknown }).ethereum = {
      request: vi.fn(async () => {
        throw Object.assign(new Error('User rejected the request'), { code: 4001 });
      }),
    };
    server.use(http.get('/api/boros/agent', () => HttpResponse.json(env(status()))));
    renderWithClient(<BorosAgentSetup />);

    await user.click(await screen.findByRole('button', { name: 'Connect wallet' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/rejected/i);
    // Recoverable: the button is live again, not stuck mid-step.
    expect(screen.getByRole('button', { name: 'Connect wallet' })).not.toBeDisabled();
  });

  it('tells the user when there is no wallet at all, instead of offering a dead button', async () => {
    server.use(http.get('/api/boros/agent', () => HttpResponse.json(env(status()))));
    renderWithClient(<BorosAgentSetup />);
    expect(await screen.findByText(/No browser wallet detected/i)).toBeInTheDocument();
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

    expect(await screen.findByText('trading enabled')).toBeInTheDocument();
    expect(screen.getByText('0x1111…1111')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove key' })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(AGENT_KEY);
  });

  it('repeats the server’s warning that removing the key does not revoke it', async () => {
    const user = userEvent.setup();
    const note = 'The key is gone from this machine. The on-chain approval is still live until you revoke it in the Boros app or it expires.';
    server.use(
      http.get('/api/boros/agent', () =>
        HttpResponse.json(env(status({ configured: true, root: ROOT, rootMasked: '0x1111…1111' }))),
      ),
      http.delete('/api/boros/agent', () => HttpResponse.json(env({ configured: false, note }))),
    );
    renderWithClient(<BorosAgentSetup />);

    await user.click(await screen.findByRole('button', { name: 'Remove key' }));
    expect(await screen.findByText(/still live until you revoke it/i)).toBeInTheDocument();
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
