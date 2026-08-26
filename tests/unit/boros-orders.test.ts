/**
 * Boros two-leg submission (src/core/boros/orders.ts): the rate bound each leg
 * carries, best-effort behaviour when one leg falls short, the realised spread
 * off actual fills, and the failure taxonomy that keeps "the book ran out"
 * apart from "the chain refused the rate".
 */
import { describe, expect, it, vi } from 'vitest';
import { CoreError } from '../../src/core/errors';
import {
  classifyLegFailure,
  describeLegFailure,
  limitAprFor,
  submitBorosPair,
  type BorosLegFill,
  type BorosMarketOrderRequest,
  type BorosOrderClient,
} from '../../src/core/boros/orders';

const req = (over: Partial<BorosMarketOrderRequest> = {}): BorosMarketOrderRequest => ({
  marketId: 155,
  direction: 'short',
  size: 100_000,
  limitApr: 0.0875,
  clientOrderId: 'coid-a',
  ...over,
});

const fill = (over: Partial<BorosLegFill> = {}): BorosLegFill => ({
  marketId: 155,
  direction: 'short',
  filledSize: 100_000,
  shortfallSize: 0,
  execApr: 0.09,
  feeSize: 4.1,
  failure: null,
  ...over,
});

/** A client whose legs are scripted by marketId, served as ONE batch. */
const clientOf = (byMarket: Record<number, BorosLegFill | Error>): BorosOrderClient => {
  const placeMarketOrders = async (reqs: BorosMarketOrderRequest[]) =>
    reqs.map((r) => {
      const scripted = byMarket[r.marketId];
      // A whole-batch throw is a transport failure; a per-leg failure comes
      // back as a failed fill inside the array, which is what the venue does.
      if (scripted instanceof Error) {
        return {
          marketId: r.marketId,
          direction: r.direction,
          filledSize: 0,
          shortfallSize: r.size,
          execApr: null,
          feeSize: null,
          failure: { code: classifyLegFailure(scripted), message: scripted.message },
        } as BorosLegFill;
      }
      return scripted;
    });
  return {
    placeMarketOrders,
    cancelOrders: async () => {},
    closePosition: async () => fill(),
  };
};

const legA = req();
const legB = req({ marketId: 101, direction: 'long', limitApr: 0.0445, clientOrderId: 'coid-b' });
/** Same fee drag the simulation used, so estimate and outcome are comparable. */
const FEE_DRAG = 0.003;

describe('limitAprFor', () => {
  it('moves a receive-fixed leg DOWN and a pay-fixed leg UP', () => {
    expect(limitAprFor('short', 0.09, 0.0025)).toBeCloseTo(0.0875, 12);
    expect(limitAprFor('long', 0.042, 0.0025)).toBeCloseTo(0.0445, 12);
  });

  it('treats a zero or nonsense tolerance as no give-up at all', () => {
    expect(limitAprFor('short', 0.09, 0)).toBeCloseTo(0.09, 12);
    expect(limitAprFor('long', 0.042, Number.NaN)).toBeCloseTo(0.042, 12);
  });
});

describe('submitBorosPair', () => {
  it('sends BOTH legs in one batch — never two races for the same nonce', async () => {
    // Boros enforces strictly increasing nonces per signer, and both legs share
    // one agent key. Two concurrent sends make the loser fail with "Nonces must
    // be greater than the signer's latest tracked nonce".
    const placeMarketOrders = vi.fn(async (reqs: BorosMarketOrderRequest[]) =>
      reqs.map((r) => fill({ marketId: r.marketId, direction: r.direction })),
    );
    const client: BorosOrderClient = {
      placeMarketOrders,
      cancelOrders: async () => {},
      closePosition: async () => fill(),
    };
    const res = await submitBorosPair({ client, legA, legB, feeDragApr: FEE_DRAG, receiveLeg: 'A' });

    expect(placeMarketOrders).toHaveBeenCalledTimes(1);
    expect(placeMarketOrders.mock.calls[0][0].map((r) => r.marketId)).toEqual([155, 101]);
    expect(res.partial).toBe(false);
  });

  it('reports BOTH legs failed when the whole batch throws', async () => {
    // One nonce covers both, so a batch-level rejection is not a one-leg event
    // — claiming otherwise would hide live exposure or invent it.
    const client: BorosOrderClient = {
      placeMarketOrders: async () => {
        throw new Error('Nonces must be greater than the signer’s latest tracked nonce');
      },
      cancelOrders: async () => {},
      closePosition: async () => fill(),
    };
    const res = await submitBorosPair({ client, legA, legB, feeDragApr: FEE_DRAG, receiveLeg: 'A' });
    expect(res.legA.filledSize).toBe(0);
    expect(res.legB.filledSize).toBe(0);
    expect(res.legA.failure!.message).toMatch(/Nonces must be greater/);
    expect(res.legB.failure!.message).toMatch(/Nonces must be greater/);
    expect(res.hedgedSize).toBe(0);
  });

  it('computes the realised spread from ACTUAL fills, net of the same fee drag', async () => {
    const client = clientOf({
      155: fill({ execApr: 0.0885 }),
      101: fill({ marketId: 101, direction: 'long', execApr: 0.0435 }),
    });
    const res = await submitBorosPair({ client, legA, legB, feeDragApr: FEE_DRAG, receiveLeg: 'A' });
    expect(res.realisedSpreadApr).toBeCloseTo(0.0885 - 0.0435 - FEE_DRAG, 12);
  });

  it('leaves the pair partially filled and names the residual leg', async () => {
    const client = clientOf({
      155: fill({ filledSize: 60_000, shortfallSize: 40_000, failure: { code: 'insufficient-depth', message: 'book ran out' } }),
      101: fill({ marketId: 101, direction: 'long', execApr: 0.042 }),
    });
    const res = await submitBorosPair({ client, legA, legB, feeDragApr: FEE_DRAG, receiveLeg: 'A' });
    expect(res.partial).toBe(true);
    expect(res.hedgedSize).toBe(60_000);
    expect(res.unhedgedSize).toBe(40_000);
    // Leg B over-filled relative to A, so B carries the directional residual.
    expect(res.unhedgedLeg).toBe('B');
    expect(res.legA.failure!.code).toBe('insufficient-depth');
  });

  it('reports the other leg even when one leg throws outright', async () => {
    const client = clientOf({
      155: new Error('BOROS_RATE_DEVIATION: rate too far from mark'),
      101: fill({ marketId: 101, direction: 'long', execApr: 0.042 }),
    });
    const res = await submitBorosPair({ client, legA, legB, feeDragApr: FEE_DRAG, receiveLeg: 'A' });
    expect(res.legA.filledSize).toBe(0);
    expect(res.legA.failure!.code).toBe('rate-deviation');
    // The leg that DID fill is still reported — it is live exposure.
    expect(res.legB.filledSize).toBe(100_000);
    expect(res.unhedgedSize).toBe(100_000);
    expect(res.unhedgedLeg).toBe('B');
    // Nothing to compute a spread from on one side.
    expect(res.realisedSpreadApr).toBeNull();
  });

  it('never widens a tolerance or re-sends on its own', async () => {
    const place = vi.fn(async (reqs: BorosMarketOrderRequest[]) =>
      reqs.map((r) =>
        fill({ marketId: r.marketId, direction: r.direction, filledSize: 10, shortfallSize: r.size - 10 }),
      ),
    );
    const client: BorosOrderClient = { placeMarketOrders: place, cancelOrders: async () => {}, closePosition: async () => fill() };
    await submitBorosPair({ client, legA, legB, feeDragApr: FEE_DRAG, receiveLeg: 'A' });
    // One batch, exactly the bounds handed in — no retry, no widened limit.
    expect(place).toHaveBeenCalledTimes(1);
    expect(place.mock.calls[0][0][0].limitApr).toBe(legA.limitApr);
    expect(place.mock.calls[0][0][1].limitApr).toBe(legB.limitApr);
  });

  it('carries the caller idempotency key through unchanged', async () => {
    const place = vi.fn(async (reqs: BorosMarketOrderRequest[]) =>
      reqs.map((r) => fill({ marketId: r.marketId, direction: r.direction })),
    );
    const client: BorosOrderClient = { placeMarketOrders: place, cancelOrders: async () => {}, closePosition: async () => fill() };
    await submitBorosPair({ client, legA, legB, feeDragApr: FEE_DRAG, receiveLeg: 'A' });
    expect(place.mock.calls[0][0].map((r) => r.clientOrderId)).toEqual(['coid-a', 'coid-b']);
  });
});

describe('describeLegFailure', () => {
  /** What axios rejects with: a generic message, the real cause in the body. */
  const axiosErr = (status: number, data: unknown) =>
    Object.assign(new Error(`Request failed with status code ${status}`), {
      response: { status, data },
    });

  it('digs the reason out of an axios response body', () => {
    expect(describeLegFailure(axiosErr(400, { message: 'market not entered' }))).toBe(
      'HTTP 400: market not entered',
    );
  });

  it('never leaves the user with just a status code when a body exists', () => {
    for (const body of [
      { error: 'RATE_OUT_OF_BOUND' },
      { detail: 'agent not approved' },
      { error: { message: 'nested cause' } },
      'plain string body',
    ]) {
      const out = describeLegFailure(axiosErr(400, body));
      expect(out).not.toBe('Request failed with status code 400');
      expect(out).toMatch(/HTTP 400: /);
    }
  });

  it('serialises an unrecognised body rather than dropping it', () => {
    const out = describeLegFailure(axiosErr(400, { code: 7, hint: 'enter the market first' }));
    expect(out).toContain('enter the market first');
  });

  it('caps a huge body so an HTML error page cannot flood the panel', () => {
    const out = describeLegFailure(axiosErr(500, { blob: 'x'.repeat(5_000) }));
    expect(out.length).toBeLessThan(400);
    expect(out.endsWith('…')).toBe(true);
  });

  it('still reports the status when there is no body at all', () => {
    expect(describeLegFailure(axiosErr(502, undefined))).toMatch(/HTTP 502/);
  });

  it('passes an ordinary Error through untouched', () => {
    expect(describeLegFailure(new Error('boom'))).toBe('boom');
  });
});

describe('classifyLegFailure', () => {
  it('keeps rate-deviation distinct from a depth shortfall', () => {
    expect(classifyLegFailure(new Error('RATE_DEVIATION_TOO_LARGE'))).toBe('rate-deviation');
    expect(classifyLegFailure(new Error('INSUFFICIENT_LIQUIDITY on market 155'))).toBe(
      'insufficient-depth',
    );
  });

  it('prefers a classified CoreError category over sniffing the message', () => {
    expect(classifyLegFailure(new CoreError('could not fund', 'insufficient-margin'))).toBe(
      'insufficient-margin',
    );
    expect(classifyLegFailure(new CoreError('upstream down', 'network'))).toBe('unknown');
    expect(classifyLegFailure(new CoreError('slow down', 'rate-limited'))).toBe('unknown');
  });

  it('treats a lost response as UNKNOWN, never as a clean reject', () => {
    expect(classifyLegFailure(new Error('socket timeout'))).toBe('unknown');
  });

  it('falls back to a plain rejection', () => {
    expect(classifyLegFailure(new Error('MARKET_CLOSED'))).toBe('rejected');
  });

  it('reads the relayer\'s own gas refusal as no-gas, unprompted', () => {
    // Prepaid gas is a different pot from margin, so it needs a different fix.
    expect(
      classifyLegFailure(new Error('HTTP 400: Insufficient gas balance 0xab. Required: 0.05')),
    ).toBe('no-gas');
    expect(classifyLegFailure(new Error('GAS_BALANCE_TOO_LOW'))).toBe('no-gas');
  });

  it('reads the venue top-up string as gas ONLY on a market already entered', () => {
    // Boros says the same sentence about an account that has not entered the
    // market. Sending that user to a top-up would not unblock them.
    const topUp = new Error('[SIMULATE] Top up at least ~$10 to trade');
    expect(classifyLegFailure(topUp, true)).toBe('no-gas');
    expect(classifyLegFailure(topUp, false)).toBe('rejected');
    expect(classifyLegFailure(topUp)).toBe('rejected');
  });

  it('keeps a margin shortfall out of the gas branch', () => {
    expect(classifyLegFailure(new Error('INSUFFICIENT_MARGIN'), true)).toBe('insufficient-margin');
  });

  it('classifies off the unwrapped body, not the generic axios message', () => {
    const axiosErr = Object.assign(new Error('Request failed with status code 400'), {
      response: { status: 400, data: { message: 'RATE_DEVIATION too large' } },
    });
    // Sniffing `.message` alone would have called this a plain rejection.
    expect(classifyLegFailure(axiosErr)).toBe('rate-deviation');
  });
});
