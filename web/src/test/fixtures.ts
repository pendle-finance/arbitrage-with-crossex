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
  EvenPlan,
  OpportunitiesResult,
  OpportunityGroup,
  OpportunityLeg,
  OpportunityMarketRow,
  OpportunityPair,
  PositionsResponse,
  PreviewResponse,
  PreviewResult,
  RebalanceBucket,
  RebalanceJob,
  RebalanceStep,
  RebalanceView,
  RoutePlan,
  SpotBalance,
  StrategyLeg,
  SymbolRule,
  TransferJob,
  TransferPath,
  TransferView,
  UpdateStatus,
  WalletAfter,
  WalletShare,
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
        latestCommit: null,
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
    rebalanceHandler(),
    transferHandler(),
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

/** GET /api/rebalance with nothing to move; pass `buckets` for a borrow. */
export function makeRebalanceView(over: Partial<RebalanceView> = {}): RebalanceView {
  return { buckets: [], plan: EMPTY_PLAN, job: null, ...over };
}

export function rebalanceHandler(view: RebalanceView = makeRebalanceView()) {
  return http.get('/api/rebalance', () => HttpResponse.json(env<RebalanceView>(view)));
}

export function transferHandler(view: TransferView = transferViews.accountB) {
  return http.get('/api/transfer', () => HttpResponse.json(env<TransferView>(view)));
}

export function accountHandler(body: CrossexAccount = accountBodies.accountB) {
  return http.get('/api/account', () => HttpResponse.json(env<CrossexAccount>(body)));
}

export const REBALANCE_NOW = 1_789_306_394_208;

const TO_HYPERLIQUID = { from: 'CROSSEX', to: 'HYPERLIQUID' } as const;
const FROM_HYPERLIQUID = { from: 'HYPERLIQUID', to: 'CROSSEX' } as const;

const EVEN_SPLIT: WalletShare[] = [
  { coin: 'USDT', venue: 'CROSSEX', notionalUsd: 1000, share: 0.5 },
  { coin: 'USDC', venue: 'HYPERLIQUID', notionalUsd: 1000, share: 0.5 },
];

function jobStep(step: Pick<RebalanceStep, 'name' | 'round' | 'planned'> & Partial<RebalanceStep>): RebalanceStep {
  return {
    ...TO_HYPERLIQUID,
    text: null,
    quoteId: null,
    venueId: null,
    qty: null,
    attempt: 0,
    status: 'pending',
    startedAt: null,
    doneAt: null,
    arrives: null,
    borrowLeft: null,
    ...step,
  };
}

function balancedPlan(after: WalletAfter[]): EvenPlan {
  const idle = {
    available: false, reason: null, costUsd: 0, seconds: 0, rounds: 0, oneMoreRoundCostUsd: null, marginFreedUsd: 0,
    savesPerDayUsd: 0, after, steps: [],
  };
  return {
    balanced: true, noLegs: false, moves: 0, shortOfEven: 0, roundCap: 0, split: EVEN_SPLIT,
    routes: { mix: null, loop: idle, convert: idle },
    recommended: null,
  };
}

function afterOf(usdt: number, usdc: number, gate: number): WalletAfter[] {
  return [
    { coin: 'USDT', venue: 'CROSSEX', cash: usdt, equity: usdt },
    { coin: 'USDC', venue: 'HYPERLIQUID', cash: usdc, equity: usdc },
    { coin: 'USDC', venue: 'GATE', cash: gate, equity: gate },
  ];
}

export function rebased(buckets: RebalanceBucket[], changes: Record<string, Partial<RebalanceBucket>>): RebalanceBucket[] {
  return buckets.map((bucket) => ({ ...bucket, ...changes[`${bucket.coin}/${bucket.venue}`] }));
}

function withLoopReason(plan: EvenPlan, reason: string): EvenPlan {
  return { ...plan, routes: { ...plan.routes, loop: { ...plan.routes.loop!, reason } } };
}

const EMPTY_PLAN: EvenPlan = balancedPlan(afterOf(0, 0, 0));

const ACCOUNT_A_BUCKETS: RebalanceBucket[] = [
  {
    coin: 'USDT', venue: 'CROSSEX', cash: 92.54, upnl: 0, equity: 92.54, borrow: 0, imHeldUsd: 0, mmHeldUsd: 0,
    interestPaidUsd: 0, interestPerDayUsd: 0,
  },
  {
    coin: 'USDC', venue: 'HYPERLIQUID', cash: -147.05, upnl: 0, equity: -147.05, borrow: 147.05, imHeldUsd: 29.41,
    mmHeldUsd: 14.705, interestPaidUsd: 0, interestPerDayUsd: 0,
  },
  {
    coin: 'USDC', venue: 'GATE', cash: 111.96, upnl: 0, equity: 111.96, borrow: 0, imHeldUsd: 0, mmHeldUsd: 0,
    interestPaidUsd: 0, interestPerDayUsd: 0,
  },
];

const ACCOUNT_A_ROUND_3_BUCKETS: RebalanceBucket[] = [
  {
    coin: 'USDT', venue: 'CROSSEX', cash: 92.54, upnl: 0, equity: 92.54, borrow: 0, imHeldUsd: 0, mmHeldUsd: 0,
    interestPaidUsd: 0, interestPerDayUsd: 0,
  },
  {
    coin: 'USDC', venue: 'HYPERLIQUID', cash: -92.71, upnl: 0, equity: -92.71, borrow: 92.71, imHeldUsd: 18.542,
    mmHeldUsd: 9.271, interestPaidUsd: 0, interestPerDayUsd: 0,
  },
  {
    coin: 'USDC', venue: 'GATE', cash: 20.94, upnl: 0, equity: 20.94, borrow: 0, imHeldUsd: 0, mmHeldUsd: 0,
    interestPaidUsd: 0, interestPerDayUsd: 0,
  },
];

const ACCOUNT_A_ROUND_3_PLAN: EvenPlan = {
  balanced: false, noLegs: false, moves: 103.19, shortOfEven: 0, roundCap: 6, split: EVEN_SPLIT,
  routes: {
    mix: null,
    loop: {
      available: false, reason: 'Free margin is too low for an 11 USDC round.', costUsd: 0.21, seconds: 0, rounds: 0,
      oneMoreRoundCostUsd: null, marginFreedUsd: 18.54, savesPerDayUsd: 0,
      after: [
        { coin: 'USDT', venue: 'CROSSEX', cash: 10.28, equity: 10.28 },
        { coin: 'USDC', venue: 'HYPERLIQUID', cash: 10.27, equity: 10.27 },
        { coin: 'USDC', venue: 'GATE', cash: 0, equity: 0 },
      ],
      steps: [
        { round: null, kind: 'convert', buy: 0, move: 103.19, arrives: 102.98, borrowLeft: 0, seconds: 0, ...TO_HYPERLIQUID },
      ],
    },
    convert: {
      available: true, reason: null, costUsd: 0.21, seconds: 0, rounds: 0, oneMoreRoundCostUsd: null,
      marginFreedUsd: 18.54, savesPerDayUsd: 0,
      after: [
        { coin: 'USDT', venue: 'CROSSEX', cash: 10.28, equity: 10.28 },
        { coin: 'USDC', venue: 'HYPERLIQUID', cash: 10.27, equity: 10.27 },
        { coin: 'USDC', venue: 'GATE', cash: 0, equity: 0 },
      ],
      steps: [
        { round: null, kind: 'convert', buy: 0, move: 103.19, arrives: 102.98, borrowLeft: 0, seconds: 0, ...TO_HYPERLIQUID },
      ],
    },
  },
  recommended: 'convert',
};

const ACCOUNT_A_RUNNING_JOB: RebalanceJob = {
  id: 'mtzunfww', route: 'loop', amount: 175.88, costUsd: 0.26,
  target: [
    { coin: 'USDT', venue: 'CROSSEX', cash: 28.61, equity: 28.61 },
    { coin: 'USDC', venue: 'HYPERLIQUID', cash: 28.58, equity: 28.58 },
    { coin: 'USDC', venue: 'GATE', cash: 0, equity: 0 },
  ],
  status: 'running', stepIndex: 8,
  steps: [
    jobStep({
      name: 'Buy USDC', qty: 0, status: 'done', startedAt: REBALANCE_NOW - 298_000, doneAt: REBALANCE_NOW - 298_000,
      round: 1, planned: 0,
    }),
    jobStep({
      name: 'To spot', qty: 24.51, status: 'done', startedAt: REBALANCE_NOW - 298_000, doneAt: REBALANCE_NOW - 293_000,
      round: 1, planned: 24.51,
    }),
    jobStep({
      name: 'To Hyperliquid', qty: 24.46, status: 'done', startedAt: REBALANCE_NOW - 293_000,
      doneAt: REBALANCE_NOW - 167_000, round: 1, planned: 24.51, arrives: 24.46, borrowLeft: 122.59,
    }),
    jobStep({
      name: 'Buy USDC', qty: 0, status: 'done', startedAt: REBALANCE_NOW - 167_000, doneAt: REBALANCE_NOW - 167_000,
      round: 2, planned: 0,
    }),
    jobStep({
      name: 'To spot', qty: 29.93, status: 'done', startedAt: REBALANCE_NOW - 167_000, doneAt: REBALANCE_NOW - 162_000,
      round: 2, planned: 29.93,
    }),
    jobStep({
      name: 'To Hyperliquid', qty: 29.88, status: 'done', startedAt: REBALANCE_NOW - 162_000,
      doneAt: REBALANCE_NOW - 45_000, round: 2, planned: 29.93, arrives: 29.88, borrowLeft: 92.71,
    }),
    jobStep({
      name: 'Buy USDC', qty: 0, status: 'done', startedAt: REBALANCE_NOW - 45_000, doneAt: REBALANCE_NOW - 45_000,
      round: 3, planned: 0,
    }),
    jobStep({
      name: 'To spot', qty: 36.58, status: 'done', startedAt: REBALANCE_NOW - 45_000, doneAt: REBALANCE_NOW - 40_000,
      round: 3, planned: 36.58,
    }),
    jobStep({
      name: 'To Hyperliquid', status: 'running', startedAt: REBALANCE_NOW - 40_000, round: 3, planned: 36.58,
      arrives: 36.53, borrowLeft: 56.18,
    }),
    jobStep({ name: 'Buy USDC', round: 4, planned: 23.77 }),
    jobStep({ name: 'To spot', round: 4, planned: 44.71 }),
    jobStep({ name: 'To Hyperliquid', round: 4, planned: 44.71, arrives: 44.66, borrowLeft: 11.53 }),
    jobStep({ name: 'Buy USDC', round: 5, planned: 40.15 }),
    jobStep({ name: 'To spot', round: 5, planned: 40.15 }),
    jobStep({ name: 'To Hyperliquid', round: 5, planned: 40.15, arrives: 40.1, borrowLeft: 0 }),
  ],
  fundsAt: 'SPOT', haltReason: null, createdAt: REBALANCE_NOW - 298_000, updatedAt: REBALANCE_NOW - 40_000,
  inTransit: { coin: 'USDC', qty: 36.58, at: 'SPOT' },
};

const ACCOUNT_A_HALTED_JOB: RebalanceJob = {
  ...ACCOUNT_A_RUNNING_JOB, status: 'halted', haltReason: 'Gate paused transfers into the CrossEx Hyperliquid wallet.',
  updatedAt: REBALANCE_NOW - 37_000,
};

const ACCOUNT_B_BUCKETS: RebalanceBucket[] = [
  {
    coin: 'USDT', venue: 'CROSSEX', cash: 986.61, upnl: -15.39, equity: 971.22, borrow: 0, imHeldUsd: 0, mmHeldUsd: 0,
    interestPaidUsd: 0, interestPerDayUsd: 0,
  },
  {
    coin: 'USDC', venue: 'HYPERLIQUID', cash: 11.88, upnl: 5.03, equity: 16.91, borrow: 0, imHeldUsd: 0, mmHeldUsd: 0,
    interestPaidUsd: 0, interestPerDayUsd: 0,
  },
  {
    coin: 'USDC', venue: 'GATE', cash: 0.29, upnl: 0, equity: 0.29, borrow: 0, imHeldUsd: 0, mmHeldUsd: 0,
    interestPaidUsd: 0, interestPerDayUsd: 0,
  },
];

const BALANCED_BUCKETS: RebalanceBucket[] = [
  {
    coin: 'USDT', venue: 'CROSSEX', cash: 509.27, upnl: -15.39, equity: 493.88, borrow: 0, imHeldUsd: 0, mmHeldUsd: 0,
    interestPaidUsd: 0, interestPerDayUsd: 0,
  },
  {
    coin: 'USDC', venue: 'HYPERLIQUID', cash: 489.12, upnl: 5.03, equity: 494.15, borrow: 0, imHeldUsd: 0, mmHeldUsd: 0,
    interestPaidUsd: 0, interestPerDayUsd: 0,
  },
  {
    coin: 'USDC', venue: 'GATE', cash: 0.29, upnl: 0, equity: 0.29, borrow: 0, imHeldUsd: 0, mmHeldUsd: 0,
    interestPaidUsd: 0, interestPerDayUsd: 0,
  },
];

const BALANCED_PLAN: EvenPlan = balancedPlan([
  { coin: 'USDT', venue: 'CROSSEX', cash: 509.27, equity: 493.88 },
  { coin: 'USDC', venue: 'HYPERLIQUID', cash: 489.12, equity: 494.15 },
  { coin: 'USDC', venue: 'GATE', cash: 0.29, equity: 0.29 },
]);

const BALANCED_DONE_JOB: RebalanceJob = {
  id: 'mtzuqygg', route: 'loop', amount: 477.29, costUsd: 0.1,
  target: [
    { coin: 'USDT', venue: 'CROSSEX', cash: 509.27, equity: 493.88 },
    { coin: 'USDC', venue: 'HYPERLIQUID', cash: 489.12, equity: 494.15 },
    { coin: 'USDC', venue: 'GATE', cash: 0.29, equity: 0.29 },
  ],
  status: 'done', stepIndex: 2,
  steps: [
    jobStep({
      name: 'Buy USDC', qty: 477.29, status: 'done', startedAt: REBALANCE_NOW - 134_000,
      doneAt: REBALANCE_NOW - 133_000, round: 1, planned: 477.29,
    }),
    jobStep({
      name: 'To spot', qty: 477.29, status: 'done', startedAt: REBALANCE_NOW - 133_000, doneAt: REBALANCE_NOW - 128_000,
      round: 1, planned: 477.29,
    }),
    jobStep({
      name: 'To Hyperliquid', qty: 477.24, status: 'done', startedAt: REBALANCE_NOW - 128_000, doneAt: REBALANCE_NOW,
      round: 1, planned: 477.29, arrives: 477.24, borrowLeft: 0,
    }),
  ],
  fundsAt: 'HYPERLIQUID', haltReason: null, createdAt: REBALANCE_NOW - 134_000, updatedAt: REBALANCE_NOW,
  inTransit: null,
};

const OLD_DONE_JOB: RebalanceJob = {
  id: 'mtzuqygg', route: 'loop', amount: 111.96, status: 'done', stepIndex: 2,
  steps: [
    jobStep({
      name: 'Buy USDC', qty: 111.96, status: 'done', startedAt: REBALANCE_NOW - 134_000,
      doneAt: REBALANCE_NOW - 133_000, round: 1, planned: 111.96,
    }),
    jobStep({
      name: 'To spot', qty: 111.96, status: 'done', startedAt: REBALANCE_NOW - 133_000, doneAt: REBALANCE_NOW - 128_000,
      round: 1, planned: 111.96,
    }),
    jobStep({
      name: 'To Hyperliquid', qty: 111.91, status: 'done', startedAt: REBALANCE_NOW - 128_000, doneAt: REBALANCE_NOW,
      round: 1, planned: 111.96,
    }),
  ],
  fundsAt: 'HYPERLIQUID', haltReason: null, createdAt: REBALANCE_NOW - 134_000, updatedAt: REBALANCE_NOW, costUsd: null,
  target: null, inTransit: null,
};

const ACCOUNT_A_CONVERT: RoutePlan = {
  available: true, reason: null, costUsd: 0.36, seconds: 0, rounds: 0, oneMoreRoundCostUsd: null,
  marginFreedUsd: 29.41, savesPerDayUsd: 0,
  after: afterOf(28.54, 28.53, 0),
  steps: [
    { round: null, kind: 'convert', buy: 0, move: 175.94, arrives: 175.58, borrowLeft: 0, seconds: 0, ...TO_HYPERLIQUID },
  ],
};

const ACCOUNT_A_PLAN: EvenPlan = {
  balanced: false, noLegs: false, moves: 175.89, shortOfEven: 0, roundCap: 6, split: EVEN_SPLIT,
  routes: {
    mix: null,
    loop: {
      available: true, reason: null, costUsd: 0.26, seconds: 650, rounds: 5, oneMoreRoundCostUsd: null,
      marginFreedUsd: 29.41, savesPerDayUsd: 0,
      after: afterOf(28.61, 28.58, 0),
      steps: [
        { round: 1, kind: 'round', buy: 0, move: 24.51, arrives: 24.46, borrowLeft: 122.59, seconds: 130, ...TO_HYPERLIQUID },
        { round: 2, kind: 'round', buy: 0, move: 29.93, arrives: 29.88, borrowLeft: 92.71, seconds: 130, ...TO_HYPERLIQUID },
        { round: 3, kind: 'round', buy: 0, move: 36.58, arrives: 36.53, borrowLeft: 56.18, seconds: 130, ...TO_HYPERLIQUID },
        { round: 4, kind: 'round', buy: 23.77, move: 44.71, arrives: 44.66, borrowLeft: 11.53, seconds: 130, ...TO_HYPERLIQUID },
        { round: 5, kind: 'round', buy: 40.15, move: 40.15, arrives: 40.1, borrowLeft: 0, seconds: 130, ...TO_HYPERLIQUID },
      ],
    },
    convert: ACCOUNT_A_CONVERT,
  },
  recommended: 'loop',
};

const ACCOUNT_A_PAUSED_PLAN: EvenPlan = {
  balanced: false, noLegs: false, moves: 175.94, shortOfEven: 0, roundCap: 6, split: EVEN_SPLIT,
  routes: {
    mix: null,
    loop: {
      available: false, reason: 'Gate paused USDC transfers.', costUsd: 0.26, seconds: 650, rounds: 5,
      oneMoreRoundCostUsd: null, marginFreedUsd: 29.41, savesPerDayUsd: 0,
      after: afterOf(28.6, 28.59, 0),
      steps: [
        { round: 1, kind: 'round', buy: 0, move: 24.51, arrives: 24.46, borrowLeft: 122.59, seconds: 130, ...TO_HYPERLIQUID },
        { round: 2, kind: 'round', buy: 0, move: 29.93, arrives: 29.88, borrowLeft: 92.71, seconds: 130, ...TO_HYPERLIQUID },
        { round: 3, kind: 'round', buy: 0, move: 36.58, arrives: 36.53, borrowLeft: 56.18, seconds: 130, ...TO_HYPERLIQUID },
        { round: 4, kind: 'round', buy: 23.77, move: 44.71, arrives: 44.66, borrowLeft: 11.52, seconds: 130, ...TO_HYPERLIQUID },
        { round: 5, kind: 'round', buy: 40.16, move: 40.16, arrives: 40.11, borrowLeft: 0, seconds: 130, ...TO_HYPERLIQUID },
      ],
    },
    convert: ACCOUNT_A_CONVERT,
  },
  recommended: 'convert',
};

const ACCOUNT_A_INSIDE_BUCKETS = rebased(ACCOUNT_A_ROUND_3_BUCKETS, { 'USDC/GATE': { cash: 57.52, equity: 57.52 } });

const ACCOUNT_A_INSIDE_PLAN: EvenPlan = {
  balanced: false, noLegs: false, moves: 121.45, shortOfEven: 0, roundCap: 6, split: EVEN_SPLIT,
  routes: {
    mix: null,
    loop: {
      available: true, reason: null, costUsd: 0.16, seconds: 390, rounds: 3, oneMoreRoundCostUsd: null,
      marginFreedUsd: 18.54, savesPerDayUsd: 0,
      after: afterOf(28.6, 28.59, 0),
      steps: [
        { round: 1, kind: 'round', buy: 0, move: 36.58, arrives: 36.53, borrowLeft: 56.18, seconds: 130, ...TO_HYPERLIQUID },
        { round: 2, kind: 'round', buy: 23.77, move: 44.71, arrives: 44.66, borrowLeft: 11.52, seconds: 130, ...TO_HYPERLIQUID },
        { round: 3, kind: 'round', buy: 40.16, move: 40.16, arrives: 40.11, borrowLeft: 0, seconds: 130, ...TO_HYPERLIQUID },
      ],
    },
    convert: {
      available: true, reason: null, costUsd: 0.25, seconds: 0, rounds: 0, oneMoreRoundCostUsd: null,
      marginFreedUsd: 18.54, savesPerDayUsd: 0,
      after: afterOf(28.55, 28.54, 0),
      steps: [
        { round: null, kind: 'convert', buy: 0, move: 121.5, arrives: 121.25, borrowLeft: 0, seconds: 0, ...TO_HYPERLIQUID },
      ],
    },
  },
  recommended: 'loop',
};

const HALTED_INSIDE_JOB: RebalanceJob = {
  ...ACCOUNT_A_HALTED_JOB, stepIndex: 7, fundsAt: 'GATE', haltReason: 'The app restarted during the run. Nothing failed. Press Resume.',
  inTransit: null,
  steps: [
    ...ACCOUNT_A_RUNNING_JOB.steps.slice(0, 7),
    jobStep({ name: 'To spot', status: 'running', startedAt: REBALANCE_NOW - 45_000, round: 3, planned: 36.58 }),
    jobStep({ name: 'To Hyperliquid', round: 3, planned: 36.58, arrives: 36.53, borrowLeft: 56.18 }),
    ...ACCOUNT_A_RUNNING_JOB.steps.slice(9),
  ],
};

const CONVERT_DONE_JOB: RebalanceJob = {
  id: 'mtzutp80', route: 'convert', amount: 175.94, costUsd: 0.36,
  target: ACCOUNT_A_CONVERT.after, status: 'done', stepIndex: 1,
  steps: [
    jobStep({
      name: 'Sell USDC', qty: 111.948804, status: 'done', startedAt: REBALANCE_NOW - 6_000,
      doneAt: REBALANCE_NOW - 5_000, round: null, planned: 111.96,
    }),
    jobStep({
      name: 'Convert', qty: 175.58, status: 'done', startedAt: REBALANCE_NOW - 5_000, doneAt: REBALANCE_NOW - 4_000,
      round: null, planned: 175.94,
    }),
  ],
  fundsAt: 'HYPERLIQUID', haltReason: null, createdAt: REBALANCE_NOW - 6_000, updatedAt: REBALANCE_NOW - 4_000,
  inTransit: null,
};

const CONVERT_DONE_BUCKETS = rebased(ACCOUNT_A_BUCKETS, {
  'USDT/CROSSEX': { cash: 28.548804, equity: 28.548804 },
  'USDC/HYPERLIQUID': { cash: 28.53, equity: 28.53, borrow: 0, imHeldUsd: 0, mmHeldUsd: 0 },
  'USDC/GATE': { cash: 0, equity: 0 },
});

const BORROW_UNDER_ONE_BUCKETS = rebased(ACCOUNT_B_BUCKETS, {
  'USDC/HYPERLIQUID': { cash: -0.4, equity: 4.63, borrow: 0.4, imHeldUsd: 0.08, mmHeldUsd: 0.04 },
});

const BORROW_UNDER_ONE_PLAN: EvenPlan = {
  balanced: false, noLegs: false, moves: 483.43, shortOfEven: 0, roundCap: 6, split: EVEN_SPLIT,
  routes: {
    mix: null,
    loop: {
      available: true, reason: null, costUsd: 0.1, seconds: 130, rounds: 1, oneMoreRoundCostUsd: null,
      marginFreedUsd: 0.08, savesPerDayUsd: 0,
      after: [
        { coin: 'USDT', venue: 'CROSSEX', cash: 503.13, equity: 487.74 },
        { coin: 'USDC', venue: 'HYPERLIQUID', cash: 482.98, equity: 488.01 },
        { coin: 'USDC', venue: 'GATE', cash: 0.29, equity: 0.29 },
      ],
      steps: [
        { round: 1, kind: 'round', buy: 483.43, move: 483.43, arrives: 483.38, borrowLeft: 0, seconds: 130, ...TO_HYPERLIQUID },
      ],
    },
    convert: {
      available: true, reason: null, costUsd: 0.97, seconds: 0, rounds: 0, oneMoreRoundCostUsd: null,
      marginFreedUsd: 0.08, savesPerDayUsd: 0,
      after: [
        { coin: 'USDT', venue: 'CROSSEX', cash: 502.69, equity: 487.3 },
        { coin: 'USDC', venue: 'HYPERLIQUID', cash: 482.55, equity: 487.58 },
        { coin: 'USDC', venue: 'GATE', cash: 0.29, equity: 0.29 },
      ],
      steps: [
        { round: null, kind: 'convert', buy: 0, move: 483.92, arrives: 482.95, borrowLeft: 0, seconds: 0, ...TO_HYPERLIQUID },
      ],
    },
  },
  recommended: 'loop',
};

const EXAMPLE_D_BUCKETS: RebalanceBucket[] = [
  {
    coin: 'USDT', venue: 'CROSSEX', cash: 12081.77, upnl: 0, equity: 12081.77, borrow: 0, imHeldUsd: 0,
    mmHeldUsd: 0, interestPaidUsd: 0, interestPerDayUsd: 0,
  },
  {
    coin: 'USDC', venue: 'HYPERLIQUID', cash: -9612.4, upnl: 0, equity: -9612.4, borrow: 9612.4, imHeldUsd: 1922.48,
    mmHeldUsd: 961.24, interestPaidUsd: 0, interestPerDayUsd: 0,
  },
  {
    coin: 'USDC', venue: 'GATE', cash: 0, upnl: 0, equity: 0, borrow: 0, imHeldUsd: 0, mmHeldUsd: 0,
    interestPaidUsd: 0, interestPerDayUsd: 0,
  },
];

const EXAMPLE_D_MIX: RoutePlan = {
  available: true, reason: null, costUsd: 15.68, seconds: 780, rounds: 6, oneMoreRoundCostUsd: null,
  marginFreedUsd: 1922.48, savesPerDayUsd: 0,
  after: afterOf(1226.85, 1226.83, 0),
  steps: [
    { round: 1, kind: 'round', buy: 316.19, move: 316.19, arrives: 316.14, borrowLeft: 9296.26, seconds: 130, ...TO_HYPERLIQUID },
    { round: 2, kind: 'round', buy: 386.92, move: 386.92, arrives: 386.87, borrowLeft: 8909.39, seconds: 130, ...TO_HYPERLIQUID },
    { round: 3, kind: 'round', buy: 473.49, move: 473.49, arrives: 473.44, borrowLeft: 8435.95, seconds: 130, ...TO_HYPERLIQUID },
    { round: 4, kind: 'round', buy: 579.44, move: 579.44, arrives: 579.39, borrowLeft: 7856.56, seconds: 130, ...TO_HYPERLIQUID },
    { round: 5, kind: 'round', buy: 709.12, move: 709.12, arrives: 709.07, borrowLeft: 7147.49, seconds: 130, ...TO_HYPERLIQUID },
    { round: 6, kind: 'round', buy: 867.83, move: 867.83, arrives: 867.78, borrowLeft: 6279.71, seconds: 130, ...TO_HYPERLIQUID },
    { round: null, kind: 'convert', buy: 0, move: 7521.59, arrives: 7506.54, borrowLeft: 0, seconds: 0, ...TO_HYPERLIQUID },
  ],
};

const EXAMPLE_D_MID_BUCKETS = rebased(EXAMPLE_D_BUCKETS, {
  'USDT/CROSSEX': { cash: 8748.446701, equity: 8748.446701 },
  'USDC/HYPERLIQUID': { cash: -6279.71, equity: -6279.71, borrow: 6279.71, imHeldUsd: 1255.942, mmHeldUsd: 627.971 },
});

const EXAMPLE_D_MID_PLAN: EvenPlan = {
  balanced: false, noLegs: false, moves: 7513.82, shortOfEven: 0, roundCap: 6, split: EVEN_SPLIT,
  routes: {
    mix: null,
    loop: {
      available: true, reason: null, costUsd: 1, seconds: 650, rounds: 5, oneMoreRoundCostUsd: null,
      marginFreedUsd: 1255.94, savesPerDayUsd: 0,
      after: afterOf(1233.87, 1233.86, 0),
      steps: [
        { round: 1, kind: 'round', buy: 1062.08, move: 1062.08, arrives: 1062.03, borrowLeft: 5217.68, seconds: 130, ...TO_HYPERLIQUID },
        { round: 2, kind: 'round', buy: 1299.82, move: 1299.82, arrives: 1299.77, borrowLeft: 3917.91, seconds: 130, ...TO_HYPERLIQUID },
        { round: 3, kind: 'round', buy: 1590.78, move: 1590.78, arrives: 1590.73, borrowLeft: 2327.18, seconds: 130, ...TO_HYPERLIQUID },
        { round: 4, kind: 'round', buy: 1946.9, move: 1946.9, arrives: 1946.85, borrowLeft: 380.33, seconds: 130, ...TO_HYPERLIQUID },
        { round: 5, kind: 'round', buy: 1614.24, move: 1614.24, arrives: 1614.19, borrowLeft: 0, seconds: 130, ...TO_HYPERLIQUID },
      ],
    },
    convert: {
      available: true, reason: null, costUsd: 15.04, seconds: 0, rounds: 0, oneMoreRoundCostUsd: null,
      marginFreedUsd: 1255.94, savesPerDayUsd: 0,
      after: EXAMPLE_D_MIX.after,
      steps: [
        { round: null, kind: 'convert', buy: 0, move: 7521.59, arrives: 7506.54, borrowLeft: 0, seconds: 0, ...TO_HYPERLIQUID },
      ],
    },
  },
  recommended: 'loop',
};

const EXAMPLE_D_STARTED = REBALANCE_NOW - 783_000;

const EXAMPLE_D_CONVERT_JOB: RebalanceJob = {
  id: 'mtzud1oo', route: 'mix', amount: 10854.58, costUsd: EXAMPLE_D_MIX.costUsd,
  target: EXAMPLE_D_MIX.after, status: 'running', stepIndex: 18,
  steps: EXAMPLE_D_MIX.steps.flatMap((step, index): RebalanceStep[] => {
    const start = EXAMPLE_D_STARTED + index * 130_000;
    if (step.kind === 'convert') {
      return [jobStep({ name: 'Convert', status: 'running', startedAt: start, round: null, planned: step.move })];
    }
    return [
      jobStep({
        name: 'Buy USDC', qty: step.buy, status: 'done', startedAt: start, doneAt: start + 1_000, round: step.round,
        planned: step.buy,
      }),
      jobStep({
        name: 'To spot', qty: step.move, status: 'done', startedAt: start + 1_000, doneAt: start + 6_000,
        round: step.round, planned: step.move,
      }),
      jobStep({
        name: 'To Hyperliquid', qty: step.arrives, status: 'done', startedAt: start + 6_000, doneAt: start + 130_000,
        round: step.round, planned: step.move, arrives: step.arrives, borrowLeft: step.borrowLeft,
      }),
    ];
  }),
  fundsAt: 'HYPERLIQUID', haltReason: null, createdAt: EXAMPLE_D_STARTED, updatedAt: REBALANCE_NOW - 3_000,
  inTransit: null,
};

const MIX_DONE_JOB: RebalanceJob = {
  ...EXAMPLE_D_CONVERT_JOB, status: 'done', updatedAt: REBALANCE_NOW,
  steps: EXAMPLE_D_CONVERT_JOB.steps.map(
    (step): RebalanceStep =>
      step.name === 'Convert' ? { ...step, qty: 7506.54, status: 'done', doneAt: REBALANCE_NOW } : step,
  ),
};

const MIX_DONE_BUCKETS = rebased(EXAMPLE_D_MID_BUCKETS, {
  'USDT/CROSSEX': { cash: 1226.856701, equity: 1226.856701 },
  'USDC/HYPERLIQUID': { cash: 1226.83, equity: 1226.83, borrow: 0, imHeldUsd: 0, mmHeldUsd: 0 },
});

const EXAMPLE_E_BUCKETS: RebalanceBucket[] = [
  {
    coin: 'USDT', venue: 'CROSSEX', cash: -612.35, upnl: 0, equity: -612.35, borrow: 612.35, imHeldUsd: 122.47,
    mmHeldUsd: 61.235, interestPaidUsd: 0, interestPerDayUsd: 0.09,
  },
  {
    coin: 'USDC', venue: 'HYPERLIQUID', cash: 1842.16, upnl: 0, equity: 1842.16, borrow: 0, imHeldUsd: 0,
    mmHeldUsd: 0, interestPaidUsd: 0, interestPerDayUsd: 0,
  },
  {
    coin: 'USDC', venue: 'GATE', cash: 0, upnl: 0, equity: 0, borrow: 0, imHeldUsd: 0, mmHeldUsd: 0,
    interestPaidUsd: 0, interestPerDayUsd: 0,
  },
];

const EXAMPLE_E_MID_BUCKETS = rebased(EXAMPLE_E_BUCKETS, { 'USDC/HYPERLIQUID': { cash: 1096.72, equity: 1096.72 } });

const EXAMPLE_E_MID_CONVERT: RoutePlan = {
  available: true, reason: null, costUsd: 1.71, seconds: 0, rounds: 0, oneMoreRoundCostUsd: null,
  marginFreedUsd: 122.47, savesPerDayUsd: 0.09,
  after: afterOf(241.32, 241.33, 0),
  steps: [
    { round: null, kind: 'convert', buy: 0, move: 855.39, arrives: 853.67, borrowLeft: 0, seconds: 0, ...FROM_HYPERLIQUID },
  ],
};

const EXAMPLE_E_MID_PLAN: EvenPlan = {
  balanced: false, noLegs: false, moves: 855.39, shortOfEven: 0, roundCap: 2, split: EVEN_SPLIT,
  routes: {
    mix: null,
    loop: { ...EXAMPLE_E_MID_CONVERT, available: false, reason: 'Free margin is too low for an 11 USDC round.' },
    convert: EXAMPLE_E_MID_CONVERT,
  },
  recommended: 'convert',
};

const EXAMPLE_E_JOB: RebalanceJob = {
  id: 'mtzuqm40', route: 'loop', amount: 1228.31, costUsd: 2.12,
  target: afterOf(613.83, 613.85, 0), status: 'running', stepIndex: 0,
  steps: [
    jobStep({ ...FROM_HYPERLIQUID,
      name: 'From Hyperliquid', status: 'running', startedAt: REBALANCE_NOW - 150_000, round: 1, planned: 745.44,
    }),
    jobStep({ ...FROM_HYPERLIQUID, name: 'To Gate', round: 1, planned: 744.44 }),
    jobStep({ ...FROM_HYPERLIQUID, name: 'Sell USDC', round: 1, planned: 744.44, borrowLeft: 0 }),
    jobStep({ ...FROM_HYPERLIQUID, name: 'From Hyperliquid', round: 2, planned: 482.87 }),
    jobStep({ ...FROM_HYPERLIQUID, name: 'To Gate', round: 2, planned: 481.87 }),
    jobStep({ ...FROM_HYPERLIQUID, name: 'Sell USDC', round: 2, planned: 481.87, borrowLeft: 0 }),
  ],
  fundsAt: 'HYPERLIQUID', haltReason: null, createdAt: REBALANCE_NOW - 150_000, updatedAt: REBALANCE_NOW - 150_000,
  inTransit: null,
};

const EXAMPLE_E_ABANDONED_JOB: RebalanceJob = {
  ...EXAMPLE_E_JOB, id: 'mtzujyww', status: 'abandoned', stepIndex: 1, fundsAt: 'SPOT',
  haltReason: 'The app restarted during the run. Nothing failed. Press Resume.', createdAt: REBALANCE_NOW - 460_000,
  updatedAt: REBALANCE_NOW - 30_000, inTransit: { coin: 'USDC', qty: 744.44, at: 'SPOT' },
  steps: [
    jobStep({ ...FROM_HYPERLIQUID,
      name: 'From Hyperliquid', qty: 744.44, status: 'done', startedAt: REBALANCE_NOW - 460_000,
      doneAt: REBALANCE_NOW - 60_000, round: 1, planned: 745.44,
    }),
    jobStep({ ...FROM_HYPERLIQUID, name: 'To Gate', status: 'running', startedAt: REBALANCE_NOW - 60_000, round: 1, planned: 744.44 }),
    ...EXAMPLE_E_JOB.steps.slice(2),
  ],
};

const LIGHTER_SPLIT_BUCKETS: RebalanceBucket[] = [
  {
    coin: 'USDT',
    venue: 'CROSSEX',
    cash: 1000,
    upnl: 0,
    equity: 1000,
    borrow: 0,
    imHeldUsd: 0,
    mmHeldUsd: 0,
    interestPaidUsd: 0,
    interestPerDayUsd: 0,
  },
  {
    coin: 'USDC',
    venue: 'HYPERLIQUID',
    cash: 0,
    upnl: 0,
    equity: 0,
    borrow: 0,
    imHeldUsd: 0,
    mmHeldUsd: 0,
    interestPaidUsd: 0,
    interestPerDayUsd: 0,
  },
  {
    coin: 'USDC',
    venue: 'LIGHTER',
    cash: 0,
    upnl: 0,
    equity: 0,
    borrow: 0,
    imHeldUsd: 0,
    mmHeldUsd: 0,
    interestPaidUsd: 0,
    interestPerDayUsd: 0,
  },
  {
    coin: 'USDC',
    venue: 'GATE',
    cash: 0,
    upnl: 0,
    equity: 0,
    borrow: 0,
    imHeldUsd: 0,
    mmHeldUsd: 0,
    interestPaidUsd: 0,
    interestPerDayUsd: 0,
  },
];

const LIGHTER_SPLIT_PLAN: EvenPlan = {
  balanced: false,
  noLegs: false,
  moves: 500.12,
  shortOfEven: 0,
  roundCap: 6,
  split: [
    { coin: 'USDT', venue: 'CROSSEX', notionalUsd: 500, share: 0.5 },
    { coin: 'USDC', venue: 'HYPERLIQUID', notionalUsd: 250, share: 0.25 },
    { coin: 'USDC', venue: 'LIGHTER', notionalUsd: 250, share: 0.25 },
  ],
  routes: {
    mix: {
      available: true,
      reason: null,
      costUsd: 0.83,
      seconds: 130,
      rounds: 1,
      oneMoreRoundCostUsd: null,
      marginFreedUsd: 0,
      savesPerDayUsd: 0,
      after: [
        { coin: 'USDT', venue: 'CROSSEX', cash: 499.6, equity: 499.6 },
        { coin: 'USDC', venue: 'HYPERLIQUID', cash: 249.78, equity: 249.78 },
        { coin: 'USDC', venue: 'LIGHTER', cash: 249.78, equity: 249.78 },
        { coin: 'USDC', venue: 'GATE', cash: 0, equity: 0 },
      ],
      steps: [
        {
          round: 1,
          kind: 'round',
          buy: 249.83,
          move: 249.83,
          arrives: 249.78,
          borrowLeft: 0,
          seconds: 130,
          from: 'CROSSEX',
          to: 'HYPERLIQUID',
        },
        {
          round: null,
          kind: 'convert',
          buy: 0,
          move: 250.29,
          arrives: 249.78,
          borrowLeft: 0,
          seconds: 0,
          from: 'CROSSEX',
          to: 'LIGHTER',
        },
      ],
    },
    loop: {
      available: true,
      reason: null,
      costUsd: 1.63,
      seconds: 365,
      rounds: 2,
      oneMoreRoundCostUsd: null,
      marginFreedUsd: 0,
      savesPerDayUsd: 0,
      after: [
        { coin: 'USDT', venue: 'CROSSEX', cash: 499.2, equity: 499.2 },
        { coin: 'USDC', venue: 'HYPERLIQUID', cash: 249.58, equity: 249.58 },
        { coin: 'USDC', venue: 'LIGHTER', cash: 249.58, equity: 249.58 },
        { coin: 'USDC', venue: 'GATE', cash: 0, equity: 0 },
      ],
      steps: [
        {
          round: 1,
          kind: 'round',
          buy: 249.63,
          move: 249.63,
          arrives: 249.58,
          borrowLeft: 0,
          seconds: 130,
          from: 'CROSSEX',
          to: 'HYPERLIQUID',
        },
        {
          round: 2,
          kind: 'round',
          buy: 250.61,
          move: 250.61,
          arrives: 249.58,
          borrowLeft: 0,
          seconds: 235,
          from: 'CROSSEX',
          to: 'LIGHTER',
        },
      ],
    },
    convert: {
      available: true,
      reason: null,
      costUsd: 1,
      seconds: 0,
      rounds: 0,
      oneMoreRoundCostUsd: null,
      marginFreedUsd: 0,
      savesPerDayUsd: 0,
      after: [
        { coin: 'USDT', venue: 'CROSSEX', cash: 499.5, equity: 499.5 },
        { coin: 'USDC', venue: 'HYPERLIQUID', cash: 249.74, equity: 249.74 },
        { coin: 'USDC', venue: 'LIGHTER', cash: 249.74, equity: 249.74 },
        { coin: 'USDC', venue: 'GATE', cash: 0, equity: 0 },
      ],
      steps: [
        {
          round: null,
          kind: 'convert',
          buy: 0,
          move: 250.25,
          arrives: 249.74,
          borrowLeft: 0,
          seconds: 0,
          from: 'CROSSEX',
          to: 'HYPERLIQUID',
        },
        {
          round: null,
          kind: 'convert',
          buy: 0,
          move: 250.25,
          arrives: 249.74,
          borrowLeft: 0,
          seconds: 0,
          from: 'CROSSEX',
          to: 'LIGHTER',
        },
      ],
    },
  },
  recommended: 'mix',
};

const LIGHTER_ACROSS_BUCKETS: RebalanceBucket[] = [
  {
    coin: 'USDT',
    venue: 'CROSSEX',
    cash: 500,
    upnl: 0,
    equity: 500,
    borrow: 0,
    imHeldUsd: 0,
    mmHeldUsd: 0,
    interestPaidUsd: 0,
    interestPerDayUsd: 0,
  },
  {
    coin: 'USDC',
    venue: 'HYPERLIQUID',
    cash: 500,
    upnl: 0,
    equity: 500,
    borrow: 0,
    imHeldUsd: 0,
    mmHeldUsd: 0,
    interestPaidUsd: 0,
    interestPerDayUsd: 0,
  },
  {
    coin: 'USDC',
    venue: 'LIGHTER',
    cash: 0,
    upnl: 0,
    equity: 0,
    borrow: 0,
    imHeldUsd: 0,
    mmHeldUsd: 0,
    interestPaidUsd: 0,
    interestPerDayUsd: 0,
  },
  {
    coin: 'USDC',
    venue: 'GATE',
    cash: 0,
    upnl: 0,
    equity: 0,
    borrow: 0,
    imHeldUsd: 0,
    mmHeldUsd: 0,
    interestPaidUsd: 0,
    interestPerDayUsd: 0,
  },
];

const LIGHTER_ACROSS_PLAN: EvenPlan = {
  balanced: false,
  noLegs: false,
  moves: 500,
  shortOfEven: 0,
  roundCap: 1,
  split: [
    { coin: 'USDT', venue: 'CROSSEX', notionalUsd: 500, share: 0.5 },
    { coin: 'USDC', venue: 'HYPERLIQUID', notionalUsd: 0, share: 0 },
    { coin: 'USDC', venue: 'LIGHTER', notionalUsd: 500, share: 0.5 },
  ],
  routes: {
    mix: null,
    loop: {
      available: true,
      reason: null,
      costUsd: 2.03,
      seconds: 625,
      rounds: 1,
      oneMoreRoundCostUsd: null,
      marginFreedUsd: 0,
      savesPerDayUsd: 0,
      after: [
        { coin: 'USDT', venue: 'CROSSEX', cash: 500, equity: 500 },
        { coin: 'USDC', venue: 'HYPERLIQUID', cash: 0, equity: 0 },
        { coin: 'USDC', venue: 'LIGHTER', cash: 497.97, equity: 497.97 },
        { coin: 'USDC', venue: 'GATE', cash: 0, equity: 0 },
      ],
      steps: [
        {
          round: 1,
          kind: 'round',
          buy: 0,
          move: 500,
          arrives: 497.97,
          borrowLeft: 0,
          seconds: 625,
          from: 'HYPERLIQUID',
          to: 'LIGHTER',
        },
      ],
    },
    convert: {
      available: true,
      reason: null,
      costUsd: 2,
      seconds: 0,
      rounds: 0,
      oneMoreRoundCostUsd: null,
      marginFreedUsd: 0,
      savesPerDayUsd: 0,
      after: [
        { coin: 'USDT', venue: 'CROSSEX', cash: 500, equity: 500 },
        { coin: 'USDC', venue: 'HYPERLIQUID', cash: 0, equity: 0 },
        { coin: 'USDC', venue: 'LIGHTER', cash: 498, equity: 498 },
        { coin: 'USDC', venue: 'GATE', cash: 0, equity: 0 },
      ],
      steps: [
        {
          round: null,
          kind: 'convert',
          buy: 0,
          move: 500,
          arrives: 498,
          borrowLeft: 0,
          seconds: 0,
          from: 'HYPERLIQUID',
          to: 'LIGHTER',
        },
      ],
    },
  },
  recommended: 'convert',
};

const ACROSS = { from: 'HYPERLIQUID', to: 'LIGHTER' } as const;

const LIGHTER_ACROSS_RUNNING_JOB: RebalanceJob = {
  id: 'mtzv1l7g', route: 'loop', amount: 500, costUsd: 2.03, target: LIGHTER_ACROSS_PLAN.routes.loop!.after,
  status: 'running', stepIndex: 1,
  steps: [
    jobStep({
      ...ACROSS, name: 'From Hyperliquid', qty: 499, status: 'done', startedAt: REBALANCE_NOW - 400_000,
      doneAt: REBALANCE_NOW - 10_000, round: 1, planned: 500,
    }),
    jobStep({
      ...ACROSS, name: 'To Lighter', venueId: 'x2', status: 'running', startedAt: REBALANCE_NOW - 10_000, round: 1,
      planned: 499, arrives: 497.97, borrowLeft: 0,
    }),
  ],
  fundsAt: 'SPOT', haltReason: null, createdAt: REBALANCE_NOW - 400_000, updatedAt: REBALANCE_NOW - 10_000,
  inTransit: { coin: 'USDC', qty: 499, at: 'MOVING' },
};

const LIGHTER_ACROSS_ABANDONED_JOB: RebalanceJob = {
  ...LIGHTER_ACROSS_RUNNING_JOB, status: 'abandoned', haltReason: 'Gate took too long on this step. Press Resume to check again.',
  inTransit: { coin: 'USDC', qty: 499, at: 'SPOT' },
  steps: [
    LIGHTER_ACROSS_RUNNING_JOB.steps[0],
    jobStep({ ...ACROSS, name: 'To Lighter', round: 1, planned: 499, arrives: 497.97, borrowLeft: 0 }),
  ],
};

const LIGHTER_CONVERT_DONE_JOB: RebalanceJob = {
  id: 'mtzv2c1q', route: 'convert', amount: 500, costUsd: 2, target: LIGHTER_ACROSS_PLAN.routes.convert.after,
  status: 'done', stepIndex: 1,
  steps: [
    jobStep({
      ...ACROSS, name: 'Convert to USDT', qty: 499, status: 'done', startedAt: REBALANCE_NOW - 3_000,
      doneAt: REBALANCE_NOW - 2_000, round: null, planned: 500,
    }),
    jobStep({
      ...ACROSS, name: 'Convert to USDC', qty: 498, status: 'done', startedAt: REBALANCE_NOW - 2_000,
      doneAt: REBALANCE_NOW - 1_000, round: null, planned: 499,
    }),
  ],
  fundsAt: 'LIGHTER', haltReason: null, createdAt: REBALANCE_NOW - 3_000, updatedAt: REBALANCE_NOW - 1_000,
  inTransit: null,
};

const NO_LEGS_PLAN: EvenPlan = { ...balancedPlan(afterOf(1000, 0, 0)), split: [], noLegs: true };

const TWO_BORROWS_BUCKETS: RebalanceBucket[] = [
  {
    coin: 'USDT', venue: 'CROSSEX', cash: 1387.45, upnl: 104.47, equity: 1491.92, borrow: 0, imHeldUsd: 0,
    mmHeldUsd: 0, interestPaidUsd: 0, interestPerDayUsd: 0,
  },
  {
    coin: 'USDC', venue: 'HYPERLIQUID', cash: -100.0, upnl: -12.0, equity: -112.0, borrow: 112.0, imHeldUsd: 22.4,
    mmHeldUsd: 11.2, interestPaidUsd: 0, interestPerDayUsd: 0,
  },
  {
    coin: 'USDC', venue: 'LIGHTER', cash: -120.0, upnl: -12.0, equity: -132.0, borrow: 132.0, imHeldUsd: 26.4,
    mmHeldUsd: 13.2, interestPaidUsd: 0, interestPerDayUsd: 0.0396,
  },
];

const TWO_BORROWS_SPLIT: WalletShare[] = [
  { coin: 'USDT', venue: 'CROSSEX', notionalUsd: 1890.5, share: 0.5 },
  { coin: 'USDC', venue: 'HYPERLIQUID', notionalUsd: 1663.64, share: 0.44 },
  { coin: 'USDC', venue: 'LIGHTER', notionalUsd: 226.86, share: 0.06 },
];

const TWO_BORROWS_TARGET: WalletAfter[] = [
  { coin: 'USDT', venue: 'CROSSEX', cash: 519.49, equity: 623.96 },
  { coin: 'USDC', venue: 'HYPERLIQUID', cash: 561.08, equity: 549.08 },
  { coin: 'USDC', venue: 'LIGHTER', cash: 86.88, equity: 74.88 },
];

const TWO_BORROWS_PLAN: EvenPlan = {
  balanced: false, noLegs: false, moves: 869.04, shortOfEven: 0, roundCap: 6, split: TWO_BORROWS_SPLIT,
  routes: {
    mix: {
      available: true, reason: null, costUsd: 0.46, seconds: 130, rounds: 1, oneMoreRoundCostUsd: null,
      marginFreedUsd: 48.8, savesPerDayUsd: 0.04, after: TWO_BORROWS_TARGET,
      steps: [
        {
          round: 1, kind: 'round', buy: 661.13, move: 661.13, arrives: 661.08, borrowLeft: 132.0, seconds: 130,
          from: 'CROSSEX', to: 'HYPERLIQUID',
        },
        {
          round: null, kind: 'convert', buy: 0, move: 207.29, arrives: 206.88, borrowLeft: 0, seconds: 0,
          from: 'CROSSEX', to: 'LIGHTER',
        },
      ],
    },
    loop: {
      available: true, reason: null, costUsd: 1.08, seconds: 360, rounds: 2, oneMoreRoundCostUsd: null,
      marginFreedUsd: 48.8, savesPerDayUsd: 0.04, after: TWO_BORROWS_TARGET,
      steps: [
        {
          round: 1, kind: 'round', buy: 661.13, move: 661.13, arrives: 661.08, borrowLeft: 132.0, seconds: 130,
          from: 'CROSSEX', to: 'HYPERLIQUID',
        },
        {
          round: 2, kind: 'round', buy: 207.91, move: 207.91, arrives: 206.88, borrowLeft: 0, seconds: 230,
          from: 'CROSSEX', to: 'LIGHTER',
        },
      ],
    },
    convert: {
      available: true, reason: null, costUsd: 1.73, seconds: 0, rounds: 0, oneMoreRoundCostUsd: null,
      marginFreedUsd: 48.8, savesPerDayUsd: 0.04, after: TWO_BORROWS_TARGET,
      steps: [
        {
          round: null, kind: 'convert', buy: 0, move: 662.4, arrives: 661.08, borrowLeft: 132.0, seconds: 0,
          from: 'CROSSEX', to: 'HYPERLIQUID',
        },
        {
          round: null, kind: 'convert', buy: 0, move: 207.29, arrives: 206.88, borrowLeft: 0, seconds: 0,
          from: 'CROSSEX', to: 'LIGHTER',
        },
      ],
    },
  },
  recommended: 'loop',
};

const ONE_BORROW_BUCKETS: RebalanceBucket[] = [
  {
    coin: 'USDT', venue: 'CROSSEX', cash: 687.53, upnl: 104.47, equity: 792.0, borrow: 0, imHeldUsd: 0,
    mmHeldUsd: 0, interestPaidUsd: 0, interestPerDayUsd: 0,
  },
  {
    coin: 'USDC', venue: 'HYPERLIQUID', cash: 496.14, upnl: 91.78, equity: 587.92, borrow: 0, imHeldUsd: 0,
    mmHeldUsd: 0, interestPaidUsd: 0, interestPerDayUsd: 0,
  },
  {
    coin: 'USDC', venue: 'LIGHTER', cash: -120.0, upnl: -12.0, equity: -132.0, borrow: 132.0, imHeldUsd: 26.4,
    mmHeldUsd: 13.2, interestPaidUsd: 0, interestPerDayUsd: 0.0396,
  },
];

const ONE_BORROW_TARGET: WalletAfter[] = [
  { coin: 'USDT', venue: 'CROSSEX', cash: 479.62, equity: 584.09 },
  { coin: 'USDC', venue: 'HYPERLIQUID', cash: 496.14, equity: 587.92 },
  { coin: 'USDC', venue: 'LIGHTER', cash: 86.88, equity: 74.88 },
];

const ONE_BORROW_PLAN: EvenPlan = {
  balanced: false, noLegs: false, moves: 206.88, shortOfEven: 0, roundCap: 6, split: TWO_BORROWS_SPLIT,
  routes: {
    mix: null,
    loop: {
      available: true, reason: null, costUsd: 1.03, seconds: 230, rounds: 1, oneMoreRoundCostUsd: null,
      marginFreedUsd: 26.4, savesPerDayUsd: 0.04, after: ONE_BORROW_TARGET,
      steps: [
        {
          round: 1, kind: 'round', buy: 207.91, move: 207.91, arrives: 206.88, borrowLeft: 0, seconds: 230,
          from: 'CROSSEX', to: 'LIGHTER',
        },
      ],
    },
    convert: {
      available: true, reason: null, costUsd: 0.41, seconds: 0, rounds: 0, oneMoreRoundCostUsd: null,
      marginFreedUsd: 26.4, savesPerDayUsd: 0.04,
      after: [
        { coin: 'USDT', venue: 'CROSSEX', cash: 480.24, equity: 584.71 },
        { coin: 'USDC', venue: 'HYPERLIQUID', cash: 496.14, equity: 587.92 },
        { coin: 'USDC', venue: 'LIGHTER', cash: 86.88, equity: 74.88 },
      ],
      steps: [
        {
          round: null, kind: 'convert', buy: 0, move: 207.29, arrives: 206.88, borrowLeft: 0, seconds: 0,
          from: 'CROSSEX', to: 'LIGHTER',
        },
      ],
    },
  },
  recommended: 'loop',
};

const HYPERLIQUID_FREE_BORROW_BUCKETS: RebalanceBucket[] = [
  {
    coin: 'USDT', venue: 'CROSSEX', cash: 8400.0, upnl: 0, equity: 8400.0, borrow: 0, imHeldUsd: 0, mmHeldUsd: 0,
    interestPaidUsd: 0, interestPerDayUsd: 0,
  },
  {
    coin: 'USDC', venue: 'HYPERLIQUID', cash: -4200.0, upnl: 0, equity: -4200.0, borrow: 4200.0, imHeldUsd: 840.0,
    mmHeldUsd: 420.0, interestPaidUsd: 0, interestPerDayUsd: 0,
  },
];

const HYPERLIQUID_FREE_BORROW_TARGET: WalletAfter[] = [
  { coin: 'USDT', venue: 'CROSSEX', cash: 2800.14, equity: 2800.14 },
  { coin: 'USDC', venue: 'HYPERLIQUID', cash: 1399.86, equity: 1399.86 },
];

const HYPERLIQUID_FREE_BORROW_PLAN: EvenPlan = {
  balanced: false, noLegs: false, moves: 5599.91, shortOfEven: 0, roundCap: 6,
  split: [
    { coin: 'USDT', venue: 'CROSSEX', notionalUsd: 8400.0, share: 0.6667 },
    { coin: 'USDC', venue: 'HYPERLIQUID', notionalUsd: 4200.0, share: 0.3333 },
  ],
  routes: {
    mix: null,
    loop: {
      available: true, reason: null, costUsd: 0.05, seconds: 130, rounds: 1, oneMoreRoundCostUsd: null,
      marginFreedUsd: 840.0, savesPerDayUsd: 0, after: HYPERLIQUID_FREE_BORROW_TARGET,
      steps: [
        {
          round: 1, kind: 'round', buy: 5599.91, move: 5599.91, arrives: 5599.86, borrowLeft: 0, seconds: 130,
          from: 'CROSSEX', to: 'HYPERLIQUID',
        },
      ],
    },
    convert: {
      available: true, reason: null, costUsd: 11.2, seconds: 0, rounds: 0, oneMoreRoundCostUsd: null,
      marginFreedUsd: 840.0, savesPerDayUsd: 0, after: HYPERLIQUID_FREE_BORROW_TARGET,
      steps: [
        {
          round: null, kind: 'convert', buy: 0, move: 5611.06, arrives: 5599.86, borrowLeft: 0, seconds: 0,
          from: 'CROSSEX', to: 'HYPERLIQUID',
        },
      ],
    },
  },
  recommended: 'loop',
};

const GAIN_OVER_NEGATIVE_CASH_BUCKETS: RebalanceBucket[] = [
  {
    coin: 'USDC', venue: 'LIGHTER', cash: -40.0, upnl: 55.0, equity: 15.0, borrow: 0, imHeldUsd: 0, mmHeldUsd: 0,
    interestPaidUsd: 0, interestPerDayUsd: 0,
  },
];

const GAIN_OVER_NEGATIVE_CASH_PLAN: EvenPlan = {
  balanced: true, noLegs: false, moves: 0, shortOfEven: 0, roundCap: 0,
  split: [{ coin: 'USDC', venue: 'LIGHTER', notionalUsd: 15.0, share: 1 }],
  routes: {
    mix: null,
    loop: {
      available: false, reason: null, costUsd: 0, seconds: 0, rounds: 0, oneMoreRoundCostUsd: null,
      marginFreedUsd: 0, savesPerDayUsd: 0, after: [{ coin: 'USDC', venue: 'LIGHTER', cash: -40.0, equity: 15.0 }],
      steps: [],
    },
    convert: {
      available: false, reason: null, costUsd: 0, seconds: 0, rounds: 0, oneMoreRoundCostUsd: null,
      marginFreedUsd: 0, savesPerDayUsd: 0, after: [{ coin: 'USDC', venue: 'LIGHTER', cash: -40.0, equity: 15.0 }],
      steps: [],
    },
  },
  recommended: null,
};

const INTEREST_PAID_SPLIT_BUCKETS: RebalanceBucket[] = [
  {
    coin: 'USDT', venue: 'CROSSEX', cash: 900.0, upnl: 0, equity: 900.0, borrow: 0, imHeldUsd: 0, mmHeldUsd: 0,
    interestPaidUsd: 0, interestPerDayUsd: 0,
  },
  {
    coin: 'USDC', venue: 'HYPERLIQUID', cash: 300.0, upnl: 0, equity: 300.0, borrow: 0, imHeldUsd: 0, mmHeldUsd: 0,
    interestPaidUsd: 0.31, interestPerDayUsd: 0,
  },
  {
    coin: 'USDC', venue: 'LIGHTER', cash: 200.0, upnl: 0, equity: 200.0, borrow: 0, imHeldUsd: 0, mmHeldUsd: 0,
    interestPaidUsd: 1.55, interestPerDayUsd: 0,
  },
];

const INTEREST_PAID_SPLIT_AFTER: WalletAfter[] = [
  { coin: 'USDT', venue: 'CROSSEX', cash: 900.0, equity: 900.0 },
  { coin: 'USDC', venue: 'HYPERLIQUID', cash: 300.0, equity: 300.0 },
  { coin: 'USDC', venue: 'LIGHTER', cash: 200.0, equity: 200.0 },
];

const INTEREST_PAID_SPLIT_PLAN: EvenPlan = {
  balanced: true, noLegs: false, moves: 0, shortOfEven: 0, roundCap: 0,
  split: [
    { coin: 'USDT', venue: 'CROSSEX', notionalUsd: 899.92, share: 0.6428 },
    { coin: 'USDC', venue: 'HYPERLIQUID', notionalUsd: 300.02, share: 0.2143 },
    { coin: 'USDC', venue: 'LIGHTER', notionalUsd: 200.06, share: 0.1429 },
  ],
  routes: {
    mix: null,
    loop: {
      available: false, reason: null, costUsd: 0, seconds: 0, rounds: 0, oneMoreRoundCostUsd: null,
      marginFreedUsd: 0, savesPerDayUsd: 0, after: INTEREST_PAID_SPLIT_AFTER, steps: [],
    },
    convert: {
      available: false, reason: null, costUsd: 0, seconds: 0, rounds: 0, oneMoreRoundCostUsd: null,
      marginFreedUsd: 0, savesPerDayUsd: 0, after: INTEREST_PAID_SPLIT_AFTER, steps: [],
    },
  },
  recommended: null,
};

const ONE_ROUTE_ONLY_BUCKETS: RebalanceBucket[] = [
  {
    coin: 'USDT', venue: 'CROSSEX', cash: 300.0, upnl: 0, equity: 300.0, borrow: 0, imHeldUsd: 0, mmHeldUsd: 0,
    interestPaidUsd: 0, interestPerDayUsd: 0,
  },
  {
    coin: 'USDC', venue: 'HYPERLIQUID', cash: 10.0, upnl: 150.0, equity: 160.0, borrow: 0, imHeldUsd: 0,
    mmHeldUsd: 0, interestPaidUsd: 0, interestPerDayUsd: 0,
  },
];

const ONE_ROUTE_ONLY_PLAN: EvenPlan = {
  balanced: false, noLegs: false, moves: 10.0, shortOfEven: 5, roundCap: 1,
  split: [
    { coin: 'USDT', venue: 'CROSSEX', notionalUsd: 300.01, share: 0.6522 },
    { coin: 'USDC', venue: 'HYPERLIQUID', notionalUsd: 159.99, share: 0.3478 },
  ],
  routes: {
    mix: null,
    loop: null,
    convert: {
      available: true, reason: null, costUsd: 0.02, seconds: 0, rounds: 0, oneMoreRoundCostUsd: null,
      marginFreedUsd: 0, savesPerDayUsd: 0,
      after: [
        { coin: 'USDT', venue: 'CROSSEX', cash: 310.0, equity: 310.0 },
        { coin: 'USDC', venue: 'HYPERLIQUID', cash: 0, equity: 150.0 },
      ],
      steps: [
        {
          round: null, kind: 'convert', buy: 0, move: 10.02, arrives: 10.0, borrowLeft: 0, seconds: 0,
          from: 'HYPERLIQUID', to: 'CROSSEX',
        },
      ],
    },
  },
  recommended: 'convert',
};

const HIDDEN_ROUTE_BUCKETS: RebalanceBucket[] = [
  {
    coin: 'USDT', venue: 'CROSSEX', cash: 400.0, upnl: 0, equity: 400.0, borrow: 0, imHeldUsd: 0, mmHeldUsd: 0,
    interestPaidUsd: 0, interestPerDayUsd: 0,
  },
  {
    coin: 'USDC', venue: 'HYPERLIQUID', cash: 100.0, upnl: 0, equity: 100.0, borrow: 0, imHeldUsd: 0, mmHeldUsd: 0,
    interestPaidUsd: 0, interestPerDayUsd: 0,
  },
];

const HIDDEN_ROUTE_TARGET: WalletAfter[] = [
  { coin: 'USDT', venue: 'CROSSEX', cash: 250.0, equity: 250.0 },
  { coin: 'USDC', venue: 'HYPERLIQUID', cash: 250.0, equity: 250.0 },
];

const HIDDEN_ROUTE_PLAN: EvenPlan = {
  balanced: false, noLegs: false, moves: 150.0, shortOfEven: 0, roundCap: 1,
  split: [
    { coin: 'USDT', venue: 'CROSSEX', notionalUsd: 350.0, share: 0.7 },
    { coin: 'USDC', venue: 'HYPERLIQUID', notionalUsd: 150.0, share: 0.3 },
  ],
  routes: {
    mix: null,
    loop: {
      available: false, reason: 'Gate paused USDC transfers.', costUsd: 0, seconds: 0, rounds: 0,
      oneMoreRoundCostUsd: null, marginFreedUsd: 0, savesPerDayUsd: 0, after: HIDDEN_ROUTE_TARGET, steps: [],
    },
    convert: {
      available: true, reason: null, costUsd: 0.3, seconds: 0, rounds: 0, oneMoreRoundCostUsd: null,
      marginFreedUsd: 0, savesPerDayUsd: 0, after: HIDDEN_ROUTE_TARGET,
      steps: [
        {
          round: null, kind: 'convert', buy: 0, move: 150.3, arrives: 150.0, borrowLeft: 0, seconds: 0,
          from: 'CROSSEX', to: 'HYPERLIQUID',
        },
      ],
    },
  },
  recommended: 'convert',
};

export const rebalanceViews = {
  accountA: { buckets: ACCOUNT_A_BUCKETS, plan: ACCOUNT_A_PLAN, job: null },
  accountARunning: { buckets: ACCOUNT_A_ROUND_3_BUCKETS, plan: ACCOUNT_A_ROUND_3_PLAN, job: ACCOUNT_A_RUNNING_JOB },
  accountAHalted: { buckets: ACCOUNT_A_ROUND_3_BUCKETS, plan: ACCOUNT_A_ROUND_3_PLAN, job: ACCOUNT_A_HALTED_JOB },
  accountAAbandoned: {
    buckets: ACCOUNT_A_ROUND_3_BUCKETS, plan: ACCOUNT_A_ROUND_3_PLAN,
    job: { ...ACCOUNT_A_HALTED_JOB, status: 'abandoned' },
  },
  accountABlocked: { buckets: ACCOUNT_A_BUCKETS, plan: ACCOUNT_A_PAUSED_PLAN, job: null },
  accountB: {
    buckets: ACCOUNT_B_BUCKETS,
    plan: {
      balanced: false, noLegs: false, moves: 477.29, shortOfEven: 0, roundCap: 6, split: EVEN_SPLIT,
      routes: {
        mix: null,
        loop: {
          available: true, reason: null, costUsd: 0.1, seconds: 130, rounds: 1, oneMoreRoundCostUsd: null,
          marginFreedUsd: 0, savesPerDayUsd: 0,
          after: [
            { coin: 'USDT', venue: 'CROSSEX', cash: 509.27, equity: 493.88 },
            { coin: 'USDC', venue: 'HYPERLIQUID', cash: 489.12, equity: 494.15 },
            { coin: 'USDC', venue: 'GATE', cash: 0.29, equity: 0.29 },
          ],
          steps: [
            { round: 1, kind: 'round', buy: 477.29, move: 477.29, arrives: 477.24, borrowLeft: 0, seconds: 130, ...TO_HYPERLIQUID },
          ],
        },
        convert: {
          available: true, reason: null, costUsd: 0.96, seconds: 0, rounds: 0, oneMoreRoundCostUsd: null,
          marginFreedUsd: 0, savesPerDayUsd: 0,
          after: [
            { coin: 'USDT', venue: 'CROSSEX', cash: 508.84, equity: 493.45 },
            { coin: 'USDC', venue: 'HYPERLIQUID', cash: 488.69, equity: 493.72 },
            { coin: 'USDC', venue: 'GATE', cash: 0.29, equity: 0.29 },
          ],
          steps: [
            { round: null, kind: 'convert', buy: 0, move: 477.77, arrives: 476.81, borrowLeft: 0, seconds: 0, ...TO_HYPERLIQUID },
          ],
        },
      },
      recommended: 'loop',
    },
    job: null,
  },
  exampleC: {
    buckets: [
      {
        coin: 'USDT', venue: 'CROSSEX', cash: 165.45, upnl: 0, equity: 165.45, borrow: 0, imHeldUsd: 0, mmHeldUsd: 0,
        interestPaidUsd: 0, interestPerDayUsd: 0,
      },
      {
        coin: 'USDC', venue: 'HYPERLIQUID', cash: 22.18, upnl: 203.64, equity: 225.82, borrow: 0, imHeldUsd: 0,
        mmHeldUsd: 0, interestPaidUsd: 0, interestPerDayUsd: 0,
      },
      {
        coin: 'USDC', venue: 'GATE', cash: 0, upnl: 0, equity: 0, borrow: 0, imHeldUsd: 0, mmHeldUsd: 0,
        interestPaidUsd: 0, interestPerDayUsd: 0,
      },
    ],
    plan: {
      balanced: false, noLegs: false, moves: 22.18, shortOfEven: 8, roundCap: 2, split: EVEN_SPLIT,
      routes: {
        mix: null,
        loop: null,
        convert: {
          available: true, reason: null, costUsd: 0.04, seconds: 0, rounds: 0, oneMoreRoundCostUsd: null,
          marginFreedUsd: 0, savesPerDayUsd: 0,
          after: [
            { coin: 'USDT', venue: 'CROSSEX', cash: 187.58, equity: 187.58 },
            { coin: 'USDC', venue: 'HYPERLIQUID', cash: 0, equity: 203.64 },
            { coin: 'USDC', venue: 'GATE', cash: 0, equity: 0 },
          ],
          steps: [
            { round: null, kind: 'convert', buy: 0, move: 22.18, arrives: 22.13, borrowLeft: 0, seconds: 0, ...FROM_HYPERLIQUID },
          ],
        },
      },
      recommended: 'convert',
    },
    job: null,
  },
  exampleD: {
    buckets: EXAMPLE_D_BUCKETS,
    plan: {
      balanced: false, noLegs: false, moves: 10854.58, shortOfEven: 0, roundCap: 6, split: EVEN_SPLIT,
      routes: {
        mix: EXAMPLE_D_MIX,
        loop: null,
        convert: {
          available: true, reason: null, costUsd: 21.72, seconds: 0, rounds: 0, oneMoreRoundCostUsd: null,
          marginFreedUsd: 1922.48, savesPerDayUsd: 0,
          after: [
            { coin: 'USDT', venue: 'CROSSEX', cash: 1223.83, equity: 1223.83 },
            { coin: 'USDC', venue: 'HYPERLIQUID', cash: 1223.82, equity: 1223.82 },
            { coin: 'USDC', venue: 'GATE', cash: 0, equity: 0 },
          ],
          steps: [
            { round: null, kind: 'convert', buy: 0, move: 10857.94, arrives: 10836.22, borrowLeft: 0, seconds: 0, ...TO_HYPERLIQUID },
          ],
        },
      },
      recommended: 'mix',
    },
    job: null,
  },
  exampleE: {
    buckets: EXAMPLE_E_BUCKETS,
    plan: {
      balanced: false, noLegs: false, moves: 1228.27, shortOfEven: 0, roundCap: 2, split: EVEN_SPLIT,
      routes: {
        mix: {
          available: true, reason: null, costUsd: 2.04, seconds: 400, rounds: 1, oneMoreRoundCostUsd: 2.12,
          marginFreedUsd: 122.47, savesPerDayUsd: 0.09,
          after: [
            { coin: 'USDT', venue: 'CROSSEX', cash: 613.87, equity: 613.87 },
            { coin: 'USDC', venue: 'HYPERLIQUID', cash: 613.89, equity: 613.89 },
            { coin: 'USDC', venue: 'GATE', cash: 0, equity: 0 },
          ],
          steps: [
            { round: 1, kind: 'round', buy: 0, move: 745.44, arrives: 744.44, borrowLeft: 0, seconds: 400, ...FROM_HYPERLIQUID },
            { round: null, kind: 'convert', buy: 0, move: 482.83, arrives: 481.86, borrowLeft: 0, seconds: 0, ...FROM_HYPERLIQUID },
          ],
        },
        loop: null,
        convert: {
          available: true, reason: null, costUsd: 2.46, seconds: 0, rounds: 0, oneMoreRoundCostUsd: null,
          marginFreedUsd: 122.47, savesPerDayUsd: 0.09,
          after: [
            { coin: 'USDT', venue: 'CROSSEX', cash: 613.67, equity: 613.67 },
            { coin: 'USDC', venue: 'HYPERLIQUID', cash: 613.68, equity: 613.68 },
            { coin: 'USDC', venue: 'GATE', cash: 0, equity: 0 },
          ],
          steps: [
            { round: null, kind: 'convert', buy: 0, move: 1228.48, arrives: 1226.02, borrowLeft: 0, seconds: 0, ...FROM_HYPERLIQUID },
          ],
        },
      },
      recommended: 'mix',
    },
    job: null,
  },
  balancedDone: { buckets: BALANCED_BUCKETS, plan: BALANCED_PLAN, job: BALANCED_DONE_JOB },
  oldDone: { buckets: BALANCED_BUCKETS, plan: BALANCED_PLAN, job: OLD_DONE_JOB },
  exampleERunning: { buckets: EXAMPLE_E_MID_BUCKETS, plan: EXAMPLE_E_MID_PLAN, job: EXAMPLE_E_JOB },
  exampleEAbandoned: { buckets: EXAMPLE_E_MID_BUCKETS, plan: EXAMPLE_E_MID_PLAN, job: EXAMPLE_E_ABANDONED_JOB },
  exampleDRunningConvert: { buckets: EXAMPLE_D_MID_BUCKETS, plan: EXAMPLE_D_MID_PLAN, job: EXAMPLE_D_CONVERT_JOB },
  exampleDHaltedConvert: {
    buckets: EXAMPLE_D_MID_BUCKETS, plan: EXAMPLE_D_MID_PLAN,
    job: {
      ...EXAMPLE_D_CONVERT_JOB, status: 'halted', haltReason: 'Convert quote was more than 0.3% under market.',
      updatedAt: REBALANCE_NOW - 2_000,
    },
  },
  haltedInside: { buckets: ACCOUNT_A_INSIDE_BUCKETS, plan: ACCOUNT_A_INSIDE_PLAN, job: HALTED_INSIDE_JOB },
  mixDone: { buckets: MIX_DONE_BUCKETS, plan: balancedPlan(EXAMPLE_D_MIX.after), job: MIX_DONE_JOB },
  convertDone: { buckets: CONVERT_DONE_BUCKETS, plan: balancedPlan(ACCOUNT_A_CONVERT.after), job: CONVERT_DONE_JOB },
  balancedNoJob: { buckets: BALANCED_BUCKETS, plan: BALANCED_PLAN, job: null },
  spotClosed: {
    buckets: ACCOUNT_A_BUCKETS, plan: withLoopReason(ACCOUNT_A_PAUSED_PLAN, 'The spot market for USDC is closed.'),
    job: null,
  },
  underMinimum: {
    buckets: ACCOUNT_A_BUCKETS, plan: withLoopReason(ACCOUNT_A_PAUSED_PLAN, 'The move is under the 11 USDC minimum.'),
    job: null,
  },
  borrowUnderOne: { buckets: BORROW_UNDER_ONE_BUCKETS, plan: BORROW_UNDER_ONE_PLAN, job: null },
  accountADone: { buckets: ACCOUNT_A_BUCKETS, plan: ACCOUNT_A_PLAN, job: CONVERT_DONE_JOB },
  lighterSplit: { buckets: LIGHTER_SPLIT_BUCKETS, plan: LIGHTER_SPLIT_PLAN, job: null },
  lighterAcross: { buckets: LIGHTER_ACROSS_BUCKETS, plan: LIGHTER_ACROSS_PLAN, job: null },
  lighterAcrossRunning: {
    buckets: rebased(LIGHTER_ACROSS_BUCKETS, { 'USDC/HYPERLIQUID': { cash: 0, equity: 0 } }), plan: LIGHTER_ACROSS_PLAN,
    job: LIGHTER_ACROSS_RUNNING_JOB,
  },
  lighterAcrossAbandoned: {
    buckets: rebased(LIGHTER_ACROSS_BUCKETS, { 'USDC/HYPERLIQUID': { cash: 0, equity: 0 } }), plan: LIGHTER_ACROSS_PLAN,
    job: LIGHTER_ACROSS_ABANDONED_JOB,
  },
  lighterConvertDone: {
    buckets: rebased(LIGHTER_ACROSS_BUCKETS, {
      'USDC/HYPERLIQUID': { cash: 0, equity: 0 },
      'USDC/LIGHTER': { cash: 498, equity: 498 },
    }),
    plan: {
      ...balancedPlan(LIGHTER_ACROSS_PLAN.routes.convert.after),
      split: LIGHTER_ACROSS_PLAN.split.filter((share) => share.share > 0),
    },
    job: LIGHTER_CONVERT_DONE_JOB,
  },
  noLegs: { buckets: LIGHTER_SPLIT_BUCKETS, plan: NO_LEGS_PLAN, job: null },
  twoBorrows: { buckets: TWO_BORROWS_BUCKETS, plan: TWO_BORROWS_PLAN, job: null },
  oneBorrow: { buckets: ONE_BORROW_BUCKETS, plan: ONE_BORROW_PLAN, job: null },
  hyperliquidFreeBorrow: { buckets: HYPERLIQUID_FREE_BORROW_BUCKETS, plan: HYPERLIQUID_FREE_BORROW_PLAN, job: null },
  gainOverNegativeCash: { buckets: GAIN_OVER_NEGATIVE_CASH_BUCKETS, plan: GAIN_OVER_NEGATIVE_CASH_PLAN, job: null },
  interestPaidSplit: { buckets: INTEREST_PAID_SPLIT_BUCKETS, plan: INTEREST_PAID_SPLIT_PLAN, job: null },
  oneRouteOnly: { buckets: ONE_ROUTE_ONLY_BUCKETS, plan: ONE_ROUTE_ONLY_PLAN, job: null },
  hiddenRoute: { buckets: HIDDEN_ROUTE_BUCKETS, plan: HIDDEN_ROUTE_PLAN, job: null },
} satisfies Record<string, RebalanceView>;

const ACCOUNT_B_SPOT: SpotBalance[] = [
  { coin: 'USDT', available: 318.42, locked: 0 },
  { coin: 'USDC', available: 0, locked: 0 },
];

const ACCOUNT_B_PATHS: TransferPath[] = [
  { coin: 'USDT', from: 'SPOT', to: 'CROSSEX', max: 318.42, min: 0.00001, feeUsd: 0, seconds: 3 },
  { coin: 'USDT', from: 'CROSSEX', to: 'SPOT', max: 816.1, min: 0.00001, feeUsd: 0, seconds: 3 },
  { coin: 'USDC', from: 'SPOT', to: 'CROSSEX_GATE', max: 0, min: 0.00001, feeUsd: 0, seconds: 5 },
  { coin: 'USDC', from: 'CROSSEX_GATE', to: 'SPOT', max: 0.29, min: 0.00001, feeUsd: 0, seconds: 5 },
  { coin: 'USDC', from: 'SPOT', to: 'CROSSEX_HYPERLIQUID', max: 0, min: 11, feeUsd: 0.05, seconds: 120 },
  { coin: 'USDC', from: 'CROSSEX_HYPERLIQUID', to: 'SPOT', max: 11.88, min: 11, feeUsd: 1, seconds: 400 },
  { coin: 'USDC', from: 'SPOT', to: 'CROSSEX_LIGHTER', max: 0, min: 11, feeUsd: 1.03, seconds: 230 },
  { coin: 'USDC', from: 'CROSSEX_LIGHTER', to: 'SPOT', max: 0, min: 11, feeUsd: 0, seconds: 180 },
];

const NO_SPOT_PATHS: TransferPath[] = [
  { coin: 'USDT', from: 'SPOT', to: 'CROSSEX', max: null, min: 0.00001, feeUsd: 0, seconds: 3 },
  { coin: 'USDT', from: 'CROSSEX', to: 'SPOT', max: 816.1, min: 0.00001, feeUsd: 0, seconds: 3 },
  { coin: 'USDC', from: 'SPOT', to: 'CROSSEX_GATE', max: null, min: 0.00001, feeUsd: 0, seconds: 5 },
  { coin: 'USDC', from: 'CROSSEX_GATE', to: 'SPOT', max: 0.29, min: 0.00001, feeUsd: 0, seconds: 5 },
  { coin: 'USDC', from: 'SPOT', to: 'CROSSEX_HYPERLIQUID', max: null, min: 11, feeUsd: 0.05, seconds: 120 },
  { coin: 'USDC', from: 'CROSSEX_HYPERLIQUID', to: 'SPOT', max: 11.88, min: 11, feeUsd: 1, seconds: 400 },
  { coin: 'USDC', from: 'SPOT', to: 'CROSSEX_LIGHTER', max: null, min: 11, feeUsd: 1.03, seconds: 230 },
  { coin: 'USDC', from: 'CROSSEX_LIGHTER', to: 'SPOT', max: 0, min: 11, feeUsd: 0, seconds: 180 },
];

const MOVING_TRANSFER: TransferJob = {
  id: 'mtzur1jk', coin: 'USDC', from: 'CROSSEX_HYPERLIQUID', to: 'SPOT', amount: 11.88, status: 'moving',
  received: null, failText: null, createdAt: REBALANCE_NOW - 130_000, doneAt: null,
};

const FAILED_TRANSFER: TransferJob = { ...MOVING_TRANSFER, status: 'failed', failText: 'Transfer failed: x.' };

const FAILED_OVER_CAP_TRANSFER: TransferJob = {
  id: 'mtzwovrcap', coin: 'USDC', from: 'CROSSEX_HYPERLIQUID', to: 'SPOT', amount: 442.02, status: 'failed',
  received: null, failText: 'Insufficient transferAvailable, transferAvailable: 292.0185407',
  createdAt: REBALANCE_NOW - 130_000, doneAt: REBALANCE_NOW - 60_000,
};

const FAILED_OVER_CAP_PATHS: TransferPath[] = ACCOUNT_B_PATHS.map((path) =>
  path.coin === 'USDC' && path.from === 'CROSSEX_HYPERLIQUID' && path.to === 'SPOT' ? { ...path, max: 292.02 } : path,
);

function withSpot(spot: SpotBalance[]): TransferView {
  const paths = ACCOUNT_B_PATHS.map((path) =>
    path.from === 'SPOT' ? { ...path, max: spot.find((balance) => balance.coin === path.coin)?.available ?? 0 } : path,
  );
  return { spot, paths, lock: null, transfer: null };
}

export const transferViews = {
  accountB: { spot: ACCOUNT_B_SPOT, paths: ACCOUNT_B_PATHS, lock: null, transfer: null },
  noSpot: { spot: null, paths: NO_SPOT_PATHS, lock: null, transfer: null },
  moving: { spot: ACCOUNT_B_SPOT, paths: ACCOUNT_B_PATHS, lock: null, transfer: MOVING_TRANSFER },
  lockRebalance: { spot: ACCOUNT_B_SPOT, paths: ACCOUNT_B_PATHS, lock: 'rebalance', transfer: null },
  lockHalted: { spot: ACCOUNT_B_SPOT, paths: ACCOUNT_B_PATHS, lock: 'halted', transfer: null },
  lockDeal: { spot: ACCOUNT_B_SPOT, paths: ACCOUNT_B_PATHS, lock: 'deal', transfer: null },
  failed: { spot: ACCOUNT_B_SPOT, paths: ACCOUNT_B_PATHS, lock: null, transfer: FAILED_TRANSFER },
  done: {
    spot: ACCOUNT_B_SPOT, paths: ACCOUNT_B_PATHS, lock: null,
    transfer: { ...MOVING_TRANSFER, status: 'done', received: 10.88, doneAt: REBALANCE_NOW + 270_000 },
  },
  spotDust: withSpot([
    { coin: 'USDT', available: 0.8, locked: 0 },
    { coin: 'USDC', available: 0, locked: 0 },
  ]),
  spotBoth: withSpot([
    { coin: 'USDT', available: 318.42, locked: 0 },
    { coin: 'USDC', available: 25, locked: 0 },
  ]),
  spotLocked: withSpot([
    { coin: 'USDT', available: 300, locked: 18.42 },
    { coin: 'USDC', available: 0, locked: 0 },
  ]),
  spotZero: withSpot([
    { coin: 'USDT', available: 0, locked: 0 },
    { coin: 'USDC', available: 0, locked: 0 },
  ]),
  movingDeal: { spot: ACCOUNT_B_SPOT, paths: ACCOUNT_B_PATHS, lock: 'deal', transfer: MOVING_TRANSFER },
  failedLocked: { spot: ACCOUNT_B_SPOT, paths: ACCOUNT_B_PATHS, lock: 'rebalance', transfer: FAILED_TRANSFER },
  failedOverCap: { spot: ACCOUNT_B_SPOT, paths: FAILED_OVER_CAP_PATHS, lock: null, transfer: FAILED_OVER_CAP_TRANSFER },
  failedAndRebalanceRunning: {
    spot: ACCOUNT_B_SPOT, paths: FAILED_OVER_CAP_PATHS, lock: 'rebalance', transfer: FAILED_OVER_CAP_TRANSFER,
  },
} satisfies Record<string, TransferView>;

const ACCOUNT_ASSETS = {
  accountA: [
    {
      coin: 'USDT', exchangeType: 'CROSSEX', balance: '92.54', availableBalance: '92.54', upnl: '0', equity: '92.54',
      liability: '0', borrowingInitialMargin: '0', borrowingMaintenanceMargin: '0',
    },
    {
      coin: 'USDC', exchangeType: 'HYPERLIQUID', balance: '-147.05', availableBalance: '0', upnl: '0',
      equity: '-147.05', liability: '147.05', borrowingInitialMargin: '29.41', borrowingMaintenanceMargin: '14.705',
    },
    {
      coin: 'USDC', exchangeType: 'GATE', balance: '111.96', availableBalance: '111.96', upnl: '0', equity: '111.96',
      liability: '0', borrowingInitialMargin: '0', borrowingMaintenanceMargin: '0',
    },
  ],
  accountARound3: [
    {
      coin: 'USDT', exchangeType: 'CROSSEX', balance: '92.54', availableBalance: '92.54', upnl: '0', equity: '92.54',
      liability: '0', borrowingInitialMargin: '0', borrowingMaintenanceMargin: '0',
    },
    {
      coin: 'USDC', exchangeType: 'HYPERLIQUID', balance: '-92.71', availableBalance: '0', upnl: '0', equity: '-92.71',
      liability: '92.71', borrowingInitialMargin: '18.542', borrowingMaintenanceMargin: '9.271',
    },
    {
      coin: 'USDC', exchangeType: 'GATE', balance: '20.94', availableBalance: '20.94', upnl: '0', equity: '20.94',
      liability: '0', borrowingInitialMargin: '0', borrowingMaintenanceMargin: '0',
    },
  ],
  accountB: [
    {
      coin: 'USDT', exchangeType: 'CROSSEX', balance: '986.61', availableBalance: '986.61', upnl: '-15.39',
      equity: '971.22', liability: '0', borrowingInitialMargin: '0', borrowingMaintenanceMargin: '0',
    },
    {
      coin: 'USDC', exchangeType: 'HYPERLIQUID', balance: '11.88', availableBalance: '11.88', upnl: '5.03',
      equity: '16.91', liability: '0', borrowingInitialMargin: '0', borrowingMaintenanceMargin: '0',
    },
    {
      coin: 'USDC', exchangeType: 'GATE', balance: '0.29', availableBalance: '0.29', upnl: '0', equity: '0.29',
      liability: '0', borrowingInitialMargin: '0', borrowingMaintenanceMargin: '0',
    },
  ],
  exampleC: [
    {
      coin: 'USDT', exchangeType: 'CROSSEX', balance: '165.45', availableBalance: '165.45', upnl: '0', equity: '165.45',
      liability: '0', borrowingInitialMargin: '0', borrowingMaintenanceMargin: '0',
    },
    {
      coin: 'USDC', exchangeType: 'HYPERLIQUID', balance: '22.18', availableBalance: '22.18', upnl: '203.64',
      equity: '225.82', liability: '0', borrowingInitialMargin: '0', borrowingMaintenanceMargin: '0',
    },
    {
      coin: 'USDC', exchangeType: 'GATE', balance: '0', availableBalance: '0', upnl: '0', equity: '0', liability: '0',
      borrowingInitialMargin: '0', borrowingMaintenanceMargin: '0',
    },
  ],
  exampleD: [
    {
      coin: 'USDT', exchangeType: 'CROSSEX', balance: '12081.77', availableBalance: '12081.77', upnl: '0',
      equity: '12081.77', liability: '0', borrowingInitialMargin: '0', borrowingMaintenanceMargin: '0',
    },
    {
      coin: 'USDC', exchangeType: 'HYPERLIQUID', balance: '-9612.4', availableBalance: '0', upnl: '0',
      equity: '-9612.4', liability: '9612.4', borrowingInitialMargin: '1922.48', borrowingMaintenanceMargin: '961.24',
    },
    {
      coin: 'USDC', exchangeType: 'GATE', balance: '0', availableBalance: '0', upnl: '0', equity: '0', liability: '0',
      borrowingInitialMargin: '0', borrowingMaintenanceMargin: '0',
    },
  ],
  lighter: [
    {
      coin: 'USDT', exchangeType: 'CROSSEX', balance: '1000', availableBalance: '1000', upnl: '0', equity: '1000',
      liability: '0', borrowingInitialMargin: '0', borrowingMaintenanceMargin: '0',
    },
    {
      coin: 'USDC', exchangeType: 'HYPERLIQUID', balance: '0', availableBalance: '0', upnl: '0', equity: '0',
      liability: '0', borrowingInitialMargin: '0', borrowingMaintenanceMargin: '0',
    },
    {
      coin: 'USDC', exchangeType: 'LIGHTER', balance: '0', availableBalance: '0', upnl: '0', equity: '0',
      liability: '0', borrowingInitialMargin: '0', borrowingMaintenanceMargin: '0',
    },
    {
      coin: 'USDC', exchangeType: 'GATE', balance: '0', availableBalance: '0', upnl: '0', equity: '0', liability: '0',
      borrowingInitialMargin: '0', borrowingMaintenanceMargin: '0',
    },
  ],
  exampleE: [
    {
      coin: 'USDT', exchangeType: 'CROSSEX', balance: '-612.35', availableBalance: '0', upnl: '0', equity: '-612.35',
      liability: '612.35', borrowingInitialMargin: '122.47', borrowingMaintenanceMargin: '61.235',
    },
    {
      coin: 'USDC', exchangeType: 'HYPERLIQUID', balance: '1842.16', availableBalance: '1842.16', upnl: '0',
      equity: '1842.16', liability: '0', borrowingInitialMargin: '0', borrowingMaintenanceMargin: '0',
    },
    {
      coin: 'USDC', exchangeType: 'GATE', balance: '0', availableBalance: '0', upnl: '0', equity: '0', liability: '0',
      borrowingInitialMargin: '0', borrowingMaintenanceMargin: '0',
    },
  ],
  twoBorrows: [
    {
      coin: 'USDT', exchangeType: 'CROSSEX', balance: '1387.45', availableBalance: '1387.45', upnl: '104.47',
      equity: '1491.92', liability: '0', borrowingInitialMargin: '0', borrowingMaintenanceMargin: '0',
    },
    {
      coin: 'USDC', exchangeType: 'HYPERLIQUID', balance: '-100.00', availableBalance: '0', upnl: '-12.00',
      equity: '-112.00', liability: '112.00', borrowingInitialMargin: '22.40', borrowingMaintenanceMargin: '11.20',
    },
    {
      coin: 'USDC', exchangeType: 'LIGHTER', balance: '-120.00', availableBalance: '0', upnl: '-12.00',
      equity: '-132.00', liability: '132.00', borrowingInitialMargin: '26.40', borrowingMaintenanceMargin: '13.20',
    },
  ],
  oneBorrow: [
    {
      coin: 'USDT', exchangeType: 'CROSSEX', balance: '687.53', availableBalance: '687.53', upnl: '104.47',
      equity: '792.00', liability: '0', borrowingInitialMargin: '0', borrowingMaintenanceMargin: '0',
    },
    {
      coin: 'USDC', exchangeType: 'HYPERLIQUID', balance: '496.14', availableBalance: '496.14', upnl: '91.78',
      equity: '587.92', liability: '0', borrowingInitialMargin: '0', borrowingMaintenanceMargin: '0',
    },
    {
      coin: 'USDC', exchangeType: 'LIGHTER', balance: '-120.00', availableBalance: '0', upnl: '-12.00',
      equity: '-132.00', liability: '132.00', borrowingInitialMargin: '26.40', borrowingMaintenanceMargin: '13.20',
    },
  ],
  hyperliquidFreeBorrow: [
    {
      coin: 'USDT', exchangeType: 'CROSSEX', balance: '8400.00', availableBalance: '8400.00', upnl: '0',
      equity: '8400.00', liability: '0', borrowingInitialMargin: '0', borrowingMaintenanceMargin: '0',
    },
    {
      coin: 'USDC', exchangeType: 'HYPERLIQUID', balance: '-4200.00', availableBalance: '0', upnl: '0',
      equity: '-4200.00', liability: '4200.00', borrowingInitialMargin: '840.00',
      borrowingMaintenanceMargin: '420.00',
    },
  ],
  gainOverNegativeCash: [
    {
      coin: 'USDC', exchangeType: 'LIGHTER', balance: '-40.00', availableBalance: '0', upnl: '55.00',
      equity: '15.00', liability: '0', borrowingInitialMargin: '0', borrowingMaintenanceMargin: '0',
    },
  ],
  interestPaidSplit: [
    {
      coin: 'USDT', exchangeType: 'CROSSEX', balance: '900.00', availableBalance: '900.00', upnl: '0',
      equity: '900.00', liability: '0', borrowingInitialMargin: '0', borrowingMaintenanceMargin: '0',
    },
    {
      coin: 'USDC', exchangeType: 'HYPERLIQUID', balance: '300.00', availableBalance: '300.00', upnl: '0',
      equity: '300.00', liability: '0', borrowingInitialMargin: '0', borrowingMaintenanceMargin: '0',
    },
    {
      coin: 'USDC', exchangeType: 'LIGHTER', balance: '200.00', availableBalance: '200.00', upnl: '0',
      equity: '200.00', liability: '0', borrowingInitialMargin: '0', borrowingMaintenanceMargin: '0',
    },
  ],
  oneRouteOnly: [
    {
      coin: 'USDT', exchangeType: 'CROSSEX', balance: '300.00', availableBalance: '300.00', upnl: '0',
      equity: '300.00', liability: '0', borrowingInitialMargin: '0', borrowingMaintenanceMargin: '0',
    },
    {
      coin: 'USDC', exchangeType: 'HYPERLIQUID', balance: '10.00', availableBalance: '10.00', upnl: '150.00',
      equity: '160.00', liability: '0', borrowingInitialMargin: '0', borrowingMaintenanceMargin: '0',
    },
  ],
  hiddenRoute: [
    {
      coin: 'USDT', exchangeType: 'CROSSEX', balance: '400.00', availableBalance: '400.00', upnl: '0',
      equity: '400.00', liability: '0', borrowingInitialMargin: '0', borrowingMaintenanceMargin: '0',
    },
    {
      coin: 'USDC', exchangeType: 'HYPERLIQUID', balance: '100.00', availableBalance: '100.00', upnl: '0',
      equity: '100.00', liability: '0', borrowingInitialMargin: '0', borrowingMaintenanceMargin: '0',
    },
  ],
  ethTwoVenues: [
    {
      coin: 'USDT', exchangeType: 'CROSSEX', balance: '500', availableBalance: '500', upnl: '0', equity: '500',
      liability: '0', borrowingInitialMargin: '0', borrowingMaintenanceMargin: '0',
    },
    {
      coin: 'USDC', exchangeType: 'HYPERLIQUID', balance: '503', availableBalance: '503', upnl: '-3', equity: '500',
      liability: '0', borrowingInitialMargin: '0', borrowingMaintenanceMargin: '0',
    },
    {
      coin: 'USDC', exchangeType: 'GATE', balance: '0', availableBalance: '0', upnl: '0', equity: '0', liability: '0',
      borrowingInitialMargin: '0', borrowingMaintenanceMargin: '0',
    },
  ],
};

export const accountBodies = {
  accountA: {
    ...account, marginBalance: '57.45', availableMargin: '28.04', initialMargin: '29.41', maintenanceMargin: '14.705',
    initialMarginRate: '0.5119', maintenanceMarginRate: '0.256', assets: ACCOUNT_ASSETS.accountA,
  },
  accountARound3: {
    ...account, marginBalance: '20.77', availableMargin: '2.228', initialMargin: '18.542', maintenanceMargin: '9.271',
    initialMarginRate: '0.8927', maintenanceMarginRate: '0.4464', assets: ACCOUNT_ASSETS.accountARound3,
  },
  accountB: {
    ...account, marginBalance: '988.42', availableMargin: '834.57', initialMargin: '153.85', maintenanceMargin: '0',
    initialMarginRate: '0.1557', maintenanceMarginRate: '0', assets: ACCOUNT_ASSETS.accountB,
  },
  exampleC: {
    ...account, marginBalance: '391.27', availableMargin: '294.87', initialMargin: '96.4', maintenanceMargin: '0',
    initialMarginRate: '0.2464', maintenanceMarginRate: '0', assets: ACCOUNT_ASSETS.exampleC,
  },
  exampleD: {
    ...account, marginBalance: '2469.37', availableMargin: '546.89', initialMargin: '1922.48',
    maintenanceMargin: '961.24', initialMarginRate: '0.7785', maintenanceMarginRate: '0.3893',
    assets: ACCOUNT_ASSETS.exampleD,
  },
  exampleE: {
    ...account, marginBalance: '1229.81', availableMargin: '797.34', initialMargin: '432.47',
    maintenanceMargin: '61.235', initialMarginRate: '0.3517', maintenanceMarginRate: '0.0498',
    assets: ACCOUNT_ASSETS.exampleE,
  },
  lighter: {
    ...account, marginBalance: '1000', availableMargin: '1000', initialMargin: '0', maintenanceMargin: '0',
    initialMarginRate: '0', maintenanceMarginRate: '0', assets: ACCOUNT_ASSETS.lighter,
  },
  noAssets: {
    ...account, marginBalance: '0', availableMargin: '0', initialMargin: '0', maintenanceMargin: '0',
    initialMarginRate: '0', maintenanceMarginRate: '0', assets: [],
  },
  twoBorrows: {
    ...account, marginBalance: '1247.92', availableMargin: '1199.12', initialMargin: '48.80', maintenanceMargin: '24.40',
    initialMarginRate: '0.0391', maintenanceMarginRate: '0.0196', assets: ACCOUNT_ASSETS.twoBorrows,
  },
  oneBorrow: {
    ...account, marginBalance: '1247.92', availableMargin: '1221.52', initialMargin: '26.40',
    maintenanceMargin: '13.20', initialMarginRate: '0.0212', maintenanceMarginRate: '0.0106',
    assets: ACCOUNT_ASSETS.oneBorrow,
  },
  hyperliquidFreeBorrow: {
    ...account, marginBalance: '4200.00', availableMargin: '3360.00', initialMargin: '840.00',
    maintenanceMargin: '420.00', initialMarginRate: '0.2000', maintenanceMarginRate: '0.1000',
    assets: ACCOUNT_ASSETS.hyperliquidFreeBorrow,
  },
  gainOverNegativeCash: {
    ...account, marginBalance: '15.00', availableMargin: '15.00', initialMargin: '0', maintenanceMargin: '0',
    initialMarginRate: '0', maintenanceMarginRate: '0', assets: ACCOUNT_ASSETS.gainOverNegativeCash,
  },
  interestPaidSplit: {
    ...account, marginBalance: '1400.00', availableMargin: '1400.00', initialMargin: '0', maintenanceMargin: '0',
    initialMarginRate: '0', maintenanceMarginRate: '0', assets: ACCOUNT_ASSETS.interestPaidSplit,
  },
  oneRouteOnly: {
    ...account, marginBalance: '460.00', availableMargin: '460.00', initialMargin: '0', maintenanceMargin: '0',
    initialMarginRate: '0', maintenanceMarginRate: '0', assets: ACCOUNT_ASSETS.oneRouteOnly,
  },
  hiddenRoute: {
    ...account, marginBalance: '500.00', availableMargin: '500.00', initialMargin: '0', maintenanceMargin: '0',
    initialMarginRate: '0', maintenanceMarginRate: '0', assets: ACCOUNT_ASSETS.hiddenRoute,
  },
  ethTwoVenues: {
    ...account, marginBalance: '1000', availableMargin: '775', initialMargin: '225', maintenanceMargin: '400',
    initialMarginRate: '0.225', maintenanceMarginRate: '0.4', assets: ACCOUNT_ASSETS.ethTwoVenues,
  },
} satisfies Record<string, CrossexAccount>;

export const positionsBodies = {
  ethTwoVenues: {
    positions: [
      makeCrossexPosition({ maintenanceMargin: '200' }),
      makeCrossexPosition({
        symbol: 'HYPERLIQUID_FUTURE_ETH_USDC',
        positionSide: 'SHORT',
        positionQty: '-0.3',
        maxLeverage: '20',
        upnl: '-3',
        upnlRate: '-0.004',
        fee: '-0.3',
        initialMargin: '75',
        maintenanceMargin: '200',
      }),
    ],
    exposure: [
      {
        base: 'ETH',
        legs: [
          { symbol: 'GATE_FUTURE_ETH_USDT', exchange: 'GATE', quote: 'USDT', side: 'LONG', qty: 0.3, value: 750 },
          {
            symbol: 'HYPERLIQUID_FUTURE_ETH_USDC', exchange: 'HYPERLIQUID', quote: 'USDC', side: 'SHORT', qty: 0.3,
            value: 750,
          },
        ],
        longValue: 750,
        shortValue: 750,
        netValue: 0,
        grossValue: 1500,
        neutral: true,
        singleLeg: false,
      },
    ],
  },
} satisfies Record<string, PositionsResponse>;
