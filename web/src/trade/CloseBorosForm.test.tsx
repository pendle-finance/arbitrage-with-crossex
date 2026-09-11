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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BorosCancelAndCloseResult, StrategyLeg } from '../api/types';
import { STRATEGY_STORAGE_KEY } from '../panels/HomeControls';
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
    expect(screen.getByLabelText(/Close size, applied to both legs/)).toHaveValue('0.004');
  });

  it('reports a PARTIAL as a partial even though the venue client stamps it with a failure', async () => {
    // The real client sets `insufficient-depth` on EVERY short fill. 0.006 of
    // 0.01 coming off is a partial reduction, not a failed close — reported
    // red, the user would believe nothing happened.
    server.use(
      ...ready(),
      closeReturns({
        closed: false,
        fill: {
          ...fill(0.006, 0.004),
          failure: { code: 'insufficient-depth', message: 'Only 0.006 of 0.01 matched inside the rate bound.' },
        },
      }),
    );
    renderWithClient(<CloseBorosForm legs={[leg()]} />);
    await confirmClose();
    expect(await screen.findByText(/of what you asked for is still open/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Close size, applied to both legs/)).toHaveValue('0.004');
    expect(screen.queryByText(/Only 0.006 of 0.01 matched/)).not.toBeInTheDocument();
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
describe('CloseBorosForm — whose legs these are', () => {
  const ROOT = '0x1111111111111111111111111111111111111111';
  const OTHER = '0x2222222222222222222222222222222222222222';
  const agentFor = (root: string) =>
    http.get('/api/boros/agent', () => HttpResponse.json(env({ configured: true, expired: false, root })));

  it('refuses to close when the tracked address is not the account the agent signs for', async () => {
    localStorage.setItem('crossex.strategy.v1', JSON.stringify({ address: OTHER }));
    server.use(versionHandler(), agentFor(ROOT), closeReturns({}));
    renderWithClient(<CloseBorosForm legs={[leg()]} />);
    expect(await screen.findByText(/a different account from the one your agent key signs for/)).toBeInTheDocument();
    const btn = await screen.findByRole('button', { name: /Close leg/ });
    expect(btn).toBeDisabled();
    localStorage.clear();
  });

  it('names the account the close was sized against, so the server can refuse a mismatch too', async () => {
    localStorage.setItem('crossex.strategy.v1', JSON.stringify({ address: ROOT }));
    const seen: Array<{ address?: string }> = [];
    server.use(versionHandler(), agentFor(ROOT), closeReturns({ fill: fill(MINE) }, seen));
    renderWithClient(<CloseBorosForm legs={[leg()]} />);
    await confirmClose();
    await waitFor(() => expect(seen).toHaveLength(1), { timeout: 3_000 });
    expect(seen[0].address).toBe(ROOT);
    localStorage.clear();
  });
});

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
    fireEvent.change(screen.getByLabelText(/Close size, applied to both legs/), {
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

  it('refuses a slippage the quote endpoint would refuse — 10% is the cap everywhere', async () => {
    // The form used to accept up to 50% while /simulate rejects above 10%: every
    // quoted number went blank and the hold still sent that bound.
    server.use(...ready());
    renderWithClient(<CloseBorosForm legs={[leg()]} />);
    // The tolerance box sits behind the "Max: X%" toggle.
    fireEvent.click(await screen.findByRole('button', { name: /%$/ }));
    const slip = await screen.findByLabelText(/Close slippage tolerance/);
    fireEvent.change(slip, { target: { value: '20' } });
    expect(await screen.findByText(/slippage must be in \(0, 10\]/)).toBeInTheDocument();
    await waitFor(() => expect(armed()).toBeDisabled());
    fireEvent.change(slip, { target: { value: '5' } });
    await waitFor(() => expect(armed()).toBeEnabled());
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

/**
 * The $10 floor. Boros refuses an order worth that or less, and the close route
 * cancels every resting order on the market BEFORE it prices anything — so a
 * close that was always going to be refused still costs the user those orders.
 *
 * Read off the quote's gate rather than recomputed here: the server owns the
 * threshold, the collateral price and the "a flattening close is exempt" rule.
 */
describe('CloseBorosForm — the venue minimum', () => {
  const MATURITY = 1_800_000_000;

  // No tracked address means no quote at all, and then no gate to read.
  beforeEach(() => {
    window.localStorage.setItem(
      STRATEGY_STORAGE_KEY,
      JSON.stringify({ address: '0x1111111111111111111111111111111111111111' }),
    );
  });
  afterEach(() => window.localStorage.clear());

  const marketRow = (over: Record<string, unknown> = {}) => ({
    marketId: MARKET,
    name: 'Hyperliquid ETH',
    venue: 'Hyperliquid',
    base: 'ETH',
    tokenId: 2,
    collateral: 'ETH',
    maturity: MATURITY,
    midApr: 0.09,
    markApr: 0.09,
    isolatedOnly: false,
    onIsolatedMargin: false,
    isolatedHasPositionOrOrders: false,
    currentSize: 0,
    collateralPriceUsd: 2_460,
    ...over,
  });

  /** A partner sharing collateral and maturity, so the quote is eligible. */
  const quoting = (blockers: unknown[]) => [
    ...ready(),
    http.get('/api/boros/pair/context', () =>
      HttpResponse.json(
        env({
          markets: [marketRow(), marketRow({ marketId: MARKET + 1, name: 'Binance ETH' })],
          crossByToken: [{ tokenId: 2, available: 5 }],
          isolatedByMarket: [],
          defaultSlippageApr: 0.0025,
          maxSlippageApr: 0.1,
        }),
      ),
    ),
    http.post('/api/boros/pair/simulate', () =>
      HttpResponse.json(
        env({
          simulation: { legA: null, legB: null, collateralPriceUsd: 2_460 },
          gate: { blockers, warnings: [], requiresAcknowledgement: false, opposingLegs: [] },
          eligibility: { eligible: true, code: null, reason: null },
          simulatedAtMs: Date.now(),
          gasBalanceUsd: null,
        }),
      ),
    ),
  ];

  const belowMin = {
    code: 'below-min-order-value',
    leg: 'A',
    marketId: MARKET,
    message: 'Hyperliquid ETH: this leg is worth $2.46, and Boros takes nothing at or under $10 — increase the size.',
  };

  it("shows the server's own words and will not let the close through", async () => {
    server.use(...quoting([belowMin]));
    renderWithClient(<CloseBorosForm legs={[leg()]} />);
    expect(await screen.findByText(/worth \$2\.46/)).toBeInTheDocument();
    const btn = await screen.findByRole('button', { name: /Close leg/ });
    await waitFor(() => expect(btn).toBeDisabled());
  });

  it('ignores blockers about the synthetic partner leg', async () => {
    // The quote is a PAIR, so the gate also reports these about the zero-sized
    // partner. Neither describes this close, and neither may block it.
    server.use(
      ...quoting([
        { code: 'legs-do-not-offset', message: 'Both legs point the same way — flip one to trade a spread.' },
        { code: 'flip-unacknowledged', message: 'Tick the acknowledgement.' },
        { code: 'below-min-order-value', leg: 'B', marketId: MARKET + 1, message: 'partner leg is worth $0.00' },
      ]),
    );
    renderWithClient(<CloseBorosForm legs={[leg()]} />);
    const btn = await screen.findByRole('button', { name: /Close leg/ });
    await waitFor(() => expect(btn).toBeEnabled());
    expect(screen.queryByText(/flip one to trade a spread/)).not.toBeInTheDocument();
  });
});
