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
    renderRun(job({}, { takerAfterSec: 120 }));
    expect(screen.getByText('TWAP · ETH pair open')).toBeTruthy();
    expect(screen.getByText(/12 slices over 1h/)).toBeTruthy();
    expect(screen.getByText('Slippage so far')).toBeTruthy();
    expect(within(rowOf('Slice 3 of 12')).getByText('Est. about 44 min left')).toBeTruthy();
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
    expect(within(rowOf('Boros')).getByText('900.00 → 873.75 YU · closes after each slice')).toBeTruthy();
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
    expect(screen.getByText('Closed · each leg')).toBeTruthy();
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
    expect(within(rowOf('Fee so far')).getByText('$1,029 ($189 from Gate, $840 estimated)')).toBeTruthy();
  });

  it('a filled slice with no fee read yet shows the estimate, not $0', () => {
    renderRun(job({ fees: { readUsd: 0, estUsd: 0.139, totalUsd: 0.139, est: true } }));
    expect(within(rowOf('Fee so far')).getByText('$0.14 estimated')).toBeTruthy();
  });

  it('time left counts to the last slice start plus the taker wait', () => {
    renderRun(job({}, { slice: 1, of: 2, durationSec: 300, intervalSec: 150, nextAt: NOW + 117_000, takerAfterSec: null }));
    expect(within(rowOf('Slice 1 of 2')).getByText('Est. about 2 min left')).toBeTruthy();
  });

  it('a progress bar shows how much each leg has filled', () => {
    renderRun(job());
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('21');
  });

  it('pause stacks above hold to stop, full width, at one height', () => {
    renderRun(job());
    const pause = screen.getByRole('button', { name: 'Pause' });
    const stop = screen.getByRole('button', { name: 'Hold to stop' });
    expect(pause.parentElement).toBe(stop.parentElement);
    expect(pause.parentElement?.className).toContain('flex-col');
    expect(pause.parentElement?.className).not.toContain('grid-cols-2');
    expect(pause.compareDocumentPosition(stop) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(pause.className.split(' ')).toContain('btn');
    expect(stop.className).toContain('h-9');
    expect(stop.className).toContain('!text-[12px]');
  });

  it('the slippage label carries a hover with its unit', async () => {
    renderRun(job());
    fireEvent.mouseEnter(screen.getByText('Slippage so far'));
    expect(await screen.findByText('Gap between the two average prices, in USDT per coin. Above zero is in your favor.')).toBeTruthy();
  });

  it('favorable is green', () => {
    renderRun(job());
    const value = screen.getByText(/Favorable/);
    expect(value.textContent).toBe('+0.37 USDT per coin (+0.021%) Favorable');
    expect(value.className).toContain('text-emerald-400');
  });

  it('adverse is red', () => {
    renderRun(job({ legs: [leg('Gate', 'LONG', '146.12', '1730.21'), leg('Hyperliquid', 'SHORT', '146.12', '1729.84')] }));
    const value = screen.getByText(/Adverse/);
    expect(value.textContent).toBe('−0.37 USDT per coin (−0.021%) Adverse');
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

  it('a refused re-peg on the last slice says no limit rests', () => {
    const legs = [leg('Gate', 'LONG', '672.24', '1729.9'), leg('Hyperliquid', 'SHORT', '672.24', '1730.2')];
    const child = restingChild({ slice: 12, repegRefused: { kind: 'order-allowance', at: NOW - 5_000 } });
    renderRun(job({ legs, child }, { slice: 12, nextAt: null, takerAfterSec: null }));
    expect(screen.getByText('Re-peg refused by Gate · no order resting · price moves again in 1 min')).toBeTruthy();
    expect(within(rowOf('Slice 12 of 12')).getByText('No market order')).toBeTruthy();
    expect(within(rowOf('Rest')).getByText('21.40 ETH')).toBeTruthy();
    expect(screen.queryByText(/Limit resting|resting until filled/)).toBeNull();
  });

  it('a refused re-peg on the last slice with a taker step shows no resting label', () => {
    const child = restingChild({ slice: 12, repegRefused: { kind: 'order-allowance', at: NOW - 5_000 } });
    renderRun(job({ child }, { slice: 12, nextAt: null }));
    expect(screen.queryByText(/Limit resting/)).toBeNull();
  });

  it('refused re-peg line', () => {
    const child = restingChild({ makerLeg: 'b', side: 'SELL', repegRefused: { kind: 'order-allowance', at: NOW - 5_000 } });
    renderRun(job({ child }, { makerLeg: 'b', takerAfterSec: null }));
    expect(screen.getByText('Re-peg refused by Hyperliquid · no order resting · price moves again in 1 min')).toBeTruthy();
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

  it('one slice left on resume says "1 slice", not "1 slices"', () => {
    renderRun(job({ status: 'halted', paused: true, child: null }, { slice: 11, of: 12, nextAt: null }));
    expect(within(rowOf('On Resume')).getByText('1 slice, every 5m')).toBeTruthy();
  });

  it('before the first fill there is no average price, and no empty dollar brackets', () => {
    const { container } = renderRun(
      job({ legs: [leg('Gate', 'LONG', '0', null), leg('Hyperliquid', 'SHORT', '0', null)], orders: [] }),
    );
    expect(container.textContent).toContain('0.00 / 693.64 ETH');
    expect(container.textContent).not.toContain('()');
  });

  it('restart line', () => {
    renderRun(paused({ paused: false, haltKind: 'restart', updatedAt: at(14, 13) }));
    expect(document.querySelector('.alert-amber')).not.toBeNull();
    expect(document.querySelector('.alert-red')).toBeNull();
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
    expect(screen.getByText('Gate refused slice 4: not enough margin').closest('.alert-red')).not.toBeNull();
    expect(screen.getByText('Add USDT to Gate CrossEx, then resume.')).toBeTruthy();
  });

  it('a rest wholly under a venue minimum says Resume cannot send it and offers only Stop', () => {
    const reason = "Rest 0.006 ETH is under Binance's $20 minimum. Resume cannot send it. Stop ends the run.";
    const sizeRefusal = { slice: 3, venue: 'Binance', limit: '$20', bound: 'min' as const, wholeRest: true };
    renderRun(paused({ paused: false, haltKind: 'refused', haltReason: reason, sizeRefusal }));
    expect(screen.getByText(reason).closest('.alert-red')).not.toBeNull();
    expect(screen.queryByText('Resume re-plans the rest.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Hold to stop' })).toBeTruthy();
  });

  it('a margin refusal on Hyperliquid asks for USDC', () => {
    const legs = [leg('Hyperliquid', 'LONG', '146.12', '1730'), leg('Gate', 'SHORT', '146.12', '1730.2')];
    renderRun(paused({ paused: false, haltKind: 'refused', haltReason: 'Hyperliquid refused slice 4: not enough margin', legs }));
    expect(screen.getByText('Add USDC to Hyperliquid CrossEx, then resume.')).toBeTruthy();
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
    expect(screen.getByText('Add USDC to Hyperliquid on CrossEx to hedge')).toBeTruthy();
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
        { status: 'done', child: null, legs, fees: { readUsd: 861, estUsd: 0, totalUsd: 861, est: false }, updatedAt: NOW },
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

describe('RunView, fix round', () => {
  const closeLegs = (a: string, b: string) => [leg('Gate', 'LONG', a, '1730', true), leg('Hyperliquid', 'SHORT', b, '1730.3', true)];

  it('hedge refused on a close names the order each hold sends', () => {
    renderRun(paused({ paused: false, haltKind: 'hedge-margin', haltReason: 'Hyperliquid refused the hedge in slice 4', legs: closeLegs('177.61', '173.41') }));
    const holds = screen.getAllByRole('button').map((b) => b.textContent ?? '').filter((text) => text.includes('at market'));
    expect(holds).toEqual(['Hold to close Hyperliquid Short 4.20 ETH at market', 'Hold to open Gate Long 4.20 ETH at market']);
  });

  it('a close run reads Closed per leg', () => {
    renderRun(job({ legs: closeLegs('146.12', '140') }));
    expect(screen.getByText('Closed · Gate')).toBeTruthy();
    expect(screen.getByText('Closed · Hyperliquid')).toBeTruthy();
    expect(screen.queryByText('Filled · Gate')).toBeNull();
  });

  it('a size refusal does not ask for USDT', () => {
    renderRun(paused({ paused: false, haltKind: 'refused', haltReason: "Slice 7 is under Binance's $50 minimum" }));
    expect(screen.getByText("Slice 7 is under Binance's $50 minimum")).toBeTruthy();
    expect(screen.getByText('Resume re-plans the rest.')).toBeTruthy();
    expect(screen.queryByText(/^Add USDT/)).toBeNull();
  });

  it('paused rows carry since and left each leg', () => {
    renderRun(paused());
    expect(within(rowOf('Paused at slice 3 of 12')).getByText('Since 14:20')).toBeTruthy();
    expect(within(rowOf('Left · each leg')).getByText('547.52 ETH')).toBeTruthy();
  });

  it('next slice waits for the live slice', () => {
    renderRun(job({ child: restingChild({ mode: 'CONVERTING' }) }, { nextAt: null }));
    expect(within(rowOf('Next slice')).getByText('after slice 3 ends')).toBeTruthy();
  });

  it('capped rest is a Rest row, with no On Resume row', () => {
    const legs = closeLegs('690.64', '690.64');
    renderRun(job({ status: 'halted', child: null, haltKind: 'capped-rest', haltReason: '3 ETH not closed', legs }, { slice: 12, nextAt: null, behindQty: '3' }));
    expect(within(rowOf('Rest')).getByText('3.00 ETH not closed')).toBeTruthy();
    expect(screen.queryByText('On Resume')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a Delever run says Delever and that Boros closes after each slice', () => {
    const legs = closeLegs('26.25', '26.25');
    renderRun(job({ kind: 'delever', legs, boros: { beforeYu: 900, nowYu: 873.75, leftYu: 0, refused: false, slice: 7 } }));
    expect(screen.getByText('Delever ETH · Gate / Hyperliquid')).toBeTruthy();
    expect(within(rowOf('Boros')).getByText('900.00 → 873.75 YU · closes after each slice')).toBeTruthy();
  });

  it('keep-awake line off macOS', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32');
    renderRun(job());
    expect(screen.getByText('Keep this computer awake until it ends.')).toBeTruthy();
    expect(screen.queryByText(/Keeps this Mac awake/)).toBeNull();
  });

  it('a sleep over days names the dates', () => {
    renderRun(paused({ paused: false, haltKind: 'sleep', sleptFrom: at(14, 11) - 2 * 86_400_000, sleptTo: at(14, 51), updatedAt: at(14, 51) }));
    expect(screen.getByText(/^This Mac slept from 23 Nov 14:11 to 25 Nov 14:51\./)).toBeTruthy();
  });
});

describe('RunView, own account line', () => {
  const NOTE = "This TWAP runs on this terminal's Gate account.";
  const A = '0x1111111111111111111111111111111111111111';
  const B = '0x2222222222222222222222222222222222222222';
  const agent = (root: string | null) =>
    http.get('/api/boros/agent', () =>
      HttpResponse.json(env({ configured: root !== null, root, rootMasked: null, accountId: 1, expiry: null, expired: false, canProvision: true, approval: 'approved' })),
    );

  afterEach(() => localStorage.clear());

  it('shows in view-only mode', async () => {
    localStorage.setItem('crossex.strategy.v1', JSON.stringify({ address: B, walletUpgraded: true }));
    server.use(agent(A));
    renderRun(job());
    expect(await screen.findByText(NOTE)).toBeTruthy();
  });

  it('shows when logged out', async () => {
    server.use(agent(null));
    renderRun(job());
    expect(await screen.findByText(NOTE)).toBeTruthy();
  });

  it('is absent in normal mode', async () => {
    localStorage.setItem('crossex.strategy.v1', JSON.stringify({ address: A, walletUpgraded: true }));
    server.use(agent(A));
    renderRun(job());
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(NOTE)).toBeNull();
  });
});
