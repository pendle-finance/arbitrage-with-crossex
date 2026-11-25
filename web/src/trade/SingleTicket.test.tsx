import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import type { ActionInput, DealRequest, PreviewResponse, TwapPlanView } from '../api/types';
import {
  baseHandlers,
  BTC_BINANCE,
  BTC_HYPERLIQUID,
  echoPreviewHandler,
  makeRebalanceView,
  previewFor,
  REALIZE_RUNNING_JOB,
  rebalanceHandler,
  symbolHandlers,
} from '../test/fixtures';
import { env, server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { SingleTicket } from './SingleTicket';

const btcSymbolHandlers = () => symbolHandlers([BTC_BINANCE, BTC_HYPERLIQUID]);

const bookHandler = (bestBid = 64_999.9, bestAsk = 65_000) =>
  http.get('/api/books/:symbol', ({ params }) =>
    HttpResponse.json(env({ symbol: String(params.symbol), bestBid, bestAsk, mid: (bestBid + bestAsk) / 2 })),
  );

const PLAN: TwapPlanView = {
  slices: 12,
  sliceQty: '0.002',
  lastQty: '0.004',
  intervalSec: 150,
  durationSec: 1800,
  takerAfterSec: 120,
};

function twapPreviewHandler(bodies: Array<{ actions: ActionInput[]; twap?: unknown }> = []) {
  return http.post('/api/preview', async ({ request }) => {
    const body = (await request.json()) as { actions: ActionInput[]; twap?: unknown };
    bodies.push(body);
    return HttpResponse.json(
      env<PreviewResponse>({
        previews: body.actions.map((a, i) => previewFor(a, { index: i, qty: '0.0015' })),
        priceImpact: { whole: 83, sliced: 14 },
        twap: { plan: PLAN, refusal: null },
      }),
    );
  });
}

function dealHandler(calls: DealRequest[]) {
  return http.post('/api/deals', async ({ request }) => {
    const body = (await request.json()) as DealRequest;
    calls.push(body);
    return HttpResponse.json(env({ id: body.id }), { status: 202 });
  });
}

async function pickBinanceBtc() {
  await userEvent.click(screen.getByRole('button', { name: 'BTC' }));
  await userEvent.selectOptions(await screen.findByLabelText('Long venue'), 'BINANCE_FUTURE_BTC_USDT');
  await screen.findByRole('button', { name: /^Max / }).catch(() => undefined);
}

async function pickHyperliquidBtc() {
  await userEvent.click(screen.getByRole('button', { name: 'BTC' }));
  await userEvent.selectOptions(await screen.findByLabelText('Long venue'), 'HYPERLIQUID_FUTURE_BTC_USDC');
  await userEvent.click(screen.getByRole('radio', { name: 'USDT' }));
  await screen.findByRole('button', { name: /^Max / });
}

const marketMode = () => userEvent.click(screen.getByRole('radio', { name: 'Market' }));

async function holdExecute(name: RegExp | string) {
  const button = await screen.findByRole('button', { name });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.pointerDown(button);
}

describe('SingleTicket', () => {
  it('renders preview violations and disables the action', async () => {
    server.use(
      ...baseHandlers(),
      ...btcSymbolHandlers(),
      bookHandler(),
      http.post('/api/preview', async ({ request }) => {
        const { actions } = (await request.json()) as { actions: ActionInput[] };
        return HttpResponse.json(
          env<PreviewResponse>({
            previews: [
              previewFor(actions[0], {
                qty: '',
                estNotional: 0,
                violations: [{ code: 'below-min-notional', message: 'notional 5.00 below venue min 10' }],
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
    expect(screen.getByRole('button', { name: 'Execute now' })).toBeDisabled();
  });

  it('blocks execute until the venue leverage cap loads', async () => {
    server.use(
      ...baseHandlers(),
      http.get('/api/symbols', () => HttpResponse.json(env([BTC_BINANCE]))),
      http.get('/api/symbols/:symbol', async () => {
        await new Promise(() => {});
        return HttpResponse.json(env({}));
      }),
      bookHandler(),
      echoPreviewHandler({ overrides: { qty: '0.0015' } }),
    );
    renderWithClient(<SingleTicket />);

    await pickBinanceBtc();
    await marketMode();
    await userEvent.type(screen.getByLabelText('Size'), '100');

    await screen.findByText('Loading…');
    await new Promise((r) => setTimeout(r, 250));
    expect(screen.getByRole('button', { name: 'Execute now' })).toBeDisabled();
  });

  it('Market preview shows the tentative avg fill and the partial-depth warning', async () => {
    server.use(
      ...baseHandlers(),
      ...btcSymbolHandlers(),
      bookHandler(),
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
    await marketMode();
    await userEvent.type(screen.getByLabelText('Size'), '100');

    expect(await screen.findByText(/Est\. avg fill/)).toBeInTheDocument();
    expect(screen.getByText('65010.5')).toBeInTheDocument();
    expect(screen.getByText(/Thin book/)).toBeInTheDocument();
    expect(screen.getByText('≈ 0.05 USDT')).toBeInTheDocument();
    expect(screen.getByText('Taker')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Execute now' })).toBeEnabled();
  });

  it('does not keep an action enabled off a stale preview while a size edit is estimating', async () => {
    server.use(
      ...baseHandlers(),
      ...btcSymbolHandlers(),
      bookHandler(),
      echoPreviewHandler({ overrides: { qty: '0.0015' } }),
    );
    renderWithClient(<SingleTicket />);

    await pickBinanceBtc();
    await userEvent.type(screen.getByLabelText('Size'), '100');
    const exec = screen.getByRole('button', { name: 'Execute now' });
    await waitFor(() => expect(exec).toBeEnabled());

    await userEvent.type(screen.getByLabelText('Size'), '00');
    expect(exec).toBeDisabled();
    await waitFor(() => expect(exec).toBeEnabled());
  });

  it('Limit is always post-only: the fee estimate is maker-only from the start', async () => {
    server.use(
      ...baseHandlers(),
      ...btcSymbolHandlers(),
      bookHandler(),
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
    await userEvent.type(screen.getByLabelText('Size'), '100');

    expect(await screen.findByText('≈ 0.02 USDT')).toBeInTheDocument();
    expect(screen.getByText('Maker')).toBeInTheDocument();
    expect(screen.queryByText(/maker–taker/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Limit orders are post-only/)).toBeInTheDocument();
  });

  it('snaps a typed resting BUY price DOWN and a SELL price UP (Hyperliquid)', async () => {
    const calls: ActionInput[][] = [];
    server.use(...baseHandlers(), ...btcSymbolHandlers(), bookHandler(61_717, 61_718), echoPreviewHandler({ calls }));
    renderWithClient(<SingleTicket />);

    await pickHyperliquidBtc();
    await userEvent.type(screen.getByLabelText('Size'), '100');
    await userEvent.clear(screen.getByLabelText('Limit price'));
    await userEvent.type(screen.getByLabelText('Limit price'), '61717.6');
    await waitFor(() => expect(calls.at(-1)?.[0]).toMatchObject({ kind: 'open-limit', price: '61717' }));

    await userEvent.click(screen.getByRole('radio', { name: 'Short' }));
    await waitFor(() => expect(calls.at(-1)?.[0]).toMatchObject({ kind: 'open-limit', side: 'SELL', price: '61718' }));
  });

  it('a Limit price that follows the book rests at the best bid for Long and the best ask for Short', async () => {
    const calls: ActionInput[][] = [];
    server.use(...baseHandlers(), ...btcSymbolHandlers(), bookHandler(), echoPreviewHandler({ calls }));
    renderWithClient(<SingleTicket />);

    await pickBinanceBtc();
    await userEvent.type(screen.getByLabelText('Size'), '100');
    await waitFor(() => expect(calls.at(-1)?.[0]).toMatchObject({ kind: 'open-limit', side: 'BUY', price: '64999.9' }));

    await userEvent.click(screen.getByRole('radio', { name: 'Short' }));
    await waitFor(() => expect(calls.at(-1)?.[0]).toMatchObject({ kind: 'open-limit', side: 'SELL', price: '65000' }));
  });
});

describe('no Review card on a single order', () => {
  it('hovering Execute does not open a Review card', async () => {
    server.use(...baseHandlers(), ...btcSymbolHandlers(), bookHandler(), echoPreviewHandler());
    renderWithClient(<SingleTicket />);
    await pickBinanceBtc();
    await userEvent.type(screen.getByPlaceholderText(/Size \(BTC\)/), '0.01');

    const execute = await screen.findByRole('button', { name: /Execute now/ });
    await userEvent.hover(execute);

    await waitFor(() => expect(screen.queryByText('Review')).toBeNull());
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(await screen.findByText('Trade cost')).toBeInTheDocument();
  });
});

describe('SingleTicket: the Estimate card', () => {
  const fees = { makerRate: 0.0002, takerRate: 0.0005, specialOverride: false, quote: 'USDT', est: { maker: 13.84, taker: 34.6 } };

  it('limit shows the maker trade cost, the plan line, a Book button, leverage and margin', async () => {
    server.use(...baseHandlers(), ...btcSymbolHandlers(), bookHandler(), echoPreviewHandler({ overrides: { fees, qty: '1.5' } }));
    renderWithClient(<SingleTicket />);
    await pickBinanceBtc();
    await userEvent.type(screen.getByPlaceholderText(/Size \(BTC\)/), '1.5');

    expect(await screen.findByText('≈ 13.84 USDT')).toBeInTheDocument();
    expect(screen.getByText('Trade cost')).toBeInTheDocument();
    expect(screen.getByText('Maker')).toBeInTheDocument();
    expect(screen.getByText(/Binance · rests as maker/)).toBeInTheDocument();
    expect(screen.getByText('1.5 BTC')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Book' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('Leverage')).toBeInTheDocument();
    expect(screen.getByText('Margin')).toBeInTheDocument();
    expect(screen.queryByText('Rests at')).toBeNull();
    expect(screen.queryByText('Est. fee')).toBeNull();
    expect(screen.queryByText('Margin required')).toBeNull();
  });

  it('market shows the taker trade cost and the at-market plan line', async () => {
    server.use(...baseHandlers(), ...btcSymbolHandlers(), bookHandler(), echoPreviewHandler({ overrides: { fees, qty: '1.5' } }));
    renderWithClient(<SingleTicket />);
    await pickBinanceBtc();
    await marketMode();
    await userEvent.type(screen.getByPlaceholderText(/Size \(BTC\)/), '1.5');

    expect(await screen.findByText('≈ 34.60 USDT')).toBeInTheDocument();
    expect(screen.getByText('Taker')).toBeInTheDocument();
    expect(screen.getByText(/Binance · at market/)).toBeInTheDocument();
  });
});

describe('SingleTicket: the size unit follows the coin', () => {
  it('defaults BTC to the coin, and the toggle still wins', async () => {
    server.use(...baseHandlers(), ...btcSymbolHandlers(), bookHandler(), echoPreviewHandler());
    renderWithClient(<SingleTicket />);
    await pickBinanceBtc();

    expect(await screen.findByPlaceholderText(/Size \(BTC\)/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: 'USDT' }));
    expect(screen.getByPlaceholderText(/Notional/)).toBeInTheDocument();
  });
});

describe('SingleTicket: the max size', () => {
  it('stops at the largest position CrossEx takes, even when margin allows more', async () => {
    server.use(
      http.get('/api/symbols/:symbol', () =>
        HttpResponse.json(env({ ...BTC_HYPERLIQUID, leverageMax: 50, positionMaxUsd: 100_000 })),
      ),
      ...baseHandlers(),
      ...btcSymbolHandlers(),
      bookHandler(),
      echoPreviewHandler(),
    );
    renderWithClient(<SingleTicket />);
    await pickHyperliquidBtc();

    expect(screen.getByRole('button', { name: /^Max / })).toHaveTextContent('Max $100,000');
  });
});

describe('SingleTicket with TWAP', () => {
  function setup(bodies: Array<{ actions: ActionInput[]; twap?: unknown }> = [], deals: DealRequest[] = []) {
    server.use(...baseHandlers(), ...btcSymbolHandlers(), bookHandler(), twapPreviewHandler(bodies), dealHandler(deals));
    renderWithClient(<SingleTicket />);
  }

  it('built from pair ticket parts', async () => {
    setup();
    await pickBinanceBtc();

    expect(screen.getByRole('radio', { name: 'Long' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Short' })).toBeInTheDocument();
    expect(screen.getByText('LONG')).toBeInTheDocument();
    expect(screen.getByLabelText('Long venue')).toBeInTheDocument();
    expect(screen.getByLabelText('Size')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Limit' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Market' })).toBeInTheDocument();
    expect(screen.getByLabelText('Limit price')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Size'), '100');
    expect(await screen.findByText('Trade cost')).toBeInTheDocument();
  });

  it('long short with no buy sell', async () => {
    setup();
    await pickBinanceBtc();

    expect(screen.queryByRole('radio', { name: 'Buy' })).toBeNull();
    expect(screen.queryByRole('radio', { name: 'Sell' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Mark/ })).toBeNull();
    await userEvent.click(screen.getByRole('radio', { name: 'Short' }));
    expect(screen.getByText('SHORT')).toBeInTheDocument();
  });

  it('twap switch only on limit', async () => {
    setup();
    await pickBinanceBtc();
    expect(screen.getByRole('switch', { name: 'TWAP' })).toBeInTheDocument();

    await marketMode();
    expect(screen.queryByRole('switch', { name: 'TWAP' })).toBeNull();

    await userEvent.click(screen.getByRole('radio', { name: 'Limit' }));
    expect(screen.getByRole('switch', { name: 'TWAP' })).toBeInTheDocument();
  });

  it('twap off keeps post-only limit', async () => {
    const deals: DealRequest[] = [];
    setup([], deals);
    await pickBinanceBtc();
    await userEvent.type(screen.getByLabelText('Size'), '100');

    await holdExecute('Execute now');
    await waitFor(() => expect(deals).toHaveLength(1), { timeout: 4_000 });

    expect(deals[0]).toMatchObject({ execution: 'maker', price: '64999.9', pricePolicy: 'fixed' });
    expect(deals[0]).not.toHaveProperty('timeoutSec');
  });

  it('no maker settings with twap off', async () => {
    setup();
    await pickBinanceBtc();

    expect(screen.queryByText('Maker settings')).toBeNull();
  });

  it('twap on hides type and price', async () => {
    setup();
    await pickBinanceBtc();
    await userEvent.click(screen.getByRole('switch', { name: 'TWAP' }));

    expect(screen.queryByRole('radio', { name: 'Limit' })).toBeNull();
    expect(screen.queryByRole('radio', { name: 'Market' })).toBeNull();
    expect(screen.queryByLabelText('Limit price')).toBeNull();
  });

  it('single fold row', async () => {
    const bodies: Array<{ actions: ActionInput[]; twap?: unknown }> = [];
    setup(bodies);
    await pickBinanceBtc();
    await userEvent.type(screen.getByLabelText('Size'), '100');
    await userEvent.click(screen.getByRole('switch', { name: 'TWAP' }));
    await userEvent.clear(screen.getByLabelText('Duration'));
    await userEvent.type(screen.getByLabelText('Duration'), '30m');
    await userEvent.clear(screen.getByLabelText('Interval'));
    await userEvent.type(screen.getByLabelText('Interval'), '2m 30s');

    expect(await screen.findByText('Taker 2m · re-peg 0.05%')).toBeInTheDocument();
    expect(screen.getByText('Maker settings')).toBeInTheDocument();
    await waitFor(() => expect(bodies.some((b) => b.twap !== undefined)).toBe(true));
  });

  it('unhedged note stays with twap', async () => {
    setup();
    await pickBinanceBtc();
    await userEvent.type(screen.getByLabelText('Size'), '100');
    await userEvent.click(screen.getByRole('switch', { name: 'TWAP' }));

    expect(await screen.findByRole('button', { name: /Start TWAP/ })).toBeInTheDocument();
    expect(screen.getByText('This leg is not hedged.')).toBeInTheDocument();
  });

  it('locked while a twap runs', async () => {
    server.use(
      rebalanceHandler(
        makeRebalanceView({
          job: {
            ...REALIZE_RUNNING_JOB,
            kind: 'twap',
            status: 'running',
            paused: false,
            child: null,
            twap: {
              slice: 3,
              of: 12,
              nextAt: null,
              durationSec: 3600,
              intervalSec: 300,
              startedAt: 0,
              carryQty: '0',
              behindQty: '0',
              makerLeg: 'a',
              repegBehindBp: 5,
              takerAfterSec: 240,
            },
          },
        }),
      ),
      ...baseHandlers(),
      ...btcSymbolHandlers(),
      bookHandler(),
      echoPreviewHandler(),
    );
    renderWithClient(<SingleTicket />);
    await pickBinanceBtc();
    await userEvent.type(screen.getByLabelText('Size'), '100');

    expect(await screen.findByText('A TWAP is running. Orders and transfers wait until it ends.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Execute now' })).toBeNull();
  });
});

describe('SingleTicket TWAP under the venue minimum', () => {
  function zeroSizeHandler() {
    return http.post('/api/preview', async ({ request }) => {
      const { actions } = (await request.json()) as { actions: ActionInput[] };
      return HttpResponse.json(
        env<PreviewResponse>({
          previews: [
            previewFor(actions[0], {
              qty: '0',
              estNotional: 0,
              rule: { ...BTC_BINANCE, minSize: '0.001', lotSize: '0.001' },
              violations: [{ code: 'qty-invalid', message: 'size rounds down to zero' }],
            }),
          ],
          twap: { plan: null, refusal: null },
        }),
      );
    });
  }

  async function open() {
    server.use(...baseHandlers(), ...btcSymbolHandlers(), bookHandler(), zeroSizeHandler());
    renderWithClient(<SingleTicket />);
    await pickBinanceBtc();
    await userEvent.click(screen.getByRole('switch', { name: 'TWAP' }));
    await userEvent.type(screen.getByLabelText('Size'), '1');
  }

  it('names the venue minimum a slice instead of rounds down to zero', async () => {
    await open();
    expect(await screen.findByText('Binance takes at least 0.001 BTC ($3) a slice.')).toBeInTheDocument();
    expect(screen.queryByText(/rounds down to zero/)).toBeNull();
  });

  it('keeps Start TWAP off with a reason on screen when the slice size is empty', async () => {
    await open();
    await screen.findByText('Binance takes at least 0.001 BTC ($3) a slice.');
    expect(screen.getByLabelText('Slice size')).toHaveValue('');
    expect(screen.getByRole('button', { name: /Start TWAP/ })).toBeDisabled();
  });

  it('never offers one deal while TWAP is on', async () => {
    await open();
    await screen.findByText('Binance takes at least 0.001 BTC ($3) a slice.');
    expect(screen.queryByText("Can't send as one deal. Send each leg on its own.")).toBeNull();
  });
});
