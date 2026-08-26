/**
 * Boros two-leg market ticket. The things worth pinning are the ones that stop
 * a user putting on the wrong exposure: the worst-case spread leads and moves
 * with the tolerance, ineligible markets stay visible WITH their reason, the
 * §4 acknowledgement gates confirm and retracts when the trade changes, and a
 * partial fill is reported as a residual rather than a success.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STRATEGY_STORAGE_KEY } from '../panels/HomeControls';
import { server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { BorosPairTicket } from './BorosPairTicket';
import { useTradeFlow, type BorosOpenPrefill } from './TradeFlow';

const ADDRESS = '0x1111111111111111111111111111111111111111';
const HL = 155;
const BN = 158;
const MATURITY = 1_800_000_000;

const env = <T,>(data: T) => ({ ok: true, data, meta: { ts: Date.now() } });

const marketRow = (over: Record<string, unknown> = {}) => ({
  marketId: HL,
  name: 'Hyperliquid ETH 31 Aug 2026',
  venue: 'Hyperliquid',
  base: 'ETH',
  tokenId: 3,
  collateral: 'USDT',
  maturity: MATURITY,
  midApr: 0.09,
  markApr: 0.09,
  isolatedOnly: false,
  onIsolatedMargin: false,
  isolatedHasPositionOrOrders: false,
  currentSize: 0,
  collateralPriceUsd: 1,
  ...over,
});

const context = (over: Record<string, unknown> = {}) => ({
  markets: [
    marketRow(),
    marketRow({ marketId: BN, name: 'Binance ETHUSDT 31 Aug 2026', venue: 'Binance', midApr: 0.045 }),
    // Same collateral, DIFFERENT maturity — must be listed but unselectable.
    marketRow({
      marketId: 300,
      name: 'Bybit ETH 30 Sep 2026',
      venue: 'Bybit',
      maturity: MATURITY + 86_400,
    }),
    // Same maturity, DIFFERENT collateral.
    marketRow({ marketId: 400, name: 'OKX BTC 31 Aug 2026', venue: 'OKX', base: 'BTC', tokenId: 1, collateral: 'BTC' }),
  ],
  crossByToken: [{ tokenId: 3, available: 500_000 }],
  isolatedByMarket: [],
  defaultSlippageApr: 0.0025,
  maxSlippageApr: 0.1,
  ...over,
});

const simLeg = (over: Record<string, unknown> = {}) => ({
  marketId: HL,
  marketName: 'Hyperliquid ETH 31 Aug 2026',
  venue: 'Hyperliquid',
  base: 'ETH',
  direction: 'short',
  execApr: 0.09,
  worstApr: 0.0875,
  estFillSize: 100_000,
  shortfallSize: 0,
  bookStatus: 'ok',
  marginRequired: 700,
  slippageApr: 0.0025,
  sizing: {
    currentSize: 0,
    deltaSize: -100_000,
    resultingSize: -100_000,
    opposing: false,
    flips: false,
    clampedToClose: false,
  },
  ...over,
});

const simulation = (over: Record<string, unknown> = {}) => ({
  legA: simLeg(),
  legB: simLeg({
    marketId: BN,
    marketName: 'Binance ETHUSDT 31 Aug 2026',
    venue: 'Binance',
    direction: 'long',
    execApr: 0.042,
    worstApr: 0.0445,
    marginRequired: 620,
    sizing: {
      currentSize: 0,
      deltaSize: 100_000,
      resultingSize: 100_000,
      opposing: false,
      flips: false,
      clampedToClose: false,
    },
  }),
  receiveLeg: 'A',
  estSpreadApr: 0.045,
  worstSpreadApr: 0.04,
  costToCrossSize: 8.2,
  feeDragApr: 0.003,
  marginRequiredTotal: 1_320,
  hedgedSize: 100_000,
  unhedgedSize: 0,
  collateral: 'USDT',
  collateralPriceUsd: 1,
  secondsToMaturity: 2_592_000,
  reasons: [],
  ...over,
});

/** Leg A 60k of 100k, leg B full — 40k surplus sitting on leg B. */
const partialExecute = () =>
  HttpResponse.json(
    env({
      result: {
        legA: { marketId: HL, direction: 'short', filledSize: 60_000, shortfallSize: 40_000, execApr: 0.089, feeSize: 2, failure: null },
        legB: { marketId: BN, direction: 'long', filledSize: 100_000, shortfallSize: 0, execApr: 0.042, feeSize: 4, failure: null },
        hedgedSize: 60_000,
        unhedgedSize: 40_000,
        unhedgedLeg: 'B',
        realisedSpreadApr: 0.044,
        partial: true,
        bothLegsSubmitted: true,
      },
      estimate: simulation(),
      warnings: [],
    }),
  );

const gate = (over: Record<string, unknown> = {}) => ({
  blockers: [],
  warnings: [],
  requiresAcknowledgement: false,
  opposingLegs: [],
  ...over,
});

/** Install the two reads the panel makes. `onSimulate` sees each request body. */
const agentStatus = (over: Record<string, unknown> = {}) => ({
  configured: true,
  root: ADDRESS,
  rootMasked: '0x1111…1111',
  accountId: 0,
  expiry: null,
  expired: false,
  canProvision: true,
  ...over,
});

function handlers(opts: {
  ctx?: Record<string, unknown>;
  sim?: Record<string, unknown>;
  gate?: Record<string, unknown>;
  onSimulate?: (body: Record<string, unknown>) => void;
  gasBalanceUsd?: number | null;
  agent?: Record<string, unknown>;
  simulatedAtMs?: number;
  execute?: () => Response | Promise<Response>;
  onExecute?: (body: Record<string, unknown>) => void;
} = {}) {
  return [
    http.get('/api/boros/agent', () => HttpResponse.json(env(agentStatus(opts.agent)))),
    http.get('/api/boros/pair/context', () => HttpResponse.json(env(context(opts.ctx)))),
    http.post('/api/boros/pair/simulate', async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      opts.onSimulate?.(body);
      return HttpResponse.json(
        env({
          simulation: simulation(opts.sim),
          gate: gate(opts.gate),
          eligibility: { eligible: true, code: null, reason: null },
          simulatedAtMs: opts.simulatedAtMs ?? Date.now(),
          gasBalanceUsd: opts.gasBalanceUsd ?? null,
        }),
      );
    }),
    http.post('/api/boros/pair/execute', async ({ request }) => {
      opts.onExecute?.((await request.json()) as Record<string, unknown>);
      if (opts.execute) return opts.execute();
      return HttpResponse.json(
        env({
          result: {
            legA: { marketId: HL, direction: 'short', filledSize: 100_000, shortfallSize: 0, execApr: 0.09, feeSize: 4, failure: null },
            legB: { marketId: BN, direction: 'long', filledSize: 100_000, shortfallSize: 0, execApr: 0.042, feeSize: 4, failure: null },
            hedgedSize: 100_000,
            unhedgedSize: 0,
            unhedgedLeg: null,
            realisedSpreadApr: 0.045,
            partial: false,
            bothLegsSubmitted: true,
          },
          estimate: simulation(),
          warnings: [],
        }),
      );
    }),
  ];
}

/** Fill in the form far enough that a simulation is requested. */
async function fillTicket(user: ReturnType<typeof userEvent.setup>) {
  // The selects are disabled and empty until the context query lands.
  await waitFor(() =>
    expect((screen.getByLabelText('Leg A') as HTMLSelectElement).options.length).toBeGreaterThan(1),
  );
  await user.selectOptions(screen.getByLabelText('Leg A'), String(HL));
  await user.selectOptions(screen.getByLabelText('Leg B'), String(BN));
  await user.type(screen.getByLabelText(/^Size per leg/), '100000');
}

beforeEach(() => {
  window.localStorage.setItem(
    STRATEGY_STORAGE_KEY,
    JSON.stringify({ address: ADDRESS, since: null, capitalBasis: 'balance' }),
  );
});

describe('BorosPairTicket', () => {
  it('uses the AGENT\'s root even when no address is tracked locally', async () => {
    // The agent's root is the account the orders hit; requiring the user to
    // re-enter the same address in Settings was pure friction.
    window.localStorage.clear();
    const bodies: Record<string, unknown>[] = [];
    server.use(...handlers({ onSimulate: (b) => bodies.push(b) }));
    const user = userEvent.setup();
    renderWithClient(<BorosPairTicket />);

    await fillTicket(user);
    await waitFor(() => expect(bodies.length).toBeGreaterThan(0));
    expect((bodies[0] as { address: string }).address).toBe(ADDRESS);
  });

  it('prices the AGENT\'s account, not a different tracked address', async () => {
    // The dangerous case: tracking A while the agent trades B would show A's
    // positions, margin and blockers for orders that hit B.
    const other = '0x2222222222222222222222222222222222222222';
    window.localStorage.setItem(
      STRATEGY_STORAGE_KEY,
      JSON.stringify({ address: other, since: null, capitalBasis: 'balance' }),
    );
    const bodies: Record<string, unknown>[] = [];
    server.use(...handlers({ onSimulate: (b) => bodies.push(b) }));
    const user = userEvent.setup();
    renderWithClient(<BorosPairTicket />);

    await fillTicket(user);
    await waitFor(() => expect(bodies.length).toBeGreaterThan(0));
    expect((bodies[0] as { address: string }).address).toBe(ADDRESS);
    // And the divergence is stated, because the Positions view shows the other.
    expect(screen.getByText(/the account your agent key signs for/i)).toBeInTheDocument();
  });

  it('falls back to the tracked address when no agent is configured', async () => {
    const bodies: Record<string, unknown>[] = [];
    server.use(
      ...handlers({
        onSimulate: (b) => bodies.push(b),
        agent: { configured: false, root: null, rootMasked: null },
      }),
    );
    const user = userEvent.setup();
    renderWithClient(<BorosPairTicket />);

    await fillTicket(user);
    await waitFor(() => expect(bodies.length).toBeGreaterThan(0));
    expect((bodies[0] as { address: string }).address).toBe(ADDRESS);
  });

  it('asks for one only when there is neither an agent nor a tracked address', async () => {
    window.localStorage.clear();
    server.use(...handlers({ agent: { configured: false, root: null, rootMasked: null } }));
    renderWithClient(<BorosPairTicket />);
    expect(await screen.findByText(/Connect a wallet above, or set a Boros address/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Leg A')).not.toBeInTheDocument();
  });

  it('defaults leg B to the opposite direction of leg A', async () => {
    const user = userEvent.setup();
    server.use(...handlers());
    renderWithClient(<BorosPairTicket />);

    const legA = within(await screen.findByRole('radiogroup', { name: 'Leg A direction' }));
    const legB = within(screen.getByRole('radiogroup', { name: 'Leg B direction' }));
    expect(legA.getByRole('radio', { name: 'Short' })).toHaveAttribute('aria-checked', 'true');
    expect(legB.getByRole('radio', { name: 'Long' })).toHaveAttribute('aria-checked', 'true');

    await user.click(legA.getByRole('radio', { name: 'Long' }));
    await waitFor(() =>
      expect(legB.getByRole('radio', { name: 'Short' })).toHaveAttribute('aria-checked', 'true'),
    );
  });

  it('hides ineligible markets once a leg is picked, and says how many it dropped', async () => {
    // Reverses the original §2 rule ("never hidden, disabled WITH the reason").
    // With a leg chosen, most of the venue's markets are ineligible, and a
    // dropdown of mostly-dead options is its own kind of hunting — so they are
    // dropped and a caption carries the explanation §2 was protecting.
    const user = userEvent.setup();
    server.use(...handlers());
    renderWithClient(<BorosPairTicket />);
    await waitFor(() =>
      expect((screen.getByLabelText('Leg A') as HTMLSelectElement).options.length).toBeGreaterThan(1),
    );
    await user.selectOptions(screen.getByLabelText('Leg A'), String(HL));

    const legB = screen.getByLabelText('Leg B') as HTMLSelectElement;
    const byLabel = (needle: string) =>
      [...legB.options].find((o) => o.textContent?.includes(needle));

    // Neither the wrong maturity nor the wrong collateral is offered at all.
    expect(byLabel('Bybit ETH 30 Sep 2026')).toBeUndefined();
    expect(byLabel('OKX BTC 31 Aug 2026')).toBeUndefined();
    // The eligible one is still there and selectable.
    expect(byLabel('Binance ETHUSDT')!.disabled).toBe(false);
    // The absence is explained rather than silent.
    expect(await screen.findByText(/markets? hidden/)).toBeInTheDocument();
  });

  it('leads with the estimated spread and shows the worst case beneath it', async () => {
    const user = userEvent.setup();
    server.use(...handlers());
    renderWithClient(<BorosPairTicket />);
    await fillTicket(user);

    expect(await screen.findByText('Estimated spread')).toBeInTheDocument();
    expect(screen.getByText('4.50%')).toBeInTheDocument(); // estimate — the lead
    expect(screen.getByText('Worst case')).toBeInTheDocument();
    expect(screen.getByText('4.00%')).toBeInTheDocument(); // worst — beneath it
    // Both are net; the pre-cost 4.8% must appear nowhere.
    expect(screen.queryByText('4.80%')).not.toBeInTheDocument();
    // The fee caveat is still stated on screen, in one line rather than three;
    // its long form moved to the hover, which is asserted too so a silent
    // deletion of the explanation cannot pass.
    expect(screen.getByText(/net of fees/i)).toBeInTheDocument();
    expect(screen.getByTitle(/net of Boros taker and settlement fees/i)).toBeInTheDocument();
  });

  it('says plainly that slippage bounds the rate, not the fill', async () => {
    const user = userEvent.setup();
    server.use(...handlers());
    renderWithClient(<BorosPairTicket />);
    await fillTicket(user);
    expect(await screen.findByText(/bounds the rate, not the fill/i)).toBeInTheDocument();
  });

  it('Single mode sends one leg, borrowing an eligible partner for the pair shape', async () => {
    // The route refuses a request whose legs name the same market, and will
    // not walk either book for one — so a single-leg ticket borrows a real
    // partner and zeroes it with onlyLeg rather than duplicating leg A.
    const user = userEvent.setup();
    const bodies: Record<string, unknown>[] = [];
    server.use(...handlers({ onSimulate: (b) => bodies.push(b) }));
    renderWithClient(<BorosPairTicket />);
    await fillTicket(user);
    await waitFor(() => expect(bodies.length).toBeGreaterThan(0));

    await user.click(screen.getByRole('radio', { name: 'Single' }));
    await waitFor(() => {
      const last = bodies[bodies.length - 1] as {
        onlyLeg?: string;
        legA: { marketId: number };
        legB: { marketId: number };
      };
      expect(last.onlyLeg).toBe('A');
      // A real second market, never a duplicate of leg A.
      expect(last.legB.marketId).not.toBe(last.legA.marketId);
    });
  });

  it('seeds the tolerance from half each market\'s max rate deviation', async () => {
    // The venue caps how far one trade may move the rate; a bound wider than
    // that can never fill, so half of it is the natural default. Across a
    // spread both legs must clear their own cap, so the seed is the mean of
    // the two halves — floored to 1 s.f. so it never rounds UP past the cap.
    const user = userEvent.setup();
    const bodies: Record<string, unknown>[] = [];
    server.use(
      ...handlers({
        onSimulate: (b) => bodies.push(b),
        ctx: {
          markets: [
            marketRow({ maxRateDeviationApr: 0.0164 }),
            marketRow({
              marketId: BN,
              name: 'Binance ETHUSDT 31 Aug 2026',
              venue: 'Binance',
              midApr: 0.045,
              maxRateDeviationApr: 0.0164,
            }),
          ],
        },
      }),
    );
    renderWithClient(<BorosPairTicket />);
    await fillTicket(user);
    await waitFor(() => expect(bodies.length).toBeGreaterThan(0));

    // 1.64% cap ⇒ half is 0.82% ⇒ floored to 1 s.f. = 0.8% = 0.008 APR.
    const last = bodies[bodies.length - 1] as { legA: { slippageApr: number } };
    expect(last.legA.slippageApr).toBeCloseTo(0.008, 9);
  });

  it('sends the tolerance as an APR fraction derived from a PERCENT, per leg', async () => {
    const user = userEvent.setup();
    const bodies: Record<string, unknown>[] = [];
    server.use(...handlers({ onSimulate: (b) => bodies.push(b) }));
    renderWithClient(<BorosPairTicket />);
    await fillTicket(user);
    await waitFor(() => expect(bodies.length).toBeGreaterThan(0));

    // The seed is half each market's max rate deviation; this fixture carries
    // no cap, so it falls back to 0.25% → 0.0025 APR on both legs.
    const first = bodies[bodies.length - 1] as { legA: { slippageApr: number }; legB: { slippageApr: number } };
    expect(first.legA.slippageApr).toBeCloseTo(0.0025, 9);
    expect(first.legB.slippageApr).toBeCloseTo(0.0025, 9);

    // Per-leg override: leg A alone widens.
    await user.click(screen.getByRole('button', { name: 'per leg' }));
    const slipA = screen.getByLabelText('Leg A %');
    await user.clear(slipA);
    await user.type(slipA, '0.8');

    await waitFor(() => {
      const last = bodies[bodies.length - 1] as { legA: { slippageApr: number }; legB: { slippageApr: number } };
      expect(last.legA.slippageApr).toBeCloseTo(0.008, 9);
      expect(last.legB.slippageApr).toBeCloseTo(0.0025, 9);
    });
  });

  it('shows the position arithmetic against the whole netted position', async () => {
    const user = userEvent.setup();
    server.use(
      ...handlers({
        sim: {
          legA: simLeg({
            sizing: {
              currentSize: 150_000,
              deltaSize: -100_000,
              resultingSize: 50_000,
              opposing: true,
              flips: false,
              clampedToClose: false,
            },
          }),
        },
      }),
    );
    renderWithClient(<BorosPairTicket />);
    await fillTicket(user);

    // Presented as "current → resulting" per leg, the way the Boros app shows
    // it: the heading and the three-column grid are gone, so what is pinned is
    // that each market's ENDING position is on screen and that the netting
    // rule is still stated somewhere the user can reach it.
    expect((await screen.findAllByTitle(/whole exposure there/i)).length).toBe(2);
    expect(screen.getAllByText(/→/).length).toBeGreaterThan(0);
    // Current and resulting now share one line, "+150k USDT → +50k USDT". The
    // TRADE column is deliberately gone: it was the reader doing the addition
    // to reach the resulting figure, which the arrow states outright.
    const netted = (await screen.findAllByTitle(/whole exposure there/i))[0];
    expect(netted).toHaveTextContent(/\+150k/);
    expect(netted).toHaveTextContent(/\+50k/);
  });

  it('blocks confirm behind the acknowledgement, and retracts it when the trade changes', async () => {
    const user = userEvent.setup();
    server.use(
      ...handlers({
        gate: {
          requiresAcknowledgement: true,
          opposingLegs: ['A'],
          blockers: [{ code: 'flip-unacknowledged', message: 'Tick the acknowledgement.' }],
        },
        sim: {
          legA: simLeg({
            sizing: {
              currentSize: 40_000,
              deltaSize: -100_000,
              resultingSize: -60_000,
              opposing: true,
              flips: true,
              clampedToClose: false,
            },
          }),
        },
      }),
    );
    renderWithClient(<BorosPairTicket />);
    await fillTicket(user);

    const box = await screen.findByRole('checkbox');
    // The copy names the market, the held size and what happens to it.
    expect(screen.getByText(/closes my existing Hyperliquid ETH 31 Aug 2026 long position of 40,000/i))
      .toBeInTheDocument();
    expect(screen.getByText(/opens 60,000 USDT in the opposite direction/i)).toBeInTheDocument();
    expect(box).not.toBeChecked();

    await user.click(box);
    expect(box).toBeChecked();

    // Changing the size changes WHAT is being acknowledged — it must not carry.
    await user.type(screen.getByLabelText(/^Size per leg/), '0');
    await waitFor(() => expect(screen.getByRole('checkbox')).not.toBeChecked());
  });

  it('names the venue and both markets before anything is sent', async () => {
    const user = userEvent.setup();
    server.use(...handlers());
    renderWithClient(<BorosPairTicket />);
    await fillTicket(user);

    const confirm = await screen.findByRole('button', { name: /2 Boros market orders/i });
    expect(confirm).toBeInTheDocument();
    // The button states the COUNT ("2 Boros market orders"); the footer no
    // longer repeats it and just names the markets, which is the part the
    // button cannot show. Atomicity keeps its wording on the hover.
    // Scoped to the footer: the market names also appear in the dropdowns, so
    // a bare text query matches those too.
    const footer = screen.getByTitle(/One atomic batch/i);
    expect(footer).toHaveTextContent('Hyperliquid ETH 31 Aug 2026');
    expect(footer).toHaveTextContent('Binance ETHUSDT 31 Aug 2026');
    // Atomic acceptance is the promise; a full fill is NOT. Both halves must
    // still be stated together — overselling the batch is the failure mode —
    // so the hover is asserted to carry BOTH clauses, not just the reassuring
    // one.
    const atomicity = footer.getAttribute("title") ?? "";
    expect(atomicity).toMatch(/One atomic batch/i);
    expect(atomicity).toMatch(/can still fill short/i);
  });

  it('renders ETH-collateral sizes at real precision, never rounded to 0', async () => {
    // The bug this pins: a 0.01 ETH ticket showed "0" everywhere — est. fill,
    // margin, trade and resulting position — because the columns were formatted
    // at a fixed 0dp that only suits USDT-scale numbers.
    const user = userEvent.setup();
    server.use(
      ...handlers({
        sim: {
          collateral: 'ETH',
          collateralPriceUsd: 3_000,
          legA: simLeg({
            estFillSize: 0.01,
            marginRequired: 0.00042,
            sizing: {
              currentSize: 0,
              deltaSize: -0.01,
              resultingSize: -0.01,
              opposing: false,
              flips: false,
              clampedToClose: false,
            },
          }),
          legB: simLeg({
            marketId: BN,
            direction: 'long',
            estFillSize: 0.01,
            marginRequired: 0.00031,
            sizing: {
              currentSize: 0,
              deltaSize: 0.01,
              resultingSize: 0.01,
              opposing: false,
              flips: false,
              clampedToClose: false,
            },
          }),
          marginRequiredTotal: 0.00073,
          hedgedSize: 0.01,
        },
      }),
    );
    renderWithClient(<BorosPairTicket />);
    await fillTicket(user);

    await screen.findByText('Estimated spread');
    // The COMBINED margin survives at ETH scale. The per-leg margins are no
    // longer shown — only the combined figure has to clear the account — so
    // the total is what this now pins.
    expect(screen.getByText(/0\.00073/)).toBeInTheDocument();
    // The position lines keep their sign AND their magnitude: "0 → -0.01".
    expect(screen.getAllByText(/-0\.01/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/\+0\.01/).length).toBeGreaterThan(0);
    // Nothing collapsed to a bare -0 / +0, which is the actual bug.
    expect(screen.queryByText('-0')).not.toBeInTheDocument();
    expect(screen.queryByText('+0')).not.toBeInTheDocument();
  });

  it('shows the venue’s own words when a leg is rejected outright', async () => {
    // 'rejected' is the catch-all: without the message the user gets a
    // one-word label and no way to tell what went wrong.
    const user = userEvent.setup();
    server.use(
      ...handlers({
        execute: () =>
          HttpResponse.json(
            env({
              result: {
                legA: {
                  marketId: HL,
                  direction: 'short',
                  filledSize: 0,
                  shortfallSize: 0.01,
                  execApr: null,
                  feeSize: null,
                  failure: { code: 'rejected', message: 'MarketNotEntered(155)' },
                },
                legB: {
                  marketId: BN,
                  direction: 'long',
                  filledSize: 0,
                  shortfallSize: 0.01,
                  execApr: null,
                  feeSize: null,
                  failure: { code: 'rejected', message: 'MarketNotEntered(158)' },
                },
                hedgedSize: 0,
                unhedgedSize: 0,
                unhedgedLeg: null,
                realisedSpreadApr: null,
                partial: true,
                bothLegsSubmitted: true,
              },
              estimate: simulation(),
              warnings: [],
            }),
          ),
      }),
    );
    renderWithClient(<BorosPairTicket />);
    await fillTicket(user);

    const confirm = await screen.findByRole('button', { name: /2 Boros market orders/i });
    await waitFor(() => expect(confirm).not.toBeDisabled());
    await user.pointer({ keys: '[MouseLeft>]', target: confirm });
    await waitFor(() => expect(screen.queryByRole('status')).toBeInTheDocument(), { timeout: 3_000 });

    const report = within(screen.getByRole('status'));
    expect(report.getAllByText('rejected').length).toBe(2);
    // The actual venue error, verbatim — that is the whole diagnostic.
    expect(report.getAllByText('MarketNotEntered(155)').length).toBe(1);
    expect(report.getAllByText(/its own message is below/i).length).toBe(2);
  });

  it('names a gas failure as gas, not as margin', async () => {
    const user = userEvent.setup();
    const failed = (marketId: number, direction: string) => ({
      marketId,
      direction,
      filledSize: 0,
      shortfallSize: 100_000,
      execApr: null,
      feeSize: null,
      failure: { code: 'no-gas', message: 'Top up at least ~$10 to trade' },
    });
    server.use(
      ...handlers({
        execute: () =>
          HttpResponse.json(
            env({
              result: {
                legA: failed(HL, 'short'),
                legB: failed(BN, 'long'),
                hedgedSize: 0,
                unhedgedSize: 0,
                unhedgedLeg: null,
                realisedSpreadApr: null,
                partial: true,
                bothLegsSubmitted: true,
              },
              estimate: simulation(),
              warnings: [],
            }),
          ),
      }),
    );
    renderWithClient(<BorosPairTicket />);
    await fillTicket(user);

    const confirm = await screen.findByRole('button', { name: /2 Boros market orders/i });
    await waitFor(() => expect(confirm).not.toBeDisabled());
    await user.pointer({ keys: '[MouseLeft>]', target: confirm });
    await waitFor(() => expect(screen.queryByRole('status')).toBeInTheDocument(), { timeout: 3_000 });

    const report = within(screen.getByRole('status'));
    expect(report.getAllByText('no prepaid gas').length).toBe(2);
    expect(report.getAllByText(/separate from your trading collateral/i).length).toBe(2);
  });

  it('renders nothing about gas when the balance covers the order', async () => {
    const user = userEvent.setup();
    server.use(...handlers({ gasBalanceUsd: 25 }));
    renderWithClient(<BorosPairTicket />);
    await fillTicket(user);

    await screen.findByText('Taker fee');
    expect(screen.queryByText(/prepaid gas/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Top up gas/i })).not.toBeInTheDocument();
  });

  it('says an unreadable gas balance is unknown, and offers no top-up for it', async () => {
    const user = userEvent.setup();
    server.use(
      ...handlers({
        gasBalanceUsd: null,
        gate: {
          blockers: [
            {
              code: 'no-gas',
              message:
                'Prepaid gas on this Boros account could not be read, so we cannot say whether an order will be accepted. This is gas, not trading collateral: topping up your margin will not fix it.',
            },
          ],
        },
      }),
    );
    renderWithClient(<BorosPairTicket />);
    await fillTicket(user);

    expect(await screen.findByText(/could not be read/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Top up gas/i })).not.toBeInTheDocument();
  });

  it('surfaces an empty gas balance as its own blocker, not a margin one', async () => {
    const user = userEvent.setup();
    server.use(
      ...handlers({
        gasBalanceUsd: 0,
        gate: {
          blockers: [
            {
              code: 'no-gas',
              message:
                'Prepaid gas on this Boros account is empty — top it up to send an order. This is gas, not trading collateral: topping up your margin will not fix it.',
            },
          ],
        },
      }),
    );
    renderWithClient(<BorosPairTicket />);
    await fillTicket(user);

    expect(await screen.findByText(/Prepaid gas on this Boros account is empty/i)).toBeInTheDocument();
    expect(screen.getByText(/topping up your margin will not fix it/i)).toBeInTheDocument();
  });

  it('tops up gas from inside the blocker, at an amount the user can edit', async () => {
    const user = userEvent.setup();
    const bodies: Record<string, unknown>[] = [];
    server.use(
      ...handlers({
        gasBalanceUsd: 0.05,
        gate: {
          blockers: [
            {
              code: 'no-gas',
              message: 'Prepaid gas on this Boros account is low, about $0.05 — top it up to send an order.',
            },
          ],
        },
      }),
      http.post('/api/boros/pair/top-up-gas', async ({ request }) => {
        bodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json(env({ balanceUsd: 20.05 }));
      }),
    );
    renderWithClient(<BorosPairTicket />);
    await fillTicket(user);

    const field = (await screen.findByLabelText(/Top up \(USD\)/i)) as HTMLInputElement;
    expect(field.value).toBe('5');
    const button = screen.getByRole('button', { name: /Top up gas/i });

    await user.clear(field);
    await user.type(field, '1');
    expect(button).toBeDisabled();
    expect(screen.getByText('Minimum is 2')).toBeInTheDocument();
    await user.clear(field);
    await user.type(field, '500');
    expect(button).toBeDisabled();
    expect(screen.getByText('Maximum is 100')).toBeInTheDocument();

    await user.clear(field);
    await user.type(field, '20');
    await user.click(button);
    await waitFor(() => expect(bodies.length).toBe(1));
    expect(bodies[0]).toEqual({ amountUsd: 20 });
  });

  it('says reduce-only is enforced by sizing, not by the venue', async () => {
    const user = userEvent.setup();
    server.use(...handlers());
    renderWithClient(<BorosPairTicket />);
    await waitFor(() =>
      expect((screen.getByLabelText('Leg A') as HTMLSelectElement).options.length).toBeGreaterThan(1),
    );
    // The option's accessible name carries its "reduce-only" sub-label.
    await user.click(screen.getByRole('radio', { name: /^Close/ }));
    // Whose guarantee "reduce-only" is still qualified — on the badge that
    // makes the claim, instead of a paragraph shown every time Close is picked.
    expect(screen.getByTitle(/Boros has no reduce-only order type/i)).toBeInTheDocument();
  });

  it('surfaces a server blocker with its shortfall framed as a top-up', async () => {
    const user = userEvent.setup();
    server.use(
      ...handlers({
        gate: {
          blockers: [
            {
              code: 'cross-short-margin',
              message: 'Cross margin is short 320.00 USDT for both legs together.',
              shortfall: 320,
            },
          ],
        },
      }),
    );
    renderWithClient(<BorosPairTicket />);
    await fillTicket(user);

    expect(await screen.findByText(/Cross margin is short 320.00 USDT/)).toBeInTheDocument();
    expect(screen.getByText(/that is the top-up, not the total requirement/i)).toBeInTheDocument();
  });

  it('sends a usable cancel-and-close request — id present, no address', async () => {
    // It previously posted an empty body to a route requiring clientOrderId, so
    // the §6A remediation button always 400'd and was unreachable.
    const user = userEvent.setup();
    let body: Record<string, unknown> | null = null;
    server.use(
      ...handlers({
        gate: {
          blockers: [
            {
              code: 'isolated-must-switch',
              leg: 'A',
              marketId: HL,
              message: 'Hyperliquid ETH 31 Aug 2026 is on isolated margin. Switch it to cross margin.',
            },
          ],
        },
      }),
      http.post(`/api/boros/pair/market/${HL}/cancel-and-close`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(env({ marketId: HL, cancelled: true, closed: true }));
      }),
    );
    renderWithClient(<BorosPairTicket />);
    await fillTicket(user);

    await user.click(await screen.findByRole('button', { name: /Cancel orders & close position/i }));
    await waitFor(() => expect(body).not.toBeNull());

    const sent = body as unknown as { clientOrderId?: string; address?: string };
    expect(sent.clientOrderId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    // The account is the server's to decide — this route sizes the close from it.
    expect(sent.address).toBeUndefined();
  });

  it('offers the §6A remediation on an isolated leg', async () => {
    const user = userEvent.setup();
    server.use(
      ...handlers({
        gate: {
          blockers: [
            {
              code: 'isolated-must-switch',
              leg: 'A',
              marketId: HL,
              message:
                'Hyperliquid ETH 31 Aug 2026 is on isolated margin with an open position/order. Switch it to cross margin to trade this pair.',
            },
          ],
        },
      }),
    );
    renderWithClient(<BorosPairTicket />);
    await fillTicket(user);

    expect(await screen.findByText(/Switch it to cross margin/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Cancel orders & close position/i }),
    ).toBeInTheDocument();
  });

  it('reports a partial fill as a residual with three follow-up actions', async () => {
    const user = userEvent.setup();
    server.use(
      ...handlers({
        execute: () =>
          HttpResponse.json(
            env({
              result: {
                legA: {
                  marketId: HL,
                  direction: 'short',
                  filledSize: 60_000,
                  shortfallSize: 40_000,
                  execApr: 0.089,
                  feeSize: 2,
                  failure: { code: 'insufficient-depth', message: 'thin' },
                },
                legB: { marketId: BN, direction: 'long', filledSize: 100_000, shortfallSize: 0, execApr: 0.042, feeSize: 4, failure: null },
                hedgedSize: 60_000,
                unhedgedSize: 40_000,
                unhedgedLeg: 'B',
                realisedSpreadApr: 0.044,
                partial: true,
                bothLegsSubmitted: true,
              },
              estimate: simulation(),
              warnings: [],
            }),
          ),
      }),
    );
    renderWithClient(<BorosPairTicket />);
    await fillTicket(user);

    const confirm = await screen.findByRole('button', { name: /2 Boros market orders/i });
    await waitFor(() => expect(confirm).not.toBeDisabled());
    // Hold-to-confirm: press, wait out the gate, release.
    await user.pointer({ keys: '[MouseLeft>]', target: confirm });
    await waitFor(() => expect(screen.queryByRole('status')).toBeInTheDocument(), { timeout: 3_000 });

    const report = within(screen.getByRole('status'));
    expect(report.getByText('partially filled')).toBeInTheDocument();
    expect(report.getByText(/40,000 USDT on leg B is unhedged/i)).toBeInTheDocument();
    expect(report.getByText(/not enough depth/i)).toBeInTheDocument();
    for (const label of ['Complete now at market', 'Retry', 'Leave it']) {
      expect(report.getByRole('button', { name: label })).toBeInTheDocument();
    }
  });

  it('completes the DEFICIENT leg only — never re-arms both', async () => {
    const user = userEvent.setup();
    const bodies: Record<string, unknown>[] = [];
    server.use(...handlers({ onSimulate: (b) => bodies.push(b), execute: partialExecute }));
    renderWithClient(<BorosPairTicket />);
    await fillTicket(user);

    const confirm = await screen.findByRole('button', { name: /2 Boros market orders/i });
    await waitFor(() => expect(confirm).not.toBeDisabled());
    await user.pointer({ keys: '[MouseLeft>]', target: confirm });
    await waitFor(() => expect(screen.queryByRole('status')).toBeInTheDocument(), { timeout: 3_000 });

    await user.click(screen.getByRole('button', { name: 'Complete now at market' }));

    // Leg B carries the surplus, so leg A is the one still short — arming both
    // at 40k (the old behaviour) would have grown the book at the same
    // imbalance and doubled the exposure.
    expect(screen.getByLabelText(/^Size per leg/)).toHaveValue('40000');
    expect(screen.getByText(/Completing leg A only/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /complete leg A/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /2 Boros market orders/i })).not.toBeInTheDocument();

    // …and the request says so, so the server trades one leg.
    await waitFor(() => {
      const last = bodies[bodies.length - 1] as { onlyLeg?: string; size: number };
      expect(last.onlyLeg).toBe('A');
      expect(last.size).toBe(40_000);
    });
  });

  it('retries only the LEG that fell short — never on top of a finished fill', async () => {
    const user = userEvent.setup();
    const bodies: Record<string, unknown>[] = [];
    server.use(...handlers({ onSimulate: (b) => bodies.push(b), execute: partialExecute }));
    renderWithClient(<BorosPairTicket />);
    await fillTicket(user);

    const confirm = await screen.findByRole('button', { name: /2 Boros market orders/i });
    await waitFor(() => expect(confirm).not.toBeDisabled());
    await user.pointer({ keys: '[MouseLeft>]', target: confirm });
    await waitFor(() => expect(screen.queryByRole('status')).toBeInTheDocument(), { timeout: 3_000 });

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    // Leg A fell 40k short and leg B filled in FULL — re-arming BOTH legs at
    // 40k would trade 40k on top of leg B's finished fill. Only the short leg
    // re-arms, as a single-leg completion.
    expect(screen.getByLabelText(/^Size per leg/)).toHaveValue('40000');
    expect(screen.getByText(/Completing leg A only/i)).toBeInTheDocument();
  });

  it('retries BOTH legs at the smaller shortfall when both fell short', async () => {
    /** Leg A 60k of 100k, leg B 75k of 100k — both short, by different amounts. */
    const bothShort = () =>
      HttpResponse.json(
        env({
          result: {
            legA: { marketId: HL, direction: 'short', filledSize: 60_000, shortfallSize: 40_000, execApr: 0.089, feeSize: 2, failure: null },
            legB: { marketId: BN, direction: 'long', filledSize: 75_000, shortfallSize: 25_000, execApr: 0.042, feeSize: 3, failure: null },
            hedgedSize: 60_000,
            unhedgedSize: 15_000,
            unhedgedLeg: 'B',
            realisedSpreadApr: 0.044,
            partial: true,
            bothLegsSubmitted: true,
          },
          estimate: simulation(),
          warnings: [],
        }),
      );
    const user = userEvent.setup();
    server.use(...handlers({ execute: bothShort }));
    renderWithClient(<BorosPairTicket />);
    await fillTicket(user);

    const confirm = await screen.findByRole('button', { name: /2 Boros market orders/i });
    await waitFor(() => expect(confirm).not.toBeDisabled());
    await user.pointer({ keys: '[MouseLeft>]', target: confirm });
    await waitFor(() => expect(screen.queryByRole('status')).toBeInTheDocument(), { timeout: 3_000 });

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    // One shared size must not overshoot EITHER leg's own gap, so the smaller
    // shortfall re-arms both; the leftover imbalance is what Complete is for.
    expect(screen.getByLabelText(/^Size per leg/)).toHaveValue('25000');
    expect(screen.queryByText(/Completing leg/i)).not.toBeInTheDocument();
  });

  it('blocks confirm when the QUOTE has sat too long — not on server clock skew', async () => {
    // /simulate judges freshness against the timestamp it just made, so its age
    // is always 0 there — only the client can catch a quote going cold, and it
    // must measure on ONE clock (its own receive time): a fresh quote from a
    // server whose clock runs a minute behind must NOT read as stale.
    const user = userEvent.setup();
    server.use(...handlers({ simulatedAtMs: Date.now() - 60_000 }));
    renderWithClient(<BorosPairTicket />);
    await fillTicket(user);

    const confirm = await screen.findByRole('button', { name: /2 Boros market orders/i });
    await waitFor(() => expect(confirm).not.toBeDisabled());
    expect(screen.queryByText(/quote is out of date/i)).not.toBeInTheDocument();

    // Now let the quote actually sit: further refetches fail (keeping the last
    // good quote and its receive time) while the client clock runs past the
    // max age — the ticket's own 1s ticker picks the skewed time up.
    server.use(http.post('/api/boros/pair/simulate', () => HttpResponse.error()));
    const realNow = Date.now.bind(Date);
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 13_000);
    try {
      expect(await screen.findByText(/quote is out of date/i, undefined, { timeout: 3_000 })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /2 Boros market orders/i })).toBeDisabled();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('sends distinct idempotency keys, one per leg', async () => {
    const user = userEvent.setup();
    const sent: Record<string, unknown>[] = [];
    server.use(...handlers({ onExecute: (b) => sent.push(b) }));
    renderWithClient(<BorosPairTicket />);
    await fillTicket(user);

    const confirm = await screen.findByRole('button', { name: /2 Boros market orders/i });
    await waitFor(() => expect(confirm).not.toBeDisabled());
    await user.pointer({ keys: '[MouseLeft>]', target: confirm });
    await waitFor(() => expect(sent.length).toBe(1), { timeout: 3_000 });

    const body = sent[0] as { clientOrderIdA: string; clientOrderIdB: string };
    expect(body.clientOrderIdA).toBeTruthy();
    expect(body.clientOrderIdB).toBeTruthy();
    expect(body.clientOrderIdA).not.toBe(body.clientOrderIdB);
  });
});

describe('BorosPairTicket — the size unit', () => {
  it('names the collateral as soon as a leg is picked, before any simulation', async () => {
    // There is no simulation until a size is typed, and a size field labelled
    // "(collateral)" tells the user nothing about what to type into it.
    server.use(...handlers());
    const user = userEvent.setup();
    renderWithClient(<BorosPairTicket />);
    await waitFor(() =>
      expect((screen.getByLabelText('Leg A') as HTMLSelectElement).options.length).toBeGreaterThan(1),
    );
    expect(screen.getByText(/^Size per leg$/)).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Leg A'), String(HL));
    expect(screen.getByText('Size per leg (USDT)')).toBeInTheDocument();
    expect(screen.queryByText(/\(collateral\)/)).not.toBeInTheDocument();
  });

  it('follows the picked market into another collateral zone', async () => {
    server.use(...handlers());
    const user = userEvent.setup();
    renderWithClient(<BorosPairTicket />);
    await waitFor(() =>
      expect((screen.getByLabelText('Leg A') as HTMLSelectElement).options.length).toBeGreaterThan(1),
    );
    await user.selectOptions(screen.getByLabelText('Leg A'), '400');
    expect(screen.getByText('Size per leg (BTC)')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Card cue prefill ("Open the Boros legs") — maturity agreement
// ---------------------------------------------------------------------------

function BorosPrefillHarness({ prefill }: { prefill: Omit<BorosOpenPrefill, 'nonce'> }) {
  const flow = useTradeFlow();
  return (
    <>
      <button type="button" onClick={() => flow.prefillBorosOpen(prefill)}>
        fire
      </button>
      <BorosPairTicket />
    </>
  );
}

describe('BorosPairTicket — the cue prefill lands both legs on ONE maturity', () => {
  /**
   * The shape that broke live: the cue fires from a card with NO Boros legs,
   * so it carries no maturity, and each venue lists a different set. Gate had
   * exactly one ETH market (the later one is absent) while Hyperliquid listed
   * the FAR maturity first — so resolving each leg independently armed
   * Gate-near against HL-far, a pair that cannot trade.
   */
  const SEP = MATURITY;
  const DEC = MATURITY + 90 * 86_400;
  const twoVenues = () =>
    handlers({
      ctx: context({
        markets: [
          // Hyperliquid lists the FAR maturity first — the list order that
          // produced the bug.
          marketRow({ marketId: 901, name: 'Hyperliquid ETH Dec', venue: 'Hyperliquid', maturity: DEC }),
          marketRow({ marketId: 902, name: 'Hyperliquid ETH Sep', venue: 'Hyperliquid', maturity: SEP }),
          // Gate lists only the near one.
          marketRow({ marketId: 903, name: 'Gate ETH Sep', venue: 'Gate', maturity: SEP }),
        ],
      }),
    });

  it("picks the maturity the two venues SHARE, not each venue's first row", async () => {
    server.use(...twoVenues());
    const user = userEvent.setup();
    renderWithClient(
      <BorosPrefillHarness
        prefill={{ base: 'ETH', longVenue: 'Gate', shortVenue: 'Hyperliquid', size: 1000 }}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'fire' }));

    // Both legs on 902/903 (Sep). Before the fix leg B armed 901 (Dec) and the
    // ticket reported "different maturity" about a pair nobody chose.
    await waitFor(() => expect(screen.getByLabelText('Leg A')).toHaveValue('903'));
    expect(screen.getByLabelText('Leg B')).toHaveValue('902');
    expect(screen.queryByText(/different maturity/)).not.toBeInTheDocument();
  });

  it('arms neither leg when the venues share no maturity', async () => {
    // An impossible pair must stay unarmed: a ticket holding two markets that
    // cannot trade together is worse than an empty one.
    server.use(
      ...handlers({
        ctx: context({
          markets: [
            marketRow({ marketId: 911, name: 'Hyperliquid ETH Dec', venue: 'Hyperliquid', maturity: DEC }),
            marketRow({ marketId: 912, name: 'Gate ETH Sep', venue: 'Gate', maturity: SEP }),
          ],
        }),
      }),
    );
    const user = userEvent.setup();
    renderWithClient(
      <BorosPrefillHarness
        prefill={{ base: 'ETH', longVenue: 'Gate', shortVenue: 'Hyperliquid', size: 1000 }}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'fire' }));

    await waitFor(() => expect(screen.getByLabelText('Leg A')).toHaveValue(''));
    expect(screen.getByLabelText('Leg B')).toHaveValue('');
  });
});

describe('BorosPairTicket — slippage is stated, not silently clamped', () => {
  it('blocks confirm when the typed slippage exceeds the cap', async () => {
    /**
     * `pctToApr` clamps to MAX_SLIP_PCT, so typing 50 left "50" on screen while
     * 10 went on the wire — and clamping client-side made the server's own
     * "reject, never silently coerce" guard unreachable. The number shown must
     * be the number sent, or the user must be told it is not.
     */
    server.use(...handlers());
    const user = userEvent.setup();
    renderWithClient(<BorosPairTicket />);
    await fillTicket(user);

    const slip = screen.getByLabelText(/Max slippage/);
    await user.clear(slip);
    await user.type(slip, '50');

    expect(await screen.findByText(/Max slippage must be greater than 0/)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Confirm/ })).toBeDisabled(),
    );
  });

  it('blocks confirm on a typed ZERO — the seeded default must not go out silently', async () => {
    /**
     * The check used to be one-sided: only `> MAX_SLIP_PCT` was flagged, while
     * a typed 0 (or a cleared box, or a negative) fell through to `pctToApr`'s
     * fallback — the order went out carrying the SEEDED default as its rate
     * bound, a bound the user explicitly did not choose, with "0" on screen.
     */
    server.use(...handlers());
    const user = userEvent.setup();
    renderWithClient(<BorosPairTicket />);
    await fillTicket(user);

    const slip = screen.getByLabelText(/Max slippage/);
    await user.clear(slip);
    await user.type(slip, '0');

    expect(await screen.findByText(/Max slippage must be greater than 0/)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Confirm/ })).toBeDisabled(),
    );

    // A cleared box is the same dishonesty — empty on screen, seed on the wire.
    await user.clear(slip);
    expect(await screen.findByText(/Max slippage must be greater than 0/)).toBeInTheDocument();
  });
});
