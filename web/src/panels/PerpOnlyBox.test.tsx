import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import type { ActionInput, PreviewResponse, TwapStartBody } from '../api/types';
import { baseHandlers, previewFor } from '../test/fixtures';
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

describe('ClosePairForm, close perps with TWAP', () => {
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
    await userEvent.click(await screen.findByRole('radio', { name: /^Market$/ }));
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

  it('the leg table names legs LONG or SHORT, never buy or sell', async () => {
    server.use(...baseHandlers(), previewHandler());
    renderPlain();
    expect(await screen.findByText('Limit price')).toBeInTheDocument();
    expect(screen.queryByText('SELL')).toBeNull();
    expect(screen.queryByText('BUY')).toBeNull();
    expect(screen.getAllByText('LONG').length).toBeGreaterThan(0);
  });
});
