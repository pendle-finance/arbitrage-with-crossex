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
const tradableHandlers = (result: Record<string, unknown>, collateral = 'USDT') => [
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
    HttpResponse.json(env({ result, estimate: null, warnings: [] })),
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
