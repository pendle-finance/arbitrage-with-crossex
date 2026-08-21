/** Display-side strategy arithmetic shared by the home totals strip and
 * StrategyCard — the server never bakes the perp exit parts into any number
 * (each part folds in via its own toggle), and it always bakes the perp ENTRY
 * parts in, which the "rolled over" toggle backs out again. */

import type { PerpEntryCostPart } from '../api/types';

export const SECONDS_IN_YEAR = 365 * 24 * 3600;

/** The per-position cost assumptions. Entry and exit are INDEPENDENT: the
 * server seeds the exit slippage estimate from the observed entry gap
 * (`returns.ts`: "exit crossing assumed symmetric to entry"), but omitting a
 * rolled-in position's entry cost must not zero the cost of crossing back out. */
export interface CostFlags {
  inclExitFees: boolean;
  inclExitSlippage: boolean;
  /** The master switch. False = this strategy is NOT charged the perp entry
   * fees + entry slippage at all. Gate reports a position's fee CUMULATIVELY
   * and its entryPrice from the original open, so for a perp rolled into a new
   * maturity both predate the strategy — charging them here bills it for a
   * previous life's spending. */
  inclEntryCost: boolean;
  /** Ids of individual entry-cost parts to leave out while inclEntryCost is
   * true — for a book built across several executions, the ones that belong to
   * an earlier strategy. Empty/absent = charge everything (the default). */
  excludedEntryPartIds?: ReadonlySet<string>;
}

export interface CostsApplied {
  /** The exit cost actually folded in (0 when both off / unknown / no perps).
   * Can be NEGATIVE when the assumed exit slippage is favorable. */
  exitUsd: number;
  /** The entry cost handed BACK (0 while everything is charged). Signed — a
   * favorable (negative) entry slippage hands back negatively. */
  entryAddBackUsd: number;
  /** The same split by kind: ProfitBars nets each against its own bar, so the
   * charts shrink with the ticks instead of vanishing all at once. */
  entryAddBackFeesUsd: number;
  entryAddBackSlippageUsd: number;
  /** Current PnL under the ENTRY assumption only. The exit parts are future
   * costs — money not yet spent — so they never move the "now" line, only the
   * by-maturity target. */
  currentNetUsd: number;
  /** currentNetUsd less the assumed exit cost — the basis the realized APR is
   * re-annualized from. */
  netUsd: number;
  /** Server APR when untouched; re-annualized (same formula, adjusted
   * numerator) when either adjustment applies; null when it can't be re-derived. */
  apr: number | null;
  /** Null passes through from expectedPnlToMaturityUsd (unknowable clock). */
  expectedUsd: number | null;
}

/** Fold the chosen cost assumptions into the headline numbers. */
export function applyCostFlags(opts: {
  flags: CostFlags;
  /** feesUsd.future.perpExitFeesUsd — null = unknown, never guess. */
  perpExitFeesUsd: number | null;
  /** feesUsd.future.perpExitSlippageUsd — signed; null = unknown. */
  perpExitSlippageUsd: number | null;
  /** feesUsd.paid.perpTradingUsd — Gate's cumulative position fee. */
  perpEntryFeesUsd: number;
  /** feesUsd.paid.perpEntrySlippageUsd — signed; null = unknown. */
  perpEntrySlippageUsd: number | null;
  /** The itemised entry cost. Empty is fine — the master switch still works
   * off the aggregates, so an older payload degrades to all-or-nothing. */
  perpEntryParts?: readonly PerpEntryCostPart[];
  realizedPnlUsd: number;
  realizedApr: number | null;
  expectedPnlToMaturityUsd: number | null;
  capitalUsd: number;
  /** Annualization window (capital-weighted for totals); null = unknown. */
  elapsedSeconds: number | null;
}): CostsApplied {
  const feesPart =
    opts.flags.inclExitFees && opts.perpExitFeesUsd !== null && opts.perpExitFeesUsd > 0
      ? opts.perpExitFeesUsd
      : 0;
  // Slippage is signed — a favorable (negative) assumed exit still folds in.
  const slipPart =
    opts.flags.inclExitSlippage && opts.perpExitSlippageUsd !== null
      ? opts.perpExitSlippageUsd
      : 0;
  const exitUsd = feesPart + slipPart;
  // Both parts are ALREADY subtracted server-side — inside realizedPnlUsd (via
  // each leg's net) and inside expectedPnlToMaturityUsd (via paid.totalUsd) —
  // so leaving one out means adding it back. Unknown slippage counts as 0,
  // exactly as the server counts it when summing.
  const parts = opts.perpEntryParts ?? [];
  const excluded = opts.flags.excludedEntryPartIds;
  let entryAddBackFeesUsd: number;
  let entryAddBackSlippageUsd: number;
  if (!opts.flags.inclEntryCost) {
    // The master switch works off the AGGREGATES, not the parts, so it stays
    // exact even when the itemisation is unavailable.
    entryAddBackFeesUsd = opts.perpEntryFeesUsd;
    entryAddBackSlippageUsd = opts.perpEntrySlippageUsd ?? 0;
  } else {
    entryAddBackFeesUsd = 0;
    entryAddBackSlippageUsd = 0;
    for (const p of parts) {
      if (!excluded?.has(p.id)) continue; // unknown ids simply never match
      if (p.kind === 'fees') entryAddBackFeesUsd += p.usd;
      else entryAddBackSlippageUsd += p.usd;
    }
  }
  const entryAddBackUsd = entryAddBackFeesUsd + entryAddBackSlippageUsd;
  // The parts must decompose the aggregates exactly, or the numbers and the
  // waterfalls quietly disagree. Same doctrine as ProfitBars' drift guard.
  if (import.meta.env.DEV && parts.length > 0) {
    const summed = parts.reduce((a, p) => a + p.usd, 0);
    const aggregate = opts.perpEntryFeesUsd + (opts.perpEntrySlippageUsd ?? 0);
    if (Math.abs(summed - aggregate) > 0.01) {
      // eslint-disable-next-line no-console
      console.warn('entry parts drift', { summed, aggregate });
    }
  }
  const currentNetUsd = opts.realizedPnlUsd + entryAddBackUsd;
  const netUsd = currentNetUsd - exitUsd;
  let apr = opts.realizedApr;
  if ((exitUsd !== 0 || entryAddBackUsd !== 0) && apr !== null && opts.capitalUsd > 0) {
    apr =
      opts.elapsedSeconds !== null && opts.elapsedSeconds > 0
        ? (netUsd / opts.capitalUsd) * (SECONDS_IN_YEAR / opts.elapsedSeconds)
        : null;
  }
  return {
    exitUsd,
    entryAddBackUsd,
    entryAddBackFeesUsd,
    entryAddBackSlippageUsd,
    currentNetUsd,
    netUsd,
    apr,
    expectedUsd:
      opts.expectedPnlToMaturityUsd === null
        ? null
        : opts.expectedPnlToMaturityUsd + entryAddBackUsd - exitUsd,
  };
}

/**
 * A leg's size in tokens, or null when the dollars already say it.
 *
 * ONE rule, read off the leg — never off the card. A perp always qualifies:
 * `$85.6k` is a price times a quantity, and the quantity is the position. A
 * Boros leg qualifies only off USDT, because Boros notional is denominated in
 * the COLLATERAL, so `(100,000 USDT)` merely restates `$100.0k` while
 * `(43.1 ETH)` does not.
 *
 * Shared by the card's notional column and the share payload, which used to
 * carry their own copies of it — and a card-level "is this book
 * token-margined" flag that let one USDT Boros leg suppress the coin size of
 * every perp beside it.
 */
export function legTokenSize(l: {
  kind: 'perp' | 'boros';
  base: string;
  collateral?: string;
  notionalToken?: number;
}): { qty: number; symbol: string } | null {
  if (l.notionalToken === undefined || !(l.notionalToken > 0)) return null;
  if (l.kind === 'boros') {
    return l.collateral && l.collateral !== 'USDT'
      ? { qty: l.notionalToken, symbol: l.collateral }
      : null;
  }
  return { qty: l.notionalToken, symbol: l.base };
}
