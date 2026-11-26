import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ActionInput, PreviewResponse, SymbolRule, TwapStartBody } from '../api/types';
import { baseHandlers, ETH_GATE, previewFor, symbolHandlers } from '../test/fixtures';
import { env, server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { ClosePairForm } from './PerpOnlyBox';

const LEGS = [
  { symbol: 'GATE_FUTURE_ETH_USDT', qty: 120, venue: 'GATE' },
  { symbol: 'HYPERLIQUID_FUTURE_ETH_USDT', qty: 120, venue: 'HYPERLIQUID' },
];

const PLAN = { slices: 12, sliceQty: '10', lastQty: '10', intervalSec: 300, durationSec: 3_600, takerAfterSec: 240 };

const FEES = { makerRate: 0.0002, takerRate: 0.0005, specialOverride: false, quote: 'USDT', est: { taker: 51.9 } };

function previewHandler(bodies: Array<{ twap?: unknown }> = [], fees?: typeof FEES) {
  return http.post('/api/preview', async ({ request }) => {
    const body = (await request.json()) as { actions: ActionInput[]; twap?: unknown };
    bodies.push(body);
    return HttpResponse.json(
      env<PreviewResponse>({
        makerLeg: { auto: 'a', why: 'fees' },
        priceImpact: { whole: 12, sliced: 3 },
        twap: { plan: PLAN, refusal: null },
        previews: body.actions.map((a) =>
          previewFor(a, {
            side: 'SELL',
            type: 'LIMIT',
            tif: 'IOC',
            reduceOnly: true,
            qty: '120',
            price: '1730',
            estNotional: 207_600,
            closing: { positionQty: '120', upnl: '590', mark: 1730 },
            ...(fees ? { fees } : {}),
          }),
        ),
      }),
    );
  });
}

function renderPlain() {
  return renderWithClient(<ClosePairForm base="ETH" legs={LEGS} allowTwap />);
}

async function twapOn() {
  await userEvent.click(await screen.findByRole('switch', { name: 'TWAP' }));
}

const ruleOf = (symbol: string, lotSize: string): SymbolRule => ({
  ...ETH_GATE,
  symbol,
  exchange: symbol.split('_')[0],
  base: symbol.split('_')[2],
  lotSize,
  minSize: lotSize,
});

const RULES = [
  ruleOf('GATE_FUTURE_ETH_USDT', '0.001'),
  ruleOf('HYPERLIQUID_FUTURE_ETH_USDT', '0.0001'),
  ruleOf('GATE_FUTURE_BTC_USDT', '0.0001'),
  ruleOf('HYPERLIQUID_FUTURE_BTC_USDT', '0.00001'),
];

function heldPreviewHandler(held: Record<string, string>, bodies: Array<{ actions: ActionInput[]; twap?: unknown }> = []) {
  return http.post('/api/preview', async ({ request }) => {
    const body = (await request.json()) as { actions: ActionInput[]; twap?: unknown };
    bodies.push(body);
    const previews = body.actions.map((a) =>
      previewFor(a, {
        side: a.symbol.startsWith('GATE') ? 'SELL' : 'BUY',
        qty: ('qty' in a && a.qty) || held[a.symbol],
        closing: { positionQty: held[a.symbol], upnl: '0', mark: 2000 },
      }),
    );
    const sameQty = previews.every((p) => Number(p.qty) === Number(previews[0].qty));
    return HttpResponse.json(
      env<PreviewResponse>({
        previews,
        makerLeg: { auto: 'a', why: 'fees' },
        priceImpact: { whole: 12, sliced: 3 },
        twap: body.twap !== undefined && sameQty ? { plan: PLAN, refusal: null } : null,
      }),
    );
  });
}

const restLine = (text: string) => (_: string, el: Element | null) => el?.tagName === 'P' && el.textContent === text;

describe('ClosePairForm, close perps with TWAP and unequal legs', () => {
  beforeEach(() => server.use(...baseHandlers(), ...symbolHandlers(RULES)));

  const btcLegs = (gate: number, hl: number) => [
    { symbol: 'GATE_FUTURE_BTC_USDT', qty: gate, venue: 'GATE' },
    { symbol: 'HYPERLIQUID_FUTURE_BTC_USDT', qty: hl, venue: 'HYPERLIQUID' },
  ];

  it('plans the matched size on both legs, names the rest and arms the hold', async () => {
    const bodies: Array<{ actions: ActionInput[]; twap?: unknown }> = [];
    const starts: TwapStartBody[] = [];
    server.use(
      heldPreviewHandler({ GATE_FUTURE_BTC_USDT: '4.4', HYPERLIQUID_FUTURE_BTC_USDT: '4.03' }, bodies),
      http.post('/api/rebalance', async ({ request }) => {
        starts.push((await request.json()) as TwapStartBody);
        return HttpResponse.json(env({ id: 'job-1' }), { status: 202 });
      }),
    );
    renderWithClient(<ClosePairForm base="BTC" legs={btcLegs(4.4, 4.03)} allowTwap />);
    await twapOn();
    expect(await screen.findByText(restLine('0.37 BTC Gate Long stays open. Close it as one leg.'))).toBeInTheDocument();
    const btn = await screen.findByRole('button', { name: /Start TWAP close/ });
    await waitFor(() => expect(btn).toBeEnabled(), { timeout: 4000 });
    const last = bodies[bodies.length - 1];
    expect(last.actions[0]).toMatchObject({ symbol: 'GATE_FUTURE_BTC_USDT', qty: '4.03' });
    expect(last.actions[1]).not.toHaveProperty('qty');
    fireEvent.pointerDown(btn);
    await waitFor(() => expect(starts).toHaveLength(1), { timeout: 4000 });
    expect(starts[0].deal).toMatchObject({ qty: '4.03', a: { reduceOnly: true }, b: { reduceOnly: true } });
  });

  it('a shared Gate leg of 4.40 out of 8.0 against 4.03 BTC closes 4.03 on both and leaves 0.37 BTC', async () => {
    const bodies: Array<{ actions: ActionInput[]; twap?: unknown }> = [];
    const starts: TwapStartBody[] = [];
    server.use(
      heldPreviewHandler({ GATE_FUTURE_BTC_USDT: '8', HYPERLIQUID_FUTURE_BTC_USDT: '4.03' }, bodies),
      http.post('/api/rebalance', async ({ request }) => {
        starts.push((await request.json()) as TwapStartBody);
        return HttpResponse.json(env({ id: 'job-1' }), { status: 202 });
      }),
    );
    renderWithClient(
      <ClosePairForm
        base="BTC"
        legs={[
          { symbol: 'GATE_FUTURE_BTC_USDT', qty: 4.4, venue: 'GATE', partial: true },
          { symbol: 'HYPERLIQUID_FUTURE_BTC_USDT', qty: 4.03, venue: 'HYPERLIQUID' },
        ]}
        allowTwap
      />,
    );
    await twapOn();
    expect(await screen.findByText(restLine('0.37 BTC Gate Long stays open. Close it as one leg.'))).toBeInTheDocument();
    const btn = await screen.findByRole('button', { name: /Start TWAP close/ });
    await waitFor(() => expect(btn).toBeEnabled(), { timeout: 4000 });
    expect(bodies[bodies.length - 1].actions[0]).toMatchObject({ symbol: 'GATE_FUTURE_BTC_USDT', qty: '4.03' });
    fireEvent.pointerDown(btn);
    await waitFor(() => expect(starts).toHaveLength(1), { timeout: 4000 });
    expect(starts[0].deal).toMatchObject({ qty: '4.03', a: { reduceOnly: true }, b: { reduceOnly: true } });
  });

  it('a shared Gate leg of 4.03 out of 8.0 against 4.03 BTC sends 4.03, never the whole Gate position', async () => {
    const bodies: Array<{ actions: ActionInput[]; twap?: unknown }> = [];
    server.use(heldPreviewHandler({ GATE_FUTURE_BTC_USDT: '8', HYPERLIQUID_FUTURE_BTC_USDT: '4.03' }, bodies));
    renderWithClient(
      <ClosePairForm
        base="BTC"
        legs={[
          { symbol: 'GATE_FUTURE_BTC_USDT', qty: 4.03, venue: 'GATE', partial: true },
          { symbol: 'HYPERLIQUID_FUTURE_BTC_USDT', qty: 4.03, venue: 'HYPERLIQUID' },
        ]}
        allowTwap
      />,
    );
    await twapOn();
    await waitFor(() => expect(screen.getByRole('button', { name: /Start TWAP close/ })).toBeEnabled(), { timeout: 4000 });
    expect(bodies[bodies.length - 1].actions[0]).toMatchObject({ symbol: 'GATE_FUTURE_BTC_USDT', qty: '4.03' });
    expect(screen.queryByText(/stays open/)).not.toBeInTheDocument();
  });

  it('a $6M book of 1,000.37 against 1,000 ETH closes 1000 on both and leaves 0.37 ETH', async () => {
    const bodies: Array<{ actions: ActionInput[]; twap?: unknown }> = [];
    server.use(heldPreviewHandler({ GATE_FUTURE_ETH_USDT: '1000.37', HYPERLIQUID_FUTURE_ETH_USDT: '1000' }, bodies));
    renderWithClient(
      <ClosePairForm
        base="ETH"
        legs={[
          { symbol: 'GATE_FUTURE_ETH_USDT', qty: 1000.37, venue: 'GATE' },
          { symbol: 'HYPERLIQUID_FUTURE_ETH_USDT', qty: 1000, venue: 'HYPERLIQUID' },
        ]}
        allowTwap
      />,
    );
    await twapOn();
    expect(await screen.findByText(restLine('0.37 ETH Gate Long stays open. Close it as one leg.'))).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: /Start TWAP close/ })).toBeEnabled(), { timeout: 4000 });
    expect(bodies[bodies.length - 1].actions[0]).toMatchObject({ qty: '1000' });
  });

  it('floors the matched size to the coarser lot and names both rests', async () => {
    const bodies: Array<{ actions: ActionInput[]; twap?: unknown }> = [];
    server.use(heldPreviewHandler({ GATE_FUTURE_BTC_USDT: '4.4', HYPERLIQUID_FUTURE_BTC_USDT: '4.03157' }, bodies));
    renderWithClient(<ClosePairForm base="BTC" legs={btcLegs(4.4, 4.03157)} allowTwap />);
    await twapOn();
    expect(await screen.findByText(restLine('0.3685 BTC Gate Long stays open. Close it as one leg.'))).toBeInTheDocument();
    expect(screen.getByText(restLine('0.00007 BTC Hyperliquid Short stays open. Close it as one leg.'))).toBeInTheDocument();
    await waitFor(() => expect(bodies[bodies.length - 1].actions.map((a) => ('qty' in a ? a.qty : undefined))).toEqual(['4.0315', '4.0315']));
  });

  it('with twap off, unequal legs keep the whole close of each leg and show no rest', async () => {
    const bodies: Array<{ actions: ActionInput[]; twap?: unknown }> = [];
    server.use(heldPreviewHandler({ GATE_FUTURE_BTC_USDT: '4.4', HYPERLIQUID_FUTURE_BTC_USDT: '4.03' }, bodies));
    renderWithClient(<ClosePairForm base="BTC" legs={btcLegs(4.4, 4.03)} allowTwap />);
    expect(await screen.findByText('PnL to realize')).toBeInTheDocument();
    await waitFor(() => expect(bodies.length).toBeGreaterThan(0), { timeout: 4000 });
    expect(bodies[bodies.length - 1].actions.every((a) => !('qty' in a))).toBe(true);
    expect(screen.queryByText(/stays open/)).toBeNull();
  });

  it('equal legs with twap on send no size and show no rest', async () => {
    const bodies: Array<{ actions: ActionInput[]; twap?: unknown }> = [];
    server.use(heldPreviewHandler({ GATE_FUTURE_BTC_USDT: '4.03', HYPERLIQUID_FUTURE_BTC_USDT: '4.03' }, bodies));
    renderWithClient(<ClosePairForm base="BTC" legs={btcLegs(4.03, 4.03)} allowTwap />);
    await twapOn();
    await waitFor(() => expect(screen.getByRole('button', { name: /Start TWAP close/ })).toBeEnabled(), { timeout: 4000 });
    expect(bodies[bodies.length - 1].actions.every((a) => !('qty' in a))).toBe(true);
    expect(screen.queryByText(/stays open/)).toBeNull();
  });
});

describe('ClosePairForm, close perps with TWAP', () => {
  beforeEach(() => server.use(...symbolHandlers(RULES)));

  it('close perps has the twap area', async () => {
    server.use(...baseHandlers(), previewHandler());
    renderPlain();
    expect(await screen.findByRole('switch', { name: 'TWAP' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Maker settings/ })).toBeInTheDocument();
    await twapOn();
    expect(await screen.findByText('Duration')).toBeInTheDocument();
  });

  it('headline kept with twap', async () => {
    const bodies: Array<{ twap?: unknown }> = [];
    server.use(...baseHandlers(), previewHandler(bodies));
    renderPlain();
    await twapOn();
    expect(await screen.findByText('PnL to realize')).toBeInTheDocument();
    expect(await screen.findByText('Realized as each slice fills')).toBeInTheDocument();
    await waitFor(() => expect(bodies.some((b) => b.twap !== undefined)).toBe(true), { timeout: 4000 });
  });

  it('start twap close label', async () => {
    server.use(...baseHandlers(), previewHandler());
    renderPlain();
    expect(await screen.findByRole('button', { name: /Close both/ })).toBeInTheDocument();
    await twapOn();
    expect(await screen.findByRole('button', { name: /Start TWAP close/ })).toBeInTheDocument();
    expect(screen.getByText('Reduce-only. Each fill is hedged at once.')).toBeInTheDocument();
  });

  it('shows the fee saved against two taker orders in maker settings', async () => {
    server.use(...baseHandlers(), previewHandler([], FEES));
    renderPlain();
    await userEvent.click(await screen.findByRole('button', { name: /Maker settings/ }));
    expect(await screen.findByText(/Saves ≈ 62.28 USDT/)).toBeInTheDocument();
    expect(screen.getByText(/vs 2 taker orders/)).toBeInTheDocument();
  });

  it('hides the saving line with twap on', async () => {
    server.use(...baseHandlers(), previewHandler([], FEES));
    renderPlain();
    await twapOn();
    await userEvent.click(await screen.findByRole('button', { name: /Maker settings/ }));
    await screen.findByText('PnL to realize');
    expect(screen.queryByText(/vs 2 taker orders/)).toBeNull();
  });

  it('fixed rate pair has no switch', async () => {
    server.use(...baseHandlers(), previewHandler());
    renderWithClient(<ClosePairForm base="ETH" legs={LEGS} />);
    expect(await screen.findByRole('button', { name: /Maker settings/ })).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'TWAP' })).toBeNull();
  });

  it('market slippage in maker settings', async () => {
    server.use(...baseHandlers(), previewHandler());
    renderPlain();
    await userEvent.click(await screen.findByRole('button', { name: /Maker settings/ }));
    expect(screen.getByRole('radiogroup', { name: 'Market slippage' })).toBeInTheDocument();
    expect(await screen.findByText('PnL to realize')).toBeInTheDocument();
    expect(screen.queryByText(/Max slippage/)).toBeNull();
  });

  it('market slippage row with market', async () => {
    server.use(...baseHandlers(), previewHandler());
    renderPlain();
    await userEvent.click(await screen.findByRole('radio', { name: /^Market/ }));
    expect(screen.getByRole('textbox', { name: 'Market slippage' })).toHaveValue('0.5');
    expect(screen.queryByRole('switch', { name: 'TWAP' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Maker settings/ })).toBeNull();
  });

  it('market slippage goes as clipBandPct', async () => {
    const starts: TwapStartBody[] = [];
    server.use(
      ...baseHandlers(),
      previewHandler(),
      http.post('/api/rebalance', async ({ request }) => {
        starts.push((await request.json()) as TwapStartBody);
        return HttpResponse.json(env({ id: 'job-1' }), { status: 202 });
      }),
    );
    renderPlain();
    await twapOn();
    const btn = await screen.findByRole('button', { name: /Start TWAP close/ });
    await waitFor(() => expect(btn).toBeEnabled(), { timeout: 4000 });
    fireEvent.pointerDown(btn);
    await waitFor(() => expect(starts).toHaveLength(1), { timeout: 4000 });
    expect(starts[0]).toMatchObject({
      kind: 'twap',
      durationSec: 3_600,
      slices: 12,
      deal: {
        a: { symbol: 'GATE_FUTURE_ETH_USDT', reduceOnly: true },
        b: { symbol: 'HYPERLIQUID_FUTURE_ETH_USDT', reduceOnly: true },
        execution: 'maker',
        makerLeg: 'auto',
        timeoutSec: 240,
        clipBandPct: 0.5,
      },
    });
  });

  it('limit and hedge: plan lines name each leg by its position, with the trade cost and a Book button', async () => {
    server.use(...baseHandlers(), previewHandler([], FEES));
    renderPlain();
    expect(await screen.findByText('≈ 93.42 USDT')).toBeInTheDocument();
    expect(screen.getByText('Trade cost')).toBeInTheDocument();
    expect(screen.getByText('PnL to realize')).toBeInTheDocument();
    expect(screen.getByText(/Gate · rests as maker/)).toBeInTheDocument();
    expect(screen.getByText(/Hyperliquid · hedges/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Book' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByText('Limit price')).toBeNull();
    expect(screen.queryByText('SELL')).toBeNull();
    expect(screen.queryByText('BUY')).toBeNull();
    expect(screen.getAllByText('LONG').length).toBeGreaterThan(0);
  });

  it('market: the trade cost is two taker fees and no plan line shows', async () => {
    server.use(...baseHandlers(), previewHandler([], FEES));
    renderPlain();
    await userEvent.click(await screen.findByRole('radio', { name: /^Market/ }));
    expect(await screen.findByText('≈ 103.80 USDT')).toBeInTheDocument();
    expect(screen.queryByText(/rests as maker/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Book' })).toBeInTheDocument();
  });
});
