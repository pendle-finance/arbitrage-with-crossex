import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import type { ActionInput, PreviewResponse } from '../api/types';
import {
  baseHandlers,
  BTC_BINANCE,
  BTC_HYPERLIQUID,
  echoPreviewHandler,
  previewFor,
  symbolHandlers,
} from '../test/fixtures';
import { env, server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { SingleTicket } from './SingleTicket';

const btcSymbolHandlers = () => symbolHandlers([BTC_BINANCE, BTC_HYPERLIQUID]);

/** Type BTC into the combobox and pick the BINANCE venue chip. */
async function pickBinanceBtc() {
  await userEvent.type(screen.getByLabelText('Symbol search'), 'BTC');
  await userEvent.click(await screen.findByRole('button', { name: 'BINANCE' }));
}

/** Type BTC into the combobox and pick the HYPERLIQUID venue chip, then wait
 * for the symbol detail (tick size + leverage cap) so the blur snap has a tick. */
async function pickHyperliquidBtc() {
  await userEvent.type(screen.getByLabelText('Symbol search'), 'BTC');
  // The chip's accessible name includes the non-USDT quote note ("USDC").
  await userEvent.click(await screen.findByRole('button', { name: /HYPERLIQUID/ }));
  await screen.findByText('50x (venue max)');
}

describe('SingleTicket', () => {
  it('renders preview violations and disables both actions', async () => {
    server.use(
      ...baseHandlers(),
      ...btcSymbolHandlers(),
      http.post('/api/preview', async ({ request }) => {
        const { actions } = (await request.json()) as { actions: ActionInput[] };
        return HttpResponse.json(
          env<PreviewResponse>({
            previews: [
              previewFor(actions[0], {
                qty: '',
                estNotional: 0,
                violations: [
                  { code: 'below-min-notional', message: 'notional 5.00 below venue min 10' },
                ],
              }),
            ],
          }),
        );
      }),
    );
    renderWithClient(<SingleTicket />);

    await pickBinanceBtc();
    await userEvent.type(screen.getByLabelText('Size'), '5');

    expect(await screen.findByText(/below venue min 10/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Execute now ▸' })).toBeDisabled();
  });

  it('blocks execute until the venue leverage cap loads (never silently omits leverage)', async () => {
    server.use(
      ...baseHandlers(),
      http.get('/api/symbols', () => HttpResponse.json(env([BTC_BINANCE]))),
      // The symbol DETAIL (leverage cap) never resolves → levMax stays 0.
      http.get('/api/symbols/:symbol', async () => {
        await new Promise(() => {});
        return HttpResponse.json(env({}));
      }),
      http.post('/api/preview', async ({ request }) => {
        const { actions } = (await request.json()) as { actions: ActionInput[] };
        return HttpResponse.json(env<PreviewResponse>({ previews: [previewFor(actions[0], { qty: '0.0015' })] }));
      }),
    );
    renderWithClient(<SingleTicket />);

    await pickBinanceBtc();
    await userEvent.type(screen.getByLabelText('Size'), '100');

    // The preview can settle, but with the venue max unknown the promise "venue
    // max" can't be honored — execute stays disabled and the row says loading.
    await screen.findByText('loading…');
    await new Promise((r) => setTimeout(r, 250));
    expect(screen.getByRole('button', { name: 'Execute now ▸' })).toBeDisabled();
  });

  it('MARKET preview shows the tentative avg fill and the partial-depth warning', async () => {
    server.use(
      ...baseHandlers(),
      ...btcSymbolHandlers(),
      http.post('/api/preview', async ({ request }) => {
        const { actions } = (await request.json()) as { actions: ActionInput[] };
        return HttpResponse.json(
          env<PreviewResponse>({
            previews: [
              previewFor(actions[0], {
                qty: '0.0015',
                estNotional: 97.51,
                refPrice: { value: 65000, source: 'mark' },
                fillEstimate: {
                  qty: '0.0015',
                  avgPrice: 65010.5,
                  worstPrice: 65022,
                  midPrice: 65000,
                  slippagePct: 0.016,
                  source: 'venue-orderbook',
                  confidence: 'high',
                  venue: 'BINANCE',
                  partialDepth: true,
                },
                fees: {
                  makerRate: 0.0002,
                  takerRate: 0.0005,
                  specialOverride: false,
                  quote: 'USDT',
                  est: { taker: 0.0488 },
                },
              }),
            ],
          }),
        );
      }),
    );
    renderWithClient(<SingleTicket />);

    await pickBinanceBtc();
    await userEvent.type(screen.getByLabelText('Size'), '100');

    expect(await screen.findByText(/Tentative avg fill/)).toBeInTheDocument();
    expect(screen.getByText('65010.5')).toBeInTheDocument();
    expect(screen.getByText('partial depth — estimate extrapolated')).toBeInTheDocument();
    // Taker fee with bps, and actions enabled (no violations).
    expect(screen.getByText(/0\.0488 USDT \(taker, 5\.0 bps\)/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Execute now ▸' })).toBeEnabled();
  });

  it('does not keep an action enabled off a stale preview while a size edit is estimating', async () => {
    server.use(
      ...baseHandlers(),
      ...btcSymbolHandlers(),
      echoPreviewHandler({ overrides: { qty: '0.0015' } }),
    );
    renderWithClient(<SingleTicket />);

    await pickBinanceBtc();
    await userEvent.type(screen.getByLabelText('Size'), '100');
    const exec = screen.getByRole('button', { name: 'Execute now ▸' });
    await waitFor(() => expect(exec).toBeEnabled());

    // Edit the size — the debounced preview still describes the OLD "100" input,
    // so the action must NOT stay enabled off that stale estimate.
    await userEvent.type(screen.getByLabelText('Size'), '00'); // → "10000"
    expect(exec).toBeDisabled();

    // Once the new preview settles (no violations), it re-enables.
    await waitFor(() => expect(exec).toBeEnabled());
  });

  it('LIMIT is always post-only (POC): the fee estimate is maker-only from the start', async () => {
    server.use(
      ...baseHandlers(),
      ...btcSymbolHandlers(),
      http.post('/api/preview', async ({ request }) => {
        const { actions } = (await request.json()) as { actions: ActionInput[] };
        const a = actions[0];
        const poc = a.kind === 'open-limit' && a.tif === 'POC';
        return HttpResponse.json(
          env<PreviewResponse>({
            previews: [
              previewFor(a, {
                type: 'LIMIT',
                tif: poc ? 'POC' : 'GTC',
                price: a.kind === 'open-limit' ? a.price : undefined,
                qty: '0.0015',
                fees: {
                  makerRate: 0.0002,
                  takerRate: 0.0005,
                  specialOverride: false,
                  quote: 'USDT',
                  est: poc ? { maker: 0.0195 } : { maker: 0.0195, taker: 0.0488 },
                },
              }),
            ],
          }),
        );
      }),
    );
    renderWithClient(<SingleTicket />);

    await pickBinanceBtc();
    await userEvent.click(screen.getByRole('radio', { name: 'LIMIT' }));
    await userEvent.type(screen.getByLabelText('Size'), '100');
    await userEvent.type(screen.getByLabelText('Limit price'), '65000');

    // The engine rests every limit post-only — the ticket declares tif POC
    // up front, so the estimate is maker-only and no range is ever shown.
    expect(await screen.findByText(/maker-only/)).toBeInTheDocument();
    expect(screen.queryByText(/maker–taker/)).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /post-only/ })).not.toBeInTheDocument();
    expect(screen.getByText(/limits rest post-only/)).toBeInTheDocument();
  });

  it('blur-snaps a resting BUY price DOWN, never up onto the ask (Hyperliquid)', async () => {
    // Pre-fix failure: the on-blur snap used the NEAREST-mode formatLimitPrice,
    // whose Hyperliquid 5-sig-fig cap turned 61717.6 into 61718. With HL BTC at
    // bid 61717 / ask 61718 (tick 0.1) that is EXACTLY the ask, so the ticket's
    // always-POC limit was insta-rejected by the venue as would-cross — and the
    // server's directional formatRestPrice (commit 54964fe) was a no-op on the
    // already-valid tick multiple, so no "price adjusted" warning ever fired.
    server.use(...baseHandlers(), ...btcSymbolHandlers(), echoPreviewHandler());
    renderWithClient(<SingleTicket />);

    await pickHyperliquidBtc();
    await userEvent.click(screen.getByRole('radio', { name: 'LIMIT' }));
    const price = screen.getByLabelText('Limit price');
    await userEvent.type(price, '61717.6');
    await userEvent.tab();

    expect(price).toHaveValue('61717');
    expect(screen.getByText('adjusted to venue tick/precision rules')).toBeInTheDocument();
  });

  it('blur-snaps a resting SELL price UP, never down onto the bid (Hyperliquid)', async () => {
    server.use(...baseHandlers(), ...btcSymbolHandlers(), echoPreviewHandler());
    renderWithClient(<SingleTicket />);

    await pickHyperliquidBtc();
    await userEvent.click(screen.getByRole('radio', { name: 'SELL' }));
    await userEvent.click(screen.getByRole('radio', { name: 'LIMIT' }));
    const price = screen.getByLabelText('Limit price');
    await userEvent.type(price, '61717.4');
    await userEvent.tab();

    // Mirror of the BUY case: a resting SELL must stay at/above what was typed.
    expect(price).toHaveValue('61718');
  });

  it('re-snaps from the typed price when the side flips after a snap', async () => {
    // The directional snap is lossy: after the BUY blur the field holds 61717,
    // and re-snapping THAT for SELL would be a no-op (it is a valid tick
    // multiple) — leaving a resting SELL on the bid. The ticket must remember
    // the raw typed 61717.6 and re-snap it for the new side.
    server.use(...baseHandlers(), ...btcSymbolHandlers(), echoPreviewHandler());
    renderWithClient(<SingleTicket />);

    await pickHyperliquidBtc();
    await userEvent.click(screen.getByRole('radio', { name: 'LIMIT' }));
    const price = screen.getByLabelText('Limit price');
    await userEvent.type(price, '61717.6');
    await userEvent.tab();
    expect(price).toHaveValue('61717'); // floored for the resting BUY

    await userEvent.click(screen.getByRole('radio', { name: 'SELL' }));
    expect(price).toHaveValue('61718'); // re-ceiled from the raw 61717.6
  });
});

describe('no Review card on a single order', () => {
  // The ticket already shows ref price, fill estimate, fees and violations
  // directly above the button, so hovering Execute popped a floating copy of
  // what was already on screen.
  it('hovering Execute does not open a Review card', async () => {
    server.use(...baseHandlers(), ...btcSymbolHandlers(), echoPreviewHandler());
    renderWithClient(<SingleTicket />);
    await pickBinanceBtc();
    // BTC is coin-margined on Boros, so the box defaults to the coin — the
    // same rule the pair ticket follows, so one strategy is sized in one unit.
    await userEvent.type(screen.getByPlaceholderText(/qty \(BTC\)/), '0.01');

    const execute = await screen.findByRole('button', { name: /Execute now/ });
    await userEvent.hover(execute);

    // The card is a portalled tooltip titled "Review".
    await waitFor(() => expect(screen.queryByText('Review')).toBeNull());
    expect(screen.queryByRole('tooltip')).toBeNull();
    // The inline preview is still there — nothing was lost by removing it.
    expect(await screen.findByText(/est fee/)).toBeInTheDocument();
  });
});

describe('SingleTicket — the size unit follows the coin', () => {
  it('defaults BTC to the coin, and the toggle still wins', async () => {
    /**
     * Same rule as the pair ticket (`sizeUnitForBase`): BTC/ETH are
     * coin-margined on Boros, so sizing the perp in the coin makes the hedge
     * exact instead of an eyeballed FX step. The Single ticket used to
     * hardcode USDT regardless of coin.
     */
    server.use(...baseHandlers(), ...btcSymbolHandlers(), echoPreviewHandler());
    renderWithClient(<SingleTicket />);
    await pickBinanceBtc();

    expect(await screen.findByPlaceholderText(/qty \(BTC\)/)).toBeInTheDocument();
    // An explicit choice still overrides the default.
    await userEvent.click(screen.getByRole('radio', { name: 'USDT' }));
    expect(screen.getByPlaceholderText(/notional/)).toBeInTheDocument();
  });
});
