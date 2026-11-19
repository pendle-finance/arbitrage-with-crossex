import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { PositionsResponse, RebalanceView } from '../api/types';
import { accountBodies, accountHandler, rebalanceViews, transferHandler, transferViews } from '../test/fixtures';
import { env, server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { RebalanceModal } from './RebalanceModal';

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

const hold = () => screen.getByRole('button', { name: /^Hold to rebalance/ });

const follows = (first: Node, second: Node): boolean => (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

describe('RebalanceModal hold', () => {
  it('refused realize offers the plain move', () => {
    show(rebalanceViews.refusedMargin);
    const title = screen.getByText('Not enough margin to reopen.');
    expect(screen.getByText('Add USDT to USDT · CrossEx, then try again.')).toBeInTheDocument();
    expect(follows(screen.getByText('How it runs'), title)).toBe(true);
    expect(screen.queryByText(/^Realize .+ of profit$/)).toBeNull();
    expect(screen.getByText('Total cost')).toBeInTheDocument();
    expect(follows(title, screen.getByText('Total cost'))).toBe(true);
    expect(hold()).toBeEnabled();
  });

  it('total cost and the hold stay in a sticky footer', () => {
    show(rebalanceViews.ownerBook);
    const footer = hold().closest('.sticky');
    expect(footer).not.toBeNull();
    expect(within(footer as HTMLElement).getByText('Total cost')).toBeInTheDocument();
  });

  it.each(['accountA', 'hyperliquidFreeBorrow'] as const)('a move with no interest shows no nothing-to-move line on %s', (key) => {
    show(rebalanceViews[key]);
    expect(hold()).toBeInTheDocument();
    expect(screen.queryByText('No interest yet. Nothing to move.')).toBeNull();
  });

  it('no fee rate shows why', () => {
    const plan = rebalanceViews.refusedMargin.plans.even;
    const refused = { ...plan, realize: { legs: plan.realize!.legs, refused: { reason: 'no-fee-rate' as const, bp: null, maxBp: 25 } } };
    show({ ...rebalanceViews.refusedMargin, plans: { ...rebalanceViews.refusedMargin.plans, even: refused } });
    const title = screen.getByText('Fee rate not loaded.');
    expect(screen.getByText('Profit stays open. The cash move runs without it.')).toBeInTheDocument();
    expect(follows(screen.getByText('How it runs'), title)).toBe(true);
    expect(screen.queryByText(/^Realize .+ of profit$/)).toBeNull();
    expect(hold()).toBeEnabled();
  });

  it('price impact keeps its hover', async () => {
    const user = userEvent.setup();
    show(rebalanceViews.ownerBook);
    const footer = hold().closest('.sticky') as HTMLElement;
    const trigger = within(footer).getByText('Price impact');
    const card = await waitFor(async () => {
      if (!screen.queryByRole('tooltip')) {
        await user.unhover(trigger);
        await user.hover(trigger);
      }
      return screen.getByRole('tooltip');
    });
    expect(card).toHaveTextContent('Not a fee. USDC bought above $1 or sold below it on Gate spot, and depth taken past the top of the book.');
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
    expect(screen.getByText('Done. This is what each wallet holds now.')).toBeInTheDocument();
  });

  it('a running job that finishes with the modal open shows Done, not the picker', async () => {
    serve();
    renderWithClient(<Polled views={[rebalanceViews.accountARunning, rebalanceViews.convertDone]} />);
    await act(async () => poll());
    expect(screen.queryByRole('button', { name: 'Custom amount' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Refresh route' })).toBeNull();
    expect(screen.getByText('Done. This is what each wallet holds now.')).toBeInTheDocument();
  });
});
