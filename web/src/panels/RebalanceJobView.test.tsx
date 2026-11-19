import { cleanup, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import type { RealizeJobLeg, RebalanceJob, RebalanceStep } from '../api/types';
import { accountBodies, accountHandler, auditRebalanceViews, REBALANCE_NOW, rebalanceViews, transferHandler, transferViews, whaleRebalanceViews } from '../test/fixtures';
import { env, server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { openGapOf } from './rebalanceCardGap';
import { convertsOf, lastRealizeIndex } from './rebalanceJobSteps';
import { RebalanceJobView } from './RebalanceJobView';

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
