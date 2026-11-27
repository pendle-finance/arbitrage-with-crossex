import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import type { RebalanceJob, RebalanceView } from '../api/types';
import { accountBodies, accountHandler, REBALANCE_NOW, rebalanceViews, transferHandler, transferViews, whaleRebalanceViews } from '../test/fixtures';
import { env, server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { RebalanceJobView } from './RebalanceJobView';

const MARKS = [
  { symbol: 'HYPERLIQUID_FUTURE_BTC_USDC', markPrice: '90000' },
  { symbol: 'GATE_FUTURE_BTC_USDT', markPrice: '90000' },
];

function show(view: RebalanceView, over: Partial<RebalanceJob> = {}) {
  server.use(
    transferHandler(transferViews.spotZero),
    accountHandler(accountBodies.accountA),
    http.get('/api/positions', () => HttpResponse.json(env({ positions: MARKS, exposure: [] }))),
  );
  const job = { ...view.job!, ...over };
  renderWithClient(
    <RebalanceJobView job={job} view={{ ...view, job }} now={REBALANCE_NOW} holdMs={50} onResume={vi.fn()} onAbandon={vi.fn()} onTab={vi.fn()} />,
  );
  return job;
}

const sizesOf = (text: string): number[] => [...text.matchAll(/([\d,.]+) BTC/g)].map((m) => Number(m[1].replace(/,/g, '')));

function lagging(view: RebalanceView, lag: number): Partial<RebalanceJob> {
  const job = view.job!;
  const lead = job.realize!.legs[0]!;
  const other = job.delever!.legs.find((l) => l.symbol !== lead.symbol)!;
  return {
    paused: false,
    haltReason: 'Close not filled.',
    notHedgedQty: lag,
    follow: { symbol: other.symbol, exchange: other.exchange, side: other.side === 'LONG' ? 'SELL' : 'BUY', qty: lag, reduceOnly: true },
    steps: job.steps.map((step) => (step.name === 'Slices' ? { ...step, qty: lead.filledQty - lag } : step)),
  };
}

describe('SliceJobView, each perp from its own fills', () => {
  for (const [size, view, lag] of [
    ['900 BTC', rebalanceViews.deleverPausedGap, 0.5],
    ['66.7 BTC', whaleRebalanceViews.deleverPausedGap, 0.05],
  ] as const) {
    it(`a not-hedged Delever names each perp size when the follow leg lags (${size})`, () => {
      const job = show(view, lagging(view, lag));
      const lead = job.realize!.legs[0]!;
      const split = screen.getByText(/^\S+ [\d,.]+ BTC · \S+ [\d,.]+ BTC$/);
      const sizes = sizesOf(split.textContent!);
      const byLeg = job.delever!.legs.map((l) => l.before - (l.symbol === lead.symbol ? lead.filledQty : lead.filledQty - lag));
      expect(sizes[0]).toBeCloseTo(byLeg[0]!, 2);
      expect(sizes[1]).toBeCloseTo(byLeg[1]!, 2);
      expect(Math.abs(sizes[0]! - sizes[1]!)).toBeCloseTo(lag, 2);
      expect(screen.queryByText(/^[\d,.]+ BTC each$/)).toBeNull();
    });
  }
});

describe('SliceJobView, one order', () => {
  it('a one-order Delever shows no slice count and no Pause', () => {
    show(rebalanceViews.deleverRunning, { slice: { index: 1, count: 1, sizeUsd: 250_000 } });
    expect(screen.getByText('Perps')).toBeInTheDocument();
    expect(screen.queryByText(/slice 1 of 1/i)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pause after this slice' })).toBeNull();
  });

  it('a Delever in many slices keeps the count and Pause', () => {
    show(rebalanceViews.deleverRunning);
    expect(screen.getByText(/^Perps · slice \d+ of \d+$/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause after this slice' })).toBeInTheDocument();
  });

  it('a one-order Realize shows no Pause', () => {
    show(rebalanceViews.ownerRealizeRunning, { slice: { index: 1, count: 1, sizeUsd: 25_000 } });
    expect(screen.queryByRole('button', { name: 'Pause after this slice' })).toBeNull();
  });
});

describe('SliceJobView, a done Realize', () => {
  it('offers Next: Move cash only while a borrow is left', () => {
    const view = rebalanceViews.ownerRealizeDone;
    expect(view.buckets.some((bucket) => bucket.borrow > 0)).toBe(true);
    show({ ...view, buckets: view.buckets.map((bucket) => ({ ...bucket, borrow: 0 })) });
    expect(screen.queryByRole('button', { name: 'Next: Move cash' })).toBeNull();
  });

  it('keeps Next: Move cash with a borrow left', () => {
    show(rebalanceViews.ownerRealizeDone);
    expect(screen.getByRole('button', { name: 'Next: Move cash' })).toBeInTheDocument();
  });
});

describe('SliceJobView, a stopped Realize of a perp with no hedge', () => {
  const stopped = (hedge: string | null): Partial<RebalanceJob> => {
    const job = rebalanceViews.ownerRealizeRunning.job!;
    const lead = job.realize!.legs[0]!;
    return {
      status: 'halted',
      paused: false,
      haltKind: 'not-hedged',
      haltReason: 'Gate refused the reopen.',
      notHedgedQty: 0.2,
      unwindTarget: null,
      follow: { symbol: lead.symbol, exchange: lead.exchange, side: lead.side === 'SHORT' ? 'SELL' : 'BUY', qty: 0.2, reduceOnly: false },
      realize: { ...job.realize!, legs: [{ ...lead, hedge }, ...job.realize!.legs.slice(1)] },
    };
  };

  it('offers the hold that keeps the perp smaller', () => {
    show(rebalanceViews.ownerRealizeRunning, stopped(null));
    expect(screen.getByRole('button', { name: 'Hold to keep the Hyperliquid Short 0.2 ETH smaller' })).toBeInTheDocument();
  });

  it('offers no such hold when the perp has a hedge', () => {
    show(rebalanceViews.ownerRealizeRunning, stopped('GATE'));
    expect(screen.queryByRole('button', { name: /^Hold to keep the/ })).toBeNull();
  });
});
