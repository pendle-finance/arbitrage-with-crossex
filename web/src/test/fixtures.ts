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
  OpportunitiesResult,
  OpportunityGroup,
  OpportunityLeg,
  OpportunityMarketRow,
  OpportunityPair,
  PositionsResponse,
  PreviewResponse,
  PreviewResult,
  RebalanceView,
  StrategyLeg,
  SymbolRule,
  UpdateStatus,
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
  return {
    buckets: [],
    plan: {
      direction: 'toUsdc',
      amount: 0,
      receives: 0,
      price: null,
      borrowAfterUsd: 0,
      shortfall: null,
      routes: {
        loop: { costUsd: 0.05, waitSeconds: 150, available: false, reason: 'nothing to move' },
        convert: { costUsd: 0, waitSeconds: 0, available: false, reason: 'nothing to move' },
      },
      route: null,
      savesPerDayUsd: 0,
      marginFreedUsd: 0,
    },
    job: null,
    ...over,
  };
}

export function rebalanceHandler(view: RebalanceView = makeRebalanceView()) {
  return http.get('/api/rebalance', () => HttpResponse.json(env<RebalanceView>(view)));
}
