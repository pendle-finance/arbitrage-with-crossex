import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionInput, DealRequest, PreviewResponse } from '../api/types';
import { baseHandlers, ethPosition, previewFor } from '../test/fixtures';
import { env, server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { ClosePopover } from './ClosePopover';

function closePreviewHandler() {
  return http.post('/api/preview', async ({ request }) => {
    const { actions } = (await request.json()) as { actions: ActionInput[] };
    const a = actions[0];
    return HttpResponse.json(
      env<PreviewResponse>({
        previews: [
          previewFor(a, {
            side: 'SELL',
            type: 'LIMIT',
            tif: 'IOC',
            reduceOnly: true,
            qty: a.kind === 'close-position' && a.qty ? a.qty : '0.3',
            price: '2497.45',
            estNotional: 753,
            closing: { positionQty: '0.3', upnl: '3', mark: 2510 },
            fees: {
              makerRate: 0.0002,
              takerRate: 0.0005,
              specialOverride: false,
              quote: 'USDT',
              est: { taker: 0.3765 },
            },
          }),
        ],
      }),
    );
  });
}

describe('ClosePopover', () => {
  const viewportHeight = window.innerHeight;
  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(window, 'innerHeight', { value: viewportHeight, configurable: true });
  });

  it('opens on this position\'s own size when the venue leg is shared', async () => {
    // The venue holds 0.3; this strategy owns 0.1. A close acts on the whole
    // position, so the popover must not default to closing someone else's.
    server.use(...baseHandlers(), closePreviewHandler());
    renderWithClient(
      <ClosePopover
        position={ethPosition}
        attributedQty={0.1}
       
        onDismiss={() => {}}
      />,
    );
    expect(await screen.findByRole('radio', { name: /partial/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByLabelText('Close qty')).toHaveValue('0.1');
    expect(screen.getByText(/holds 0.1 of the 0.3 on the venue/)).toBeInTheDocument();

    // Switching to full spells out whose size goes with it.
    fireEvent.click(screen.getByRole('radio', { name: /full/ }));
    expect(screen.getByText(/including the 0.2 that belongs to your other position/)).toBeInTheDocument();
  });

  it('leaves an unshared position on full', async () => {
    server.use(...baseHandlers(), closePreviewHandler());
    renderWithClient(<ClosePopover position={ethPosition} onDismiss={() => {}} />);
    expect(await screen.findByRole('radio', { name: /full/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.queryByText(/belongs to your other position/)).not.toBeInTheDocument();
  });

  it('previews a full close (marketable limit px + uPnL) with the reduce-only note', async () => {
    server.use(...baseHandlers(), closePreviewHandler());
    renderWithClient(<ClosePopover position={ethPosition} onDismiss={() => {}} />);

    expect(await screen.findByText(/marketable limit px/)).toBeInTheDocument();
    expect(screen.getByText('2497.45')).toBeInTheDocument();
    expect(screen.getByText(/reduce-only IOC marketable limit/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close now ▸' })).toBeEnabled();
  });

  it('partial qty above the position shows an inline error and disables Close', async () => {
    server.use(...baseHandlers(), closePreviewHandler());
    renderWithClient(<ClosePopover position={ethPosition} onDismiss={() => {}} />);
    await screen.findByText(/marketable limit px/);

    await userEvent.click(screen.getByRole('radio', { name: 'partial' }));
    await userEvent.type(screen.getByLabelText('Close qty'), '0.5'); // position is 0.3

    expect(await screen.findByText(/close qty exceeds position \(0\.3\)/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close now ▸' })).toBeDisabled();
  });

  it('holding "Close now" POSTs a reduce-only banded close deal (no review modal)', async () => {
    const dealCalls: DealRequest[] = [];
    server.use(
      ...baseHandlers(),
      closePreviewHandler(),
      http.post('/api/deals', async ({ request }) => {
        dealCalls.push((await request.json()) as DealRequest);
        return HttpResponse.json(env({ id: dealCalls[0].id }), { status: 202 });
      }),
    );
    renderWithClient(<ClosePopover position={ethPosition} onDismiss={() => {}} />);

    const btn = await screen.findByRole('button', { name: 'Close now ▸' });
    await waitFor(() => expect(btn).toBeEnabled());
    fireEvent.pointerDown(btn);
    await waitFor(() => expect(dealCalls).toHaveLength(1), { timeout: 2_000 });
    // The deal maps the RESOLVER's close (side/qty from the live position via
    // the preview) with the protection band carried as clipBandPct.
    expect(dealCalls[0]).toMatchObject({
      a: { symbol: 'GATE_FUTURE_ETH_USDT', side: 'SELL', reduceOnly: true },
      execution: 'taker',
      clipBandPct: 0.5,
    });
    expect(dealCalls[0].b ?? null).toBeNull();
  });

  it('hovering "Close now" opens no review card — the preview box above already reviews it', async () => {
    server.use(...baseHandlers(), closePreviewHandler());
    renderWithClient(<ClosePopover position={ethPosition} onDismiss={() => {}} />);

    const btn = await screen.findByRole('button', { name: 'Close now ▸' });
    await waitFor(() => expect(btn).toBeEnabled());
    await userEvent.hover(btn);

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('an execution error still surfaces even with the hover card suppressed', async () => {
    server.use(
      ...baseHandlers(),
      closePreviewHandler(),
      http.post('/api/deals', () =>
        HttpResponse.json(
          { ok: false, error: { category: 'exchange', message: 'venue rejected the close', retryable: true } },
          { status: 500 },
        ),
      ),
    );
    renderWithClient(<ClosePopover position={ethPosition} onDismiss={() => {}} />);

    const btn = await screen.findByRole('button', { name: 'Close now ▸' });
    await waitFor(() => expect(btn).toBeEnabled());
    fireEvent.pointerDown(btn);

    // Errors must never be silent: they force the card open regardless.
    expect(await screen.findByRole('alert', {}, { timeout: 3_000 })).toHaveTextContent(
      /venue rejected the close/,
    );
  });
});
