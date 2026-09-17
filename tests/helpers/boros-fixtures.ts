/**
 * Shared Boros fixture bits. The CANONICAL 4-LEG ETH BOOK — Boros SHORT HL @8%
 * / LONG OKX @3%, $1M/leg, settlement cash 3205/1120, mtm 820/−300, Boros IM
 * 5000/leg, perp IM 12500/leg, perp funding 3120/−1940, fees −210/−202 (perp)
 * and 390/300 (Boros opens) — is encoded at TWO seams, each in its own shape:
 *   tests/unit/boros-returns.test.ts   (domain objects)
 *   tests/server/strategy.test.ts      (raw wire bodies)
 * Change the book in one place → change it in both (their expectation pins
 * are hand-derived from these numbers on purpose — do not compute them).
 * tests/unit/boros-opportunities.test.ts and tests/server/opportunities.test.ts
 * also import the helpers below, but their books are their own scenarios.
 */

/** 18-dec raw string (Number-parseable scientific notation is fine). */
export const raw = (n: number): string => String(n * 1e18);

/**
 * Initial-margin inputs of a `BorosMarket`, live-shaped from
 * HYPERLIQUID-ETH-31JUL2026 (2026-07): kIM 0.476 is the 2.1x preset, the floor
 * `1.00005 ** (770 × 2) − 1` ≈ 0.08004, tThresh 5d. Spread into market literals
 * that don't exercise the capital model themselves.
 */
export const imInputs = {
  kIM: 0.47619047619047616,
  imTickThresh: 770,
  imTickStep: 2,
  tThreshSec: 432_000,
} as const;
