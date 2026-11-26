import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import type { RebalanceJob, RebalanceView } from '../api/types';
import { fmtUsd, num } from '../lib/fmt';
import { accountBodies, accountHandler, REBALANCE_NOW, rebalanceViews, transferHandler, transferViews, whaleRebalanceViews } from '../test/fixtures';
import { env, server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { JobChip, RebalanceJobView } from './RebalanceJobView';

const MARKS = [
  { symbol: 'HYPERLIQUID_FUTURE_ETH_USDC', markPrice: '3200' },
  { symbol: 'HYPERLIQUID_FUTURE_BTC_USDC', markPrice: '90000' },
  { symbol: 'GATE_FUTURE_BTC_USDT', markPrice: '90000' },
];

function show(view: RebalanceView, over: Partial<RebalanceJob> = {}) {
  const posts: { path: string; body: unknown }[] = [];
  server.use(
    transferHandler(transferViews.spotZero),
    accountHandler(accountBodies.accountA),
    http.get('/api/positions', () => HttpResponse.json(env({ positions: MARKS, exposure: [] }))),
    http.post('/api/rebalance/:id/:cmd', async ({ request, params }) => {
      posts.push({ path: `${String(params.id)}/${String(params.cmd)}`, body: await request.json() });
      return HttpResponse.json(env(view.job));
    }),
  );
  const job = { ...view.job!, ...over };
  const onTab = vi.fn();
  renderWithClient(
    <RebalanceJobView job={job} view={{ ...view, job }} now={REBALANCE_NOW} holdMs={50} onResume={vi.fn()} onAbandon={vi.fn()} onTab={onTab} />,
  );
  return { job, onTab, posts };
}

const hold = (name: RegExp | string) => fireEvent.pointerDown(screen.getByRole('button', { name }));

describe('RebalanceJobView, sliced runs', () => {
  it('move header names tab and goal', () => {
    const word = { repay: 'Clear debt', even: 'Balance positions', custom: 'Custom amount' };
    for (const view of [rebalanceViews.moveRunning, rebalanceViews.moveStopped, rebalanceViews.moveDone]) {
      show(view);
      expect(screen.getByText(`Move cash · ${word[view.job!.goal]}`)).toBeInTheDocument();
      cleanup();
    }
  });

  it('slice counter', () => {
    show(rebalanceViews.ownerRealizeRunning, { slice: { index: 6, count: 14, sizeUsd: 25_000 } });
    expect(screen.getByText('Slice 6 of 14')).toBeInTheDocument();
    expect(screen.getByText('Est. about 45 min left')).toBeInTheDocument();
  });

  it('realized and not hedged now', async () => {
    const { job } = show(rebalanceViews.ownerRealizeRunning);
    const net = job.realize!.legs.reduce((sum, leg) => sum + leg.realizedUsd, 0) - job.feeSoFarUsd!;
    expect(screen.getByText(`${num(net, 0)} of ${num(job.amount, 0)} USDC`)).toBeInTheDocument();
    expect(screen.getByText('Not hedged now')).toBeInTheDocument();
    expect(await screen.findByText('3.9 ETH ($12,480)')).toBeInTheDocument();
  });

  it('pause after this slice is a click', async () => {
    const { job, posts } = show(rebalanceViews.ownerRealizeRunning);
    expect(job.estimate!.totalUsd).not.toBe(job.estimate!.feeUsd);
    expect(screen.getByText('Fee so far')).toBeInTheDocument();
    expect(screen.getByText(`${fmtUsd(job.feeSoFarUsd!)} · est. ${fmtUsd(job.estimate!.totalUsd)}`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pause after this slice' }));
    await waitFor(() => expect(posts.map((p) => p.path)).toEqual(['acct0001/pause']));
  });

  it('pausing shows the slice it stops after', () => {
    show(rebalanceViews.realizePausing);
    expect(screen.getByText('Pausing after slice 1 of 2')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pause after this slice' })).not.toBeInTheDocument();
  });

  it('paused realize view', () => {
    show(rebalanceViews.realizePaused, { slice: { index: 6, count: 14, sizeUsd: 25_000 } });
    expect(screen.getByText('Paused after slice 6 of 14')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Abandon' })).toBeInTheDocument();
  });

  it('missed follow shows holds', async () => {
    const { posts } = show(rebalanceViews.realizeFollowMissed);
    expect(within(screen.getByRole('alert')).getByText('3.9 ETH not hedged · reopen not filled yet')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Hold to reopen at limit $3,192.00' })).toBeInTheDocument();
    hold('Hold to reopen Hyperliquid Short 3.9 ETH at market');
    await waitFor(() => expect(posts).toEqual([{ path: 'acct0001/fix', body: { action: 'market' } }]));
    hold('Hold to reopen at limit $3,192.00');
    await waitFor(() => expect(posts[1]).toEqual({ path: 'acct0001/fix', body: { action: 'limit' } }));
  });

  it('margin halt shows today\'s text', () => {
    show(rebalanceViews.realizeStoppedMargin);
    const box = screen.getByRole('alert');
    expect(within(box).getByText('Not enough margin, and no cash left to convert. Move USDT into USDT · CrossEx, then Resume.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Hold to reopen/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument();
  });

  it('not hedged halt view', async () => {
    show(rebalanceViews.realizeStoppedNotHedged);
    const box = screen.getByRole('alert');
    expect(box.className).toContain('alert-red');
    expect(within(box).getByText('3.9 ETH not hedged')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hold to reopen Hyperliquid Short 3.9 ETH at market' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Hold to reopen at limit $3,192.00' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hold to abandon' })).toBeInTheDocument();
    expect(screen.getByText('Abandon leaves the short 3.9 ETH smaller.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument();
  });

  it('realize done receipt', () => {
    const { job } = show(rebalanceViews.ownerRealizeDone);
    const net = job.realize!.legs.reduce((sum, leg) => sum + leg.realizedUsd, 0) - job.totalCostUsd!;
    expect(screen.getByText(`Realized ${num(net, 0)} USDC`)).toBeInTheDocument();
    expect(screen.getByText('Total cost')).toBeInTheDocument();
    expect(screen.getByText(`${fmtUsd(job.totalCostUsd!)} (est. ${fmtUsd(job.estimate!.totalUsd)})`)).toBeInTheDocument();
  });

  it('realize done shows no Pair PnL row', () => {
    show(rebalanceViews.ownerRealizeDone);
    expect(screen.queryByText('Pair PnL')).not.toBeInTheDocument();
  });

  it('realize done next move cash', () => {
    const { onTab } = show(rebalanceViews.ownerRealizeDone);
    const next = screen.getByRole('button', { name: 'Next: Move cash' });
    expect(next).toHaveClass('btn-primary');
    fireEvent.click(next);
    expect(onTab).toHaveBeenCalledWith('move');
  });

  it('delever running legs', () => {
    show(rebalanceViews.deleverRunning);
    expect(screen.getByText('Perps · slice 20 of 65')).toBeInTheDocument();
    expect(screen.getByText(/^900(\.0+)? → 847\.18 BTC each$/)).toBeInTheDocument();
    expect(screen.getByText(/^900(\.0+)? → 720(\.0+)? YU · closes after perps$/)).toBeInTheDocument();
    expect(screen.getByText(/^Delever BTC · \S+ \/ \S+$/)).toBeInTheDocument();
  });

  it('delever running figures', async () => {
    const { job } = show(rebalanceViews.deleverRunning);
    expect(await screen.findByText(/^Not hedged now max 2\.7778 BTC \(\$250,000\) per slice$/)).toBeInTheDocument();
    expect(screen.getByText('IM used · CrossEx')).toBeInTheDocument();
    expect(screen.getByText('86.2% now · 74.2% at end')).toBeInTheDocument();
    expect(screen.getByText(`${fmtUsd(job.feeSoFarUsd!)} · est. ${fmtUsd(job.estimate!.feeUsd)}`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause after this slice' })).toBeInTheDocument();
  });

  it('a TWAP job renders the run view with its slice', () => {
    show(rebalanceViews.deleverRunning, {
      kind: 'twap',
      twap: { slice: 3, of: 12, nextAt: REBALANCE_NOW + 130_000, durationSec: 3600, intervalSec: 300, startedAt: REBALANCE_NOW - 600_000, carryQty: '0', behindQty: '0', makerLeg: 'a', repegBehindBp: 5, takerAfterSec: 240 },
    });
    expect(screen.getByText('Slice 3 of 12')).toBeInTheDocument();
    expect(screen.getByText('Next slice in')).toBeInTheDocument();
  });

  it('delever running max not hedged reads the slice qty the server sends', async () => {
    const view = rebalanceViews.deleverRunning;
    show({ ...view, job: { ...view.job!, slice: { ...view.job!.slice!, qty: 2.5 } } });
    expect(await screen.findByText(/^Not hedged now max 2\.5(0+)? BTC \(\$225,000\) per slice$/)).toBeInTheDocument();
  });

  it('delever boros gap on pause', async () => {
    const { posts } = show(rebalanceViews.deleverPausedGap);
    const box = screen.getByRole('alert');
    expect(box.className).toContain('alert-red');
    expect(within(box).getByText('Boros 52.82 YU has no perp behind it')).toBeInTheDocument();
    expect(within(box).getByText('Paused after slice 19 of 65')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resume' }).className).not.toContain('btn-primary');
    hold('Hold to close 52.82 YU on Boros');
    await waitFor(() => expect(posts).toEqual([{ path: 'delv0001/fix', body: { action: 'boros-retry' } }]));
  });

  it('boros part fill holds', async () => {
    const { posts } = show(rebalanceViews.deleverStoppedBoros);
    expect(within(screen.getByRole('alert')).getByText(/^Boros 36(\.0+)? YU not hedged$/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hold to abandon' })).toBeInTheDocument();
    hold(/^Hold to retry closing 36(\.0+)? YU on Boros$/);
    await waitFor(() => expect(posts).toEqual([{ path: 'delv0001/fix', body: { action: 'boros-retry' } }]));
    hold(/^Hold to add 36(\.0+)? BTC back on both perps$/);
    await waitFor(() => expect(posts[1]).toEqual({ path: 'delv0001/fix', body: { action: 'add-back' } }));
  });

  it('delever done receipt', () => {
    const { job } = show(rebalanceViews.deleverDone);
    expect(screen.getByText(/^Hyperliquid Long · Gate Short 900(\.0+)? → 720(\.0+)? BTC each$/)).toBeInTheDocument();
    expect(screen.getByText(/^Boros 900(\.0+)? → 720(\.0+)? YU$/)).toBeInTheDocument();
    expect(screen.getByText('IM used · CrossEx')).toBeInTheDocument();
    expect(screen.getByText('91.2% → 74.2%')).toBeInTheDocument();
    expect(screen.getByText('Delever 20.0%')).toBeInTheDocument();
    expect(screen.getByText('Total cost')).toBeInTheDocument();
    expect(screen.getByText(`${fmtUsd(job.totalCostUsd!)} (est. ${fmtUsd(job.estimate!.totalUsd)})`)).toBeInTheDocument();
  });

  it('delever done next', () => {
    const { onTab } = show(rebalanceViews.deleverDone);
    fireEvent.click(screen.getByRole('button', { name: 'Next: Move cash' }));
    expect(onTab).toHaveBeenCalledWith('move');
    cleanup();
    show({ ...rebalanceViews.deleverDone, buckets: rebalanceViews.deleverDone.buckets.map((b) => ({ ...b, borrow: 0 })) });
    expect(screen.queryByRole('button', { name: 'Next: Move cash' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('abandoned delever keeps the boros gap and the close hold', async () => {
    const { posts } = show(rebalanceViews.deleverPausedGap, { status: 'abandoned', paused: false });
    expect(within(screen.getByRole('alert')).getByText('Boros 52.82 YU has no perp behind it')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument();
    hold('Hold to close 52.82 YU on Boros');
    await waitFor(() => expect(posts).toEqual([{ path: 'delv0001/fix', body: { action: 'boros-retry' } }]));
  });

  const unhedged: Partial<RebalanceJob> = {
    paused: false,
    haltReason: 'Reopen not filled.',
    notHedgedQty: 0.5,
    follow: { symbol: 'GATE_FUTURE_BTC_USDT', exchange: 'GATE', side: 'BUY', qty: 0.5, reduceOnly: true },
  };

  it('halted delever with a perp not hedged also shows the boros gap and its close hold', async () => {
    const { posts } = show(rebalanceViews.deleverPausedGap, unhedged);
    expect(screen.getByText(/^0\.5(0+)? BTC not hedged$/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Hold to close Gate Short 0\.5(0+)? BTC at market$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hold to abandon' })).toBeInTheDocument();
    expect(screen.getByText('Boros 52.82 YU has no perp behind it')).toBeInTheDocument();
    hold('Hold to close 52.82 YU on Boros');
    await waitFor(() => expect(posts).toEqual([{ path: 'delv0001/fix', body: { action: 'boros-retry' } }]));
  });

  it('abandoned delever with a perp not hedged keeps only the boros close hold', () => {
    show(rebalanceViews.deleverPausedGap, { ...unhedged, status: 'abandoned' });
    expect(screen.getByText('Boros 52.82 YU has no perp behind it')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hold to close 52.82 YU on Boros' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /at market$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Hold to reopen at limit|^Hold to close at limit/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Hold to abandon' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('a part add-back shows the add-back hold and Hold to abandon, and no Boros retry', async () => {
    const job = rebalanceViews.deleverStoppedBoros.job!;
    const steps = job.steps.map((step) =>
      step.name === 'Close Boros'
        ? { ...step, addBack: { qty: 36, legs: [{ symbol: 'GATE_FUTURE_BTC_USDT', filled: 36 }, { symbol: 'HYPERLIQUID_FUTURE_BTC_USDC', filled: 0 }] } }
        : step,
    );
    const { posts } = show(rebalanceViews.deleverStoppedBoros, { steps });
    expect(screen.queryByRole('button', { name: /^Hold to retry closing/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hold to abandon' })).toBeInTheDocument();
    hold(/^Hold to add back Hyperliquid 36(\.0+)? BTC$/);
    await waitFor(() => expect(posts).toEqual([{ path: 'delv0001/fix', body: { action: 'add-back' } }]));
  });

  it('a part add-back names each perp size, and an even add-back keeps each', () => {
    const view = rebalanceViews.deleverStoppedBoros;
    const withFills = (gate: number, hl: number) =>
      view.job!.steps.map((step) =>
        step.name === 'Close Boros'
          ? { ...step, addBack: { qty: 36, legs: [{ symbol: 'GATE_FUTURE_BTC_USDT', filled: gate }, { symbol: 'HYPERLIQUID_FUTURE_BTC_USDC', filled: hl }] } }
          : step,
      );
    show(view, { steps: withFills(36, 12) });
    const split = screen.getByText(/^Perps \S+ [\d,.]+ BTC, \S+ [\d,.]+ BTC · Boros [\d,.]+ YU$/);
    const sizes = [...split.textContent!.matchAll(/([\d,.]+) BTC/g)].map((m) => Number(m[1].replace(/,/g, '')));
    expect(Math.abs(sizes[0] - sizes[1])).toBeCloseTo(24, 6);
    expect(screen.queryByText(/ each · Boros/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Hold to add back Hyperliquid 24(\.0+)? BTC$/ })).toBeInTheDocument();
    cleanup();
    show(view, { steps: withFills(12, 12) });
    expect(screen.getByText(/^Perps [\d,.]+ BTC each · Boros [\d,.]+ YU$/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Hold to add 24(\.0+)? BTC back on both perps$/ })).toBeInTheDocument();
  });

  it('boros part fill shows the filled-of line', () => {
    show(rebalanceViews.deleverStoppedBoros);
    expect(within(screen.getByRole('alert')).getByText(/^Boros filled \S+ of \S+ YU$/)).toBeInTheDocument();
  });

  it('pause and not-hedged chips', () => {
    const paused = rebalanceViews.realizePaused.job!;
    renderWithClient(<JobChip job={{ ...paused, notHedgedQty: 0, borosGapYu: 0, borosLeftYu: 0 }} />);
    expect(screen.getByText('Paused')).toBeInTheDocument();
    cleanup();
    renderWithClient(<JobChip job={rebalanceViews.deleverStoppedBoros.job!} />);
    expect(screen.getByText('Not hedged')).toBeInTheDocument();
  });

  it('done chip', () => {
    for (const view of [rebalanceViews.moveDone, rebalanceViews.ownerRealizeDone, rebalanceViews.deleverDone, rebalanceViews.balancedDone]) {
      renderWithClient(<JobChip job={view.job!} />);
      expect(screen.getByText('Done')).toBeInTheDocument();
      cleanup();
    }
  });

  it('margin halt reads the halt kind', async () => {
    show(rebalanceViews.realizeStoppedNotHedged, { haltKind: 'margin' });
    expect(screen.queryByRole('button', { name: /^Hold to reopen/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument();
    cleanup();
    show(rebalanceViews.realizeStoppedMargin, { haltKind: 'not-hedged' });
    expect(await screen.findByRole('button', { name: 'Hold to reopen at limit $3,192.00' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument();
  });

  it('realized and total cost come from the job', () => {
    const view = rebalanceViews.ownerRealizeRunning;
    const leg = view.job!.realize!.legs[0]!;
    show(view, { realize: { legs: [{ ...leg, realizedUsd: 1_000 }] }, feeSoFarUsd: 40, totalCostUsd: null });
    expect(screen.getByText('960 of 7,128 USDC')).toBeInTheDocument();
    cleanup();
    show(view, { realize: { legs: [{ ...leg, realizedUsd: 1_000 }] }, feeSoFarUsd: 40, totalCostUsd: 55 });
    expect(screen.getByText('945 of 7,128 USDC')).toBeInTheDocument();
    cleanup();
    show(rebalanceViews.ownerRealizeDone, { totalCostUsd: null });
    expect(screen.queryByText(/^Total cost/)).not.toBeInTheDocument();
  });

  it('delever im used now starts at the start reading', () => {
    show(rebalanceViews.deleverRunning, { imUsedNow: null });
    expect(screen.getByText('91.2% now · 74.2% at end')).toBeInTheDocument();
  });

  it('delever missed follow says close', async () => {
    const { job, posts } = show(rebalanceViews.deleverRunning, { followMisses: 3 });
    const follow = job.follow!;
    const followLeg = job.delever!.legs.find((l) => l.exchange === follow.exchange)!;
    const venue = follow.exchange === 'GATE' ? 'Gate' : 'Hyperliquid';
    const side = followLeg.side === 'LONG' ? 'Long' : 'Short';
    expect(within(screen.getByRole('alert')).getByText(/^[\d.,]+ BTC not hedged · close not filled yet$/)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /^Hold to close at limit \$[\d,.]+$/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reopen/ })).not.toBeInTheDocument();
    hold(new RegExp(`^Hold to close ${venue} ${side} [\\d.,]+ BTC at market$`));
    await waitFor(() => expect(posts).toEqual([{ path: 'delv0001/fix', body: { action: 'market' } }]));
  });

  it.each([
    [
      'realize',
      whaleRebalanceViews.realizeRunning,
      `${num(whaleRebalanceViews.realizeRunning.job!.realize!.legs.reduce((sum, leg) => sum + leg.realizedUsd, 0) - (whaleRebalanceViews.realizeRunning.job!.feeSoFarUsd ?? 0), 0)} of 5,965,174 USDC`,
    ],
    ['delever', whaleRebalanceViews.deleverRunning, /^66\.7\d* → .+ BTC each$/],
  ])('the %s run reads at $6M', (_name, view, line) => {
    show(view);
    expect(screen.getByText(line)).toBeInTheDocument();
  });
});
