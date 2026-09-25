/**
 * The opportunity rebate overlay: crediting the settlement fee back per leg and
 * re-deriving every figure through the server's own identities, and composing
 * cleanly with repriceHeld. Expectations are hand-derived.
 */
import { describe, expect, it } from 'vitest';
import type { Rebate } from '../api/types';
import { makeOpportunityPair, OPP_NOTIONAL } from '../test/fixtures';
import { applyRebate } from './opportunityRebate';
import { repriceHeld } from './heldPerps';

const YEARS = (secondsToMaturity: number) => secondsToMaturity / (365 * 24 * 3600);

const relative = (over: Partial<Rebate> = {}): Rebate => ({
  mode: 'relative',
  settlementFeePercentage: 0.8, // rebates 20%
  rebateBps: 2000,
  startTimestamp: null,
  endTimestamp: null,
  marketIds: null,
  active: true,
  ...over,
});

describe('applyRebate', () => {
  it('credits settleFee × 20% back per leg and lifts profit by exactly that, capital untouched', () => {
    const pair = makeOpportunityPair();
    const years = YEARS(pair.secondsToMaturity);
    const out = applyRebate(pair, relative(), OPP_NOTIONAL);

    // Both legs at 0.001 settleFeeApr, 20% rebated ⇒ borosSettleFeeUsd × 0.2.
    const credit = pair.costs.borosSettleFeeUsd * 0.2;
    expect(credit).toBeGreaterThan(0);
    expect(out.costs.borosSettleRebateUsd).toBeCloseTo(credit, 9);
    // The gross settle-fee line is UNCHANGED — the credit is a separate step.
    expect(out.costs.borosSettleFeeUsd).toBe(pair.costs.borosSettleFeeUsd);
    expect(out.costs.totalUsd).toBeCloseTo((pair.costs.totalUsd as number) - credit, 9);
    expect(out.estProfitUsd).toBeCloseTo((pair.estProfitUsd as number) + credit, 6);
    expect(out.capitalUsd).toBe(pair.capitalUsd);
    const notionalYears = OPP_NOTIONAL * years;
    expect(out.netFixedApr).toBeCloseTo(
      (pair.execSpreadApr as number) - (out.costs.totalUsd as number) / notionalYears,
      9,
    );
    expect(out.netFixedAprOnCapital).toBeCloseTo(
      (out.estProfitUsd as number) / ((pair.capitalUsd as number) * years),
      9,
    );
  });

  it('credits only the in-scope leg when the rebate is market-filtered', () => {
    const pair = makeOpportunityPair();
    // Only the short leg's market (101) is covered.
    const out = applyRebate(pair, relative({ marketIds: [pair.shortLeg.marketId] }), OPP_NOTIONAL);
    // One leg of two ⇒ half the full credit.
    const credit = pair.costs.borosSettleFeeUsd * 0.2 * 0.5;
    expect(out.costs.borosSettleRebateUsd).toBeCloseTo(credit, 9);
  });

  it('caps the fee in absolute mode, crediting only the excess over the cap', () => {
    const pair = makeOpportunityPair();
    const years = YEARS(pair.secondsToMaturity);
    // Cap the settle fee APR at 0.0004; each leg pays 0.001, so 0.0006 is saved.
    const out = applyRebate(
      pair,
      { mode: 'absolute', settlementFeePercentage: 0.0004, rebateBps: null, startTimestamp: null, endTimestamp: null, marketIds: null, active: true },
      OPP_NOTIONAL,
    );
    const credit = 2 * (0.001 - 0.0004) * OPP_NOTIONAL * years;
    expect(out.costs.borosSettleRebateUsd).toBeCloseTo(credit, 9);
  });

  it('is a no-op with no rebate, inactive, and for an unpriced pair', () => {
    const pair = makeOpportunityPair();
    expect(applyRebate(pair, null, OPP_NOTIONAL)).toBe(pair);
    expect(applyRebate(pair, relative({ active: false }), OPP_NOTIONAL)).toBe(pair);
    const unpriced = { ...pair, costs: { ...pair.costs, totalUsd: null } };
    expect(applyRebate(unpriced, relative(), OPP_NOTIONAL)).toBe(unpriced);
  });

  it('composes with repriceHeld: held perps drop entry cost, then the rebate credits on top', () => {
    const pair = makeOpportunityPair();
    const held = repriceHeld(pair, OPP_NOTIONAL);
    const both = applyRebate(held, relative(), OPP_NOTIONAL);

    const saved = (pair.costs.perpEntryFeesUsd ?? 0) + (pair.costs.perpEntrySlippageUsd ?? 0);
    const credit = pair.costs.borosSettleFeeUsd * 0.2;
    expect(both.costs.totalUsd).toBeCloseTo((pair.costs.totalUsd as number) - saved - credit, 9);
    expect(both.estProfitUsd).toBeCloseTo((pair.estProfitUsd as number) + saved + credit, 6);
    // Both overlays are pure OpportunityPair → OpportunityPair, order-independent
    // for the total (each removes a distinct cost slice).
    const other = repriceHeld(applyRebate(pair, relative(), OPP_NOTIONAL), OPP_NOTIONAL);
    expect(other.costs.totalUsd).toBeCloseTo(both.costs.totalUsd as number, 9);
  });
});
