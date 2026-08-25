import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionInput, CrossexPosition, DealRequest, PreviewResponse } from '../api/types';
import { sig } from '../lib/fmt';
import { baseHandlers, ethPosition, makeCrossexPosition, previewFor } from '../test/fixtures';
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

    // ETH is coin-margined, so the box defaults to the coin and the error
    // names the limit in that unit.
    expect(await screen.findByText(/close size exceeds position \(0\.3 ETH\)/)).toBeInTheDocument();
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

  /**
   * A venue position NETS, so a card that states an absolute share of a shared
   * leg has to hear about its own close — otherwise the row goes on claiming
   * the same size out of a smaller leg, taking it from whoever shares it. The
   * card looked untouched by its own close: only the denominator moved.
   */
  describe('reporting what it closed', () => {
    const executed = async () => {
      const btn = await screen.findByRole('button', { name: 'Close now ▸' });
      await waitFor(() => expect(btn).toBeEnabled());
      fireEvent.pointerDown(btn);
    };
    const dealsOk = () =>
      http.post('/api/deals', async ({ request }) =>
        HttpResponse.json(env({ id: ((await request.json()) as DealRequest).id }), { status: 202 }),
      );

    it('reports this position\'s own size on a partial close', async () => {
      const closed: number[] = [];
      server.use(...baseHandlers(), closePreviewHandler(), dealsOk());
      // The venue holds 0.3, this card owns 0.1 — so partial is pre-selected
      // at 0.1 and that is what leaves this card.
      renderWithClient(
        <ClosePopover
          position={ethPosition}
          attributedQty={0.1}
          onClosed={(q) => closed.push(q)}
          onDismiss={() => {}}
        />,
      );
      await executed();
      await waitFor(() => expect(closed).toEqual([0.1]));
    });

    it('reports the WHOLE venue size on a full close, however little the card owns', async () => {
      // Full takes the other position's 0.2 with it. This card's claim cannot
      // survive that, whatever number it stated.
      const closed: number[] = [];
      server.use(...baseHandlers(), closePreviewHandler(), dealsOk());
      renderWithClient(
        <ClosePopover
          position={ethPosition}
          attributedQty={0.1}
          onClosed={(q) => closed.push(q)}
          onDismiss={() => {}}
        />,
      );
      fireEvent.click(await screen.findByRole('radio', { name: /full/ }));
      await executed();
      await waitFor(() => expect(closed).toEqual([0.3]));
    });

    it('says nothing until the deal is accepted', async () => {
      // A 500 is not a close. Shrinking the claim on the attempt would hand
      // size away that is still very much open.
      const closed: number[] = [];
      server.use(
        ...baseHandlers(),
        closePreviewHandler(),
        http.post('/api/deals', () =>
          HttpResponse.json(
            {
              ok: false,
              error: { category: 'exchange', message: 'venue rejected the close', retryable: true },
            },
            { status: 500 },
          ),
        ),
      );
      renderWithClient(
        <ClosePopover
          position={ethPosition}
          attributedQty={0.1}
          onClosed={(q) => closed.push(q)}
          onDismiss={() => {}}
        />,
      );
      await executed();
      // The rejection surfaces…
      expect(await screen.findByRole('alert', {}, { timeout: 3_000 })).toHaveTextContent(
        /venue rejected the close/,
      );
      // …and the claim is untouched: that size is still very much open.
      expect(closed).toEqual([]);
    });
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

describe('ClosePopover — sizing a close in dollars', () => {
  /**
   * A HYPE position's Boros leg is USDT-collateral and reads $100, so closing
   * it in coin units meant converting by eye on the very leg where a slip
   * leaves a naked remainder. The unit follows the same rule as the tickets.
   */
  const hypePosition = makeCrossexPosition({
    symbol: 'BYBIT_FUTURE_HYPE_USDT',
    positionQty: '1.89',
    markPrice: '80',
    entryPrice: '78',
  });

  it('defaults a non-coin-margined position to USDT and converts at the mark', async () => {
    server.use(...baseHandlers(), closePreviewHandler());
    renderWithClient(<ClosePopover position={hypePosition} onDismiss={() => {}} />);
    await screen.findByText(/marketable limit px/);

    await userEvent.click(screen.getByRole('radio', { name: 'partial' }));
    // Dollars, not coins — the box says so.
    const box = screen.getByLabelText('Close value');
    await userEvent.type(box, '50');

    // 50 USDT at mark 80 = 0.625 HYPE, and the converted figure is SHOWN
    // rather than left to be inferred. (The shared preview fixture answers
    // with an ETH-sized position, so the button's own enablement is covered by
    // the ETH cases above; what matters here is the unit and the conversion.)
    expect(await screen.findByText(/0\.625/)).toBeInTheDocument();
    expect(screen.getByText(/at mark/)).toBeInTheDocument();
  });

  it('validates a USD entry against the position VALUE, not its quantity', async () => {
    // 1.89 @ 80 = $151.20. A $200 close must be refused; without converting
    // first, 200 > 1.89 would be refused for the wrong reason and $1 would be
    // wrongly ACCEPTED as if it were 1 coin.
    server.use(...baseHandlers(), closePreviewHandler());
    renderWithClient(<ClosePopover position={hypePosition} onDismiss={() => {}} />);
    await screen.findByText(/marketable limit px/);

    await userEvent.click(screen.getByRole('radio', { name: 'partial' }));
    await userEvent.type(screen.getByLabelText('Close value'), '200');
    expect(await screen.findByText(/close size exceeds position/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close now ▸' })).toBeDisabled();
  });

  it('falls back to COIN units when the mark is unusable — never sends dollars as qty', async () => {
    /**
     * The unit default is 'usd' for every non-ETH/BTC coin, and the toggle was
     * the only thing gated on having a mark. A position whose markPrice is
     * empty/zero therefore sat in 'usd' with no way out, and the conversion
     * fell through to the raw entry — a "$50" close would have sent 50 HYPE.
     */
    server.use(...baseHandlers(), closePreviewHandler());
    renderWithClient(
      <ClosePopover position={makeCrossexPosition({ ...hypePosition, markPrice: '0' })} onDismiss={() => {}} />,
    );
    await screen.findByText(/marketable limit px/);
    await userEvent.click(screen.getByRole('radio', { name: 'partial' }));

    // Coin units, and the USD toggle is not offered at all.
    expect(screen.getByLabelText('Close qty')).toBeInTheDocument();
    expect(screen.queryByLabelText('Close value')).not.toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'Close size unit' })).not.toBeInTheDocument();
    // And the limit is stated in coins, so 2 (> 1.89) is refused.
    await userEvent.type(screen.getByLabelText('Close qty'), '2');
    expect(await screen.findByText(/close size exceeds position \(1\.89 HYPE\)/)).toBeInTheDocument();
  });

  it('keeps the SIZE when the unit is toggled, not the digits', async () => {
    // Relabelling 0.63 as $0.63 would silently resize the close by the mark.
    server.use(...baseHandlers(), closePreviewHandler());
    renderWithClient(<ClosePopover position={hypePosition} onDismiss={() => {}} />);
    await screen.findByText(/marketable limit px/);

    await userEvent.click(screen.getByRole('radio', { name: 'partial' }));
    await userEvent.type(screen.getByLabelText('Close value'), '80');
    await userEvent.click(screen.getByRole('radio', { name: 'HYPE' }));
    // $80 at mark 80 is 1 HYPE.
    expect(screen.getByLabelText('Close qty')).toHaveValue('1');
  });
});

describe('ClosePopover — closing one side of a hedge', () => {
  it('warns that the far leg is left unhedged, and stays silent when there is none', async () => {
    /**
     * A delta-neutral pair earns because the two floating legs cancel. Closing
     * one end leaves the other running as a directional funding bet the user
     * did not choose to put on — and the row-level Close said nothing about
     * that (only the card-level "Close perp pair" is self-describing).
     */
    server.use(...baseHandlers(), closePreviewHandler());
    const { unmount } = renderWithClient(
      <ClosePopover
        position={ethPosition}
        hedgedSibling={{ venue: 'HYPERLIQUID', side: 'SHORT' }}
        onDismiss={() => {}}
      />,
    );
    expect(await screen.findByText(/Closing it leaves that one unhedged/)).toBeInTheDocument();
    expect(screen.getByText(/Hyperliquid short/)).toBeInTheDocument();
    unmount();

    // No sibling (an unpaired leg) ⇒ nothing to un-hedge, so no noise.
    renderWithClient(<ClosePopover position={ethPosition} onDismiss={() => {}} />);
    await screen.findByText(/marketable limit px/);
    expect(screen.queryByText(/leaves that one unhedged/)).not.toBeInTheDocument();
  });
});

describe('ClosePopover — the conversion mark is latched at open', () => {
  const hype = makeCrossexPosition({
    symbol: 'BYBIT_FUTURE_HYPE_USDT',
    positionQty: '1.89',
    markPrice: '80',
    entryPrice: '78',
  });

  /** Simulates the 4s positions poll delivering a refreshed position whose
   * mark has turned unusable while the dialog is up. */
  function MarkFlipHarness() {
    const [pos, setPos] = useState<CrossexPosition>(hype);
    return (
      <>
        <button type="button" onClick={() => setPos(makeCrossexPosition({ ...hype, markPrice: '0' }))}>
          break-mark
        </button>
        <ClosePopover position={pos} onDismiss={() => {}} />
      </>
    );
  }

  it('a mark that breaks mid-dialog does NOT relabel the typed USD figure', async () => {
    /**
     * `effUnit` used to re-derive from the LIVE markPrice each render while
     * the typed digits persisted — a mark arriving as ''/'0' mid-edit flipped
     * the unit to 'base' and re-read "$50" as 50 HYPE (~40× the close), with
     * only the label quietly changing. The mark is latched at open now.
     */
    server.use(...baseHandlers(), closePreviewHandler());
    renderWithClient(<MarkFlipHarness />);
    await screen.findByText(/marketable limit px/);

    await userEvent.click(screen.getByRole('radio', { name: 'partial' }));
    await userEvent.type(screen.getByLabelText('Close value'), '50');
    await userEvent.click(screen.getByRole('button', { name: 'break-mark' }));

    // Still a DOLLAR box, still converting at the mark the dialog opened with.
    expect(screen.getByLabelText('Close value')).toHaveValue('50');
    expect(screen.queryByLabelText('Close qty')).not.toBeInTheDocument();
    expect(await screen.findByText(/0\.625/)).toBeInTheDocument();
  });

  it('accepts the USD maximum the dialog itself displays', async () => {
    /**
     * The max is DISPLAYED via sig() (round-to-nearest) but was validated by
     * exact conversion: whenever sig rounded up, typing the placeholder's own
     * figure converted to a hair above posQty and was refused by an error
     * naming the very number it rejected. Within rounding distance the entry
     * is accepted and the wire qty is clamped to the position.
     */
    server.use(...baseHandlers(), closePreviewHandler());
    renderWithClient(
      <ClosePopover position={makeCrossexPosition({ ...hype, markPrice: '80.001' })} onDismiss={() => {}} />,
    );
    await screen.findByText(/marketable limit px/);
    await userEvent.click(screen.getByRole('radio', { name: 'partial' }));

    // The placeholder's own stated max: sig(1.89 × 80.001) rounds UP.
    const max = sig(1.89 * 80.001);
    await userEvent.type(screen.getByLabelText('Close value'), max);

    expect(screen.queryByText(/close size exceeds position/)).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close now ▸' })).toBeEnabled());
  });
});
