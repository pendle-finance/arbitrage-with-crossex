/**
 * Hand-mirrored API contract for the Arbitrage with CrossEx backend
 * (Fastify on http://localhost:6688, proxied at /api).
 *
 * Monitoring route shapes mirror what the backend serializes from gate-api +
 * src/core/positions.ts. Trading types (ActionInput, deals) are copied
 * faithfully from src/core/actions.ts + src/core/errors.ts for the trading UI.
 *
 * Conventions:
 * - All Gate numerics are decimal STRINGS (qty, prices, balances, rates).
 * - Exposure groups are the one exception: they are computed server-side by
 *   core/positions.ts `computeExposure`, whose output uses plain NUMBERS.
 * - Margin rates are ratios (0..1); Gate returns a large sentinel (>= 9) when
 *   there are no positions — render "—" instead of a nonsensical percentage.
 * - createTime / create_time epoch units may be seconds OR milliseconds; use
 *   `toDate()` from lib/fmt.ts (value < 1e12 ⇒ seconds).
 */

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export interface ApiMeta {
  ts: number;
  stale?: boolean;
}

/** Mirror of src/core/errors.ts ErrorCategory. */
export type ErrorCategory =
  | 'auth'
  | 'not-configured'
  | 'insufficient-margin'
  | 'size-too-small'
  | 'size-too-large'
  | 'price-limit'
  | 'post-only-would-cross'
  | 'leverage'
  | 'reduce-only-violation'
  | 'rate-limited'
  | 'symbol-invalid'
  | 'venue-rejected'
  | 'validation'
  | 'network'
  | 'unknown';

/** Mirror of src/core/errors.ts ClassifiedError (the envelope's error shape). */
export interface ClassifiedError {
  category: ErrorCategory;
  label?: string;
  message: string;
  httpStatus?: number;
  retryable: boolean;
  hint?: string;
}

export type Envelope<T> =
  | { ok: true; data: T; meta: ApiMeta }
  | { ok: false; error: ClassifiedError };

// ---------------------------------------------------------------------------
// GET /api/credentials  (PUT /api/credentials { key, secret } ships later)
// ---------------------------------------------------------------------------

export interface CredentialsInfo {
  configured: boolean;
  keyMasked: string | null;
}

export interface CredentialsInput {
  key: string;
  secret: string;
}

// ---------------------------------------------------------------------------
// GET /api/disclaimer  (POST /api/disclaimer/accept { version })
// ---------------------------------------------------------------------------

export interface DisclaimerStatus {
  /** The disclaimer version this build ships. */
  version: string;
  /** True once the CURRENT version has been accepted (a stale acceptance is false). */
  accepted: boolean;
  /** The version the user last accepted, or null if never. */
  acceptedVersion: string | null;
}

/** GET /api/version — the server-side GitHub update check (silent on failure:
 * every error collapses to updateAvailable false). */
export interface UpdateStatus {
  /** The running copy's version (null = local version.json unreadable). */
  current: string | null;
  /** What the installer recorded about this tree; null in a source checkout. */
  install: {
    repo: string | null;
    requestedRef: string | null;
    commit: string | null;
    source: string | null;
    installedAt: string | null;
  } | null;
  /** The latest published version (null = remote unreadable / check disabled). */
  latest: string | null;
  updateAvailable: boolean;
  /** The latest version's feature list — only when updateAvailable. */
  highlights: string[];
}

// ---------------------------------------------------------------------------
// GET /api/account
// ---------------------------------------------------------------------------

export interface CrossexAsset {
  coin: string;
  exchangeType: string;
  balance: string;
  equity: string;
  availableBalance: string;
  upnl: string;
  liability: string;
}

export interface CrossexAccount {
  marginBalance: string;
  availableMargin: string;
  initialMargin: string;
  maintenanceMargin: string;
  /** Ratio (0..1); values >= 9 are a "no positions" sentinel → render "—". */
  initialMarginRate: string;
  /** Ratio (0..1); values >= 9 are a "no positions" sentinel → render "—". */
  maintenanceMarginRate: string;
  accountMode: string;
  positionMode: string;
  assets: CrossexAsset[];
}

// ---------------------------------------------------------------------------
// GET /api/positions
// ---------------------------------------------------------------------------

export interface CrossexPosition {
  symbol: string;
  positionSide: string;
  positionQty: string;
  positionValue: string;
  entryPrice: string;
  markPrice: string;
  leverage: string;
  maxLeverage: string;
  upnl: string;
  upnlRate: string;
  fundingFee: string;
  fee: string;
  initialMargin: string;
  maintenanceMargin: string;
}

/** Mirror of src/core/positions.ts ExposureLeg (numbers, computed server-side). */
export interface ExposureLeg {
  symbol: string;
  exchange: string;
  quote: string;
  side: 'LONG' | 'SHORT';
  qty: number;
  value: number; // absolute notional (position_value)
}

/** Mirror of src/core/positions.ts ExposureGroup. */
export interface ExposureGroup {
  base: string;
  legs: ExposureLeg[];
  longValue: number;
  shortValue: number;
  netValue: number; // long - short
  grossValue: number; // long + short
  /** |net|/gross < 2% — the arb pair is effectively delta-neutral. */
  neutral: boolean;
  /** Only one direction present — an unhedged leg. */
  singleLeg: boolean;
}

export interface PositionsResponse {
  positions: CrossexPosition[];
  exposure: ExposureGroup[];
}

// ---------------------------------------------------------------------------
// GET /api/strategy/:address — mirror of src/core/boros/returns.ts. All values
// are computed server-side and arrive as plain NUMBERS (USD / APR fractions /
// unix seconds); warnings are ready-to-render plain-language sentences.
// ---------------------------------------------------------------------------

export interface StrategyLeg {
  kind: 'perp' | 'boros';
  /** Normalized venue key (BINANCE / HYPERLIQUID / …). */
  venue: string;
  base: string;
  side: 'LONG' | 'SHORT';
  notionalUsd: number;
  /** Boros only: the collateral token the position is margined and sized in. */
  collateral?: string;
  /** |notional| in token units — Boros: |notionalSize| in the collateral token
   * (notionalUsd = notionalToken × its USD price); perp: |qty| in the base coin. */
  notionalToken?: number;
  /** Boros only: the venue's own market id — how a membership row names it. */
  marketId?: number;
  /** Boros only: entry fixed APR and current mark APR (fractions). */
  entryApr?: number;
  markApr?: number;
  /** Perp only: what THIS strategy's share of the leg entered at. Differs from
   * the live position's blended figure once a user has asserted what their
   * half paid — the other claims then take whatever conserves the venue
   * average, so the per-card number has to come from the payload, not from the
   * position. Absent when nothing is known; fall back to the position. */
  entryPrice?: number;
  /** The VENUE's own blended entry across every claim on this leg, present only
   * when a user assertion has moved this claim away from it. Without it the UI
   * would compare `entryApr`/`entryPrice` to itself and report the user's own
   * assertion as what the venue says. */
  venueEntry?: number;
  /** Boros only: the reference perp's live floating APR. */
  floatingApr?: number;
  /** Perp: funding since the STRATEGY CLOCK START (re-based via the CrossEx
   * funding ledger when the position predates it; a warning says when the
   * ledger couldn't cover the window). Boros: settlements net of settle fees. */
  cashFlowUsd: number;
  /** Boros only: settlement fees this leg has already paid — the per-leg share
   * of `feesUsd.paid.borosSettlementUsd`. `cashFlowUsd` is already net of it,
   * so a "before costs" reading adds it back. Never re-subtract. */
  settlementFeePaidUsd?: number;
  /** Perp: price MtM — DISPLAY ONLY, excluded from netUsd (the delta-neutral
   * pair's uPnLs cancel; the residual is accounted once as entry slippage).
   * Boros: mark value of the remaining rate stream — included in netUsd. */
  mtmUsd: number;
  /** Realized trade PnL NET of trade fees (0 for pure holds). */
  tradePnlUsd: number;
  /** Trading fees paid — a POSITIVE cost number. */
  feesUsd: number;
  /** Perp: cashFlowUsd − feesUsd. Boros: cashFlow + mtm + tradePnl. */
  netUsd: number;
  /** Unix seconds, null when unknown. */
  openedAt: number | null;
  /** Boros only: unix-seconds maturity. */
  maturity?: number;
  /** Perp only: the exact CrossEx symbol — join key to the live position. */
  symbol?: string;
  /** The fraction of the venue position attributed to this strategy (1 = the
   * whole leg). Every shared number on the leg is already scaled by it. */
  share?: number;
  warnings: string[];
}

/** One tickable piece of a strategy's PAID perp entry cost.
 *
 * INVARIANT: the parts sum to
 *   feesUsd.paid.perpTradingUsd + (feesUsd.paid.perpEntrySlippageUsd ?? 0)
 * — the card subtracts the un-ticked ones from exactly those two aggregates.
 *
 * The kinds are NOT symmetric, and the UI says so:
 *  - `slippage` is per EXECUTION — one per journal deal (a venue migration or a
 *    DCA top-up each get their own), or a single whole-book part when both legs
 *    were opened together.
 *  - `fees` is per LEG, covering that position's whole life: Gate reports a
 *    position's fee as one cumulative scalar and nothing records a trading fee
 *    more finely, so a per-execution split would be invented. A leg migrated
 *    away from has no live position and so never appears here. */
export interface PerpEntryCostPart {
  id: string;
  kind: 'slippage' | 'fees';
  /** Signed — a favorable crossing is negative. */
  usd: number;
  /** Null when the cost has no single point in time (a leg's lifetime fees). */
  atSec: number | null;
  /** Two venues for a slippage part, one for fees. */
  venues: string[];
  side: 'LONG' | 'SHORT' | null;
  /** Matched qty — slippage parts only. */
  qty: number | null;
}

/** The strategy's cost ledger split by paid (money already gone) vs future
 * (still ahead). expectedPnlToMaturityUsd = spread return − paid.totalUsd −
 * future.borosSettlementUsd; the perp exit parts are folded in client-side,
 * each via its own checkbox. */
export interface StrategyFees {
  paid: {
    perpTradingUsd: number;
    /** Entry crossing cost (long entry − short entry) × qty; signed, negative
     * = favorable. Null unless exactly 1 long + 1 short perp leg. */
    perpEntrySlippageUsd: number | null;
    borosTradeUsd: number;
    /** Estimated accrual — settlement PnL is already net of these. */
    borosSettlementUsd: number;
    /** Null slippage counts as 0 here (a warning says so). */
    totalUsd: number;
  };
  future: {
    /** Maker+hedge exit (maker one leg + taker the other, cheaper assignment).
     * 0 = no perps; null = perps exist but the fee schedule is unknown. */
    perpExitFeesUsd: number | null;
    /** Assumed equal to paid.perpEntrySlippageUsd. */
    perpExitSlippageUsd: number | null;
    /** Already inside expectedPnlToMaturityUsd — display decomposition only. */
    borosSettlementUsd: number;
    /** Null propagates from the perp exit parts. */
    totalUsd: number | null;
  };
}

export type HedgeStatus = 'hedged' | 'partial' | 'unhedged';

/** What counts as the capital a Boros position ties up. `balance` apportions
 * the margin group's posted balance (over-states it when the collateral
 * account is shared with other trading); `im` counts only the initial margin
 * the legs consume — the same basis the perp side always uses. */
export type CapitalBasis = 'balance' | 'im';

/** How a strategy's share of each shared leg was arrived at — see
 * src/core/boros/partition.ts. `measured` means an execution record (the local
 * deal journal or the venue's own fills) proved the split; `unconfirmed` means
 * it was paired on price/open-time proximity and is a proposal to edit. */
export interface StrategyAttribution {
  source:
    | 'journal'
    | 'fill-history'
    | 'forced'
    | 'proximity'
    | 'user'
    | 'merged'
    | 'boros-only'
    /** Live perp size no position claimed — a position holding that one leg. */
    | 'unhedged';
  confidence: 'measured' | 'unconfirmed';
  pinned: boolean;
  /**
   * True when this card exists ONLY to report size no position claims —
   * detached by the user, or left over by the solver.
   *
   * ⚠ A SEPARATE QUESTION FROM `source`, which answers how a grouping was
   * arrived at. The two were conflated, and collided both ways: a solver
   * tranche on a coin with no Boros reports `source: 'unhedged'` (the chip
   * means "no rate is locked against this"), while the Boros remainder card
   * reports `'boros-only'` or `'merged'`. So "is this the card holding the
   * detached size" could not be read off `source` at all — Automatic deleted
   * a neighbour's detachment from the first, and did nothing on the second.
   */
  unclaimed?: boolean;
}

/** What anchors the realized-APR clock: earliest Boros leg (default), perp
 * fallback when the Boros open time is unknown, or a user-chosen date. */
export type ClockBasis = 'boros-open' | 'perp-open' | 'custom';

export interface StrategyRollup {
  /** Stable identity across re-solves: `BASE#VENUE-VENUE#openDay` when the
   * book was split, `BASE@maturity` when it was not. Pins, excluded entry
   * parts and React keys all hang off this. */
  strategyId: string;
  attribution: StrategyAttribution;
  base: string;
  /** Unix seconds. */
  maturity: number;
  legs: StrategyLeg[];
  hedge: HedgeStatus;
  /** Sizing gate for the headline numbers: all three ratios (matched/larger)
   * must clear their thresholds — Boros legs > 0.9, perp legs > 0.9,
   * Boros↔perp > 0.8 — before APR / capital / PnL-by-maturity are shown.
   * A position still being entered would otherwise show confidently wrong
   * numbers (a full-life spread projection on half the notional). */
  hedgeChecks: {
    borosMatchRatio: number;
    perpMatchRatio: number;
    borosVsPerpRatio: number;
    fullyHedged: boolean;
  };
  capitalUsd: number;
  /** capitalUsd's two components: perp initial margin on CrossEx + the Boros
   * margin apportioned to this strategy. Sums to capitalUsd by construction. */
  capitalSplit: { perpUsd: number; borosUsd: number };
  /** Σ leg nets − entry slippage (pair-level). Perp price MtM is excluded. */
  realizedPnlUsd: number;
  /** Annualized on capital; null = too early to annualize / unknowable. */
  realizedApr: number | null;
  /** Locked fixed spread across the Boros legs (≈ rate_A − rate_B). */
  spread: number;
  lockedAprOnCapital: number;
  spreadReturnUsd: number | null;
  /** spreadReturnUsd − paid costs − future Boros settle fees. Perp exit parts
   * NOT included — each checkbox folds its own in client-side. Null exactly
   * when spreadReturnUsd is null. */
  expectedPnlToMaturityUsd: number | null;
  elapsedSeconds: number | null;
  clockBasis: ClockBasis | null;
  /** The clock's start instant — the date the spread-lock assumption runs from. */
  clockStartSec: number | null;
  secondsToMaturity: number;
  notionalMismatchUsd: number;
  feesUsd: StrategyFees;
  /** The PAID perp entry cost, itemised so a user can drop the executions that
   * belong to an earlier strategy. Sums to paid.perpTradingUsd +
   * (paid.perpEntrySlippageUsd ?? 0). */
  perpEntryCostParts: PerpEntryCostPart[];
  warnings: string[];
}

export interface StrategyReturns {
  address: string;
  /** null when Gate isn't configured — Boros-only view. */
  perpSource: 'connected-gate-account' | null;
  strategies: StrategyRollup[];
  /**
   * Every Boros market the venue reports a live position on — counted from the
   * account's own zones, so no downstream filtering can shorten it.
   *
   * ⚠ NOT the same as the markets appearing on `strategies`. A collateral zone
   * that cannot be priced in USD is excluded from every card (with a warning)
   * while its positions stay open, so a market can be live here and absent
   * there. The client prunes membership rows against THIS, never against the
   * cards: reading "no card holds it" as "the position closed" deleted pins
   * the user cannot get back.
   */
  liveBorosMarketIds: number[];
  totals: {
    capitalUsd: number;
    realizedPnlUsd: number;
    realizedApr: number | null;
    /** Σ non-null strategy projections. */
    expectedPnlToMaturityUsd: number;
    /** Σ paid fees only. */
    feesTotalUsd: number;
    /** Σ future.perpExitFeesUsd; null if any strategy's schedule is unknown. */
    perpExitFeesTotalUsd: number | null;
    /** Σ future.perpExitSlippageUsd; null if any strategy's is unknown. */
    perpExitSlippageTotalUsd: number | null;
    /** How many strategies could not measure their crossing cost — lets the
     * strip say "unknown for 2 of 5" instead of blanking with no reason. */
    slippageUnknownCount: number;
    strategyCount: number;
  };
  /** Which reading of "capital" produced every capital-derived number here. */
  capitalBasis: CapitalBasis;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// GET /api/opportunities?notionalUsd&borosEntry&entryMode&exitMode — mirror of
// src/core/boros/opportunities.ts. Every APR field is a decimal FRACTION (0.09
// = 9%), like StrategyReturns; every *Usd cost is a POSITIVE number. Nullable
// fields mean "not knowable at this size / with this data" — render "—".
// ---------------------------------------------------------------------------

/** How the Boros entry rate is established: taker VWAP of both books at the
 * chosen size, or each market's mark APR (assumes patient limit entry). */
export type BorosEntryMode = 'mark' | 'market';

/** How the two perp legs are executed: both crossing, or one resting maker
 * order hedged by a taker fill on the other venue. */
export type EntryMode = 'both-market' | 'maker-hedge';

/** Whether the perps are closed at maturity or rolled into the next cohort. */
export type ExitMode = 'close' | 'roll';

/** Whether a live strategy is charged the perp entry cost it paid, or not —
 * a perp rolled into this maturity paid its fees and crossed its spread in a
 * previous life. Client-side display only; the server never sees it. */
export type EntryCostMode = 'include' | 'omit';

/** Why a market's exec APRs are what they are — drives the per-row badge. */
export type BookStatus = 'ok' | 'insufficient-depth' | 'unavailable' | 'not-fetched';

/** One member of an arb group, whether or not it can carry a perp leg. */
export interface OpportunityMarketRow {
  marketId: number;
  name: string;
  /** Boros platformName, verbatim. */
  venue: string;
  /** Mapped CrossEx exchange; null when the venue has no CrossEx perp. */
  crossexVenue: string | null;
  /** Live CrossEx symbol for (crossexVenue, base); null when none is listed. */
  crossexSymbol: string | null;
  base: string;
  midApr: number;
  markApr: number;
  floatingApr: number;
  /** Open interest in USD; null when the collateral can't be priced. */
  oiUsd: number | null;
  /** Rate achievable going SHORT fixed here (hitting bids) at the chosen size. */
  execShortApr: number | null;
  /** Rate achievable going LONG fixed here (lifting asks) at the chosen size. */
  execLongApr: number | null;
  bookStatus: BookStatus;
}

/** The pair's cost ledger. The four perp components are null when unknowable;
 * the two Boros components are always computable from the market config. */
export interface OpportunityCostBreakdown {
  /** (takerFeeRateA + takerFeeRateB) × N × T — charged on notional × duration. */
  borosTakerFeeUsd: number;
  /** (settleFeeAprA + settleFeeAprB) × N × T, accrued to maturity. */
  borosSettleFeeUsd: number;
  perpEntryFeesUsd: number | null;
  perpEntrySlippageUsd: number | null;
  /** 0 under `roll` — nothing is closed. */
  perpExitFeesUsd: number | null;
  perpExitSlippageUsd: number | null;
  totalUsd: number | null;
  /** totalUsd / (N × T) — the cost expressed as an APR drag. */
  annualizedApr: number | null;
}

/** The MODELLED minimum capital a pair consumes, leg by leg: Boros initial
 * margin from the kIM formula plus perp initial margin at each venue's max
 * leverage. Each component is null when an input it needs is missing, and any
 * null nulls the pair's `capitalUsd`. */
export interface OpportunityCapitalBreakdown {
  borosShortImUsd: number | null;
  borosLongImUsd: number | null;
  perpShortImUsd: number | null;
  perpLongImUsd: number | null;
  /** Max leverage used to size the perp leg's margin; null when unknown. */
  shortLeverageMax: number | null;
  longLeverageMax: number | null;
}

export interface OpportunityLeg {
  marketId: number;
  /** Boros platformName. */
  venue: string;
  crossexVenue: string;
  crossexSymbol: string;
  base: string;
  midApr: number;
  /** The rate this leg actually locks (receive-fixed on the short, pay-fixed on
   * the long); null when the book can't support the size. */
  execApr: number | null;
}

export interface OpportunityPair {
  /** The legs' shared asset symbol, or the group underlying when they differ
   * (fungible groups like GOLD collapse XAU and GOLD markets). */
  base: string;
  /** Market A: Boros SHORT fixed + perp SHORT. */
  shortLeg: OpportunityLeg;
  /** Market B: Boros LONG fixed + perp LONG. */
  longLeg: OpportunityLeg;
  /** midApr_A − midApr_B — the headline spread, before any execution cost. */
  grossSpreadApr: number;
  /** execApr_A − execApr_B — what the size actually locks. */
  execSpreadApr: number | null;
  /** grossSpreadApr − execSpreadApr: the Boros books' price impact. */
  borosImpactApr: number | null;
  /** Which leg rests as the maker order under `maker-hedge`; null otherwise. */
  makerLeg: 'short' | 'long' | null;
  costs: OpportunityCostBreakdown;
  capital: OpportunityCapitalBreakdown;
  /** Σ of the four capital components; null when any one of them is. */
  capitalUsd: number | null;
  /** Net fixed return annualized on the per-leg NOTIONAL — the secondary rate. */
  netFixedApr: number | null;
  /** The headline: the locked net fixed return over the capital consumed —
   * the same basis as StrategyRollup.lockedAprOnCapital, so an opportunity is
   * directly comparable to an open position. */
  netFixedAprOnCapital: number | null;
  /** notionalUsd / capitalUsd — the ratio between the two net APRs. */
  effectiveLeverage: number | null;
  estProfitUsd: number | null;
  secondsToMaturity: number;
  /** Plain-language sentences: every null above, plus standing caveats. */
  reasons: string[];
}

export interface OpportunityGroup {
  tokenId: number;
  /** Collateral token symbol, e.g. "USDT". */
  collateral: string;
  /** USD price of the collateral token (1 for USDT); null = unpriceable. */
  collateralPriceUsd: number | null;
  /** Unix seconds. */
  maturity: number;
  secondsToMaturity: number;
  underlying: string;
  markets: OpportunityMarketRow[];
  pairs: OpportunityPair[];
  /** pairs[0] when its netFixedAprOnCapital is known; null otherwise. */
  bestPair: OpportunityPair | null;
  warnings: string[];
}

/** Groups arrive pre-ranked, and so do the `pairs` within each — on net fixed
 * APR on capital, then netFixedApr, execSpreadApr, grossSpreadApr. A view that
 * flattens the groups has to REPRODUCE that comparator (see
 * `panels/opportunityFilters.ts`), not just its first key: the flat array is
 * group-major, so sort stability alone would break a cross-group tie by group
 * rank and float a strictly worse pair to the top. */
export interface OpportunitiesResult {
  groups: OpportunityGroup[];
  meta: {
    asOfSec: number;
    notionalUsd: number;
    borosEntry: BorosEntryMode;
    entryMode: EntryMode;
    exitMode: ExitMode;
  };
  warnings: string[];
}

// ---------------------------------------------------------------------------
// GET /api/fees
// ---------------------------------------------------------------------------

export interface SpecialFee {
  symbol: string;
  makerFeeRate: string;
  takerFeeRate: string;
}

/** Rates are fractions: 0.0002 = 2 bps. Negative maker = rebate (render green). */
export interface VenueFees {
  exchangeType: string;
  spotMakerFee: string;
  spotTakerFee: string;
  futureMakerFee: string;
  futureTakerFee: string;
  specialFeeList: SpecialFee[];
}

// ---------------------------------------------------------------------------
// GET /api/orders/open?symbol  ·  DELETE /api/orders/:id
// ---------------------------------------------------------------------------

export interface OpenOrder {
  orderId: string;
  text: string;
  /** Gate's literal state string — the enum is undocumented; render unknown values verbatim. */
  state: string;
  symbol: string;
  side: string;
  type: string;
  timeInForce: string;
  qty: string;
  price: string;
  executedQty: string;
  executedAvgPrice: string;
  reduceOnly: boolean;
  /** Epoch seconds OR milliseconds — use toDate(). */
  createTime: number | string;
}

// ---------------------------------------------------------------------------
// GET /api/trades?limit&page&join=1
// ---------------------------------------------------------------------------

export interface Trade {
  transactionId: string;
  orderId: string;
  symbol: string;
  exchangeType: string;
  side: string;
  qty: string;
  price: string;
  fee: string;
  feeCoin: string;
  /** Fraction: 0.0002 = 2 bps. */
  feeRate: string;
  matchRole: 'maker' | 'taker';
  rpnl: string;
  /** Epoch seconds OR milliseconds — use toDate(). */
  createTime: number | string;
  /** Present when join=1 matched the order. */
  orderType?: string;
  orderTif?: string;
}

export interface TradesResponse {
  trades: Trade[];
  page: number;
  limit: number;
  hasMore: boolean;
}

// ---------------------------------------------------------------------------
// GET /api/symbols?q=
// ---------------------------------------------------------------------------

export interface SymbolRule {
  symbol: string;
  exchange: string;
  base: string;
  quote: string;
  tickSize: string;
  lotSize: string;
  minSize: string;
  /** Live-API truth: null on symbols with no minimum notional. */
  minNotional: string | null;
  maxMarketSize: string | null;
  maxLimitSize: string | null;
  /** Serialized by the backend's SymbolInfo; optional here for fixture brevity. */
  contractSize?: string | null;
  state: string;
}

/** GET /api/symbols/:symbol — the rule plus the max settable leverage. */
export interface SymbolDetail extends SymbolRule {
  leverageMax: number;
}

/** GET/PUT /api/leverage/:symbol. */
export interface LeverageInfo {
  symbol: string;
  leverage: number;
  leverageMax?: number;
}

// ---------------------------------------------------------------------------
// Trading contract — copied faithfully from src/core/actions.ts (the trading UI
// will need these next). `rule` uses our SymbolRule mirror instead of gate-api's
// RuleSymbol (same fields the backend serializes for /api/symbols).
// ---------------------------------------------------------------------------

export type Side = 'BUY' | 'SELL';

/** Maker-hedge pair roles: the maker leg rests post-only; the engine auto-fires
 * market orders on the hedge leg as the maker fills. */
export type PairRole = 'maker' | 'hedge';

export interface OpenMarketAction {
  kind: 'open-market';
  symbol: string;
  side: Side;
  /** Resolved base qty string — REQUIRED at execute time (never re-sized server-side). */
  qty?: string;
  /** Preview-only sizing; a violation at execute time. */
  notional?: string;
  leverage?: number;
  reduceOnly?: boolean;
  /** Links delta-neutral legs (open/open or close/close) for the unhedged guard. */
  pairGroupId?: string;
  /** Maker-hedge mode: this leg must be 'hedge'. */
  pairRole?: PairRole;
}

export interface OpenLimitAction {
  kind: 'open-limit';
  symbol: string;
  side: Side;
  qty?: string;
  notional?: string;
  /** Limit price; tick-snapped (and HL 5-sig-fig-capped) during resolution. */
  price: string;
  tif?: 'GTC' | 'IOC' | 'FOK' | 'POC';
  leverage?: number;
  reduceOnly?: boolean;
  pairGroupId?: string;
  /** Maker-hedge mode: this leg must be 'maker' (tif is forced to POC). */
  pairRole?: PairRole;
  /** Maker-hedge: unfilled remainder converts to taker after this many seconds. */
  makerTimeoutSec?: number;
  /** Maker-hedge maker leg only: re-peg the INITIAL submit price to the fresh
   * same-side touch at t=submit (`price` is the fallback reference). */
  pegToTouch?: boolean;
}

export interface ClosePositionAction {
  kind: 'close-position';
  symbol: string;
  /** Partial close qty; default = full position (re-derived from the live position). */
  qty?: string;
  /** Marketable-limit protection band, percent. Default 0.5, bounded (0, 10]. */
  slippagePct?: number;
  pairGroupId?: string;
}

export type ActionInput = OpenMarketAction | OpenLimitAction | ClosePositionAction;

export interface FillEstimate {
  qty: string;
  avgPrice: number;
  worstPrice: number;
  midPrice?: number;
  /** avg vs mid (or reference when no book), percent, signed against the taker. */
  slippagePct: number;
  source: 'venue-orderbook' | 'gate-orderbook' | 'reference+spread' | 'mark';
  confidence: 'high' | 'medium' | 'low';
  venue: string;
  /** Book was thinner than qty — the tail is extrapolated at the last level. */
  partialDepth?: boolean;
}

export interface FeeEstimate {
  makerRate: number;
  takerRate: number;
  specialOverride: boolean;
  /** Fee currency = the symbol's quote (USDT / USD / USDC — never assume USDT). */
  quote: string;
  /** MARKET/IOC ⇒ taker only; POC ⇒ maker only; resting-capable LIMIT ⇒ both (a range). */
  est: { taker?: number; maker?: number };
}

export interface Violation {
  code:
    | 'symbol-not-found'
    | 'symbol-not-live'
    | 'not-a-perp'
    | 'qty-missing'
    | 'qty-invalid'
    | 'notional-at-execute'
    | 'sizing-failed'
    | 'below-min-size'
    | 'below-min-notional'
    | 'lot-incompatible'
    | 'exceeds-max-market-size'
    | 'exceeds-max-limit-size'
    | 'price-missing'
    | 'price-invalid'
    | 'leverage-exceeds-max'
    | 'slippage-invalid'
    | 'ref-price-unavailable'
    | 'no-position'
    | 'qty-exceeds-position'
    | 'pair-legs-invalid'
    | 'pair-side-conflict'
    | 'pair-base-mismatch'
    | 'pair-qty-mismatch'
    | 'pair-type-restricted'
    | 'pair-role-invalid'
    | 'pair-mode-mixed-actions';
  message: string;
}

export interface ResolvedAction {
  index: number;
  input: ActionInput;
  symbol: string;
  side: Side;
  type: 'MARKET' | 'LIMIT';
  tif: 'GTC' | 'IOC' | 'FOK' | 'POC';
  reduceOnly: boolean;
  /** Final lot-floored base qty ('' when unresolvable — a violation explains why). */
  qty: string;
  price?: string;
  estNotional: number;
  refPrice?: { value: number; source: string };
  leverage?: { requested: number; max: number };
  rule?: SymbolRule;
  /** Present on close actions: what the close was derived from. */
  closing?: { positionQty: string; upnl: string; mark: number };
  violations: Violation[];
  warnings: string[];
}

/** Touch prices for a resting (POC) leg — used to price the maker order. */
export interface RestEstimate {
  bestBid: number;
  bestAsk: number;
  mid: number;
}

export interface PreviewResult extends ResolvedAction {
  fillEstimate?: FillEstimate;
  fees?: FeeEstimate;
  restEstimate?: RestEstimate;
}

/** POST /api/preview response body. */
export interface PreviewResponse {
  previews: PreviewResult[];
}

/** POST /api/deals response (202; duplicate = idempotent replay). */
export interface DealResponse {
  id: string;
  duplicate?: boolean;
}

// ---------------------------------------------------------------------------
// Deals — mirrors src/engine/types.ts (the engine's wire shapes)
// ---------------------------------------------------------------------------

export type DealMode = 'OPENING' | 'CONVERTING' | 'STOPPING' | 'HALTED' | 'DONE';
export type DealOrderState = 'PENDING' | 'OPEN' | 'CLOSED' | 'DEAD';

export interface DealLegSpec {
  contract: string;
  side: Side;
  lot: string;
  minSize: string;
  minNotional: string;
  tick: string;
  reduceOnly?: boolean;
}

export interface DealPair {
  id: string;
  mode: DealMode;
  a: DealLegSpec;
  b: DealLegSpec | null;
  targetQty: string;
  limitPrice: string | null;
  pricePolicy: 'fixed' | 'touch';
  deadlineAt: number | null;
  makerNotBefore: number;
  hedgeNotBefore: number;
  pocRejects: number;
  hedgeRejectStreak: number;
  maxClip: string | null;
  clipBandBp: number | null;
  haltReason: string | null;
  reportJson: string | null;
  createdAt: number;
}

export interface DealOrder {
  pairId: string;
  leg: 'A' | 'B';
  seq: number;
  clientId: string;
  kind: 'maker' | 'taker';
  side: Side;
  qty: string;
  price: string | null;
  tif: 'poc' | 'ioc';
  state: DealOrderState;
  venueOrderId: string | null;
  cumQty: string;
  closeReason: string | null;
  cancelRequested: 0 | 1;
  quarantinedStatus: string | null;
  /** The venue's own explanation for the last status it reported. */
  venueReason: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

export interface DealProjection {
  aFilled: string;
  aReserved: string;
  bFilled: string;
  bReserved: string;
  unhedged: string;
  residualA: string;
  makerOrder: DealOrder | null;
  anyPending: boolean;
  anyQuarantined: boolean;
  allSettled: boolean;
}

/** GET /api/deals/:id */
export interface DealView {
  pair: DealPair;
  orders: DealOrder[];
  projection: DealProjection;
}

export interface DealReport {
  aFilled: string;
  bFilled: string;
  unhedged: string;
  reason: string;
  /** Quantity-weighted average fill price per leg. Leg A = maker (limit) leg,
   * leg B = taker (hedge) leg. Null when the leg took no fills. */
  aAvgFill?: string | null;
  bAvgFill?: string | null;
}

export interface DealAlert {
  id: number;
  ts: number;
  level: 'info' | 'warn' | 'error';
  pairId: string | null;
  message: string;
  ack: 0 | 1;
}

/** POST /api/deals request (mirrors src/engine/create.ts DealRequest). */
export interface DealRequest {
  id: string;
  a: { symbol: string; side: Side; reduceOnly?: boolean };
  b?: { symbol: string; side: Side; reduceOnly?: boolean } | null;
  qty: string;
  execution: 'maker' | 'taker';
  price?: string;
  pricePolicy?: 'fixed' | 'touch';
  timeoutSec?: number;
  maxClip?: string;
  clipBandPct?: number;
  leverage?: { a?: number; b?: number };
}

/** GET /api/books/:symbol — the venue's live touch (re-peg decision data). */
export interface BookTouch {
  symbol: string;
  bestBid: number;
  bestAsk: number;
  mid: number;
}

// ---------------------------------------------------------------------------
// Boros two-leg market entry (mirrors src/core/boros/pair.ts + orders.ts)
// ---------------------------------------------------------------------------

/** 'short' RECEIVES fixed (hits bids); 'long' PAYS fixed (lifts asks). */
export type BorosLegDirection = 'long' | 'short';
export type BorosPairIntent = 'open' | 'close';

export interface BorosPairMarketRow {
  marketId: number;
  name: string;
  venue: string;
  base: string;
  tokenId: number;
  /** Symbol of the collateral token — the unit a size on this market is in.
   * Empty when the token is one this build has no symbol for. */
  collateral: string;
  maturity: number;
  midApr: number;
  markApr: number;
  /** The venue's cap on how far one trade may move the rate, as an APR
   * fraction (config.maxRateDeviationFactorBase1e4 / 1e4 × markApr). Half of
   * it is the default close tolerance; wider than it can never fill. */
  maxRateDeviationApr: number;
  isolatedOnly: boolean;
  onIsolatedMargin: boolean;
  isolatedHasPositionOrOrders: boolean;
  /** Signed netted position on this market, collateral units (+ long fixed). */
  currentSize: number;
  collateralPriceUsd: number | null;
}

/** GET /api/boros/pair/context */
export interface BorosPairContext {
  markets: BorosPairMarketRow[];
  crossByToken: Array<{ tokenId: number; available: number }>;
  isolatedByMarket: Array<{ marketId: number; available: number }>;
  defaultSlippageApr: number;
  maxSlippageApr: number;
}

export interface BorosLegSizing {
  currentSize: number;
  deltaSize: number;
  resultingSize: number;
  opposing: boolean;
  flips: boolean;
  clampedToClose: boolean;
}

export type BorosBookStatus = 'ok' | 'insufficient-depth' | 'unavailable' | 'not-fetched';

export interface BorosSimulatedLeg {
  marketId: number;
  marketName: string;
  venue: string;
  base: string;
  direction: BorosLegDirection;
  execApr: number | null;
  worstApr: number | null;
  estFillSize: number;
  shortfallSize: number;
  bookStatus: BorosBookStatus;
  marginRequired: number | null;
  slippageApr: number;
  sizing: BorosLegSizing;
}

export interface BorosPairSimulation {
  legA: BorosSimulatedLeg;
  legB: BorosSimulatedLeg;
  receiveLeg: 'A' | 'B' | null;
  /** NET of fees. There is no gross counterpart — by design. */
  estSpreadApr: number | null;
  worstSpreadApr: number | null;
  costToCrossSize: number;
  feeDragApr: number;
  marginRequiredTotal: number | null;
  hedgedSize: number;
  unhedgedSize: number;
  collateral: string;
  collateralPriceUsd: number | null;
  secondsToMaturity: number;
  reasons: string[];
}

export interface BorosPairBlocker {
  code: string;
  message: string;
  leg?: 'A' | 'B';
  marketId?: number;
  /** Collateral units still needed — the shortfall, never the total. */
  shortfall?: number;
}

export interface BorosPairGate {
  blockers: BorosPairBlocker[];
  warnings: string[];
  requiresAcknowledgement: boolean;
  opposingLegs: Array<'A' | 'B'>;
}

export interface BorosPairEligibility {
  eligible: boolean;
  code: string | null;
  reason: string | null;
}

/** POST /api/boros/pair/simulate */
export interface BorosPairSimulateResponse {
  simulation: BorosPairSimulation;
  gate: BorosPairGate;
  eligibility: BorosPairEligibility;
  simulatedAtMs: number;
  /** Prepaid relayer gas in USD — a DIFFERENT pot from trading collateral.
   * null when the install cannot read it. */
  gasBalanceUsd: number | null;
}

export type BorosLegFailureCode =
  | 'insufficient-depth'
  | 'rate-deviation'
  | 'insufficient-margin'
  | 'no-gas'
  | 'rejected'
  | 'unknown';

export interface TopUpGasResponse {
  sentUsd: number;
}

export interface RunUpdateResponse {
  started: true;
  logPath: string;
}

export interface BorosLegFill {
  marketId: number;
  direction: BorosLegDirection;
  filledSize: number;
  shortfallSize: number;
  execApr: number | null;
  feeSize: number | null;
  failure: { code: BorosLegFailureCode; message: string } | null;
}

/**
 * POST /boros/pair/market/:id/cancel-and-close.
 *
 * ⚠ A 200 here does NOT mean the position closed. The route answers 200 for
 * "cancelled, but there was nothing to close" (`fill: null`) and for a close
 * that filled SHORT or failed at the venue (`fill.failure`). Callers must read
 * `closed` and `fill` — treating the HTTP status as the outcome reports a
 * success the user can then watch not happen.
 */
export interface BorosCancelAndCloseResult {
  marketId: number;
  cancelled: boolean;
  /** True only when the position is FLAT afterwards. */
  closed: boolean;
  fill: BorosLegFill | null;
  slippageApr?: number;
  /** What was open when the close was sized. */
  openSize?: number;
}

export interface BorosPairResult {
  legA: BorosLegFill;
  legB: BorosLegFill;
  /** False when only one leg was submitted (a completion). */
  bothLegsSubmitted: boolean;
  hedgedSize: number;
  unhedgedSize: number;
  unhedgedLeg: 'A' | 'B' | null;
  realisedSpreadApr: number | null;
  partial: boolean;
}

/** POST /api/boros/pair/execute */
export interface BorosPairExecuteResponse {
  result: BorosPairResult;
  estimate: BorosPairSimulation;
  warnings: string[];
  /** True when this response replays an earlier submission with the same order
   * ids rather than a fresh trade. */
  replayed?: boolean;
}

/** Request body shared by simulate and execute. */
export interface BorosPairRequest {
  address: string;
  /** Trade one leg only (a completion); the other is sized to zero. */
  onlyLeg?: 'A' | 'B';
  legA: { marketId: number; direction: BorosLegDirection; slippageApr: number };
  legB: { marketId: number; direction: BorosLegDirection; slippageApr: number };
  size: number;
  intent: BorosPairIntent;
  opposingAcknowledged?: boolean;
  clientOrderIdA?: string;
  clientOrderIdB?: string;
}

/** GET /api/boros/agent — the delegated trading key's status. Never carries the
 * key itself, under any field name. */
export interface BorosAgentStatus {
  configured: boolean;
  root: string | null;
  rootMasked: string | null;
  accountId: number | null;
  /** Unix seconds the on-chain approval lapses; null when unknown. Past this,
   * every order fails with AuthAgentExpired(). */
  expiry: number | null;
  expired: boolean;
  /** False on an install with no agent service (e.g. public mode). */
  canProvision: boolean;
}

/** PUT /api/boros/agent — a browser-generated agent key, already approved
 * on-chain by the connected root wallet. */
export interface BorosAgentInput {
  root: string;
  accountId: number;
  agentPrivateKey: string;
  /** Absolute unix seconds the approval was signed until. */
  expiry?: number;
}
