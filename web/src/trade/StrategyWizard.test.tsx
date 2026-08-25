/** The wizard's contract with the prefill channel: a fresh open arms step 1
 * (the Boros pair) from the intent; a resume (initialStep 2) arms the perp
 * ticket instead and never mounts the Boros one. Prefill→ticket mechanics are
 * the tickets' own suites; panel→intent is the OpportunitiesPanel suite. */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { useEffect, useRef } from 'react';
import { describe, expect, it } from 'vitest';
import { ETH_GATE, symbolHandlers } from '../test/fixtures';
import { env, server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { StrategyWizard } from './StrategyWizard';
import { useTradeFlow, type StrategyWizardIntent } from './TradeFlow';

const INTENT: StrategyWizardIntent = {
  base: 'ETH',
  borosLongVenue: 'BINANCE',
  borosShortVenue: 'HYPERLIQUID',
  maturity: 1_760_000_000,
  // Deliberately unmapped venues: the perp legs stay unselected, so no
  // preview fires and the test needs no preview handler.
  crossexLongVenue: 'OKX',
  crossexShortVenue: 'GATE',
  notionalUsd: 10_000,
  perpMode: 'maker',
};

/** No agent, no tracked address: the Boros ticket renders its connect prompt
 * and prices nothing — the wizard's own prefill still fires. */
const agentHandlers = () => [
  http.get('/api/boros/agent', () =>
    HttpResponse.json(
      env({
        configured: false,
        root: null,
        rootMasked: null,
        accountId: 0,
        expiry: null,
        expired: false,
        canProvision: true,
      }),
    ),
  ),
  http.get('/api/boros/pair/context', () => HttpResponse.json(env({ markets: [] }))),
];

const prefillsSeen: Array<{ kind: 'boros' | 'pair'; payload: Record<string, unknown> }> = [];
function Probe() {
  const flow = useTradeFlow();
  const b = flow.borosOpenPrefill;
  const p = flow.pairPrefill;
  if (b && !prefillsSeen.some((x) => x.kind === 'boros' && x.payload.nonce === b.nonce))
    prefillsSeen.push({ kind: 'boros', payload: { ...b } });
  if (p && !prefillsSeen.some((x) => x.kind === 'pair' && x.payload.nonce === p.nonce))
    prefillsSeen.push({ kind: 'pair', payload: { ...p } });
  return null;
}

function Launch({ intent }: { intent: StrategyWizardIntent }) {
  const flow = useTradeFlow();
  const fired = useRef(false);
  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    flow.openWizard(intent);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

const renderWizard = (intent: StrategyWizardIntent) => {
  prefillsSeen.length = 0;
  return renderWithClient(
    <>
      <Launch intent={intent} />
      <StrategyWizard />
      <Probe />
    </>,
  );
};

describe('StrategyWizard → prefills', () => {
  it('a fresh open arms step 1 with the Boros pair — venues, maturity, size', async () => {
    server.use(...agentHandlers(), ...symbolHandlers([ETH_GATE]));
    renderWizard(INTENT);

    await waitFor(() => expect(prefillsSeen).toHaveLength(1));
    expect(prefillsSeen[0].kind).toBe('boros');
    expect(prefillsSeen[0].payload).toMatchObject({
      base: 'ETH',
      longVenue: 'BINANCE',
      shortVenue: 'HYPERLIQUID',
      maturity: 1_760_000_000,
      size: 10_000,
    });
    // Step 1 is the lit step; the perp ticket is not on screen yet.
    expect(screen.getByText('Lock the rate')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Size per leg/)).not.toBeInTheDocument();
  });

  it('a resume (initialStep 2) arms the perp ticket and never mounts the Boros one', async () => {
    server.use(...agentHandlers(), ...symbolHandlers([ETH_GATE]));
    renderWizard({ ...INTENT, initialStep: 2 });

    await waitFor(() => expect(prefillsSeen).toHaveLength(1));
    expect(prefillsSeen[0].kind).toBe('pair');
    expect(prefillsSeen[0].payload).toMatchObject({
      base: 'ETH',
      longVenue: 'OKX',
      shortVenue: 'GATE',
      notionalUsd: 10_000,
      mode: 'maker',
    });
    // The perp ticket is live at step 2; the Boros ticket is absent entirely —
    // those rate legs already exist as a position.
    expect(screen.getByLabelText(/Size per leg/)).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'Boros ticket mode' })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// A succeeded step is a receipt, not a form
// ---------------------------------------------------------------------------

const HL_M = 155;
const BN_M = 158;
const MAT = 1_800_000_000;
const market = (over: Record<string, unknown> = {}) => ({
  marketId: HL_M,
  name: 'Hyperliquid ETH 31 Aug 2026',
  venue: 'HYPERLIQUID',
  base: 'ETH',
  tokenId: 3,
  collateral: 'USDT',
  maturity: MAT,
  midApr: 0.09,
  markApr: 0.09,
  maxRateDeviationApr: 0.02,
  isolatedOnly: false,
  onIsolatedMargin: false,
  isolatedHasPositionOrOrders: false,
  currentSize: 0,
  collateralPriceUsd: 1,
  ...over,
});

/** A wizard whose Boros step can actually be filled and executed. */
/** Pass an ARRAY of results to script SEQUENTIAL executions (a partial then
 * its completion, a retry, a close): call N answers with results[N], and the
 * last one repeats. A single result behaves as before. */
const tradableHandlers = (result: Record<string, unknown> | Record<string, unknown>[], collateral = 'USDT') => {
  const sequence = Array.isArray(result) ? result : [result];
  let call = 0;
  return tradableHandlersSeq(() => sequence[Math.min(call++, sequence.length - 1)], collateral);
};

const tradableHandlersSeq = (next: () => Record<string, unknown>, collateral: string) => [
  http.get('/api/boros/agent', () =>
    HttpResponse.json(
      env({
        configured: true,
        root: '0x1111111111111111111111111111111111111111',
        rootMasked: '0x1111…1111',
        accountId: 0,
        expiry: null,
        expired: false,
        canProvision: true,
      }),
    ),
  ),
  http.get('/api/boros/pair/context', () =>
    HttpResponse.json(
      env({
        markets: [market({ collateral }), market({ marketId: BN_M, name: 'Binance ETH 31 Aug 2026', venue: 'BINANCE', collateral })],
        crossByToken: [{ tokenId: 3, available: 500_000 }],
        isolatedByMarket: [],
        defaultSlippageApr: 0.0025,
        maxSlippageApr: 0.1,
      }),
    ),
  ),
  http.post('/api/boros/pair/simulate', () =>
    HttpResponse.json(
      env({
        simulation: {
          collateral,
          spreadApr: 0.045,
          worstCaseSpreadApr: 0.02,
          legA: { marketId: HL_M, direction: 'short', execApr: 0.09, feeSize: 4, marginRequired: 1, sizing: { currentSize: 0, resultingSize: -1000, flips: false } },
          legB: { marketId: BN_M, direction: 'long', execApr: 0.042, feeSize: 4, marginRequired: 1, sizing: { currentSize: 0, resultingSize: 1000, flips: false } },
          takerFeeSize: 8,
          costToCrossSize: 0,
          feeDragApr: 0.003,
          marginRequiredTotal: 2,
          hedgedSize: 1000,
          unhedgedSize: 0,
          collateralPriceUsd: 1,
          secondsToMaturity: 1_000_000,
          reasons: [],
        },
        gate: { blockers: [], warnings: [], requiresAcknowledgement: false, opposingLegs: [] },
        eligibility: { eligible: true, code: null, reason: null },
        simulatedAtMs: Date.now(),
        gasBalanceUsd: 100,
      }),
    ),
  ),
  http.post('/api/boros/pair/execute', () =>
    HttpResponse.json(env({ result: next(), estimate: null, warnings: [] })),
  ),
];

const CLEAN_FILL = {
  legA: { marketId: HL_M, direction: 'short', filledSize: 1000, shortfallSize: 0, execApr: 0.09, feeSize: 4, failure: null },
  legB: { marketId: BN_M, direction: 'long', filledSize: 1000, shortfallSize: 0, execApr: 0.042, feeSize: 4, failure: null },
  hedgedSize: 1000,
  unhedgedSize: 0,
  unhedgedLeg: null,
  realisedSpreadApr: 0.045,
  partial: false,
  bothLegsSubmitted: true,
};

describe('StrategyWizard — the hedge is sized off the EXECUTED collateral', () => {
  it('an ETH-collateral fill with no sizeBase arms the perps in DOLLARS, not the coin count', async () => {
    /**
     * The old branch asked "did the caller supply a base quantity?" — which is
     * a question about what the OPPORTUNITY card knew, not about the market
     * that traded. An ETH cohort whose collateral price is unavailable arrives
     * with no `sizeBase`, so a 2-ETH fill fell into the "USD-margined" branch
     * and armed the perp pair at $2 against a ~$9,000 rate leg.
     *
     * With no conversion available the honest move is to keep the intent's USD
     * figure, never to pass a coin count as dollars.
     */
    const ethFill = {
      ...CLEAN_FILL,
      hedgedSize: 2, // 2 ETH
    };
    server.use(...tradableHandlers(ethFill, 'ETH'), ...symbolHandlers([ETH_GATE]));
    renderWizard({
      ...INTENT,
      maturity: MAT,
      borosLongVenue: 'BINANCE',
      borosShortVenue: 'HYPERLIQUID',
      notionalUsd: 9000,
      sizeBase: undefined, // no collateral price ⇒ the card could not convert
    });

    await waitFor(() => expect(screen.getByLabelText('Leg A')).toHaveValue(String(BN_M)));
    // With no `sizeBase` the prefill leaves the size empty (it has no coin
    // quantity to put there) — the user types the ETH size themselves. That
    // is precisely the path that produced the mis-sized hedge.
    fireEvent.change(screen.getByLabelText(/^Size per leg/), { target: { value: '2' } });

    const confirm = await screen.findByRole('button', { name: /Confirm — 2 Boros market orders/ });
    await waitFor(() => expect(confirm).toBeEnabled(), { timeout: 4000 });
    fireEvent.pointerDown(confirm);

    await screen.findByRole('button', { name: /Rate locked/ }, { timeout: 4000 });
    fireEvent.click(screen.getByRole('button', { name: /Rate locked/ }));

    // The perp prefill carries the USD intent (9000), NOT the 2-coin fill.
    await waitFor(() => {
      const pair = prefillsSeen.find((x) => x.kind === 'pair');
      expect(pair?.payload.notionalUsd).toBe(9000);
    });
    const pair = prefillsSeen.find((x) => x.kind === 'pair');
    expect(pair?.payload.sizeBase).toBeUndefined();
  });
});

describe('StrategyWizard — step 1 becomes a receipt once the rate is locked', () => {
  it('replaces the Boros form with the fill summary — ONE CTA, not two', async () => {
    /**
     * The bug this pins: the ticket stayed mounted and ARMED under the wizard's
     * advance button, so the modal showed both `Confirm — 2 Boros market
     * orders` and `Rate locked ✓ — hedge the perps`. The same pair could then
     * be fired a second time by a user the wizard had just told the rate was
     * locked.
     */
    server.use(...tradableHandlers(CLEAN_FILL), ...symbolHandlers([ETH_GATE]));
    renderWizard({ ...INTENT, maturity: MAT, borosLongVenue: 'BINANCE', borosShortVenue: 'HYPERLIQUID' });

    // The wizard's own prefill arms both legs and the size; just wait for it.
    await waitFor(() =>
      expect(screen.getByLabelText('Leg A')).toHaveValue(String(BN_M)),
    );
    expect(screen.getByLabelText('Leg B')).toHaveValue(String(HL_M));

    const confirm = await screen.findByRole('button', { name: /Confirm — 2 Boros market orders/ });
    await waitFor(() => expect(confirm).toBeEnabled(), { timeout: 4000 });
    fireEvent.pointerDown(confirm);

    // The receipt appears…
    await screen.findByText(/1,000 USDT hedged/, undefined, { timeout: 4000 });
    // …and the form is GONE: no confirm, no size box, nothing to re-fire.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Confirm — 2 Boros market orders/ })).not.toBeInTheDocument(),
    );
    expect(screen.queryByLabelText(/^Size per leg/)).not.toBeInTheDocument();
    // Exactly one way forward.
    expect(screen.getByRole('button', { name: /Rate locked ✓ — hedge the perps/ })).toBeInTheDocument();
    // And no Dismiss — the receipt IS the step; hiding it would blank it.
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// The step-1 BOOK: every execution folds; "locked" means the book is clean
// ---------------------------------------------------------------------------

/** The sentinel a not-submitted leg comes back as (orders.ts `notSubmitted`). */
const NOT_SUBMITTED = {
  marketId: 0,
  direction: 'short',
  filledSize: 0,
  shortfallSize: 0,
  execApr: null,
  feeSize: null,
  failure: null,
};

/** Both legs venue-rejected: fills 0 under a 200. The old receipt gate read
 * `unhedgedSize > 0`, which is 0 here — and showed "Rate locked ✓". */
const ZERO_FILL = {
  legA: { marketId: HL_M, direction: 'short', filledSize: 0, shortfallSize: 1000, execApr: null, feeSize: null, failure: { code: 'rate-deviation', message: 'rate moved beyond the band' } },
  legB: { marketId: BN_M, direction: 'long', filledSize: 0, shortfallSize: 1000, execApr: null, feeSize: null, failure: { code: 'rate-deviation', message: 'rate moved beyond the band' } },
  hedgedSize: 0,
  unhedgedSize: 0,
  unhedgedLeg: null,
  realisedSpreadApr: null,
  partial: true,
  bothLegsSubmitted: true,
};

/** Leg A fills whole, leg B falls 400 short: 600 hedged, 400 directional. */
const PARTIAL_600 = {
  legA: { marketId: HL_M, direction: 'short', filledSize: 1000, shortfallSize: 0, execApr: 0.09, feeSize: 4, failure: null },
  legB: { marketId: BN_M, direction: 'long', filledSize: 600, shortfallSize: 400, execApr: 0.042, feeSize: 3, failure: null },
  hedgedSize: 600,
  unhedgedSize: 400,
  unhedgedLeg: 'A',
  realisedSpreadApr: null,
  partial: true,
  bothLegsSubmitted: true,
};

/** The 400-unit one-leg completion of PARTIAL_600's deficient leg B. */
const COMPLETION_400 = {
  legA: NOT_SUBMITTED,
  legB: { marketId: BN_M, direction: 'long', filledSize: 400, shortfallSize: 0, execApr: 0.041, feeSize: 2, failure: null },
  hedgedSize: 0,
  unhedgedSize: 0,
  unhedgedLeg: null,
  realisedSpreadApr: null,
  partial: false,
  bothLegsSubmitted: false,
};

/** The same completion, FAILED at the venue — still a 200. */
const COMPLETION_FAIL = {
  legA: NOT_SUBMITTED,
  legB: { marketId: BN_M, direction: 'long', filledSize: 0, shortfallSize: 400, execApr: null, feeSize: null, failure: { code: 'insufficient-depth', message: 'not enough depth inside the band' } },
  hedgedSize: 0,
  unhedgedSize: 0,
  unhedgedLeg: null,
  realisedSpreadApr: null,
  partial: true,
  bothLegsSubmitted: false,
};

/** Both legs short by DIFFERENT amounts: 500 hedged, 200 directional. */
const UNEVEN_PARTIAL = {
  legA: { marketId: HL_M, direction: 'short', filledSize: 700, shortfallSize: 300, execApr: 0.09, feeSize: 3, failure: null },
  legB: { marketId: BN_M, direction: 'long', filledSize: 500, shortfallSize: 500, execApr: 0.042, feeSize: 2, failure: null },
  hedgedSize: 500,
  unhedgedSize: 200,
  unhedgedLeg: 'A',
  realisedSpreadApr: null,
  partial: true,
  bothLegsSubmitted: true,
};

/** The pair-shaped retry Retry arms for UNEVEN_PARTIAL (min shortfall 300),
 * filling clean. The book is then 1000/800 — still 200 directional. */
const RETRY_300 = {
  legA: { marketId: HL_M, direction: 'short', filledSize: 300, shortfallSize: 0, execApr: 0.088, feeSize: 1, failure: null },
  legB: { marketId: BN_M, direction: 'long', filledSize: 300, shortfallSize: 0, execApr: 0.043, feeSize: 1, failure: null },
  hedgedSize: 300,
  unhedgedSize: 0,
  unhedgedLeg: null,
  realisedSpreadApr: 0.045,
  partial: false,
  bothLegsSubmitted: true,
};

/** A deliberate one-leg lock (the ticket's Single mode). */
const SINGLE_LOCK = {
  legA: { marketId: HL_M, direction: 'short', filledSize: 1000, shortfallSize: 0, execApr: 0.09, feeSize: 4, failure: null },
  legB: NOT_SUBMITTED,
  hedgedSize: 0,
  unhedgedSize: 0,
  unhedgedLeg: null,
  realisedSpreadApr: null,
  partial: false,
  bothLegsSubmitted: false,
};

/** The close that unwinds SINGLE_LOCK — opposite direction, same market. */
const SINGLE_CLOSE = {
  legA: { marketId: HL_M, direction: 'long', filledSize: 1000, shortfallSize: 0, execApr: 0.091, feeSize: 4, failure: null },
  legB: NOT_SUBMITTED,
  hedgedSize: 0,
  unhedgedSize: 0,
  unhedgedLeg: null,
  realisedSpreadApr: null,
  partial: false,
  bothLegsSubmitted: false,
};

const WIZ = { ...INTENT, maturity: MAT, borosLongVenue: 'BINANCE', borosShortVenue: 'HYPERLIQUID' };

/** Arm, wait for the tradable state, hold-to-confirm the pair. */
const confirmPair = async () => {
  await waitFor(() => expect(screen.getByLabelText('Leg A')).toHaveValue(String(BN_M)));
  const confirm = await screen.findByRole('button', { name: /Confirm — 2 Boros market orders/ });
  await waitFor(() => expect(confirm).toBeEnabled(), { timeout: 4000 });
  fireEvent.pointerDown(confirm);
};

describe('StrategyWizard — the book decides, not the last result', () => {
  it('a ZERO fill keeps the live ticket: no receipt, no Continue, Retry works', async () => {
    /**
     * The receipt gate used to read `unhedgedSize > 0`, and a both-legs-zero
     * rejection reports unhedgedSize 0 — so nothing filled, the ticket
     * unmounted, and "Rate locked ✓ — hedge the perps" armed a FULL-SIZE perp
     * pair against a rate position that does not exist, over dead
     * Complete/Retry buttons.
     */
    server.use(...tradableHandlers(ZERO_FILL), ...symbolHandlers([ETH_GATE]));
    renderWizard(WIZ);
    await confirmPair();

    // The ticket's own failure report, with its REAL remediation…
    expect(await screen.findByRole('button', { name: 'Retry' }, { timeout: 4000 })).toBeEnabled();
    // …and nothing claiming a rate was locked.
    expect(screen.queryByRole('button', { name: /Rate locked/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Continue anyway/ })).not.toBeInTheDocument();
  }, 15_000);

  it('a partial and its completion make ONE aggregate receipt, sizing the hedge', async () => {
    /**
     * The old merge kept the PRE-completion hedgedSize (600) and the receipt
     * described whichever result came last — the book is what actually traded:
     * 1000/1000 after the top-up.
     */
    server.use(...tradableHandlers([PARTIAL_600, COMPLETION_400]), ...symbolHandlers([ETH_GATE]));
    renderWizard({ ...WIZ, notionalUsd: 1000 });
    await confirmPair();

    // Partial: the wizard names the unmatched size and the ticket stays live.
    expect(await screen.findByText(/400 USDT is unmatched/, undefined, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Rate locked/ })).not.toBeInTheDocument();

    // Complete the deficient leg through the ticket's own report.
    fireEvent.click(screen.getByRole('button', { name: 'Complete now at market' }));
    const complete = await screen.findByRole('button', { name: /^Confirm — complete leg/ }, { timeout: 4000 });
    await waitFor(() => expect(complete).toBeEnabled(), { timeout: 4000 });
    fireEvent.pointerDown(complete);

    // ONE receipt, reading the AGGREGATE — not the 400 top-up, not the stale 600.
    await screen.findByText(/1,000 USDT hedged/, undefined, { timeout: 4000 });
    fireEvent.click(screen.getByRole('button', { name: /Rate locked/ }));
    await waitFor(() => {
      const pair = prefillsSeen.find((x) => x.kind === 'pair');
      expect(pair?.payload.notionalUsd).toBe(1000);
    });
  }, 20_000);

  it('a FAILED completion leaves the residual standing', async () => {
    // The old merge zeroed unhedgedSize on ANY completion result — including
    // one whose leg filled nothing — erasing a residual that still exists.
    server.use(...tradableHandlers([PARTIAL_600, COMPLETION_FAIL]), ...symbolHandlers([ETH_GATE]));
    renderWizard({ ...WIZ, notionalUsd: 1000 });
    await confirmPair();
    await screen.findByText(/400 USDT is unmatched/, undefined, { timeout: 4000 });

    fireEvent.click(screen.getByRole('button', { name: 'Complete now at market' }));
    const complete = await screen.findByRole('button', { name: /^Confirm — complete leg/ }, { timeout: 4000 });
    await waitFor(() => expect(complete).toBeEnabled(), { timeout: 4000 });
    fireEvent.pointerDown(complete);

    // The completion failed at the venue: the round-trip settles back into a
    // live one-leg report with remediation (clicking Complete cleared the
    // pair report, so this button is the failed completion's own)…
    expect(
      await screen.findByRole('button', { name: /Retry the rest/ }, { timeout: 4000 }),
    ).toBeInTheDocument();
    // …and the 400 stays flagged; nothing claims the rate is locked. (The old
    // merge zeroed the residual here and rendered the receipt.)
    expect(screen.getByText(/400 USDT is unmatched/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Rate locked/ })).not.toBeInTheDocument();
  }, 20_000);

  it('a pair-shaped Retry ADDS to the book — the hedge is the aggregate', async () => {
    /**
     * Retry after a both-short partial re-arms a PAIR at the min shortfall,
     * and its result REPLACED `locked`: the receipt read "300 hedged" and the
     * perps armed at 300 against a true book of 1000/800.
     */
    server.use(...tradableHandlers([UNEVEN_PARTIAL, RETRY_300]), ...symbolHandlers([ETH_GATE]));
    renderWizard({ ...WIZ, notionalUsd: 1000 });
    await confirmPair();
    await screen.findByText(/200 USDT is unmatched/, undefined, { timeout: 4000 });

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    const retry = await screen.findByRole('button', { name: /Confirm — 2 Boros market orders/ }, { timeout: 4000 });
    await waitFor(() => expect(retry).toBeEnabled(), { timeout: 4000 });
    fireEvent.pointerDown(retry);

    // The retry's own clean report shows inside the ticket (300 hedged)…
    await screen.findByText(/300 USDT hedged/, undefined, { timeout: 4000 });
    // …but the BOOK is 1000/800: still lopsided, still no "Rate locked ✓".
    expect(screen.getByText(/200 USDT is unmatched/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Rate locked/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Continue anyway/ }));
    await waitFor(() => {
      const pair = prefillsSeen.find((x) => x.kind === 'pair');
      expect(pair?.payload.notionalUsd).toBe(800);
    });
  }, 20_000);

  it('a single-leg lock is one-sided exposure — never "Rate locked ✓"', async () => {
    // A one-leg result reports unhedgedSize 0, so the old gate read it as a
    // clean pair lock and armed BOTH perp legs at the full intent size.
    server.use(...tradableHandlers(SINGLE_LOCK), ...symbolHandlers([ETH_GATE]));
    renderWizard(WIZ);
    await waitFor(() => expect(screen.getByLabelText('Leg A')).toHaveValue(String(BN_M)));
    fireEvent.click(screen.getByRole('radio', { name: 'Single' }));
    const confirm = await screen.findByRole('button', { name: /Confirm — 1 Boros market order/ });
    await waitFor(() => expect(confirm).toBeEnabled(), { timeout: 4000 });
    fireEvent.pointerDown(confirm);

    expect(
      await screen.findByText(/Only one side of the rate pair is on/, undefined, { timeout: 4000 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Rate locked/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Continue anyway/ })).not.toBeInTheDocument();

    // And leaving THIS is guarded: one leg on is exposure, whatever made it.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(
      await screen.findByText(/until the perp legs open you hold directional exposure/),
    ).toBeInTheDocument();
  }, 15_000);

  it('a close through the wizard SUBTRACTS — a book closed to zero leaves silently', async () => {
    server.use(...tradableHandlers([SINGLE_LOCK, SINGLE_CLOSE]), ...symbolHandlers([ETH_GATE]));
    renderWizard(WIZ);
    await waitFor(() => expect(screen.getByLabelText('Leg A')).toHaveValue(String(BN_M)));
    fireEvent.click(screen.getByRole('radio', { name: 'Single' }));
    const confirm = await screen.findByRole('button', { name: /Confirm — 1 Boros market order/ });
    await waitFor(() => expect(confirm).toBeEnabled(), { timeout: 4000 });
    fireEvent.pointerDown(confirm);
    await screen.findByText(/Only one side of the rate pair is on/, undefined, { timeout: 4000 });

    // Unwind it: dismiss the report (which clears the size — its point), flip
    // the intent to Close, re-enter the size, execute.
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    fireEvent.click(screen.getByRole('radio', { name: /^Close/ }));
    // Single-mode label is "Size (USDT)" — not the pair's "Size per leg".
    fireEvent.change(screen.getByLabelText(/^Size \(/), { target: { value: '1000' } });
    const confirm2 = await screen.findByRole('button', { name: /Confirm — 1 Boros market order/ });
    await waitFor(() => expect(confirm2).toBeEnabled(), { timeout: 4000 });
    fireEvent.pointerDown(confirm2);

    // The book is flat again: the banner clears…
    await waitFor(
      () => expect(screen.queryByText(/Only one side of the rate pair is on/)).not.toBeInTheDocument(),
      { timeout: 4000 },
    );
    // …and leaving needs no warning — nothing naked remains.
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText('Open this strategy')).not.toBeInTheDocument());
  }, 20_000);
});

describe('StrategyWizard — continue arms once per book state', () => {
  it('Back → Continue with nothing new executed does NOT re-arm the perp ticket', async () => {
    // Every Continue used to fire a fresh prefill, so re-reading the receipt
    // and coming forward wiped the user's step-2 edits back to the fill size.
    server.use(...tradableHandlers(CLEAN_FILL), ...symbolHandlers([ETH_GATE]));
    renderWizard(WIZ);
    await confirmPair();

    fireEvent.click(await screen.findByRole('button', { name: /Rate locked/ }, { timeout: 4000 }));
    await waitFor(() => expect(prefillsSeen.filter((x) => x.kind === 'pair')).toHaveLength(1));

    fireEvent.click(screen.getByRole('button', { name: /Back to the rate legs/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Rate locked/ }));
    await screen.findByLabelText(/Size per leg/);
    // Same book ⇒ same arm: still exactly one pair prefill.
    expect(prefillsSeen.filter((x) => x.kind === 'pair')).toHaveLength(1);
  }, 15_000);
});

describe('StrategyWizard — leaving and closing are deliberate', () => {
  it('the leave warning cannot be walked through by a second Escape', async () => {
    // Modal forwards Escape unfiltered, so a HELD key's auto-repeat (or a
    // backdrop double-click) used to arm the guard and confirm it in one
    // perceived gesture. Only the banner's explicit Leave closes now.
    server.use(...agentHandlers(), ...symbolHandlers([ETH_GATE]));
    renderWizard({ ...INTENT, initialStep: 2 });
    await screen.findByLabelText(/Size per leg/);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(
      await screen.findByText(/until the perp legs open you hold directional exposure/),
    ).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    // Still open, still warning.
    expect(screen.getByText('Finish this strategy')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
    await waitFor(() => expect(screen.queryByText('Finish this strategy')).not.toBeInTheDocument());
  });

  it('the modal cannot be closed while a Boros execution is in flight', async () => {
    // Unmounting the executing ticket skips its onSuccess: the fill report and
    // its remediation die unseen while the order executes at the venue anyway.
    server.use(
      http.post('/api/boros/pair/execute', () => new Promise<never>(() => {})),
      ...tradableHandlers(CLEAN_FILL),
      ...symbolHandlers([ETH_GATE]),
    );
    renderWizard(WIZ);
    await waitFor(() => expect(screen.getByLabelText('Leg A')).toHaveValue(String(BN_M)));
    expect(screen.getByRole('button', { name: 'close' })).toBeInTheDocument();

    const confirm = await screen.findByRole('button', { name: /Confirm — 2 Boros market orders/ });
    await waitFor(() => expect(confirm).toBeEnabled(), { timeout: 4000 });
    fireEvent.pointerDown(confirm);

    // In flight: the ✕ goes away and Escape is inert.
    await waitFor(
      () => expect(screen.queryByRole('button', { name: 'close' })).not.toBeInTheDocument(),
      { timeout: 4000 },
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByText('Open this strategy')).toBeInTheDocument();
  }, 15_000);
});

describe('StrategyWizard — token-collateral aggregate sizing', () => {
  it('scales the USD notional by hedged/sizeBase and passes the coin size', async () => {
    const ETH_FILL = {
      ...CLEAN_FILL,
      legA: { ...CLEAN_FILL.legA, filledSize: 2 },
      legB: { ...CLEAN_FILL.legB, filledSize: 2 },
      hedgedSize: 2,
    };
    server.use(...tradableHandlers(ETH_FILL, 'ETH'), ...symbolHandlers([ETH_GATE]));
    renderWizard({ ...WIZ, notionalUsd: 9000, sizeBase: 3 });
    await confirmPair();

    // The receipt reads the book in the executed collateral.
    await screen.findByText(/2 ETH hedged/, undefined, { timeout: 4000 });
    fireEvent.click(screen.getByRole('button', { name: /Rate locked/ }));
    await waitFor(() => {
      const pair = prefillsSeen.find((x) => x.kind === 'pair');
      // 2 of the intended 3 ETH filled ⇒ 2/3 of the $9,000 intent.
      expect(pair?.payload.notionalUsd).toBeCloseTo(6000);
      expect(pair?.payload.sizeBase).toBe(2);
    });
  }, 15_000);
});
