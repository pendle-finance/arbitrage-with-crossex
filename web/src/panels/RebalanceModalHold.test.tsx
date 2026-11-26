import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { PositionsResponse, RebalanceView } from '../api/types';
import { accountBodies, accountHandler, rebalanceViews, transferHandler, transferViews } from '../test/fixtures';
import { env, server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { RebalanceModal } from './RebalanceModal';
import { RebalanceModalFooter } from './RebalanceModalFooter';

const NO_POSITIONS: PositionsResponse = { positions: [], exposure: [] };

function serve() {
  server.use(
    transferHandler(transferViews.spotZero),
    accountHandler(accountBodies.accountA),
    http.get('/api/positions', () => HttpResponse.json(env(NO_POSITIONS))),
  );
}

function show(view: RebalanceView) {
  serve();
  renderWithClient(<RebalanceModal view={view} onClose={vi.fn()} />);
}

let poll: () => void = () => {};

function Polled({ views }: { views: RebalanceView[] }) {
  const [index, setIndex] = useState(0);
  poll = () => setIndex(1);
  return <RebalanceModal view={views[index]} onClose={vi.fn()} />;
}

const hold = () => screen.getByRole('button', { name: /^Hold to (rebalance|clear debt|move)/ });

describe('RebalanceModal hold', () => {
  it.each(['accountA', 'hyperliquidFreeBorrow'] as const)('a move with no interest shows no nothing-to-move line on %s', (key) => {
    show(rebalanceViews[key]);
    expect(hold()).toBeInTheDocument();
    expect(screen.queryByText('No interest yet. Nothing to move.')).toBeNull();
  });


  it('route head keeps its hover', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.ownerBook);
    const trigger = await screen.findByText('Route');
    const card = await waitFor(async () => {
      if (!screen.queryByRole('tooltip')) {
        await user.unhover(trigger);
        await user.hover(trigger);
      }
      return screen.getByRole('tooltip');
    });
    expect(card).toHaveTextContent('How the money moves. Fee includes Gate fees and the spot spread.');
  });

  it('a convert landing with the modal open shows the job', async () => {
    const done = rebalanceViews.convertDone;
    serve();
    renderWithClient(<Polled views={[{ ...done, job: { ...done.job!, status: 'running' } }, done]} />);
    await act(async () => poll());
    expect(screen.queryByRole('button', { name: 'Refresh route' })).toBeNull();
    expect(screen.getByText(/^Moved \$/)).toBeInTheDocument();
    expect(screen.queryByText(/what each wallet holds/)).toBeNull();
  });

  it('a running job that finishes with the modal open shows Done, not the picker', async () => {
    serve();
    renderWithClient(<Polled views={[rebalanceViews.accountARunning, rebalanceViews.convertDone]} />);
    await act(async () => poll());
    expect(screen.queryByRole('radio', { name: 'Custom amount' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Refresh route' })).toBeNull();
    expect(screen.getByText(/^Moved \$/)).toBeInTheDocument();
    expect(screen.queryByText(/what each wallet holds/)).toBeNull();
  });
});

describe('RebalanceModalFooter', () => {
  const footer = (over: { quoteStale?: boolean; lock?: string | null }) =>
    renderWithClient(
      <RebalanceModalFooter
        rows={[]} holdLabel="Hold to move 3,000 USDC" optional={false} stale={false} pricing={false} disabled={false}
        lock={over.lock ?? null} quoteStale={over.quoteStale} onRefresh={vi.fn()} onConfirm={vi.fn()}
      />,
    );

  it('a stale quote turns the hold into Refresh quote', () => {
    const onRefresh = vi.fn();
    renderWithClient(
      <RebalanceModalFooter
        rows={[]} holdLabel="Hold to move 3,000 USDC" optional={false} stale={false} pricing={false} disabled={false}
        lock={null} quoteStale onRefresh={onRefresh} onConfirm={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Hold to move 3,000 USDC' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh quote' }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it('a running job draws the waits line in place of the hold', () => {
    footer({ lock: 'New deals and transfers wait until it ends.', quoteStale: true });
    expect(screen.getByText('New deals and transfers wait until it ends.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Hold to/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Refresh quote' })).toBeNull();
  });
});
