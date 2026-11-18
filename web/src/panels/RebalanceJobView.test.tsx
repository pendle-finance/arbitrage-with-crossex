import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import type { RealizeJobLeg, RebalanceJob, RebalanceStep } from '../api/types';
import { accountBodies, accountHandler, REBALANCE_NOW, rebalanceViews, transferHandler, transferViews } from '../test/fixtures';
import { env, server } from '../test/server';
import { renderWithClient } from '../test/utils';
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

  it('receipt fees come from the job, and an old job file shows none', () => {
    render(rebalanceViews.realizeDone.job!);
    expect(screen.queryByText(/^Fee \$/)).not.toBeInTheDocument();
  });
});
