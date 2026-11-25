import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RebalanceJob, RunOrderView, TwapChildView } from '../api/types';
import { makeDealView } from '../test/fixtures';
import { env, server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { RunView, twapRunProps } from './RunView';

vi.mock('./PriceImpactGraph', () => ({
  DealBookImpact: (p: { makerContract: string; hedgeContract: string | null }) => (
    <div data-testid="book-graph" data-maker={p.makerContract} data-hedge={String(p.hedgeContract)} />
  ),
}));

const at = (h: number, m: number, s = 0): number => new Date(2026, 10, 25, h, m, s).getTime();
const NOW = at(14, 20);
const CHILD_ID = 'job1-s3-1';

afterEach(() => {
  vi.restoreAllMocks();
});

function order(slice: number, kind: 'maker' | 'taker', createdAt: number, filledQty: string): RunOrderView {
  return {
    venue: kind === 'maker' ? 'Gate' : 'Hyperliquid',
    leg: kind === 'maker' ? 'A' : 'B',
    kind,
    slice,
    price: kind === 'maker' ? '1729.8' : '1730.2',
    qty: '57.803',
    filledQty,
    state: kind === 'maker' && slice === 3 ? 'OPEN' : 'CLOSED',
    createdAt,
  };
}

const ORDERS: RunOrderView[] = [
  order(3, 'taker', NOW - 10_000, '30.1'),
  order(3, 'maker', NOW - 60_000, '30.52'),
  order(2, 'taker', NOW - 300_000, '57.803'),
  order(2, 'maker', NOW - 360_000, '57.803'),
  order(1, 'taker', NOW - 600_000, '57.803'),
  order(1, 'maker', NOW - 660_000, '57.803'),
];

function restingChild(over: Partial<TwapChildView> = {}): TwapChildView {
  return {
    id: CHILD_ID,
    mode: 'OPENING',
    slice: 3,
    makerLeg: 'a',
    side: 'BUY',
    restPrice: '1729.8',
    bestPrice: '1730.15',
    behindPct: 0.0002,
    repegRefused: null,
    ...over,
  };
}

function leg(name: string, side: 'LONG' | 'SHORT', filledQty: string, avgPrice: string | null, reduceOnly = false) {
  const exchange = name.toUpperCase();
  const quote = name === 'Hyperliquid' ? 'USDC' : 'USDT';
  return { name, exchange, side, filledQty, plannedQty: '693.64', avgPrice, symbol: `${exchange}_FUTURE_ETH_${quote}`, reduceOnly };
}

function job(over: Partial<RebalanceJob> = {}, twap: Partial<NonNullable<RebalanceJob['twap']>> = {}): RebalanceJob {
  return {
    id: 'job1',
    goal: 'even',
    route: 'mix',
    amount: 693.64,
    costUsd: null,
    target: null,
    status: 'running',
    stepIndex: 0,
    steps: [],
    fundsAt: 'CROSSEX',
    haltReason: null,
    createdAt: NOW - 900_000,
    updatedAt: NOW,
    inTransit: null,
    kind: 'twap',
    haltKind: null,
    twap: {
      slice: 3,
      of: 12,
      nextAt: NOW + 130_000,
      durationSec: 3_600,
      intervalSec: 300,
      startedAt: NOW - 600_000,
      carryQty: '0',
      behindQty: '0',
      makerLeg: 'a',
      repegBehindBp: 5,
      takerAfterSec: 240,
      ...twap,
    },
    child: restingChild(),
    legs: [leg('Gate', 'LONG', '146.12', '1729.84'), leg('Hyperliquid', 'SHORT', '146.12', '1730.21')],
    fees: { readUsd: 189, estUsd: 840, est: true },
    slippage: null,
    orders: ORDERS,
    ...over,
  } as RebalanceJob;
}

const paused = (over: Partial<RebalanceJob> = {}): RebalanceJob =>
  job({ status: 'halted', paused: true, child: null, ...over }, { nextAt: null });

function renderRun(j: RebalanceJob, now = NOW, deal = makeDealView({ pair: { id: CHILD_ID } })) {
  const repegs: { id: string; body: unknown }[] = [];
  server.use(
    http.get('/api/deals/:id', () => HttpResponse.json(env(deal))),
    http.post('/api/deals/:id/repeg', async ({ params, request }) => {
      repegs.push({ id: String(params.id), body: await request.json() });
      return HttpResponse.json(env({ id: String(params.id) }));
    }),
  );
  const view = renderWithClient(<RunView {...twapRunProps(j, now)} />);
  return { ...view, repegs };
}

const rowOf = (label: string): HTMLElement => screen.getByText(label).closest('div.flex.items-baseline') as HTMLElement;

describe('RunView, TWAP running', () => {
  it('slice and next slice rows', () => {
    renderRun(job());
    expect(screen.getByText('TWAP · ETH pair open')).toBeTruthy();
    expect(screen.getByText(/12 slices over 1h/)).toBeTruthy();
    expect(screen.getByText('Slippage so far')).toBeTruthy();
    expect(within(rowOf('Slice 3 of 12')).getByText('Est. about 47 min left')).toBeTruthy();
    expect(within(rowOf('Next slice in')).getByText('2m 10s')).toBeTruthy();
  });

  it('next slice from server time', () => {
    renderRun(job({}, { nextAt: NOW + 65_000 }), NOW);
    expect(within(rowOf('Next slice in')).getByText('1m 05s')).toBeTruthy();
  });

  it('a Delever halted at the Boros close shows the Boros row and the retry hold', () => {
    renderRun(
      job(
        {
          kind: 'delever',
          status: 'halted',
          haltKind: 'boros',
          boros: { refused: true, slice: 8, leftYu: 3.75, beforeYu: 900, nowYu: 873.75 },
          legs: [leg('Gate', 'LONG', '30', '1730', true), leg('Hyperliquid', 'SHORT', '30', '1730.2', true)],
        },
        {},
      ),
    );
    expect(within(rowOf('Boros')).getByText('900.00 → 873.75 YU')).toBeTruthy();
    expect(screen.getByText('Boros 3.75 YU not hedged')).toBeTruthy();
    expect(screen.getByText('Boros refused the close after slice 8.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Hold to retry closing 3.75 YU on Boros' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
  });

  it('a Delever shows the perps row from before and now', () => {
    const legWith = (name: string, side: 'LONG' | 'SHORT', now: string) => ({ ...leg(name, side, '26.25', '1730', true), beforeQty: '900', nowQty: now });
    renderRun(job({ kind: 'delever', legs: [legWith('Gate', 'LONG', '873.75'), legWith('Hyperliquid', 'SHORT', '873.75')] }));
    expect(within(rowOf('Perps · each leg')).getByText('900.00 → 873.75 ETH')).toBeTruthy();
    expect(screen.queryByText('Filled · each leg')).toBeNull();
  });

  it('a Delever without before and now keeps the filled rows', () => {
    renderRun(job({ kind: 'delever', legs: [leg('Gate', 'LONG', '26.25', '1730', true), leg('Hyperliquid', 'SHORT', '26.25', '1730', true)] }));
    expect(screen.queryByText('Perps · each leg')).toBeNull();
    expect(screen.getByText('Filled · each leg')).toBeTruthy();
  });

  it('filled each leg', () => {
    renderRun(job({ legs: [leg('Gate', 'LONG', '146.12', '1730'), leg('Hyperliquid', 'SHORT', '146.12', '1730.21')] }));
    expect(within(rowOf('Filled · each leg')).getByText('146.12 / 693.64 ETH ($252,788)')).toBeTruthy();
  });

  it('filled splits when legs differ', () => {
    renderRun(job({ legs: [leg('Gate', 'LONG', '177.61', '1730'), leg('Hyperliquid', 'SHORT', '173.41', '1730.3')] }));
    expect(screen.queryByText('Filled · each leg')).toBeNull();
    expect(screen.getByText('Filled · Gate')).toBeTruthy();
    expect(screen.getByText('Filled · Hyperliquid')).toBeTruthy();
  });

  it('avg price and not hedged rows', () => {
    renderRun(job({ legs: [leg('Gate', 'LONG', '146.54', '1729.84'), leg('Hyperliquid', 'SHORT', '146.12', '1730.21')] }));
    expect(within(rowOf('Avg price · Gate')).getByText('1,729.84')).toBeTruthy();
    expect(within(rowOf('Avg price · Hyperliquid')).getByText('1,730.21')).toBeTruthy();
    expect(within(rowOf('Not hedged now')).getByText('0.42 ETH ($727)')).toBeTruthy();
  });

  it('fee row', () => {
    renderRun(job());
    expect(within(rowOf('Fee so far')).getByText('$189 · est. $840')).toBeTruthy();
  });

  it('favorable is green', () => {
    renderRun(job());
    const value = screen.getByText(/Favorable/);
    expect(value.textContent).toBe('+0.37 (+0.021%) Favorable');
    expect(value.className).toContain('text-emerald-400');
  });

  it('adverse is red', () => {
    renderRun(job({ legs: [leg('Gate', 'LONG', '146.12', '1730.21'), leg('Hyperliquid', 'SHORT', '146.12', '1729.84')] }));
    const value = screen.getByText(/Adverse/);
    expect(value.textContent).toBe('−0.37 (−0.021%) Adverse');
    expect(value.className).toContain('text-rose-400');
  });

  it('graph while a slice rests', async () => {
    renderRun(job());
    const graph = await screen.findByTestId('book-graph');
    expect(graph.dataset.maker).toBe('GATE_FUTURE_ETH_USDT');
    expect(graph.dataset.hedge).toBe('BINANCE_FUTURE_ETH_USDT');
  });

  it('no graph when nothing rests', () => {
    for (const j of [paused(), job({ status: 'done', child: null }), job({ status: 'abandoned', child: null })]) {
      const { unmount } = renderRun(j);
      expect(screen.queryByTestId('book-graph')).toBeNull();
      expect(screen.queryByText('To best')).toBeNull();
      unmount();
    }
  });

  it('price box label for a bid', async () => {
    renderRun(job());
    expect(await screen.findByText('Slice 3 limit · Gate')).toBeTruthy();
    expect(screen.getByText('Best bid 1,730.15 · 0.02% behind')).toBeTruthy();
  });

  it('price box label for an ask', async () => {
    renderRun(job({ child: restingChild({ side: 'SELL', bestPrice: '1730.16', behindPct: 0.0001 }) }));
    expect(await screen.findByText('Best ask 1,730.16 · 0.01% behind')).toBeTruthy();
  });

  it('to best posts repeg', async () => {
    const { repegs } = renderRun(job());
    fireEvent.click(await screen.findByText('To best'));
    await waitFor(() => expect(repegs).toHaveLength(1));
    expect(repegs[0]).toEqual({ id: CHILD_ID, body: {} });
  });

  it('orders folded by default', () => {
    renderRun(job());
    expect(screen.getByText('Orders 6')).toBeTruthy();
    expect(screen.queryByText('Market hedge · 3')).toBeNull();
  });

  it('orders table newest first', () => {
    renderRun(job());
    fireEvent.click(screen.getByText('Orders 6'));
    const rows = screen.getAllByRole('row');
    expect(within(rows[0]!).getByText('Venue')).toBeTruthy();
    expect(within(rows[0]!).getByText('Order')).toBeTruthy();
    expect(within(rows[0]!).getByText('Size')).toBeTruthy();
    expect(within(rows[0]!).getByText('Filled')).toBeTruthy();
    expect(within(rows[0]!).getByText('State')).toBeTruthy();
    expect(within(rows[1]!).getByText('Market hedge · 3')).toBeTruthy();
    expect(within(rows[2]!).getByText('Limit 1,729.80 · 3')).toBeTruthy();
    expect(within(rows[2]!).getByText('Open')).toBeTruthy();
    expect(within(rows[6]!).getByText('Limit 1,729.80 · 1')).toBeTruthy();
  });

  it('footer lines', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    renderRun(job());
    expect(screen.getByText('Runs in the app on this computer. Closing this view does not stop it.')).toBeTruthy();
    expect(screen.getByText('Keeps this Mac awake until it ends. Closing the lid still sleeps it.')).toBeTruthy();
  });

  it('behind row', () => {
    renderRun(job({ child: restingChild({ slice: 5 }) }, { slice: 5, takerAfterSec: null, behindQty: '21.4' }));
    expect(within(rowOf('Behind · each leg')).getByText('21.40 ETH')).toBeTruthy();
  });

  it('rest row after the last slice', () => {
    const legs = [leg('Gate', 'LONG', '672.24', '1729.9'), leg('Hyperliquid', 'SHORT', '672.24', '1730.2')];
    renderRun(job({ legs, child: restingChild({ slice: 12 }) }, { slice: 12, nextAt: null, takerAfterSec: null }));
    expect(within(rowOf('Slice 12 of 12')).getByText('Limit resting · no market order')).toBeTruthy();
    expect(within(rowOf('Rest')).getByText('21.40 ETH resting until filled')).toBeTruthy();
  });

  it('refused re-peg line', () => {
    const child = restingChild({ makerLeg: 'b', side: 'SELL', repegRefused: { kind: 'order-allowance', at: NOW - 5_000 } });
    renderRun(job({ child }, { makerLeg: 'b', takerAfterSec: null }));
    expect(screen.getByText('Re-peg refused by Hyperliquid · resting at 1,729.80')).toBeTruthy();
  });

  it('delever twap shows graph and price box', async () => {
    renderRun(job({ kind: 'delever', legs: [], orders: [] }));
    expect(await screen.findByTestId('book-graph')).toBeTruthy();
    expect(await screen.findByText('Slice 3 limit · Gate')).toBeTruthy();
    expect(screen.getByText('To best')).toBeTruthy();
  });
});

describe('RunView, TWAP paused and ended', () => {
  it('pausing line', () => {
    renderRun(job({ pauseRequested: true }));
    expect(screen.getByText('Pausing: cancelling the slice 3 limit and hedging what filled')).toBeTruthy();
    expect(screen.queryByTestId('book-graph')).toBeNull();
  });

  it('paused rows', () => {
    renderRun(paused());
    expect(screen.getByText('Paused at slice 3 of 12')).toBeTruthy();
    expect(within(rowOf('On Resume')).getByText('9 slices, every 5m')).toBeTruthy();
    expect(screen.getByText('Resume')).toBeTruthy();
    expect(screen.getByText('Hold to stop')).toBeTruthy();
  });

  it('restart line', () => {
    renderRun(paused({ paused: false, haltKind: 'restart', updatedAt: at(14, 13) }));
    expect(
      screen.getByText('The app restarted at 14:13. Slice 3 stopped: its rest is cancelled and what filled is hedged.'),
    ).toBeTruthy();
  });

  it('sleep line', () => {
    renderRun(paused({ paused: false, haltKind: 'sleep', sleptFrom: at(14, 11), sleptTo: at(14, 51), updatedAt: at(14, 51) }));
    expect(
      screen.getByText('This Mac slept from 14:11 to 14:51. Slice 3 stopped: its rest is cancelled and what filled is hedged.'),
    ).toBeTruthy();
  });

  it('refused slice line', () => {
    renderRun(paused({ paused: false, haltKind: 'refused', haltReason: 'Gate refused slice 4: not enough margin' }));
    expect(screen.getByText('Gate refused slice 4: not enough margin')).toBeTruthy();
    expect(screen.getByText('Add USDT to Gate CrossEx, then resume.')).toBeTruthy();
  });

  const hedgeRefused = () =>
    paused({
      paused: false,
      haltKind: 'hedge-margin',
      haltReason: 'Hyperliquid refused the hedge in slice 4',
      legs: [leg('Gate', 'LONG', '177.61', '1730'), leg('Hyperliquid', 'SHORT', '173.41', '1730.3')],
    });

  it('hedge refused lines', () => {
    renderRun(hedgeRefused());
    expect(screen.getByText('Hyperliquid refused the hedge in slice 4')).toBeTruthy();
    expect(screen.getByText('4.20 ETH not hedged ($7,266)')).toBeTruthy();
    expect(screen.getByText('Add USDT to Hyperliquid on CrossEx to hedge')).toBeTruthy();
  });

  it('hedge refused offers two holds', () => {
    renderRun(hedgeRefused());
    expect(screen.getByText('Hold to open Hyperliquid Short 4.20 ETH at market')).toBeTruthy();
    expect(screen.getByText('Hold to close Gate Long 4.20 ETH at market')).toBeTruthy();
    expect(screen.queryByText('Resume')).toBeNull();
  });

  it('stopped rows', () => {
    const legs = [leg('Gate', 'LONG', '289.02', '1729.96'), leg('Hyperliquid', 'SHORT', '289.02', '1730.3')];
    renderRun(job({ status: 'abandoned', child: null, legs }, { slice: 5, nextAt: null }));
    expect(screen.getByText('Stopped at slice 5 of 12')).toBeTruthy();
    expect(within(rowOf('Opened · each leg')).getByText('289.02 / 693.64 ETH')).toBeTruthy();
    expect(within(rowOf('Not opened · each leg')).getByText('404.62 ETH')).toBeTruthy();
    expect(screen.queryByText('Hold to stop')).toBeNull();
  });

  it('done rows', () => {
    const legs = [leg('Gate', 'LONG', '693.64', '1730.02'), leg('Hyperliquid', 'SHORT', '693.64', '1730.35')];
    renderRun(
      job(
        { status: 'done', child: null, legs, fees: { readUsd: 861, estUsd: 0, est: false }, updatedAt: NOW },
        { slice: 12, nextAt: null, startedAt: NOW - 3_720_000 },
      ),
    );
    expect(within(rowOf('Opened · each leg')).getByText('693.64 ETH ($1,200,011)')).toBeTruthy();
    expect(screen.getByText('Avg price · Gate')).toBeTruthy();
    expect(screen.getByText('Slippage')).toBeTruthy();
    expect(within(rowOf('Fees')).getByText('$861')).toBeTruthy();
    expect(within(rowOf('Took')).getByText('1h 02m')).toBeTruthy();
  });
});
