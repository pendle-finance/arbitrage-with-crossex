/**
 * Roll sizing arithmetic. The ladder is the live Hyperliquid ETH 25 Sep ask
 * side of 2026-09-22 (mid 0.15198): five levels inside a 1% bound summing to
 * 389.95, then 2,033 ETH at +1.30%. The venue's FOK ceiling at 1% bisected to
 * 389.2–390.1 against it, so these figures are checked against the venue, not
 * against the code.
 */
import { describe, expect, it } from 'vitest';
import type { BorosSimulatedLeg } from '../../api/types';
import { ROLL_FIT_BUFFER, capacityAt, fitAtBand, maxRollSize, planBatch, suggestedRollSize, toleranceFor } from './rollSizing';

const HL: Array<[number, number]> = [
  [0.0005, 9.44],
  [0.004, 338.75],
  [0.0062, 340.75],
  [0.0063, 380.75],
  [0.0083, 389.95],
  [0.013, 2423.05],
  [0.0134, 2623.05],
  [0.02, 3134.07],
];
/** A deep book: everything inside 0.1%. */
const DEEP: Array<[number, number]> = [[0.001, 50_000]];

const leg = (over: Partial<BorosSimulatedLeg>): BorosSimulatedLeg =>
  ({ marketName: 'Hyperliquid ETH 25 Sep 2026', depth: HL, maxToleranceApr: 0.02, ...over }) as BorosSimulatedLeg;

describe('capacityAt / toleranceFor', () => {
  it('counts whole levels inside the bound and nothing past it', () => {
    expect(capacityAt(HL, 0.01)).toBeCloseTo(389.95, 6);
    expect(capacityAt(HL, 0.013)).toBeCloseTo(2423.05, 6);
    expect(capacityAt(HL, 0.0001)).toBe(0);
    expect(capacityAt([], 0.01)).toBe(0);
  });

  it('names the deepest level a size has to reach', () => {
    expect(toleranceFor(HL, 100)).toBeCloseTo(0.004, 9);
    expect(toleranceFor(HL, 389.95)).toBeCloseTo(0.0083, 9);
    expect(toleranceFor(HL, 390)).toBeCloseTo(0.013, 9);
    // More than the whole side holds: no tolerance fills it.
    expect(toleranceFor(HL, 4000)).toBeNull();
    expect(toleranceFor(HL, 0)).toBe(0);
  });
});

describe('suggestedRollSize', () => {
  it('keeps the buffer back from a book that binds', () => {
    expect(suggestedRollSize(389.95, 1340)).toBeCloseTo(389.95 * (1 - ROLL_FIT_BUFFER), 9);
  });

  it('suggests the WHOLE position when the book holds it with the buffer to spare', () => {
    expect(suggestedRollSize(50_000, 1340)).toBe(1340);
    // Exactly at the edge: 1340 / 0.95 = 1410.53 of capacity is enough.
    expect(suggestedRollSize(1410.6, 1340)).toBe(1340);
    expect(suggestedRollSize(1410.4, 1340)).toBeLessThan(1340);
  });
});

describe('planBatch', () => {
  const SEED = 0.01;
  const CAP = 0.1;

  it('keeps the seed while the size fills inside it', () => {
    expect(planBatch([leg({}), leg({ depth: DEEP })], 370, SEED, CAP)).toEqual({ toleranceApr: 0.01, widened: false, limit: null });
  });

  it('widens for a size the seed cannot fill, with headroom, rounded up to 0.01%', () => {
    // 1,000 ETH reaches the +1.30% level: 1.30% × 1.1 = 1.43%.
    const plan = planBatch([leg({}), leg({ depth: DEEP })], 1000, SEED, CAP);
    expect(plan).toEqual({ toleranceApr: 0.0143, widened: true, limit: null });
    // …and the widened tolerance really does fill it.
    expect(capacityAt(HL, plan!.toleranceApr)).toBeGreaterThanOrEqual(1000);
  });

  it("gives up the headroom, not the fill, at the venue's band", () => {
    // Needs 1.30%; the band's usable 90% is 1.35% — under the 1.43% it would like.
    const plan = planBatch([leg({ maxToleranceApr: 0.015 }), leg({ depth: DEEP })], 1000, SEED, CAP);
    expect(plan).toEqual({ toleranceApr: 0.0135, widened: true, limit: null });
  });

  it('reports the rate limit when the size only fills past the band', () => {
    // The band stops at 1.2% (1.08% usable): the +1.30% level is out of reach, so 389.95 is the most.
    const plan = planBatch([leg({ maxToleranceApr: 0.012 }), leg({ depth: DEEP })], 1000, SEED, CAP);
    expect(plan?.limit).toEqual({ kind: 'rate-limit', marketName: 'Hyperliquid ETH 25 Sep 2026', maxSize: 389.95 });
  });

  it('reports liquidity when the whole book cannot supply the size', () => {
    const plan = planBatch([leg({}), leg({ depth: DEEP })], 4000, SEED, CAP);
    // The most that rolls stops at the usable band (2% × 0.9 = 1.8%), short of the 2.00% level.
    expect(plan?.limit).toEqual({ kind: 'liquidity', marketName: 'Hyperliquid ETH 25 Sep 2026', maxSize: 2623.05 });
  });

  it("never sets a tolerance at the band's very edge", () => {
    // The band allows exactly the 1.30% the size needs — but mid and mark
    // drift, so the edge is not usable: that is a rate limit, not a widening.
    const plan = planBatch([leg({ maxToleranceApr: 0.013 }), leg({ depth: DEEP })], 1000, SEED, CAP);
    expect(plan?.limit?.kind).toBe('rate-limit');
    expect(plan!.toleranceApr).toBeLessThanOrEqual(0.013 * 0.9 + 1e-9);
  });

  it("judges every leg against the batch's ONE tolerance, which the tighter band bounds", () => {
    // The HL leg needs 1.30% and its own band (2% × 0.9) would allow it; the
    // other leg's band stops at 1.2% (1.08% usable). One tolerance serves
    // both, so the HL leg cannot get its 1.30% — a rate limit, at the size
    // the shared bound does reach, not a silent clamp the venue then refuses.
    const plan = planBatch([leg({}), leg({ depth: DEEP, maxToleranceApr: 0.012 })], 1000, SEED, CAP);
    expect(plan?.limit).toEqual({ kind: 'rate-limit', marketName: 'Hyperliquid ETH 25 Sep 2026', maxSize: 389.95 });
    expect(plan!.toleranceApr).toBeLessThanOrEqual(0.012 * 0.9 + 1e-9);
  });

  it('has nothing to say until both legs carry a ladder', () => {
    expect(planBatch([leg({}), leg({ depth: null })], 100, SEED, CAP)).toBeNull();
    expect(planBatch([], 100, SEED, CAP)).toBeNull();
  });

  it('the tighter batch decides the most that rolls', () => {
    expect(maxRollSize([{ kind: 'liquidity', marketName: 'a', maxSize: 900 }, null, { kind: 'rate-limit', marketName: 'b', maxSize: 400 }])).toBe(400);
    expect(maxRollSize([null, null])).toBeNull();
  });
});

describe('fitAtBand — the default roll size is sized at the band, not the seed', () => {
  const CAP = 0.1;
  // Live 2026-09-23, the Gate / Hyperliquid 25 Sep pair (870 ETH): the HL
  // exit's best ask was a stray 0.01 ETH at 0.37%, then 1,000 ETH at 1.10%,
  // past the 1.0% seed. Sized at the seed the modal defaulted to 0.0095 ETH.
  const STRAY: Array<[number, number]> = [
    [0.0037, 0.01],
    [0.011, 1000.01],
    [0.0112, 1424.59],
  ];
  const GATE_EXIT: Array<[number, number]> = [
    [0.0012, 3.71],
    [0.0069, 251.76],
    [0.012, 325.23],
    [0.03, 900],
  ];
  const exit = [
    leg({ marketName: 'Gate ETHUSDT 25 Sep 2026', depth: GATE_EXIT, maxToleranceApr: 0.0182 }),
    leg({ marketName: 'Hyperliquid ETH 25 Sep 2026', depth: STRAY, maxToleranceApr: 0.0518 }),
  ];
  const entry = [leg({ depth: DEEP, maxToleranceApr: 0.02 }), leg({ depth: DEEP, maxToleranceApr: 0.02 })];

  it('looks past a stray level the seed stops at', () => {
    expect(capacityAt(STRAY, 0.01)).toBe(0.01);
    const fit = fitAtBand(exit, entry, CAP)!;
    expect(fit).toBeCloseTo(325.23, 9);
    expect(suggestedRollSize(fit, 870)).toBeGreaterThan(870 * 0.2);
  });

  it("bounds each batch by its tighter leg's band, as planBatch does", () => {
    // Gate's band (1.82% × 0.9 = 1.64%) binds the exit batch, so HL is read
    // at 1.64% — not at its own 4.66%, which would reach levels the batch's
    // one tolerance cannot.
    const wideHl = [exit[0], leg({ depth: [[0.0037, 0.01], [0.03, 5000]], maxToleranceApr: 0.0518 })];
    expect(fitAtBand(wideHl, entry, CAP)).toBe(0.01);
  });

  it('a size it suggests is one planBatch carries without a limit', () => {
    const size = suggestedRollSize(fitAtBand(exit, entry, CAP)!, 870);
    expect(planBatch(exit, size, 0.01, CAP)?.limit).toBeNull();
    expect(planBatch(entry, size, 0.01, CAP)?.limit).toBeNull();
  });

  it('never reads past the app cap', () => {
    const far = [leg({ depth: [[0.001, 1], [0.15, 9000]], maxToleranceApr: null }), leg({ depth: DEEP, maxToleranceApr: null })];
    expect(fitAtBand(far, entry, CAP)).toBe(1);
  });

  it('has nothing to say until all four legs carry a ladder', () => {
    expect(fitAtBand([exit[0], leg({ depth: null })], entry, CAP)).toBeNull();
    expect(fitAtBand(exit.slice(0, 1), entry, CAP)).toBeNull();
  });
});
