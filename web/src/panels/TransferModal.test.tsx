import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TransferView } from '../api/types';
import { REBALANCE_NOW, rebalanceHandler, rebalanceViews, transferViews } from '../test/fixtures';
import { env, server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { TransferModal } from './TransferModal';

const GATE_TEXT = 'Insufficient transferAvailable, transferAvailable: 292.0185407';

const GATE_SILENT = { ok: false, error: { category: 'network', message: 'Gate did not answer.', retryable: true } };

const dialog = () => screen.getByRole('dialog');
const amountInput = () => screen.getByRole('textbox');
const toTile = () => screen.getByRole('group', { name: 'To' });
const pickWallet = (name: string) => userEvent.click(screen.getByRole('radio', { name }));
const pickInto = () => userEvent.click(screen.getByRole('radio', { name: 'Into CrossEx' }));

function facts(): Record<string, string> {
  return Object.fromEntries(
    Array.from(document.querySelectorAll('dt'), (dt) => [dt.textContent ?? '', dt.nextElementSibling?.textContent ?? '']),
  );
}

async function open(view: TransferView = transferViews.accountB) {
  server.use(rebalanceHandler(rebalanceViews.accountB));
  renderWithClient(<TransferModal view={view} onClose={() => {}} holdMs={50} />);
  await screen.findByRole('dialog');
}

function recordTransferPosts(answer: 'accepted' | 'silent'): { id?: unknown }[] {
  const bodies: { id?: unknown }[] = [];
  server.use(
    http.post('/api/transfer', async ({ request }) => {
      bodies.push((await request.json()) as { id?: unknown });
      return answer === 'accepted'
        ? HttpResponse.json(env({ id: 'mtzur2ab' }), { status: 202 })
        : HttpResponse.json(GATE_SILENT, { status: 502 });
    }),
  );
  return bodies;
}

describe('TransferModal', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('opens holding the direction, the wallets, the amount, the facts and the hold', async () => {
    await open();

    expect(await screen.findByRole('radio', { name: 'Out of CrossEx' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Into CrossEx' })).not.toBeChecked();
    expect(screen.getByRole('radiogroup', { name: 'From · CrossEx wallet' })).toBeInTheDocument();
    expect(within(toTile()).getByText('Gate spot')).toBeInTheDocument();
    expect(amountInput()).toHaveValue('');
    expect(Object.keys(facts())).toEqual(['Fee', 'Time', 'Minimum', 'You get']);
    expect(screen.getByRole('button', { name: 'Hold to send 0.00 USDT to Gate spot' })).toBeInTheDocument();
  });

  it('transfer facts read the path on the wire', async () => {
    await open();
    await userEvent.type(amountInput(), '150');

    expect(facts()).toEqual({ Fee: 'free', Time: 'about 3s', Minimum: '0.00001', 'You get': '150.00 USDT' });
  });

  it('amount cap is the path max, and Max fills it', async () => {
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Max' }));

    expect(amountInput()).toHaveValue('816.10');

    await userEvent.clear(amountInput());
    await userEvent.type(amountInput(), '900');

    expect(screen.getByText('Max 816.10 USDT. The rest is margin for open positions.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hold to send 900.00 USDT to Gate spot' })).toBeDisabled();
  });

  it('moving holds the step list and the money on the way', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(REBALANCE_NOW);
    await open(transferViews.moving);

    expect(within(dialog()).getByText('Sending')).toBeInTheDocument();
    expect(facts()).toEqual({ Moving: '11.88 USDC', From: 'USDC · Hyperliquid', To: 'Gate spot' });
    expect(screen.getByText('✓ Asked Gate to move it')).toBeInTheDocument();
    expect(screen.getByText('• Waiting for Gate spot to show it')).toBeInTheDocument();
    expect(screen.getByText('○ Reading your balances again')).toBeInTheDocument();
    expect(screen.getByText('Started 2m 10s ago. You can close this. The transfer keeps going.')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  it('failed shows gate text, unedited', async () => {
    await open(transferViews.failedOverCap);

    const block = within(dialog()).getByRole('alert');
    expect(block).toHaveTextContent('Gate refused the transfer. Nothing moved.');
    expect(within(block).getByText(GATE_TEXT)).toBeInTheDocument();
  });

  it('failed facts read the asked amount, the fresh cap and what moved', async () => {
    await open(transferViews.failedOverCap);

    expect(facts()).toEqual({
      'You asked to move': '442.02 USDC',
      'Gate allows': '292.02 USDC',
      Moved: 'nothing',
    });
  });

  it('try again clamps to the cap the path allows now', async () => {
    await open(transferViews.failedOverCap);
    await userEvent.click(screen.getByRole('button', { name: 'Try again with 292.02' }));

    expect(amountInput()).toHaveValue('292.02');
    expect(screen.getByRole('radio', { name: 'Out of CrossEx' })).toBeChecked();
    expect(await screen.findByRole('radio', { name: 'USDC · Hyperliquid' })).toBeChecked();
  });

  it('no toast on failure, the reason stays in the modal', async () => {
    await open(transferViews.failedOverCap);

    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].closest('[role="dialog"]')).not.toBeNull();
    expect(screen.getByText(GATE_TEXT)).toBeInTheDocument();
  });

  it('no spot read hides the balance instead of showing a zero', async () => {
    await open(transferViews.noSpot);

    expect(within(toTile()).getByText('balance hidden')).toBeInTheDocument();
    expect(within(toTile()).queryByText(/0\.00/)).toBeNull();
    expect(screen.getByText('Add Spot read permission to see spot balances.')).toBeInTheDocument();
  });

  it('over max hides you get and marks the input invalid', async () => {
    await open();
    await userEvent.type(amountInput(), '900');

    expect(facts()).not.toHaveProperty('You get');
    expect(amountInput()).toHaveAttribute('aria-invalid', 'true');
  });

  it('zero names the real minimum, not "more than 0"', async () => {
    await open();
    await pickWallet('USDC · Hyperliquid');
    await userEvent.type(amountInput(), '0');

    expect(screen.getByText('Minimum 11 USDC.')).toBeInTheDocument();
    expect(screen.queryByText('Must be more than 0')).toBeNull();
  });

  it('a negative still says more than 0', async () => {
    await open();
    await pickWallet('USDC · Hyperliquid');
    await userEvent.type(amountInput(), '-5');

    expect(screen.getByText('Must be more than 0')).toBeInTheDocument();
  });

  it('a tiny amount shows its real value', async () => {
    await open();
    await userEvent.type(amountInput(), '0.001');

    expect(screen.getByRole('button', { name: 'Hold to send 0.001 USDT to Gate spot' })).toBeEnabled();
    expect(facts()).toHaveProperty('You get', '0.001 USDT');
  });

  it('a locked form does not change the wallet', async () => {
    await open(transferViews.lockRebalance);
    await userEvent.click(screen.getByText('USDC · Hyperliquid'));

    expect(screen.getByRole('radio', { name: 'USDT · CrossEx' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'USDC · Hyperliquid' })).toBeDisabled();
  });

  it('a moving transfer does not change the wallet', async () => {
    await open(transferViews.moving);

    expect(screen.queryByRole('radio', { name: 'USDC · Hyperliquid' })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Hold to send/ })).toBeNull();
  });

  it('into hold label names the USDC wallet', async () => {
    await open(transferViews.spotBoth);
    await pickInto();
    await userEvent.type(amountInput(), '20');

    await pickWallet('USDC · Hyperliquid');
    expect(screen.getByRole('button', { name: 'Hold to send 20.00 USDC to USDC · Hyperliquid' })).toBeEnabled();
    await pickWallet('USDC · Gate');
    expect(screen.getByRole('button', { name: 'Hold to send 20.00 USDC to USDC · Gate' })).toBeEnabled();
  });

  it('seconds under a minute', async () => {
    await open();
    await pickInto();
    await userEvent.type(amountInput(), '150');

    expect(facts()).toHaveProperty('Time', 'about 3s');
  });

  it('free fee', async () => {
    await open();
    await pickInto();
    await userEvent.type(amountInput(), '150');

    expect(facts()).toHaveProperty('Fee', 'free');
  });

  it('hold label and you get have thousands commas', async () => {
    await open(transferViews.noSpot);
    await pickInto();
    await userEvent.type(amountInput(), '1000');

    expect(screen.getByRole('button', { name: 'Hold to send 1,000.00 USDT to USDT · CrossEx' })).toBeEnabled();
    expect(facts()).toHaveProperty('You get', '1,000.00 USDT');
  });
});

describe('TransferModal hold', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('hold posts the trimmed amount text', async () => {
    const posts = recordTransferPosts('accepted');
    await open();
    await pickWallet('USDC · Hyperliquid');
    await userEvent.type(amountInput(), ' 11.88 ');

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Hold to send 11.88 USDC to Gate spot' }));

    await waitFor(() =>
      expect(posts).toEqual([
        { id: expect.any(String), coin: 'USDC', from: 'CROSSEX_HYPERLIQUID', to: 'SPOT', amount: '11.88' },
      ]),
    );
  });

  it('a hold after a refused POST sends the same id', async () => {
    const posts = recordTransferPosts('silent');
    await open();
    await userEvent.type(amountInput(), '10');
    const hold = screen.getByRole('button', { name: 'Hold to send 10.00 USDT to Gate spot' });

    fireEvent.pointerDown(hold);
    await screen.findByRole('alert');
    await waitFor(() => expect(hold).toBeEnabled());
    fireEvent.pointerDown(hold);

    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[0].id).toEqual(expect.any(String));
    expect(posts[1].id).toBe(posts[0].id);
  });

  it('a hold after a success sends a new id', async () => {
    const posts = recordTransferPosts('accepted');
    await open();
    await userEvent.type(amountInput(), '10');
    const hold = screen.getByRole('button', { name: 'Hold to send 10.00 USDT to Gate spot' });

    fireEvent.pointerDown(hold);
    await waitFor(() => expect(posts).toHaveLength(1));
    await waitFor(() => expect(hold).toBeEnabled());
    fireEvent.pointerDown(hold);

    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1].id).toEqual(expect.any(String));
    expect(posts[1].id).not.toBe(posts[0].id);
  });

  it('a changed hold after a lost response sends a new id', async () => {
    const posts = recordTransferPosts('silent');
    await open();
    await userEvent.type(amountInput(), '10');
    const hold = () => screen.getByRole('button', { name: /^Hold to send/ });

    fireEvent.pointerDown(hold());
    await screen.findByRole('alert');
    await waitFor(() => expect(hold()).toBeEnabled());

    await userEvent.clear(amountInput());
    await userEvent.type(amountInput(), '20');
    fireEvent.pointerDown(hold());

    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[0].id).toEqual(expect.any(String));
    expect(posts[1].id).not.toBe(posts[0].id);
  });

  it('a refused POST shows under the hold', async () => {
    server.use(
      http.post('/api/transfer', () =>
        HttpResponse.json(
          { ok: false, error: { category: 'validation', message: 'Minimum 11 USDC.', retryable: false } },
          { status: 409 },
        ),
      ),
    );
    await open();
    await pickWallet('USDC · Hyperliquid');
    await userEvent.type(amountInput(), '11.88');
    const hold = screen.getByRole('button', { name: 'Hold to send 11.88 USDC to Gate spot' });

    fireEvent.pointerDown(hold);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Minimum 11 USDC.');
    expect(hold.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await userEvent.type(amountInput(), '5');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
