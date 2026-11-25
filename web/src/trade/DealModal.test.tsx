import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import type { ActionInput, DealOrder } from '../api/types';
import { baseHandlers, makeDealView, previewFor } from '../test/fixtures';
import { env, server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { DealModal } from './DealModal';
import { TradeFlowProvider } from './TradeFlow';

/** One filled order row — the report reads leg roles off these. */
const dealOrder = (leg: 'A' | 'B', kind: 'maker' | 'taker'): DealOrder => ({
  pairId: 'd1',
  leg,
  seq: 1,
  clientId: `c-${leg}`,
  kind,
  side: leg === 'A' ? 'BUY' : 'SELL',
  qty: '0.05',
  price: kind === 'maker' ? '2500' : null,
  tif: kind === 'maker' ? 'poc' : 'ioc',
  state: 'CLOSED',
  venueOrderId: `v-${leg}`,
  cumQty: '0.05',
  closeReason: 'filled',
  cancelRequested: 0,
  quarantinedStatus: null,
  venueReason: null,
  createdAt: 1_751_500_000_000,
  resolvedAt: 1_751_500_001_000,
});

function renderModal(view = makeDealView()) {
  server.use(
    // Specific view FIRST — msw matches in order, and baseHandlers carries a
    // default /api/deals/:id that would otherwise shadow it.
    http.get('/api/deals/:id', () => HttpResponse.json(env(view))),
    ...baseHandlers(),
  );
  return renderWithClient(
    <TradeFlowProvider>
      <DealModal dealId={view.pair.id} onClose={() => {}} />
    </TradeFlowProvider>,
  );
}

describe('DealModal', () => {
  it('a failed book read shows a failed state, not Loading', async () => {
    const view = makeDealView({ pair: { mode: 'OPENING', deadlineAt: null } });
    server.use(
      http.get('/api/deals/:id', () => HttpResponse.json(env(view))),
      http.get('/api/books/:symbol', () => HttpResponse.json({ ok: false, error: { message: 'down' } }, { status: 500 })),
      ...baseHandlers(),
    );
    renderWithClient(
      <TradeFlowProvider>
        <DealModal dealId={view.pair.id} onClose={() => {}} />
      </TradeFlowProvider>,
    );
    expect(await screen.findByText("Can't read the venue books.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('the deal window shows a progress bar and boxed side chips', async () => {
    renderModal(makeDealView({ pair: { mode: 'OPENING', deadlineAt: null } }));
    expect(await screen.findByRole('progressbar')).toBeInTheDocument();
    expect(screen.getByText('Short').className).toContain('chip');
  });

  it('first line with the market countdown', async () => {
    renderModal(makeDealView({ pair: { mode: 'OPENING', deadlineAt: Date.now() + 232_000 } }));
    expect(await screen.findByText('Limit resting')).toBeInTheDocument();
    expect(screen.getByText(/^Market order in 3m 5\ds$|^Market order in 3m 4\ds$/)).toBeInTheDocument();
    expect(screen.getByText('Running')).toBeInTheDocument();
  });

  const refusedMaker: DealOrder = {
    ...dealOrder('A', 'maker'),
    seq: 2,
    state: 'DEAD',
    cumQty: '0',
    closeReason: 'rejected:TRADE_HYPERLIQUID_ORDER_LIMIT_ERROR',
  };
  const refusedLine = 'Re-peg refused by Gate · no order resting · retry in 1 min';

  it('a refused re-peg says no order rests', async () => {
    renderModal({ ...makeDealView({ pair: { mode: 'OPENING', deadlineAt: null }, orders: [dealOrder('A', 'maker'), refusedMaker] }), repegRefused: 'GATE' });
    expect(await screen.findByText(refusedLine)).toBeInTheDocument();
    expect(screen.queryByText('Limit resting · no market order')).not.toBeInTheDocument();
  });

  it('a refused re-peg keeps the market countdown and says no limit rests', async () => {
    renderModal({ ...makeDealView({ pair: { mode: 'OPENING', deadlineAt: Date.now() + 232_000 }, orders: [dealOrder('A', 'maker'), refusedMaker] }), repegRefused: 'GATE' });
    expect(await screen.findByText(refusedLine)).toBeInTheDocument();
    expect(screen.getByText(/^Market order in 3m [45]\ds$/)).toBeInTheDocument();
    expect(screen.queryByText('Limit resting')).not.toBeInTheDocument();
  });

  it('the refused line goes once a new maker order is accepted', async () => {
    const accepted: DealOrder = { ...dealOrder('A', 'maker'), seq: 3, state: 'OPEN', cumQty: '0', closeReason: null };
    renderModal(makeDealView({ pair: { mode: 'OPENING', deadlineAt: null }, orders: [dealOrder('A', 'maker'), refusedMaker, accepted] }));
    expect(await screen.findByText('Limit resting · no market order')).toBeInTheDocument();
    expect(screen.queryByText(refusedLine)).not.toBeInTheDocument();
  });

  it('first line under never', async () => {
    renderModal(makeDealView({ pair: { mode: 'OPENING', deadlineAt: null } }));
    expect(await screen.findByText('Limit resting · no market order')).toBeInTheDocument();
    expect(screen.queryByText(/Market order in/)).not.toBeInTheDocument();
  });

  it('deal window in the run layout', async () => {
    renderModal(
      makeDealView({
        pair: { mode: 'OPENING', deadlineAt: Date.now() + 120_000 },
        orders: [dealOrder('A', 'maker'), dealOrder('B', 'taker'), dealOrder('B', 'taker')],
        projection: { aFilled: '0.02', bFilled: '0.02' },
      }),
    );
    expect(await screen.findByText('Filled · each leg')).toBeInTheDocument();
    expect(screen.getByText('Not hedged now')).toBeInTheDocument();
    expect(screen.getByText('Fee so far')).toBeInTheDocument();
    expect(screen.getByText('Orders 3')).toBeInTheDocument();
    expect(await screen.findByText(/Limit · Gate/)).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('[data-price-graph]')).not.toBeNull());
    expect(screen.queryByTestId('deal-report')).not.toBeInTheDocument();
  });

  it('market order now beside hold to stop', async () => {
    renderModal();
    const market = await screen.findByRole('button', { name: 'Market order now' });
    const stop = screen.getByRole('button', { name: 'Hold to stop' });
    expect(market).toBeEnabled();
    expect(market.parentElement).toBe(stop.parentElement);
    expect(market.parentElement?.className).toContain('grid-cols-2');
  });

  it('old buttons gone', async () => {
    renderModal();
    await screen.findByRole('button', { name: 'Market order now' });
    for (const name of ['Convert now', 'Re-peg to touch', 'Re-peg to price']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
  });

  it('OPENING: draws the live book graph — OUR limit, the hedge market fill, and the leg captions', async () => {
    const previewCalls: ActionInput[][] = [];
    server.use(
      http.get('/api/books/:symbol', ({ params }) =>
        HttpResponse.json(
          env({ symbol: String(params.symbol), bestBid: 2499, bestAsk: 2501, mid: 2500 }),
        ),
      ),
      http.post('/api/preview', async ({ request }) => {
        const { actions } = (await request.json()) as { actions: ActionInput[] };
        previewCalls.push(actions);
        return HttpResponse.json(
          env({
            previews: actions.map((a, i) =>
              previewFor(a, {
                index: i,
                // A SELL fills below the touch — the hedge leg's estimate.
                fillEstimate: {
                  qty: '0.05',
                  avgPrice: 2497.4,
                  worstPrice: 2497,
                  midPrice: 2500,
                  slippagePct: 0.06,
                  source: 'venue-orderbook',
                  confidence: 'high',
                  venue: 'BINANCE',
                },
              }),
            ),
          }),
        );
      }),
    );
    renderModal(
      makeDealView({
        pair: { mode: 'OPENING' },
        projection: {
          makerOrder: {
            pairId: 'd1',
            leg: 'A',
            seq: 1,
            clientId: 'c1',
            kind: 'maker',
            side: 'BUY',
            qty: '0.05',
            price: '2497',
            tif: 'poc',
            state: 'OPEN',
            venueOrderId: 'v1',
            cumQty: '0',
            closeReason: null,
            cancelRequested: 0,
            quarantinedStatus: null,
    venueReason: null,
            createdAt: Date.now(),
            resolvedAt: null,
          },
        },
      }),
    );
    await screen.findByText('Running');
    // The maker (GATE, BUY → long column) carries the resting limit at the
    // LIVE order's price; the hedge column shows only its book.
    await waitFor(() => expect(document.querySelector('[data-price-graph]')).not.toBeNull());
    await waitFor(() =>
      expect(
        document.querySelector('[data-leg="long"] [data-mark="limit"]')?.getAttribute('data-price'),
      ).toBe('2497'),
    );
    // The limit tag carries the order's price AND size (no legs table remains
    // to spell them out).
    expect(
      document.querySelector('[data-leg="long"] [data-mark="limit"]')?.textContent,
    ).toContain('Limit 2,497.00 × 0.05');
    expect(document.querySelector('[data-leg="short"] [data-mark="limit"]')).toBeNull();
    expect(document.querySelector('[data-leg="short"] [data-mark="bid"]')?.getAttribute('data-price')).toBe('2499');
    // The hedge column carries its market-order simulation — the market hedge
    // Leg B fires to cover everything Leg A acquires (target − reserved),
    // matched back by symbol. The maker column shows NO market estimate: the
    // deal's whole point is resting at the limit.
    await waitFor(
      () =>
        expect(
          document.querySelector('[data-leg="short"] [data-mark="fill"]')?.getAttribute('data-price'),
        ).toBe('2497.4'),
      { timeout: 4000 },
    );
    expect(document.querySelector('[data-leg="long"] [data-mark="fill"]')).toBeNull();
    expect(previewCalls.at(-1)).toHaveLength(1);
    expect(previewCalls.at(-1)?.[0]).toMatchObject({
      kind: 'open-market',
      symbol: 'BINANCE_FUTURE_ETH_USDT',
      side: 'SELL',
      qty: '0.05',
    });
  });

  it('OPENING: the hedge qty is target − reserved, float dust trimmed off the wire', async () => {
    const previewCalls: ActionInput[][] = [];
    server.use(
      http.get('/api/books/:symbol', ({ params }) =>
        HttpResponse.json(
          env({ symbol: String(params.symbol), bestBid: 2499, bestAsk: 2501, mid: 2500 }),
        ),
      ),
      http.post('/api/preview', async ({ request }) => {
        const { actions } = (await request.json()) as { actions: ActionInput[] };
        previewCalls.push(actions);
        return HttpResponse.json(
          env({
            previews: actions.map((a, i) =>
              previewFor(a, {
                index: i,
                fillEstimate: {
                  qty: '0.03',
                  avgPrice: 2497.4,
                  worstPrice: 2497,
                  midPrice: 2500,
                  slippagePct: 0.06,
                  source: 'venue-orderbook',
                  confidence: 'high',
                  venue: 'BINANCE',
                },
              }),
            ),
          }),
        );
      }),
    );
    renderModal(
      makeDealView({
        pair: { mode: 'OPENING' },
        // The hedge still owes target − bReserved = 0.05 − 0.02, which floats
        // to 0.030000000000000002 — the wire must carry '0.03' EXACTLY.
        projection: { aFilled: '0.05', bReserved: '0.02', residualA: '0', unhedged: '0.03' },
      }),
    );
    await waitFor(() => expect(document.querySelector('[data-price-graph]')).not.toBeNull());
    await waitFor(
      () =>
        expect(
          document.querySelector('[data-leg="short"] [data-mark="fill"]')?.getAttribute('data-price'),
        ).toBe('2497.4'),
      { timeout: 4000 },
    );
    expect(document.querySelector('[data-leg="long"] [data-mark="fill"]')).toBeNull();
    expect(previewCalls.at(-1)).toHaveLength(1);
    expect(previewCalls.at(-1)?.[0]).toMatchObject({
      kind: 'open-market',
      symbol: 'BINANCE_FUTURE_ETH_USDT',
      side: 'SELL',
      qty: '0.03',
    });
  });

  it('OPENING single-leg (no hedge): the book graph renders with no preview at all', async () => {
    const previewCalls: ActionInput[][] = [];
    server.use(
      http.get('/api/books/:symbol', ({ params }) =>
        HttpResponse.json(
          env({ symbol: String(params.symbol), bestBid: 2499, bestAsk: 2501, mid: 2500 }),
        ),
      ),
      http.post('/api/preview', async ({ request }) => {
        const { actions } = (await request.json()) as { actions: ActionInput[] };
        previewCalls.push(actions);
        return HttpResponse.json(
          env({ previews: actions.map((a, i) => previewFor(a, { index: i })) }),
        );
      }),
    );
    renderModal(makeDealView({ pair: { mode: 'OPENING', b: null } }));
    await waitFor(() => expect(document.querySelector('[data-price-graph]')).not.toBeNull());
    await waitFor(() =>
      expect(
        document.querySelector('[data-leg="long"] [data-mark="limit"]')?.getAttribute('data-price'),
      ).toBe('2500'),
    );
    // Past the 400ms preview debounce: with no hedge leg there is nothing to
    // simulate, so no POST may ever fire.
    await new Promise((r) => setTimeout(r, 700));
    expect(previewCalls).toHaveLength(0);
    expect(document.querySelector('[data-mark="fill"]')).toBeNull();
  });

  it('re-pegs a BUY maker to a typed price, snapped DOWN to the venue tick', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    renderModal();
    server.use(
      http.post('/api/deals/:id/:cmd', async ({ params, request }) => {
        bodies.push({ cmd: String(params.cmd), ...((await request.json()) as object) });
        return HttpResponse.json(env({ id: String(params.id) }));
      }),
    );
    const input = await screen.findByLabelText(/Limit · Gate/);
    fireEvent.change(input, { target: { value: '2497.136' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(bodies).toEqual([{ cmd: 'repeg', price: '2497.13' }]));
  });

  it('re-pegs a SELL maker to a typed price, snapped UP to the venue tick', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    renderModal(
      makeDealView({
        pair: {
          a: { contract: 'GATE_FUTURE_ETH_USDT', side: 'SELL', lot: '0.001', minSize: '0', minNotional: '0', tick: '0.01' },
          b: { contract: 'BINANCE_FUTURE_ETH_USDT', side: 'BUY', lot: '0.001', minSize: '0', minNotional: '0', tick: '0.01' },
        },
      }),
    );
    server.use(
      http.post('/api/deals/:id/:cmd', async ({ params, request }) => {
        bodies.push({ cmd: String(params.cmd), ...((await request.json()) as object) });
        return HttpResponse.json(env({ id: String(params.id) }));
      }),
    );
    const input = await screen.findByLabelText(/Limit · Gate/);
    fireEvent.change(input, { target: { value: '2497.134' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(bodies).toEqual([{ cmd: 'repeg', price: '2497.14' }]));
  });

  it('To best posts a re-peg with no price', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    renderModal();
    server.use(
      http.post('/api/deals/:id/:cmd', async ({ params, request }) => {
        bodies.push({ cmd: String(params.cmd), ...((await request.json()) as object) });
        return HttpResponse.json(env({ id: String(params.id) }));
      }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'To best' }));
    await waitFor(() => expect(bodies).toEqual([{ cmd: 'repeg' }]));
  });

  it('market order now converts', async () => {
    const cmds: string[] = [];
    renderModal();
    server.use(
      http.post('/api/deals/:id/:cmd', ({ params }) => {
        cmds.push(String(params.cmd));
        return HttpResponse.json(env({ id: String(params.id) }));
      }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Market order now' }));
    await waitFor(() => expect(cmds).toEqual(['convert']));
  });

  it('stop is a hold', async () => {
    const cmds: string[] = [];
    renderModal();
    server.use(
      http.post('/api/deals/:id/:cmd', ({ params }) => {
        cmds.push(String(params.cmd));
        return HttpResponse.json(env({ id: String(params.id) }));
      }),
    );
    const stop = await screen.findByRole('button', { name: 'Hold to stop' });
    fireEvent.pointerDown(stop);
    await act(() => new Promise((r) => setTimeout(r, 400)));
    fireEvent.pointerUp(stop);
    await act(() => new Promise((r) => setTimeout(r, 700)));
    expect(cmds).toEqual([]);
    fireEvent.pointerDown(stop);
    await waitFor(() => expect(cmds).toEqual(['stop']), { timeout: 2500 });
  });

  it('HALTED: shows the halt reason and the resume control; unhedged is surfaced', async () => {
    renderModal(
      makeDealView({
        pair: { mode: 'HALTED', haltReason: 'hedge failed 3x' },
        projection: { aFilled: '0.05', bFilled: '0.02', unhedged: '0.03' },
      }),
    );
    expect(await screen.findByText('Halted — needs you')).toBeInTheDocument();
    expect(screen.getByText(/hedge failed 3x/)).toBeInTheDocument();
    expect(screen.getByText('Not hedged now')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Resume/ })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Market order now' })).not.toBeInTheDocument();
  });

  it('done rows', async () => {
    const created = 1_751_500_000_000;
    renderModal(
      makeDealView({
        pair: {
          mode: 'DONE',
          createdAt: created,
          reportJson: JSON.stringify({
            aFilled: '0.05', bFilled: '0.05', unhedged: '0', reason: 'filled',
            aAvgFill: '2500', bAvgFill: '2500.33',
          }),
        },
        orders: [
          { ...dealOrder('A', 'maker'), resolvedAt: created + 220_000 },
          dealOrder('B', 'taker'),
        ],
        projection: { aFilled: '0.05', bFilled: '0.05', unhedged: '0' },
        fees: { readUsd: 0, estUsd: 0.09, est: true },
        endedAt: created + 220_000,
      }),
    );
    expect(await screen.findByText('Opened · each leg')).toBeInTheDocument();
    expect(screen.getByText('Avg price · Gate')).toBeInTheDocument();
    expect(screen.getByText('Avg price · Binance')).toBeInTheDocument();
    expect(screen.getByText(/^\+0\.33 USDT per coin \(\+0\.013%\) Favorable$/)).toBeInTheDocument();
    expect(screen.getByText('Fees')).toBeInTheDocument();
    expect(screen.getByText('$0.09')).toBeInTheDocument();
    expect(screen.getByText('Took')).toBeInTheDocument();
    expect(screen.getByText('3m 40s')).toBeInTheDocument();
    expect(screen.getByText('Orders 2')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /stop/i })).not.toBeInTheDocument();
  });

  it('no report box', async () => {
    renderModal(
      makeDealView({
        pair: {
          mode: 'DONE',
          reportJson: JSON.stringify({ aFilled: '0.05', bFilled: '0.04', unhedged: '0.01', reason: 'stopped' }),
        },
        projection: { aFilled: '0.05', bFilled: '0.04', unhedged: '0.01' },
      }),
    );
    expect(await screen.findByText('Stopped')).toBeInTheDocument();
    expect(screen.getByText('Not hedged now')).toBeInTheDocument();
    expect(screen.queryByText('Report')).not.toBeInTheDocument();
    expect(screen.queryByTestId('deal-report')).not.toBeInTheDocument();
    expect(screen.queryByText(/through the market/)).not.toBeInTheDocument();
  });

  it('DONE by a crossing limit: explains the failure and points at the order form', async () => {
    renderModal(
      makeDealView({
        pair: {
          mode: 'DONE',
          reportJson: JSON.stringify({
            aFilled: '0',
            bFilled: '0',
            unhedged: '0',
            reason: 'the limit price kept crossing the market — the venue rejected the post-only maker 5 times in a row',
          }),
        },
        projection: { aFilled: '0', bFilled: '0', unhedged: '0' },
      }),
    );
    expect(await screen.findByText(/the limit price was already through the market/)).toBeInTheDocument();
    expect(screen.getByText(/Try again from the order form with a fresh limit price/)).toBeInTheDocument();
  });

  it('DONE: omits slippage when a leg has no average fill', async () => {
    renderModal(
      makeDealView({
        pair: {
          mode: 'DONE',
          reportJson: JSON.stringify({ aFilled: '0.05', bFilled: '0', unhedged: '0.05', reason: 'stopped', aAvgFill: '2500', bAvgFill: null }),
        },
        projection: { aFilled: '0.05', bFilled: '0', unhedged: '0.05' },
      }),
    );
    expect(await screen.findByText('Opened · each leg')).toBeInTheDocument();
    expect(screen.queryByText('Slippage')).not.toBeInTheDocument();
  });

  it('close: the window names the position, not the order side, and the title says close', async () => {
    const base = makeDealView();
    renderModal(
      makeDealView({
        pair: { a: { ...base.pair.a, reduceOnly: true }, b: base.pair.b && { ...base.pair.b, reduceOnly: true } },
      }),
    );
    expect(await screen.findByText('ETH pair close · limit + hedge')).toBeInTheDocument();
    const legs = document.querySelector('span.num.text-\\[11px\\]')!.textContent;
    expect(legs).toBe('Gate Short / Binance Long');
  });

  it('open: title from the job and no raw id', async () => {
    renderModal();
    expect(await screen.findByText('ETH pair open · limit + hedge')).toBeInTheDocument();
    expect(screen.queryByText(/Deal/)).not.toBeInTheDocument();
  });

  it('done: Close button, no stray Done line, slippage carries its unit', async () => {
    renderModal(
      makeDealView({
        pair: {
          mode: 'DONE',
          reportJson: JSON.stringify({ aFilled: '0.05', bFilled: '0.05', unhedged: '0', reason: 'target reached', aAvgFill: '2500', bAvgFill: '2500.33' }),
        },
        projection: { aFilled: '0.05', bFilled: '0.05', unhedged: '0' },
      }),
    );
    expect(await screen.findByRole('button', { name: 'Close' })).toBeInTheDocument();
    expect(screen.queryByText('Target reached')).not.toBeInTheDocument();
    expect(screen.getByText(/^\+0\.33 USDT per coin \(\+0\.013%\) Favorable$/)).toBeInTheDocument();
  });

  it('a failed refresh says the numbers may be old', async () => {
    const view = makeDealView();
    let n = 0;
    server.use(
      http.get('/api/deals/:id', () => (n++ === 0 ? HttpResponse.json(env(view)) : HttpResponse.json({ ok: false, error: { message: 'x' } }, { status: 500 }))),
      ...baseHandlers(),
    );
    renderWithClient(
      <TradeFlowProvider>
        <DealModal dealId="d1" onClose={() => {}} />
      </TradeFlowProvider>,
    );
    await screen.findByText('Filled · each leg');
    expect(await screen.findByText(/The numbers may be old/, undefined, { timeout: 4000 })).toBeInTheDocument();
  });
});
