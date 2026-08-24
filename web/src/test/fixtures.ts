/** Shared trading-test fixtures: rule/preview/account builders + msw handlers. */
import { http, HttpResponse } from 'msw';
import type {
  ActionInput,
  DealOrder,
  DealPair,
  DealProjection,
  DealView,
  CrossexAccount,
  CrossexPosition,
  ExposureGroup,
  OpportunitiesResult,
  OpportunityGroup,
  OpportunityLeg,
  OpportunityMarketRow,
  OpportunityPair,
  PositionsResponse,
  PreviewResponse,
  PreviewResult,
  StrategyLeg,
  StrategyReturns,
  StrategyRollup,
  SymbolRule,
  UpdateStatus,
  PerpEntryCostPart,
} from '../api/types';
import type { SharePayloadV1 } from '../lib/shareCodec';
import { env } from './server';

// Re-exported so the imports above stay live for the upcoming opportunity
// fixtures (keeps `tsc --noEmit` green while they land).
export type {
  OpportunitiesResult,
  OpportunityGroup,
  OpportunityLeg,
  OpportunityMarketRow,
  OpportunityPair,
};

export const BTC_BINANCE: SymbolRule = {
  symbol: 'BINANCE_FUTURE_BTC_USDT',
  exchange: 'BINANCE',
  base: 'BTC',
  quote: 'USDT',
  tickSize: '0.1',
  lotSize: '0.001',
  minSize: '0.001',
  minNotional: '10',
  maxMarketSize: '100',
  maxLimitSize: '500',
  state: 'live',
};

export const BTC_HYPERLIQUID: SymbolRule = {
  ...BTC_BINANCE,
  symbol: 'HYPERLIQUID_FUTURE_BTC_USDC',
  exchange: 'HYPERLIQUID',
  quote: 'USDC',
  lotSize: '0.01',
};

export const ETH_GATE: SymbolRule = {
  symbol: 'GATE_FUTURE_ETH_USDT',
  exchange: 'GATE',
  base: 'ETH',
  quote: 'USDT',
  tickSize: '0.01',
  lotSize: '0.01',
  minSize: '0.01',
  minNotional: '5',
  maxMarketSize: '10000',
  maxLimitSize: '50000',
  state: 'live',
};

export const account: CrossexAccount = {
  marginBalance: '5000',
  availableMargin: '4200',
  initialMargin: '800',
  maintenanceMargin: '80',
  initialMarginRate: '0.16',
  maintenanceMarginRate: '0.016',
  accountMode: 'CROSS',
  positionMode: 'ONE_WAY',
  assets: [],
};

export const ethPosition: CrossexPosition = {
  symbol: 'GATE_FUTURE_ETH_USDT',
  positionSide: 'LONG',
  positionQty: '0.3',
  positionValue: '750',
  entryPrice: '2500',
  markPrice: '2510',
  leverage: '5',
  maxLeverage: '50',
  upnl: '3',
  upnlRate: '0.004',
  fundingFee: '0',
  fee: '-0.3',
  initialMargin: '150',
  maintenanceMargin: '10',
};

/** A clean resolved preview for one action (customize via overrides). */
export function previewFor(input: ActionInput, overrides: Partial<PreviewResult> = {}): PreviewResult {
  const isClose = input.kind === 'close-position';
  return {
    index: 0,
    input,
    symbol: input.symbol,
    side: isClose ? 'SELL' : input.side,
    type: input.kind === 'open-limit' || isClose ? 'LIMIT' : 'MARKET',
    tif: input.kind === 'open-limit' ? (input.tif ?? 'GTC') : 'IOC',
    reduceOnly: isClose,
    qty: '0.05',
    ...(input.kind === 'open-limit' ? { price: input.price } : isClose ? { price: '2487.5' } : {}),
    estNotional: 125,
    refPrice: { value: 2500, source: 'mark' },
    violations: [],
    warnings: [],
    ...overrides,
  };
}

/** A deal view (pair + orders + projection) — tests spell only the fields under test. */
export function makeDealView(overrides?: {
  pair?: Partial<DealPair>;
  orders?: DealOrder[];
  projection?: Partial<DealProjection>;
}): DealView {
  const pair: DealPair = {
    id: 'd1',
    mode: 'OPENING',
    a: { contract: 'GATE_FUTURE_ETH_USDT', side: 'BUY', lot: '0.001', minSize: '0', minNotional: '0', tick: '0.01' },
    b: { contract: 'BINANCE_FUTURE_ETH_USDT', side: 'SELL', lot: '0.001', minSize: '0', minNotional: '0', tick: '0.01' },
    targetQty: '0.05',
    limitPrice: '2500',
    pricePolicy: 'fixed',
    deadlineAt: null,
    makerNotBefore: 0,
    hedgeNotBefore: 0,
    pocRejects: 0,
    hedgeRejectStreak: 0,
    maxClip: null,
    clipBandBp: null,
    haltReason: null,
    reportJson: null,
    createdAt: 1_751_500_000_000,
    ...overrides?.pair,
  };
  return {
    pair,
    orders: overrides?.orders ?? [],
    projection: {
      aFilled: '0',
      aReserved: '0',
      bFilled: '0',
      bReserved: '0',
      unhedged: '0',
      residualA: pair.targetQty,
      makerOrder: null,
      anyPending: false,
      anyQuarantined: false,
      allSettled: true,
      ...overrides?.projection,
    },
  };
}

/** GET /api/symbols (the whole rules list) + GET /api/symbols/:symbol (rule + leverage cap). */
export function symbolHandlers(rules: SymbolRule[], leverageMax: Record<string, number> = {}) {
  return [
    http.get('/api/symbols', () => HttpResponse.json(env(rules))),
    http.get('/api/symbols/:symbol', ({ params }) => {
      const rule = rules.find((r) => r.symbol === String(params.symbol)) ?? rules[0];
      return HttpResponse.json(env({ ...rule, leverageMax: leverageMax[rule.symbol] ?? 50 }));
    }),
  ];
}

/**
 * POST /api/preview that echoes each posted action back as a clean preview (by
 * index). `calls` collects every request's actions; `overrides` is applied to
 * every preview; `once` makes it single-use (msw falls through afterwards).
 */
export function echoPreviewHandler(
  opts: { calls?: ActionInput[][]; overrides?: Partial<PreviewResult>; once?: boolean } = {},
) {
  return http.post(
    '/api/preview',
    async ({ request }) => {
      const { actions } = (await request.json()) as { actions: ActionInput[] };
      opts.calls?.push(actions);
      return HttpResponse.json(
        env<PreviewResponse>({
          previews: actions.map((a, i) => previewFor(a, { index: i, ...opts.overrides })),
        }),
      );
    },
    opts.once ? { once: true } : undefined,
  );
}

/** Up-to-date /api/version by default — no update pill. Override per-test with
 * server.use(versionHandler({ latest: '9.9.9', updateAvailable: true, ... })). */
export function versionHandler(over: Partial<UpdateStatus> = {}) {
  return http.get('/api/version', () =>
    HttpResponse.json(
      env<UpdateStatus>({
        current: '1.0.0',
        install: null,
        latest: '1.0.0',
        updateAvailable: false,
        highlights: [],
        ...over,
      }),
    ),
  );
}

/** Standard monitoring handlers most trading tests need in the background. */
export function baseHandlers() {
  return [
    http.get('/api/account', () => HttpResponse.json(env(account))),
    versionHandler(),
    http.get('/api/positions', () =>
      HttpResponse.json(env<PositionsResponse>({ positions: [], exposure: [] })),
    ),
    http.get('/api/deals/:id', ({ params }) =>
      HttpResponse.json(env(makeDealView({ pair: { id: String(params.id) } }))),
    ),
    http.get('/api/deals', () => HttpResponse.json(env([]))),
    http.get('/api/alerts', () => HttpResponse.json(env([]))),
    // Default: disclaimer already accepted, so the gate stays out of the way.
    // Tests that exercise the gate override this with accepted:false.
    http.get('/api/disclaimer', () =>
      HttpResponse.json(env({ version: '1', accepted: true, acceptedVersion: '1' })),
    ),
  ];
}

// ---------------------------------------------------------------------------
// Strategy (4-leg) fixtures — the canonical hedged HYPE book, matching the
// backend contract in src/core/boros/returns.ts.
// ---------------------------------------------------------------------------

export const STRATEGY_NOW = 1_752_000_000;
export const STRATEGY_OPENED = STRATEGY_NOW - 2 * 86_400;
export const STRATEGY_MATURITY = STRATEGY_NOW + 12 * 86_400;
export const STRATEGY_ADDRESS = '0x' + 'ab'.repeat(20);

export function makeStrategyLeg(overrides: Partial<StrategyLeg> = {}): StrategyLeg {
  return {
    kind: 'boros',
    venue: 'HYPERLIQUID',
    base: 'HYPE',
    side: 'SHORT',
    notionalUsd: 158_800,
    collateral: 'USDT',
    notionalToken: 158_800,
    entryApr: 0.0936,
    markApr: 0.0988,
    floatingApr: 0.1095,
    cashFlowUsd: -10.12,
    mtmUsd: -26.32,
    tradePnlUsd: -2.8,
    feesUsd: 2.8,
    netUsd: -39.24,
    openedAt: STRATEGY_OPENED,
    maturity: STRATEGY_MATURITY,
    warnings: [],
    ...overrides,
  };
}

/** The 4 legs of the canonical hedged HYPE book (2 perp + 2 Boros). */
function hypeLegs(): StrategyLeg[] {
  return [
    makeStrategyLeg({
      kind: 'perp',
      venue: 'BYBIT',
      side: 'LONG',
      notionalUsd: 160_316,
      collateral: undefined,
      notionalToken: 900, // perp legs carry their base-coin size
      entryApr: undefined,
      markApr: undefined,
      floatingApr: undefined,
      maturity: undefined,
      symbol: 'BYBIT_FUTURE_HYPE_USDT',
      cashFlowUsd: -13.63,
      mtmUsd: 1497.24, // display-only for perps — excluded from netUsd
      tradePnlUsd: 0,
      feesUsd: 20.55,
      netUsd: -13.63 - 20.55, // funding − fees
    }),
    makeStrategyLeg({
      kind: 'perp',
      venue: 'HYPERLIQUID',
      side: 'SHORT',
      notionalUsd: 160_316,
      collateral: undefined,
      notionalToken: 900, // perp legs carry their base-coin size
      entryApr: undefined,
      markApr: undefined,
      floatingApr: undefined,
      maturity: undefined,
      symbol: 'HYPERLIQUID_FUTURE_HYPE_USDC',
      cashFlowUsd: 61.41,
      mtmUsd: -1546.4, // display-only for perps — excluded from netUsd
      tradePnlUsd: 0,
      feesUsd: 44.46,
      netUsd: 61.41 - 44.46, // funding − fees
    }),
    makeStrategyLeg({
      venue: 'BYBIT',
      side: 'LONG',
      entryApr: 0.0229,
      markApr: 0.0212,
      floatingApr: -0.2131,
      cashFlowUsd: 0.21,
      mtmUsd: -8.52,
      tradePnlUsd: -0.97,
      feesUsd: 0.97,
      netUsd: -9.28,
    }),
    makeStrategyLeg({}), // HYPERLIQUID Boros SHORT (the defaults)
  ];
}

/** A book built across TWO executions (the case the tickable entry cost exists
 * for), plus one fee part per live leg. Sums to perpTradingUsd 65.00 +
 * perpEntrySlippageUsd 49.16 = 114.16 — the invariant the card depends on. */
function hypeEntryCostParts(): PerpEntryCostPart[] {
  return [
    {
      id: 'slip:deal:deal-a',
      kind: 'slippage',
      usd: 30.0,
      atSec: STRATEGY_OPENED - 3 * 86_400,
      venues: ['HYPERLIQUID', 'GATE'],
      side: null,
      qty: 900,
    },
    {
      id: 'slip:deal:deal-b',
      kind: 'slippage',
      usd: 19.16,
      atSec: STRATEGY_OPENED,
      venues: ['GATE', 'BYBIT'],
      side: null,
      qty: 900,
    },
    // Per LEG, not per execution — Gate reports a position's fee cumulatively.
    {
      id: 'fees:BYBIT_FUTURE_HYPE_USDT',
      kind: 'fees',
      usd: 20.55,
      atSec: null,
      venues: ['BYBIT'],
      side: 'LONG',
      qty: null,
    },
    {
      id: 'fees:HYPERLIQUID_FUTURE_HYPE_USDC',
      kind: 'fees',
      usd: 44.46,
      atSec: null,
      venues: ['HYPERLIQUID'],
      side: 'SHORT',
      qty: null,
    },
  ];
}

export function makeStrategyRollup(overrides: Partial<StrategyRollup> = {}): StrategyRollup {
  return {
    // A book that needed no splitting: one strategy per Boros cohort, every
    // perp leg owned outright — the shape most fixtures want.
    strategyId: `HYPE@${STRATEGY_MATURITY}`,
    attribution: { source: 'merged', confidence: 'measured', pinned: false },
    base: 'HYPE',
    maturity: STRATEGY_MATURITY,
    legs: hypeLegs(),
    hedge: 'hedged',
    hedgeChecks: { borosMatchRatio: 1, perpMatchRatio: 1, borosVsPerpRatio: 1, fullyHedged: true },
    capitalUsd: 41_320,
    capitalSplit: { perpUsd: 33_056, borosUsd: 8_264 }, // sums to capitalUsd
    // Σ leg nets (−34.18 + 16.95 − 9.28 − 39.24) − entry slippage 49.16.
    realizedPnlUsd: -114.91,
    realizedApr: -0.553,
    spread: 0.0707,
    lockedAprOnCapital: 0.2715,
    spreadReturnUsd: 411.81,
    // spread return − paid.totalUsd (119.53) − future Boros settle (10.06).
    expectedPnlToMaturityUsd: 411.81 - (65.01 + 49.16 + 3.77 + 1.6) - 10.06,
    elapsedSeconds: STRATEGY_NOW - STRATEGY_OPENED,
    clockBasis: 'boros-open',
    clockStartSec: STRATEGY_OPENED,
    secondsToMaturity: STRATEGY_MATURITY - STRATEGY_NOW,
    notionalMismatchUsd: 3032,
    perpEntryCostParts: hypeEntryCostParts(),
    feesUsd: {
      paid: {
        perpTradingUsd: 65.01, // === Σ perp leg feesUsd (20.55 + 44.46)
        perpEntrySlippageUsd: 49.16,
        borosTradeUsd: 3.77,
        borosSettlementUsd: 1.6,
        totalUsd: 65.01 + 49.16 + 3.77 + 1.6, // 119.54… kept exact by construction
      },
      future: {
        perpExitFeesUsd: 80,
        perpExitSlippageUsd: 49.16,
        borosSettlementUsd: 10.06,
        totalUsd: 80 + 49.16 + 10.06,
      },
    },
    warnings: [],
    ...overrides,
  };
}

export function makeStrategyReturns(overrides: Partial<StrategyReturns> = {}): StrategyReturns {
  const strategies = overrides.strategies ?? [makeStrategyRollup()];
  return {
    address: STRATEGY_ADDRESS,
    perpSource: 'connected-gate-account',
    strategies,
    // Venue truth, so it defaults to every Boros market the cards hold —
    // overridable to model a leg that is open but has no card (an unpriced
    // collateral zone), which is what the prune must not read as closed.
    liveBorosMarketIds: [
      ...new Set(
        strategies.flatMap((s) =>
          s.legs.flatMap((l) => (l.kind === 'boros' && l.marketId !== undefined ? [l.marketId] : [])),
        ),
      ),
    ],
    totals: {
      capitalUsd: strategies.reduce((s, x) => s + x.capitalUsd, 0),
      realizedPnlUsd: strategies.reduce((s, x) => s + x.realizedPnlUsd, 0),
      realizedApr: null,
      expectedPnlToMaturityUsd: strategies.reduce(
        (s, x) => s + (x.expectedPnlToMaturityUsd ?? 0),
        0,
      ),
      feesTotalUsd: strategies.reduce((s, x) => s + x.feesUsd.paid.totalUsd, 0),
      perpExitFeesTotalUsd: strategies.reduce((s, x) => s + (x.feesUsd.future.perpExitFeesUsd ?? 0), 0),
      perpExitSlippageTotalUsd: strategies.reduce(
        (s, x) => s + (x.feesUsd.future.perpExitSlippageUsd ?? 0),
        0,
      ),
      slippageUnknownCount: strategies.filter(
        (x) => x.feesUsd.future.perpExitSlippageUsd === null,
      ).length,
      strategyCount: strategies.length,
    },
    capitalBasis: 'balance',
    warnings: [],
    ...overrides,
  };
}

/** The canonical hedged HYPE book as a SHARE PAYLOAD — the wire form of the
 * rollup above (17.81% on $41,320, 12 days to maturity, 4 legs). One factory so
 * a schema change edits one literal instead of every position-page suite.
 * The codec suite keeps its own literals on purpose: that fixture is the
 * cross-REPO drift pin against the decoder in arbitrage-landing. */
export function makeSharePayload(overrides: Partial<SharePayloadV1> = {}): SharePayloadV1 {
  return {
    v: 1,
    b: 'HYPE',
    t: STRATEGY_NOW,
    m: STRATEGY_MATURITY,
    cs: STRATEGY_OPENED,
    a: 0.1781,
    c: 41_320,
    cp: 33_056,
    cb: 8_264,
    p: 282,
    sp: 0.0707,
    h: 'h',
    ce: 1,
    cx: 1,
    l: [
      { k: 'b', x: 'HYPERLIQUID', s: 'S', n: 158_800, r: 0.0936 },
      { k: 'b', x: 'BYBIT', s: 'L', n: 158_800, r: 0.0229 },
      { k: 'p', x: 'HYPERLIQUID', s: 'S', n: 160_300 },
      { k: 'p', x: 'BYBIT', s: 'L', n: 160_300 },
    ],
    f: { pp: 65.01, ps: 49.16, pb: 3.77, pl: 1.6, fp: 80, fs: 49.16, fb: 10.06 },
    ...overrides,
  };
}

export function makeCrossexPosition(overrides: Partial<CrossexPosition> = {}): CrossexPosition {
  return { ...ethPosition, ...overrides };
}

export function makeExposureGroup(overrides: Partial<ExposureGroup> = {}): ExposureGroup {
  return {
    base: 'ETH',
    legs: [
      { symbol: 'GATE_FUTURE_ETH_USDT', exchange: 'GATE', quote: 'USDT', side: 'LONG', qty: 0.3, value: 750 },
      { symbol: 'HYPERLIQUID_FUTURE_ETH_USDC', exchange: 'HYPERLIQUID', quote: 'USDC', side: 'SHORT', qty: 0.3, value: 752 },
    ],
    longValue: 750,
    shortValue: 752,
    netValue: -2,
    grossValue: 1502,
    neutral: true,
    singleLeg: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Opportunities fixtures — the canonical ETH/USDT cohort (Hyperliquid 9% vs
// Binance 4.5%, 30 days out), matching src/core/boros/opportunities.ts. APRs
// are fractions; costs are positive USD and stay exact by construction.
// ---------------------------------------------------------------------------

export const OPP_NOW = 1_752_000_000;
export const OPP_MATURITY = OPP_NOW + 30 * 86_400;
export const OPP_SECONDS_TO_MATURITY = OPP_MATURITY - OPP_NOW;
export const OPP_NOTIONAL = 10_000;

/** N × T — the base every APR↔USD conversion in the fixture runs through. */
export const OPP_NT = OPP_NOTIONAL * (OPP_SECONDS_TO_MATURITY / (365 * 24 * 3600));

export function makeOpportunityMarketRow(
  overrides: Partial<OpportunityMarketRow> = {},
): OpportunityMarketRow {
  return {
    marketId: 101,
    name: 'Hyperliquid ETH',
    venue: 'HYPERLIQUID',
    crossexVenue: 'HYPERLIQUID',
    crossexSymbol: 'HYPERLIQUID_FUTURE_ETH_USDC',
    base: 'ETH',
    midApr: 0.09,
    markApr: 0.0902,
    floatingApr: 0.112,
    oiUsd: 4_200_000,
    execShortApr: 0.0895,
    execLongApr: 0.0905,
    bookStatus: 'ok',
    ...overrides,
  };
}

/** Both members of the canonical group (the high-mid market first). */
function ethOpportunityMarkets(): OpportunityMarketRow[] {
  return [
    makeOpportunityMarketRow(),
    makeOpportunityMarketRow({
      marketId: 102,
      name: 'Binance ETH',
      venue: 'BINANCE',
      crossexVenue: 'BINANCE',
      crossexSymbol: 'BINANCE_FUTURE_ETH_USDT',
      midApr: 0.045,
      markApr: 0.0451,
      floatingApr: 0.0518,
      oiUsd: 9_100_000,
      execShortApr: 0.0445,
      execLongApr: 0.0455,
    }),
  ];
}

export function makeOpportunityLeg(overrides: Partial<OpportunityLeg> = {}): OpportunityLeg {
  return {
    marketId: 101,
    venue: 'HYPERLIQUID',
    crossexVenue: 'HYPERLIQUID',
    crossexSymbol: 'HYPERLIQUID_FUTURE_ETH_USDC',
    base: 'ETH',
    midApr: 0.09,
    execApr: 0.0895,
    ...overrides,
  };
}

/** Boros SHORT on Hyperliquid + Boros LONG on Binance, both perp legs crossing
 * and closed at maturity. */
export function makeOpportunityPair(overrides: Partial<OpportunityPair> = {}): OpportunityPair {
  // (takerFeeRate 5bps + settleFeeApr 10bps) on each of the two Boros legs.
  const borosTakerFeeUsd = 0.001 * OPP_NT;
  const borosSettleFeeUsd = 0.002 * OPP_NT;
  const perpEntryFeesUsd = 10;
  const perpEntrySlippageUsd = 2.5;
  const perpExitFeesUsd = 10;
  const perpExitSlippageUsd = 2.5;
  const totalUsd =
    borosTakerFeeUsd +
    borosSettleFeeUsd +
    perpEntryFeesUsd +
    perpEntrySlippageUsd +
    perpExitFeesUsd +
    perpExitSlippageUsd;
  const grossSpreadApr = 0.09 - 0.045;
  const execSpreadApr = 0.0895 - 0.0455; // hit HL's bids, lift Binance's asks
  const netFixedApr = execSpreadApr - totalUsd / OPP_NT;
  const estProfitUsd = netFixedApr * OPP_NT;
  // Perp IM dominates: $10k at HL's 10x + Binance's 20x. The Boros legs post
  // the kIM formula's tiny 30-day margin.
  const capital = {
    borosShortImUsd: 8,
    borosLongImUsd: 4,
    perpShortImUsd: OPP_NOTIONAL / 10,
    perpLongImUsd: OPP_NOTIONAL / 20,
    shortLeverageMax: 10,
    longLeverageMax: 20,
  };
  const capitalUsd =
    capital.borosShortImUsd +
    capital.borosLongImUsd +
    capital.perpShortImUsd +
    capital.perpLongImUsd;
  return {
    base: 'ETH',
    shortLeg: makeOpportunityLeg(),
    longLeg: makeOpportunityLeg({
      marketId: 102,
      venue: 'BINANCE',
      crossexVenue: 'BINANCE',
      crossexSymbol: 'BINANCE_FUTURE_ETH_USDT',
      midApr: 0.045,
      execApr: 0.0455,
    }),
    grossSpreadApr,
    execSpreadApr,
    borosImpactApr: grossSpreadApr - execSpreadApr,
    makerLeg: null,
    costs: {
      borosTakerFeeUsd,
      borosSettleFeeUsd,
      perpEntryFeesUsd,
      perpEntrySlippageUsd,
      perpExitFeesUsd,
      perpExitSlippageUsd,
      totalUsd,
      annualizedApr: totalUsd / OPP_NT,
    },
    capital,
    capitalUsd,
    netFixedApr,
    netFixedAprOnCapital: estProfitUsd / (capitalUsd * (OPP_NT / OPP_NOTIONAL)),
    effectiveLeverage: OPP_NOTIONAL / capitalUsd,
    estProfitUsd,
    secondsToMaturity: OPP_SECONDS_TO_MATURITY,
    reasons: [],
    ...overrides,
  };
}

export function makeOpportunityGroup(overrides: Partial<OpportunityGroup> = {}): OpportunityGroup {
  const pairs = overrides.pairs ?? [makeOpportunityPair()];
  const best = pairs[0];
  return {
    tokenId: 3,
    collateral: 'USDT',
    collateralPriceUsd: 1,
    maturity: OPP_MATURITY,
    secondsToMaturity: OPP_SECONDS_TO_MATURITY,
    underlying: 'ETH',
    markets: ethOpportunityMarkets(),
    pairs,
    bestPair: best !== undefined && best.netFixedAprOnCapital !== null ? best : null,
    warnings: [],
    ...overrides,
  };
}

export function makeOpportunitiesResult(
  overrides: Partial<OpportunitiesResult> = {},
): OpportunitiesResult {
  return {
    groups: [makeOpportunityGroup()],
    meta: {
      asOfSec: OPP_NOW,
      notionalUsd: OPP_NOTIONAL,
      borosEntry: 'market',
      entryMode: 'both-market',
      exitMode: 'close',
    },
    warnings: [],
    ...overrides,
  };
}

/**
 * GET /api/opportunities returning `data` (or 502 when data is an Error).
 * `opts.urls` collects every request URL so a test can assert the query params
 * a control change produced (`new URL(urls.at(-1)!).searchParams`).
 */
export function opportunitiesHandler(
  data: OpportunitiesResult | Error,
  opts: { urls?: string[] } = {},
) {
  return http.get('/api/opportunities', ({ request }) => {
    opts.urls?.push(request.url);
    return data instanceof Error
      ? HttpResponse.json(
          { ok: false, error: { category: 'network', message: data.message } },
          { status: 502 },
        )
      : HttpResponse.json(env(data));
  });
}
