import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TransferView } from '../api/types';
import { rebalanceHandler, rebalanceViews, transferHandler, transferPostHandler, transferViews } from '../test/fixtures';
import { server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { TransferSection } from './TransferSection';
import type { TransferPick } from './TransferModal';

const DONE_TOAST = 'Sent 11.88 USDC to Gate spot. 10.88 arrived.';

function serve(view: TransferView = transferViews.accountB) {
  server.use(transferHandler(view), rebalanceHandler(rebalanceViews.accountB));
}

const loaded = () => screen.findByText('Manual Transfer');

async function renderCard(view: TransferView = transferViews.accountB) {
  serve(view);
  renderWithClient(<TransferSection holdMs={50} />);
  await loaded();
}

describe('TransferSection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('at rest shows a title, one line and one button, nothing else', async () => {
    await renderCard();

    expect(screen.getByText('Between Gate spot and CrossEx')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move money' })).toBeEnabled();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('title hover', async () => {
    await renderCard();
    await userEvent.hover(screen.getByRole('button', { name: 'Manual Transfer' }));

    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      "Move funds between Gate spot and CrossEx. Gate's website cannot do this.",
    );
  });

  it('no should i signal', async () => {
    const states: { name: string; view: TransferView }[] = [
      { name: 'at rest', view: transferViews.accountB },
      { name: 'moving', view: transferViews.moving },
      { name: 'failed', view: transferViews.failedOverCap },
      { name: 'lock rebalance', view: transferViews.lockRebalance },
      { name: 'lock halted', view: transferViews.lockHalted },
      { name: 'lock deal', view: transferViews.lockDeal },
      { name: 'no Spot read', view: transferViews.noSpot },
    ];
    for (const { name, view } of states) {
      await renderCard(view);
      expect(screen.queryByText(/should/i), name).toBeNull();
      expect(screen.queryByText(/recommend/i), name).toBeNull();
      expect(screen.queryByText(/best/i), name).toBeNull();
      cleanup();
    }
  });

  it('lock chip is short', async () => {
    await renderCard(transferViews.lockRebalance);

    expect(screen.getByText('Waits for the rebalance')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move money' })).toBeDisabled();
  });

  it('a moving transfer shows a Sending chip, and its button opens the modal on the sending view', async () => {
    await renderCard(transferViews.moving);

    expect(screen.getByText('Sending')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Sending 11.88 USDC' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/You can close this\./)).toBeInTheDocument();
  });

  it('done toast', async () => {
    await renderCard(transferViews.moving);
    expect(screen.getByText('Sending')).toBeInTheDocument();

    serve(transferViews.done);

    expect(await screen.findByText(DONE_TOAST, undefined, { timeout: 3_000 })).toBeInTheDocument();
  });

  it('no toast on reload', async () => {
    await renderCard(transferViews.done);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(screen.queryByText(DONE_TOAST)).toBeNull();
  });

  it('done toast waits for visible tab', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await renderCard(transferViews.moving);
    expect(screen.getByText('Sending')).toBeInTheDocument();

    serve(transferViews.done);
    await waitFor(() => expect(screen.queryByText('Sending')).toBeNull(), { timeout: 3_000 });
    expect(screen.queryByText(DONE_TOAST)).toBeNull();

    visibility.mockReturnValue('visible');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(await screen.findByText(DONE_TOAST)).toBeInTheDocument();
  });

  it('a failed transfer shows a Failed chip, and its button opens the modal on the failed view', async () => {
    await renderCard(transferViews.failedOverCap);

    expect(screen.getByText('Failed')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Failed · open' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Transfer failed.')).toBeInTheDocument();
  });

  it('failed chip survives a running rebalance', async () => {
    await renderCard(transferViews.failedAndRebalanceRunning);

    expect(screen.getByText('Failed')).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Failed · open' });
    expect(button).toBeEnabled();
    await userEvent.click(button);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Transfer failed.')).toBeInTheDocument();
  });

  it('retry id survives closing the modal', async () => {
    const posts: { id?: unknown }[] = [];
    server.use(transferPostHandler(posts, 'silent'));
    await renderCard();
    const holdTen = async () => {
      await userEvent.click(screen.getByRole('button', { name: 'Move money' }));
      const dialog = await screen.findByRole('dialog');
      await userEvent.type(within(dialog).getByRole('textbox'), '10');
      const hold = within(dialog).getByRole('button', { name: 'Hold to send 10.00 USDT to Gate spot' });
      await waitFor(() => expect(hold).toBeEnabled());
      fireEvent.pointerDown(hold);
    };

    await holdTen();
    await screen.findByText('Gate did not answer.');
    await userEvent.click(screen.getByRole('button', { name: 'close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await holdTen();

    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[0].id).toEqual(expect.any(String));
    expect(posts[1].id).toBe(posts[0].id);
  });

  it('a new pick opens the modal', async () => {
    serve();
    const picks: TransferPick[] = [
      { coin: 'USDT', wallet: 'CROSSEX', nonce: 1 },
      { coin: 'USDC', wallet: 'CROSSEX_HYPERLIQUID', nonce: 2 },
    ];
    function PickHost() {
      const [i, setI] = useState(0);
      return (
        <>
          <button type="button" onClick={() => setI((n) => Math.min(n + 1, picks.length - 1))}>
            next pick
          </button>
          <TransferSection holdMs={50} pick={picks[i]} />
        </>
      );
    }
    renderWithClient(<PickHost />);

    await screen.findByRole('dialog');
    await userEvent.click(screen.getByRole('button', { name: 'close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await userEvent.click(screen.getByRole('button', { name: 'next pick' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('radio', { name: 'Into CrossEx' })).toBeChecked();
    expect(within(dialog).getByRole('radio', { name: 'USDC · Hyperliquid' })).toBeChecked();

    await userEvent.click(within(dialog).getByRole('button', { name: 'close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await userEvent.click(screen.getByRole('button', { name: 'next pick' }));
    expect(screen.queryByRole('dialog')).toBeNull();
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

    expect(await screen.findByRole('button', { name: 'Move money' })).toBeInTheDocument();
  });
});
