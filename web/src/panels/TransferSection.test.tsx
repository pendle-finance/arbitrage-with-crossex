import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TransferJob, TransferView } from '../api/types';
import { REBALANCE_NOW, rebalanceHandler, rebalanceViews, transferHandler, transferViews } from '../test/fixtures';
import { env, server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { TransferSection } from './TransferSection';

const DONE_TOAST = 'Sent 11.88 USDC to Gate spot. 10.88 arrived.';
const SENDING = 'Sending 11.88 USDC to Gate spot';

const SENT_INTO_HYPERLIQUID: TransferJob = {
  ...transferViews.moving.transfer,
  from: 'SPOT',
  to: 'CROSSEX_HYPERLIQUID',
};

function serve(view: TransferView = transferViews.accountB) {
  server.use(transferHandler(view), rebalanceHandler(rebalanceViews.accountB));
}

const loaded = () => screen.findByRole('radio', { name: 'Out of CrossEx' });
const amountInput = () => screen.getByRole('textbox');

function amountLabel(): string | null {
  const input = amountInput();
  if (!(input instanceof HTMLInputElement)) return null;
  return input.labels?.[0]?.textContent ?? null;
}
const pickWallet = (name: string) => userEvent.click(screen.getByRole('radio', { name }));
const pickInto = () => userEvent.click(screen.getByRole('radio', { name: 'Into CrossEx' }));

function walletRows(group: HTMLElement): string[] {
  return within(group)
    .getAllByRole('radio')
    .map((radio) =>
      Array.from(radio.closest('label')?.querySelectorAll('span') ?? [], (span) => span.textContent).join(' '),
    );
}

function facts(): Record<string, string> {
  return Object.fromEntries(
    Array.from(document.querySelectorAll('dt'), (dt) => [dt.textContent ?? '', dt.nextElementSibling?.textContent ?? '']),
  );
}

async function renderCard(view: TransferView = transferViews.accountB) {
  serve(view);
  renderWithClient(<TransferSection holdMs={50} />);
  await loaded();
}

describe('TransferSection', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('out is default', async () => {
    serve();
    renderWithClient(<TransferSection holdMs={50} />);

    expect(await loaded()).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Into CrossEx' })).not.toBeChecked();
  });

  it('from list balances', async () => {
    await renderCard();

    const group = screen.getByRole('radiogroup', { name: 'From · CrossEx wallet' });
    await waitFor(() =>
      expect(walletRows(group)).toEqual([
        'USDT · CrossEx 986.61 USDT',
        'USDC · Gate 0.29 USDC',
        'USDC · Hyperliquid 11.88 USDC',
      ]),
    );
  });

  it('spot tile', async () => {
    await renderCard();

    const to = screen.getByRole('group', { name: 'To' });
    expect(within(to).getByText('Gate spot')).toBeInTheDocument();
    expect(within(to).getByText('318.42 USDT · 0.00 USDC')).toBeInTheDocument();
  });

  it('into swaps columns', async () => {
    await renderCard();
    await pickInto();

    expect(within(screen.getByRole('group', { name: 'From' })).getByText('Gate spot')).toBeInTheDocument();
    expect(within(screen.getByRole('radiogroup', { name: 'To · CrossEx wallet' })).getAllByRole('radio')).toHaveLength(3);
    expect(screen.queryByRole('radiogroup', { name: 'From · CrossEx wallet' })).toBeNull();
  });

  it('up to label', async () => {
    await renderCard();
    await pickWallet('USDC · Hyperliquid');

    expect(amountLabel()).toBe('Amount · up to 11.88');
  });

  it('max fills', async () => {
    await renderCard();
    await pickWallet('USDC · Hyperliquid');
    await userEvent.click(screen.getByRole('button', { name: 'Max' }));

    expect(amountInput()).toHaveValue('11.88');
  });

  it('hyperliquid out facts', async () => {
    await renderCard();
    await pickWallet('USDC · Hyperliquid');
    await userEvent.type(amountInput(), '11.88');

    expect(facts()).toEqual({ Fee: '$1.00', Time: 'about 6.5 min', Minimum: '11 USDC', 'You get': '10.88 USDC' });
  });

  it('no minimum on USDT', async () => {
    await renderCard();
    await pickInto();
    await userEvent.type(amountInput(), '150');

    expect(facts()).not.toHaveProperty('Minimum');
    expect(facts()).toHaveProperty('You get', '150.00 USDT');
  });

  it('into hold label', async () => {
    await renderCard();
    await pickInto();
    await userEvent.type(amountInput(), '150');

    expect(screen.getByRole('button', { name: 'Hold to send 150.00 USDT to USDT · CrossEx' })).toBeEnabled();
  });

  it('into hold label names the USDC wallet', async () => {
    await renderCard(transferViews.spotBoth);
    await pickInto();
    await userEvent.type(amountInput(), '20');

    await pickWallet('USDC · Hyperliquid');
    expect(screen.getByRole('button', { name: 'Hold to send 20.00 USDC to USDC · Hyperliquid' })).toBeEnabled();
    await pickWallet('USDC · Gate');
    expect(screen.getByRole('button', { name: 'Hold to send 20.00 USDC to USDC · Gate' })).toBeEnabled();
  });

  it('sending line and done toast name the wallet', async () => {
    await renderCard({ ...transferViews.moving, transfer: SENT_INTO_HYPERLIQUID });
    expect(screen.getByText('Sending 11.88 USDC to USDC · Hyperliquid')).toBeInTheDocument();

    serve({ ...transferViews.moving, transfer: { ...SENT_INTO_HYPERLIQUID, status: 'done', received: 10.88 } });

    expect(
      await screen.findByText('Sent 11.88 USDC to USDC · Hyperliquid. 10.88 arrived.', undefined, { timeout: 3_000 }),
    ).toBeInTheDocument();
  });

  it('out hold label', async () => {
    await renderCard();
    await pickWallet('USDC · Hyperliquid');
    await userEvent.type(amountInput(), '11.88');

    expect(screen.getByRole('button', { name: 'Hold to send 11.88 USDC to Gate spot' })).toBeEnabled();
  });

  it('a tiny amount shows its real value', async () => {
    await renderCard();
    await userEvent.type(amountInput(), '0.001');

    expect(screen.getByRole('button', { name: 'Hold to send 0.001 USDT to Gate spot' })).toBeEnabled();
    expect(facts()).toHaveProperty('You get', '0.001 USDT');
  });

  it('over max line', async () => {
    await renderCard();
    await userEvent.type(amountInput(), '900');

    expect(screen.getByText('Max 816.10 USDT. The rest is margin for open positions.')).toBeInTheDocument();
  });

  it('over max hold off', async () => {
    await renderCard();
    await userEvent.type(amountInput(), '900');

    expect(screen.getByRole('button', { name: 'Hold to send 900.00 USDT to Gate spot' })).toBeDisabled();
  });

  it('over max hides you get and marks the input invalid', async () => {
    await renderCard();
    await userEvent.type(amountInput(), '900');

    expect(facts()).not.toHaveProperty('You get');
    expect(amountInput()).toHaveAttribute('aria-invalid', 'true');
  });

  it('moving line', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(REBALANCE_NOW);
    await renderCard(transferViews.moving);

    expect(screen.getByText(SENDING)).toBeInTheDocument();
    expect(screen.getByText('2m 10s of about 6.5 min')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  it('moving hold off', async () => {
    await renderCard(transferViews.moving);
    fireEvent.change(amountInput(), { target: { value: '10' } });

    expect(screen.getByRole('button', { name: 'Hold to send 10.00 USDT to Gate spot' })).toBeDisabled();
  });

  it('done toast', async () => {
    await renderCard(transferViews.moving);
    expect(screen.getByText(SENDING)).toBeInTheDocument();

    serve(transferViews.done);

    expect(await screen.findByText(DONE_TOAST, undefined, { timeout: 3_000 })).toBeInTheDocument();
  });

  it('no toast on reload', async () => {
    await renderCard(transferViews.done);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(screen.queryByText(DONE_TOAST)).toBeNull();
  });

  it('failed line', async () => {
    await renderCard(transferViews.failed);

    expect(screen.getByText('Transfer failed: x.')).toBeInTheDocument();
  });

  it('rebalance lock line', async () => {
    await renderCard(transferViews.lockRebalance);

    expect(screen.getByText('Transfers wait until the rebalance ends.')).toBeInTheDocument();
  });

  it('rebalance lock hold off', async () => {
    await renderCard(transferViews.lockRebalance);
    fireEvent.change(amountInput(), { target: { value: '10' } });

    expect(screen.getByRole('button', { name: 'Hold to send 10.00 USDT to Gate spot' })).toBeDisabled();
  });

  it('deal lock line', async () => {
    await renderCard(transferViews.lockDeal);

    expect(screen.getByText('Transfers wait until the deal ends.')).toBeInTheDocument();
  });

  it('a lock wins over a failed line', async () => {
    await renderCard(transferViews.failedLocked);

    expect(screen.getByText('Transfers wait until the rebalance ends.')).toBeInTheDocument();
    expect(screen.queryByText('Transfer failed: x.')).toBeNull();
  });

  it('no spot read line', async () => {
    await renderCard(transferViews.noSpot);

    expect(screen.getByText('Add Spot read permission to see spot balances.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'How ▸' })).toBeInTheDocument();
  });

  it('balance hidden', async () => {
    await renderCard(transferViews.noSpot);

    expect(within(screen.getByRole('group', { name: 'To' })).getByText('balance hidden')).toBeInTheDocument();
  });

  it('no max without spot read', async () => {
    await renderCard(transferViews.noSpot);
    await pickInto();

    expect(screen.queryByRole('button', { name: 'Max' })).toBeNull();
    expect(amountLabel()).toBe('Amount');
  });

  it('title hover', async () => {
    await renderCard();
    await userEvent.hover(screen.getByRole('button', { name: 'Transfer' }));

    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      "Move funds between Gate spot and CrossEx. Gate's website cannot do this.",
    );
  });

  it('done toast waits for visible tab', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await renderCard(transferViews.moving);
    expect(screen.getByText(SENDING)).toBeInTheDocument();

    serve(transferViews.done);
    await waitFor(() => expect(screen.queryByText(SENDING)).toBeNull(), { timeout: 3_000 });
    expect(screen.queryByText(DONE_TOAST)).toBeNull();

    visibility.mockReturnValue('visible');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(await screen.findByText(DONE_TOAST)).toBeInTheDocument();
  });

  it('load error retry', async () => {
    server.use(
      http.get('/api/transfer', () =>
        HttpResponse.json(
          { ok: false, error: { category: 'network', message: 'gate down', retryable: true } },
          { status: 500 },
        ),
      ),
      rebalanceHandler(rebalanceViews.accountB),
    );
    renderWithClient(<TransferSection holdMs={50} />);

    const retry = await screen.findByRole('button', { name: 'Retry' });
    expect(screen.getByText('Could not load transfers. gate down')).toBeInTheDocument();

    serve();
    await userEvent.click(retry);

    expect(await loaded()).toBeChecked();
  });

  it('load error stays while the retry poll runs', async () => {
    let reads = 0;
    server.use(
      http.get('/api/transfer', () => {
        reads += 1;
        if (reads === 1) {
          return HttpResponse.json(
            { ok: false, error: { category: 'network', message: 'gate down', retryable: true } },
            { status: 500 },
          );
        }
        return new Promise(() => undefined);
      }),
      rebalanceHandler(rebalanceViews.accountB),
    );
    renderWithClient(<TransferSection holdMs={50} />);

    const retry = await screen.findByRole('button', { name: 'Retry' });
    expect(screen.getByText('Could not load transfers. gate down')).toBeInTheDocument();

    await userEvent.click(retry);

    await waitFor(() => expect(reads).toBe(2));
    expect(screen.getByText('Could not load transfers. gate down')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(document.querySelector('.animate-pulse')).toBeNull();
  });

  it('halted lock line', async () => {
    await renderCard(transferViews.lockHalted);

    expect(screen.getByText('Transfers wait until you resume or abandon the rebalance.')).toBeInTheDocument();
  });

  it('moving line wins', async () => {
    await renderCard({ ...transferViews.moving, lock: 'deal' });

    expect(screen.getByText(SENDING)).toBeInTheDocument();
    expect(screen.queryByText('Transfers wait until the deal ends.')).toBeNull();
  });

  it('moving form off', async () => {
    await renderCard(transferViews.moving);

    expect(amountInput()).toBeDisabled();
  });

  it('wallet list header', async () => {
    await renderCard();

    expect(screen.getByRole('radiogroup', { name: 'From · CrossEx wallet' })).toBeInTheDocument();
    expect(screen.getByText('From · CrossEx wallet')).toBeInTheDocument();
  });

  it('seconds under a minute', async () => {
    await renderCard();
    await pickInto();
    await userEvent.type(amountInput(), '150');

    expect(facts()).toHaveProperty('Time', 'about 3s');
  });

  it('free fee', async () => {
    await renderCard();
    await pickInto();
    await userEvent.type(amountInput(), '150');

    expect(facts()).toHaveProperty('Fee', 'free');
  });

  it('hold posts the trimmed amount text', async () => {
    const posts: unknown[] = [];
    server.use(
      http.post('/api/transfer', async ({ request }) => {
        posts.push(await request.json());
        return HttpResponse.json(env({ id: 'mtzur2ab' }), { status: 202 });
      }),
    );
    await renderCard();
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
    const ids: unknown[] = [];
    server.use(
      http.post('/api/transfer', async ({ request }) => {
        ids.push(((await request.json()) as { id?: unknown }).id);
        return HttpResponse.json(
          { ok: false, error: { category: 'network', message: 'Gate did not answer.', retryable: true } },
          { status: 502 },
        );
      }),
    );
    await renderCard();
    await userEvent.type(amountInput(), '10');
    const hold = screen.getByRole('button', { name: 'Hold to send 10.00 USDT to Gate spot' });

    fireEvent.pointerDown(hold);
    await screen.findByRole('alert');
    await waitFor(() => expect(hold).toBeEnabled());
    fireEvent.pointerDown(hold);

    await waitFor(() => expect(ids).toHaveLength(2));
    expect(ids[0]).toEqual(expect.any(String));
    expect(ids[1]).toBe(ids[0]);
  });

  it('a hold after a success sends a new id', async () => {
    const ids: unknown[] = [];
    server.use(
      http.post('/api/transfer', async ({ request }) => {
        ids.push(((await request.json()) as { id?: unknown }).id);
        return HttpResponse.json(env({ id: 'mtzur2ab' }), { status: 202 });
      }),
    );
    await renderCard();
    await userEvent.type(amountInput(), '10');
    const hold = screen.getByRole('button', { name: 'Hold to send 10.00 USDT to Gate spot' });

    fireEvent.pointerDown(hold);
    await waitFor(() => expect(ids).toHaveLength(1));
    await waitFor(() => expect(hold).toBeEnabled());
    fireEvent.pointerDown(hold);

    await waitFor(() => expect(ids).toHaveLength(2));
    expect(ids[1]).toEqual(expect.any(String));
    expect(ids[1]).not.toBe(ids[0]);
  });

  it('a changed hold after a lost response sends a new id', async () => {
    const ids: unknown[] = [];
    server.use(
      http.post('/api/transfer', async ({ request }) => {
        ids.push(((await request.json()) as { id?: unknown }).id);
        return HttpResponse.json(
          { ok: false, error: { category: 'network', message: 'Gate did not answer.', retryable: true } },
          { status: 502 },
        );
      }),
    );
    await renderCard();
    await userEvent.type(amountInput(), '10');
    const hold = () => screen.getByRole('button', { name: /^Hold to send/ });

    fireEvent.pointerDown(hold());
    await screen.findByRole('alert');
    await waitFor(() => expect(hold()).toBeEnabled());

    await userEvent.clear(amountInput());
    await userEvent.type(amountInput(), '20');
    fireEvent.pointerDown(hold());

    await waitFor(() => expect(ids).toHaveLength(2));
    expect(ids[0]).toEqual(expect.any(String));
    expect(ids[1]).not.toBe(ids[0]);
  });

  it('hold label and you get have thousands commas', async () => {
    await renderCard(transferViews.noSpot);
    await pickInto();
    await userEvent.type(amountInput(), '1000');

    expect(screen.getByRole('button', { name: 'Hold to send 1,000.00 USDT to USDT · CrossEx' })).toBeEnabled();
    expect(facts()).toHaveProperty('You get', '1,000.00 USDT');
  });

  it('a locked form does not change the wallet', async () => {
    await renderCard(transferViews.lockRebalance);
    await userEvent.click(screen.getByText('USDC · Hyperliquid'));

    expect(screen.getByRole('radio', { name: 'USDT · CrossEx' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'USDC · Hyperliquid' })).toBeDisabled();
  });

  it('a moving transfer does not change the wallet', async () => {
    await renderCard(transferViews.moving);
    await userEvent.click(screen.getByText('USDC · Hyperliquid'));

    expect(screen.getByRole('radio', { name: 'USDT · CrossEx' })).toBeChecked();
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
    await renderCard();
    await pickWallet('USDC · Hyperliquid');
    await userEvent.type(amountInput(), '11.88');

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Hold to send 11.88 USDC to Gate spot' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Minimum 11 USDC.');

    await userEvent.type(amountInput(), '5');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('pick opens into with the wallet', async () => {
    serve();
    renderWithClient(<TransferSection holdMs={50} pick={{ coin: 'USDC', wallet: 'CROSSEX_HYPERLIQUID', nonce: 1 }} />);

    expect(await screen.findByRole('radio', { name: 'Into CrossEx' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'USDC · Hyperliquid' })).toBeChecked();
  });
});
