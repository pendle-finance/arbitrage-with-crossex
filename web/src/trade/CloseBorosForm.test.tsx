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
    expect(await screen.findByText(/of what you asked for is still open/)).toBeInTheDocument();
    // …and the size is re-armed at the REMAINDER, so a second press cannot
    // re-send the amount that just half-filled.
    expect(screen.getByLabelText(/Close size for the .* Boros leg/)).toHaveValue('0.004');
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

/**
 * What the dialog SAYS once the close lands.
 *
 * `closed` is the venue going flat — `shortfall === 0 && size >= openSize`, an
 * exact comparison. Keying the done panel off it meant a close that did
 * exactly what was asked could still report itself unfinished: one small amber
 * line, the confirm button still armed at the same size, and "close again to
 * finish it" for a leg with nothing of the user's left in it. On a real-money
 * surface that is an invitation to send the order twice.
 */
describe('CloseBorosForm — saying that it landed', () => {
  const panel = () => screen.queryByText(/Leg closed\./);
  const armed = () => screen.queryByRole('button', { name: /Close leg/ });

  it('reports DONE when the request filled, even though the venue is not flat', async () => {
    // The reported case: 39 asked, 39 filled, 0 short — and `closed: false`,
    // because the live position carried a dust residual over the 39.
    server.use(
      ...ready(),
      closeReturns({ closed: false, fill: fill(MINE), openSize: MINE + 1e-12 }),
    );
    renderWithClient(<CloseBorosForm legs={[leg()]} />);
    await confirmClose();

    expect(await screen.findByText(/Leg closed\./)).toBeInTheDocument();
    // The confirm is GONE, replaced by Done — the whole point.
    expect(armed()).toBeNull();
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
    expect(screen.queryByText(/close again to finish it/i)).toBeNull();
  });

  it('does not call the user\'s OWN un-closed remainder somebody else\'s', async () => {
    // A deliberate partial of a sole-owned leg: close 0.004 of 0.01 and the
    // 0.006 left is entirely the user's. Reporting it as another position's
    // share is a falsehood about their own money, and the panel replaces the
    // form — so it also takes away the affordance to close it.
    server.use(...ready(), closeReturns({ closed: false, fill: fill(0.004), openSize: MINE }));
    renderWithClient(<CloseBorosForm legs={[{ ...leg(), notionalToken: MINE }]} />);
    // Ask for less than the whole share.
    fireEvent.change(screen.getByLabelText(/Close size for the .* Boros leg/), {
      target: { value: '0.004' },
    });
    await confirmClose();

    expect(await screen.findByText(/of this position is still open/)).toBeInTheDocument();
    expect(screen.queryByText(/not yours/)).toBeNull();
  });

  it('names the share another position holds instead of calling it unfinished', async () => {
    // A card closing its own 0.01 of a 0.03 leg satisfies its request and
    // leaves 0.02 open. That is somebody else's, and saying "close again to
    // finish it" would be telling this user to close it.
    server.use(...ready(), closeReturns({ closed: false, fill: fill(MINE), openSize: 0.03 }));
    renderWithClient(<CloseBorosForm legs={[leg()]} />);
    await confirmClose();

    expect(await screen.findByText(/Leg closed\./)).toBeInTheDocument();
    expect(screen.getByText(/another position's share of the same leg, not yours/)).toBeInTheDocument();
    expect(armed()).toBeNull();
  });

  it('keeps the confirm armed only when something of the user\'s is genuinely left', async () => {
    server.use(...ready(), closeReturns({ closed: false, fill: fill(0.006, 0.004) }));
    renderWithClient(<CloseBorosForm legs={[leg()]} />);
    await confirmClose();

    expect(await screen.findByText(/of what you asked for is still open/)).toBeInTheDocument();
    expect(panel()).toBeNull();
    expect(armed()).toBeInTheDocument();
  });
});
