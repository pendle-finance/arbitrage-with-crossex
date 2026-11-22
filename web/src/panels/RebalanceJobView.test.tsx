import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import type { RealizeJobLeg, RebalanceJob, RebalanceStep, RebalanceView } from '../api/types';
import { fmtUsd, num } from '../lib/fmt';
import { accountBodies, accountHandler, auditRebalanceViews, REBALANCE_NOW, rebalanceViews, transferHandler, transferViews, whaleRebalanceViews } from '../test/fixtures';
import { env, server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { openGapOf } from './rebalanceCardGap';
import { convertsOf, lastRealizeIndex } from './rebalanceJobSteps';
import { JobChip, RebalanceJobView } from './RebalanceJobView';

const FEES: Partial<RealizeJobLeg> = {
  closeFeeUsd: 51.2,
  reopenFeeUsd: 51.19,
  closeImpactUsd: 9.44,
  reopenImpactUsd: 9.44,
  convert: { amount: 10298, feeUsd: 20.6 },
};

function scaled(job: RebalanceJob, by: number, leg: Partial<RealizeJobLeg>, steps: Partial<Record<string, Partial<RebalanceStep>>> = {}): RebalanceJob {
  const at = (value: number | null | undefined) => (typeof value === 'number' ? value * by : value);
  return {
    ...job,
    realize: {
      legs: job.realize!.legs.map((l) => ({
        ...l,
        positionQty: l.positionQty * by,
        qty: l.qty * by,
        filledQty: l.filledQty * by,
        realizedUsd: l.realizedUsd * by,
        ...leg,
      })),
    },
    steps: job.steps.map((step) => {
      const over = steps[step.name] ?? {};
      return step.perp || step.name === 'Convert' ? { ...step, planned: at(step.planned) ?? null, qty: at(step.qty) ?? null, ...over } : step;
    }),
  };
}

function render(job: RebalanceJob) {
  server.use(
    transferHandler(transferViews.spotZero),
    accountHandler(accountBodies.accountA),
    http.get('/api/positions', () => HttpResponse.json(env({ positions: [], exposure: [] }))),
  );
  const view = { ...rebalanceViews.realizeDone, job };
  renderWithClient(<RebalanceJobView job={job} view={view} now={REBALANCE_NOW} onResume={vi.fn()} onAbandon={vi.fn()} />);
}

describe('RebalanceJobView', () => {
  it.each([
    [1 / 4000, 'Fee $0.03', '+ $0.00 price impact'],
    [1, 'Fee $122.99', '+ $18.88 price impact'],
    [30, 'Fee $3,689.70', '+ $566.40 price impact'],
  ])('receipt fees come from the job at %o of the owner leg', (by, fee, impact) => {
    const job = scaled(rebalanceViews.realizeDone.job!, by, {
      closeFeeUsd: 51.2 * by,
      reopenFeeUsd: 51.19 * by,
      closeImpactUsd: 9.44 * by,
      reopenImpactUsd: 9.44 * by,
      convert: { amount: 10298 * by, feeUsd: 20.6 * by },
    });
    render(job);
    expect(screen.getByText(fee)).toBeInTheDocument();
    if (by >= 1) expect(screen.getByText(impact)).toBeInTheDocument();
  });

  it('receipt fees come from the job, scaled to a part fill', () => {
    const job = scaled(rebalanceViews.realizeDone.job!, 1, { ...FEES, filledQty: 30, realizedUsd: 19173 }, {
      Close: { qty: 30 },
      Convert: { planned: 5742, qty: 5742 },
      Reopen: { qty: 30 },
    });
    render(job);
    expect(screen.getByText('Fee $68.58')).toBeInTheDocument();
    expect(screen.getByText('+ $10.53 price impact')).toBeInTheDocument();
  });

  it('a done reopen short by a dust rest shows the rest on the receipt', async () => {
    const job = auditRebalanceViews.realizeDoneShortReopen.job!;
    render(job);
    const line = await screen.findByText('Hyperliquid short 0.01 ETH smaller');
    expect(line.className).toContain('text-gold');
    expect(openGapOf(job)).toBeNull();
  });

  it('receipt fees come from the job, and an old job file shows none', () => {
    const job = rebalanceViews.realizeDone.job!;
    const legs = job.realize!.legs.map(({ symbol, base, exchange, pool, side, positionQty, qty, filledQty, realizedUsd }) => ({
      symbol, base, exchange, pool, side, positionQty, qty, filledQty, realizedUsd,
    }));
    render({ ...job, realize: { legs } });
    expect(screen.queryByText(/^Fee \$/)).not.toBeInTheDocument();
    expect(screen.queryByText('Fee')).not.toBeInTheDocument();
  });

  it.each([
    ['owner', rebalanceViews.realizeDone.job!, '$127.27', '$108.39', '$18.88'],
    ['whale', whaleRebalanceViews.realizeWhaleDone.job!, '$27,743.20', '$23,892.90', '$3,850.30'],
  ])('total cost parts add up to the total on the %s fixture', (_name, job, total, fee, impact) => {
    render(job);
    const card = screen.getByText('Total cost').closest('.card') as HTMLElement;
    const value = (label: string) => within(card).getByText(label).closest('div')!.lastElementChild!.textContent;
    expect(value('Total cost')).toBe(total);
    expect(value('Fee')).toBe(fee);
    expect(value('Price impact')).toBe(impact);
    const cents = (text: string) => Math.round(Number(text.replace(/[$,]/g, '')) * 100);
    expect(cents(fee) + cents(impact)).toBe(cents(total));
  });

  it('the stop box says the gap once', () => {
    const job = {
      ...rebalanceViews.realizeHaltedLegOpen.job!,
      haltReason:
        'Gate refused the reopen. Some raw Gate text. The Hyperliquid short is 53.8 ETH smaller than the Gate long. Resume to try again, or close 53.8 ETH of the Gate long in Positions.',
    };
    render(job);
    const box = screen.getByRole('alert');
    expect(within(box).getAllByText(/smaller than the/)).toHaveLength(1);
    expect(within(box).getByText('Gate refused the reopen.')).toBeInTheDocument();
    expect(within(box).getByText('Resume to try again, or close 53.8 ETH of the Gate long in Positions.')).toBeInTheDocument();
  });

  it('the started line and the actions toggle use tabular figures', () => {
    render(rebalanceViews.realizeLegClosed.job!);
    expect(screen.getByText(/^Started /)).toHaveClass('num');
    cleanup();
    render(rebalanceViews.realizeDone.job!);
    expect(screen.getByRole('button', { name: '3 actions' })).toHaveClass('num');
  });

  it('a convert sent before the reopen and looked up after it stays in step 1', () => {
    const done = rebalanceViews.realizeDone.job!;
    const [close, convert, reopen, ...route] = done.steps;
    const deferred = { ...convert!, status: 'pending' as const, qty: null, doneAt: null, quoteId: 'q1' };
    const job: RebalanceJob = { ...done, status: 'running', stepIndex: 2, steps: [close!, reopen!, deferred, ...route.map((s) => ({ ...s, status: 'pending' as const, qty: null, doneAt: null, startedAt: null }))] };
    expect(lastRealizeIndex(job)).toBe(2);
    expect(convertsOf(job, job.realize!.legs[0]!)).toEqual([deferred]);
    render(job);
    expect(screen.getByText(/^Realizing .+ of profit$/)).toBeInTheDocument();
    expect(screen.getByText('Move the other 27,228 USDC')).toBeInTheDocument();
  });

  it('a finished deferred convert on a convert route stays in step 1 when the job marks phases', () => {
    const done = rebalanceViews.realizeDone.job!;
    const [close, convert, reopen, ...route] = done.steps;
    const deferred = { ...convert!, quoteId: 'q1' };
    const routeConvert = { ...convert!, quoteId: 'q2', planned: 27228, qty: 27222 };
    const steps = [close!, reopen!, deferred, routeConvert, ...route];
    const unmarked: RebalanceJob = { ...done, route: 'convert', stepIndex: steps.length - 1, steps };
    expect(lastRealizeIndex(unmarked)).toBe(1);
    const marked: RebalanceJob = { ...unmarked, steps: steps.map((step, index) => ({ ...step, phase: index < 3 ? 'realize' : 'route' })) };
    expect(lastRealizeIndex(marked)).toBe(2);
    expect(convertsOf(marked, marked.realize!.legs[0]!)).toEqual([marked.steps[2]]);
  });

  it.each([
    ['owner', rebalanceViews.realizeDone.job!, 12.34, '$127.27', '$96.05', '$31.22'],
    ['whale', whaleRebalanceViews.realizeWhaleDone.job!, 100, '$27,743.20', '$23,792.90', '$3,950.30'],
  ])('route price impact counts in Price impact, not Fee, on the %s fixture', (_name, job, routeImpactUsd, total, fee, impact) => {
    render({ ...job, routeImpactUsd });
    const card = screen.getByText('Total cost').closest('.card') as HTMLElement;
    const value = (label: string) => within(card).getByText(label).closest('div')!.lastElementChild!.textContent;
    expect(value('Total cost')).toBe(total);
    expect(value('Fee')).toBe(fee);
    expect(value('Price impact')).toBe(impact);
    const cents = (text: string) => Math.round(Number(text.replace(/[$,]/g, '')) * 100);
    expect(cents(fee) + cents(impact)).toBe(cents(total));
  });
});

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
    expect(screen.getByText(`Realized ${num(net, 0)} of ${num(job.amount, 0)} USDC`)).toBeInTheDocument();
    expect(await screen.findByText('Not hedged now 3.9 ETH ($12,480)')).toBeInTheDocument();
  });

  it('fee so far and pause hold', async () => {
    const { job, posts } = show(rebalanceViews.ownerRealizeRunning);
    expect(job.estimate!.totalUsd).not.toBe(job.estimate!.feeUsd);
    expect(screen.getByText(`Fee so far ${fmtUsd(job.feeSoFarUsd!)} · est. total ${fmtUsd(job.estimate!.totalUsd)}`)).toBeInTheDocument();
    hold('Hold to pause after this slice');
    await waitFor(() => expect(posts.map((p) => p.path)).toEqual(['acct0001/pause']));
  });

  it('pausing shows the slice it stops after', () => {
    show(rebalanceViews.realizePausing);
    expect(screen.getByText('Pausing after slice 1 of 2')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Hold to pause after this slice' })).not.toBeInTheDocument();
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
    expect(screen.getByText(`Total cost ${fmtUsd(job.totalCostUsd!)} (est. ${fmtUsd(job.estimate!.totalUsd)})`)).toBeInTheDocument();
  });

  it('realize done pair pnl', () => {
    show(rebalanceViews.ownerRealizeDone);
    const row = screen.getByText('Pair PnL').parentElement!;
    expect(row).toHaveTextContent('Pair PnLUnchanged, except cost');
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
    expect(screen.getByText(/^Perps · slice 20 of 65 900(\.0+)? → 847\.18 BTC each$/)).toBeInTheDocument();
    expect(screen.getByText(/^Boros 900(\.0+)? → 720(\.0+)? YU · closes after perps$/)).toBeInTheDocument();
    expect(screen.getByText(/^Delever BTC · \S+ \/ \S+$/)).toBeInTheDocument();
  });

  it('delever running figures', async () => {
    const { job } = show(rebalanceViews.deleverRunning);
    expect(await screen.findByText(/^Not hedged now max 2\.7778 BTC \(\$250,000\) per slice$/)).toBeInTheDocument();
    expect(screen.getByText('IM used · CrossEx 86.2% now · 74.2% at end')).toBeInTheDocument();
    expect(screen.getByText(`Fee so far ${fmtUsd(job.feeSoFarUsd!)} · Est. fee ${fmtUsd(job.estimate!.feeUsd)}`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hold to pause after this slice' })).toBeInTheDocument();
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
    hold(/^Hold to retry closing 36(\.0+)? YU on Boros$/);
    await waitFor(() => expect(posts).toEqual([{ path: 'delv0001/fix', body: { action: 'boros-retry' } }]));
    hold(/^Hold to add 36(\.0+)? BTC back on both perps$/);
    await waitFor(() => expect(posts[1]).toEqual({ path: 'delv0001/fix', body: { action: 'add-back' } }));
  });

  it('delever done receipt', () => {
    const { job } = show(rebalanceViews.deleverDone);
    expect(screen.getByText(/^Hyperliquid Long · Gate Short 900(\.0+)? → 720(\.0+)? BTC each$/)).toBeInTheDocument();
    expect(screen.getByText(/^Boros 900(\.0+)? → 720(\.0+)? YU$/)).toBeInTheDocument();
    expect(screen.getByText('IM used · CrossEx 91.2% → 74.2%')).toBeInTheDocument();
    expect(screen.getByText('Delever 20.0%')).toBeInTheDocument();
    expect(screen.getByText(`Total cost ${fmtUsd(job.totalCostUsd!)} (est. ${fmtUsd(job.estimate!.totalUsd)})`)).toBeInTheDocument();
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
    expect(screen.getByText('Realized 960 of 7,128 USDC')).toBeInTheDocument();
    cleanup();
    show(view, { realize: { legs: [{ ...leg, realizedUsd: 1_000 }] }, feeSoFarUsd: 40, totalCostUsd: 55 });
    expect(screen.getByText('Realized 945 of 7,128 USDC')).toBeInTheDocument();
    cleanup();
    show(rebalanceViews.ownerRealizeDone, { totalCostUsd: null });
    expect(screen.queryByText(/^Total cost/)).not.toBeInTheDocument();
  });

  it('delever im used now starts at the start reading', () => {
    show(rebalanceViews.deleverRunning, { imUsedNow: null });
    expect(screen.getByText('IM used · CrossEx 91.2% now · 74.2% at end')).toBeInTheDocument();
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
      `Realized ${num(whaleRebalanceViews.realizeRunning.job!.realize!.legs.reduce((sum, leg) => sum + leg.realizedUsd, 0) - (whaleRebalanceViews.realizeRunning.job!.feeSoFarUsd ?? 0), 0)} of 5,965,174 USDC`,
    ],
    ['delever', whaleRebalanceViews.deleverRunning, /^Perps · slice \d+ of \d+ 66\.7\d* → .+ BTC each$/],
  ])('the %s run reads at $6M', (_name, view, line) => {
    show(view);
    expect(screen.getByText(line)).toBeInTheDocument();
  });
});
