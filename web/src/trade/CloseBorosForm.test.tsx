/**
 * What a Boros close tells the card it took off the venue.
 *
 * A card that states an absolute share of a leg has to hear its own close, or
 * the row goes on claiming the same size out of a smaller leg — taken from
 * whoever shares it. Unlike a perp close (which only knows the deal was
 * ACCEPTED), this route answers with the fill, so the number reported here is
 * what actually closed.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import type { BorosCancelAndCloseResult, StrategyLeg } from '../api/types';
import { makeStrategyLeg, versionHandler } from '../test/fixtures';
import { env, server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { CloseBorosForm } from './CloseBorosForm';

const MARKET = 190;
/** The card's own share of the market — the number a row would state. */
const MINE = 0.01;

const leg = (): StrategyLeg =>
  makeStrategyLeg({ marketId: MARKET, notionalToken: MINE, collateral: 'ETH' });

/** An approved agent and nothing else: the confirm gate gets its clearance,
 * the quote panel gets no context and simply shows no rate. */
const ready = () => [
  versionHandler(),
  http.get('/api/boros/agent', () =>
    HttpResponse.json(env({ configured: true, expired: false, address: '0xagent' })),
  ),
];

const closeReturns = (r: Partial<BorosCancelAndCloseResult>, seen?: unknown[]) =>
  http.post('/api/boros/pair/market/:id/cancel-and-close', async ({ request, params }) => {
    seen?.push(await request.json());
    return HttpResponse.json(
      env<BorosCancelAndCloseResult>({
        marketId: Number(params.id),
        cancelled: true,
        closed: true,
        fill: null,
        ...r,
      }),
    );
  });

const fill = (filledSize: number, shortfallSize = 0) => ({
  marketId: MARKET,
  direction: 'long' as const,
  filledSize,
  shortfallSize,
  execApr: 0.09,
  feeSize: 0,
  failure: null,
});

/** Hold the confirm through its 800ms gate. */
const confirmClose = async () => {
  const btn = await screen.findByRole('button', { name: /Close leg/ });
  await waitFor(() => expect(btn).toBeEnabled());
  fireEvent.pointerDown(btn);
};

describe('CloseBorosForm — reporting what it closed', () => {
  it('reports the filled size when the leg closes out', async () => {
    const closed: Array<[number, number]> = [];
    server.use(...ready(), closeReturns({ closed: true, fill: fill(MINE) }));
    renderWithClient(
      <CloseBorosForm legs={[leg()]} onClosed={(l, q) => closed.push([l.marketId!, q])} />,
    );
    await confirmClose();
    await waitFor(() => expect(closed).toEqual([[MARKET, MINE]]), { timeout: 3_000 });
  });

  it('reports what REALLY filled when the book ran short, not what was asked', async () => {
    // The whole point of reading the fill: shrinking the claim by the
    // requested size would hand away 0.004 that is still open.
    const closed: Array<[number, number]> = [];
    server.use(...ready(), closeReturns({ closed: false, fill: fill(0.006, 0.004) }));
    renderWithClient(
      <CloseBorosForm legs={[leg()]} onClosed={(l, q) => closed.push([l.marketId!, q])} />,
    );
    await confirmClose();
    await waitFor(() => expect(closed).toEqual([[MARKET, 0.006]]), { timeout: 3_000 });
    expect(await screen.findByText(/left\s+open/)).toBeInTheDocument();
  });

  it('says nothing when the venue rejected the close', async () => {
    // ⚠ A 200 is not a close. Reporting one here would shrink a claim on a
    // position that never moved.
    const closed: unknown[] = [];
    server.use(
      ...ready(),
      closeReturns({
        closed: false,
        fill: { ...fill(0), failure: { code: 'rate-deviation', message: 'rate moved too far' } },
      }),
    );
    renderWithClient(<CloseBorosForm legs={[leg()]} onClosed={() => closed.push(1)} />);
    await confirmClose();
    expect(await screen.findByText(/rate moved too far/)).toBeInTheDocument();
    expect(closed).toEqual([]);
  });

  it('says nothing when there was nothing open to close', async () => {
    const closed: unknown[] = [];
    server.use(...ready(), closeReturns({ cancelled: true, closed: false, fill: null }));
    renderWithClient(<CloseBorosForm legs={[leg()]} onClosed={() => closed.push(1)} />);
    await confirmClose();
    expect(await screen.findByText(/no open position to close/)).toBeInTheDocument();
    expect(closed).toEqual([]);
  });
});
