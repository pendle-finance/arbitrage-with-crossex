/**
 * 4-leg strategy returns: join Boros funding-rate legs (by entered EVM address)
 * with the Gate CrossEx perp legs (connected account) and compute realized +
 * locked returns, net of all fees.
 *
 * The strategy (per boros-knowledge-base "fixed-return funding-rate arbitrage"):
 *   L1 perp SHORT on venue A  → receives A floating funding
 *   L2 perp LONG  on venue B  → pays     B floating funding   (delta-neutral)
 *   L3 Boros SHORT FR on A    → receives fixed rate_A, pays A floating
 *   L4 Boros LONG  FR on B    → pays     fixed rate_B, receives B floating
 * Floating cancels per venue → locked (rate_A − rate_B) APR on notional.
 *
 * Money conventions: every *Usd number is USD, positive = gain to the owner.
 * APRs are per-year decimal fractions. We SUM each leg's actual signed cash
 * flows (never "net out" the floating cancellation) so the totals reflect the
 * true near-cancellation plus any residual basis.
 *
 * Perp leg net = funding − trading fees (price MtM is EXCLUDED: on the
 * delta-neutral pair the two uPnLs cancel to entry-gap noise, which the
 * strategy already accounts as entry slippage — subtracted once at pair level
 * inside realizedPnlUsd). Funding is measured FROM THE STRATEGY CLOCK START:
 * when a perp position predates the clock (a pre-existing arb later locked on
 * Boros), the CrossEx account-book funding ledger re-bases it; Gate's
 * position-lifetime cumulative counter is only used when it equals the
 * since-start value (position opened at/after the clock) or as a warned
 * fallback when the ledger can't cover the window.
 */
import { resolveFeeRates, type VenueFeeRow } from '../estimate/fees';
import { parseSymbol } from '../numbers';
import {
  allocateBorosByEvidence,
  borosIncrements,
  solvePerpPartition,
  TIME_SCALE_SEC,
  type BorosIncrement,
  type DealFillRecord,
  type PerpFillRecord,
  type PerpLegSnapshot,
  type PerpPartition,
  type PerpTranche,
  type TrancheLeg,
  legRefKey,
  type LegRef,
  type MembershipRow,
  type TrancheConfidence,
  type TrancheSource,
  type UnhedgedResidual,
} from './partition';
import { bindExecutions, legsBoundTogether, type Atom as GroupingAtom } from './grouping';
import {
  BOROS_TOKEN_SYMBOLS,
  norm18,
  type BorosCollateralZone,
  type BorosMarket,
  type BorosMarketPosition,
  type BorosTxn,
} from './client';

export const SECONDS_IN_YEAR = 365 * 24 * 3600;

/** Structural subset of gate-api's CrossexPosition (all fields optional there). */
export interface PerpPositionLike {
  symbol?: string;
  positionId?: string;
  positionSide?: string;
  positionQty?: string;
  positionValue?: string;
  entryPrice?: string;
  leverage?: string;
  upnl?: string;
  fundingFee?: string;
  fee?: string;
  initialMargin?: string;
  createTime?: string;
}

/** One FUNDING_FEE settlement from the CrossEx account book, attributed to a
 * position (businessId = `{positionId}_{fundingTs}`). USD ≈ coin (USDT/USDC). */
export interface PerpFundingEntry {
  positionId: string;
  /** Unix seconds of the ledger row. */
  timeSec: number;
  /** Signed funding amount (positive = received). */
  changeUsd: number;
}

/** Per-position funding ledger + the earliest instant it covers. */
export interface PerpFundingLedger {
  byPosition: Map<string, PerpFundingEntry[]>;
  /** Unix seconds — rows older than this were not fetched; a clock start
   * before it means the ledger cannot re-base that strategy's funding. */
  coversFromSec: number;
}

/** One finished two-leg deal from the local engine journal, shaped by the
 * route. Both fills of one deal are contemporaneous by construction (the
 * engine hedges within seconds), so each deal's fill gap is pure crossing
 * cost — unlike the gap between two live entry averages, which absorbs every
 * market move between the legs' open times. Contracts are venue-qualified
 * CrossEx symbols. Defined in ./partition, which also matches on it. */
export type {
  DealFillRecord,
  PerpFillRecord,
  LegRef,
  MembershipRow,
  UnhedgedResidual,
} from './partition';

export interface StrategyLeg {
  kind: 'perp' | 'boros';
  /** Normalized venue key (BINANCE / HYPERLIQUID / …). */
  venue: string;
  base: string;
  side: 'LONG' | 'SHORT';
  notionalUsd: number;
  /** Boros only: the venue's own id for this market. How a membership row
   * names the leg — unambiguous where (venue, base, maturity) is not, since
   * one market can be listed in two collateral zones. */
  marketId?: number;
  /** Boros only: the collateral token the position is margined and sized in. */
  collateral?: string;
  /** |notional| in token units — Boros: |notionalSize| in the collateral token
   * (notionalUsd = notionalToken × its USD price); perp: |qty| in the base coin. */
  notionalToken?: number;
  /** Boros only: entry fixed APR and current mark APR. */
  entryApr?: number;
  markApr?: number;
  /**
   * The VENUE's own blended entry across every claim on this leg, when a user
   * assertion has moved this claim's own figure away from it.
   *
   * `entryApr` (Boros) and `entryPrice` (perp) become per-claim once anyone
   * asserts, so they can no longer answer "and what does the venue report?".
   * Without this the UI compared a number to itself and told the reader the
   * venue reported their own assertion. Absent when nothing was asserted, in
   * which case the two are the same number by definition.
   */
  venueEntry?: number;
  /**
   * Perp only: what THIS strategy's share of the leg entered at.
   *
   * Normally the venue's own blended entry, which is the same for every
   * strategy sharing the leg — so the UI could read it off the live position
   * and did. It stops being the same the moment a user asserts what their half
   * actually paid: the asserting card takes its number and the others take
   * whatever balances, and the venue's average is conserved across them (see
   * `entryByClaim`). At that point the live position's single figure is wrong
   * for every card, and the per-leg value has to come from here.
   *
   * Absent when nothing is known — a partial claim on a shared leg with no
   * assertion anywhere. The UI falls back to the venue's figure, as before.
   */
  entryPrice?: number;
  /** Boros only: the reference perp's live floating APR (from /markets). */
  floatingApr?: number;
  /** Funding (perp) or settlement (Boros, net of settle fees) cash to date. */
  cashFlowUsd: number;
  /** Boros only: the settlement fees this leg has ALREADY paid, accrued as
   * notional × settleFeeApr × elapsed — the per-leg share of
   * `feesUsd.paid.borosSettlementUsd`, which is the sum of exactly this.
   *
   * Exposed because `cashFlowUsd` arrives net of it: a "before costs" reading
   * of the leg has to add it back, and the alternative — splitting the
   * strategy-level total across legs by a ratio — would be an estimate where
   * this is exact. Display-only, like the aggregate: never re-subtract it. */
  settlementFeePaidUsd?: number;
  /** Mark-to-market of the open position. */
  mtmUsd: number;
  /** Realized trade PnL NET of trade fees (Boros closes/partials; 0 for pure holds). */
  tradePnlUsd: number;
  /** Trading fees paid, as a POSITIVE cost number. */
  feesUsd: number;
  /** The leg's bottom line (fees not double-subtracted where already netted). */
  netUsd: number;
  /** Unix seconds the position was opened, when known. */
  openedAt: number | null;
  /** Boros only: unix-seconds maturity of the market. */
  maturity?: number;
  /** Perp only: the exact CrossEx symbol — the client's join key to the live
   * 4s-polled position (entry/mark/leverage display + close/lev actions). */
  symbol?: string;
  /** The fraction of the venue's position attributed to THIS strategy — 1
   * when the strategy owns the whole leg. Every shared number on the leg
   * (funding, fees, margin, notional) is already scaled by it; it is carried
   * so the UI can say "this is part of a bigger position". */
  share?: number;
  warnings: string[];
}

/** One tickable piece of a strategy's PAID perp entry cost.
 *
 * INVARIANT: the parts always sum to
 *   paid.perpTradingUsd + (paid.perpEntrySlippageUsd ?? 0)
 * — the client subtracts the un-ticked ones from exactly those two aggregates,
 * so any drift shows up immediately as a waterfall that misses its total.
 *
 * The two kinds are NOT symmetric, and the UI has to say so:
 *  - `slippage` is genuinely per-execution — one part per journal deal (a venue
 *    migration or a DCA top-up each get their own), or a single whole-book part
 *    when both legs were opened together.
 *  - `fees` is per LEG, covering that position's whole life. Gate reports a
 *    position's `fee` as one cumulative scalar, and neither the deal journal nor
 *    the funding ledger records a trading fee at any finer granularity, so a
 *    per-execution split would be a fabrication. A leg migrated away from has no
 *    live position and therefore contributes nothing here at all. */
export interface PerpEntryCostPart {
  /** Stable across reloads: the client persists the un-ticked ids. */
  id: string;
  kind: 'slippage' | 'fees';
  /** Signed — a favorable crossing is negative. */
  usd: number;
  /** Unix seconds; null when the cost has no single point in time (a leg's
   * lifetime fees). */
  atSec: number | null;
  /** Two venues for a slippage part (the pair that was crossed), one for fees. */
  venues: string[];
  /** Fees parts only. */
  side: 'LONG' | 'SHORT' | null;
  /** Matched qty — slippage parts only. */
  qty: number | null;
}

/** The strategy's cost ledger, split by whether the money is already gone
 * (paid) or still ahead (future). Feeds `expectedPnlToMaturityUsd`:
 * spread return − paid.totalUsd − future.borosSettlementUsd; the perp exit
 * parts are NOT baked in — the client folds each in via its own checkbox. */
export interface StrategyFees {
  paid: {
    /** Gate live position `fee` — exact for open positions. */
    perpTradingUsd: number;
    /** Entry crossing cost: (entry price of the LONG − entry price of the
     * SHORT) × matched qty. Signed — negative means the pair was entered at a
     * favorable gap. Null unless the strategy has exactly 1 long + 1 short
     * perp leg (no other reading is computable). */
    perpEntrySlippageUsd: number | null;
    /** Σ actual per-fill fees from /pnl/transactions since open — exact. */
    borosTradeUsd: number;
    /** Accrued settlement fees, estimated as notional × settleFeeApr × elapsed.
     * Display-only: settlement PnL is already NET of these (never re-subtract). */
    borosSettlementUsd: number;
    /** Sum of the above; a null slippage counts as 0 (a warning says so). */
    totalUsd: number;
  };
  future: {
    /** Exit trading fees assuming maker+hedge execution: maker rate on one
     * perp leg + taker on the other, cheaper assignment. Falls back to taker
     * on every leg when the strategy isn't a simple 2-leg pair. 0 when no
     * perp legs; null when perps exist but the fee schedule is unknown. */
    perpExitFeesUsd: number | null;
    /** Assumed equal to paid.perpEntrySlippageUsd (symmetric crossing cost). */
    perpExitSlippageUsd: number | null;
    /** Σ notional × settleFeeApr × time remaining to maturity — the exact
     * amount already subtracted inside expectedPnlToMaturityUsd. */
    borosSettlementUsd: number;
    /** Sum of the above; null propagates from the perp exit parts. */
    totalUsd: number | null;
  };
}

export type HedgeStatus = 'hedged' | 'partial' | 'unhedged';

/**
 * The three sizing checks that must ALL pass before the strategy's headline
 * numbers (APR on capital, capital, PnL by maturity) describe a real 4-leg
 * position rather than one still being built. Each ratio is matched/larger
 * (min/max), 0 when a side is absent entirely:
 *  - `borosMatchRatio`  — LONG-fixed vs SHORT-fixed Boros notional (> 0.9);
 *  - `perpMatchRatio`   — LONG vs SHORT perp notional (> 0.9);
 *  - `borosVsPerpRatio` — gross Boros vs gross perp notional (> 0.8).
 * `fullyHedged` is false whenever the perp side is not visible at all
 * (perpSource null): an unverifiable hedge is not a hedge. This is distinct
 * from `hedge`, the per-venue floating-cancellation band — that one asks "do
 * the venue rates cancel", this one asks "is the whole book actually built".
 */
export interface HedgeChecks {
  borosMatchRatio: number;
  perpMatchRatio: number;
  borosVsPerpRatio: number;
  fullyHedged: boolean;
}

export const BOROS_LEG_MATCH_MIN = 0.9;
export const PERP_LEG_MATCH_MIN = 0.9;
export const BOROS_VS_PERP_MATCH_MIN = 0.8;

/**
 * What counts as the capital a Boros position ties up.
 *  - `balance` — the margin group's posted balance, apportioned across its
 *    positions by initial-margin share. Right when the account exists FOR this
 *    position; it over-states capital for anyone who also keeps trading money
 *    in the same collateral account, because idle cash is counted as if the
 *    strategy needed it.
 *  - `im` — only the initial margin the Boros legs actually consume. Right
 *    when the account is shared, and the same basis the perp side always uses.
 * The perp side is initial margin under both.
 */
export type CapitalBasis = 'balance' | 'im';

/** What anchors the realized-APR annualization clock. Default: the strategy
 * starts when its Boros legs lock the spread — the perp pair may have existed
 * long before as a plain funding arb. */
export type ClockBasis = 'boros-open' | 'perp-open' | 'custom';

/** How this strategy's share of each shared leg was arrived at.
 *  - `journal` / `fill-history` — rebuilt from the execution record: sizes,
 *    both entry prices and (fill-history only) exact fees are MEASURED.
 *  - `forced` — only one pairing was possible, so no choice was made.
 *  - `proximity` — no record explained it; paired on price/time closeness.
 *  - `user` — a pinned size the user asserted.
 *  - `merged` — not split at all (one strategy per Boros cohort, the legacy
 *    reading), either because nothing needed splitting or because a split
 *    failed to reconcile.
 *  - `boros-only` — Boros legs with no perp tranche to attach to.
 *  - `unhedged` — the mirror of `boros-only`: perp size no position claimed,
 *    which is a position of one leg rather than a footnote beside them. */
export interface StrategyAttribution {
  source: TrancheSource | 'merged' | 'boros-only' | 'unhedged';
  confidence: TrancheConfidence;
  pinned: boolean;
}

export interface StrategyRollup {
  /** Stable identity across re-solves — `BASE#VENUE-VENUE#openDay` for a
   * split strategy, `BASE@maturity` for a merged one. The client keys pins,
   * excluded entry parts and share links off this. */
  strategyId: string;
  attribution: StrategyAttribution;
  base: string;
  /** Unix seconds (the Boros cohort's maturity). */
  maturity: number;
  legs: StrategyLeg[];
  hedge: HedgeStatus;
  /** Sizing gate for the headline numbers — see HedgeChecks. */
  hedgeChecks: HedgeChecks;
  capitalUsd: number;
  /** capitalUsd's two components: the perp legs' initial margin on CrossEx +
   * the Boros margin-group balance apportioned to this strategy. Sums to
   * capitalUsd by construction. */
  capitalSplit: { perpUsd: number; borosUsd: number };
  realizedPnlUsd: number;
  /** Annualized realized return on capital; null when too early / unknowable. */
  realizedApr: number | null;
  /** Locked fixed spread across the Boros legs (≈ rate_A − rate_B). */
  spread: number;
  lockedAprOnCapital: number;
  /** Full-life projection of the locked spread on the Boros notional:
   * (grossBorosNotional/2) × spread × (maturity − clockStart)/YEAR. Assumes the
   * spread was locked on the full notional since the strategy start — the UI
   * shows that assumption. Null when the clock start is unknown. */
  spreadReturnUsd: number | null;
  /** Vu's formula: spreadReturnUsd − feesUsd.paid.totalUsd −
   * feesUsd.future.borosSettlementUsd. The perp exit parts (fees + slippage)
   * are NOT included — the client folds each in via its own checkbox. Null
   * exactly when spreadReturnUsd is null. */
  expectedPnlToMaturityUsd: number | null;
  elapsedSeconds: number | null;
  clockBasis: ClockBasis | null;
  /** The clock's start instant (unix seconds) — lets the UI show the DATE the
   * spread-lock assumption runs from. Null when unknown. */
  clockStartSec: number | null;
  secondsToMaturity: number;
  /** Σ per-venue |residual floating notional| — 0 when perfectly hedged. */
  notionalMismatchUsd: number;
  feesUsd: StrategyFees;
  /** The PAID perp entry cost, itemised so the client can let a user drop the
   * executions that belong to an earlier strategy. Sums to
   * feesUsd.paid.perpTradingUsd + (feesUsd.paid.perpEntrySlippageUsd ?? 0). */
  perpEntryCostParts: PerpEntryCostPart[];
  /** Plain-language sentences, ready to render. */
  warnings: string[];
}

export interface StrategyReturns {
  address: string;
  /** null when Gate isn't configured — Boros-only view. */
  perpSource: 'connected-gate-account' | null;
  strategies: StrategyRollup[];
  totals: {
    capitalUsd: number;
    realizedPnlUsd: number;
    realizedApr: number | null;
    /** Σ non-null strategy projections. */
    expectedPnlToMaturityUsd: number;
    /** Σ paid fees (future costs are not "fees paid" — see per-strategy split). */
    feesTotalUsd: number;
    /** Σ future.perpExitFeesUsd; null if any strategy's schedule is unknown. */
    perpExitFeesTotalUsd: number | null;
    /** Σ future.perpExitSlippageUsd; null if any strategy's is unknown. */
    perpExitSlippageTotalUsd: number | null;
    /** How many strategies could not measure their crossing cost. Lets the UI
     * say "unknown for 2 of 5" instead of blanking the total with no reason. */
    slippageUnknownCount: number;
    strategyCount: number;
  };
  /** Which reading of "capital" produced every capital-derived number here. */
  capitalBasis: CapitalBasis;
  warnings: string[];
}

const fin = (v: string | number | undefined | null): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Boros platformName / CrossEx exchange → one venue key space. */
export function normalizeVenue(venue: string): string {
  return venue.trim().toUpperCase();
}

// ---------------------------------------------------------------------------
// Leg builders
// ---------------------------------------------------------------------------

/** Per-market digest of the txn history: exact fees + open time of the CURRENT
 * position (the latest open-from-flat event; everything after it belongs to
 * this position). Values stay in collateral-token units here. */
interface TxnDigest {
  openedAt: number | null;
  feesSinceOpen: number;
  tradePnlSinceOpen: number;
  sawAnyTxn: boolean;
}

function digestTxns(txns: BorosTxn[], marketId: number): TxnDigest {
  const forMarket = txns.filter((t) => t.marketId === marketId).sort((a, b) => a.time - b.time);
  if (!forMarket.length) {
    return { openedAt: null, feesSinceOpen: 0, tradePnlSinceOpen: 0, sawAnyTxn: false };
  }
  let openIdx = 0;
  for (let i = forMarket.length - 1; i >= 0; i -= 1) {
    if (fin(forMarket[i].prevPositionS) === 0 && fin(forMarket[i].postPositionS) !== 0) {
      openIdx = i;
      break;
    }
  }
  const current = forMarket.slice(openIdx);
  return {
    openedAt: current[0].time || null,
    feesSinceOpen: current.reduce((s, t) => s + Math.abs(norm18(t.fee)), 0),
    tradePnlSinceOpen: current.reduce((s, t) => s + norm18(t.pnl), 0),
    sawAnyTxn: true,
  };
}

interface BorosLegBuild {
  leg: StrategyLeg;
  /** Boros market id — the join key to this position's fill history, which is
   * what makes a per-strategy entry rate measurable instead of allocated. */
  marketId: number;
  /** Stable identity of the margin group this position sits in. */
  groupKey: string;
  /** For capital apportionment (all USD). */
  groupNetBalanceUsd: number;
  groupInitialMarginUsd: number;
  positionInitialMarginUsd: number;
  settleFeeApr: number;
  paymentPeriod: number;
}

interface PerpLegBuild {
  leg: StrategyLeg;
  /** Gate initialMargin — the capital this leg consumes. */
  imUsd: number;
  /** Full CrossEx symbol — needed to resolve the venue's exit fee rates. */
  symbol: string;
  /** Average entry price + absolute qty — feed the entry-slippage estimate. */
  entryPrice: number;
  qty: number;
  /** Gate position id — joins the account-book funding ledger. */
  positionId: string;
  /** When the VENUE position opened. Kept separate from `leg.openedAt`, which
   * a tranche re-stamps to its own open: the cumulative funding counter still
   * starts here, so the re-base guard has to read this one. */
  venueOpenedAtSec: number | null;
  /** Gate's position-lifetime cumulative funding (the since-open counter). */
  cumulativeFundingUsd: number;
  /** Fraction of the venue position this build represents (1 = the whole
   * leg). Everything on the build is already scaled by it; the ledger re-base
   * below has to apply it too, because the ledger measures the WHOLE
   * position. */
  share: number;
  /** When the venue leg is SHARED and every sibling tranche's open is known:
   * this build's fraction of the position at each moment — entries sorted by
   * `fromSec`, each active until the next, 0 before the first. The funding
   * re-base uses it so settlements from before a later sibling opened are not
   * scaled by the FINAL share. Absent = the share never changed (or the
   * timeline is unknowable) and the flat `share` applies. */
  shareTimeline?: Array<{ fromSec: number; share: number }>;
}

function buildBorosLeg(
  p: BorosMarketPosition,
  px: number,
  markets: Map<number, BorosMarket>,
  txns: BorosTxn[],
  group: { key: string; collateral: string; netBalanceUsd: number; initialMarginUsd: number },
): BorosLegBuild {
  const market = markets.get(p.marketId);
  const legWarnings: string[] = [];
  if (!market) {
    legWarnings.push(
      `Boros market #${p.marketId} is missing from /markets — using position-level rates; settlement-fee estimate skipped.`,
    );
  }
  const digest = digestTxns(txns, p.marketId);
  if (!digest.sawAnyTxn) {
    legWarnings.push(
      `No trade history found for ${market?.name ?? `market #${p.marketId}`} — trade fees may be understated and the open time is unknown.`,
    );
  }

  const signed = norm18(p.notionalSize);
  const side: 'LONG' | 'SHORT' = signed >= 0 ? 'LONG' : 'SHORT';
  const cashFlowUsd = norm18(p.pnl.rateSettlementPnl) * px;
  const mtmUsd = norm18(p.pnl.unrealisedPnl) * px;
  const tradePnlUsd = digest.tradePnlSinceOpen * px;

  return {
    marketId: p.marketId,
    leg: {
      kind: 'boros',
      marketId: p.marketId,
      venue: normalizeVenue(market?.venue ?? ''),
      base: (market?.base ?? '').toUpperCase(),
      side,
      notionalUsd: Math.abs(signed) * px,
      collateral: group.collateral,
      notionalToken: Math.abs(signed),
      entryApr: p.fixedApr,
      markApr: p.markApr || market?.markApr,
      floatingApr: market?.floatingApr,
      cashFlowUsd,
      mtmUsd,
      // tradePnlUsd is NET of fees (txn.pnl includes −fee); netUsd must not
      // subtract fees again. feesUsd is the display breakdown of that cost.
      tradePnlUsd,
      feesUsd: digest.feesSinceOpen * px,
      netUsd: cashFlowUsd + mtmUsd + tradePnlUsd,
      openedAt: digest.openedAt,
      maturity: market?.maturity,
      warnings: legWarnings,
    },
    groupKey: group.key,
    groupNetBalanceUsd: group.netBalanceUsd,
    groupInitialMarginUsd: group.initialMarginUsd,
    positionInitialMarginUsd: norm18(p.positionInitialMargin ?? p.initialMargin) * px,
    settleFeeApr: market?.settleFeeApr ?? 0,
    paymentPeriod: market?.paymentPeriod ?? 0,
  };
}

function buildBorosLegs(
  zones: BorosCollateralZone[],
  markets: Map<number, BorosMarket>,
  txnsByToken: Map<number, BorosTxn[]>,
  pricesUsd: Map<number, number | null>,
  warnings: string[],
): BorosLegBuild[] {
  const out: BorosLegBuild[] = [];
  for (const zone of zones) {
    const groups = [...(zone.cross ? [zone.cross] : []), ...zone.isolated];
    const hasPositions = groups.some((g) => g.marketPositions.some((p) => fin(p.notionalSize) !== 0));
    if (!hasPositions) continue;

    const sym = BOROS_TOKEN_SYMBOLS[zone.tokenId] ?? `token#${zone.tokenId}`;
    const px = pricesUsd.get(zone.tokenId) ?? null;
    if (px === null) {
      warnings.push(
        `Can't price the ${sym} collateral zone in USD (no reference market) — its positions are excluded.`,
      );
      continue;
    }

    const txns = txnsByToken.get(zone.tokenId) ?? [];
    groups.forEach((group, gi) => {
      const groupCtx = {
        key: `${zone.tokenId}:${group.isCross ? 'cross' : `iso${gi}`}`,
        collateral: sym,
        netBalanceUsd: norm18(group.netBalance) * px,
        initialMarginUsd: group.marketPositions.reduce(
          (s, p) => s + norm18(p.positionInitialMargin ?? p.initialMargin) * px,
          0,
        ),
      };
      for (const p of group.marketPositions) {
        if (norm18(p.notionalSize) === 0) continue;
        out.push(buildBorosLeg(p, px, markets, txns, groupCtx));
      }
    });
  }
  return out;
}

function buildPerpLeg(pos: PerpPositionLike): PerpLegBuild {
  const { exchange, base } = parseSymbol(pos.symbol ?? '');
  const qty = fin(pos.positionQty);
  const side: 'LONG' | 'SHORT' =
    (pos.positionSide ?? '').toUpperCase() === 'SHORT' || qty < 0 ? 'SHORT' : 'LONG';
  const cashFlowUsd = fin(pos.fundingFee);
  const mtmUsd = fin(pos.upnl);
  // Gate reports `fee` as the position's cumulative trading fees; its sign is
  // not documented — treat it as a cost either way.
  const feesUsd = Math.abs(fin(pos.fee));
  const openedAtRaw = fin(pos.createTime);
  return {
    leg: {
      kind: 'perp',
      venue: normalizeVenue(exchange),
      base: base.toUpperCase(),
      side,
      notionalUsd: Math.abs(fin(pos.positionValue)),
      notionalToken: Math.abs(qty),
      cashFlowUsd,
      // Display-only for perps: the delta-neutral pair's price MtM nets to
      // entry-gap noise, which the strategy accounts as entry slippage.
      mtmUsd,
      tradePnlUsd: 0,
      feesUsd,
      // Perp net EXCLUDES price MtM: funding − fees. The funding may still be
      // re-based to the strategy clock in assembleStrategy (ledger permitting).
      netUsd: cashFlowUsd - feesUsd,
      // createTime may be seconds or milliseconds — normalize to seconds.
      openedAt:
        openedAtRaw > 0 ? (openedAtRaw < 1e12 ? openedAtRaw : Math.floor(openedAtRaw / 1000)) : null,
      symbol: pos.symbol,
      warnings: [],
    },
    imUsd: Math.abs(fin(pos.initialMargin)),
    symbol: pos.symbol ?? '',
    entryPrice: fin(pos.entryPrice),
    qty: Math.abs(qty),
    positionId: pos.positionId ?? '',
    venueOpenedAtSec:
      openedAtRaw > 0 ? (openedAtRaw < 1e12 ? openedAtRaw : Math.floor(openedAtRaw / 1000)) : null,
    cumulativeFundingUsd: cashFlowUsd,
    share: 1,
  };
}

// ---------------------------------------------------------------------------
// Strategy assembly
// ---------------------------------------------------------------------------

const signedNotional = (leg: StrategyLeg): number =>
  leg.side === 'LONG' ? leg.notionalUsd : -leg.notionalUsd;

/** Floating-rate exposure sign: a Boros LONG receives floating (+), a perp
 * LONG pays funding (−); shorts are the opposite. Per venue these should net
 * to ~0 when the 4-leg hedge is on. */
const floatingExposure = (leg: StrategyLeg): number =>
  leg.kind === 'boros' ? signedNotional(leg) : -signedNotional(leg);

/** Boros fixed-rate cash direction: SHORT receives fixed (+), LONG pays (−). */
const fixedSign = (leg: StrategyLeg): number => (leg.side === 'SHORT' ? 1 : -1);

/** |net|/gross band under which a venue's floating counts as cancelled —
 * matches computeExposure's delta-neutrality band. */
const HEDGE_BAND = 0.02;

/** Longest standard perp funding interval (Binance et al. settle every 8h).
 * Within this window of the strategy start, a pre-existing position with an
 * empty funding ledger is normal — the first settlement boundary since the
 * lock may simply not have passed yet. Beyond it, absence is suspicious. */
const FUNDING_LEDGER_GRACE_SEC = 8 * 3600;

/** Widest open-time gap at which the two live entry averages still count as
 * contemporaneous. A position's createTime stamps at its FIRST fill and the
 * engine hedges each fill within seconds, so even a long-resting maker opens
 * both positions moments apart once filling starts; 3× the 5-minute convert
 * deadline tolerates re-pegs and slow partial starts. Beyond it the entry gap
 * absorbs market drift and stops being slippage. */
const PERP_ENTRY_SYNC_MAX_SEC = 15 * 60;

/**
 * Above this fraction of the matched notional, an ESTIMATED entry slippage is
 * flagged as probably market drift rather than a cost that was paid.
 *
 * Estimates only ever come from legs opened far enough apart that the gap
 * between their entries includes whatever the coin did in between. A genuine
 * crossing cost on a liquid perp pair is basis points; half a percent is
 * already an order of magnitude more than the spread, so past that the number
 * is telling you about the market, not about the trade. Below it, saying
 * anything would train the user to dismiss the warning that matters.
 */
const ESTIMATED_SLIPPAGE_WARN_FRACTION = 0.005;

/** How far before the earliest live position's open the deal chain may reach:
 * a deal row's created_at precedes the position's first fill by however long
 * the maker rested, so the window must cover intent-to-first-fill lag. */
const DEAL_CHAIN_LOOKBACK_SEC = 48 * 3600;

/** Relative tolerance for the chain's qty reconciliation — absorbs lot
 * rounding and dust-sized unhedged remainders (mirrors HEDGE_BAND). */
const DEAL_CHAIN_QTY_BAND = 0.02;

/** True entry slippage of a book built across several executions: the sum of
 * each journal deal's own contemporaneous fill gap. Valid only when the deals
 * fully explain the live book — the signed filled quantities must net to the
 * live legs' sizes (and to ~zero on every intermediate venue), else some of
 * the book was built off-journal and a sum would silently be wrong: null,
 * never a guess. Venue is deliberately NOT matched per deal — a migration
 * chain flows through venues the live book no longer holds. */
export function chainPerpEntrySlippageUsd(
  deals: DealFillRecord[],
  pair: {
    base: string;
    longSymbol: string;
    longQty: number;
    shortSymbol: string;
    shortQty: number;
    earliestOpenSec: number | null;
  },
): { usd: number; deals: number; parts: PerpEntryCostPart[] } | null {
  const sinceSec = (pair.earliestOpenSec ?? 0) - DEAL_CHAIN_LOOKBACK_SEC;
  const netQtyBySymbol = new Map<string, number>();
  const parts: PerpEntryCostPart[] = [];
  let gapUsd = 0;
  let used = 0;
  for (const d of deals) {
    if (d.createdAtSec < sinceSec) continue;
    if (parseSymbol(d.aContract).base !== pair.base || parseSymbol(d.bContract).base !== pair.base)
      continue;
    if (d.aSide === d.bSide) return null; // not an opposing pair — journal corruption
    const matched = Math.min(d.aFilled, d.bFilled);
    if (!(matched > 0) || !(d.aAvgFill > 0) || !(d.bAvgFill > 0)) return null;
    const longFill = d.aSide === 'BUY' ? d.aAvgFill : d.bAvgFill;
    const shortFill = d.aSide === 'BUY' ? d.bAvgFill : d.aAvgFill;
    const dealGapUsd = (longFill - shortFill) * matched;
    gapUsd += dealGapUsd;
    // Same arithmetic, kept per deal: the caller lists these so a user can
    // drop the executions that belong to an EARLIER strategy.
    parts.push({
      id: `slip:deal:${d.dealId}`,
      kind: 'slippage',
      usd: dealGapUsd,
      atSec: d.createdAtSec,
      venues: [parseSymbol(d.aContract).exchange, parseSymbol(d.bContract).exchange].map(
        normalizeVenue,
      ),
      side: null,
      qty: matched,
    });
    netQtyBySymbol.set(
      d.aContract,
      (netQtyBySymbol.get(d.aContract) ?? 0) + (d.aSide === 'BUY' ? d.aFilled : -d.aFilled),
    );
    netQtyBySymbol.set(
      d.bContract,
      (netQtyBySymbol.get(d.bContract) ?? 0) + (d.bSide === 'BUY' ? d.bFilled : -d.bFilled),
    );
    used++;
  }
  if (used === 0) return null;
  const band = DEAL_CHAIN_QTY_BAND * Math.max(pair.longQty, pair.shortQty);
  const expected = (symbol: string): number =>
    symbol === pair.longSymbol ? pair.longQty : symbol === pair.shortSymbol ? -pair.shortQty : 0;
  const symbols = new Set([...netQtyBySymbol.keys(), pair.longSymbol, pair.shortSymbol]);
  for (const s of symbols) {
    if (Math.abs((netQtyBySymbol.get(s) ?? 0) - expected(s)) > band) return null;
  }
  return { usd: gapUsd, deals: used, parts };
}

interface AssembleInput {
  strategyId: string;
  attribution: StrategyAttribution;
  base: string;
  maturity: number;
  borosBuilds: BorosLegBuild[];
  perpBuilds: PerpLegBuild[];
  perpAvailable: boolean;
  nowSec: number;
  clockStartOverrideSec?: number;
  venueFees?: VenueFeeRow[] | null;
  fundingLedger?: PerpFundingLedger | null;
  dealFills?: DealFillRecord[] | null;
  capitalBasis: CapitalBasis;
}

function assembleStrategy(args: AssembleInput): StrategyRollup {
  const {
    strategyId,
    attribution,
    base,
    maturity,
    borosBuilds,
    perpBuilds,
    perpAvailable,
    nowSec,
    clockStartOverrideSec,
    venueFees,
    fundingLedger,
    dealFills,
    capitalBasis,
  } = args;
  const warnings: string[] = [];
  const borosLegs = borosBuilds.map((b) => b.leg);
  const perpLegs = perpBuilds.map((b) => b.leg);
  const legs = [
    ...perpLegs.slice().sort((a, b) => a.venue.localeCompare(b.venue)),
    ...borosLegs.slice().sort((a, b) => a.venue.localeCompare(b.venue)),
  ];
  for (const leg of legs) warnings.push(...leg.warnings);

  // --- Hedge health: per-venue floating cancellation ------------------------
  const venues = [...new Set(legs.map((l) => l.venue))];
  let notionalMismatchUsd = 0;
  let anyVenueOutOfBand = false;
  for (const venue of venues) {
    const atVenue = legs.filter((l) => l.venue === venue);
    const net = atVenue.reduce((s, l) => s + floatingExposure(l), 0);
    const gross = atVenue.reduce((s, l) => s + l.notionalUsd, 0);
    notionalMismatchUsd += Math.abs(net);
    if (gross > 0 && Math.abs(net) / gross > HEDGE_BAND) {
      anyVenueOutOfBand = true;
      const hasBoros = atVenue.some((l) => l.kind === 'boros');
      const hasPerp = atVenue.some((l) => l.kind === 'perp');
      // Naming the venue is only worth it when SOME other venue on this card
      // does have its perp. With no perp legs at all the card-level warning
      // below says the same thing once, instead of once per venue.
      if (perpAvailable && hasBoros && !hasPerp && perpLegs.length > 0) {
        warnings.push(
          `No ${venue} perp found for ${base} in the connected Gate account — that side's floating rate is unhedged.`,
        );
      } else if (hasBoros && hasPerp) {
        warnings.push(
          `${venue} legs are imbalanced by $${Math.round(Math.abs(net)).toLocaleString('en-US')} of notional — the locked rate only covers the matched part.`,
        );
      }
    }
  }
  // A hedge here is a FIXED leg cancelling a FLOATING one, so it takes both
  // kinds. One side alone is unhedged whichever side is missing — perps with
  // no Boros lock nothing, exactly as Boros with no perps hedges nothing.
  // ('partial' is for a book that has both and sized them unevenly.)
  let hedge: HedgeStatus;
  if (!perpAvailable) {
    hedge = 'partial'; // can't see the perp side — don't assert either way
  } else if (!perpLegs.length) {
    hedge = 'unhedged';
    warnings.push(
      `No matching perp legs for ${base} in the connected Gate account — the floating side is unhedged (or hedged elsewhere).`,
    );
  } else if (!borosLegs.length) {
    hedge = 'unhedged';
    const bothSides =
      perpLegs.some((l) => l.side === 'LONG') && perpLegs.some((l) => l.side === 'SHORT');
    warnings.push(
      bothSides
        ? `No Boros legs in this ${base} position — the funding spread is floating, not locked.`
        : `No Boros legs in this ${base} position — its funding is directional, not locked.`,
    );
  } else {
    hedge = anyVenueOutOfBand ? 'partial' : 'hedged';
  }

  // --- Sizing gate for the headline numbers ---------------------------------
  // APR-on-capital, capital and PnL-by-maturity all assume the spread is
  // locked on a BUILT book. While the position is still being entered (one
  // Boros leg filled, hedge lagging, perps sized differently), those numbers
  // are confidently wrong — e.g. the full-life spread projection on half the
  // notional. The ratios are matched/larger per check; the perp side counts 0
  // when invisible, because an unverifiable hedge is not a hedge.
  const sideSum = (ls: StrategyLeg[], side: StrategyLeg['side']): number =>
    ls.filter((l) => l.side === side).reduce((s, l) => s + l.notionalUsd, 0);
  const matchRatio = (a: number, b: number): number => {
    const hi = Math.max(a, b);
    return hi > 0 ? Math.min(a, b) / hi : 0;
  };
  const grossBoros = borosLegs.reduce((s, l) => s + l.notionalUsd, 0);
  const grossPerp = perpAvailable ? perpLegs.reduce((s, l) => s + l.notionalUsd, 0) : 0;
  const hedgeChecks: HedgeChecks = {
    borosMatchRatio: matchRatio(sideSum(borosLegs, 'LONG'), sideSum(borosLegs, 'SHORT')),
    perpMatchRatio: perpAvailable ? matchRatio(sideSum(perpLegs, 'LONG'), sideSum(perpLegs, 'SHORT')) : 0,
    borosVsPerpRatio: matchRatio(grossBoros, grossPerp),
    fullyHedged: false, // set below from the three ratios
  };
  hedgeChecks.fullyHedged =
    hedgeChecks.borosMatchRatio > BOROS_LEG_MATCH_MIN &&
    hedgeChecks.perpMatchRatio > PERP_LEG_MATCH_MIN &&
    hedgeChecks.borosVsPerpRatio > BOROS_VS_PERP_MATCH_MIN;

  // --- Capital ---------------------------------------------------------------
  // Perp side: initial margin of the matched legs (positions sit on shared
  // CrossEx collateral; IM is what the pair actually consumes). Boros side:
  // apportion each margin group's netBalance (cash actually posted) across
  // its positions by initial-margin share — a group can back several
  // strategies, so never count its full balance more than once.
  const perpCapitalUsd = perpBuilds.reduce((s, b) => s + b.imUsd, 0);
  const byGroup = new Map<string, { balance: number; groupIm: number; strategyIm: number }>();
  for (const b of borosBuilds) {
    const entry = byGroup.get(b.groupKey) ?? {
      balance: b.groupNetBalanceUsd,
      groupIm: b.groupInitialMarginUsd,
      strategyIm: 0,
    };
    entry.strategyIm += b.positionInitialMarginUsd;
    byGroup.set(b.groupKey, entry);
  }
  let borosCapitalUsd = 0;
  if (capitalBasis === 'im') {
    // Only what the legs actually post. A collateral account shared with other
    // trading holds cash this strategy never needed, and counting it drags the
    // APR down for a position that is doing fine.
    borosCapitalUsd = borosBuilds.reduce((s, b) => s + b.positionInitialMarginUsd, 0);
  } else {
    for (const g of byGroup.values()) {
      borosCapitalUsd += g.groupIm > 0 ? g.balance * (g.strategyIm / g.groupIm) : g.balance;
    }
  }
  const capitalUsd = perpCapitalUsd + borosCapitalUsd;

  // --- Strategy clock -----------------------------------------------------------
  // The strategy starts when its BOROS legs lock the spread (default). Perp
  // opens are only a fallback when the Boros open time is unknown; a
  // user-supplied override wins over both. The clock anchors BOTH the realized
  // window and the perp funding measurement below.
  const isOpen = (t: number | null): t is number => t !== null && t > 0;
  const borosOpens = borosLegs.map((l) => l.openedAt).filter(isOpen);
  const perpOpens = perpLegs.map((l) => l.openedAt).filter(isOpen);
  let clockStart: number | null = null;
  let clockBasis: ClockBasis | null = null;
  if (clockStartOverrideSec !== undefined) {
    clockStart = clockStartOverrideSec;
    clockBasis = 'custom';
  } else if (borosOpens.length) {
    clockStart = Math.min(...borosOpens);
    clockBasis = 'boros-open';
  } else if (perpOpens.length) {
    clockStart = Math.min(...perpOpens);
    clockBasis = 'perp-open';
    // Only a MISSING open time is worth a warning. A position with no Boros
    // legs at all has none to miss — the perp open is simply when it started.
    if (borosLegs.length) {
      warnings.push(
        `The ${base} Boros open time is unknown (no trade history) — the APR clock falls back to the earliest perp open.`,
      );
    }
  }
  const elapsedSeconds = clockStart !== null ? Math.max(1, nowSec - clockStart) : null;

  // --- Perp funding re-based to the clock -----------------------------------------
  // A position opened at/after the clock start already reports the right
  // number (Gate's cumulative counter starts at the open). A position that
  // PREDATES the clock includes pre-lock funding — re-sum it from the
  // account-book ledger; if the ledger can't cover the window, keep the
  // counter and say so.
  for (const b of perpBuilds) {
    // `b.leg.openedAt` may be this TRANCHE's open; the counter this branch
    // re-bases starts when the VENUE position opened, so that is what decides
    // whether it predates the clock.
    const venueOpen = b.venueOpenedAtSec;
    // A share that VARIED over the position's life needs the ledger even when
    // the position does not predate the clock: the counter × FINAL share
    // drops the funding this tranche earned while it owned more of it.
    const shareVaries =
      b.shareTimeline !== undefined &&
      b.shareTimeline.some((s) => Math.abs(s.share - b.share) > 1e-9);
    if (clockStart === null || venueOpen === null || (venueOpen >= clockStart && !shareVaries)) {
      continue;
    }
    const startSec: number = clockStart;
    // The ledger must actually CARRY this position before we re-base against it.
    // `?? []` here would sum to 0 and overwrite the venue's cumulative counter
    // with $0 — and because the outer condition already passed, the warning
    // below would never fire. An empty map entry is indistinguishable from a
    // ledger query that came back unusable (a `from` the API read differently, a
    // statementType label change, a businessId that isn't `{positionId}_{ts}`),
    // so a missing position means "cannot re-base", never "earned nothing".
    // Funding is the single largest P&L component of a funding-rate arb; showing
    // a confident $0 is far worse than showing the counter and saying why.
    const ledgerRows = b.positionId ? fundingLedger?.byPosition.get(b.positionId) : undefined;
    if (fundingLedger && fundingLedger.coversFromSec <= startSec && ledgerRows) {
      // The ledger measures the WHOLE venue position; this build may own only
      // a share of it — and that share may have CHANGED as sibling tranches
      // opened, so each settlement is scaled by the share held at its time
      // (0 before this tranche opened, so no explicit window filter is needed
      // on the timeline path).
      const shareAt = (t: number): number => {
        let s = 0;
        for (const seg of b.shareTimeline ?? []) {
          if (seg.fromSec <= t) s = seg.share;
          else break;
        }
        return s;
      };
      // The startSec window still applies on the timeline path: for a shared
      // tranche the clock IS its own open (so the filter is a no-op for the
      // earliest sibling's solo period), but a custom clock override must
      // keep excluding pre-clock rows exactly as the flat-share path does.
      const sinceStart = b.shareTimeline
        ? ledgerRows
            .filter((e) => e.timeSec >= startSec)
            .reduce((s, e) => s + e.changeUsd * shareAt(e.timeSec), 0)
        : ledgerRows.filter((e) => e.timeSec >= startSec).reduce((s, e) => s + e.changeUsd, 0) *
          b.share;
      b.leg.cashFlowUsd = sinceStart;
      b.leg.netUsd = sinceStart - b.leg.feesUsd;
    } else if (venueOpen >= clockStart) {
      // Reached only because the share varied: the position does NOT predate
      // the clock, so the grace/predates branches below do not describe it.
      // Without a usable ledger the counter × final share stands — say so
      // rather than silently misattributing the pre-split settlements.
      warnings.push(
        `The ${b.leg.venue} ${base} perp is shared by strategies that opened at different times and the CrossEx funding ledger cannot cover it — its funding is the venue counter split by final share, which may misattribute funding settled before the later strategy opened.`,
      );
    } else if (fundingLedger && fundingLedger.coversFromSec <= startSec && !ledgerRows) {
      if (nowSec - startSec < FUNDING_LEDGER_GRACE_SEC) {
        // A young strategy may simply not have crossed a funding-settlement
        // boundary yet (venues settle at up to 8h intervals), so a
        // shortly-pre-existing position with no ledger rows is the EXPECTED
        // truth, not an unusable read: funding since the lock really is $0.
        // Re-base to 0 with no warning — the cumulative counter would
        // over-attribute pre-lock accrual, and a "returned no rows" notice
        // here reads as an error where nothing is wrong.
        b.leg.cashFlowUsd = 0;
        b.leg.netUsd = -b.leg.feesUsd;
      } else {
        warnings.push(
          `The ${b.leg.venue} ${base} perp predates the strategy start and the CrossEx funding ledger returned no rows for it — its funding number is the venue's cumulative counter and includes pre-lock accrual.`,
        );
      }
    } else {
      warnings.push(
        `The ${b.leg.venue} ${base} perp predates the strategy start — its funding number includes pre-lock accrual (the CrossEx funding ledger doesn't cover that window).`,
      );
    }
  }

  // --- Entry slippage (the perp pair's crossing cost) ---------------------------
  // Computable only for a simple pair — exactly one long + one short perp leg
  // with known entry prices — and from LIVE entries only when the two opens are
  // contemporaneous: the gap between entry averages is crossing cost only if no
  // market time passed between them. A book rebuilt leg-by-leg (venue
  // migration) instead sums each journal deal's own contemporaneous gap, so
  // drift between the opens never masquerades as slippage. Signed: paying up
  // for the long relative to the short is a cost; negative means a favorable
  // gap. No perp legs at all ⇒ structurally 0 (nothing was crossed), never
  // null — a null here would poison the account totals for every OTHER
  // strategy.
  const longPerps = perpBuilds.filter((b) => b.leg.side === 'LONG');
  const shortPerps = perpBuilds.filter((b) => b.leg.side === 'SHORT');
  let perpEntrySlippageUsd: number | null = perpBuilds.length === 0 ? 0 : null;
  let slippageCauseWarned = false;
  // The tickable decomposition of the entry cost. Slippage parts are appended
  // by whichever branch below produces a number; the per-leg fee parts follow.
  // These MUST sum to perpTradingUsd + (perpEntrySlippageUsd ?? 0).
  const perpEntryCostParts: PerpEntryCostPart[] = [];
  if (perpBuilds.length === 2 && longPerps.length === 1 && shortPerps.length === 1) {
    const [lo] = longPerps;
    const [sh] = shortPerps;
    if (lo.entryPrice > 0 && sh.entryPrice > 0) {
      const loOpen = lo.leg.openedAt;
      const shOpen = sh.leg.openedAt;
      const synced =
        loOpen !== null && shOpen !== null && Math.abs(loOpen - shOpen) <= PERP_ENTRY_SYNC_MAX_SEC;
      if (synced) {
        const matched = Math.min(lo.qty, sh.qty);
        perpEntrySlippageUsd = (lo.entryPrice - sh.entryPrice) * matched;
        // Both legs opened together, so the whole book is ONE execution — there
        // is nothing finer to tick, but it still lists alongside the fees.
        perpEntryCostParts.push({
          id: 'slip:live',
          kind: 'slippage',
          usd: perpEntrySlippageUsd,
          atSec: Math.min(loOpen, shOpen),
          venues: [lo.leg.venue, sh.leg.venue],
          side: null,
          qty: matched,
        });
      } else {
        const opens = [loOpen, shOpen].filter((t): t is number => t !== null && t > 0);
        const chained = dealFills?.length
          ? chainPerpEntrySlippageUsd(dealFills, {
              base,
              longSymbol: lo.symbol,
              longQty: lo.qty,
              shortSymbol: sh.symbol,
              shortQty: sh.qty,
              earliestOpenSec: opens.length ? Math.min(...opens) : null,
            })
          : null;
        const cause =
          loOpen === null || shOpen === null
            ? "a perp leg's open time is unknown, so the entries cannot be confirmed contemporaneous"
            : 'the perp legs were opened at different times, so the live entry gap would include market drift';
        if (chained !== null) {
          perpEntrySlippageUsd = chained.usd;
          perpEntryCostParts.push(...chained.parts);
          warnings.push(
            `Entry slippage for ${base} is summed from ${chained.deals} deal${chained.deals === 1 ? '' : 's'} in this terminal's journal (${cause}).`,
          );
        } else {
          /**
           * No journal to reconstruct the fills — so ESTIMATE from the live
           * entry gap rather than dropping the cost.
           *
           * This used to report null and exclude the whole figure. That is the
           * more defensible number in isolation, but it silently understates
           * every book it touches: a real cost was paid, and reporting nothing
           * reads as zero in the totals the user actually decides on. An
           * estimate that is LABELLED and can be corrected is worth more than
           * an honest blank — the entry override on each leg is the correction
           * (assert what a leg really paid and this recomputes from it).
           *
           * ⚠ The estimate's known flaw: legs opened apart include market
           * drift between the two opens, so the gap is the crossing cost PLUS
           * whatever the coin did in between. Small gaps are dominated by the
           * former, large ones by the latter — hence the threshold below,
           * which warns only when the number is big enough to be mostly drift.
           */
          const matched = Math.min(lo.qty, sh.qty);
          perpEntrySlippageUsd = (lo.entryPrice - sh.entryPrice) * matched;
          // The earliest open this cost can be attributed to. 0 when neither
          // leg reports one — the part is still listed, just undated.
          const atSec = opens.length ? Math.min(...opens) : 0;
          perpEntryCostParts.push({
            id: 'slip:estimated',
            kind: 'slippage',
            usd: perpEntrySlippageUsd,
            atSec,
            venues: [lo.leg.venue, sh.leg.venue],
            side: null,
            qty: matched,
          });
          // Only when it is large enough to be suspect. Below the threshold the
          // gap is an ordinary crossing cost and saying anything would train
          // the user to ignore the warning that matters.
          const notionalUsd = Math.abs(lo.entryPrice * matched);
          const suspect =
            notionalUsd > 0 &&
            Math.abs(perpEntrySlippageUsd) > notionalUsd * ESTIMATED_SLIPPAGE_WARN_FRACTION;
          if (suspect) {
            slippageCauseWarned = true;
            warnings.push(
              `Entry slippage for ${base} is an estimate from the live entry gap (${cause}) and looks large — it may be market drift rather than a cost you paid. Correct a leg's entry from Manual adjustment if you know what it actually filled at.`,
            );
          }
        }
      }
    }
  }
  if (perpEntrySlippageUsd === null && perpBuilds.length > 0 && !slippageCauseWarned) {
    warnings.push(
      `Entry slippage for ${base} is unknown (not a simple 1-long/1-short perp pair with known entries) — it is excluded from the cost totals.`,
    );
  }
  // One fee part per LIVE perp leg. Gate reports each position's `fee` as a
  // single cumulative scalar covering the position's whole life, so this is as
  // fine as the data honestly goes — and a leg migrated away from has no live
  // position, so it never appears here (nor in perpTradingUsd).
  for (const b of perpBuilds) {
    if (b.leg.feesUsd === 0) continue;
    perpEntryCostParts.push({
      id: `fees:${b.symbol}`,
      kind: 'fees',
      usd: b.leg.feesUsd,
      atSec: null,
      venues: [b.leg.venue],
      side: b.leg.side,
      qty: null,
    });
  }

  // --- Realized ----------------------------------------------------------------
  // Σ leg nets (perp = funding − fees; boros = settlements + mtm + tradePnl)
  // minus the pair's entry slippage — the realized cost of crossing both books,
  // which replaced the perps' price MtM in the leg nets.
  const realizedPnlUsd =
    legs.reduce((s, l) => s + l.netUsd, 0) - (perpEntrySlippageUsd ?? 0);
  const maxPaymentPeriod = Math.max(0, ...borosBuilds.map((b) => b.paymentPeriod));
  let realizedApr: number | null = null;
  if (elapsedSeconds !== null && capitalUsd > 0 && elapsedSeconds >= maxPaymentPeriod) {
    realizedApr = (realizedPnlUsd / capitalUsd) * (SECONDS_IN_YEAR / elapsedSeconds);
  }

  // --- Locked spread ----------------------------------------------------------
  const netFixedPerYearUsd = borosLegs.reduce(
    (s, l) => s + fixedSign(l) * (l.entryApr ?? 0) * l.notionalUsd,
    0,
  );
  const grossBorosNotional = borosLegs.reduce((s, l) => s + l.notionalUsd, 0);
  // For the canonical 2-leg book (equal notional N): netFixed = (rateA−rateB)·N
  // and gross = 2N, so netFixed / (gross/2) recovers the spread exactly.
  const spread = grossBorosNotional > 0 ? netFixedPerYearUsd / (grossBorosNotional / 2) : 0;
  const lockedAprOnCapital = capitalUsd > 0 ? netFixedPerYearUsd / capitalUsd : 0;

  // Full-life spread return: the locked net fixed rate accrued from the
  // strategy start to maturity. netFixedPerYearUsd ≡ (gross/2) × spread, so
  // this is N × spread × duration for the canonical book, and stays exact for
  // unequal notionals. Assumes the spread was locked on the full notional
  // since the start — the UI surfaces that assumption verbatim.
  const spreadReturnUsd =
    clockStart !== null
      ? netFixedPerYearUsd * (Math.max(0, maturity - clockStart) / SECONDS_IN_YEAR)
      : null;

  // --- Perp exit cost (maker+hedge close) ---------------------------------------
  // For a 2-leg pair: maker order on one venue + taker hedge on the other —
  // price the CHEAPER maker assignment. Any other shape: taker on every leg.
  const perpRatePairs = perpBuilds.map((b) => ({
    notionalUsd: b.leg.notionalUsd,
    rates: venueFees ? resolveFeeRates(venueFees, b.symbol) : null,
  }));
  let perpExitFeesUsd: number | null;
  if (perpRatePairs.some((r) => r.rates === null)) {
    perpExitFeesUsd = null; // perps exist but the schedule is unknown — say so
  } else if (perpRatePairs.length === 2) {
    const [a, b] = perpRatePairs;
    perpExitFeesUsd = Math.min(
      a.notionalUsd * a.rates!.makerRate + b.notionalUsd * b.rates!.takerRate,
      a.notionalUsd * a.rates!.takerRate + b.notionalUsd * b.rates!.makerRate,
    );
  } else {
    perpExitFeesUsd = perpRatePairs.reduce((s, r) => s + r.notionalUsd * r.rates!.takerRate, 0);
  }
  // Exit crossing cost assumed symmetric to entry.
  const perpExitSlippageUsd = perpEntrySlippageUsd;

  // --- Fees: paid vs future ------------------------------------------------------
  const perpTradingUsd = perpLegs.reduce((s, l) => s + l.feesUsd, 0);
  const borosTradeUsd = borosLegs.reduce((s, l) => s + l.feesUsd, 0);
  let borosSettlementPaidUsd = 0;
  let borosSettlementFutureUsd = 0;
  for (const b of borosBuilds) {
    if (b.settleFeeApr <= 0) continue;
    const legMaturity = b.leg.maturity ?? maturity;
    if (b.leg.openedAt !== null) {
      const settledElapsed = Math.max(0, Math.min(nowSec, legMaturity) - b.leg.openedAt);
      const legSettlementPaidUsd =
        b.leg.notionalUsd * b.settleFeeApr * (settledElapsed / SECONDS_IN_YEAR);
      // Kept on the leg as well as summed: the card adds it back to show a
      // per-leg figure before costs, and the aggregate cannot be split after
      // the fact without inventing a ratio.
      b.leg.settlementFeePaidUsd = legSettlementPaidUsd;
      borosSettlementPaidUsd += legSettlementPaidUsd;
    }
    // No openedAt condition here: the fee runs to maturity for every open leg
    // whether or not its open time is known.
    borosSettlementFutureUsd +=
      b.leg.notionalUsd * b.settleFeeApr * (Math.max(0, legMaturity - nowSec) / SECONDS_IN_YEAR);
  }
  const paidTotalUsd =
    perpTradingUsd + (perpEntrySlippageUsd ?? 0) + borosTradeUsd + borosSettlementPaidUsd;
  const futureTotalUsd =
    perpExitFeesUsd === null || perpExitSlippageUsd === null
      ? null
      : perpExitFeesUsd + perpExitSlippageUsd + borosSettlementFutureUsd;

  // --- Profit by maturity --------------------------------------------------------
  // spread return − paid costs − future Boros settlement fees. The perp exit
  // parts are deliberately left out: the client folds each in via its own
  // checkbox (the server never bakes exit costs into the headline).
  const expectedPnlToMaturityUsd =
    spreadReturnUsd === null ? null : spreadReturnUsd - paidTotalUsd - borosSettlementFutureUsd;

  return {
    strategyId,
    attribution,
    base,
    maturity,
    legs,
    hedge,
    hedgeChecks,
    capitalUsd,
    capitalSplit: { perpUsd: perpCapitalUsd, borosUsd: borosCapitalUsd },
    realizedPnlUsd,
    realizedApr,
    spread,
    lockedAprOnCapital,
    spreadReturnUsd,
    expectedPnlToMaturityUsd,
    elapsedSeconds,
    clockBasis,
    clockStartSec: clockStart,
    secondsToMaturity: Math.max(0, maturity - nowSec),
    notionalMismatchUsd,
    perpEntryCostParts,
    feesUsd: {
      paid: {
        perpTradingUsd,
        perpEntrySlippageUsd,
        borosTradeUsd,
        borosSettlementUsd: borosSettlementPaidUsd,
        totalUsd: paidTotalUsd,
      },
      future: {
        perpExitFeesUsd,
        perpExitSlippageUsd,
        borosSettlementUsd: borosSettlementFutureUsd,
        totalUsd: futureTotalUsd,
      },
    },
    warnings: [...new Set(warnings)],
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface BuildStrategiesInput {
  address: string;
  zones: BorosCollateralZone[];
  markets: BorosMarket[];
  /** Full txn history per collateral tokenId (for exact fees + open times). */
  txnsByToken: Map<number, BorosTxn[]>;
  pricesUsd: Map<number, number | null>;
  /** null ⇒ the perp side is unavailable (Boros-only view). */
  perpPositions: PerpPositionLike[] | null;
  /** Why perps are unavailable — replaces the default "not configured" sentence
   * so a transient Gate failure is never misreported as missing credentials. */
  perpsUnavailableWarning?: string;
  /** User-chosen APR clock start (unix seconds) — overrides the Boros-open default. */
  clockStartOverrideSec?: number;
  /** /crossex/fee rows for exit-cost estimation; null/absent = schedule unknown. */
  venueFees?: VenueFeeRow[] | null;
  /** CrossEx account-book funding ledger — re-bases perp funding to the clock
   * start when a position predates it; null/absent = ledger unavailable. */
  perpFunding?: PerpFundingLedger | null;
  /** Finished deals from the local engine journal — chains true entry slippage
   * across leg migrations when the live entries are not contemporaneous;
   * null/absent = journal unavailable (public mode, tests). */
  dealFills?: DealFillRecord[] | null;
  /** Venue fill history — the execution record that splits one venue's leg
   * across the strategies that built it (and carries per-fill fees).
   * null/absent = unavailable, so the split falls back to proximity. */
  perpFills?: PerpFillRecord[] | null;
  /** What the user has said belongs where. A position with rows is exactly
   * its rows; everything unclaimed is solved around them. */
  membership?: MembershipRow[] | null;
  /** How much capital a Boros position is said to tie up. Defaults to
   * `balance`, the reading every existing number was computed on. */
  capitalBasis?: CapitalBasis;
  /** False for a collateral zone whose transaction history was truncated —
   * see fetchBorosTransactions. Absence-based bands are illegal there. */
  borosHistoryComplete?: boolean;
  nowSec: number;
}

export function buildStrategies(input: BuildStrategiesInput): StrategyReturns {
  const globalWarnings: string[] = [];
  const marketById = new Map(input.markets.map((m) => [m.marketId, m]));

  const borosBuilds = buildBorosLegs(
    input.zones,
    marketById,
    input.txnsByToken,
    input.pricesUsd,
    globalWarnings,
  );

  const perpAvailable = input.perpPositions !== null;
  if (!perpAvailable) {
    globalWarnings.push(
      input.perpsUnavailableWarning ??
        'Gate credentials are not configured — showing the Boros legs only (connect Gate keys to overlay perp legs 1–2).',
    );
  }
  const perpBuildsAll = (input.perpPositions ?? [])
    .filter((p) => fin(p.positionQty) !== 0 || fin(p.positionValue) !== 0)
    .map(buildPerpLeg);

  // --- Group Boros legs into cohorts by (base, maturity) ---------------------
  // A cohort is one coin at one maturity: the Boros side of every strategy on
  // that pairing, netted by the venue into one position per market.
  const cohorts = new Map<string, Cohort>();
  for (const b of borosBuilds) {
    const base = b.leg.base || '?';
    const maturity = b.leg.maturity ?? 0;
    const key = `${base}@${maturity}`;
    const cohort = cohorts.get(key) ?? { base, maturity, builds: [] };
    cohort.builds.push(b);
    cohorts.set(key, cohort);
  }
  const cohortsBeforeAssertions = [...cohorts.values()];
  const borosBases = new Set(cohortsBeforeAssertions.map((c) => c.base));

  // --- What the user has already said, before anything is inferred ----------
  const asserted = applyMembership(input, perpBuildsAll, borosBuilds);
  for (const note of asserted.notes) globalWarnings.push(note);

  // Both sides of the book, reduced by everything the user spoke for. One
  // ledger, applied the same way to perps and to Boros — the solver simply
  // gets a smaller book, and has no idea assertions exist.
  const cohortList = cohortsBeforeAssertions
    .map((c) => ({
      ...c,
      builds: c.builds
        .map((b) => {
          const whole = b.leg.notionalToken ?? 0;
          const left = asserted.borosLeft.get(b.marketId) ?? whole;
          if (!(whole > 0) || left >= whole * (1 - 1e-9)) return b;
          return left <= whole * 1e-9 ? null : scaleBorosBuild(b, left / whole);
        })
        .filter((b): b is BorosLegBuild => b !== null),
    }))
    .filter((c) => c.builds.length > 0);

  // --- Split what is LEFT into the tranches that built it -------------------
  const partition = solvePerpPartition({
    positions: perpBuildsAll
      .map(snapshotOf)
      .map((p) => ({ ...p, qty: asserted.perpLeft.get(p.symbol) ?? p.qty }))
      .filter((p) => p.qty > 0),
    fills: input.perpFills,
    deals: input.dealFills,
  });
  for (const note of partition.notes) globalWarnings.push(note);

  const strategies = [
    ...asserted.cards,
    ...(partition.reconciled
      ? splitStrategies(input, cohortList, perpBuildsAll, partition, asserted, borosBases)
      : mergedStrategies(input, cohortList, perpBuildsAll)),
  ];

  /**
   * UNHEDGED SIZE, DERIVED — never merged from the places that produce it.
   *
   * A perp position is either on a card or it is unhedged, so the honest
   * definition is subtraction: what the venue reports, minus what the cards
   * show. Three sources used to be concatenated instead — the solver's
   * leftovers, the user's detachments, and a sweep for anything both missed —
   * which double-counted a leg that one branch reported AND another attached,
   * and still lost size when every branch skipped it.
   *
   * What comes out is a POSITION holding one leg, not a footnote. It used to
   * be a separate `unhedgedResiduals` list the client drew as an amber strip,
   * with an "attach to" picker and an undo button of its own — two controls
   * that restated what any leg row's own picker already says. A position is a
   * set of legs, and "one perp, nothing against it" is a set of legs; giving
   * it a card is what makes it answerable with the same control as everything
   * else, and shows its funding and fees, which the strip never did.
   *
   * ⚠ A POSITION IS AT MOST TWO PERP LEGS AND TWO BOROS LEGS — one of each per
   * venue, opposite sides. A coin with no Boros used to have ALL its perp legs
   * pooled onto one `BASE#perps` card, on the reasoning that a delta-neutral
   * pair waiting for its rate lock is one position. That reasoning only holds
   * while the coin has exactly one pair: a book with two longs against one
   * short is TWO strategies sharing a venue leg, and pooling them produced a
   * three-legged card whose header could only name two of its venues, whose
   * hedge ratios compared sums rather than pairs, and whose missing-Boros rows
   * sized themselves off one leg of a side they had summed.
   *
   * So the pairing comes from the same solver every Boros coin uses — the
   * tranche cards `splitStrategies` already builds — and only what NO tranche
   * could pair reaches here. What does is per-leg: a remainder is what one
   * strategy released, and remainders have nothing to do with each other.
   *
   * The one exception is `mergedStrategies`, the branch taken when the split
   * does NOT reconcile. There the solver has said it cannot explain the book,
   * so its cards stay merged and may hold any number of legs — splitting a
   * book you have just declared unsplittable would be a guess wearing the
   * clothes of a measurement. This whole pass is gated on `reconciled` for the
   * same reason.
   */
  if (partition.reconciled) {
    const shown = new Map<string, number>();
    for (const l of strategies.flatMap((s) => s.legs)) {
      if (l.kind !== 'perp' || !l.symbol) continue;
      shown.set(l.symbol, (shown.get(l.symbol) ?? 0) + (l.notionalToken ?? 0));
    }
    /** The unclaimed part of one venue leg, as a build the card can hold. */
    const leftoverOf = (b: PerpLegBuild): PerpLegBuild | null => {
      const whole = b.leg.notionalToken ?? 0;
      const missing = whole - (shown.get(b.symbol) ?? 0);
      if (missing <= Math.max(1e-12, whole * 1e-9)) return null;
      const share = whole > 0 ? missing / whole : 1;
      if (share >= 1 - 1e-9) return b;
      return scalePerpBuild(
        b,
        {
          symbol: b.symbol,
          venue: b.leg.venue,
          side: b.leg.side,
          qty: missing,
          // The venue's blended entry covers the positions holding the rest
          // of this leg too, so the remainder cannot claim a price of its own.
          entryPrice: null,
          feesUsd: null,
          share,
          shared: true,
        },
        null,
      );
    };
    const card = (strategyId: string, base: string, perpBuilds: PerpLegBuild[]) =>
      assembleStrategy({
        strategyId,
        attribution: { source: 'unhedged', confidence: 'measured', pinned: false },
        base,
        // No Boros legs, so no maturity — see the sentinel on StrategyRollup.
        maturity: 0,
        borosBuilds: [],
        perpBuilds,
        perpAvailable,
        nowSec: input.nowSec,
        clockStartOverrideSec: input.clockStartOverrideSec,
        venueFees: input.venueFees,
        fundingLedger: input.perpFunding,
        dealFills: input.dealFills,
        capitalBasis: input.capitalBasis ?? 'balance',
      });

    // Whatever no card claimed: one leg, one position. Keyed by the leg,
    // because that is all this position is. Stable across re-solves, and
    // distinguishable from a minted position id.
    for (const b of perpBuildsAll) {
      const left = leftoverOf(b);
      if (!left) continue;
      strategies.push(card(`${b.leg.base}#unhedged:${b.symbol}`, b.leg.base, [left]));
    }
  }

  strategies.sort(
    (a, b) =>
      b.legs.reduce((s, l) => s + l.notionalUsd, 0) - a.legs.reduce((s, l) => s + l.notionalUsd, 0),
  );

  // --- Totals ------------------------------------------------------------------
  // Over the ARB BOOK only. Unhedged cards render beside the strategies so no
  // position hides, but they are not Boros-tracked returns — folding a
  // directional leftover (or a whole coin that never touched Boros) into
  // "Boros-tracked totals" would let it dominate the APR it has nothing to do
  // with. The card itself still shows that money.
  const tracked = strategies.filter((x) => x.attribution.source !== 'unhedged');
  const capitalUsd = tracked.reduce((s, x) => s + x.capitalUsd, 0);
  const realizedPnlUsd = tracked.reduce((s, x) => s + x.realizedPnlUsd, 0);
  const expectedPnlToMaturityUsd = tracked.reduce(
    (s, x) => s + (x.expectedPnlToMaturityUsd ?? 0),
    0,
  );
  const feesTotalUsd = tracked.reduce((s, x) => s + x.feesUsd.paid.totalUsd, 0);
  const perpExitFeesTotalUsd = tracked.some((x) => x.feesUsd.future.perpExitFeesUsd === null)
    ? null
    : tracked.reduce((s, x) => s + (x.feesUsd.future.perpExitFeesUsd ?? 0), 0);
  // Deliberately all-or-nothing: a sum over the measurable subset, presented as
  // a total, is the same confident-average mistake the split exists to fix. The
  // count travels with it so the UI can say WHY the total is missing.
  const slippageUnknownCount = tracked.filter(
    (x) => x.feesUsd.future.perpExitSlippageUsd === null,
  ).length;
  const perpExitSlippageTotalUsd =
    slippageUnknownCount > 0
      ? null
      : tracked.reduce((s, x) => s + (x.feesUsd.future.perpExitSlippageUsd ?? 0), 0);
  // Blend the annualization over capital-weighted elapsed time; null if any
  // strategy can't be annualized (a partial blend would mislead).
  let realizedApr: number | null = null;
  if (
    tracked.length > 0 &&
    capitalUsd > 0 &&
    tracked.every((s) => s.realizedApr !== null && s.capitalUsd > 0)
  ) {
    const weightedElapsed =
      tracked.reduce((s, x) => s + x.capitalUsd * (x.elapsedSeconds ?? 0), 0) / capitalUsd;
    if (weightedElapsed > 0) {
      realizedApr = (realizedPnlUsd / capitalUsd) * (SECONDS_IN_YEAR / weightedElapsed);
    }
  }

  return {
    address: input.address,
    perpSource: perpAvailable ? 'connected-gate-account' : null,
    strategies,
    totals: {
      capitalUsd,
      realizedPnlUsd,
      realizedApr,
      expectedPnlToMaturityUsd,
      feesTotalUsd,
      perpExitFeesTotalUsd,
      perpExitSlippageTotalUsd,
      slippageUnknownCount,
      // The totals' own population — unhedged cards render but do not count.
      strategyCount: tracked.length,
    },
    capitalBasis: input.capitalBasis ?? 'balance',
    warnings: [...new Set(globalWarnings)],
  };
}

interface Cohort {
  base: string;
  maturity: number;
  builds: BorosLegBuild[];
}

const snapshotOf = (b: PerpLegBuild): PerpLegSnapshot => ({
  symbol: b.symbol,
  venue: b.leg.venue,
  base: b.leg.base,
  side: b.leg.side,
  qty: b.qty,
  entryPrice: b.entryPrice,
  openedAtSec: b.leg.openedAt,
});

/**
 * What the user has ASSERTED, applied before anything is inferred.
 *
 * ONE RULE, no cases: a position is the set of (leg, size) rows naming it.
 * Every row draws from a single ledger of what each venue leg still has left;
 * whatever the ledger still holds afterwards is the solver's to propose, and
 * whatever is left after THAT is unhedged. Membership, sizing, detaching and
 * moving are all the same operation on that ledger — which is why none of them
 * has a branch here.
 *
 * A position is built straight from its rows. It is deliberately NOT fed to
 * the solver as a tranche: the solver's job is to infer groupings, and there
 * is nothing to infer about one the user has stated. That also means a
 * position needs no particular shape — two perps and two Boros legs, a spread
 * whose hedge is not open yet, a single leg — they are all just row sets.
 *
 * Order is the only subtlety: rows carrying an explicit size bind before rows
 * that say "all of it", so a number the user typed always outranks a blanket
 * claim.
 */
function applyMembership(
  input: BuildStrategiesInput,
  perpBuildsAll: PerpLegBuild[],
  borosBuilds: BorosLegBuild[],
): {
  /** One card per position the user defined, whatever shape it is. */
  cards: StrategyRollup[];
  /** symbol → base-coin qty the solver may still divide. */
  perpLeft: Map<string, number>;
  /** marketId → token size the cohorts may still divide. */
  borosLeft: Map<number, number>;
  /** Every perp symbol the user spoke about. The leftover branch in
   * `splitStrategies` attaches un-spoken-for legs WHOLE to a cohort, which
   * would undo an assertion. */
  assertedSymbols: Set<string>;
  orphanedBoros: BorosLegBuild[];
  /**
   * The entry a claim takes when it asserted nothing, keyed by leg.
   *
   * Exposed because the leftover/unowned passes downstream build their own
   * cards out of size no membership row mentions — and that size is still part
   * of the venue's blend, so it re-balances like any other un-asserted claim.
   * Without it those cards kept the venue figure while the asserted card moved,
   * showing two different entries for one venue position.
   */
  impliedByLeg: Map<string, number>;
  notes: string[];
} {
  const notes: string[] = [];
  const perpLeft = new Map<string, number>();
  const borosLeft = new Map<number, number>();
  const cards: StrategyRollup[] = [];
  const orphanedBoros: BorosLegBuild[] = [];
  /** marketId → detached token size, summed over every row that detached it. */
  const detachedByMarket = new Map<number, number>();
  /** See the note on the return type. Filled while reconciling entries. */
  const impliedByLeg = new Map<string, number>();
  const rows = input.membership ?? [];

  const perpBySymbol = new Map(perpBuildsAll.map((b) => [b.symbol, b]));
  const borosByMarket = new Map(borosBuilds.map((b) => [b.marketId, b]));
  for (const b of perpBuildsAll) perpLeft.set(b.symbol, b.leg.notionalToken ?? 0);
  for (const b of borosBuilds) borosLeft.set(b.marketId, b.leg.notionalToken ?? 0);
  const assertedSymbols = new Set<string>(
    rows.flatMap((r) => (r.leg.kind === 'perp' ? [r.leg.symbol] : [])),
  );
  if (!rows.length) {
    return { cards, perpLeft, borosLeft, assertedSymbols, orphanedBoros, impliedByLeg, notes };
  }

  // --- The ledger ------------------------------------------------------------
  const sizeOf = (l: LegRef): number =>
    l.kind === 'perp' ? (perpLeft.get(l.symbol) ?? 0) : (borosLeft.get(l.marketId) ?? 0);
  const draw = (l: LegRef, qty: number): number => {
    const left = sizeOf(l);
    const got = Math.min(qty, left);
    if (!(got > 0)) return 0;
    if (l.kind === 'perp') perpLeft.set(l.symbol, left - got);
    else borosLeft.set(l.marketId, left - got);
    return got;
  };
  /**
   * A leg, named the way the cards name it — never the raw venue symbol.
   *
   * These strings go into warnings the user reads. A leg the venue no longer
   * reports has no build to read a venue off, so the symbol is parsed instead
   * of printed: `OKX_FUTURE_ETH_USDT` is "OKX ETH perp", not itself.
   */
  const describe = (l: LegRef): string => {
    if (l.kind === 'boros') {
      const b = borosByMarket.get(l.marketId);
      return b ? `${b.leg.venue} ${b.leg.base} Boros` : `Boros market ${l.marketId}`;
    }
    const p = perpBySymbol.get(l.symbol);
    if (p) return `${p.leg.venue} ${p.leg.base} perp`;
    const { exchange, base } = parseSymbol(l.symbol);
    return exchange && base ? `${exchange} ${base} perp` : l.symbol;
  };

  /**
   * An assertion naming a leg the venue no longer reports.
   *
   * Dropped SILENTLY. This used to raise a note, on the reasoning that a row
   * names a LEG and so a dangling one is checkable and worth surfacing. But
   * the overwhelmingly common way a leg stops existing is that the user CLOSED
   * it — the normal end of a position's life — and warning about that greeted
   * anyone who flattened their book with a wall of amber naming every leg they
   * had just deliberately closed. The rows are pruned by the client
   * (partitionStore) once the server stops returning their legs; a genuinely
   * stale assertion is indistinguishable from a closed one here, and the
   * closed reading is right almost every time.
   */
  const live = (l: LegRef): boolean =>
    l.kind === 'perp' ? perpBySymbol.has(l.symbol) : borosByMarket.has(l.marketId);
  const usable = rows.filter((r) => live(r.leg));

  // --- Draw, in the one order that matters -----------------------------------
  // A row with no position is a claim by NOBODY, drawn first so no position and
  // no solver can reach it. Everything else is a claim by someone.
  const claimed = new Map<string, Map<string, { leg: LegRef; qty: number }>>();
  const take = (positionId: string | undefined, leg: LegRef, want: number, stated: boolean) => {
    const got = draw(leg, want);
    if (stated && got < want * (1 - 1e-9)) {
      notes.push(
        `You assigned ${want} of ${describe(leg)} to a position but only ${got} was left — the assignment was clamped, not rescaled.`,
      );
    }
    if (!(got > 0)) return;
    if (positionId === undefined) {
      // A detached BOROS leg has to be carried out of here — it becomes its
      // own unmatched card. A detached PERP simply leaves the pool: the
      // derived pass reports whatever the cards do not show, by subtraction,
      // and a second list of the same size here was never read. Keeping one
      // would put two sources of truth behind one number.
      // Accumulated PER MARKET, not per row: two rows detaching two chunks of
      // one leg detach one leg, and pushing a build each made two cards out of
      // one unclaimed position — with the same id, since a card is named for
      // the legs it holds.
      if (leg.kind === 'boros') {
        detachedByMarket.set(leg.marketId, (detachedByMarket.get(leg.marketId) ?? 0) + got);
      }
      return;
    }
    const byLeg = claimed.get(positionId) ?? new Map();
    const key = legRefKey(leg);
    byLeg.set(key, { leg, qty: (byLeg.get(key)?.qty ?? 0) + got });
    claimed.set(positionId, byLeg);
  };

  for (const r of usable.filter((x) => x.positionId === undefined)) {
    take(undefined, r.leg, r.qty ?? sizeOf(r.leg), r.qty !== undefined);
  }
  for (const r of usable.filter((x) => x.positionId !== undefined && x.qty !== undefined)) {
    take(r.positionId, r.leg, r.qty as number, true);
  }
  // "All of it" rows divide whatever survived the stated ones.
  const blanket = new Map<string, MembershipRow[]>();
  for (const r of usable.filter((x) => x.positionId !== undefined && x.qty === undefined)) {
    const key = legRefKey(r.leg);
    blanket.set(key, [...(blanket.get(key) ?? []), r]);
  }
  for (const [, claimants] of blanket) {
    const left = sizeOf(claimants[0].leg);
    if (!(left > 0)) continue;
    if (claimants.length > 1) {
      notes.push(
        `${claimants.length} positions each claim all of ${describe(claimants[0].leg)} — it was divided equally. Give one of them an explicit size to decide it.`,
      );
    }
    const each = left / claimants.length;
    for (const r of claimants) take(r.positionId, r.leg, each, false);
  }

  // Every detachment of one leg, as the ONE leg it is. Done after the draw so
  // rows that detached the same market in several bites are already summed.
  for (const [marketId, got] of detachedByMarket) {
    const b = borosByMarket.get(marketId) as BorosLegBuild;
    const whole = b.leg.notionalToken ?? 0;
    orphanedBoros.push(got >= whole * (1 - 1e-9) ? b : scaleBorosBuild(b, got / whole));
  }

  /**
   * What each position's share of a leg ACTUALLY entered at, once the user's
   * assertions are honoured and the venue's own average is conserved.
   *
   * Keyed `positionId|legKey`. The venue reports ONE blended entry across every
   * position sharing a leg, so a claim cannot normally name a price of its own
   * — that is why the branch below used to hand every partial claim a null.
   * An assertion changes that: the user is dividing a known total, not
   * restating it, so
   *
   *   Σ(qty · entry) over every claim  ==  venueEntry · venueQty
   *
   * still holds. Claims that asserted keep their number; the rest split what
   * is left, by size. This mirrors `impliedRemainderPrice` above, which prices
   * an unexplained remainder against the fills that WERE explained.
   *
   * Nothing is invented: a leg nobody asserted keeps null everywhere, exactly
   * as before. A leg whose assertions leave the remainder non-positive is
   * abandoned whole — the client blocks that case, and a payload that reaches
   * here anyway must not produce a negative price.
   */
  const entryByClaim = new Map<string, number>();
  {
    const asserted = new Map<string, number>();
    for (const r of usable) {
      if (r.positionId === undefined || r.entry === undefined) continue;
      asserted.set(`${r.positionId}|${legRefKey(r.leg)}`, r.entry);
    }
    if (asserted.size) {
      // Every claim on each leg, including the ones that said nothing.
      const claimsByLeg = new Map<string, Array<{ positionId: string; qty: number }>>();
      for (const [positionId, byLeg] of claimed) {
        for (const { leg, qty } of byLeg.values()) {
          const k = legRefKey(leg);
          claimsByLeg.set(k, [...(claimsByLeg.get(k) ?? []), { positionId, qty }]);
        }
      }
      for (const [legKey, claims] of claimsByLeg) {
        if (!claims.some((c) => asserted.has(`${c.positionId}|${legKey}`))) continue;
        /**
         * The venue's own blended entry for this leg, whichever kind it is.
         *
         * A perp's is a PRICE (quote per coin) and a Boros leg's is a RATE
         * (`entryApr`), but the conservation is identical: one venue figure
         * covering every claim, divided by size. Sizes are in the leg's own
         * unit — base coin for a perp, collateral for Boros — and since every
         * claim on one leg shares that unit, the weighted average is
         * well-formed either way.
         *
         * This resolved perps only, which silently dropped every Boros rate
         * the user asserted while the dialog reported success.
         */
        const perp = [...perpBySymbol.values()].find(
          (b) => legRefKey({ kind: 'perp', symbol: b.symbol }) === legKey,
        );
        const boros = perp
          ? undefined
          : [...borosByMarket.values()].find(
              (b) => legRefKey({ kind: 'boros', marketId: b.marketId }) === legKey,
            );
        const venueEntry = perp ? perp.entryPrice : (boros?.leg.entryApr ?? 0);
        const venueQty = (perp ?? boros)?.leg.notionalToken ?? 0;
        if (!(venueEntry > 0) || !(venueQty > 0)) continue;
        let restQty = venueQty;
        let restNotional = venueEntry * venueQty;
        for (const c of claims) {
          const v = asserted.get(`${c.positionId}|${legKey}`);
          if (v === undefined) continue;
          entryByClaim.set(`${c.positionId}|${legKey}`, v);
          restQty -= c.qty;
          restNotional -= v * c.qty;
        }
        // What every un-asserted claim on this leg entered at, so the venue's
        // average still comes back out. Guarded: an overrun would imply a
        // negative price, and a fabricated one is worse than no answer.
        if (!(restQty > 1e-12)) continue;
        const implied = restNotional / restQty;
        if (!(Number.isFinite(implied) && implied > 0)) continue;
        impliedByLeg.set(legKey, implied);
        for (const c of claims) {
          const k = `${c.positionId}|${legKey}`;
          if (!asserted.has(k)) entryByClaim.set(k, implied);
        }
      }
    }
  }

  // --- Every claim set becomes a card, whatever shape it is ------------------
  for (const [positionId, byLeg] of claimed) {
    const all = [...byLeg.values()];
    const borosScaled: BorosLegBuild[] = [];
    const perpScaled: PerpLegBuild[] = [];
    for (const { leg, qty } of all) {
      if (leg.kind === 'boros') {
        const b = borosByMarket.get(leg.marketId) as BorosLegBuild;
        const whole = b.leg.notionalToken ?? 0;
        if (!(whole > 0)) continue;
        // The rate this claim actually locked, once the user's assertions are
        // honoured and the venue's blend is conserved across the claims. Also
        // applied to a WHOLE-leg claim, which takes the unscaled build: owning
        // all of a leg does not mean the venue's figure is right for it —
        // another position may hold size the solver could not attribute.
        const rate = entryByClaim.get(`${positionId}|${legRefKey(leg)}`);
        // Keep the venue's own blend alongside the per-claim rate, or the UI
        // has nothing left to compare against and reports the user's own
        // assertion as what the venue says.
        const venueApr = rate === undefined ? undefined : b.leg.entryApr;
        const withVenue = (x: BorosLegBuild): BorosLegBuild =>
          venueApr === undefined ? x : { ...x, leg: { ...x.leg, venueEntry: venueApr } };
        borosScaled.push(
          withVenue(
            qty >= whole * (1 - 1e-9)
              ? rate === undefined
                ? b
                : { ...b, leg: { ...b.leg, entryApr: rate } }
              : scaleBorosBuild(b, qty / whole, rate),
          ),
        );
      } else {
        const l = perpBySymbol.get(leg.symbol) as PerpLegBuild;
        const whole = l.leg.notionalToken ?? 0;
        if (!(whole > 0)) continue;
        const share = Math.min(1, qty / whole);
        if (share >= 1 - 1e-9) {
          perpScaled.push(l);
          continue;
        }
        perpScaled.push(
          scalePerpBuild(
            l,
            {
              symbol: leg.symbol,
              venue: l.leg.venue,
              side: l.leg.side,
              qty,
              // The venue's blended entry covers every strategy sharing the
              // leg, so a partial claim cannot claim a price of its own — the
              // card reports null slippage rather than inventing one. A whole
              // claim took the branch above and keeps the venue's figures.
              //
              // UNLESS someone asserted one. Then the split is the user's, the
              // venue average is conserved across the claims (entryByClaim),
              // and this claim's real entry is known — which also lets the
              // entry-slippage branch run instead of reporting "unknown".
              entryPrice: entryByClaim.get(`${positionId}|${legRefKey(leg)}`) ?? null,
              feesUsd: null,
              share,
              shared: true,
            },
            null,
          ),
        );
      }
    }
    if (!borosScaled.length && !perpScaled.length) continue;
    const maturities = borosScaled.map((b) => b.leg.maturity ?? 0);
    const card = assembleStrategy({
      strategyId: positionId,
      // Stated, not inferred — the strongest attribution there is.
      attribution: { source: 'user', confidence: 'measured', pinned: true },
      base: borosScaled[0]?.leg.base || perpScaled[0]?.leg.base || '?',
      maturity: maturities.length ? Math.min(...maturities) : 0,
      borosBuilds: borosScaled,
      perpBuilds: perpScaled,
      perpAvailable: input.perpPositions !== null,
      nowSec: input.nowSec,
      clockStartOverrideSec: input.clockStartOverrideSec,
      venueFees: input.venueFees,
      fundingLedger: input.perpFunding,
      dealFills: input.dealFills,
      capitalBasis: input.capitalBasis ?? 'balance',
    });
    // The card wears a "grouped by you" chip; it must not also claim the split
    // was guessed. Said here rather than in splitStrategies, because that is
    // where the card is now built.
    card.warnings.push(
      `This ${card.base} position holds the legs you assigned to it — the rest of the book is matched around them, and it holds until you change it.`,
    );
    cards.push(card);
  }

  /**
   * An ORPHANED Boros portion re-balances too.
   *
   * It is detached size on a leg someone else asserted about, so it takes the
   * same implied rate as any other un-asserted claim — the venue's blend
   * already counted it, so leaving it on that blend broke conservation and
   * showed the user two different rates for one venue position on two cards.
   *
   * Done here rather than at the draw site because the implied rate is not
   * known until every claim on the leg has been collected, which happens after
   * the orphans are carried out.
   */
  if (impliedByLeg.size) {
    for (let i = 0; i < orphanedBoros.length; i += 1) {
      const b = orphanedBoros[i];
      const implied = impliedByLeg.get(legRefKey({ kind: 'boros', marketId: b.marketId }));
      if (implied === undefined || b.leg.entryApr === implied) continue;
      orphanedBoros[i] = {
        ...b,
        leg: { ...b.leg, entryApr: implied, venueEntry: b.leg.entryApr },
      };
    }
  }

  return { cards, perpLeft, borosLeft, assertedSymbols, orphanedBoros, impliedByLeg, notes };
}

function mergedStrategies(
  input: BuildStrategiesInput,
  cohortList: Cohort[],
  perpBuildsAll: PerpLegBuild[],
): StrategyRollup[] {
  const attachedByCohort = new Map<Cohort, PerpLegBuild[]>();
  for (const perp of perpBuildsAll) {
    const winner = pickCohort(cohortList, perp.leg.base, [perp.leg.venue]);
    if (!winner) continue;
    if (cohortList.filter((c) => c.base === perp.leg.base).length > 1) {
      perp.leg.warnings.push(
        `${perp.leg.base} has several Boros maturities — this ${perp.leg.venue} perp was attached to the largest cohort on its venue.`,
      );
    }
    attachedByCohort.set(winner, [...(attachedByCohort.get(winner) ?? []), perp]);
  }
  return cohortList.map((cohort) =>
    assembleStrategy({
      strategyId: `${cohort.base}@${cohort.maturity}`,
      attribution: { source: 'merged', confidence: 'measured', pinned: false },
      base: cohort.base,
      maturity: cohort.maturity,
      borosBuilds: cohort.builds,
      perpBuilds: attachedByCohort.get(cohort) ?? [],
      perpAvailable: input.perpPositions !== null,
      nowSec: input.nowSec,
      clockStartOverrideSec: input.clockStartOverrideSec,
      venueFees: input.venueFees,
      fundingLedger: input.perpFunding,
      dealFills: input.dealFills,
      capitalBasis: input.capitalBasis ?? 'balance',
    }),
  );
}

/** One strategy per perp tranche, plus one per cohort remainder for the Boros
 * notional no tranche claimed (standalone directional legs — never force-fitted
 * into someone else's strategy). */
function splitStrategies(
  input: BuildStrategiesInput,
  cohortList: Cohort[],
  perpBuildsAll: PerpLegBuild[],
  partition: PerpPartition,
  asserted: {
    /**
     * symbol → base-coin qty the solver was given, when a user position already
     * claimed part of it. A SOLVED tranche's `share` is computed against the
     * size the solver saw, so its fraction of the whole venue position — what
     * every USD number here is scaled by — is that share times what was left.
     * A synthetic tranche is already stated against the whole.
     */
    perpLeft: Map<string, number>;
    assertedSymbols: Set<string>;
    orphanedBoros: BorosLegBuild[];
    /** Per-leg entry for un-asserted size — leftover cards re-balance on it. */
    impliedByLeg: Map<string, number>;

    cards: StrategyRollup[];
  },
  /** Coins that hold Boros anywhere — before assertions moved any of it. */
  borosBases: ReadonlySet<string>,
): StrategyRollup[] {
  const { perpLeft } = asserted;
  /**
   * `share` means "fraction of the whole venue position" everywhere below —
   * it is what every USD number is scaled by. But the solver computed it
   * against the size IT was given, which is smaller whenever a user position
   * already claimed part of the leg. Re-base it once here rather than at each
   * of the several places that read it.
   */
  const wholeOf = new Map(perpBuildsAll.map((b) => [b.symbol, b.leg.notionalToken ?? 0]));
  const rebase = (leg: TrancheLeg): TrancheLeg => {
    const whole = wholeOf.get(leg.symbol) ?? 0;
    const left = perpLeft.get(leg.symbol);
    if (left === undefined || !(whole > 0)) return leg;
    const f = Math.min(1, left / whole);
    return f >= 1 - 1e-12 ? leg : { ...leg, share: leg.share * f, shared: true };
  };
  const tranches = partition.tranches.map((t) => ({
    ...t,
    long: rebase(t.long),
    short: rebase(t.short),
  }));
  // A perp the partition already spoke for must never be re-attached WHOLE by
  // the leftover branch below: a leg scaled into a tranche would land in two
  // strategies at once, and a DETACHED leg would show as hedged inside a card
  // while the residual box calls the same size unhedged. A leg that is merely
  // unpaired (no opposing perp yet) is not spoken for — it is still this
  // cohort's hedge, and the card must show it.
  const spokenFor = new Set<string>(asserted.assertedSymbols);
  for (const t of tranches) {
    spokenFor.add(t.long.symbol);
    spokenFor.add(t.short.symbol);
  }
  const perpBySymbol = new Map(perpBuildsAll.map((b) => [b.symbol, b]));
  // How much of each Boros position is still unclaimed (1 = untouched).
  const borosShareLeft = new Map<BorosLegBuild, number>(borosLegsOf(cohortList).map((b) => [b, 1]));
  const out: StrategyRollup[] = [];
  const assigned = new Map<Cohort, PerpTranche[]>();

  // One index over the whole txn history, not one flatten per cohort and a
  // full re-scan per Boros leg: the fetcher returns up to 5,000 fills PER
  // collateral token, and this route is polled every 30 seconds.
  const txnsByMarket = new Map<number, BorosTxn[]>();
  for (const list of input.txnsByToken.values()) {
    for (const t of list) {
      const forMarket = txnsByMarket.get(t.marketId);
      if (forMarket) forMarket.push(t);
      else txnsByMarket.set(t.marketId, [t]);
    }
  }

  /**
   * The opening fills of each Boros leg, replayed once.
   *
   * `borosIncrements` re-filters, re-sorts and re-walks the market's history
   * on every call, and both the serving-order scan and the allocation below
   * want the same answer for the same leg. Keyed by market AND size, because a
   * replay is only valid for the position size it reconciles against.
   */
  const incrementsCache = new Map<string, ReturnType<typeof borosIncrements>>();
  const incrementsFor = (marketId: number, size: number) => {
    const key = `${marketId}:${size}`;
    const hit = incrementsCache.get(key);
    if (hit !== undefined) return hit;
    const built = borosIncrements(txnsByMarket.get(marketId) ?? [], marketId, size);
    incrementsCache.set(key, built);
    return built;
  };

  /**
   * `boros:MARKETID` → every venue the legs placed WITH it sit at.
   *
   * Built from the increments each leg decomposes into: two increments a few
   * seconds apart, at matching size, on opposite sides of one coin are one
   * trade, and the legs they belong to must therefore land on one card.
   */
  const boundVenues = new Map<string, string[]>();
  {
    const cohortLegs = borosLegsOf(cohortList);
    const { atoms } = borosAtoms(cohortLegs, incrementsFor);
    const execs = bindExecutions(atoms, {
      historyComplete: input.borosHistoryComplete !== false,
    });
    /**
     * ⚠ Only legs built by a SINGLE increment are constrained here.
     *
     * An execution binds increments, but the constraint below is applied per
     * LEG — and those are the same thing only when the leg has one increment.
     * A leg grown over several days takes part in several executions, each
     * with a different counterparty: a Hyperliquid short opened against OKX
     * and later added to against Binance is two strategies, and collapsing
     * its executions to one leg-level set would force both onto one card.
     * That is the netting mistake this whole module exists to undo, so where
     * it could happen we do nothing rather than something wrong.
     *
     * Lifting this needs the constraint pushed down into the allocator, so a
     * leg's increments can be placed on different tranches while each stays
     * with whatever it was traded alongside.
     */
    const incrementCount = new Map<string, number>();
    for (const a of atoms) incrementCount.set(a.legKey, (incrementCount.get(a.legKey) ?? 0) + 1);

    for (const [leg, legs] of legsBoundTogether(atoms, execs)) {
      if (legs.some((k) => (incrementCount.get(k) ?? 0) !== 1)) continue;
      boundVenues.set(leg, [
        ...new Set(
          legs
            .map((k) => cohortLegs.find((x) => `boros:${x.marketId}` === k)?.leg.venue)
            .filter((v): v is string => v !== undefined),
        ),
      ]);
    }
  }

  /**
   * How much of each tranche's perp is still free to hedge something, in USD
   * per venue.
   *
   * ⚠ A perp has NO MATURITY. One position hedges every maturity cohort at
   * once, so it cannot belong to a single one — cohorts DRAW DOWN a shared
   * capacity instead. `pickCohort` used to force the choice and warn about it,
   * which stranded the perps on one maturity while a complete Boros pair on
   * another rendered with no hedge at all.
   */
  const capacity = new Map<string, Map<string, number>>();
  const perpLegAt = (t: PerpTranche, venue: string) => {
    const leg = t.long.venue === venue ? t.long : t.short.venue === venue ? t.short : null;
    const live = leg ? perpBySymbol.get(leg.symbol) : undefined;
    return leg && live ? { leg, live } : null;
  };
  const perpUsdAt = (t: PerpTranche, venue: string): number => {
    const at = perpLegAt(t, venue);
    return at ? at.live.leg.notionalUsd * at.leg.share : 0;
  };
  /**
   * The venue's own mark for one base coin, backed out of the position it
   * reports (`positionValue ÷ qty`). Only ever used to undo that same venue's
   * own conversion — see `unitPriceFor`.
   */
  const venuePriceAt = (t: PerpTranche, venue: string): number | null => {
    const at = perpLegAt(t, venue);
    const tokens = at?.live.leg.notionalToken ?? 0;
    return at && tokens > 0 ? at.live.leg.notionalUsd / tokens : null;
  };
  for (const t of tranches) {
    const byVenue = new Map<string, number>();
    for (const v of new Set([t.long.venue, t.short.venue])) byVenue.set(v, perpUsdAt(t, v));
    capacity.set(t.id, byVenue);
  }

  /**
   * Cohorts are served in EVIDENCE order: the cohort whose Boros fills sit
   * closest to a candidate tranche's open goes first, so the maturity a perp
   * was actually opened alongside claims it before an older, larger one can.
   */
  const cohortGap = (c: Cohort): number => {
    let best = Number.POSITIVE_INFINITY;
    for (const b of c.builds) {
      const incs = incrementsFor(b.marketId, b.leg.notionalToken ?? 0);
      for (const t of tranches) {
        if (t.base !== c.base) continue;
        if (t.long.venue !== b.leg.venue && t.short.venue !== b.leg.venue) continue;
        if (t.openedAtSec === null) continue;
        for (const i of incs ?? []) best = Math.min(best, Math.abs(i.timeSec - t.openedAtSec));
      }
    }
    return best;
  };
  const servingOrder = [...cohortList]
    .map((c) => ({ c, gap: cohortGap(c) }))
    // No fills to judge by ⇒ fall back to the larger book first, the old
    // pickCohort tie-break, so a book with no history is unchanged.
    .sort(
      (a, b) =>
        a.gap - b.gap ||
        b.c.builds.reduce((s, x) => s + x.leg.notionalUsd, 0) -
          a.c.builds.reduce((s, x) => s + x.leg.notionalUsd, 0),
    )
    .map((x) => x.c);

  for (const c of servingOrder) {
    const eligible = tranches.filter(
      (t) =>
        t.base === c.base &&
        c.builds.some((b) => b.leg.venue === t.long.venue || b.leg.venue === t.short.venue) &&
        [t.long.venue, t.short.venue].some((v) => (capacity.get(t.id)?.get(v) ?? 0) > 0),
    );
    if (eligible.length) assigned.set(c, eligible);
  }

  /**
   * A tranche that covers no Boros anywhere still has to be reported — it is a
   * real perp pair, just an uncovered one. It lands on its best cohort so the
   * card has a base and a maturity to render.
   *
   * When there is no cohort at all on its coin — every Boros leg spoken for by
   * someone else, or a coin that never touched Boros — it becomes its own
   * cohort with nothing in it, rather than falling off the page. A perp pair
   * with no hedge is a position; it is just an unhedged one.
   *
   * ⚠ A coin with no Boros ANYWHERE used to be excluded here and rebuilt by a
   * second card builder in `buildStrategies`. Two builders meant two copies of
   * the open-time re-stamp, the share timelines and the dust floor — and they
   * had already drifted: the copy labelled every pairing `measured`, so a
   * guessed grouping on a Boros-less coin claimed to be an execution record
   * while the identical grouping on a Boros coin admitted it was a proposal.
   * One tranche, one card, one place.
   */
  for (const t of tranches) {
    if ([...assigned.values()].some((ts) => ts.includes(t))) continue;
    const home =
      pickCohort(cohortList, t.base, [t.long.venue, t.short.venue]) ??
      ({ base: t.base, maturity: 0, builds: [] } satisfies Cohort);
    assigned.set(home, [...(assigned.get(home) ?? []), t]);
  }

  // share_i(t) for SHARED venue legs. The venue's cumulative funding counter
  // and the account-book ledger both measure the WHOLE position, while a
  // tranche's ownership of it CHANGES as sibling tranches open — funding
  // settled while an earlier tranche owned the whole leg must not be scaled
  // by its FINAL share. Per symbol: each tranche's share renormalised over
  // the siblings already open at t. Any missing open time makes the timeline
  // unknowable — no timeline, and the flat share stands.
  const shareTimelines = new Map<
    string,
    Map<string, Array<{ fromSec: number; share: number }>>
  >();
  {
    const legsBySymbol = new Map<
      string,
      Array<{ trancheId: string; openedAtSec: number | null; share: number }>
    >();
    for (const t of tranches) {
      for (const leg of [t.long, t.short]) {
        if (!leg.shared || !(leg.share > 0)) continue;
        const list = legsBySymbol.get(leg.symbol) ?? [];
        list.push({ trancheId: t.id, openedAtSec: t.openedAtSec, share: leg.share });
        legsBySymbol.set(leg.symbol, list);
      }
    }
    for (const [symbol, list] of legsBySymbol) {
      if (list.length < 2 || list.some((x) => x.openedAtSec === null)) continue;
      const opens = [...new Set(list.map((x) => x.openedAtSec as number))].sort((a, b) => a - b);
      const perTranche = new Map<string, Array<{ fromSec: number; share: number }>>();
      for (const x of list) {
        const timeline: Array<{ fromSec: number; share: number }> = [];
        for (const at of opens) {
          if (at < (x.openedAtSec as number)) continue;
          const openSum = list
            .filter((y) => (y.openedAtSec as number) <= at)
            .reduce((s, y) => s + y.share, 0);
          timeline.push({ fromSec: at, share: openSum > 0 ? x.share / openSum : x.share });
        }
        perTranche.set(x.trancheId, timeline);
      }
      shareTimelines.set(symbol, perTranche);
    }
  }

  /**
   * PASS 1 — resolve every cohort's Boros legs, consuming the shared perp
   * capacity as it goes, so a maturity served earlier cannot have its perp
   * counted again by a later one.
   */
  interface CohortPlan {
    shareByTranche: Map<string, Map<string, number>>;
    rateByTranche: Map<string, number>;
    pinNotes: Map<string, string[]>;
    coveredUsd: Map<string, number>;
  }
  const plans = new Map<Cohort, CohortPlan>();
  for (const [cohort, cohortTranches] of assigned) {
    /**
     * What fraction of THIS cohort's Boros leg at `venue` belongs to tranche
     * `t` — its perp size there over the perp size of every tranche in this
     * cohort at the same venue.
     *
     * ⚠ NOT `leg.share`. That is the tranche's share of the VENUE PERP, and a
     * perp is perpetual: one position hedges every maturity cohort at once, so
     * a book with two maturities splits it 50/50. A cohort's Boros leg is not
     * shared that way — it belongs entirely to the tranches in its own cohort
     * — so charging it the perp's share leaves the rest unclaimed, and the
     * leftover branch below spins it out as a phantom standalone card while
     * the real strategy reports itself half-hedged.
     *
     * Scoping the denominator to the cohort still divides one venue's leg
     * between two quote-coin symbols (pinTarget in ./partition) when both sit
     * in the SAME cohort — there the cohort-scoped sum is the venue-wide sum.
     * Token qty, not USD: the legs share a base, so the ratio is identical and
     * it needs no live perp build to be computable.
     */
    const qtyAt = (x: PerpTranche, venue: string): number => {
      const leg = x.long.venue === venue ? x.long : x.short.venue === venue ? x.short : null;
      return leg && leg.qty > 0 ? leg.qty : 0;
    };

    /**
     * Resolve every Boros leg in this cohort into a per-tranche share, PINS
     * FIRST and pro-rata for the rest.
     *
     * Same doctrine as a perp pin: a pinned size HOLDS and everything unpinned
     * absorbs the difference. A pin larger than the leg is clamped and said
     * out loud, never silently rescaled.
     */
    const pinNotes = new Map<string, string[]>();
    /** `${trancheId}:${venue}` → the fixed APR that tranche actually locked.
     * Filled by the same allocation that sizes it, so a strategy can never be
     * credited a rate for size it was not given. */
    const rateByTranche = new Map<string, number>();
    const shareByTranche = new Map<string, Map<string, number>>(
      cohortTranches.map((t) => [t.id, new Map<string, number>()]),
    );
    /** USD of perp this cohort's Boros actually covers, per tranche — what the
     * perp is then divided by in pass 2. */
    const coveredUsd = new Map<string, number>();
    for (const b of cohort.builds) {
      const venue = b.leg.venue;
      const total = b.leg.notionalToken ?? 0;
      /**
       * Which venues this leg must be held ALONGSIDE.
       *
       * Normally just its own. But when the co-execution pass found this leg
       * was placed together with another — same instant, matching size,
       * opposite side — the two are one trade and may not be divided between
       * cards. Requiring a tranche to cover every venue in the bound set is
       * what expresses that here: on a Binance-long / Hyperliquid-short pair,
       * only the tranche holding both perps qualifies, so both halves land on
       * it instead of being scored separately into two different cards.
       */
      const bound = boundVenues.get(`boros:${b.marketId}`);
      const needVenues = bound && bound.length > 1 ? bound : [venue];
      // Only a tranche with perp exposure at this venue can hold its Boros leg.
      // Anything the user spoke for is already out of this cohort, so there is
      // nothing to make an exception for.
      const strict = cohortTranches.filter((t) => needVenues.every((v) => qtyAt(t, v) > 0));
      // ⚠ Never strand the leg. If no tranche covers the whole bound set, the
      // grouping evidence simply cannot be honoured here — fall back to this
      // leg's own venue rather than dropping it out of the cohort.
      const eligible = strict.length > 0 ? strict : cohortTranches.filter((t) => qtyAt(t, venue) > 0);

      const rest = total;
      const unpinned = eligible;

      /**
       * BOROS ANCHORS THE SPLIT. The fills that built this leg say which
       * strategy opened which part of it; a strategy is capped at the perp
       * exposure it actually has to hedge, and anything left over stays
       * unclaimed rather than being pushed onto a strategy that never traded
       * it.
       *
       * Pro-rata by perp size is the fallback, and only where there is no
       * fill record to anchor on — with no evidence, an equal hedge ratio is
       * the least-assuming answer.
       */
      const scale = total > 0 ? rest / total : 0;
      const raw = incrementsFor(b.marketId, total);
      const pool = raw && scale > 0 ? raw.map((i) => ({ ...i, qty: i.qty * scale })) : null;
      // ⚠ A Boros leg is denominated in its COLLATERAL token, a perp in the
      // BASE asset — 1,000,000 USDT against 531 ETH. Demand has to cross that
      // boundary through USD, or a USDT-margined book hands every strategy a
      // millionth of its leg.
      const usdPerToken = total > 0 ? b.leg.notionalUsd / total : 0;
      /**
       * ...but only when the boundary is really there. When the zone's
       * collateral IS the base asset — 0.013 ETH of Boros against 0.013 ETH of
       * perp — both sides already count the same coin, and routing them
       * through USD converts one with Pendle's mark and the other with the
       * venue's. Those two oracles are sampled at different instants and
       * disagree by hundredths of a percent, so the SIGN of that disagreement,
       * not the hedge, decided whether the perp could cover its Boros. Every
       * time it came up short the remainder turned into `spare`, was smeared
       * over the other tranches, and surfaced as a dust card that blinked in
       * and out with the feeds.
       *
       * Undoing the venue's own conversion puts the comparison back in coins,
       * where it belongs: the price cancels and demand is the perp's token
       * count. A genuinely cross-denominated zone still goes through USD,
       * where the Boros notional is already a USD amount and the venue's mark
       * is the honest value of the perp against it.
       */
      const sameUnit = (b.leg.collateral ?? '') === cohort.base;
      const unitPriceFor = (t: PerpTranche): number =>
        (sameUnit ? venuePriceAt(t, venue) : usdPerToken) ?? usdPerToken;
      // Remaining capacity, not the whole perp leg: an earlier maturity may
      // already be using part of this position to hedge its own Boros.
      const demandTokens = (t: PerpTranche): number => {
        const px = unitPriceFor(t);
        if (!(px > 0)) return 0;
        const freeUsd = capacity.get(t.id)?.get(venue) ?? 0;
        return Math.min(freeUsd / px, rest);
      };
      const byEvidence = pool
        ? allocateBorosByEvidence(
            pool,
            unpinned.map((t) => ({
              id: t.id,
              demand: demandTokens(t),
              openedAtSec: t.openedAtSec,
            })),
          )
        : null;

      const denom = unpinned.reduce((s, t) => s + Math.min(qtyAt(t, venue), demandTokens(t)), 0);
      /**
       * Boros the fills gave to nobody, because every strategy was already
       * capped at the perp it has to hedge.
       *
       * It must NOT be orphaned into a standalone card: a book deliberately
       * holding more Boros than perp is exactly what the hedge check exists to
       * report ("the Boros book is 140% of the perp book"), and quietly moving
       * the excess elsewhere would delete that signal. The demand cap is there
       * to stop one strategy taking what ANOTHER needs — not to disown size
       * nobody is competing for.
       */
      const claimed = byEvidence
        ? unpinned.reduce((s, t) => s + (byEvidence.get(t.id)?.qty ?? 0), 0)
        : 0;
      const spare = byEvidence ? Math.max(0, rest - claimed) : 0;
      for (const t of eligible) {
        const qty = byEvidence
          ? (byEvidence.get(t.id)?.qty ?? 0) +
            (spare > 0 && denom > 0 ? (spare * Math.min(qtyAt(t, venue), demandTokens(t))) / denom : 0)
          : denom > 0
            ? (rest * Math.min(qtyAt(t, venue), demandTokens(t))) / denom
            : 0;
        shareByTranche.get(t.id)?.set(venue, total > 0 ? qty / total : 0);
        // Same price the demand was measured with, or the tokens consumed and
        // the capacity they are charged against drift apart every cohort.
        const usedUsd = qty * unitPriceFor(t);
        const byVenue = capacity.get(t.id);
        if (byVenue) byVenue.set(venue, Math.max(0, (byVenue.get(venue) ?? 0) - usedUsd));
        coveredUsd.set(t.id, (coveredUsd.get(t.id) ?? 0) + usedUsd);
        const apr = byEvidence?.get(t.id)?.fixedApr;
        if (apr !== null && apr !== undefined) {
          rateByTranche.set(`${t.id}:${venue}`, apr);
        }
      }
    }

    plans.set(cohort, { shareByTranche, rateByTranche, pinNotes, coveredUsd });
  }

  /**
   * PASS 2 — a perp is divided between the cohorts it actually covers, in
   * proportion to the Boros it covers in each. Normalised so the shares sum to
   * one: nothing of the position may vanish from the page, so a tranche that
   * is only partly covered keeps its whole perp on the cohort that covers it
   * and reports the imbalance there.
   */
  const perpShareIn = (t: PerpTranche, cohort: Cohort): number => {
    let total = 0;
    for (const plan of plans.values()) total += plan.coveredUsd.get(t.id) ?? 0;
    if (!(total > 0)) {
      /**
       * Covered NOWHERE — a real perp pair that nothing hedges. It still has
       * to be reported, but exactly once: a tranche is eligible for every
       * cohort sharing one of its venues, so returning 1 to each of them
       * rendered the same position as a full-size card in all of them. And
       * `spans` counts covered cohorts, which is zero here, so none of those
       * cards got the disambiguating suffix — the venue's position was
       * double-counted across the book under one repeated strategyId. The
       * first cohort to serve it owns it; the rest see 0 and skip below.
       */
      const first = [...assigned.keys()].find((c) => assigned.get(c)?.includes(t));
      return cohort === first ? 1 : 0;
    }
    return (plans.get(cohort)?.coveredUsd.get(t.id) ?? 0) / total;
  };

  for (const [cohort, cohortTranches] of assigned) {
    const { shareByTranche, rateByTranche, pinNotes } = plans.get(cohort) as CohortPlan;
    const venueSlice = (t: PerpTranche, venue: string): number =>
      shareByTranche.get(t.id)?.get(venue) ?? 0;

    for (const t of cohortTranches) {
      const cohortPerpShare = perpShareIn(t, cohort);
      /**
       * A tranche that hedges two maturities produces a card in each, so the
       * tranche id alone is no longer unique — and everything the client keys
       * off strategyId (pins, excluded entry parts, React keys, share links)
       * would collide between them. Suffix ONLY when it actually spans, so
       * the ordinary single-cohort id is unchanged.
       */
      const spans = [...plans.keys()].filter(
        (c) => (plans.get(c)?.coveredUsd.get(t.id) ?? 0) > 0,
      ).length;
      const cardId = spans > 1 ? `${t.id}@${cohort.maturity}` : t.id;
      if (!(cohortPerpShare > 0) && !cohort.builds.some((b) => venueSlice(t, b.leg.venue) > 0)) {
        continue;
      }
      // A tranche that owns both its legs whole IS the position: leave its
      // open times alone so nothing about a single-strategy book changes
      // (the migration chain in assembleStrategy still gets its shot). Only a
      // SHARED leg needs re-stamping, because the venue row's createTime is
      // the first tranche's open, not this one's.
      const ownsBothLegs = !t.long.shared && !t.short.shared;
      // A Boros position shared by several strategies opened before most of
      // them: leave its open alone only when this tranche owns it outright,
      // or every later tranche inherits the first one's APR clock.
      const trancheOpenedAt = ownsBothLegs ? null : t.openedAtSec;
      const perpBuilds: PerpLegBuild[] = [];
      for (const leg of [t.long, t.short]) {
        const live = perpBySymbol.get(leg.symbol);
        if (!live) continue;
        // The tranche's own share of the venue position, then the fraction of
        // THAT which this maturity covers. A perp spanning two cohorts is
        // divided between them rather than picked by one.
        const inCohort =
          cohortPerpShare >= 1 - 1e-9
            ? leg
            : { ...leg, qty: leg.qty * cohortPerpShare, share: leg.share * cohortPerpShare };
        const build = scalePerpBuild(live, inCohort, trancheOpenedAt);
        const timeline = shareTimelines.get(leg.symbol)?.get(t.id);
        if (timeline && timeline.length > 0) build.shareTimeline = timeline;
        perpBuilds.push(build);
      }
      const borosScaled: BorosLegBuild[] = [];
      for (const b of cohort.builds) {
        const leg = b.leg.venue === t.long.venue ? t.long : b.leg.venue === t.short.venue ? t.short : null;
        if (!leg || !(leg.share > 0)) continue;
        // Clamped by what is left, so no rounding path can hand out more of a
        // position than exists.
        const share = Math.min(venueSlice(t, b.leg.venue), borosShareLeft.get(b) ?? 1);
        if (!(share > 0)) continue;
        borosScaled.push(
          scaleBorosBuild(b, share, rateByTranche.get(`${t.id}:${b.leg.venue}`), trancheOpenedAt),
        );
        borosShareLeft.set(b, (borosShareLeft.get(b) ?? 1) - share);
      }
      // A perp is perpetual, so one position can hedge several maturities at
      // once. It is no longer ATTACHED to a chosen cohort — each draws the
      // part it covers — but a leg that really is split says so, because its
      // numbers here are a fraction of the position the venue reports.
      if (cohortPerpShare < 1 - 1e-9) {
        /**
         * Never round a share to 0% or 100%. A sliver reads as "0% of this
         * GATE perp is counted here" beside leg rows that plainly carry
         * numbers, and the reader cannot tell whether the leg is absent,
         * rounded, or broken; 99.6% claims a whole position on a card that is
         * not one.
         */
        const pct =
          cohortPerpShare < 0.01
            ? '<1'
            : cohortPerpShare > 0.99
              ? '>99'
              : String(Math.round(cohortPerpShare * 100));
        for (const b of perpBuilds) {
          b.leg.warnings.push(
            `${pct}% of this ${b.leg.venue} perp is counted here — the rest hedges ${cohort.base}'s other Boros maturities.`,
          );
        }
      }
      // Float dust from the perp pairing can leave a tranche with essentially
      // nothing in it. A position of a fraction of a cent is not a strategy.
      if (![...perpBuilds, ...borosScaled].some((b) => b.leg.notionalUsd > 0.005)) continue;
      const rollup = assembleStrategy({
        strategyId: cardId,
        attribution: {
          // A coin that never touched Boros is `unhedged` however well the
          // pairing itself is evidenced: the chip answers "is a rate locked
          // against this", and nothing is. It is also what keeps a pure
          // funding arb out of the Boros-tracked totals, where it would
          // dominate an APR it has no part in. How the pairing was ARRIVED at
          // is a separate question, and `confidence` still answers it.
          source: borosBases.has(t.base) ? t.source : 'unhedged',
          confidence: t.confidence,
          pinned: t.pinned,
        },
        base: cohort.base,
        maturity: cohort.maturity,
        borosBuilds: borosScaled,
        perpBuilds,
        perpAvailable: true,
        nowSec: input.nowSec,
        clockStartOverrideSec: input.clockStartOverrideSec,
        venueFees: input.venueFees,
        fundingLedger: input.perpFunding,
        dealFills: input.dealFills,
        capitalBasis: input.capitalBasis ?? 'balance',
      });
      // Both of these are `unconfirmed` — neither was measured from the
      // execution record — but they are not the same claim, and a card that
      // shows the `pinned` chip while saying the split was guessed
      // contradicts itself.
      for (const note of pinNotes.get(t.id) ?? []) rollup.warnings.push(note);
      if (t.source === 'user') {
        rollup.warnings.push(
          `This ${t.base} position is the size you pinned — the rest of the book is matched around it, and it holds until you change it.`,
        );
      } else if (t.confidence === 'unconfirmed') {
        rollup.warnings.push(
          `This ${t.base} position was matched by price and open-time proximity, not by an execution record — the split between strategies is a proposal you can edit, not a measurement.`,
        );
      }
      out.push(rollup);
    }
  }

  /**
   * Boros notional NO POSITION CLAIMED — a standalone directional leg.
   *
   * Two things arrive here and they are the same thing: what the solver could
   * not attach, and what the user detached. Grouped by (base, maturity) rather
   * than by cohort, because a cohort whose every leg was spoken for no longer
   * exists, and its leftovers would have nowhere to be reported.
   */
  const unowned = new Map<string, { cohort: Cohort | undefined; base: string; maturity: number; builds: BorosLegBuild[] }>();
  const addUnowned = (b: BorosLegBuild, cohort?: Cohort) => {
    const base = b.leg.base;
    const maturity = b.leg.maturity ?? 0;
    const key = `${base}@${maturity}`;
    const at = unowned.get(key) ?? { cohort, base, maturity, builds: [] };
    at.cohort = at.cohort ?? cohort;
    at.builds.push(b);
    unowned.set(key, at);
  };
  for (const b of asserted.orphanedBoros) addUnowned(b);
  for (const cohort of cohortList) {
    for (const b of cohort.builds) {
      const left = borosShareLeft.get(b) ?? 1;
      if (left <= 1e-6) continue;
      /**
       * Leftover size re-balances like any other un-asserted claim.
       *
       * This is size no membership row mentions, so it never passed through
       * the per-claim reconciliation — but the venue's blend counted it, so
       * leaving it on that blend showed two different entries for one venue
       * position: the asserted card moved and this leftover card did not.
       */
      const implied = asserted.impliedByLeg.get(
        legRefKey({ kind: 'boros', marketId: b.marketId }),
      );
      const scaled = left >= 1 - 1e-9 ? b : scaleBorosBuild(b, left, implied);
      addUnowned(
        implied !== undefined && scaled.leg.entryApr !== implied
          ? { ...scaled, leg: { ...scaled.leg, entryApr: implied, venueEntry: b.leg.entryApr } }
          : scaled,
        cohort,
      );
    }
  }
  for (const { cohort, base, maturity, builds: unclaimed } of unowned.values()) {
    // `attached` = this coin already has a strategy — solved OR asserted — so
    // the leftover is a remainder beside it. Otherwise the coin is Boros-only
    // and keeps the legacy behaviour of pulling in any perp nobody spoke for.
    const attached =
      (cohort !== undefined && assigned.has(cohort)) ||
      asserted.cards.some((c) => c.base === base);
    const freePerps =
      attached || cohort === undefined
        ? []
        : perpBuildsAll.filter(
            (p) =>
              !spokenFor.has(p.symbol) &&
              pickCohort(cohortList, p.leg.base, [p.leg.venue]) === cohort,
          );
    /**
     * The spreads inside this remainder, before it is called one position.
     *
     * A cohort's unclaimed legs arrive here as a SET, and a set of four legs
     * is not a strategy just because no perp tranche wanted it — a book that
     * pays fixed at two venues against one that receives is two spreads
     * sharing a leg. `pairBorosLegs` states which, and only what it could not
     * pair stays whole.
     */
    const { pairs, leftovers } = pairBorosLegs(
      unclaimed,
      incrementsFor,
      input.borosHistoryComplete !== false,
    );
    /** Every card this remainder becomes: its spreads, then its odd legs. */
    const groups: Array<{ id: string; builds: BorosLegBuild[]; unconfirmed: boolean }> = [
      ...pairs.map((p) => ({
        // Keyed by the two MARKETS, not their venues. Stable across re-solves
        // and it survives the other spread on a shared leg being closed —
        // while a venue pair does not name a spread uniquely: one venue lists
        // the same coin in several collateral zones, so two spreads in one
        // cohort can sit on the same two venues and collide.
        id: `${base}@${maturity}#boros:${p.long.marketId}-${p.short.marketId}`,
        builds: [p.long, p.short],
        unconfirmed: p.unconfirmed,
      })),
      ...leftovers.map((b) => ({
        id: `${base}@${maturity}#boros:${b.marketId}`,
        builds: [b],
        unconfirmed: false,
      })),
    ];
    if (groups.length === 1) {
      // Nothing was split out, so this IS the remainder — keep the id it has
      // always had, and leave existing pins and share links pointing at it.
      groups[0].id = attached ? `${base}@${maturity}#unmatched` : `${base}@${maturity}`;
    } else {
      /**
       * A market can reach this pass TWICE — once as size the user detached
       * and once as size the solver could not place — and those are two
       * different statements about one leg, so they stay two positions. Their
       * ids are named for the legs they hold, though, which makes them the
       * same string; the ordinal keeps them apart. Deterministic, because the
       * order above is.
       */
      const used = new Set<string>();
      for (const g of groups) {
        let id = g.id;
        for (let n = 2; used.has(id); n += 1) id = `${g.id}~${n}`;
        used.add(id);
        g.id = id;
      }
    }
    for (const g of groups) {
      const venues = new Set(g.builds.map((b) => b.leg.venue));
      const rollup = assembleStrategy({
        strategyId: g.id,
        attribution: {
          source: attached ? 'boros-only' : 'merged',
          confidence: g.unconfirmed ? 'unconfirmed' : 'measured',
          pinned: false,
        },
        base,
        maturity,
        borosBuilds: g.builds,
        // A pulled-in perp goes to the spread it sits at the venue of — never
        // to all of them, which would count one position several times.
        perpBuilds: freePerps.filter((p) => venues.has(p.leg.venue)),
        perpAvailable: input.perpPositions !== null,
        nowSec: input.nowSec,
        clockStartOverrideSec: input.clockStartOverrideSec,
        venueFees: input.venueFees,
        fundingLedger: input.perpFunding,
        dealFills: input.dealFills,
        capitalBasis: input.capitalBasis ?? 'balance',
      });
      if (g.unconfirmed) {
        rollup.warnings.push(
          `This ${base} spread was paired by size and open-time proximity, not by an execution record — the split between strategies is a proposal you can edit, not a measurement.`,
        );
      }
      out.push(rollup);
    }
  }
  if (!out.length) return mergedStrategies(input, cohortList, perpBuildsAll);
  return out;
}

const borosLegsOf = (cohorts: Cohort[]): BorosLegBuild[] => cohorts.flatMap((c) => c.builds);

/** Perps are perpetual (no maturity): when a coin has several Boros maturity
 * cohorts, prefer the one holding the most Boros notional at the given
 * venues. */
function pickCohort(cohorts: Cohort[], base: string, venues: string[]): Cohort | null {
  const sameBase = cohorts.filter((c) => c.base === base);
  if (!sameBase.length) return null;
  const ranked = sameBase
    .map((c) => ({
      cohort: c,
      venueNotional: c.builds
        .filter((b) => venues.includes(b.leg.venue))
        .reduce((s, b) => s + b.leg.notionalUsd, 0),
    }))
    .sort((a, b) => b.venueNotional - a.venueNotional);
  return ranked[0].venueNotional > 0 ? ranked[0].cohort : sameBase[0];
}

/**
 * Boros legs as the trades they were built from — the input `./grouping` needs
 * to say which of them went out together.
 *
 * ONE encoding, because there are two callers: the co-execution constraint on
 * the cohort's legs, and the spread pairing on the ones no tranche claimed.
 * The atom id scheme, the leg-key format and the floating-sign convention have
 * to agree between them or the two passes disagree about what a book is, and
 * `Atom.identity` (which short-circuits the score and upgrades the band to
 * `certain`) would otherwise have to be added to both.
 */
function borosAtoms(
  builds: readonly BorosLegBuild[],
  incrementsFor: (marketId: number, size: number) => BorosIncrement[] | null,
): { atoms: GroupingAtom[]; byLegKey: Map<string, BorosLegBuild> } {
  const atoms: GroupingAtom[] = [];
  const byLegKey = new Map<string, BorosLegBuild>();
  for (const b of builds) {
    const incs = incrementsFor(b.marketId, Math.abs(b.leg.notionalToken ?? 0));
    // A leg whose history cannot be replayed has no increments to pair; both
    // callers still handle it, just with no co-execution evidence.
    if (!incs) continue;
    const legKey = `boros:${b.marketId}`;
    byLegKey.set(legKey, b);
    // Boros LONG receives floating (+), SHORT pays it (−) — the same sign
    // convention the hedge check uses, so opposite signs really do cancel.
    const sign = b.leg.side === 'LONG' ? 1 : -1;
    incs.forEach((inc, i) => {
      atoms.push({
        id: `${legKey}#${i}`,
        legKey,
        venue: b.leg.venue,
        base: b.leg.base,
        floating: sign * inc.qty,
        qty: inc.qty,
        rate: inc.fixedApr,
        at: { kind: 'at', sec: inc.timeSec },
      });
    });
  }
  return { atoms, byLegKey };
}

/** One spread the Boros remainder pass could form: a pay-fixed leg against a
 * receive-fixed leg on the same coin and maturity, each already scaled to the
 * size the pairing gave it. */
interface BorosPair {
  long: BorosLegBuild;
  short: BorosLegBuild;
  /** True when no execution record explained the pairing — the same claim the
   * perp side makes with `confidence: 'unconfirmed'`. */
  unconfirmed: boolean;
}

/**
 * Pair the Boros legs NO PERP TRANCHE CLAIMED into spreads.
 *
 * ⚠ This does NOT contradict the "perps anchor" doctrine in ./partition. That
 * rule is about what may anchor the matching of a HEDGE: a Boros leg can be a
 * standalone directional trade, so it must never pull a perp onto a card. It
 * says nothing about two Boros legs that are plainly the two sides of one
 * spread — one paying fixed, one receiving it, same coin, same maturity — and
 * leaving those merged produced a card with three, four or more legs whose
 * header could name only two venues and whose spread averaged across trades
 * that have nothing to do with each other.
 *
 * Evidence first, in the same order the perp side uses it:
 *  1. co-execution — the increments each leg decomposes into, bound by
 *     `bindExecutions`. This terminal places both Boros legs as ONE order, so
 *     a book it built is measured here rather than guessed;
 *  2. proximity — what is left, paired by size and open-time closeness, and
 *     reported `unconfirmed`.
 *
 * Whatever no pairing could claim comes back as `leftovers`: a directional leg
 * is a position of one leg, never a third leg on someone else's card.
 */
function pairBorosLegs(
  builds: readonly BorosLegBuild[],
  incrementsFor: (marketId: number, size: number) => BorosIncrement[] | null,
  historyComplete: boolean,
): { pairs: BorosPair[]; leftovers: BorosLegBuild[] } {
  const whole = (b: BorosLegBuild): number => Math.abs(b.leg.notionalToken ?? 0);
  const sized = builds.filter((b) => whole(b) > 0);
  const longs = sized.filter((b) => b.leg.side === 'LONG');
  const shorts = sized.filter((b) => b.leg.side === 'SHORT');
  // Nothing to pair against: every leg is directional, and each is its own
  // position. Returned unscaled so a book that never needed splitting is
  // byte-for-byte what it was.
  if (!longs.length || !shorts.length) {
    return { pairs: [], leftovers: [...builds] };
  }

  const left = new Map<BorosLegBuild, number>(sized.map((b) => [b, whole(b)]));
  const openedAt = (b: BorosLegBuild): number | null => b.leg.openedAt ?? null;
  const pairings: Array<{ long: BorosLegBuild; short: BorosLegBuild; qty: number; measured: boolean }> = [];
  const add = (long: BorosLegBuild, short: BorosLegBuild, want: number, measured: boolean) => {
    const qty = Math.min(want, left.get(long) ?? 0, left.get(short) ?? 0);
    if (!(qty > 0)) return;
    left.set(long, (left.get(long) as number) - qty);
    left.set(short, (left.get(short) as number) - qty);
    // ONE pairing per pair of legs, whatever explained it. A book part-built
    // on the execution record and part off it (a top-up placed by hand) is one
    // spread, not two cards on the same two legs — and, like a perp tranche
    // assembled from several sources, it reports the weakest one.
    const at = pairings.find((p) => p.long === long && p.short === short);
    if (at) {
      at.qty += qty;
      at.measured = at.measured && measured;
      return;
    }
    pairings.push({ long, short, qty, measured });
  };

  // --- 1. Co-execution ------------------------------------------------------
  // Skipped when there is only one leg per side: the proximity pass below
  // pairs them `forced`, which is already the strongest claim available, so
  // replaying every fill and binding all-pairs could not change the answer.
  if (longs.length > 1 || shorts.length > 1) {
    const { atoms, byLegKey } = borosAtoms(sized, incrementsFor);
    const byId = new Map(atoms.map((a) => [a.id, a]));
    for (const exec of bindExecutions(atoms, { historyComplete })) {
      const members = exec.atomIds.map((id) => byId.get(id)).filter((a): a is GroupingAtom => !!a);
      const qtyByLeg = new Map<string, number>();
      for (const a of members) qtyByLeg.set(a.legKey, (qtyByLeg.get(a.legKey) ?? 0) + a.qty);
      // Only a TWO-leg execution states a pair. A wider one is a real trade
      // that spanned three legs, and forcing it into a pair would invent the
      // very grouping this is trying to stop guessing at — it falls through
      // to proximity, which always yields two.
      if (qtyByLeg.size !== 2) continue;
      const [a, b] = [...qtyByLeg.keys()].map((k) => byLegKey.get(k));
      if (!a || !b || a.leg.side === b.leg.side) continue;
      const long = a.leg.side === 'LONG' ? a : b;
      const short = a.leg.side === 'LONG' ? b : a;
      add(
        long,
        short,
        Math.min(qtyByLeg.get(`boros:${long.marketId}`) ?? 0, qtyByLeg.get(`boros:${short.marketId}`) ?? 0),
        true,
      );
    }
  }

  // --- 2. Proximity ---------------------------------------------------------
  // Same objective as the perp residual solver: closest in size, then in open
  // time. A single long against a single short is the whole book, so it is
  // still reported measured — there was no other partition to choose.
  const forced = longs.length === 1 && shorts.length === 1;
  for (;;) {
    let best: { long: BorosLegBuild; short: BorosLegBuild; qty: number; score: number } | null = null;
    for (const lo of longs) {
      const lq = left.get(lo) ?? 0;
      if (!(lq > 0)) continue;
      const lt = openedAt(lo);
      for (const sh of shorts) {
        const sq = left.get(sh) ?? 0;
        if (!(sq > 0)) continue;
        const st = openedAt(sh);
        const size = Math.abs(lq - sq) / Math.max(lq, sq);
        const time = lt === null || st === null ? 1 : Math.abs(lt - st) / TIME_SCALE_SEC;
        const score = size + time;
        if (!best || score < best.score - 1e-12) {
          best = { long: lo, short: sh, qty: Math.min(lq, sq), score };
        }
      }
    }
    if (!best) break;
    add(best.long, best.short, best.qty, forced);
  }

  // --- Emit -----------------------------------------------------------------
  const dust = (b: BorosLegBuild, qty: number) => qty <= Math.max(1e-12, whole(b) * 1e-9);
  const pairs: BorosPair[] = [];
  for (const p of pairings) {
    if (dust(p.long, p.qty) || dust(p.short, p.qty)) continue;
    const slice = (b: BorosLegBuild) => {
      const share = p.qty / whole(b);
      return share >= 1 - 1e-9 ? b : scaleBorosBuild(b, share);
    };
    pairs.push({ long: slice(p.long), short: slice(p.short), unconfirmed: !p.measured });
  }
  const leftovers: BorosLegBuild[] = [];
  for (const b of builds) {
    const over = left.get(b);
    // A leg the pass never sized (no token notional) is passed through whole
    // rather than dropped — it still has to be reported somewhere.
    if (over === undefined) {
      leftovers.push(b);
      continue;
    }
    if (dust(b, over)) continue;
    leftovers.push(over >= whole(b) * (1 - 1e-9) ? b : scaleBorosBuild(b, over / whole(b)));
  }
  return { pairs, leftovers };
}

/** A perp position scaled down to one tranche: its own size, its own entry
 * price (null ⇒ the strategy reports null slippage rather than splitting the
 * venue's blended entry), and its share of every cumulative number. */
function scalePerpBuild(
  b: PerpLegBuild,
  leg: PerpTranche['long'],
  openedAtSec: number | null,
): PerpLegBuild {
  const share = leg.share;
  // Pro-rata on the venue's CUMULATIVE fee, never the fills' own sum. The
  // fill-derived figure only covers matched two-symbol opening executions, so
  // it silently drops fees paid on closes, single-leg adds, fills from other
  // clients, and anything past the history page cap — and it is denominated
  // in whatever coin the venue charged. Gate's per-position `fee` is exact and
  // complete; splitting it by size is the honest decomposition.
  const feesUsd = b.leg.feesUsd * share;
  const cashFlowUsd = b.leg.cashFlowUsd * share;
  return {
    ...b,
    leg: {
      ...b.leg,
      notionalUsd: b.leg.notionalUsd * share,
      notionalToken: leg.qty,
      cashFlowUsd,
      mtmUsd: b.leg.mtmUsd * share,
      feesUsd,
      netUsd: cashFlowUsd - feesUsd,
      // The TRANCHE's open, not the venue position's: a shared leg's row
      // stamps its first fill, which is a different day for the strategy
      // opened later — and the entry-gap check needs the two legs of THIS
      // execution to be contemporaneous.
      openedAt: openedAtSec ?? b.leg.openedAt,
      share,
      // Only when this tranche's entry is genuinely its own. `legOf` leaves it
      // null on a shared blended leg precisely so the card does not present
      // the venue's average as this strategy's price — and an assertion is
      // what turns it back into a real number.
      ...(leg.entryPrice !== null && leg.entryPrice > 0 ? { entryPrice: leg.entryPrice } : {}),
      // The venue's own blend, kept only when this claim's figure has moved
      // away from it — see the note on `venueEntry`.
      ...(leg.entryPrice !== null && leg.entryPrice > 0 && b.entryPrice > 0 && leg.entryPrice !== b.entryPrice
        ? { venueEntry: b.entryPrice }
        : {}),
      warnings: [...b.leg.warnings],
    },
    imUsd: b.imUsd * share,
    // 0 reads as "unknown" everywhere downstream, which is exactly right when
    // no execution record explains this tranche's entry.
    entryPrice: leg.entryPrice ?? 0,
    qty: leg.qty,
    cumulativeFundingUsd: cashFlowUsd,
    share,
  };
}

function scaleBorosBuild(
  b: BorosLegBuild,
  share: number,
  entryApr?: number,
  openedAtSec?: number | null,
): BorosLegBuild {
  const cashFlowUsd = b.leg.cashFlowUsd * share;
  const mtmUsd = b.leg.mtmUsd * share;
  const tradePnlUsd = b.leg.tradePnlUsd * share;
  return {
    ...b,
    leg: {
      ...b.leg,
      notionalUsd: b.leg.notionalUsd * share,
      notionalToken: (b.leg.notionalToken ?? 0) * share,
      entryApr: entryApr ?? b.leg.entryApr,
      cashFlowUsd,
      mtmUsd,
      tradePnlUsd,
      feesUsd: b.leg.feesUsd * share,
      netUsd: cashFlowUsd + mtmUsd + tradePnlUsd,
      // The clock (and the settlement-fee accrual) runs from here, so a
      // shared position's first open must not be handed to a strategy that
      // started months later.
      openedAt: openedAtSec ?? b.leg.openedAt,
      share,
      warnings: [...b.leg.warnings],
    },
    // The group balance stays whole and the position's margin shrinks: the
    // capital apportionment divides one by the other, so a strategy gets its
    // share of the group and never more.
    positionInitialMarginUsd: b.positionInitialMarginUsd * share,
  };
}
