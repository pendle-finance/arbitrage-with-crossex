/** Shared trading-test fixtures: rule/preview/account builders + msw handlers. */
import { http, HttpResponse } from 'msw';
import type {
  ActionInput,
  DeleverEstimate,
  DeleverPlan,
  FullPlan,
  ImUsedRow,
  AssetBorosHistory,
  AssetBorosOpen,
  AssetGroup,
  AssetPerpOpen,
  AssetViewResponse,
  BookTouch,
  BorosAgentStatus,
  BorosPairContext,
  BorosPairMarketRow,
  ClassifiedError,
  CredentialsInfo,
  DealOrder,
  DealPair,
  DealProjection,
  DealView,
  CrossexAccount,
  CrossexPosition,
  EvenPlan,
  Goal,
  OpportunitiesResult,
  OpportunityBorosLeg,
  OpportunityGroup,
  OpportunityLeg,
  OpportunityMarketRow,
  OpportunityPair,
  PositionsResponse,
  PreviewResponse,
  PreviewResult,
  Pool,
  RealizeEstimate,
  RealizeLeg,
  RealizePlan,
  RealizeRefusal,
  RealizeTab,
  RebalanceBucket,
  RebalanceJob,
  RebalancePlans,
  RebalanceStep,
  RebalanceView,
  RouteName,
  RoutePlan,
  RunLegView,
  RunOrderView,
  SliceOption,
  SpotBalance,
  StrategyLeg,
  SymbolRule,
  TelegramInfo,
  TelegramLinkStart,
  TelegramLinkStatus,
  TransferJob,
  TransferPath,
  TransferView,
  UpdateStatus,
  WalletAfter,
  WalletShare,
} from '../api/types';
import type { MarginTiers } from '../lib/liquidation';
import type { SharePayloadV1 } from '../lib/shareCodec';
import { SECONDS_IN_YEAR } from '../panels/assets/assetModel';
import type { OpenPair } from '../panels/assets/pairs';
import { env, server } from './server';

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
  fees?: DealView['fees'];
  avgPrice?: DealView['avgPrice'];
  endedAt?: number | null;
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
    fees: overrides?.fees ?? { readUsd: 0, estUsd: 0, totalUsd: 0, est: true },
    avgPrice: overrides?.avgPrice ?? { a: null, b: null },
    endedAt: overrides?.endedAt ?? null,
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
    http.get('/api/telegram', () => HttpResponse.json(env(telegramInfo()))),
    http.get('/api/boros/agent', () => HttpResponse.json(env(agentStatus()))),
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

export function agentStatus(over: Partial<BorosAgentStatus> = {}): BorosAgentStatus {
  return {
    configured: false,
    root: null,
    rootMasked: null,
    accountId: null,
    expiry: null,
    expired: false,
    canProvision: true,
    ...over,
  };
}

export function telegramInfo(over: Partial<TelegramInfo> = {}): TelegramInfo {
  return {
    connected: false,
    state: 'none',
    settings: null,
    lastSyncAt: null,
    lastSyncError: null,
    floors: [
      { wallet: 'USDT', coin: 'USDT', floorUsd: 0 },
      { wallet: 'HYPERLIQUID', coin: 'USDC', floorUsd: -10_000 },
      { wallet: 'LIGHTER', coin: 'USDC', floorUsd: 0 },
    ],
    ...over,
  };
}

export function setupHandlers(agent: BorosAgentStatus, telegram: TelegramInfo) {
  return [
    http.get('/api/boros/agent', () => HttpResponse.json(env(agent))),
    http.get('/api/telegram', () => HttpResponse.json(env(telegram))),
  ];
}

export interface SetupWorld {
  keyConfigured: boolean;
  agent: BorosAgentStatus;
  telegram: TelegramInfo;
}

export function mockWorld(over: Partial<SetupWorld> = {}): SetupWorld {
  const world: SetupWorld = { keyConfigured: false, agent: agentStatus(), telegram: telegramInfo(), ...over };
  server.use(
    http.get('/api/credentials', () =>
      HttpResponse.json(env(world.keyConfigured ? credentialsBodies.set : credentialsBodies.unset)),
    ),
    http.get('/api/boros/agent', () => HttpResponse.json(env(world.agent))),
    http.get('/api/telegram', () => HttpResponse.json(env(world.telegram))),
  );
  return world;
}

export const assetView: AssetViewResponse = {
  sinceSec: 0,
  nowSec: 1_760_000_000,
  defaultSinceSec: null,
  assets: [],
  supportedCoins: ['ETH', 'HYPE', 'BTC'],
  earliestSec: null,
  coverage: { settlementsFromSec: 0, perpClosedFromSec: 0, borosTxnsComplete: true, backfilling: false },
  warnings: [],
};

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
    venue: 'HYPERLIQUID',
    crossexVenue: 'HYPERLIQUID',
    crossexSymbol: 'HYPERLIQUID_FUTURE_ETH_USDC',
    base: 'ETH',
    ...overrides,
  };
}

export function makeOpportunityBorosLeg(overrides: Partial<OpportunityBorosLeg> = {}): OpportunityBorosLeg {
  return {
    marketId: 101,
    side: 'SHORT',
    venue: 'HYPERLIQUID',
    spreadVenues: null,
    midApr: 0.09,
    execApr: 0.0895,
    settleFeeApr: 0.001,
    takerFeeRate: 0.0005,
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
    borosIms: [
      { marketId: 101, imUsd: 8 },
      { marketId: 102, imUsd: 4 },
    ],
    perpShortImUsd: OPP_NOTIONAL / 10,
    perpLongImUsd: OPP_NOTIONAL / 20,
    shortLeverageMax: 10,
    longLeverageMax: 20,
  };
  const capitalUsd = 8 + 4 + capital.perpShortImUsd + capital.perpLongImUsd;
  return {
    base: 'ETH',
    shortLeg: makeOpportunityLeg(),
    longLeg: makeOpportunityLeg({
      venue: 'BINANCE',
      crossexVenue: 'BINANCE',
      crossexSymbol: 'BINANCE_FUTURE_ETH_USDT',
    }),
    borosLegs: [
      makeOpportunityBorosLeg(),
      makeOpportunityBorosLeg({ marketId: 102, side: 'LONG', venue: 'BINANCE', midApr: 0.045, execApr: 0.0455 }),
    ],
    grossSpreadApr,
    execSpreadApr,
    borosImpactApr: grossSpreadApr - execSpreadApr,
    makerLeg: null,
    notionalUsd: OPP_NOTIONAL,
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

export const SPREAD_OPP_NOW = 1_791_417_600;
export const SPREAD_OPP_MATURITY = 1_795_737_600;
export const SPREAD_OPP_MARKET_ID = 59;
const SPREAD_BOROS_IM = OPP_NOTIONAL * 0.00707;

export function makeSpreadOpportunityPair(overrides: Partial<OpportunityPair> = {}): OpportunityPair {
  const secondsToMaturity = SPREAD_OPP_MATURITY - SPREAD_OPP_NOW;
  const nt = OPP_NOTIONAL * (secondsToMaturity / (365 * 24 * 3600));
  const midApr = 0.0348;
  const execApr = midApr - 0.0005;
  const borosTakerFeeUsd = 0.001 * nt;
  const borosSettleFeeUsd = 0.002 * nt;
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
  const netFixedApr = execApr - totalUsd / nt;
  const estProfitUsd = netFixedApr * nt;
  const capital = {
    borosIms: [{ marketId: SPREAD_OPP_MARKET_ID, imUsd: SPREAD_BOROS_IM }],
    perpShortImUsd: OPP_NOTIONAL / 10,
    perpLongImUsd: OPP_NOTIONAL / 20,
    shortLeverageMax: 10,
    longLeverageMax: 20,
  };
  const capitalUsd = SPREAD_BOROS_IM + capital.perpShortImUsd + capital.perpLongImUsd;
  return {
    base: 'ETH',
    shortLeg: makeOpportunityLeg(),
    longLeg: makeOpportunityLeg({
      venue: 'GATE',
      crossexVenue: 'GATE',
      crossexSymbol: 'GATE_FUTURE_ETH_USDT',
    }),
    borosLegs: [
      makeOpportunityBorosLeg({
        marketId: SPREAD_OPP_MARKET_ID,
        side: 'SHORT',
        venue: 'HL-GATE',
        spreadVenues: ['HYPERLIQUID', 'GATE'],
        midApr,
        execApr,
        settleFeeApr: 0.002,
        takerFeeRate: 0.001,
      }),
    ],
    grossSpreadApr: midApr,
    execSpreadApr: execApr,
    borosImpactApr: midApr - execApr,
    makerLeg: null,
    notionalUsd: OPP_NOTIONAL,
    costs: {
      borosTakerFeeUsd,
      borosSettleFeeUsd,
      perpEntryFeesUsd,
      perpEntrySlippageUsd,
      perpExitFeesUsd,
      perpExitSlippageUsd,
      totalUsd,
      annualizedApr: totalUsd / nt,
    },
    capital,
    capitalUsd,
    netFixedApr,
    netFixedAprOnCapital: estProfitUsd / (capitalUsd * (nt / OPP_NOTIONAL)),
    effectiveLeverage: OPP_NOTIONAL / capitalUsd,
    estProfitUsd,
    secondsToMaturity,
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
  return { buckets: [], plans: plansOf(EMPTY_PLAN), job: null, ...over };
}

export function rebalanceHandler(view: RebalanceView = makeRebalanceView()) {
  return http.get('/api/rebalance', () => HttpResponse.json(env<RebalanceView>(view)));
}

export function transferHandler(view: TransferView = transferViews.accountB) {
  return http.get('/api/transfer', () => HttpResponse.json(env<TransferView>(view)));
}

export function transferPostHandler(bodies: { id?: unknown }[], answer: 'accepted' | 'silent') {
  return http.post('/api/transfer', async ({ request }) => {
    bodies.push((await request.json()) as { id?: unknown });
    if (answer === 'accepted') return HttpResponse.json(env({ id: 'mtzur2ab' }), { status: 202 });
    return HttpResponse.json(
      { ok: false, error: { category: 'network', message: 'Gate did not answer.', retryable: true } },
      { status: 502 },
    );
  });
}

export function accountHandler(body: CrossexAccount = accountBodies.accountB) {
  return http.get('/api/account', () => HttpResponse.json(env<CrossexAccount>(body)));
}

export const REBALANCE_NOW = 1_789_306_394_208;

const TO_HYPERLIQUID = { from: 'CROSSEX', to: 'HYPERLIQUID' } as const;
const FROM_HYPERLIQUID = { from: 'HYPERLIQUID', to: 'CROSSEX' } as const;

const EVEN: Goal = { kind: 'even' };

/** Both presets off one even plan: tests that build a view name only the
 * plan the card leads with, and repay idles beside it. */
export function plansOf(even: EvenPlan): RebalancePlans {
  const repay: EvenPlan = { ...balancedPlan(even.routes.convert.after), goal: { kind: 'repay' }, noLegs: even.noLegs };
  return { even, repay, custom: null };
}

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
    goal: EVEN, targets: [], balanced: true, noLegs: false, moves: 0, shortOfEven: 0, roundCap: 0, split: EVEN_SPLIT,
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
    interestPaidUsd: 0, interestPerDayUsd: 0, ratePerYear: 0.0564,
  },
  {
    coin: 'USDC', venue: 'HYPERLIQUID', cash: -147.05, upnl: 0, equity: -147.05, borrow: 147.05, imHeldUsd: 29.41,
    mmHeldUsd: 14.705, interestPaidUsd: 0, interestPerDayUsd: 0, ratePerYear: 0.05,
  },
  {
    coin: 'USDC', venue: 'GATE', cash: 111.96, upnl: 0, equity: 111.96, borrow: 0, imHeldUsd: 0, mmHeldUsd: 0,
    interestPaidUsd: 0, interestPerDayUsd: 0, ratePerYear: 0.05,
  },
];

const ACCOUNT_A_ROUND_3_BUCKETS: RebalanceBucket[] = [
  {
    coin: 'USDT', venue: 'CROSSEX', cash: 92.54, upnl: 0, equity: 92.54, borrow: 0, imHeldUsd: 0, mmHeldUsd: 0,
    interestPaidUsd: 0, interestPerDayUsd: 0, ratePerYear: 0.0564,
  },
  {
    coin: 'USDC', venue: 'HYPERLIQUID', cash: -92.71, upnl: 0, equity: -92.71, borrow: 92.71, imHeldUsd: 18.542,
    mmHeldUsd: 9.271, interestPaidUsd: 0, interestPerDayUsd: 0, ratePerYear: 0.05,
  },
  {
    coin: 'USDC', venue: 'GATE', cash: 20.94, upnl: 0, equity: 20.94, borrow: 0, imHeldUsd: 0, mmHeldUsd: 0,
    interestPaidUsd: 0, interestPerDayUsd: 0, ratePerYear: 0.05,
  },
];

const ACCOUNT_A_ROUND_3_PLAN: EvenPlan = {
  goal: EVEN, targets: [], balanced: false, noLegs: false, moves: 103.19, shortOfEven: 0, roundCap: 6, split: EVEN_SPLIT,
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
  id: 'mtzunfww', goal: 'even', route: 'loop', amount: 175.88, costUsd: 0.26,
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
    interestPaidUsd: 0, interestPerDayUsd: 0, ratePerYear: 0.0564,
  },
  {
    coin: 'USDC', venue: 'HYPERLIQUID', cash: 11.88, upnl: 5.03, equity: 16.91, borrow: 0, imHeldUsd: 0, mmHeldUsd: 0,
    interestPaidUsd: 0, interestPerDayUsd: 0, ratePerYear: 0.05,
  },
  {
    coin: 'USDC', venue: 'GATE', cash: 0.29, upnl: 0, equity: 0.29, borrow: 0, imHeldUsd: 0, mmHeldUsd: 0,
    interestPaidUsd: 0, interestPerDayUsd: 0, ratePerYear: 0.05,
  },
];

const BALANCED_BUCKETS: RebalanceBucket[] = [
  {
    coin: 'USDT', venue: 'CROSSEX', cash: 509.27, upnl: -15.39, equity: 493.88, borrow: 0, imHeldUsd: 0, mmHeldUsd: 0,
    interestPaidUsd: 0, interestPerDayUsd: 0, ratePerYear: 0.0564,
  },
  {
    coin: 'USDC', venue: 'HYPERLIQUID', cash: 489.12, upnl: 5.03, equity: 494.15, borrow: 0, imHeldUsd: 0, mmHeldUsd: 0,
    interestPaidUsd: 0, interestPerDayUsd: 0, ratePerYear: 0.05,
  },
  {
    coin: 'USDC', venue: 'GATE', cash: 0.29, upnl: 0, equity: 0.29, borrow: 0, imHeldUsd: 0, mmHeldUsd: 0,
    interestPaidUsd: 0, interestPerDayUsd: 0, ratePerYear: 0.05,
  },
];

const BALANCED_PLAN: EvenPlan = balancedPlan([
  { coin: 'USDT', venue: 'CROSSEX', cash: 509.27, equity: 493.88 },
  { coin: 'USDC', venue: 'HYPERLIQUID', cash: 489.12, equity: 494.15 },
  { coin: 'USDC', venue: 'GATE', cash: 0.29, equity: 0.29 },
]);

const BALANCED_DONE_JOB: RebalanceJob = {
  id: 'mtzuqygg', goal: 'even', route: 'loop', amount: 477.29, costUsd: 0.1,
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
  id: 'mtzuqygg', goal: 'even', route: 'loop', amount: 111.96, status: 'done', stepIndex: 2,
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
  idleSale: { usdc: 111.96, at: 0 },
};

const ACCOUNT_A_PLAN: EvenPlan = {
  goal: EVEN, targets: [], balanced: false, noLegs: false, moves: 175.89, shortOfEven: 0, roundCap: 6, split: EVEN_SPLIT,
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
  goal: EVEN, targets: [], balanced: false, noLegs: false, moves: 175.94, shortOfEven: 0, roundCap: 6, split: EVEN_SPLIT,
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
  goal: EVEN, targets: [], balanced: false, noLegs: false, moves: 121.45, shortOfEven: 0, roundCap: 6, split: EVEN_SPLIT,
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
  id: 'mtzutp80', goal: 'even', route: 'convert', amount: 175.94, costUsd: 0.36,
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

const CONVERT_DONE_SHORT_JOB: RebalanceJob = {
  ...CONVERT_DONE_JOB,
  steps: CONVERT_DONE_JOB.steps.map((step): RebalanceStep => (step.name === 'Convert' ? { ...step, qty: 105.56 } : step)),
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
  goal: EVEN, targets: [], balanced: false, noLegs: false, moves: 483.43, shortOfEven: 0, roundCap: 6, split: EVEN_SPLIT,
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
    mmHeldUsd: 0, interestPaidUsd: 0, interestPerDayUsd: 0, ratePerYear: 0.0564,
  },
  {
    coin: 'USDC', venue: 'HYPERLIQUID', cash: -9612.4, upnl: 0, equity: -9612.4, borrow: 9612.4, imHeldUsd: 1922.48,
    mmHeldUsd: 961.24, interestPaidUsd: 0, interestPerDayUsd: 0, ratePerYear: 0.05,
  },
  {
    coin: 'USDC', venue: 'GATE', cash: 0, upnl: 0, equity: 0, borrow: 0, imHeldUsd: 0, mmHeldUsd: 0,
    interestPaidUsd: 0, interestPerDayUsd: 0, ratePerYear: 0.05,
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
  goal: EVEN, targets: [], balanced: false, noLegs: false, moves: 7513.82, shortOfEven: 0, roundCap: 6, split: EVEN_SPLIT,
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
  id: 'mtzud1oo', goal: 'even', route: 'mix', amount: 10854.58, costUsd: EXAMPLE_D_MIX.costUsd,
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
    mmHeldUsd: 61.235, interestPaidUsd: 0, interestPerDayUsd: 0.09, ratePerYear: 0.0564,
  },
  {
    coin: 'USDC', venue: 'HYPERLIQUID', cash: 1842.16, upnl: 0, equity: 1842.16, borrow: 0, imHeldUsd: 0,
    mmHeldUsd: 0, interestPaidUsd: 0, interestPerDayUsd: 0, ratePerYear: 0.05,
  },
  {
    coin: 'USDC', venue: 'GATE', cash: 0, upnl: 0, equity: 0, borrow: 0, imHeldUsd: 0, mmHeldUsd: 0,
    interestPaidUsd: 0, interestPerDayUsd: 0, ratePerYear: 0.05,
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
  goal: EVEN, targets: [], balanced: false, noLegs: false, moves: 855.39, shortOfEven: 0, roundCap: 2, split: EVEN_SPLIT,
  routes: {
    mix: null,
    loop: { ...EXAMPLE_E_MID_CONVERT, available: false, reason: 'Free margin is too low for an 11 USDC round.' },
    convert: EXAMPLE_E_MID_CONVERT,
  },
  recommended: 'convert',
};

const EXAMPLE_E_JOB: RebalanceJob = {
  id: 'mtzuqm40', goal: 'even', route: 'loop', amount: 1228.31, costUsd: 2.12,
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
    ratePerYear: 0.0564,
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
    ratePerYear: 0.05,
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
    ratePerYear: 0.1095,
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
    ratePerYear: 0.05,
  },
];

const LIGHTER_SPLIT_PLAN: EvenPlan = {
  goal: EVEN, targets: [], balanced: false,
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
    ratePerYear: 0.0564,
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
    ratePerYear: 0.05,
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
    ratePerYear: 0.1095,
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
    ratePerYear: 0.05,
  },
];

const LIGHTER_ACROSS_PLAN: EvenPlan = {
  goal: EVEN, targets: [], balanced: false,
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
  id: 'mtzv1l7g', goal: 'even', route: 'loop', amount: 500, costUsd: 2.03, target: LIGHTER_ACROSS_PLAN.routes.loop!.after,
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
  id: 'mtzv2c1q', goal: 'even', route: 'convert', amount: 500, costUsd: 2, target: LIGHTER_ACROSS_PLAN.routes.convert.after,
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
    mmHeldUsd: 0, interestPaidUsd: 0, interestPerDayUsd: 0, ratePerYear: 0.0564,
  },
  {
    coin: 'USDC', venue: 'HYPERLIQUID', cash: -100.0, upnl: -12.0, equity: -112.0, borrow: 112.0, imHeldUsd: 22.4,
    mmHeldUsd: 11.2, interestPaidUsd: 0, interestPerDayUsd: 0, ratePerYear: 0.05,
  },
  {
    coin: 'USDC', venue: 'LIGHTER', cash: -120.0, upnl: -12.0, equity: -132.0, borrow: 132.0, imHeldUsd: 26.4,
    mmHeldUsd: 13.2, interestPaidUsd: 0, interestPerDayUsd: 0.0396, ratePerYear: 0.1095,
  },
];

const TWO_BORROWS_SPLIT: WalletShare[] = [
  { coin: 'USDT', venue: 'CROSSEX', notionalUsd: 1890.5, share: 0.5 },
  { coin: 'USDC', venue: 'HYPERLIQUID', notionalUsd: 1663.64, share: 0.44 },
  { coin: 'USDC', venue: 'LIGHTER', notionalUsd: 226.86, share: 0.06 },
];

const TWO_BORROWS_USDC_AFTER: WalletAfter[] = [
  { coin: 'USDC', venue: 'HYPERLIQUID', cash: 561.08, equity: 549.08 },
  { coin: 'USDC', venue: 'LIGHTER', cash: 86.88, equity: 74.88 },
];

const TWO_BORROWS_PLAN: EvenPlan = {
  goal: EVEN, targets: [], balanced: false, noLegs: false, moves: 868.42, shortOfEven: 0, roundCap: 6, split: TWO_BORROWS_SPLIT,
  routes: {
    mix: {
      available: true, reason: null, costUsd: 0.46, seconds: 130, rounds: 1, oneMoreRoundCostUsd: null,
      marginFreedUsd: 48.8, savesPerDayUsd: 0.04,
      after: [{ coin: 'USDT', venue: 'CROSSEX', cash: 519.03, equity: 623.5 }, ...TWO_BORROWS_USDC_AFTER],
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
    loop: null,
    convert: {
      available: true, reason: null, costUsd: 1.74, seconds: 0, rounds: 0, oneMoreRoundCostUsd: null,
      marginFreedUsd: 48.8, savesPerDayUsd: 0.04,
      after: [{ coin: 'USDT', venue: 'CROSSEX', cash: 517.76, equity: 622.23 }, ...TWO_BORROWS_USDC_AFTER],
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
  recommended: 'mix',
};

const BIG_BORROWS_BUCKETS: RebalanceBucket[] = [
  {
    coin: 'USDT', venue: 'CROSSEX', cash: -520000.0, upnl: -25678.9, equity: -545678.9, borrow: 545678.9,
    imHeldUsd: 109135.78, mmHeldUsd: 54567.89, interestPaidUsd: 96512.44, interestPerDayUsd: 84.32, ratePerYear: 0.0564,
  },
  {
    coin: 'USDC', venue: 'HYPERLIQUID', cash: 2850000.0, upnl: 312345.67, equity: 3162345.67, borrow: 0, imHeldUsd: 0,
    mmHeldUsd: 0, interestPaidUsd: 31902.11, interestPerDayUsd: 0, ratePerYear: 0.05,
  },
  {
    coin: 'USDC', venue: 'LIGHTER', cash: -270000.0, upnl: -17654.32, equity: -287654.32, borrow: 287654.32,
    imHeldUsd: 57530.86, mmHeldUsd: 28765.43, interestPaidUsd: 16313.22, interestPerDayUsd: 86.3, ratePerYear: 0.1095,
  },
];

const BIG_BORROWS_PLAN: EvenPlan = {
  goal: EVEN, targets: [], balanced: false, noLegs: false, moves: 2236247.29, shortOfEven: 0, roundCap: 6,
  split: [
    { coin: 'USDT', venue: 'CROSSEX', notionalUsd: 4657000, share: 0.5 },
    { coin: 'USDC', venue: 'HYPERLIQUID', notionalUsd: 3725600, share: 0.4 },
    { coin: 'USDC', venue: 'LIGHTER', notionalUsd: 931400, share: 0.1 },
  ],
  routes: {
    mix: null,
    loop: null,
    convert: {
      available: true, reason: null, costUsd: 5502.59, seconds: 0, rounds: 0, oneMoreRoundCostUsd: null,
      marginFreedUsd: 166666.64, savesPerDayUsd: 170.62,
      after: [
        { coin: 'USDT', venue: 'CROSSEX', cash: 1190185.13, equity: 1164506.23 },
        { coin: 'USDC', venue: 'HYPERLIQUID', cash: 613752.71, equity: 926098.38 },
        { coin: 'USDC', venue: 'LIGHTER', cash: 250555.57, equity: 232901.25 },
      ],
      steps: [
        {
          round: null, kind: 'convert', buy: 0, move: 1713605.5, arrives: 1710185.13, borrowLeft: 287654.32, seconds: 0,
          from: 'HYPERLIQUID', to: 'CROSSEX',
        },
        {
          round: null, kind: 'convert', buy: 0, move: 522641.79, arrives: 520555.57, borrowLeft: 0, seconds: 0,
          from: 'HYPERLIQUID', to: 'LIGHTER',
        },
      ],
    },
  },
  recommended: 'convert',
};

const ONE_BORROW_BUCKETS: RebalanceBucket[] = [
  {
    coin: 'USDT', venue: 'CROSSEX', cash: 687.53, upnl: 104.47, equity: 792.0, borrow: 0, imHeldUsd: 0,
    mmHeldUsd: 0, interestPaidUsd: 0, interestPerDayUsd: 0, ratePerYear: 0.0564,
  },
  {
    coin: 'USDC', venue: 'HYPERLIQUID', cash: 496.14, upnl: 91.78, equity: 587.92, borrow: 0, imHeldUsd: 0,
    mmHeldUsd: 0, interestPaidUsd: 0, interestPerDayUsd: 0, ratePerYear: 0.05,
  },
  {
    coin: 'USDC', venue: 'LIGHTER', cash: -120.0, upnl: -12.0, equity: -132.0, borrow: 132.0, imHeldUsd: 26.4,
    mmHeldUsd: 13.2, interestPaidUsd: 0, interestPerDayUsd: 0.0396, ratePerYear: 0.1095,
  },
];

const ONE_BORROW_TARGET: WalletAfter[] = [
  { coin: 'USDT', venue: 'CROSSEX', cash: 479.62, equity: 584.09 },
  { coin: 'USDC', venue: 'HYPERLIQUID', cash: 496.14, equity: 587.92 },
  { coin: 'USDC', venue: 'LIGHTER', cash: 86.88, equity: 74.88 },
];

const ONE_BORROW_PLAN: EvenPlan = {
  goal: EVEN, targets: [], balanced: false, noLegs: false, moves: 206.88, shortOfEven: 0, roundCap: 6, split: TWO_BORROWS_SPLIT,
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
    interestPaidUsd: 0, interestPerDayUsd: 0, ratePerYear: 0.0564,
  },
  {
    coin: 'USDC', venue: 'HYPERLIQUID', cash: -4200.0, upnl: 0, equity: -4200.0, borrow: 4200.0, imHeldUsd: 840.0,
    mmHeldUsd: 420.0, interestPaidUsd: 0, interestPerDayUsd: 0, ratePerYear: 0.05,
  },
];

const HYPERLIQUID_FREE_BORROW_TARGET: WalletAfter[] = [
  { coin: 'USDT', venue: 'CROSSEX', cash: 2800.14, equity: 2800.14 },
  { coin: 'USDC', venue: 'HYPERLIQUID', cash: 1399.86, equity: 1399.86 },
];

const HYPERLIQUID_FREE_BORROW_PLAN: EvenPlan = {
  goal: EVEN, targets: [], balanced: false, noLegs: false, moves: 5599.91, shortOfEven: 0, roundCap: 6,
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
    interestPaidUsd: 0, interestPerDayUsd: 0, ratePerYear: 0.1095,
  },
];

const GAIN_OVER_NEGATIVE_CASH_PLAN: EvenPlan = {
  goal: EVEN, targets: [], balanced: true, noLegs: false, moves: 0, shortOfEven: 0, roundCap: 0,
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
    interestPaidUsd: 0, interestPerDayUsd: 0, ratePerYear: 0.0564,
  },
  {
    coin: 'USDC', venue: 'HYPERLIQUID', cash: 300.0, upnl: 0, equity: 300.0, borrow: 0, imHeldUsd: 0, mmHeldUsd: 0,
    interestPaidUsd: 0.31, interestPerDayUsd: 0, ratePerYear: 0.05,
  },
  {
    coin: 'USDC', venue: 'LIGHTER', cash: 200.0, upnl: 0, equity: 200.0, borrow: 0, imHeldUsd: 0, mmHeldUsd: 0,
    interestPaidUsd: 1.55, interestPerDayUsd: 0, ratePerYear: 0.1095,
  },
];

const INTEREST_PAID_SPLIT_AFTER: WalletAfter[] = [
  { coin: 'USDT', venue: 'CROSSEX', cash: 900.0, equity: 900.0 },
  { coin: 'USDC', venue: 'HYPERLIQUID', cash: 300.0, equity: 300.0 },
  { coin: 'USDC', venue: 'LIGHTER', cash: 200.0, equity: 200.0 },
];

const INTEREST_PAID_SPLIT_PLAN: EvenPlan = {
  goal: EVEN, targets: [], balanced: true, noLegs: false, moves: 0, shortOfEven: 0, roundCap: 0,
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
    interestPaidUsd: 0, interestPerDayUsd: 0, ratePerYear: 0.0564,
  },
  {
    coin: 'USDC', venue: 'HYPERLIQUID', cash: 10.0, upnl: 150.0, equity: 160.0, borrow: 0, imHeldUsd: 0,
    mmHeldUsd: 0, interestPaidUsd: 0, interestPerDayUsd: 0, ratePerYear: 0.05,
  },
];

const ONE_ROUTE_ONLY_PLAN: EvenPlan = {
  goal: EVEN, targets: [], balanced: false, noLegs: false, moves: 10.0, shortOfEven: 5, roundCap: 1,
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
    interestPaidUsd: 0, interestPerDayUsd: 0, ratePerYear: 0.0564,
  },
  {
    coin: 'USDC', venue: 'HYPERLIQUID', cash: 100.0, upnl: 0, equity: 100.0, borrow: 0, imHeldUsd: 0, mmHeldUsd: 0,
    interestPaidUsd: 0, interestPerDayUsd: 0, ratePerYear: 0.05,
  },
];

const HIDDEN_ROUTE_TARGET: WalletAfter[] = [
  { coin: 'USDT', venue: 'CROSSEX', cash: 250.0, equity: 250.0 },
  { coin: 'USDC', venue: 'HYPERLIQUID', cash: 250.0, equity: 250.0 },
];

const HIDDEN_ROUTE_PLAN: EvenPlan = {
  goal: EVEN, targets: [], balanced: false, noLegs: false, moves: 150.0, shortOfEven: 0, roundCap: 1,
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

const HL_ETH = 'HYPERLIQUID_FUTURE_ETH_USDC';
const GATE_ETH = 'GATE_FUTURE_ETH_USDT';

function bucketOf(
  coin: string, venue: string, cash: number, upnl: number, borrow: number, perDay: number, ratePerYear: number,
): RebalanceBucket {
  return {
    coin, venue, cash, upnl, equity: cash + upnl, borrow, imHeldUsd: borrow * 0.2, mmHeldUsd: borrow * 0.1,
    interestPaidUsd: 0, interestPerDayUsd: perDay, ratePerYear,
  };
}

function loopRoute(
  rounds: number, move: number, costUsd: number, seconds: number, savesPerDayUsd: number, after: WalletAfter[],
  path: { from: Pool; to: Pool },
): RoutePlan {
  const each = move / rounds;
  return {
    available: true, reason: null, costUsd, seconds, rounds, oneMoreRoundCostUsd: null, marginFreedUsd: 0,
    savesPerDayUsd, after,
    steps: Array.from({ length: rounds }, (_, index) => ({
      round: index + 1, kind: 'round' as const, buy: each, move: each, arrives: each - 1, borrowLeft: 0,
      seconds: seconds / rounds, ...path,
    })),
  };
}

function convertRoute(
  moves: number[], costUsd: number, savesPerDayUsd: number, after: WalletAfter[], paths: { from: Pool; to: Pool }[],
): RoutePlan {
  return {
    available: true, reason: null, costUsd, seconds: 0, rounds: 0, oneMoreRoundCostUsd: null, marginFreedUsd: 0,
    savesPerDayUsd, after,
    steps: moves.map((move, index) => ({
      round: null, kind: 'convert' as const, buy: 0, move, arrives: move * 0.998, borrowLeft: 0, seconds: 0,
      ...paths[index]!,
    })),
  };
}

function realizeEven(
  goal: Goal, moves: number, routes: EvenPlan['routes'], recommended: RouteName, realize: EvenPlan['realize'],
  extra: Partial<EvenPlan> = {},
): EvenPlan {
  return {
    goal, balanced: false, noLegs: false, moves, shortOfEven: 0, roundCap: 6, split: EVEN_SPLIT, targets: [], routes,
    recommended, realize, customMaxUsd: null, ...extra,
  };
}

const HL_TO_GATE = { from: 'HYPERLIQUID', to: 'CROSSEX' } as const;

const OWNER_ETH_LEG: RealizeLeg = {
  pool: 'HYPERLIQUID', symbol: HL_ETH, exchange: 'HYPERLIQUID', base: 'ETH', side: 'SHORT', positionQty: 66.0,
  qty: 53.8, realizedUsd: 34386, convert: { amount: 10298, count: 1, feeUsd: 20.6 }, closeFeeUsd: 40.9,
  reopenFeeUsd: 40.89, closeImpactUsd: 9.44, reopenImpactUsd: 9.44, impactBp: 1.9,
};

const OWNER_BUCKETS: RebalanceBucket[] = [
  bucketOf('USDT', 'CROSSEX', -29812, 0, 29812, 4.9357, 0.0596),
  { ...bucketOf('USDC', 'HYPERLIQUID', 3140, 42174, 0, 0, 0.05), imHeldUsd: 0, mmHeldUsd: 0 },
];

const OWNER_AFTER: WalletAfter[] = [
  { coin: 'USDT', venue: 'CROSSEX', cash: 7687, equity: 7687 },
  { coin: 'USDC', venue: 'HYPERLIQUID', cash: 0, equity: 7687 },
];

const OWNER_ROUTES: EvenPlan['routes'] = {
  mix: null,
  loop: loopRoute(6, 27228, 6, 2400, 4.94, OWNER_AFTER, HL_TO_GATE),
  convert: convertRoute([27228], 54.46, 4.94, OWNER_AFTER, [HL_TO_GATE]),
};

const OWNER_REALIZE = { legs: [OWNER_ETH_LEG], refused: null };

const OWNER_EVEN = realizeEven({ kind: 'even' }, 37526, OWNER_ROUTES, 'loop', OWNER_REALIZE);

const OWNER_CLEAR_LEG: RealizeLeg = {
  ...OWNER_ETH_LEG, qty: 42.2, realizedUsd: 26971, convert: { amount: 8100, count: 1, feeUsd: 16.2 },
  closeFeeUsd: 32.05, reopenFeeUsd: 32.05, closeImpactUsd: 7.4, reopenImpactUsd: 7.4,
};

const OWNER_CLEAR_AFTER: WalletAfter[] = [
  { coin: 'USDT', venue: 'CROSSEX', cash: 0, equity: 0 },
  { coin: 'USDC', venue: 'HYPERLIQUID', cash: 0, equity: 15402 },
];

const OWNER_REPAY = realizeEven(
  { kind: 'repay' }, 29812,
  {
    mix: null,
    loop: loopRoute(5, 21712, 5, 2000, 4.94, OWNER_CLEAR_AFTER, HL_TO_GATE),
    convert: convertRoute([21712], 43.42, 4.94, OWNER_CLEAR_AFTER, [HL_TO_GATE]),
  },
  'loop', { legs: [OWNER_CLEAR_LEG], refused: null },
);

const CUSTOM_HL_TO_GATE: Goal = { kind: 'custom', from: 'HYPERLIQUID', to: 'CROSSEX', amount: 37526 };

const OWNER_CUSTOM = { ...OWNER_EVEN, goal: CUSTOM_HL_TO_GATE, customMaxUsd: 3140 };

const OWNER_CASH_AFTER: WalletAfter[] = [
  { coin: 'USDT', venue: 'CROSSEX', cash: -26812, equity: -26812 },
  { coin: 'USDC', venue: 'HYPERLIQUID', cash: 140, equity: 42314 },
];

const OWNER_CUSTOM_CASH = realizeEven(
  { kind: 'custom', from: 'HYPERLIQUID', to: 'CROSSEX', amount: 3000 }, 3000,
  {
    mix: null,
    loop: loopRoute(1, 3000, 1, 400, 0.5, OWNER_CASH_AFTER, HL_TO_GATE),
    convert: convertRoute([3000], 6, 0.5, OWNER_CASH_AFTER, [HL_TO_GATE]),
  },
  'loop', null, { customMaxUsd: 3140 },
);

const OWNER_ABOVE_LEG: RealizeLeg = {
  ...OWNER_ETH_LEG, qty: 26.4, realizedUsd: 16872, convert: { amount: 5050, count: 1, feeUsd: 10.1 },
  closeFeeUsd: 20.05, reopenFeeUsd: 20.05, closeImpactUsd: 4.64, reopenImpactUsd: 4.64,
};

const OWNER_ABOVE_AFTER: WalletAfter[] = [
  { coin: 'USDT', venue: 'CROSSEX', cash: -9812, equity: -9812 },
  { coin: 'USDC', venue: 'HYPERLIQUID', cash: 0, equity: 25400 },
];

const OWNER_CUSTOM_ABOVE = realizeEven(
  { kind: 'custom', from: 'HYPERLIQUID', to: 'CROSSEX', amount: 20000 }, 20000,
  {
    mix: null,
    loop: loopRoute(4, 14950, 4, 1600, 3, OWNER_ABOVE_AFTER, HL_TO_GATE),
    convert: convertRoute([14950], 29.9, 3, OWNER_ABOVE_AFTER, [HL_TO_GATE]),
  },
  'loop', { legs: [OWNER_ABOVE_LEG], refused: null }, { customMaxUsd: 3140 },
);

const SPLIT_LEG: RealizeLeg = {
  pool: 'HYPERLIQUID', symbol: 'HYPERLIQUID_FUTURE_BTC_USDC', exchange: 'HYPERLIQUID', base: 'BTC', side: 'SHORT',
  positionQty: 92.7, qty: 58.9, realizedUsd: 1266816, convert: { amount: 955498, count: 2, feeUsd: 1911 },
  closeFeeUsd: 1591.91, reopenFeeUsd: 1591.91, closeImpactUsd: 557.87, reopenImpactUsd: 557.86, impactBp: 2.9,
};

const SPLIT_BUCKETS: RebalanceBucket[] = [
  bucketOf('USDT', 'CROSSEX', -1652243, 0, 1652243, 273.538, 0.0596),
  { ...bucketOf('USDC', 'HYPERLIQUID', 387902, 2040144, 0, 0, 0.05), imHeldUsd: 0, mmHeldUsd: 0 },
];

const SPLIT_AFTER: WalletAfter[] = [
  { coin: 'USDT', venue: 'CROSSEX', cash: 0, equity: 0 },
  { coin: 'USDC', venue: 'HYPERLIQUID', cash: 0, equity: 769029 },
];

const SPLIT_ROUTES: EvenPlan['routes'] = {
  mix: null,
  loop: loopRoute(27, 699219, 563.9, 9300, 273.54, SPLIT_AFTER, HL_TO_GATE),
  convert: convertRoute([699219], 1398.44, 273.54, SPLIT_AFTER, [HL_TO_GATE]),
};

const SPLIT_REALIZE = { legs: [SPLIT_LEG], refused: null };

const SPLIT_REPAY = realizeEven({ kind: 'repay' }, 1654717, SPLIT_ROUTES, 'loop', SPLIT_REALIZE);

const ETH_UP_LEG: RealizeLeg = {
  pool: 'CROSSEX', symbol: GATE_ETH, exchange: 'GATE', base: 'ETH', side: 'LONG', positionQty: 66.0, qty: 47.1,
  realizedUsd: 30585, convert: null, closeFeeUsd: 55.77, reopenFeeUsd: 55.77, closeImpactUsd: 12.63,
  reopenImpactUsd: 12.63, impactBp: 1.9,
};

const ETH_UP_BUCKETS: RebalanceBucket[] = [
  { ...bucketOf('USDC', 'HYPERLIQUID', -18400, 0, 18400, 2.53, 0.1095), imHeldUsd: 3680, mmHeldUsd: 1840 },
  { ...bucketOf('USDT', 'CROSSEX', 0, 42900, 0, 0, 0.0564), imHeldUsd: 0, mmHeldUsd: 0 },
];

const ETH_UP_AFTER: WalletAfter[] = [
  { coin: 'USDC', venue: 'HYPERLIQUID', cash: 12178, equity: 12178 },
  { coin: 'USDT', venue: 'CROSSEX', cash: 0, equity: 12178 },
];

const GATE_TO_HL = { from: 'CROSSEX', to: 'HYPERLIQUID' } as const;

const ETH_UP_EVEN = realizeEven(
  { kind: 'even' }, 30585,
  {
    mix: null,
    loop: loopRoute(7, 30585, 7, 2700, 2.53, ETH_UP_AFTER, GATE_TO_HL),
    convert: convertRoute([30585], 61.17, 2.53, ETH_UP_AFTER, [GATE_TO_HL]),
  },
  'loop', { legs: [ETH_UP_LEG], refused: null },
);

const NOT_WORTH_LEG: RealizeLeg = {
  ...OWNER_ETH_LEG, positionQty: 4.0, qty: 0.4, realizedUsd: 261, convert: null, closeFeeUsd: 0.31,
  reopenFeeUsd: 0.31, closeImpactUsd: 0.04, reopenImpactUsd: 0.04, impactBp: 1.1,
};

const NOT_WORTH_BUCKETS: RebalanceBucket[] = [
  bucketOf('USDT', 'CROSSEX', -300, 0, 300, 0.0289, 0.035),
  { ...bucketOf('USDC', 'HYPERLIQUID', 40, 2556, 0, 0, 0.05), imHeldUsd: 0, mmHeldUsd: 0 },
];

const NOT_WORTH_AFTER: WalletAfter[] = [
  { coin: 'USDT', venue: 'CROSSEX', cash: 0, equity: 0 },
  { coin: 'USDC', venue: 'HYPERLIQUID', cash: 0, equity: 2294 },
];

const NOT_WORTH_REPAY = realizeEven(
  { kind: 'repay' }, 301,
  {
    mix: null,
    loop: loopRoute(1, 301, 1, 600, 0.0289, NOT_WORTH_AFTER, HL_TO_GATE),
    convert: convertRoute([301], 0.6, 0.0289, NOT_WORTH_AFTER, [HL_TO_GATE]),
  },
  'convert', { legs: [NOT_WORTH_LEG], refused: null },
);

function refusedLeg(over: Partial<RealizeLeg>): RealizeLeg {
  return { ...ETH_UP_LEG, side: 'SHORT', ...over };
}

const REFUSED_LEGS: RealizeLeg[] = [
  refusedLeg({
    qty: 11314.3, positionQty: 11314.3, realizedUsd: 10800000, closeFeeUsd: 10305.5, reopenFeeUsd: 10305.5,
    closeImpactUsd: 56118.5, reopenImpactUsd: 56118.5, impactBp: 54.5,
  }),
  refusedLeg({
    symbol: 'GATE_FUTURE_BTC_USDT', base: 'BTC', qty: 55.5, positionQty: 144.5, realizedUsd: 524465,
    closeFeeUsd: 1787.5, reopenFeeUsd: 1787.5, closeImpactUsd: 936, reopenImpactUsd: 936, impactBp: 5.2,
  }),
];

const REFUSED_BUCKETS: RebalanceBucket[] = [
  bucketOf('USDT', 'CROSSEX', -1500000, 0, 1500000, 250, 0.0596),
  { ...bucketOf('USDC', 'HYPERLIQUID', 1600000, 12000000, 0, 0, 0.05), imHeldUsd: 0, mmHeldUsd: 0 },
];

const REFUSED_AFTER: WalletAfter[] = [
  { coin: 'USDT', venue: 'CROSSEX', cash: 0, equity: 0 },
  { coin: 'USDC', venue: 'HYPERLIQUID', cash: 100000, equity: 12100000 },
];

function refusedPlan(refused: RealizeRefusal): EvenPlan {
  return realizeEven(
    { kind: 'even' }, 1500000,
    { mix: null, loop: null, convert: convertRoute([1500000], 3000, 250, REFUSED_AFTER, [HL_TO_GATE]) }, 'convert',
    { legs: REFUSED_LEGS, refused },
  );
}

const THREE_BUCKETS: RebalanceBucket[] = [
  bucketOf('USDT', 'CROSSEX', -338.25, 0, 338.25, 0.0537, 0.0596),
  { ...bucketOf('USDC', 'HYPERLIQUID', 1301.18, 0, 0, 0, 0.05), imHeldUsd: 0, mmHeldUsd: 0 },
  { ...bucketOf('USDC', 'LIGHTER', 276.57, 0, 0, 0, 0.05), imHeldUsd: 0, mmHeldUsd: 0 },
];

const THREE_AFTER: WalletAfter[] = [
  { coin: 'USDT', venue: 'CROSSEX', cash: 447.43, equity: 447.43 },
  { coin: 'USDC', venue: 'HYPERLIQUID', cash: 701.18, equity: 701.18 },
  { coin: 'USDC', venue: 'LIGHTER', cash: 90.57, equity: 90.57 },
];

const LIGHTER_TO_GATE = { from: 'LIGHTER', to: 'CROSSEX' } as const;

const THREE_EVEN = realizeEven(
  { kind: 'even' }, 786,
  {
    mix: null,
    loop: {
      ...loopRoute(2, 786, 1, 600, 0.0537, THREE_AFTER, HL_TO_GATE),
      steps: [
        { round: 1, kind: 'round', buy: 600, move: 600, arrives: 599, borrowLeft: 0, seconds: 300, ...HL_TO_GATE },
        { round: 2, kind: 'round', buy: 186, move: 186, arrives: 185, borrowLeft: 0, seconds: 300, ...LIGHTER_TO_GATE },
      ],
    },
    convert: convertRoute([600, 186], 1.57, 0.0537, THREE_AFTER, [HL_TO_GATE, LIGHTER_TO_GATE]),
  },
  'loop', null,
);

const OWNER_BOOK_PLANS: RebalancePlans = { even: OWNER_EVEN, repay: OWNER_REPAY, custom: OWNER_CUSTOM };

const WHALE_BUCKETS: RebalanceBucket[] = [
  bucketOf('USDT', 'CROSSEX', -4500000, 0, 4500000, 740.5, 0.0596),
  { ...bucketOf('USDC', 'HYPERLIQUID', 500000, 10000000, 0, 0, 0.05), imHeldUsd: 0, mmHeldUsd: 0 },
];

const WHALE_AFTER: WalletAfter[] = [
  { coin: 'USDT', venue: 'CROSSEX', cash: 3000000, equity: 3000000 },
  { coin: 'USDC', venue: 'HYPERLIQUID', cash: 0, equity: 3000000 },
];

const WHALE_LEG: RealizeLeg = {
  pool: 'HYPERLIQUID', symbol: HL_ETH, exchange: 'HYPERLIQUID', base: 'ETH', side: 'SHORT', positionQty: 13400.5,
  qty: 11000, realizedUsd: 7000000, convert: { amount: 999999.995, count: 2, feeUsd: 2000 },
  closeFeeUsd: 8346.5, reopenFeeUsd: 8346.4, closeImpactUsd: 1925.2, reopenImpactUsd: 1925.1, impactBp: 2.8,
};

const WHALE_ROUTES: EvenPlan['routes'] = {
  mix: null,
  loop: loopRoute(6, 6500000, 5200, 2400, 740.5, WHALE_AFTER, HL_TO_GATE),
  convert: convertRoute([7500000], 15000, 740.5, WHALE_AFTER, [HL_TO_GATE]),
};

const WHALE_REALIZE = { legs: [WHALE_LEG], refused: null };

const WHALE_EVEN = realizeEven({ kind: 'even' }, 7500000, WHALE_ROUTES, 'loop', WHALE_REALIZE);

const WHALE_BOOK_PLANS: RebalancePlans = {
  even: WHALE_EVEN,
  repay: realizeEven({ kind: 'repay' }, 4500000, WHALE_ROUTES, 'loop', WHALE_REALIZE),
  custom: { ...WHALE_EVEN, goal: { kind: 'custom', from: 'HYPERLIQUID', to: 'CROSSEX', amount: 7500000 }, customMaxUsd: 10500000 },
};

const WHALE_VIEW = { buckets: WHALE_BUCKETS, plans: WHALE_BOOK_PLANS };

const r1 = (n: number): number => Math.round(n * 10) / 10;
const r2 = (n: number): number => Math.round(n * 100) / 100;
const r4 = (n: number): number => Math.round(n * 10_000) / 10_000;
const r6 = (n: number): number => Math.round(n * 1_000_000) / 1_000_000;

const ACCT_IM: ImUsedRow[] = [{ account: 'CROSSEX', pct: 0.42 }, { account: 'HYPERLIQUID', pct: 0.18 }];

interface BorrowBook {
  borrow: number;
  cash: number;
  upnl: number;
  rate: number;
  realized: number;
  mid: number;
}

function borrowBook(borrow: number, cash: number, upnl: number, rate: number): BorrowBook {
  const need = borrow > cash ? r2(borrow / 0.998 - cash) : 0;
  return { borrow, cash, upnl, rate, mid: ACCT_MID, realized: need > 0 && upnl >= need ? need : 0 };
}

const perDayOf = (b: BorrowBook): number => (b.borrow * b.rate) / 365;

const ACCT_MID = 3200;

function acctLeg(realized: number, sliceUsd: number | null): RealizeLeg {
  const qty = r1((realized * 11.2) / 7127.72);
  const leg: RealizeLeg = {
    pool: 'HYPERLIQUID', symbol: HL_ETH, exchange: 'HYPERLIQUID', base: 'ETH', side: 'SHORT', positionQty: r1(qty * 1.25), qty,
    realizedUsd: realized, convert: { amount: realized, count: Math.ceil(realized / 500_000), feeUsd: r2(realized * 0.002) },
    closeFeeUsd: r2(realized * 0.001), reopenFeeUsd: r2(realized * 0.001), closeImpactUsd: r2(realized * 0.00045),
    reopenImpactUsd: r2(realized * 0.00045), impactBp: 0.9,
  };
  const maker = makerEstimateOf(leg);
  const impactUsd = sliceUsd === null ? maker.impactUsd : sliceRow(qty * ACCT_MID, ACCT_MID, sliceUsd, false).impactUsd;
  return { ...leg, realizedUsd: r2(realized + maker.feeUsd + impactUsd) };
}

function makerEstimateOf(leg: RealizeLeg): RealizeEstimate {
  return estimateOf(leg.closeFeeUsd * 0.4 + leg.reopenFeeUsd + (leg.convert?.feeUsd ?? 0), leg.reopenImpactUsd);
}

function estimateOf(feeUsd: number, impactUsd: number): RealizeEstimate {
  return { feeUsd: r2(feeUsd), impactUsd: r2(impactUsd), totalUsd: r2(feeUsd + impactUsd) };
}

function acctRealize(realized: number, refused: RealizeRefusal | null = null, sliceUsd: number | null = null): RealizePlan {
  const leg = acctLeg(realized, sliceUsd);
  const convert = leg.convert?.feeUsd ?? 0;
  return {
    legs: [leg], refused,
    estimates: {
      maker: makerEstimateOf(leg),
      market: estimateOf(leg.closeFeeUsd + leg.reopenFeeUsd + convert, leg.closeImpactUsd + leg.reopenImpactUsd),
    },
  };
}

function sliceRow(totalUsd: number, mid: number, sizeUsd: number, custom: boolean, whole = false): SliceOption {
  const count = Math.ceil(totalUsd / sizeUsd);
  const lead = Math.min(sizeUsd, totalUsd);
  const impactBp = r2((0.9 * lead) / totalUsd);
  return {
    sizeUsd, custom, whole, count, impactBp, impactUsd: r2((totalUsd * impactBp) / 10_000), reopenImpactUsd: r2((totalUsd * impactBp) / 10_000), pastBook: false, notHedgedMaxQty: r2(lead / mid),
    notHedgedMaxUsd: lead, seconds: { maker: count * 300, market: count * 2 },
  };
}

const SLICE_SIZES = [25_000, 50_000, 100_000, 250_000];

function sliceRowsOf(totalUsd: number, mid: number, custom: number | null = null): SliceOption[] {
  const rows = SLICE_SIZES.map((size) => sliceRow(totalUsd, mid, size, false));
  const whole = sliceRow(totalUsd, mid, 1e12, false, true);
  return custom === null ? [...rows, whole] : [...rows, sliceRow(totalUsd, mid, custom, true), whole];
}

function acctTab(b: BorrowBook, refused: RealizeRefusal | null, custom: number | null): RealizeTab {
  const clearDebt = b.realized > 0 ? acctRealize(b.realized, refused, custom ?? 25_000) : null;
  const all = b.upnl > 0 ? acctRealize(b.upnl, refused, clearDebt ? null : (custom ?? 25_000)) : null;
  const lead = clearDebt ?? all;
  return {
    pool: 'HYPERLIQUID', pools: ['HYPERLIQUID'], clearDebt, all, custom: null,
    sliceOptions: lead === null ? [] : sliceRowsOf(lead.legs[0]!.qty * b.mid, b.mid, custom),
    defaultSliceUsd: custom ?? 25_000,
  };
}

function acctFull(b: BorrowBook, refused: RealizeRefusal | null): FullPlan {
  const cleared = b.cash >= b.borrow || (b.realized > 0 && refused === null);
  const moved = b.cash >= b.borrow ? b.borrow : b.cash + (cleared ? b.realized : 0);
  const moveCostUsd = r2(moved * 0.002);
  const realizeCostUsd = cleared && b.realized > 0 ? acctRealize(b.realized).estimates!.maker.totalUsd : 0;
  const costUsd = r2(moveCostUsd + realizeCostUsd);
  return {
    costUsd, days: cleared ? Math.ceil(costUsd / perDayOf(b)) : null, clearsBorrow: cleared,
    needsRealize: b.borrow > b.cash && b.realized > 0, moveCostUsd, realizeCostUsd,
    interestPerMonthUsd: r2(perDayOf(b) * 30), refused,
  };
}

function acctBuckets(b: BorrowBook): RebalanceBucket[] {
  return [
    bucketOf('USDT', 'CROSSEX', -b.borrow, 0, b.borrow, r4(perDayOf(b)), b.rate),
    { ...bucketOf('USDC', 'HYPERLIQUID', b.cash, b.upnl, 0, 0, 0.05), imHeldUsd: 0, mmHeldUsd: 0 },
  ];
}

function acctPlans(b: BorrowBook): RebalancePlans {
  const moved = Math.min(b.cash, b.borrow);
  const after: WalletAfter[] = [
    { coin: 'USDT', venue: 'CROSSEX', cash: r2(moved * (1 - 0.002) - b.borrow), equity: r2(moved * (1 - 0.002) - b.borrow) },
    { coin: 'USDC', venue: 'HYPERLIQUID', cash: r2(b.cash - moved), equity: r2(b.cash - moved + b.upnl) },
  ];
  const repay = realizeEven(
    { kind: 'repay' }, moved,
    { mix: null, loop: null, convert: convertRoute([moved], r2(moved * 0.002), r2(perDayOf(b)), after, [HL_TO_GATE]) },
    'convert', null, { shortOfEven: r2(Math.max(0, b.borrow - b.cash)) },
  );
  return { even: { ...repay, goal: { kind: 'even' } }, repay, custom: null };
}

function acctView(
  b: BorrowBook, refused: RealizeRefusal | null = null, custom: number | null = null, over: Partial<RebalanceView> = {},
): RebalanceView {
  return {
    buckets: acctBuckets(b), plans: acctPlans(b), realize: acctTab(b, refused, custom), fullPlan: acctFull(b, refused),
    imUsed: ACCT_IM, job: null, ...over,
  };
}

export const realizeCustomPlan = (usd: number, sliceUsd: number | null = null): RealizePlan => acctRealize(usd, null, sliceUsd);

const OWNER_ACCOUNT = borrowBook(7169.33, 55.98, 9400, 0.0596);
const WHALE_ACCOUNT = borrowBook(6_000_000, 46_850, 12_345_678.9, 0.0596);
const WHALE_SLICE_USD = 999_999.995;

const ACCT_STARTED = REBALANCE_NOW - 600_000;

function acctSteps(leg: RealizeLeg, statuses: [RebalanceStep['status'], RebalanceStep['status']]): RebalanceStep[] {
  const [slices, convert] = statuses;
  const times = (status: RebalanceStep['status'], index: number): Partial<RebalanceStep> =>
    status === 'done'
      ? { startedAt: ACCT_STARTED + index * 4_000, doneAt: ACCT_STARTED + index * 4_000 + 3_000 }
      : status === 'running' ? { startedAt: REBALANCE_NOW - 3_000 } : {};
  const perp = { symbol: HL_ETH, exchange: 'HYPERLIQUID', side: 'BUY', reduceOnly: true } as const;
  return [
    jobStep({
      ...HL_TO_GATE, from: 'HYPERLIQUID', to: 'HYPERLIQUID', name: 'Slices', round: null, planned: leg.qty, status: slices,
      qty: slices === 'done' ? leg.qty : null, perp, nextTryAt: null, phase: 'realize', ...times(slices, 0),
    }),
    jobStep({
      ...HL_TO_GATE, name: 'Convert', round: null, planned: leg.convert?.amount ?? 0, status: convert,
      qty: convert === 'done' ? (leg.convert?.amount ?? 0) : null, perp: null, nextTryAt: null, phase: 'realize', ...times(convert, 1),
    }),
  ];
}

function acctJob(
  b: BorrowBook, statuses: [RebalanceStep['status'], RebalanceStep['status']],
  filledQty: number, over: Partial<RebalanceJob>,
): RebalanceJob {
  const leg = acctLeg(b.realized, null);
  const plan = acctRealize(b.realized);
  return {
    id: 'acct0001', goal: 'repay', route: 'convert', amount: b.realized, costUsd: plan.estimates!.maker.totalUsd,
    target: [
      { coin: 'USDT', venue: 'CROSSEX', cash: 0, equity: 0 },
      { coin: 'USDC', venue: 'HYPERLIQUID', cash: 0, equity: r2(b.upnl - b.realized) },
    ],
    status: 'running', stepIndex: Math.max(0, statuses.findIndex((status) => status !== 'done')), steps: acctSteps(leg, statuses),
    fundsAt: 'HYPERLIQUID', haltReason: null, createdAt: ACCT_STARTED, updatedAt: REBALANCE_NOW - 3_000, inTransit: null,
    realize: {
      legs: [{
        symbol: HL_ETH, base: 'ETH', exchange: 'HYPERLIQUID', pool: 'HYPERLIQUID', side: 'SHORT', positionQty: leg.positionQty,
        qty: leg.qty, filledQty, realizedUsd: r2((b.realized * filledQty) / leg.qty), closeFeeUsd: leg.closeFeeUsd,
        reopenFeeUsd: leg.reopenFeeUsd, closeImpactUsd: leg.closeImpactUsd, reopenImpactUsd: leg.reopenImpactUsd,
        convert: { amount: leg.convert!.amount, feeUsd: leg.convert!.feeUsd },
      }],
    },
    before: {
      buckets: acctBuckets(b),
      perps: [
        { symbol: HL_ETH, exchange: 'HYPERLIQUID', side: 'SHORT', qty: leg.positionQty },
        { symbol: GATE_ETH, exchange: 'GATE', side: 'LONG', qty: leg.positionQty },
      ],
    },
    kind: 'realize', exec: 'maker', slice: null, notHedgedQty: 0, followMisses: 0, follow: null, borosGapYu: 0, borosLeftYu: 0,
    feeSoFarUsd: 0, estimate: plan.estimates!.maker, pauseRequested: false, paused: false, delever: null, imUsedNow: null,
    imUsedEnd: null, imUsedStart: null, totalCostUsd: null, haltKind: null, ...over,
  };
}

function acctJobs(b: BorrowBook, sliceUsd: number) {
  const leg = acctLeg(b.realized, null);
  const count = Math.ceil((leg.qty * b.mid) / sliceUsd);
  const filled = r1(Math.min(sliceUsd / b.mid, leg.qty) / 2);
  const slice = { index: 1, count, sizeUsd: sliceUsd };
  const feeSoFarUsd = r2((leg.closeFeeUsd * 0.4 * filled) / leg.qty);
  const running = acctJob(b, ['running', 'pending'], filled, { slice, notHedgedQty: filled, feeSoFarUsd, totalCostUsd: feeSoFarUsd });
  const followed = acctJob(b, ['running', 'pending'], filled, {
    slice, notHedgedQty: filled, feeSoFarUsd, totalCostUsd: feeSoFarUsd, followMisses: 3,
    follow: { symbol: HL_ETH, exchange: 'HYPERLIQUID', side: 'SELL', qty: filled, reduceOnly: false },
  });
  return {
    running,
    pausing: { ...running, pauseRequested: true },
    paused: { ...running, status: 'halted', paused: true, notHedgedQty: 0 } satisfies RebalanceJob,
    followMissed: followed,
    stoppedNotHedged: {
      ...followed, status: 'halted', haltKind: 'not-hedged',
      haltReason: `Gate CrossEx takes no new orders on this contract. Resume when it does, or close ${filled} ETH of the Gate long in Positions.`,
    } satisfies RebalanceJob,
    stoppedMargin: {
      ...followed, status: 'halted', followMisses: 1, haltKind: 'margin',
      haltReason: 'Not enough margin, and no cash left to convert. Move USDT into USDT · CrossEx, then Resume.',
    } satisfies RebalanceJob,
    done: acctJob(b, ['done', 'done'], leg.qty, {
      status: 'done', stepIndex: 1, slice: { index: count, count, sizeUsd: sliceUsd },
      feeSoFarUsd: r2(acctRealize(b.realized).estimates!.maker.feeUsd),
      totalCostUsd: r2(acctRealize(b.realized).estimates!.maker.totalUsd * 1.04), createdAt: REBALANCE_NOW - 41 * 60_000,
      updatedAt: REBALANCE_NOW,
    }),
  };
}

const OWNER_JOBS = acctJobs(OWNER_ACCOUNT, 25_000);
const WHALE_JOBS = acctJobs(WHALE_ACCOUNT, WHALE_SLICE_USD);

export const REALIZE_RUNNING_JOB: RebalanceJob = OWNER_JOBS.running;

const OWNER_DONE_CASH = r2(OWNER_ACCOUNT.cash + OWNER_ACCOUNT.realized);
const OWNER_DONE_UPNL = r2(OWNER_ACCOUNT.upnl - OWNER_ACCOUNT.realized);

const OWNER_DONE_VIEW_BUCKETS = rebased(acctBuckets(OWNER_ACCOUNT), {
  'USDC/HYPERLIQUID': { cash: OWNER_DONE_CASH, upnl: OWNER_DONE_UPNL, equity: r2(OWNER_DONE_CASH + OWNER_DONE_UPNL) },
});

const OWNER_REALIZE_DONE_JOB: RebalanceJob = {
  ...OWNER_JOBS.done,
  target: [
    { coin: 'USDT', venue: 'CROSSEX', cash: 0, equity: -OWNER_ACCOUNT.borrow },
    { coin: 'USDC', venue: 'HYPERLIQUID', cash: OWNER_DONE_CASH, equity: r2(OWNER_DONE_CASH + OWNER_DONE_UPNL) },
  ],
};

const BTC_MID = 90_000;
const HL_BTC = 'HYPERLIQUID_FUTURE_BTC_USDC';
const GATE_BTC = 'GATE_FUTURE_BTC_USDT';
const DELEVER_START_IM = 0.912;
const DELEVER_END_IM = 0.742;

interface DeleverPairSpec {
  base: string;
  mid: number;
  perps: { symbol: string; exchange: string; side: 'LONG' | 'SHORT' }[];
}

const BTC_DELEVER: DeleverPairSpec = {
  base: 'BTC', mid: BTC_MID,
  perps: [{ symbol: HL_BTC, exchange: 'HYPERLIQUID', side: 'LONG' }, { symbol: GATE_BTC, exchange: 'GATE', side: 'SHORT' }],
};

const WHALE_ETH_DELEVER: DeleverPairSpec = {
  base: 'ETH', mid: 2472.74,
  perps: [
    { symbol: 'HYPERLIQUID_FUTURE_ETH_USDC', exchange: 'HYPERLIQUID', side: 'LONG' },
    { symbol: 'BINANCE_FUTURE_ETH_USDT', exchange: 'BINANCE', side: 'SHORT' },
  ],
};

function deleverPlanOf(
  size: number, boros: number[], pct: number, over: Partial<DeleverPlan> = {}, pair: DeleverPairSpec = BTC_DELEVER,
): DeleverPlan {
  const close = r6((size * pct) / 100);
  const legs: DeleverPlan['legs'] = pair.perps.map((perp) => ({
    ...perp, base: pair.base, before: size, after: r6(size - close), closeQty: close,
  }));
  const borosRows = boros.map((before, index) => {
    const closeSize = r6((before * pct) / 100);
    return { marketId: 101 + index, before, after: r6(before - closeSize), closeSize };
  });
  const notional = close * pair.mid;
  const borosClosed = borosRows.reduce((sum, row) => sum + row.closeSize, 0);
  const options = sliceRowsOf(notional, pair.mid);
  const lead = options[options.length - 1]!;
  return {
    legs, boros: borosRows,
    imUsed: [{ account: 'CROSSEX', before: DELEVER_START_IM, after: DELEVER_END_IM }],
    makerLeg: 1, sliceOptions: options, defaultSliceUsd: lead.sizeUsd,
    estimates: {
      maker: { feePerpsUsd: r2(notional * 0.00065), feeBorosUsd: r2(borosClosed * 0.025), impactUsd: r2(notional * 0.00009 + borosClosed * 0.01), totalUsd: 0 },
      market: { feePerpsUsd: r2(notional * 0.0009), feeBorosUsd: r2(borosClosed * 0.025), impactUsd: r2(notional * 0.00018 + borosClosed * 0.01), totalUsd: 0 },
    },
    notHedgedMaxQty: lead.notHedgedMaxQty, notHedgedMaxUsd: lead.notHedgedMaxUsd, refused: null, ...over,
  };
}

function withTotals(plan: DeleverPlan): DeleverPlan {
  const total = (e: DeleverEstimate): DeleverEstimate => ({ ...e, totalUsd: r2(e.feePerpsUsd + e.feeBorosUsd + e.impactUsd) });
  return { ...plan, estimates: { maker: total(plan.estimates.maker), market: total(plan.estimates.market) } };
}

export const deleverPlans = {
  twentyPct: withTotals(deleverPlanOf(900, [900], 20)),
  belowMin: withTotals(deleverPlanOf(0.004, [0.004], 10, {
    refused: { reason: 'below-min', venue: 'GATE', minQty: 0.001, coin: 'BTC' },
  })),
  sameSide: withTotals(deleverPlanOf(900, [900], 20, { refused: { reason: 'same-side', coin: 'BTC' } })),
  twoBoros: withTotals(deleverPlanOf(900, [500, 400], 20)),
  twoBorosEqual: withTotals(deleverPlanOf(900, [450, 450], 20)),
  noBoros: withTotals(deleverPlanOf(900, [], 20)),
  whale: withTotals(deleverPlanOf(4100, [4100], 20, {}, WHALE_ETH_DELEVER)),
} satisfies Record<string, DeleverPlan>;

type DeleverTwapBody = { durationSec?: number; intervalSec?: number; slices?: number };

function deleverTwapOf(plan: DeleverPlan, price: number, input: DeleverTwapBody, thinAtSlices: number): DeleverPlan {
  const close = plan.legs[plan.makerLeg]!.closeQty;
  const durationSec = input.durationSec ?? 3_600;
  const intervalSec = input.intervalSec ?? 300;
  const slices = Math.max(1, input.slices ?? Math.floor(durationSec / intervalSec));
  const sliceQty = r6(close / slices);
  const coin = plan.legs[0]!.base;
  const refusal = slices <= thinAtSlices
    ? {
        field: 'sliceSize' as const,
        text: `Book too thin for ${sliceQty} ${coin} a slice.`,
        fix: { label: `Use ${r6(sliceQty / 2)} ${coin}`, patch: { durationSec, sliceQty: String(r6(sliceQty / 2)) } },
      }
    : null;
  const planView = refusal
    ? null
    : { slices, sliceQty: String(sliceQty), lastQty: String(sliceQty), intervalSec, durationSec, takerAfterSec: Math.floor(intervalSec * 0.8) };
  return { ...plan, twap: { plan: planView, refusal, price }, priceImpact: { whole: null, sliced: 1200 } };
}

export const deleverTwapPlans = {
  twentyPctTwap: (input: DeleverTwapBody) => deleverTwapOf(deleverPlans.twentyPct, BTC_MID, input, 0),
  whaleTwap: (input: DeleverTwapBody) => deleverTwapOf(deleverPlans.whale, WHALE_ETH_DELEVER.mid, input, 2),
} satisfies Record<string, (input: DeleverTwapBody) => DeleverPlan>;

const BTC_IM_USD = 4_050_000;

function btcPair(size: number, boros: number[]): OpenPair {
  return {
    key: 'BTC:HYPERLIQUID:GATE:1794816000:spread', base: 'BTC', longVenue: 'HYPERLIQUID', shortVenue: 'GATE',
    maturitySec: 1_794_816_000, unit: 'base', size, imUsd: (BTC_IM_USD * size) / 900,
    perps: [
      { symbol: HL_BTC, exchange: 'HYPERLIQUID', side: 'LONG', qty: size },
      { symbol: GATE_BTC, exchange: 'GATE', side: 'SHORT', qty: size },
    ],
    boros: boros.map((amount, index) => ({ marketId: 101 + index, size: amount })),
  };
}

export const openPairs = {
  btc900: [btcPair(900, [900])],
  dollarPair: [{
    ...btcPair(5000, []), key: 'ETH:HYPERLIQUID:GATE:1794816000:singles', base: 'ETH', unit: 'usd', imUsd: 250, boros: [],
    perps: [
      { symbol: HL_ETH, exchange: 'HYPERLIQUID', side: 'LONG', qty: 5000 },
      { symbol: GATE_ETH, exchange: 'GATE', side: 'SHORT', qty: 5000 },
    ],
  } satisfies OpenPair],
  none: [] as OpenPair[],
} satisfies Record<string, OpenPair[]>;

function deleverJobs(size: number, sliceUsd: number, b: BorrowBook) {
  const pct = 20;
  const plan = deleverPlanOf(size, [size], pct);
  const total = withTotals(plan).estimates.maker;
  const close = plan.legs[0]!.closeQty;
  const count = Math.ceil((close * BTC_MID) / sliceUsd);
  const sliceQty = r2(Math.min(sliceUsd / BTC_MID, close));
  const doneSlices = Math.max(1, Math.floor(count * 0.3));
  const estimate = estimateOf(total.feePerpsUsd + total.feeBorosUsd, total.impactUsd);
  const lead = plan.legs[plan.makerLeg]!;
  const other = plan.legs[plan.makerLeg === 0 ? 1 : 0]!;
  const sideOf = (side: 'LONG' | 'SHORT'): 'BUY' | 'SELL' => (side === 'LONG' ? 'SELL' : 'BUY');
  const steps = (slices: RebalanceStep['status'], boros: RebalanceStep['status']): RebalanceStep[] => [
    jobStep({
      ...HL_TO_GATE, from: 'CROSSEX', to: 'CROSSEX', name: 'Slices', round: null, planned: close, status: slices,
      qty: slices === 'done' ? close : null, phase: 'realize', nextTryAt: null,
      perp: { symbol: lead.symbol, exchange: lead.exchange, side: sideOf(lead.side), reduceOnly: true },
      startedAt: REBALANCE_NOW - 3_000_000, doneAt: slices === 'done' ? REBALANCE_NOW - 600_000 : null,
    }),
    jobStep({
      ...HL_TO_GATE, from: 'CROSSEX', to: 'CROSSEX', name: 'Close Boros', round: null, planned: null, status: boros, qty: null,
      phase: 'realize', perp: null, nextTryAt: null, startedAt: boros === 'pending' ? null : REBALANCE_NOW - 600_000,
      doneAt: boros === 'done' ? REBALANCE_NOW - 60_000 : null,
    }),
  ];
  const leadLeg = (filledQty: number) => ({
    symbol: lead.symbol, base: lead.base, exchange: lead.exchange, pool: 'CROSSEX' as const, side: lead.side, positionQty: size,
    qty: close, filledQty, realizedUsd: 0,
  });
  const borosAt = (closed: number) => [{ marketId: 101, before: size, after: r6(size - close), closed }];
  const base: RebalanceJob = {
    ...acctJob(b, ['pending', 'pending'], 0, {}),
    id: 'delv0001', realize: { legs: [leadLeg(0)] }, steps: steps('running', 'pending'), stepIndex: 0, kind: 'delever', amount: 0,
    costUsd: estimate.totalUsd, target: null, exec: 'maker', estimate, before: null,
    delever: { pct: pct / 100, legs: plan.legs.map(({ symbol, exchange, base: coin, side, before, after }) => ({ symbol, exchange, base: coin, side, before, after })), boros: borosAt(0) },
    imUsedStart: [{ account: 'CROSSEX', pct: DELEVER_START_IM }],
    imUsedEnd: [{ account: 'CROSSEX', pct: DELEVER_END_IM }],
  };
  const sliced = (k: number): Partial<RebalanceJob> => ({
    realize: { legs: [leadLeg(r6(k * sliceQty))] },
    slice: { index: k + 1, count, sizeUsd: sliceUsd }, notHedgedQty: sliceQty,
    follow: { symbol: other.symbol, exchange: other.exchange, side: sideOf(other.side), qty: sliceQty, reduceOnly: true },
    feeSoFarUsd: r2((estimate.feeUsd * k) / count),
    totalCostUsd: r2((estimate.feeUsd * k) / count),
    imUsedNow: [{ account: 'CROSSEX', pct: r4(DELEVER_START_IM - ((DELEVER_START_IM - DELEVER_END_IM) * k) / count) }],
  });
  const finished = (closed: number): Partial<RebalanceJob> => ({
    realize: { legs: [leadLeg(close)] }, slice: { index: count, count, sizeUsd: sliceUsd }, notHedgedQty: 0, follow: null,
    borosGapYu: r6(close - closed), borosLeftYu: r6(close - closed), feeSoFarUsd: estimate.feeUsd, totalCostUsd: estimate.feeUsd,
    delever: { ...base.delever!, boros: borosAt(closed) },
    imUsedNow: [{ account: 'CROSSEX', pct: DELEVER_END_IM }],
  });
  const running: RebalanceJob = { ...base, ...sliced(doneSlices) };
  const pausedGap: RebalanceJob = {
    ...running, slice: { index: doneSlices, count, sizeUsd: sliceUsd }, status: 'halted', paused: true, notHedgedQty: 0, follow: null,
    borosGapYu: r6(doneSlices * sliceQty),
  };
  const haltedGap: RebalanceJob = {
    ...pausedGap, paused: false, haltKind: 'margin',
    haltReason: 'Not enough margin, and no cash left to convert. Move USDT into USDT · CrossEx, then Resume.',
  };
  const stoppedBoros: RebalanceJob = {
    ...base, ...finished(r6(close * 0.8)), steps: steps('done', 'running'), stepIndex: 1, status: 'halted', haltKind: 'boros',
    haltReason: 'Boros did not close all of its share. The rest has no perp behind it.',
  };
  const addBackQty = stoppedBoros.borosLeftYu ?? 0;
  const addBackText = addBackQty.toLocaleString('en-US', { maximumFractionDigits: 8 });
  const [firstPerp, secondPerp] = plan.legs;
  const addBackSteps = (boros: RebalanceStep['status']): RebalanceStep[] =>
    steps('done', boros).map((step, index) => (index === 1 ? {
      ...step, addBack: { qty: addBackQty, legs: [{ symbol: firstPerp!.symbol, filled: addBackQty }, { symbol: secondPerp!.symbol, filled: 0 }] },
    } : step));
  const addBackStopped = `Add back stopped: Hyperliquid ${addBackText} of ${addBackText} BTC, Gate 0 of ${addBackText} BTC.`;
  const partAddBack: RebalanceJob = {
    ...stoppedBoros, steps: addBackSteps('running'), haltReason: `${addBackStopped} Hold to add back to finish.`,
  };
  const abandonedAddBack: RebalanceJob = {
    ...stoppedBoros, ...finished(close), borosGapYu: 0, borosLeftYu: 0, steps: addBackSteps('done'), status: 'abandoned',
    haltReason: `${addBackStopped} The Gate short is ${addBackText} BTC smaller than the Hyperliquid long. Close ${addBackText} BTC of the Hyperliquid long in Positions.`,
    openGaps: [{
      leg: { symbol: secondPerp!.symbol, base: 'BTC', exchange: 'GATE', side: 'SHORT', positionQty: size, hedge: 'HYPERLIQUID' },
      qty: addBackQty,
      hedges: [{ symbol: firstPerp!.symbol, exchange: 'HYPERLIQUID', side: 'LONG', qty: size }],
    }],
  };
  return {
    running,
    pausing: { ...running, pauseRequested: true } satisfies RebalanceJob,
    haltedGap,
    abandonedGap: { ...haltedGap, status: 'abandoned' } satisfies RebalanceJob,
    followMissed: { ...running, followMisses: 3 } satisfies RebalanceJob,
    pausedGap: {
      ...running, slice: { index: doneSlices, count, sizeUsd: sliceUsd }, status: 'halted', paused: true, notHedgedQty: 0, follow: null,
      borosGapYu: r6(doneSlices * sliceQty),
    } satisfies RebalanceJob,
    stoppedBoros,
    partAddBack,
    abandonedAddBack,
    done: {
      ...base, ...finished(close), steps: steps('done', 'done'), stepIndex: 1, status: 'done', totalCostUsd: r2(estimate.totalUsd * 1.03),
      createdAt: REBALANCE_NOW - 3_600_000, updatedAt: REBALANCE_NOW,
    } satisfies RebalanceJob,
  };
}

const DELEVER_JOBS = deleverJobs(900, 250_000, OWNER_ACCOUNT);
const WHALE_DELEVER_JOBS = deleverJobs(66.7, 250_000, WHALE_ACCOUNT);

const FREE_BORROW_BUCKETS: RebalanceBucket[] = [
  bucketOf('USDC', 'HYPERLIQUID', -3200, 0, 3200, 0, 0.05),
  { ...bucketOf('USDT', 'CROSSEX', 1800, 0, 0, 0, 0.0596), imHeldUsd: 0, mmHeldUsd: 0 },
];

const NO_BORROW_BUCKETS: RebalanceBucket[] = [
  { ...bucketOf('USDT', 'CROSSEX', 800, 0, 0, 0, 0.0596), imHeldUsd: 0, mmHeldUsd: 0 },
  { ...bucketOf('USDC', 'HYPERLIQUID', 1200, 0, 0, 0, 0.05), imHeldUsd: 0, mmHeldUsd: 0 },
];

const interestFreeView: RebalanceView = {
  buckets: FREE_BORROW_BUCKETS, plans: plansOf(balancedPlan(afterOf(1800, -3200, 0))), realize: null,
  fullPlan: {
    costUsd: 0, days: null, clearsBorrow: false, needsRealize: false, moveCostUsd: 0, realizeCostUsd: 0,
    interestPerMonthUsd: 0, refused: null,
  },
  imUsed: ACCT_IM, job: null,
};

const ownerAccountLongView: RebalanceView = (() => {
  const view = acctView(OWNER_ACCOUNT);
  const legOf = (leg: RealizeLeg): RealizeLeg => ({ ...leg, side: 'LONG' });
  const tab = view.realize!;
  const planOf = (p: RealizePlan | null): RealizePlan | null => p && { ...p, legs: p.legs.map(legOf) };
  return { ...view, realize: { ...tab, clearDebt: planOf(tab.clearDebt), all: planOf(tab.all) } };
})();

const withJob = (view: RebalanceView, job: RebalanceJob): RebalanceView => ({ ...view, job });

export const rebalanceViews = {
  accountA: { buckets: ACCOUNT_A_BUCKETS, plans: plansOf(ACCOUNT_A_PLAN), job: null },
  accountARunning: { buckets: ACCOUNT_A_ROUND_3_BUCKETS, plans: plansOf(ACCOUNT_A_ROUND_3_PLAN), job: ACCOUNT_A_RUNNING_JOB },
  accountAHalted: { buckets: ACCOUNT_A_ROUND_3_BUCKETS, plans: plansOf(ACCOUNT_A_ROUND_3_PLAN), job: ACCOUNT_A_HALTED_JOB },
  accountAAbandoned: {
    buckets: ACCOUNT_A_ROUND_3_BUCKETS, plans: plansOf(ACCOUNT_A_ROUND_3_PLAN),
    job: { ...ACCOUNT_A_HALTED_JOB, status: 'abandoned' },
  },
  accountABlocked: { buckets: ACCOUNT_A_BUCKETS, plans: plansOf(ACCOUNT_A_PAUSED_PLAN), job: null },
  accountB: {
    buckets: ACCOUNT_B_BUCKETS,
    plans: plansOf({
      goal: EVEN, targets: [], balanced: false, noLegs: false, moves: 477.29, shortOfEven: 0, roundCap: 6, split: EVEN_SPLIT,
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
    }),
    job: null,
  },
  exampleC: {
    buckets: [
      {
        coin: 'USDT', venue: 'CROSSEX', cash: 165.45, upnl: 0, equity: 165.45, borrow: 0, imHeldUsd: 0, mmHeldUsd: 0,
        interestPaidUsd: 0, interestPerDayUsd: 0, ratePerYear: 0.0564,
      },
      {
        coin: 'USDC', venue: 'HYPERLIQUID', cash: 22.18, upnl: 203.64, equity: 225.82, borrow: 0, imHeldUsd: 0,
        mmHeldUsd: 0, interestPaidUsd: 0, interestPerDayUsd: 0, ratePerYear: 0.05,
      },
      {
        coin: 'USDC', venue: 'GATE', cash: 0, upnl: 0, equity: 0, borrow: 0, imHeldUsd: 0, mmHeldUsd: 0,
        interestPaidUsd: 0, interestPerDayUsd: 0, ratePerYear: 0.05,
      },
    ],
    plans: plansOf({
      goal: EVEN, targets: [], balanced: false, noLegs: false, moves: 22.18, shortOfEven: 8, roundCap: 2, split: EVEN_SPLIT,
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
    }),
    job: null,
  },
  exampleD: {
    buckets: EXAMPLE_D_BUCKETS,
    plans: plansOf({
      goal: EVEN, targets: [], balanced: false, noLegs: false, moves: 10854.58, shortOfEven: 0, roundCap: 6, split: EVEN_SPLIT,
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
    }),
    job: null,
  },
  exampleE: {
    buckets: EXAMPLE_E_BUCKETS,
    plans: plansOf({
      goal: EVEN, targets: [], balanced: false, noLegs: false, moves: 1228.27, shortOfEven: 0, roundCap: 2, split: EVEN_SPLIT,
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
    }),
    job: null,
  },
  balancedDone: { buckets: BALANCED_BUCKETS, plans: plansOf(BALANCED_PLAN), job: BALANCED_DONE_JOB },
  oldDone: { buckets: BALANCED_BUCKETS, plans: plansOf(BALANCED_PLAN), job: OLD_DONE_JOB },
  exampleERunning: { buckets: EXAMPLE_E_MID_BUCKETS, plans: plansOf(EXAMPLE_E_MID_PLAN), job: EXAMPLE_E_JOB },
  exampleEAbandoned: { buckets: EXAMPLE_E_MID_BUCKETS, plans: plansOf(EXAMPLE_E_MID_PLAN), job: EXAMPLE_E_ABANDONED_JOB },
  exampleDRunningConvert: { buckets: EXAMPLE_D_MID_BUCKETS, plans: plansOf(EXAMPLE_D_MID_PLAN), job: EXAMPLE_D_CONVERT_JOB },
  exampleDHaltedConvert: {
    buckets: EXAMPLE_D_MID_BUCKETS, plans: plansOf(EXAMPLE_D_MID_PLAN),
    job: {
      ...EXAMPLE_D_CONVERT_JOB, status: 'halted', haltReason: 'Convert quote was more than 0.3% under the Gate spot price.',
      updatedAt: REBALANCE_NOW - 2_000,
    },
  },
  haltedInside: { buckets: ACCOUNT_A_INSIDE_BUCKETS, plans: plansOf(ACCOUNT_A_INSIDE_PLAN), job: HALTED_INSIDE_JOB },
  mixDone: { buckets: MIX_DONE_BUCKETS, plans: plansOf(balancedPlan(EXAMPLE_D_MIX.after)), job: MIX_DONE_JOB },
  convertDone: { buckets: CONVERT_DONE_BUCKETS, plans: plansOf(balancedPlan(ACCOUNT_A_CONVERT.after)), job: CONVERT_DONE_JOB },
  balancedNoJob: { buckets: BALANCED_BUCKETS, plans: plansOf(BALANCED_PLAN), job: null },
  spotClosed: {
    buckets: ACCOUNT_A_BUCKETS, plans: plansOf(withLoopReason(ACCOUNT_A_PAUSED_PLAN, 'The spot market for USDC is closed.')),
    job: null,
  },
  underMinimum: {
    buckets: ACCOUNT_A_BUCKETS, plans: plansOf(withLoopReason(ACCOUNT_A_PAUSED_PLAN, 'The move is under the 11 USDC minimum.')),
    job: null,
  },
  borrowUnderOne: { buckets: BORROW_UNDER_ONE_BUCKETS, plans: plansOf(BORROW_UNDER_ONE_PLAN), job: null },
  accountADone: { buckets: ACCOUNT_A_BUCKETS, plans: plansOf(ACCOUNT_A_PLAN), job: CONVERT_DONE_JOB },
  accountADoneShort: { buckets: ACCOUNT_A_BUCKETS, plans: plansOf(ACCOUNT_A_PLAN), job: CONVERT_DONE_SHORT_JOB },
  lighterSplit: { buckets: LIGHTER_SPLIT_BUCKETS, plans: plansOf(LIGHTER_SPLIT_PLAN), job: null },
  lighterAcross: { buckets: LIGHTER_ACROSS_BUCKETS, plans: plansOf(LIGHTER_ACROSS_PLAN), job: null },
  lighterAcrossRunning: {
    buckets: rebased(LIGHTER_ACROSS_BUCKETS, { 'USDC/HYPERLIQUID': { cash: 0, equity: 0 } }), plans: plansOf(LIGHTER_ACROSS_PLAN),
    job: LIGHTER_ACROSS_RUNNING_JOB,
  },
  lighterAcrossAbandoned: {
    buckets: rebased(LIGHTER_ACROSS_BUCKETS, { 'USDC/HYPERLIQUID': { cash: 0, equity: 0 } }), plans: plansOf(LIGHTER_ACROSS_PLAN),
    job: LIGHTER_ACROSS_ABANDONED_JOB,
  },
  lighterConvertDone: {
    buckets: rebased(LIGHTER_ACROSS_BUCKETS, {
      'USDC/HYPERLIQUID': { cash: 0, equity: 0 },
      'USDC/LIGHTER': { cash: 498, equity: 498 },
    }),
    plans: plansOf({
      ...balancedPlan(LIGHTER_ACROSS_PLAN.routes.convert.after),
      split: LIGHTER_ACROSS_PLAN.split.filter((share) => share.share > 0),
    }),
    job: LIGHTER_CONVERT_DONE_JOB,
  },
  noLegs: { buckets: LIGHTER_SPLIT_BUCKETS, plans: plansOf(NO_LEGS_PLAN), job: null },
  twoBorrows: { buckets: TWO_BORROWS_BUCKETS, plans: plansOf(TWO_BORROWS_PLAN), job: null },
  bigBorrows: { buckets: BIG_BORROWS_BUCKETS, plans: plansOf(BIG_BORROWS_PLAN), job: null },
  oneBorrow: { buckets: ONE_BORROW_BUCKETS, plans: plansOf(ONE_BORROW_PLAN), job: null },
  hyperliquidFreeBorrow: { buckets: HYPERLIQUID_FREE_BORROW_BUCKETS, plans: plansOf(HYPERLIQUID_FREE_BORROW_PLAN), job: null },
  gainOverNegativeCash: { buckets: GAIN_OVER_NEGATIVE_CASH_BUCKETS, plans: plansOf(GAIN_OVER_NEGATIVE_CASH_PLAN), job: null },
  interestPaidSplit: { buckets: INTEREST_PAID_SPLIT_BUCKETS, plans: plansOf(INTEREST_PAID_SPLIT_PLAN), job: null },
  oneRouteOnly: { buckets: ONE_ROUTE_ONLY_BUCKETS, plans: plansOf(ONE_ROUTE_ONLY_PLAN), job: null },
  hiddenRoute: { buckets: HIDDEN_ROUTE_BUCKETS, plans: plansOf(HIDDEN_ROUTE_PLAN), job: null },
  ownerBook: { buckets: OWNER_BUCKETS, plans: OWNER_BOOK_PLANS, job: null },
  ownerCustomCash: {
    buckets: OWNER_BUCKETS, plans: { ...OWNER_BOOK_PLANS, custom: OWNER_CUSTOM_CASH }, job: null,
  },
  ownerCustomAbove: {
    buckets: OWNER_BUCKETS, plans: { ...OWNER_BOOK_PLANS, custom: OWNER_CUSTOM_ABOVE }, job: null,
  },
  ownerConvertSplit: {
    buckets: SPLIT_BUCKETS,
    plans: { even: { ...SPLIT_REPAY, goal: { kind: 'even' } }, repay: SPLIT_REPAY, custom: null },
    job: null,
  },
  ethUp: { buckets: ETH_UP_BUCKETS, plans: plansOf(ETH_UP_EVEN), job: null },
  notWorthIt: {
    buckets: NOT_WORTH_BUCKETS,
    plans: { even: { ...NOT_WORTH_REPAY, goal: { kind: 'even' } }, repay: NOT_WORTH_REPAY, custom: null },
    job: null,
  },
  refusedMargin: {
    buckets: REFUSED_BUCKETS, plans: plansOf(refusedPlan({ reason: 'no-margin', bp: null })), job: null,
  },
  refusedBook: {
    buckets: REFUSED_BUCKETS, plans: plansOf(refusedPlan({ reason: 'past-book', bp: null })), job: null,
  },
  threeWallets: { buckets: THREE_BUCKETS, plans: plansOf(THREE_EVEN), job: null },
  ownerAccount: acctView(OWNER_ACCOUNT, null, null),
  recommendedRealize: acctView(borrowBook(4200, 40, 6100, 0.1095)),
  recommendedCashOnly: acctView(borrowBook(3200, 5400, 0, 0.1095)),
  notRecommended: acctView(borrowBook(3100, 20, 4800, 0.0412)),
  realizeRefused: acctView(OWNER_ACCOUNT, { reason: 'past-book', bp: null }),
  imFull: acctView(OWNER_ACCOUNT, { reason: 'no-margin', bp: null }, null, {
    imUsed: [{ account: 'CROSSEX', pct: 0.914 }, { account: 'HYPERLIQUID', pct: 0.31 }],
  }),
  cashShort: acctView(borrowBook(2000, 600, 0, 0.0596)),
  interestFree: interestFreeView,
  noBorrow: {
    buckets: NO_BORROW_BUCKETS, plans: plansOf(balancedPlan(afterOf(800, 1200, 0))), realize: null, fullPlan: null,
    imUsed: ACCT_IM, job: null,
  },
  moveRunning: {
    buckets: ACCOUNT_A_ROUND_3_BUCKETS, plans: plansOf(ACCOUNT_A_ROUND_3_PLAN), job: { ...ACCOUNT_A_RUNNING_JOB, kind: 'move' },
  },
  moveStopped: {
    buckets: ACCOUNT_A_ROUND_3_BUCKETS, plans: plansOf(ACCOUNT_A_ROUND_3_PLAN), job: { ...ACCOUNT_A_HALTED_JOB, kind: 'move' },
  },
  moveDone: {
    buckets: CONVERT_DONE_BUCKETS, plans: plansOf(balancedPlan(ACCOUNT_A_CONVERT.after)), job: { ...CONVERT_DONE_JOB, kind: 'move' },
  },
  ownerRealizeRunning: withJob(acctView(OWNER_ACCOUNT), OWNER_JOBS.running),
  realizePausing: withJob(acctView(OWNER_ACCOUNT), OWNER_JOBS.pausing),
  realizePaused: withJob(acctView(OWNER_ACCOUNT), OWNER_JOBS.paused),
  realizeFollowMissed: withJob(acctView(OWNER_ACCOUNT), OWNER_JOBS.followMissed),
  realizeStoppedNotHedged: withJob(acctView(OWNER_ACCOUNT), OWNER_JOBS.stoppedNotHedged),
  realizeStoppedMargin: withJob(acctView(OWNER_ACCOUNT), OWNER_JOBS.stoppedMargin),
  ownerRealizeDone: {
    ...acctView(OWNER_ACCOUNT), buckets: OWNER_DONE_VIEW_BUCKETS, plans: acctPlans({ ...OWNER_ACCOUNT, cash: OWNER_DONE_CASH, upnl: OWNER_DONE_UPNL }),
    realize: null, fullPlan: null, job: OWNER_REALIZE_DONE_JOB,
  },
  deleverRunning: withJob(acctView(OWNER_ACCOUNT), DELEVER_JOBS.running),
  deleverPausedGap: withJob(acctView(OWNER_ACCOUNT), DELEVER_JOBS.pausedGap),
  deleverStoppedBoros: withJob(acctView(OWNER_ACCOUNT), DELEVER_JOBS.stoppedBoros),
  deleverDone: withJob(acctView(OWNER_ACCOUNT), DELEVER_JOBS.done),
} satisfies Record<string, RebalanceView>;

const fromCrossexPlan = (plan: EvenPlan): EvenPlan => ({
  ...plan,
  routes: {
    ...plan.routes,
    convert: { ...plan.routes.convert, steps: plan.routes.convert.steps.map((step) => ({ ...step, from: 'CROSSEX' as const, to: 'HYPERLIQUID' as const })) },
  },
});

const imFullFromCrossex = (): RebalanceView => {
  const view = rebalanceViews.imFull;
  return { ...view, plans: { ...view.plans, repay: fromCrossexPlan(view.plans.repay), even: fromCrossexPlan(view.plans.even) } };
};

export const extraRebalanceViews = {
  deleverPausing: withJob(acctView(OWNER_ACCOUNT), DELEVER_JOBS.pausing),
  deleverHaltedGap: withJob(acctView(OWNER_ACCOUNT), DELEVER_JOBS.haltedGap),
  deleverAbandonedGap: withJob(acctView(OWNER_ACCOUNT), DELEVER_JOBS.abandonedGap),
  deleverPartAddBack: withJob(acctView(OWNER_ACCOUNT), DELEVER_JOBS.partAddBack),
  deleverAbandonedAddBack: withJob(acctView(OWNER_ACCOUNT), DELEVER_JOBS.abandonedAddBack),
  deleverFollowMissed: withJob(acctView(OWNER_ACCOUNT), DELEVER_JOBS.followMissed),
  deleverDoneNoBorrow: withJob(
    { ...acctView(OWNER_ACCOUNT), buckets: acctBuckets(borrowBook(0, 55.98, 9400, 0.0596)) }, DELEVER_JOBS.done,
  ),
  realizeFollowMissed2: withJob(acctView(OWNER_ACCOUNT), { ...OWNER_JOBS.followMissed, followMisses: 2 }),
  ownerAccountLong: ownerAccountLongView,
  refusedNoFeeRate: acctView(OWNER_ACCOUNT, { reason: 'no-fee-rate', bp: null }),
  refusedOverCap: acctView(WHALE_ACCOUNT, { reason: 'over-cap', bp: null, capUsd: 5_000_000 }, WHALE_SLICE_USD),
  refusedMarginLowIm: acctView(OWNER_ACCOUNT, { reason: 'no-margin', bp: null }, null, {
    imUsed: [{ account: 'CROSSEX', pct: 0.8 }, { account: 'HYPERLIQUID', pct: 0.31 }],
  }),
  imAtStopBelow: acctView(OWNER_ACCOUNT, { reason: 'no-margin', bp: null }, null, {
    imUsed: [{ account: 'CROSSEX', pct: 0.8928 }, { account: 'HYPERLIQUID', pct: 0.31 }],
  }),
  imAtStopAbove: acctView(OWNER_ACCOUNT, { reason: 'no-margin', bp: null }, null, {
    imUsed: [{ account: 'CROSSEX', pct: 0.893 }, { account: 'HYPERLIQUID', pct: 0.31 }],
  }),
  rateUnknown: acctView(OWNER_ACCOUNT, null, null, {
    buckets: acctBuckets(OWNER_ACCOUNT).map((b) => (b.borrow > 0 ? { ...b, ratePerYear: null, interestPerDayUsd: 0 } : b)),
  }),
  imFullOutOfCrossex: imFullFromCrossex(),
} satisfies Record<string, RebalanceView>;

const WHALE_DONE_CASH = r2(WHALE_ACCOUNT.cash + WHALE_ACCOUNT.realized);
const WHALE_DONE_UPNL = r2(WHALE_ACCOUNT.upnl - WHALE_ACCOUNT.realized);

const whaleBorrowView = (borrow: number, cash: number, upnl: number, rate: number, refused: RealizeRefusal | null = null): RebalanceView =>
  acctView(borrowBook(borrow, cash, upnl, rate), refused, WHALE_SLICE_USD);

export const whaleRebalanceViews = {
  recommendedRealize: whaleBorrowView(6_000_000, 46_850, 12_345_678.9, 0.1095),
  recommendedCashOnly: whaleBorrowView(3_000_000, 5_400_000, 0, 0.1095),
  notRecommended: whaleBorrowView(6_000_000, 46_850, 12_345_678.9, 0.0412),
  refusedBook: whaleBorrowView(6_000_000, 46_850, 12_345_678.9, 0.0596, { reason: 'past-book', bp: null }),
  refusedMargin: whaleBorrowView(6_000_000, 46_850, 12_345_678.9, 0.0596, { reason: 'no-margin', bp: null }),
  refusedOverCap: whaleBorrowView(6_000_000, 46_850, 12_345_678.9, 0.0596, { reason: 'over-cap', bp: null, capUsd: 5_000_000 }),
  moveCashLeftover: whaleBorrowView(4_000_000, 7_000_000, 0, 0.0596),
  ownerRealizeDone: {
    ...acctView(WHALE_ACCOUNT, null, WHALE_SLICE_USD),
    buckets: rebased(acctBuckets(WHALE_ACCOUNT), {
      'USDC/HYPERLIQUID': { cash: WHALE_DONE_CASH, upnl: WHALE_DONE_UPNL, equity: r2(WHALE_DONE_CASH + WHALE_DONE_UPNL) },
    }),
    plans: acctPlans({ ...WHALE_ACCOUNT, cash: WHALE_DONE_CASH, upnl: WHALE_DONE_UPNL }),
    realize: null, fullPlan: null, job: WHALE_JOBS.done,
  },
  realizePausing: withJob(acctView(WHALE_ACCOUNT, null, WHALE_SLICE_USD), WHALE_JOBS.pausing),
  realizePaused: withJob(acctView(WHALE_ACCOUNT, null, WHALE_SLICE_USD), WHALE_JOBS.paused),
  deleverPausedGap: withJob(acctView(WHALE_ACCOUNT, null, WHALE_SLICE_USD), WHALE_DELEVER_JOBS.pausedGap),
  deleverStoppedBoros: withJob(acctView(WHALE_ACCOUNT, null, WHALE_SLICE_USD), WHALE_DELEVER_JOBS.stoppedBoros),
  deleverPartAddBack: withJob(acctView(WHALE_ACCOUNT, null, WHALE_SLICE_USD), WHALE_DELEVER_JOBS.partAddBack),
  deleverAbandonedAddBack: withJob(acctView(WHALE_ACCOUNT, null, WHALE_SLICE_USD), WHALE_DELEVER_JOBS.abandonedAddBack),
  deleverDone: withJob(acctView(WHALE_ACCOUNT, null, WHALE_SLICE_USD), WHALE_DELEVER_JOBS.done),
  ownerAccount: acctView(WHALE_ACCOUNT, null, WHALE_SLICE_USD),
  realizeRunning: withJob(acctView(WHALE_ACCOUNT, null, WHALE_SLICE_USD), WHALE_JOBS.running),
  deleverRunning: withJob(acctView(WHALE_ACCOUNT, null, WHALE_SLICE_USD), WHALE_DELEVER_JOBS.running),
  realizeWhale: { ...WHALE_VIEW, realize: { ...acctTab(WHALE_ACCOUNT, null, null), defaultSliceUsd: 50_000 }, job: null },
} satisfies Record<string, RebalanceView>;

const ownerPlans = (over: Partial<RebalancePlans>): RebalancePlans => ({ ...OWNER_BOOK_PLANS, ...over });

const customPlan = (amount: number): EvenPlan => ({
  ...OWNER_EVEN, goal: { kind: 'custom', from: 'HYPERLIQUID', to: 'CROSSEX', amount }, customMaxUsd: 3140,
});

const BTC_HL_LEG: RealizeLeg = {
  ...OWNER_ETH_LEG, symbol: 'HYPERLIQUID_FUTURE_BTC_USDC', base: 'BTC', positionQty: 2.1, qty: 1.4, realizedUsd: 9200,
  convert: { amount: 2800, count: 1, feeUsd: 5.6 }, closeFeeUsd: 12.4, reopenFeeUsd: 12.4, closeImpactUsd: 2.1,
  reopenImpactUsd: 2.1, impactBp: 1.6,
};

const BTC_GATE_LEG: RealizeLeg = {
  pool: 'CROSSEX', symbol: 'GATE_FUTURE_BTC_USDT', exchange: 'GATE', base: 'BTC', side: 'LONG', positionQty: 2.1, qty: 1.4,
  realizedUsd: 16000, convert: null, closeFeeUsd: 18.4, reopenFeeUsd: 18.4, closeImpactUsd: 3.2, reopenImpactUsd: 3.2,
  impactBp: 1.7,
};

const TWO_LEGS_AFTER: WalletAfter[] = [
  { coin: 'USDT', venue: 'CROSSEX', cash: 0, equity: 0 },
  { coin: 'USDC', venue: 'HYPERLIQUID', cash: 0, equity: 5400 },
];

const TWO_LEGS_REPAY = realizeEven(
  { kind: 'repay' }, 29812,
  {
    mix: null,
    loop: loopRoute(5, 18912, 4, 1700, 4.94, TWO_LEGS_AFTER, HL_TO_GATE),
    convert: convertRoute([18912], 37.8, 4.94, TWO_LEGS_AFTER, [HL_TO_GATE]),
  },
  'loop', { legs: [OWNER_CLEAR_LEG, BTC_HL_LEG], refused: null },
);

const TWO_LEGS_PLANS: RebalancePlans = {
  even: { ...TWO_LEGS_REPAY, goal: { kind: 'even' } }, repay: TWO_LEGS_REPAY, custom: null,
};

const TWO_VENUES_BUCKETS: RebalanceBucket[] = [
  { ...bucketOf('USDT', 'CROSSEX', -29812, 20000, 29812, 4.9357, 0.0596), imHeldUsd: 5962.4, mmHeldUsd: 2981.2 },
  { ...bucketOf('USDC', 'HYPERLIQUID', 3140, 42174, 0, 0, 0.05), imHeldUsd: 0, mmHeldUsd: 0 },
];

const TWO_VENUES_EVEN = realizeEven(
  { kind: 'even' }, 37526, OWNER_ROUTES, 'loop', { legs: [OWNER_ETH_LEG, BTC_GATE_LEG], refused: null },
);

const TWO_VENUES_VIEW = { buckets: TWO_VENUES_BUCKETS, plans: ownerPlans({ even: TWO_VENUES_EVEN }) };

const LONG_HL_LEG: RealizeLeg = { ...OWNER_ETH_LEG, side: 'LONG' };

const GATE_CONVERT_LEG: RealizeLeg = { ...ETH_UP_LEG, convert: { amount: 9000, count: 1, feeUsd: 18 } };

interface TwapLegFixture {
  name: string;
  exchange: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  lot: string;
  avg: number;
}

interface TwapRunFixture {
  id: string;
  legs: [TwapLegFixture, TwapLegFixture];
  reduceOnly: boolean;
  tick: string;
  rest: number;
  best: number;
  total: number;
  slices: number;
  sliceQty: number;
  lastQty: number;
  intervalSec: number;
}

interface TwapRunState {
  slice: number;
  maker: number;
  hedge: number | null;
  live: boolean;
  total?: number;
  avg?: number;
  never?: boolean;
  over?: Partial<RebalanceJob>;
}

interface TwapDealState {
  id: string;
  qty: number;
  maker: number;
  hedge: number | null;
  mode: DealPair['mode'];
  deadlineAt: number | null;
  createdAt: number;
  avg?: number;
}

interface TwapDeleverFixture {
  run: TwapRunFixture;
  base: RebalanceJob;
  before: number;
  part: [number, number];
  borosBefore: number;
  borosPerSlice: number;
  delever: RebalanceJob['delever'];
}

interface TwapFixtureBook {
  run: TwapRunFixture;
  part: [number, number];
  neverPart: number;
  scale: number;
  pausedPart?: number;
  pausedAvg?: number;
  view: RebalanceView;
  delever: TwapDeleverFixture;
}

type TwapFixtureState =
  | 'running' | 'pausing' | 'paused' | 'restart' | 'sleep' | 'refused' | 'restUnderMin' | 'hedgeMargin' | 'error' | 'stopped' | 'done'
  | 'never' | 'singleLeg' | 'deleverRunning' | 'deleverBorosRefused' | 'closeRunning' | 'singleClose' | 'shortOpenRunning'
  | 'hedgeMarginClose' | 'refusedMargin' | 'cappedRest' | 'repegRefused' | 'neverBehind' | 'doneGap' | 'stoppedGap'
  | 'runningFeeEst' | 'sleepLong' | 'waitingChild';

const TWAP_SLICE_AGO_MS = 60_000;
const TWAP_DELEVER_SLICE = 13;

const twapSliceQty = (run: TwapRunFixture, n: number): number => (n === run.slices ? run.lastQty : run.sliceQty);
const twapFilled = (run: TwapRunFixture, slice: number, part: number): number => r6((slice - 1) * run.sliceQty + part);
const twapDealSide = (leg: TwapLegFixture, reduceOnly: boolean): 'BUY' | 'SELL' => ((leg.side === 'LONG') !== reduceOnly ? 'BUY' : 'SELL');
const twapFeeUsd = (makerUsd: number, takerUsd: number): number => r2((makerUsd * 2 + takerUsd * 5) / 10_000);
const twapTakerAfterSec = (run: TwapRunFixture): number => run.intervalSec * 0.8;

function twapOrdersOf(run: TwapRunFixture, s: TwapRunState, startedAt: number): RunOrderView[] {
  const [a, b] = run.legs;
  const rows: RunOrderView[] = [];
  for (let n = 1; n <= s.slice; n += 1) {
    const current = n === s.slice;
    const at = startedAt + (n - 1) * run.intervalSec * 1000;
    const qty = twapSliceQty(run, n);
    const hedged = current ? (s.hedge ?? 0) : qty;
    rows.push({
      venue: a.name, leg: 'A', kind: 'maker', slice: n, price: String(run.rest), qty: String(qty),
      filledQty: String(current ? s.maker : qty), state: current && s.live ? 'OPEN' : 'CLOSED', createdAt: at,
    });
    if (s.hedge !== null && hedged > 0) {
      rows.push({
        venue: b.name, leg: 'B', kind: 'taker', slice: n, price: String(b.avg), qty: String(hedged), filledQty: String(hedged),
        state: 'CLOSED', createdAt: at + 30_000,
      });
    }
  }
  return rows.reverse();
}

function twapJobOf(run: TwapRunFixture, s: TwapRunState): RebalanceJob {
  const [a, b] = run.legs;
  const intervalMs = run.intervalSec * 1000;
  const startedAt = REBALANCE_NOW - TWAP_SLICE_AGO_MS - (s.slice - 1) * intervalMs;
  const total = s.total ?? run.total;
  const makerQty = twapFilled(run, s.slice, s.maker);
  const hedgeQty = s.hedge === null ? null : twapFilled(run, s.slice, s.hedge);
  const makerAvg = s.avg ?? run.rest;
  const legOf = (leg: TwapLegFixture, qty: number, avg: number): RunLegView => ({
    name: leg.name, exchange: leg.exchange, symbol: leg.symbol, reduceOnly: run.reduceOnly, side: leg.side,
    filledQty: String(qty), plannedQty: String(total), avgPrice: qty > 0 ? String(avg) : null,
  });
  const both = hedgeQty === null ? 0 : Math.min(makerQty, hedgeQty);
  const [longAvg, shortAvg] = a.side === 'LONG' ? [makerAvg, b.avg] : [b.avg, makerAvg];
  const edge = (shortAvg - longAvg) * (run.reduceOnly ? -1 : 1);
  return {
    id: run.id, goal: 'even', route: 'mix', amount: total, costUsd: null, target: null, status: 'running', stepIndex: 0, steps: [],
    fundsAt: 'CROSSEX', haltReason: null, createdAt: startedAt, updatedAt: REBALANCE_NOW, inTransit: null, kind: 'twap',
    haltKind: null, pauseRequested: false, paused: false,
    twap: {
      slice: s.slice, of: run.slices, nextAt: s.live ? REBALANCE_NOW - TWAP_SLICE_AGO_MS + intervalMs : null,
      durationSec: run.slices * run.intervalSec, intervalSec: run.intervalSec, startedAt, carryQty: '0', behindQty: '0',
      makerLeg: 'a', repegBehindBp: 5, takerAfterSec: s.never ? null : twapTakerAfterSec(run),
    },
    child: s.live
      ? {
          id: `${run.id}-s${s.slice}-1`, mode: 'OPENING', slice: s.slice, makerLeg: 'a', side: twapDealSide(a, run.reduceOnly),
          restPrice: String(run.rest), bestPrice: String(run.best), behindPct: r6(Math.abs(run.best - run.rest) / run.best),
          repegRefused: null,
        }
      : null,
    legs: hedgeQty === null ? [legOf(a, makerQty, makerAvg)] : [legOf(a, makerQty, makerAvg), legOf(b, hedgeQty, b.avg)],
    fees: (() => { const readUsd = twapFeeUsd(makerQty * makerAvg, (hedgeQty ?? 0) * b.avg); return { readUsd, estUsd: 0, totalUsd: readUsd, est: false }; })(),
    slippage: both > 0 ? { pct: r6(edge / longAvg), usd: r2(edge * both) } : null,
    orders: twapOrdersOf(run, s, startedAt),
    boros: null,
    ...s.over,
  };
}

function twapDealOf(run: TwapRunFixture, d: TwapDealState): DealView {
  const [a, b] = run.legs;
  const makerAvg = d.avg ?? run.rest;
  const hedge = d.hedge ?? 0;
  const residual = r6(d.qty - d.maker);
  const done = d.mode === 'DONE';
  const order = (leg: 'A' | 'B', seq: number, qty: number, cum: number, state: DealOrder['state']): DealOrder => ({
    pairId: d.id, leg, seq, clientId: `${d.id}-${leg.toLowerCase()}${seq}`, kind: leg === 'A' ? 'maker' : 'taker',
    side: twapDealSide(leg === 'A' ? a : b, run.reduceOnly), qty: String(qty), price: String(leg === 'A' ? run.rest : b.avg),
    tif: leg === 'A' ? 'poc' : 'ioc', state, venueOrderId: String(9_000_000 + seq), cumQty: String(cum), closeReason: null,
    cancelRequested: 0, quarantinedStatus: null, venueReason: null, createdAt: d.createdAt + seq * 1_000,
    resolvedAt: state === 'OPEN' ? null : d.createdAt + seq * 1_000 + 500,
  });
  const resting = !done && residual > 0 ? order('A', 3, residual, 0, d.mode === 'OPENING' ? 'OPEN' : 'PENDING') : null;
  const legSpec = (leg: TwapLegFixture) => ({
    contract: leg.symbol, side: twapDealSide(leg, run.reduceOnly), lot: leg.lot, minSize: leg.lot, minNotional: '0', tick: run.tick,
    reduceOnly: run.reduceOnly,
  });
  const report = {
    aFilled: String(d.maker), bFilled: String(hedge), unhedged: '0', reason: 'done', aAvgFill: String(makerAvg),
    bAvgFill: d.hedge === null ? null : String(b.avg),
  };
  return makeDealView({
    pair: {
      id: d.id, mode: d.mode, a: legSpec(a), b: d.hedge === null ? null : legSpec(b), targetQty: String(d.qty),
      limitPrice: String(run.rest), pricePolicy: 'touch', deadlineAt: d.deadlineAt, createdAt: d.createdAt,
      reportJson: done ? JSON.stringify(report) : null,
    },
    orders: [
      ...(d.maker > 0 ? [order('A', 1, d.maker, d.maker, 'CLOSED')] : []),
      ...(hedge > 0 ? [order('B', 2, hedge, hedge, 'CLOSED')] : []),
      ...(resting ? [resting] : []),
    ],
    projection: {
      aFilled: String(d.maker), aReserved: String(d.maker), bFilled: String(hedge), bReserved: String(hedge),
      unhedged: String(d.hedge === null ? 0 : r6(d.maker - hedge)), residualA: String(residual), makerOrder: resting,
      allSettled: done,
    },
    fees: (() => { const readUsd = twapFeeUsd(d.maker * makerAvg, hedge * b.avg); return { readUsd, estUsd: 0, totalUsd: readUsd, est: false }; })(),
    avgPrice: { a: d.maker > 0 ? String(makerAvg) : null, b: hedge > 0 ? String(b.avg) : null },
    endedAt: done ? REBALANCE_NOW - 5_000 : null,
  });
}

const twapChildOf = (run: TwapRunFixture, s: TwapRunState): DealView | null =>
  s.live
    ? twapDealOf(run, {
        id: `${run.id}-s${s.slice}-1`, qty: twapSliceQty(run, s.slice), maker: s.maker, hedge: s.hedge, mode: 'OPENING',
        deadlineAt: s.never ? null : REBALANCE_NOW - TWAP_SLICE_AGO_MS + twapTakerAfterSec(run) * 1000,
        createdAt: REBALANCE_NOW - TWAP_SLICE_AGO_MS, avg: s.avg,
      })
    : null;

function twapTouchesOf(run: TwapRunFixture): BookTouch[] {
  const step = Number(run.tick) * 10;
  const touch = (leg: TwapLegFixture, price: number): BookTouch => {
    const buy = twapDealSide(leg, run.reduceOnly) === 'BUY';
    const bestBid = buy ? price : r2(price - step);
    const bestAsk = buy ? r2(price + step) : price;
    return { symbol: leg.symbol, bestBid, bestAsk, mid: r2((bestBid + bestAsk) / 2) };
  };
  return [touch(run.legs[0], run.best), touch(run.legs[1], run.legs[1].avg)];
}

function twapDeleverOf(f: TwapDeleverFixture, view: RebalanceView, refused: boolean): { rebalance: RebalanceView; child: DealView | null } {
  const qty = f.run.sliceQty;
  const state: TwapRunState = refused
    ? { slice: TWAP_DELEVER_SLICE, maker: qty, hedge: qty, live: false }
    : { slice: TWAP_DELEVER_SLICE, maker: f.part[0], hedge: f.part[1], live: true };
  const run = twapJobOf(f.run, state);
  const closedYu = r2((TWAP_DELEVER_SLICE - 1) * f.borosPerSlice);
  const job: RebalanceJob = {
    ...f.base, status: refused ? 'halted' : 'running', haltKind: refused ? 'boros' : null,
    haltReason: refused ? 'Boros did not close all of its share. The rest has no perp behind it.' : null,
    updatedAt: REBALANCE_NOW, delever: f.delever, twap: run.twap, child: run.child, fees: run.fees, slippage: run.slippage,
    orders: run.orders,
    legs: (run.legs ?? []).map((leg) => ({ ...leg, beforeQty: String(f.before), nowQty: String(r6(f.before - Number(leg.filledQty))) })),
    boros: {
      refused, slice: TWAP_DELEVER_SLICE, leftYu: refused ? f.borosPerSlice : 0, beforeYu: f.borosBefore,
      nowYu: r2(f.borosBefore - closedYu),
    },
  };
  return { rebalance: withJob(view, job), child: twapChildOf(f.run, state) };
}

const twapCloseOf = (run: TwapRunFixture): TwapRunFixture => ({ ...run, reduceOnly: true, best: r2(run.rest - 0.35) });

const twapShortOf = (run: TwapRunFixture): TwapRunFixture => ({
  ...run, legs: twapEthLegs('SHORT', 1730.2, r2(run.legs[1].avg - 0.4)),
});

const twapHyperliquidMakerOf = (run: TwapRunFixture): TwapRunFixture => ({ ...run, legs: twapEthLegs('LONG', run.rest, run.legs[1].avg, true) });

const twapWithTwap = (job: RebalanceJob, over: Partial<NonNullable<RebalanceJob['twap']>>): RebalanceJob => ({
  ...job, twap: job.twap ? { ...job.twap, ...over } : job.twap,
});

function twapFixturesOf(book: TwapFixtureBook): Record<TwapFixtureState, { rebalance: RebalanceView; child: DealView | null }> {
  const { run, part, view, scale } = book;
  const atRun = (r: TwapRunFixture, s: TwapRunState) => ({ rebalance: withJob(view, twapJobOf(r, s)), child: twapChildOf(r, s) });
  const at = (s: TwapRunState) => atRun(run, s);
  const closeRun = twapCloseOf(run);
  const closeRunning: TwapRunState = { slice: 3, maker: part[0], hedge: part[1], live: true };
  const closeHalt = (haltKind: NonNullable<RebalanceJob['haltKind']>, haltReason: string, s: TwapRunState) =>
    atRun(closeRun, { ...s, live: false, over: { status: 'halted', haltKind, haltReason } });
  const repegRun = twapHyperliquidMakerOf(run);
  const repegJob = twapJobOf(repegRun, closeRunning);
  const repegChild = twapChildOf(repegRun, closeRunning);
  const neverJob = twapJobOf(run, { slice: 5, maker: book.neverPart, hedge: book.neverPart, live: true, never: true });
  const waitJob = twapJobOf(run, closeRunning);
  const waitChild = twapChildOf(run, closeRunning);
  const cappedLeft = 3 * scale;
  const running: TwapRunState = { slice: 3, maker: part[0], hedge: part[1], live: true };
  const held = book.pausedPart ?? part[0];
  const paused: TwapRunState = { slice: 3, maker: held, hedge: held, live: false, avg: book.pausedAvg, over: { status: 'halted', paused: true } };
  const halt = (over: Partial<RebalanceJob>) => at({ ...paused, over: { status: 'halted', ...over } });
  const pausingJob = twapJobOf(run, running);
  const pausingChild = twapChildOf(run, running);
  const firstSlices = run.slices - 1;
  return {
    running: at(running),
    pausing: {
      rebalance: withJob(view, { ...pausingJob, pauseRequested: true, child: pausingJob.child ? { ...pausingJob.child, mode: 'STOPPING' } : null }),
      child: pausingChild ? { ...pausingChild, pair: { ...pausingChild.pair, mode: 'STOPPING' } } : null,
    },
    paused: at(paused),
    restart: halt({ haltKind: 'restart', haltReason: 'The app restarted during the run. Nothing failed. Press Resume.', updatedAt: REBALANCE_NOW - 420_000 }),
    sleep: halt({
      haltKind: 'sleep', haltReason: 'This Mac slept during the TWAP. Nothing was sent while it slept. Press Resume.',
      sleptFrom: REBALANCE_NOW - 2_460_000, sleptTo: REBALANCE_NOW - TWAP_SLICE_AGO_MS,
    }),
    refused: at({
      slice: run.slices, maker: 0, hedge: 0, live: false, total: r6(firstSlices * run.sliceQty + 0.0004),
      over: {
        status: 'halted', haltKind: 'refused', haltReason: `Slice ${run.slices} is under Gate's 0.001 ETH minimum`,
        sizeRefusal: { slice: run.slices, venue: 'Gate', limit: '0.001 ETH', bound: 'min', wholeRest: false },
      },
    }),
    restUnderMin: at({
      slice: run.slices, maker: 0, hedge: 0, live: false, total: r6(firstSlices * run.sliceQty + 0.0004),
      over: {
        status: 'halted', haltKind: 'refused',
        haltReason: "Rest 0.0004 ETH is under Gate's 0.001 ETH minimum. Resume cannot send it. Stop ends the run.",
        sizeRefusal: { slice: run.slices, venue: 'Gate', limit: '0.001 ETH', bound: 'min', wholeRest: true },
      },
    }),
    hedgeMargin: at({
      slice: 3, maker: part[0], hedge: part[1], live: false,
      over: { status: 'halted', haltKind: 'hedge-margin', haltReason: `${run.legs[1].name} refused the hedge in slice 3` },
    }),
    error: halt({ haltKind: 'error', haltReason: 'Internal Server Error.' }),
    stopped: at({ ...paused, over: { status: 'abandoned' } }),
    done: at({ slice: run.slices, maker: run.lastQty, hedge: run.lastQty, live: false, over: { status: 'done' } }),
    never: at({ slice: run.slices, maker: book.neverPart, hedge: book.neverPart, live: true, never: true }),
    singleLeg: at({ ...running, hedge: null }),
    deleverRunning: twapDeleverOf(book.delever, view, false),
    deleverBorosRefused: twapDeleverOf(book.delever, view, true),
    closeRunning: atRun(closeRun, closeRunning),
    singleClose: atRun(closeRun, { ...closeRunning, hedge: null }),
    shortOpenRunning: atRun(twapShortOf(run), closeRunning),
    hedgeMarginClose: closeHalt('hedge-margin', `${closeRun.legs[1].name} refused the hedge in slice 3`, closeRunning),
    refusedMargin: atRun(run, {
      slice: 4, maker: 0, hedge: 0, live: false,
      over: { status: 'halted', haltKind: 'refused', haltReason: `${run.legs[0].name} refused slice 4: not enough margin` },
    }),
    cappedRest: closeHalt(
      'capped-rest', `${cappedLeft} ETH not closed`,
      { slice: run.slices, maker: r6(run.lastQty - cappedLeft), hedge: r6(run.lastQty - cappedLeft), live: false },
    ),
    repegRefused: {
      rebalance: withJob(view, {
        ...repegJob,
        child: repegJob.child ? { ...repegJob.child, repegRefused: { kind: 'order-allowance', at: REBALANCE_NOW - 20_000 } } : null,
      }),
      child: repegChild,
    },
    neverBehind: {
      rebalance: withJob(view, twapWithTwap(neverJob, { behindQty: String(r2(21.4 * scale)), carryQty: String(r2(21.4 * scale)) })),
      child: twapChildOf(run, { slice: 5, maker: book.neverPart, hedge: book.neverPart, live: true, never: true }),
    },
    doneGap: at({ slice: run.slices, maker: run.lastQty, hedge: r6(run.lastQty - 0.04), live: false, over: { status: 'done' } }),
    stoppedGap: at({ slice: 3, maker: part[0], hedge: r6(part[0] - 0.04), live: false, over: { status: 'abandoned' } }),
    runningFeeEst: at({
      ...running, over: { fees: { readUsd: r2(120 * scale), estUsd: r2(56.6 * scale), totalUsd: r2(176.6 * scale), est: true } },
    }),
    sleepLong: halt({
      haltKind: 'sleep', haltReason: 'This Mac slept during the TWAP. Nothing was sent while it slept. Press Resume.',
      sleptFrom: REBALANCE_NOW - 2 * 86_400_000 - 300_000, sleptTo: REBALANCE_NOW - TWAP_SLICE_AGO_MS,
    }),
    waitingChild: {
      rebalance: withJob(view, {
        ...twapWithTwap(waitJob, { nextAt: null }),
        child: waitJob.child ? { ...waitJob.child, mode: 'CONVERTING' } : null,
      }),
      child: waitChild ? { ...waitChild, pair: { ...waitChild.pair, mode: 'CONVERTING' } } : null,
    },
  };
}

function twapPlainDealsOf(
  run: TwapRunFixture, qty: number, part: [number, number],
): Record<'running' | 'never' | 'done' | 'closeRunning' | 'halted', DealView> {
  const base = { id: 'deal0001', qty, createdAt: REBALANCE_NOW - 8_000 };
  return {
    running: twapDealOf(run, { ...base, maker: part[0], hedge: part[1], mode: 'OPENING', deadlineAt: REBALANCE_NOW + 232_000 }),
    never: twapDealOf(run, { ...base, maker: part[0], hedge: part[1], mode: 'OPENING', deadlineAt: null }),
    done: twapDealOf(run, { ...base, maker: qty, hedge: qty, mode: 'DONE', deadlineAt: null }),
    closeRunning: twapDealOf(twapCloseOf(run), { ...base, maker: part[0], hedge: part[1], mode: 'OPENING', deadlineAt: REBALANCE_NOW + 232_000 }),
    halted: twapDealOf(run, { ...base, maker: part[0], hedge: part[1], mode: 'HALTED', deadlineAt: null }),
  };
}

const twapEthLegs = (makerSide: 'LONG' | 'SHORT', rest: number, hedgeAvg: number, makerOnHyperliquid = false): [TwapLegFixture, TwapLegFixture] => {
  const gate: TwapLegFixture = { name: 'Gate', exchange: 'GATE', symbol: GATE_ETH, side: makerSide, lot: '0.001', avg: rest };
  const hyperliquid: TwapLegFixture = {
    name: 'Hyperliquid', exchange: 'HYPERLIQUID', symbol: HL_ETH, side: makerSide === 'LONG' ? 'SHORT' : 'LONG', lot: '0.0001', avg: hedgeAvg,
  };
  if (!makerOnHyperliquid) return [gate, hyperliquid];
  return [{ ...hyperliquid, side: makerSide, avg: rest }, { ...gate, side: makerSide === 'LONG' ? 'SHORT' : 'LONG', avg: hedgeAvg }];
};

const TWAP_RUN: TwapRunFixture = {
  id: 'twap0001', legs: twapEthLegs('LONG', 1729.8, 1730.2), reduceOnly: false, tick: '0.01', rest: 1729.8, best: 1730.15,
  total: 693.64, slices: 12, sliceQty: 57.803, lastQty: 57.807, intervalSec: 300,
};

const WHALE_TWAP_RUN: TwapRunFixture = {
  ...TWAP_RUN, legs: twapEthLegs('LONG', 1729.8, 1729.65), total: 3468.208, sliceQty: 289.017, lastQty: 289.021,
};

const TWAP_DELEVER_RUN: TwapRunFixture = {
  id: DELEVER_JOBS.running.id, reduceOnly: true, tick: '0.1', rest: 90_010, best: 90_005, total: 180, slices: 48, sliceQty: 3.75,
  lastQty: 3.75, intervalSec: 300,
  legs: [
    { name: 'Hyperliquid', exchange: 'HYPERLIQUID', symbol: HL_BTC, side: 'LONG', lot: '0.00001', avg: 90_010 },
    { name: 'Gate', exchange: 'GATE', symbol: GATE_BTC, side: 'SHORT', lot: '0.0001', avg: 90_012 },
  ],
};

const WHALE_DELEVER_BOOK_ETH = 17_341.04;
const WHALE_DELEVER_BOROS_USD = 30_012_345.67;

const WHALE_TWAP_DELEVER_RUN: TwapRunFixture = {
  id: WHALE_DELEVER_JOBS.running.id, legs: twapEthLegs('LONG', 1730.05, 1730.1, true), reduceOnly: true, tick: '0.01', rest: 1730.05,
  best: 1729.95, total: 3468.208, slices: 48, sliceQty: 72.254, lastQty: 72.27, intervalSec: 300,
};

export const twapFixtures = {
  normal: twapFixturesOf({
    run: TWAP_RUN, part: [30.52, 30.1], neverPart: 36.407, scale: 1, view: acctView(OWNER_ACCOUNT),
    delever: {
      run: TWAP_DELEVER_RUN, base: DELEVER_JOBS.running, before: 900, part: [2.1, 1.8], borosBefore: 900, borosPerSlice: 3.75,
      delever: DELEVER_JOBS.running.delever,
    },
  }),
  whale: twapFixturesOf({
    run: WHALE_TWAP_RUN, part: [152.6, 150.4], neverPart: 189.021, scale: 5, pausedPart: 0.001, pausedAvg: 999_999.995 / 578.035,
    view: acctView(WHALE_ACCOUNT, null, WHALE_SLICE_USD),
    delever: {
      run: WHALE_TWAP_DELEVER_RUN, base: WHALE_DELEVER_JOBS.running, before: WHALE_DELEVER_BOOK_ETH, part: [40.1, 39.7],
      borosBefore: WHALE_DELEVER_BOROS_USD, borosPerSlice: r2((WHALE_DELEVER_BOROS_USD * 0.2) / 48),
      delever: {
        pct: 0.2,
        legs: WHALE_TWAP_DELEVER_RUN.legs.map((leg) => ({
          symbol: leg.symbol, exchange: leg.exchange, base: 'ETH', side: leg.side, before: WHALE_DELEVER_BOOK_ETH,
          after: r6(WHALE_DELEVER_BOOK_ETH - WHALE_TWAP_DELEVER_RUN.total),
        })),
        boros: [{ marketId: 101, before: WHALE_DELEVER_BOROS_USD, after: r2(WHALE_DELEVER_BOROS_USD * 0.8), closed: 0 }],
      },
    },
  }),
};

export const twapDealViews = {
  normal: twapPlainDealsOf(TWAP_RUN, 57.803, [30.52, 30.1]),
  whale: twapPlainDealsOf(WHALE_TWAP_RUN, 3468.208, [1834.6, 1830.2]),
};

export const twapBookTouches = {
  normal: {
    run: twapTouchesOf(TWAP_RUN), delever: twapTouchesOf(TWAP_DELEVER_RUN), close: twapTouchesOf(twapCloseOf(TWAP_RUN)),
    short: twapTouchesOf(twapShortOf(TWAP_RUN)),
  },
  whale: {
    run: twapTouchesOf(WHALE_TWAP_RUN), delever: twapTouchesOf(WHALE_TWAP_DELEVER_RUN), close: twapTouchesOf(twapCloseOf(WHALE_TWAP_RUN)),
    short: twapTouchesOf(twapShortOf(WHALE_TWAP_RUN)),
  },
};

const GATE_CONVERT_EVEN = realizeEven(
  { kind: 'even' }, 30585,
  {
    mix: null,
    loop: loopRoute(7, 21585, 7, 2700, 2.53, ETH_UP_AFTER, GATE_TO_HL),
    convert: convertRoute([21585], 43.17, 2.53, ETH_UP_AFTER, [GATE_TO_HL]),
  },
  'loop', { legs: [GATE_CONVERT_LEG], refused: null },
);

const GATE_CONVERT_VIEW = { buckets: ETH_UP_BUCKETS, plans: plansOf(GATE_CONVERT_EVEN) };

const REFUSED_HL_EVEN = realizeEven(
  { kind: 'even' }, 37526,
  {
    mix: null,
    loop: { ...OWNER_ROUTES.loop!, available: false, steps: [], after: [] },
    convert: { ...OWNER_ROUTES.convert, available: false, steps: [], after: [] },
  },
  'loop', { legs: [OWNER_ETH_LEG], refused: { reason: 'past-book', bp: null } }, { recommended: null },
);

export const auditRebalanceViews = {
  ownerCustomOverMax: { buckets: OWNER_BUCKETS, plans: ownerPlans({ custom: customPlan(50000) }), job: null },
  ownerCustomAtMax: { buckets: OWNER_BUCKETS, plans: ownerPlans({ custom: customPlan(45190) }), job: null },
  ownerCustomAtCash: {
    buckets: OWNER_BUCKETS,
    plans: ownerPlans({
      custom: realizeEven(
        { kind: 'custom', from: 'HYPERLIQUID', to: 'CROSSEX', amount: 3140 }, 3140,
        {
          mix: null,
          loop: loopRoute(1, 3140, 1, 400, 0.5, OWNER_CASH_AFTER, HL_TO_GATE),
          convert: convertRoute([3140], 6.3, 0.5, OWNER_CASH_AFTER, [HL_TO_GATE]),
        },
        'loop', null, { customMaxUsd: 3140 },
      ),
    }),
    job: null,
  },
  ownerBookCostUp: {
    buckets: OWNER_BUCKETS,
    plans: ownerPlans({
      even: {
        ...OWNER_EVEN,
        realize: {
          refused: null,
          legs: [{
            ...OWNER_ETH_LEG, closeFeeUsd: OWNER_ETH_LEG.closeFeeUsd * 2, reopenFeeUsd: OWNER_ETH_LEG.reopenFeeUsd * 2,
            convert: { amount: 10298, count: 1, feeUsd: 41.2 },
          }],
        },
      },
    }),
    job: null,
  },
  ownerBookBorrowUnread: {
    buckets: [bucketOf('USDT', 'CROSSEX', -29812, 0, 29812, 0, 0.0596), OWNER_BUCKETS[1]!], plans: OWNER_BOOK_PLANS, job: null,
  },
  refusedHlProfit: {
    buckets: OWNER_BUCKETS, plans: ownerPlans({ even: REFUSED_HL_EVEN, repay: REFUSED_HL_EVEN }), job: null,
  },
  twoLegs: { buckets: OWNER_BUCKETS, plans: TWO_LEGS_PLANS, job: null },
  twoVenues: { ...TWO_VENUES_VIEW, job: null },
  longHlLeg: {
    buckets: OWNER_BUCKETS,
    plans: ownerPlans({ even: { ...OWNER_EVEN, realize: { legs: [LONG_HL_LEG], refused: null } } }),
    job: null,
  },
  gateLegConvert: { ...GATE_CONVERT_VIEW, job: null },
} satisfies Record<string, RebalanceView>;

export const auditPositionsBodies = {
  owner: positionsWithExposure(ownerPerps(66.0, 66.0)),
  ownerAfterClose: positionsWithExposure(ownerPerps(12.2, 66.0)),
  whale: positionsWithExposure(ownerPerps(13400.5, 13400.5)),
  ownerEthBtc: positionsWithExposure([
    ...ownerPerps(66.0, 66.0),
    ...perpRows([
      ['HYPERLIQUID_FUTURE_BTC_USDC', 'SHORT', 2.1, 83000],
      ['GATE_FUTURE_BTC_USDT', 'LONG', 2.1, 83000],
    ]),
  ]),
  ownerLongHl: positionsWithExposure(
    perpRows([
      ['HYPERLIQUID_FUTURE_ETH_USDC', 'LONG', 66.0, 1821],
      ['GATE_FUTURE_ETH_USDT', 'SHORT', 66.0, 1821],
    ]),
  ),
  ownerLighterHedge: positionsWithExposure(
    perpRows([
      ['HYPERLIQUID_FUTURE_ETH_USDC', 'SHORT', 66.0, 1821],
      ['LIGHTER_FUTURE_ETH_USDC', 'LONG', 66.0, 1821],
    ]),
  ),
} satisfies Record<string, PositionsResponse>;

function perpRows(rows: [string, 'LONG' | 'SHORT', number, number][]): CrossexPosition[] {
  return rows.map(([symbol, side, qty, mark]) =>
    makeCrossexPosition({
      symbol, positionSide: side, positionQty: String(side === 'SHORT' ? -qty : qty),
      positionValue: String(Math.round(qty * mark)), entryPrice: String(mark), markPrice: String(mark), upnl: '0', upnlRate: '0',
    }),
  );
}

function ownerPerps(hlQty: number, gateQty: number): CrossexPosition[] {
  return perpRows([
    ['HYPERLIQUID_FUTURE_ETH_USDC', 'SHORT', hlQty, 1821],
    ['GATE_FUTURE_ETH_USDT', 'LONG', gateQty, 1821],
  ]);
}

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

const FAILED_TRANSFER: TransferJob = {
  ...MOVING_TRANSFER, status: 'failed', failText: 'Gate has no record of this transfer. Try again.',
};

const FAILED_OVER_CAP_TRANSFER: TransferJob = {
  id: 'mtzwovrcap', coin: 'USDC', from: 'CROSSEX_HYPERLIQUID', to: 'SPOT', amount: 442.02, status: 'failed',
  received: null, failText: 'Gate refused the move: free margin or wallet cash is too low.',
  createdAt: REBALANCE_NOW - 130_000, doneAt: REBALANCE_NOW - 60_000,
};

const FAILED_NO_SPOT_READ_TRANSFER: TransferJob = {
  id: 'mtznospotrd', coin: 'USDT', from: 'SPOT', to: 'CROSSEX', amount: 500, status: 'failed',
  received: null, failText: 'Gate spot has only 292.01 USDT.',
  createdAt: REBALANCE_NOW - 130_000, doneAt: REBALANCE_NOW - 60_000,
};

const FAILED_OVER_CAP_PATHS: TransferPath[] = ACCOUNT_B_PATHS.map((path) =>
  path.coin === 'USDC' && path.from === 'CROSSEX_HYPERLIQUID' && path.to === 'SPOT' ? { ...path, max: 292.01 } : path,
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
  failedNoSpotRead: { spot: null, paths: NO_SPOT_PATHS, lock: null, transfer: FAILED_NO_SPOT_READ_TRANSFER },
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
  bigBorrows: [
    {
      coin: 'USDT', exchangeType: 'CROSSEX', balance: '-520000.00', availableBalance: '0', upnl: '-25678.90',
      equity: '-545678.90', liability: '545678.90', borrowingInitialMargin: '109135.78', borrowingMaintenanceMargin: '54567.89',
    },
    {
      coin: 'USDC', exchangeType: 'HYPERLIQUID', balance: '2850000.00', availableBalance: '2850000.00', upnl: '312345.67',
      equity: '3162345.67', liability: '0', borrowingInitialMargin: '0', borrowingMaintenanceMargin: '0',
    },
    {
      coin: 'USDC', exchangeType: 'LIGHTER', balance: '-270000.00', availableBalance: '0', upnl: '-17654.32',
      equity: '-287654.32', liability: '287654.32', borrowingInitialMargin: '57530.86', borrowingMaintenanceMargin: '28765.43',
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
  bigBorrows: {
    ...account, marginBalance: '2329012.45', availableMargin: '1852345.81', initialMargin: '476666.64',
    maintenanceMargin: '203333.32', initialMarginRate: '0.2047', maintenanceMarginRate: '0.0873', assets: ACCOUNT_ASSETS.bigBorrows,
  },
  twoBorrows: {
    ...account, marginBalance: '1247.92', availableMargin: '1047.82', initialMargin: '200.10', maintenanceMargin: '24.40',
    initialMarginRate: '0.1603', maintenanceMarginRate: '0.0196', assets: ACCOUNT_ASSETS.twoBorrows,
  },
  oneBorrow: {
    ...account, marginBalance: '1247.92', availableMargin: '1221.52', initialMargin: '26.40',
    maintenanceMargin: '13.20', initialMarginRate: '0.0212', maintenanceMarginRate: '0.0106',
    assets: ACCOUNT_ASSETS.oneBorrow,
  },
  hyperliquidFreeBorrow: {
    ...account, marginBalance: '4200.00', availableMargin: '2856.00', initialMargin: '1344.00',
    maintenanceMargin: '420.00', initialMarginRate: '0.3200', maintenanceMarginRate: '0.1000',
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

export const whaleAccountBody = {
  ...account, marginBalance: '6000000', availableMargin: '1500000', initialMargin: '900000', maintenanceMargin: '450000',
  initialMarginRate: '0.15', maintenanceMarginRate: '0.075',
  assets: [
    {
      coin: 'USDT', exchangeType: 'CROSSEX', balance: '-4500000', availableBalance: '0', upnl: '0', equity: '-4500000',
      liability: '4500000', borrowingInitialMargin: '900000', borrowingMaintenanceMargin: '450000',
    },
    {
      coin: 'USDC', exchangeType: 'HYPERLIQUID', balance: '500000', availableBalance: '500000', upnl: '10000000',
      equity: '10500000', liability: '0', borrowingInitialMargin: '0', borrowingMaintenanceMargin: '0',
    },
  ],
};

/** Gate's /crossex/rule/risk_limits, read live 2026-09-21, mirrored in tests/fixtures/gate/risk-limits.json. */
const GATE_RISK_TIERS: MarginTiers = {
  GATE_FUTURE_ETH_USDT: [
    { from: 0, rate: 0.01, deduction: 0 },
    { from: 15_000_000, rate: 0.012, deduction: 30_000 },
    { from: 20_000_000, rate: 0.016, deduction: 110_000 },
    { from: 30_000_000, rate: 0.02, deduction: 230_000 },
    { from: 50_000_000, rate: 0.07, deduction: 2_730_000 },
    { from: 300_000_000, rate: 0.1, deduction: 11_730_000 },
  ],
  GATE_FUTURE_HYPE_USDT: [
    { from: 0, rate: 0.015, deduction: 0 },
    { from: 200_000, rate: 0.018, deduction: 600 },
    { from: 300_000, rate: 0.02, deduction: 1_200 },
    { from: 500_000, rate: 0.025, deduction: 3_700 },
    { from: 1_000_000, rate: 0.08, deduction: 58_700 },
    { from: 6_000_000, rate: 0.1, deduction: 178_700 },
  ],
  HYPERLIQUID_FUTURE_HYPE_USDC: [{ from: 0, rate: 0.05, deduction: 0 }],
};

const HYPE_MARK_STALE_AT = new Date(2026, 8, 21, 14, 32).getTime();

function abandonedAddBackPositions(gateQty: number, hyperliquidQty: number): CrossexPosition[] {
  const leg = (symbol: string, side: 'LONG' | 'SHORT', qty: number) => makeCrossexPosition({
    symbol, positionSide: side, positionQty: roundedText(side === 'LONG' ? qty : -qty), positionValue: roundedText(qty * BTC_MID),
    entryPrice: roundedText(BTC_MID), markPrice: roundedText(BTC_MID),
  });
  return [leg(HL_BTC, 'LONG', hyperliquidQty), leg(GATE_BTC, 'SHORT', gateQty)];
}

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
    marginTiers: GATE_RISK_TIERS,
  },
  hypeMarkStale: {
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
      makeCrossexPosition({
        symbol: 'GATE_FUTURE_HYPE_USDT',
        positionSide: 'LONG',
        positionQty: '10',
        positionValue: '860',
        entryPrice: '85',
        markPrice: '86',
        leverage: '10',
        maxLeverage: '10',
        upnl: '10',
        upnlRate: '0.012',
        fundingFee: '0',
        fee: '-0.43',
        initialMargin: '86',
        maintenanceMargin: '13',
      }),
      makeCrossexPosition({
        symbol: 'HYPERLIQUID_FUTURE_HYPE_USDC',
        positionSide: 'SHORT',
        positionQty: '-10',
        positionValue: '860',
        entryPrice: '85',
        markPrice: '',
        leverage: '10',
        maxLeverage: '10',
        upnl: '0',
        upnlRate: '0',
        fundingFee: '0',
        fee: '-0.43',
        initialMargin: '86',
        maintenanceMargin: '43',
        markStaleSinceMs: HYPE_MARK_STALE_AT,
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
      {
        base: 'HYPE',
        legs: [
          { symbol: 'GATE_FUTURE_HYPE_USDT', exchange: 'GATE', quote: 'USDT', side: 'LONG', qty: 10, value: 860 },
          {
            symbol: 'HYPERLIQUID_FUTURE_HYPE_USDC', exchange: 'HYPERLIQUID', quote: 'USDC', side: 'SHORT', qty: 10,
            value: 860,
          },
        ],
        longValue: 860,
        shortValue: 860,
        netValue: 0,
        grossValue: 1720,
        neutral: true,
        singleLeg: false,
      },
    ],
    marginTiers: GATE_RISK_TIERS,
  },
  deleverAbandonedAddBack: positionsWithExposure(abandonedAddBackPositions(720, 756)),
  deleverAbandonedAddBackWhale: positionsWithExposure(abandonedAddBackPositions(53.36, 56.028)),
} satisfies Record<string, PositionsResponse>;

const twapPosition = (symbol: string, side: 'LONG' | 'SHORT', qty: number, maintenanceRate: number, mark = 1730): CrossexPosition => {
  const value = r2(qty * mark);
  return makeCrossexPosition({
    symbol, positionSide: side, positionQty: String(side === 'LONG' ? qty : -qty), positionValue: String(value),
    entryPrice: String(mark), markPrice: String(mark), leverage: '25', maxLeverage: '25', upnl: '0', upnlRate: '0', fee: '0',
    initialMargin: String(r2(value / 25)), maintenanceMargin: String(r2(value * maintenanceRate)),
  });
};

export const twapPositionsBodies = {
  p1: positionsWithExposure([twapPosition('GATE_FUTURE_ETH_USDT', 'LONG', 1, 0.01), twapPosition('HYPERLIQUID_FUTURE_ETH_USDC', 'SHORT', 1, 0.02)]),
  unequal: positionsWithExposure([
    twapPosition('GATE_FUTURE_BTC_USDT', 'LONG', 4.4, 0.01, 58_000),
    twapPosition('HYPERLIQUID_FUTURE_BTC_USDC', 'SHORT', 4.03, 0.02, 58_000),
  ]),
  whale: positionsWithExposure([
    twapPosition('GATE_FUTURE_ETH_USDT', 'LONG', 3468.208, 0.01),
    twapPosition('HYPERLIQUID_FUTURE_ETH_USDC', 'SHORT', 3468.208, 0.02),
  ]),
} satisfies Record<string, PositionsResponse>;

const MIN_MS = 60_000;
const FIXTURE_NOW_SEC = Math.floor(REBALANCE_NOW / 1000);
const OWNER_WALLET = '0xab184fe7cc01f11bf80078b5bd2ac11f00c1ed9d';
export const OWNER_DEFAULT_SINCE_SEC = 1_782_211_868;
const MAR_1_2026_SEC = 1_772_323_200;
const DEC_2026_MATURITY = 1_798_156_800;
export const LINK_CODE = 'q3Jv0cX9mT2bL8wYp5nK4A';
const LINK_URL = `https://boros-bot-notification.pendle.finance/alerts?crossex=${LINK_CODE}`;
const ALL_ON = { liquidation: true, interest: true, maturity: true, rollover: true };

export const telegramBodies = {
  none: telegramInfo(),
  pending: telegramInfo(),
  connected: telegramInfo({
    connected: true, state: 'connected', settings: ALL_ON, lastSyncAt: REBALANCE_NOW - 3 * MIN_MS,
  }),
  connectedBothOff: telegramInfo({
    connected: true, state: 'connected', settings: { liquidation: false, interest: false, maturity: false, rollover: false },
    lastSyncAt: REBALANCE_NOW - 3 * MIN_MS,
  }),
  liquidationOnly: telegramInfo({
    connected: true, state: 'connected', settings: { liquidation: true, interest: false, maturity: false, rollover: false },
    lastSyncAt: REBALANCE_NOW - 3 * MIN_MS,
  }),
  interestOnly: telegramInfo({
    connected: true, state: 'connected', settings: { liquidation: false, interest: true, maturity: false, rollover: false },
    lastSyncAt: REBALANCE_NOW - 3 * MIN_MS,
  }),
  bootFailed: telegramInfo({
    connected: true, state: 'connected', settings: null, lastSyncAt: null,
    lastSyncError: { at: REBALANCE_NOW - 2 * MIN_MS, message: 'The Telegram bot answered 503.' },
  }),
  syncFailed: telegramInfo({
    connected: true, state: 'connected', settings: ALL_ON, lastSyncAt: REBALANCE_NOW - 47 * MIN_MS,
    lastSyncError: { at: REBALANCE_NOW - 2 * MIN_MS, message: 'The Telegram bot answered 503.' },
  }),
  replaced: telegramInfo({ state: 'replaced', lastSyncAt: REBALANCE_NOW - 26 * 60 * MIN_MS }),
  removed: telegramInfo({ state: 'removed', lastSyncAt: REBALANCE_NOW - 26 * 60 * MIN_MS }),
} satisfies Record<string, TelegramInfo>;

export const telegramLinkStart: TelegramLinkStart = { url: LINK_URL, expiresAt: REBALANCE_NOW + 10 * MIN_MS };

export const telegramLinkBodies = {
  none: { status: 'none', url: null, expiresAt: null },
  pending: { status: 'pending', ...telegramLinkStart },
  confirmed: { status: 'confirmed', ...telegramLinkStart },
  expired: { status: 'expired', url: LINK_URL, expiresAt: REBALANCE_NOW - MIN_MS },
} satisfies Record<string, TelegramLinkStatus>;

export const credentialsBodies = {
  unset: { configured: false, keyMasked: null },
  set: { configured: true, keyMasked: '160e…4f80' },
} satisfies Record<string, CredentialsInfo>;

export const credentialsRefused: { ok: false; error: ClassifiedError } = {
  ok: false,
  error: {
    category: 'auth',
    label: 'INVALID_KEY',
    message: 'Gate API error (HTTP 401) [INVALID_KEY]: Invalid key',
    httpStatus: 401,
    retryable: false,
    hint: 'Gate rejected these credentials — check key, secret, and CrossEx permission.',
  },
};

export const agentBodies = {
  none: agentStatus(),
  set: agentStatus({
    configured: true, root: OWNER_WALLET, rootMasked: '0xab18…ed9d', accountId: 0,
    expiry: FIXTURE_NOW_SEC + 180 * 86_400,
  }),
  expired: agentStatus({
    configured: true, root: OWNER_WALLET, rootMasked: '0xab18…ed9d', accountId: 0,
    expiry: FIXTURE_NOW_SEC - 86_400, expired: true,
  }),
} satisfies Record<string, BorosAgentStatus>;

function perpLeg(
  symbol: string, side: 'LONG' | 'SHORT', qty: number, entryPrice: number, markPrice: number, fundingUsd: number,
  openedAt: number,
): AssetPerpOpen {
  const notionalUsd = qty * markPrice;
  return {
    symbol, venue: symbol.split('_')[0], side, qty, notionalUsd, entryPrice, markPrice, leverage: 10,
    upnlUsd: (side === 'LONG' ? 1 : -1) * (markPrice - entryPrice) * qty, fundingUsd, feesUsd: notionalUsd * 0.0005,
    imUsd: notionalUsd / 10, openedAt,
  };
}

function perpFromPosition(p: CrossexPosition, openedAt: number): AssetPerpOpen {
  return {
    symbol: p.symbol, venue: p.symbol.split('_')[0], side: p.positionSide === 'SHORT' ? 'SHORT' : 'LONG',
    qty: Math.abs(Number(p.positionQty)), notionalUsd: Number(p.positionValue), entryPrice: Number(p.entryPrice),
    markPrice: Number(p.markPrice), leverage: Number(p.leverage), upnlUsd: Number(p.upnl),
    fundingUsd: Number(p.fundingFee), feesUsd: -Number(p.fee), imUsd: Number(p.initialMargin), openedAt,
  };
}

function borosLegs(sizeToken: number, priceUsd: number, settleUsd: number): {
  open: AssetBorosOpen[]; history: AssetBorosHistory[];
} {
  const notionalUsd = sizeToken * priceUsd;
  const leg = { maturity: DEC_2026_MATURITY, collateral: 'ETH', sizeToken, notionalUsd, settleFeeApr: 0.001, spreadVenues: null };
  return {
    open: [
      {
        ...leg, marketId: 214, venue: 'BINANCE', side: 'SHORT', entryApr: 0.0712, markApr: 0.0685, floatingApr: 0.0641,
        settleUsd, mtmUsd: notionalUsd * 0.0003, imUsd: notionalUsd * 0.03,
      },
      {
        ...leg, marketId: 215, venue: 'HYPERLIQUID', side: 'LONG', entryApr: 0.0874, markApr: 0.0928, floatingApr: 0.0955,
        settleUsd: -settleUsd / 2, mtmUsd: notionalUsd * 0.0002, imUsd: notionalUsd * 0.03,
      },
    ],
    history: [
      {
        marketId: 214, venue: 'BINANCE', spreadVenues: null, maturity: DEC_2026_MATURITY, settleUsd, settleFeeUsd: settleUsd * 0.025,
        tradePnlUsd: -notionalUsd * 0.0004, tradeFeeUsd: notionalUsd * 0.00025, peakSizeToken: sizeToken,
        peakNotionalUsd: notionalUsd, firstEventSec: 1_783_004_000, entryApr: 0.0712, side: 'SHORT',
      },
      {
        marketId: 215, venue: 'HYPERLIQUID', spreadVenues: null, maturity: DEC_2026_MATURITY, settleUsd: -settleUsd / 2,
        settleFeeUsd: settleUsd * 0.0125, tradePnlUsd: -notionalUsd * 0.0003, tradeFeeUsd: notionalUsd * 0.00025,
        peakSizeToken: sizeToken, peakNotionalUsd: notionalUsd, firstEventSec: 1_783_004_000, entryApr: 0.0874,
        side: 'LONG',
      },
    ],
  };
}

function assetGroup(
  base: string, priceUsd: number, perpOpen: AssetPerpOpen[], boros?: { open: AssetBorosOpen[]; history: AssetBorosHistory[] },
): AssetGroup {
  return {
    base, supported: true, priceUsd, earliestSec: Math.min(...perpOpen.map((p) => p.openedAt ?? FIXTURE_NOW_SEC)),
    perpOpen, perpClosed: [], borosOpen: boros?.open ?? [], borosHistory: boros?.history ?? [],
  };
}

const ownerEth = assetGroup(
  'ETH',
  2472.74,
  [
    perpLeg('GATE_FUTURE_ETH_USDT', 'LONG', 0.555, 2438.6, 2472.74, 3.18, 1_783_000_000),
    perpLeg('OKX_FUTURE_ETH_USDT', 'LONG', 0.1, 2451.2, 2472.84, 0.61, 1_785_400_000),
    perpLeg('BINANCE_FUTURE_ETH_USDT', 'LONG', 0.05, 2466.02, 2473.01398156, 0.12, 1_787_900_000),
    perpLeg('HYPERLIQUID_FUTURE_ETH_USDC', 'SHORT', 0.62, 2441.75, 2473.41, 4.87, 1_783_000_000),
    perpLeg('LIGHTER_FUTURE_ETH_USDC', 'SHORT', 0.1, 2449.9, 2472.94, 0.35, 1_785_400_000),
  ],
  borosLegs(1.2, 2472.74, 4.38),
);

const ownerHype = assetGroup('HYPE', 86.597, [
  perpLeg('HYPERLIQUID_FUTURE_HYPE_USDC', 'SHORT', 2.3, 41.62, 86.585, 2.95, OWNER_DEFAULT_SINCE_SEC),
  perpLeg('GATE_FUTURE_HYPE_USDT', 'LONG', 2.3, 41.7, 86.597, -1.12, OWNER_DEFAULT_SINCE_SEC + 40),
]);

const ownerEthClosed: AssetGroup = {
  ...ownerEth,
  earliestSec: 1_776_500_000,
  perpClosed: [
    {
      symbol: 'GATE_FUTURE_ETH_USDT', venue: 'GATE', closedPnlUsd: 18.24, fundingUsd: 1.9, feesUsd: 0.93, count: 1,
      lastClosedAt: 1_778_000_000,
      rows: [
        {
          closedAt: 1_778_000_000, qty: 0.4, openPx: 2310.5, closePx: 2356.1, priceUsd: 18.24, fundingUsd: 1.9,
          feesUsd: 0.93, complete: true, dedupedIntoOpen: false,
        },
      ],
    },
  ],
};

const solLeg: AssetGroup = {
  ...assetGroup('SOL', 181.25, [perpLeg('GATE_FUTURE_SOL_USDT', 'LONG', 12, 176.4, 181.25, 0.84, 1_788_000_000)]),
  supported: false,
};

const solWhaleLeg: AssetGroup = {
  ...assetGroup('SOL', 181.25, [
    { ...perpLeg('GATE_FUTURE_SOL_USDT', 'LONG', 12, 176.4, 181.25, 0.84, 1_788_000_000), upnlUsd: 6_000_000.37 },
  ]),
  supported: false,
};

const ownerEthEntryPending: AssetGroup = {
  ...ownerEth,
  borosOpen: ownerEth.borosOpen.map((leg, i) => (i === 0 ? { ...leg, entryApr: null } : leg)),
};

const avDefault: AssetViewResponse = {
  ...assetView,
  sinceSec: OWNER_DEFAULT_SINCE_SEC,
  nowSec: FIXTURE_NOW_SEC,
  defaultSinceSec: OWNER_DEFAULT_SINCE_SEC,
  assets: [ownerEth, ownerHype],
  earliestSec: OWNER_DEFAULT_SINCE_SEC,
  interest: { paidUsd: 3.41, byCoin: { USDT: 3.41 }, coversFromSec: 0, available: true },
};

const avAllTime: AssetViewResponse = {
  ...avDefault,
  sinceSec: 0,
  assets: [ownerEthClosed, ownerHype],
  earliestSec: 1_776_500_000,
  interest: { paidUsd: 5.02, byCoin: { USDT: 5.02 }, coversFromSec: 0, available: true },
};

const WHALE_ASSETS = [
  {
    coin: 'USDT', exchangeType: 'CROSSEX', balance: '-999999.995', availableBalance: '0', upnl: '3283',
    equity: '-996716.995', liability: '999999.995', borrowingInitialMargin: '199999.999',
    borrowingMaintenanceMargin: '99999.9995',
  },
  {
    coin: 'USDC', exchangeType: 'HYPERLIQUID', balance: '6493799.995', availableBalance: '3373759.901', upnl: '2917',
    equity: '6496716.995', liability: '0', borrowingInitialMargin: '0', borrowingMaintenanceMargin: '0',
  },
  {
    coin: 'USDC', exchangeType: 'LIGHTER', balance: '500000', availableBalance: '500000', upnl: '0', equity: '500000',
    liability: '0', borrowingInitialMargin: '0', borrowingMaintenanceMargin: '0',
  },
  {
    coin: 'USDC', exchangeType: 'GATE', balance: '0', availableBalance: '0', upnl: '0', equity: '0', liability: '0',
    borrowingInitialMargin: '0', borrowingMaintenanceMargin: '0',
  },
];

const WHALE_POSITIONS = [
  makeCrossexPosition({
    symbol: 'BINANCE_FUTURE_ETH_USDT', positionSide: 'SHORT', positionQty: '-4100', positionValue: '10138234',
    entryPrice: '2473.58', markPrice: '2472.74', leverage: '10', upnl: '3444', upnlRate: '0.0034',
    fundingFee: '-2310.55', fee: '-5069.117', initialMargin: '1013823.4', maintenanceMargin: '101382.34',
  }),
  makeCrossexPosition({
    symbol: 'HYPERLIQUID_FUTURE_ETH_USDC', positionSide: 'LONG', positionQty: '4100', positionValue: '10140981',
    entryPrice: '2472.62', markPrice: '2473.41', leverage: '10', maxLeverage: '25', upnl: '3239', upnlRate: '0.0032',
    fundingFee: '4875.2', fee: '-5070.4905', initialMargin: '1014098.1', maintenanceMargin: '101409.81',
  }),
  makeCrossexPosition({
    symbol: 'GATE_FUTURE_HYPE_USDT', positionSide: 'LONG', positionQty: '23000', positionValue: '1991731',
    entryPrice: '86.604', markPrice: '86.597', leverage: '10', maxLeverage: '10', upnl: '-161', upnlRate: '-0.0008',
    fundingFee: '-410.12', fee: '-995.8655', initialMargin: '199173.1', maintenanceMargin: '19917.31',
  }),
  makeCrossexPosition({
    symbol: 'HYPERLIQUID_FUTURE_HYPE_USDC', positionSide: 'SHORT', positionQty: '-23000', positionValue: '1991455',
    entryPrice: '86.571', markPrice: '86.585', leverage: '10', maxLeverage: '10', upnl: '-322', upnlRate: '-0.0016',
    fundingFee: '655.34', fee: '-995.7275', initialMargin: '199145.5', maintenanceMargin: '19914.55',
  }),
];

const [whaleBinanceEth, whaleHlEth, whaleGateHype, whaleHlHype] = WHALE_POSITIONS;

export const whaleBook = {
  account: {
    ...account, marginBalance: '6000000', availableMargin: '3373759.901', initialMargin: '2626240.099',
    maintenanceMargin: '342624.0095', initialMarginRate: '0.4377', maintenanceMarginRate: '0.0571', assets: WHALE_ASSETS,
  },
  positions: {
    positions: WHALE_POSITIONS,
    exposure: [
      {
        base: 'ETH',
        legs: [
          {
            symbol: 'BINANCE_FUTURE_ETH_USDT', exchange: 'BINANCE', quote: 'USDT', side: 'SHORT', qty: 4100,
            value: 10_138_234,
          },
          {
            symbol: 'HYPERLIQUID_FUTURE_ETH_USDC', exchange: 'HYPERLIQUID', quote: 'USDC', side: 'LONG', qty: 4100,
            value: 10_140_981,
          },
        ],
        longValue: 10_140_981, shortValue: 10_138_234, netValue: 2_747, grossValue: 20_279_215, neutral: true,
        singleLeg: false,
      },
      {
        base: 'HYPE',
        legs: [
          { symbol: 'GATE_FUTURE_HYPE_USDT', exchange: 'GATE', quote: 'USDT', side: 'LONG', qty: 23_000, value: 1_991_731 },
          {
            symbol: 'HYPERLIQUID_FUTURE_HYPE_USDC', exchange: 'HYPERLIQUID', quote: 'USDC', side: 'SHORT', qty: 23_000,
            value: 1_991_455,
          },
        ],
        longValue: 1_991_731, shortValue: 1_991_455, netValue: 276, grossValue: 3_983_186, neutral: true,
        singleLeg: false,
      },
    ],
    marginTiers: GATE_RISK_TIERS,
  },
  assetView: {
    ...avDefault,
    assets: [
      assetGroup(
        'ETH',
        2472.74,
        [perpFromPosition(whaleBinanceEth, 1_783_000_000), perpFromPosition(whaleHlEth, 1_783_000_000)],
        borosLegs(4100, 2472.74, 18_234.56),
      ),
      assetGroup('HYPE', 86.597, [
        perpFromPosition(whaleHlHype, OWNER_DEFAULT_SINCE_SEC),
        perpFromPosition(whaleGateHype, OWNER_DEFAULT_SINCE_SEC + 40),
      ]),
    ],
    interest: { paidUsd: 11_834.21, byCoin: { USDT: 11_834.21 }, coversFromSec: 0, available: true },
  },
} satisfies { account: CrossexAccount; positions: PositionsResponse; assetView: AssetViewResponse };

const BTC_MATURITY = 1_794_816_000;
const BTC_PAST_MATURITY = 1_788_000_000;

function btcBoros(
  marketId: number, size: number, side: 'LONG' | 'SHORT', venue: string, spread: [string, string] | null, maturity = BTC_MATURITY,
): AssetBorosOpen {
  const notionalUsd = size * BTC_MID;
  return {
    marketId, venue, spreadVenues: spread, maturity, collateral: 'BTC', side, sizeToken: size, notionalUsd, entryApr: 0.031,
    markApr: 0.034, floatingApr: 0.029, settleUsd: 0, mtmUsd: 0, imUsd: size * 500, settleFeeApr: 0.001,
  };
}

function btcView(hlSide: 'LONG' | 'SHORT', boros: AssetBorosOpen[]): AssetViewResponse {
  const gateSide = hlSide === 'LONG' ? 'SHORT' : 'LONG';
  const group = assetGroup(
    'BTC', BTC_MID,
    [
      { ...perpLeg(HL_BTC, hlSide, 900, 89_000, BTC_MID, 12, 1_783_000_000), imUsd: 1_800_000 },
      { ...perpLeg(GATE_BTC, gateSide, 900, 89_100, BTC_MID, -4, 1_783_000_000), imUsd: 1_800_000 },
    ],
    { open: boros, history: [] },
  );
  return { ...avDefault, assets: [group] };
}

const BTC_SPREAD_LONG = btcBoros(101, 900, 'LONG', 'HYPERLIQUID', ['HYPERLIQUID', 'GATE']);

const hypePairGroup = () => assetGroup('HYPE', 86.597, [
    perpLeg('HYPERLIQUID_FUTURE_HYPE_USDC', 'LONG', 57.7, 85.1, 86.597, 0.4, OWNER_DEFAULT_SINCE_SEC),
    perpLeg('GATE_FUTURE_HYPE_USDT', 'SHORT', 57.7, 85.2, 86.597, -0.2, OWNER_DEFAULT_SINCE_SEC),
  ], { open: [{ ...btcBoros(301, 57.7, 'LONG', 'HYPERLIQUID', ['HYPERLIQUID', 'GATE']), collateral: 'HYPE' }], history: [] });

const twoPairsView = (): AssetViewResponse => {
  const btc = btcView('LONG', [BTC_SPREAD_LONG]);
  const eth = assetGroup('ETH', 2510, [
    { ...perpLeg('HYPERLIQUID_FUTURE_ETH_USDC', 'LONG', 120, 2490, 2510, 3, 1_783_000_000), imUsd: 15_060 },
    { ...perpLeg('GATE_FUTURE_ETH_USDT', 'SHORT', 120, 2495, 2510, -1, 1_783_000_000), imUsd: 15_060 },
  ], { open: [{ ...btcBoros(201, 120, 'LONG', 'HYPERLIQUID', ['HYPERLIQUID', 'GATE']), collateral: 'ETH', notionalUsd: 120 * 2510, imUsd: 9_000 }], history: [] });
  return { ...btc, assets: [...btc.assets, eth] };
};

export const assetViewBodies = {
  default: avDefault,
  btc900: btcView('LONG', [BTC_SPREAD_LONG]),
  btc900Mirror: btcView('SHORT', [btcBoros(101, 900, 'SHORT', 'HYPERLIQUID', ['HYPERLIQUID', 'GATE'])]),
  btcTwoBoros: btcView('LONG', [
    btcBoros(101, 500, 'LONG', 'HYPERLIQUID', ['HYPERLIQUID', 'GATE']),
    btcBoros(102, 400, 'LONG', 'HYPERLIQUID', ['HYPERLIQUID', 'GATE']),
  ]),
  dollarPair: { ...avDefault, assets: [hypePairGroup()] },
  twoPairs: twoPairsView(),
  maturedLeg: btcView('LONG', [btcBoros(101, 900, 'LONG', 'HYPERLIQUID', ['HYPERLIQUID', 'GATE'], BTC_PAST_MATURITY)]),
  allTime: avAllTime,
  backfilling: {
    ...avDefault,
    sinceSec: MAR_1_2026_SEC,
    coverage: { ...avDefault.coverage, backfilling: true },
  },
  backfillingAllTime: {
    ...avAllTime,
    coverage: { ...avAllTime.coverage, backfilling: true },
  },
  unsupported: { ...avDefault, assets: [ownerEth, ownerHype, solLeg] },
  noDefault: { ...avAllTime, defaultSinceSec: null },
  entryPending: { ...avDefault, assets: [ownerEthEntryPending, ownerHype] },
  whale: whaleBook.assetView,
  whaleUnsupported: { ...whaleBook.assetView, assets: [...whaleBook.assetView.assets, solWhaleLeg] },
} satisfies Record<string, AssetViewResponse>;

function pairRow(over: Partial<BorosPairMarketRow>): BorosPairMarketRow {
  return {
    marketId: 214, name: 'Binance ETHUSDT 25 Dec 2026', venue: 'BINANCE', base: 'ETH', tokenId: 2, collateral: 'ETH',
    maturity: DEC_2026_MATURITY, midApr: 0.0688, markApr: 0.0685, maxRateDeviationApr: 0.0137, isolatedOnly: false,
    onIsolatedMargin: false, isolatedHasPositionOrOrders: false, currentSize: 0, collateralPriceUsd: 2472.74,
    closeOnly: false, spreadVenues: null, ...over,
  };
}

function pairContext(closeOnly: 'A' | 'B', size: number): BorosPairContext {
  return {
    markets: [
      pairRow({ currentSize: -size, closeOnly: closeOnly === 'A' }),
      pairRow({
        marketId: 215, name: 'Hyperliquid ETH 25 Dec 2026', venue: 'HYPERLIQUID', midApr: 0.0931, markApr: 0.0928,
        maxRateDeviationApr: 0.01856, currentSize: size, closeOnly: closeOnly === 'B',
      }),
    ],
    crossByToken: [{ tokenId: 2, available: size / 4 }],
    spreadMarkets: [],
    isolatedByMarket: [],
    defaultSlippageApr: 0.0025,
    maxSlippageApr: 0.1,
  };
}

const closeOnlyABase = pairContext('A', 1.2);

export const pairContextBodies = {
  closeOnlyA: closeOnlyABase,
  closeOnlyALong: {
    ...closeOnlyABase,
    markets: [
      { ...closeOnlyABase.markets[0], currentSize: 1.2 },
      { ...closeOnlyABase.markets[1], currentSize: -1.2 },
    ],
  },
  closeOnlyB: pairContext('B', 1.2),
  whaleCloseOnlyA: pairContext('A', 4100),
  whaleCloseOnlyB: pairContext('B', 4100),
} satisfies Record<string, BorosPairContext>;

function roundedText(x: number): string {
  return String(Math.round(x * 1e8) / 1e8);
}

function positionFromPerp(p: AssetPerpOpen): CrossexPosition {
  return makeCrossexPosition({
    symbol: p.symbol, positionSide: p.side, positionQty: roundedText(p.side === 'LONG' ? p.qty : -p.qty),
    positionValue: roundedText(p.notionalUsd), entryPrice: roundedText(p.entryPrice),
    markPrice: roundedText(p.markPrice),
    leverage: roundedText(p.leverage), upnl: roundedText(p.upnlUsd), upnlRate: roundedText(p.upnlUsd / p.imUsd),
    fundingFee: roundedText(p.fundingUsd), fee: roundedText(-p.feesUsd), initialMargin: roundedText(p.imUsd),
    maintenanceMargin: roundedText(p.imUsd / 10),
  });
}

function positionsWithExposure(positions: CrossexPosition[]): PositionsResponse {
  const legs = positions.map((p) => {
    const [exchange, , base, quote] = p.symbol.split('_');
    const side: 'LONG' | 'SHORT' = p.positionSide === 'SHORT' ? 'SHORT' : 'LONG';
    const qty = Math.abs(Number(p.positionQty));
    return { base, leg: { symbol: p.symbol, exchange, quote, side, qty, value: Number(p.positionValue) } };
  });
  const exposure = [...new Set(legs.map((l) => l.base))].map((base) => {
    const group = legs.filter((l) => l.base === base).map((l) => l.leg);
    const valueOf = (side: 'LONG' | 'SHORT') => group.filter((l) => l.side === side).reduce((a, l) => a + l.value, 0);
    const longValue = valueOf('LONG');
    const shortValue = valueOf('SHORT');
    const grossValue = longValue + shortValue;
    return {
      base, legs: group, longValue, shortValue, netValue: longValue - shortValue, grossValue,
      neutral: grossValue > 0 && Math.abs(longValue - shortValue) / grossValue < 0.02,
      singleLeg: group.every((l) => l.side === group[0].side),
    };
  });
  return { positions, exposure: exposure.sort((a, b) => b.grossValue - a.grossValue) };
}

export const assetViewPositions = {
  unsupported: positionsWithExposure(
    assetViewBodies.unsupported.assets.flatMap((g) => g.perpOpen).map(positionFromPerp),
  ),
  whaleUnsupported: positionsWithExposure([
    ...whaleBook.positions.positions,
    ...solWhaleLeg.perpOpen.map(positionFromPerp),
  ]),
} satisfies Record<string, PositionsResponse>;

const whaleFrpGroup = assetGroup(
  'ETH', 2472.74,
  [perpFromPosition(whaleHlEth, 1_783_000_000), perpFromPosition(whaleBinanceEth, 1_783_000_000)],
  { open: [{ ...btcBoros(101, 4100, 'LONG', 'HYPERLIQUID', ['HYPERLIQUID', 'BINANCE']), collateral: 'ETH', notionalUsd: 4100 * 2472.74 }], history: [] },
);

export const deleverPairViews = {
  btcFrp: assetViewBodies.btc900,
  whaleFrp: { ...whaleBook.assetView, assets: [whaleFrpGroup] } satisfies AssetViewResponse,
} satisfies Record<string, AssetViewResponse>;

export const deleverPairPositions = {
  btcFrp: positionsWithExposure(deleverPairViews.btcFrp.assets.flatMap((g) => g.perpOpen).map(positionFromPerp)),
  whaleFrp: positionsWithExposure(whaleFrpGroup.perpOpen.map(positionFromPerp)),
} satisfies Record<string, PositionsResponse>;

function closeOnlyOpportunities(context: BorosPairContext): OpportunitiesResult {
  const [binance, hyperliquid] = context.markets;
  const secondsToMaturity = binance.maturity - FIXTURE_NOW_SEC;
  const nt = OPP_NOTIONAL * (secondsToMaturity / (365 * 24 * 3600));
  const halfSpreadApr = 0.0005;
  const row = (m: BorosPairMarketRow, crossexSymbol: string) =>
    makeOpportunityMarketRow({
      marketId: m.marketId, name: m.name, venue: m.venue, crossexVenue: m.venue, crossexSymbol, base: m.base,
      midApr: m.midApr, markApr: m.markApr, execShortApr: m.midApr - halfSpreadApr,
      execLongApr: m.midApr + halfSpreadApr,
    });
  const leg = (m: BorosPairMarketRow, crossexSymbol: string) =>
    makeOpportunityLeg({ venue: m.venue, crossexVenue: m.venue, crossexSymbol, base: m.base });
  const borosLeg = (m: BorosPairMarketRow, side: 'SHORT' | 'LONG', execApr: number) =>
    makeOpportunityBorosLeg({ marketId: m.marketId, side, venue: m.venue, midApr: m.midApr, execApr });
  const hyperliquidSymbol = 'HYPERLIQUID_FUTURE_ETH_USDC';
  const binanceSymbol = 'BINANCE_FUTURE_ETH_USDT';
  const shortExecApr = hyperliquid.midApr - halfSpreadApr;
  const longExecApr = binance.midApr + halfSpreadApr;
  const template = makeOpportunityPair();
  const { perpEntryFeesUsd, perpEntrySlippageUsd, perpExitFeesUsd, perpExitSlippageUsd } = template.costs;
  const borosTakerFeeUsd = 0.001 * nt;
  const borosSettleFeeUsd = 0.002 * nt;
  const totalUsd = [
    borosTakerFeeUsd, borosSettleFeeUsd, perpEntryFeesUsd, perpEntrySlippageUsd, perpExitFeesUsd, perpExitSlippageUsd,
  ].reduce<number>((a, x) => a + (x ?? 0), 0);
  const grossSpreadApr = hyperliquid.midApr - binance.midApr;
  const execSpreadApr = shortExecApr - longExecApr;
  const netFixedApr = execSpreadApr - totalUsd / nt;
  const estProfitUsd = netFixedApr * nt;
  const capitalUsd = template.capitalUsd ?? 0;
  const pair: OpportunityPair = {
    ...template,
    shortLeg: leg(hyperliquid, hyperliquidSymbol),
    longLeg: leg(binance, binanceSymbol),
    borosLegs: [borosLeg(hyperliquid, 'SHORT', shortExecApr), borosLeg(binance, 'LONG', longExecApr)],
    grossSpreadApr,
    execSpreadApr,
    borosImpactApr: grossSpreadApr - execSpreadApr,
    costs: { ...template.costs, borosTakerFeeUsd, borosSettleFeeUsd, totalUsd, annualizedApr: totalUsd / nt },
    netFixedApr,
    netFixedAprOnCapital: capitalUsd > 0 ? estProfitUsd / (capitalUsd * (nt / OPP_NOTIONAL)) : null,
    estProfitUsd,
    secondsToMaturity,
  };
  return makeOpportunitiesResult({
    groups: [
      makeOpportunityGroup({
        tokenId: binance.tokenId, collateral: binance.collateral, collateralPriceUsd: binance.collateralPriceUsd,
        maturity: binance.maturity, secondsToMaturity,
        markets: [row(hyperliquid, hyperliquidSymbol), row(binance, binanceSymbol)], pairs: [pair],
      }),
    ],
    meta: { ...makeOpportunitiesResult().meta, asOfSec: FIXTURE_NOW_SEC },
  });
}

export const opportunitiesBodies = {
  closeOnlyA: closeOnlyOpportunities(pairContextBodies.closeOnlyA),
} satisfies Record<string, OpportunitiesResult>;

export const SPREAD_BOOK_PRICE = 2568;
export const SPREAD_WHALE_NOTIONAL = 6_000_000;
export const SPREAD_WHALE_QTY = 4672.9;
const SPREAD_BOOK_VENUES: [string, string] = ['HYPERLIQUID', 'GATE'];
const OCT_30_2026_MATURITY = 1_793_318_400;
const SPREAD_BOOK_OPENED = SPREAD_OPP_NOW - 2 * 86_400;

interface SpreadBookLeg {
  marketId: number;
  venue: string;
  spreadVenues: [string, string] | null;
  side: 'LONG' | 'SHORT';
  sizeToken: number;
  maturity: number;
  entryApr: number;
  markApr: number;
  floatingApr: number;
}

const spreadBookLeg = (side: 'LONG' | 'SHORT', sizeToken: number): SpreadBookLeg => ({
  marketId: SPREAD_OPP_MARKET_ID, venue: 'HYPERLIQUID', spreadVenues: SPREAD_BOOK_VENUES, side, sizeToken,
  maturity: SPREAD_OPP_MATURITY, entryApr: 0.0352, markApr: 0.0348, floatingApr: 0.031,
});

const hyperliquidSingleLeg = (marketId: number, sizeToken: number, maturity: number): SpreadBookLeg => ({
  marketId, venue: 'HYPERLIQUID', spreadVenues: null, side: 'SHORT', sizeToken, maturity, entryApr: 0.083,
  markApr: 0.083, floatingApr: 0.0712,
});

const gateSingleLeg = (marketId: number, sizeToken: number, maturity: number): SpreadBookLeg => ({
  marketId, venue: 'GATE', spreadVenues: null, side: 'LONG', sizeToken, maturity, entryApr: 0.0482, markApr: 0.0482,
  floatingApr: 0.0641,
});

function spreadBookBoros(legs: SpreadBookLeg[]): { open: AssetBorosOpen[]; history: AssetBorosHistory[] } {
  const heldYears = (SPREAD_OPP_NOW - SPREAD_BOOK_OPENED) / SECONDS_IN_YEAR;
  const rows = legs.map((l) => {
    const notionalUsd = l.sizeToken * SPREAD_BOOK_PRICE;
    const sign = l.side === 'SHORT' ? 1 : -1;
    const settleFeeApr = l.spreadVenues ? 0.002 : 0.001;
    const takerFeeRate = l.spreadVenues ? 0.001 : 0.0005;
    const settleUsd = sign * (l.entryApr - l.floatingApr) * notionalUsd * heldYears;
    const tradeFeeUsd = takerFeeRate * notionalUsd * ((l.maturity - SPREAD_BOOK_OPENED) / SECONDS_IN_YEAR);
    const open: AssetBorosOpen = {
      marketId: l.marketId, venue: l.venue, spreadVenues: l.spreadVenues, maturity: l.maturity, collateral: 'ETH',
      side: l.side, sizeToken: l.sizeToken, notionalUsd, entryApr: l.entryApr, markApr: l.markApr,
      floatingApr: l.floatingApr, settleUsd,
      mtmUsd: sign * (l.entryApr - l.markApr) * notionalUsd * ((l.maturity - SPREAD_OPP_NOW) / SECONDS_IN_YEAR),
      imUsd: notionalUsd * 0.03, settleFeeApr,
    };
    const history: AssetBorosHistory = {
      marketId: l.marketId, venue: l.venue, spreadVenues: l.spreadVenues, maturity: l.maturity, settleUsd,
      settleFeeUsd: settleFeeApr * notionalUsd * heldYears, tradePnlUsd: -tradeFeeUsd, tradeFeeUsd,
      peakSizeToken: l.sizeToken, peakNotionalUsd: notionalUsd, firstEventSec: SPREAD_BOOK_OPENED,
      entryApr: l.entryApr, side: l.side,
    };
    return { open, history };
  });
  return { open: rows.map((r) => r.open), history: rows.map((r) => r.history) };
}

function spreadBookPerps(qty: number): AssetPerpOpen[] {
  return [
    perpLeg('GATE_FUTURE_ETH_USDT', 'LONG', qty, SPREAD_BOOK_PRICE, SPREAD_BOOK_PRICE, (3.18 / 0.555) * qty, SPREAD_BOOK_OPENED),
    perpLeg(
      'HYPERLIQUID_FUTURE_ETH_USDC', 'SHORT', qty, SPREAD_BOOK_PRICE, SPREAD_BOOK_PRICE, (4.87 / 0.62) * qty,
      SPREAD_BOOK_OPENED,
    ),
  ];
}

function spreadBook(perps: AssetPerpOpen[], legs: SpreadBookLeg[], interestPaidUsd = 0): AssetViewResponse {
  return {
    ...assetView,
    nowSec: SPREAD_OPP_NOW,
    earliestSec: SPREAD_BOOK_OPENED,
    assets: [{ ...assetGroup('ETH', SPREAD_BOOK_PRICE, perps, spreadBookBoros(legs)), earliestSec: SPREAD_BOOK_OPENED }],
    interest: { paidUsd: interestPaidUsd, byCoin: { USDT: interestPaidUsd }, coversFromSec: 0, available: true },
  };
}

export function makeSpreadWhaleBook(): AssetViewResponse {
  return spreadBook(spreadBookPerps(SPREAD_WHALE_QTY), [spreadBookLeg('SHORT', SPREAD_WHALE_QTY)], 999_999.995);
}

export const spreadBookBodies = {
  spread: spreadBook(spreadBookPerps(0.555), [spreadBookLeg('SHORT', 0.555)]),
  mixed: spreadBook(spreadBookPerps(0.555), [
    hyperliquidSingleLeg(51, 0.3, SPREAD_OPP_MATURITY),
    gateSingleLeg(60, 0.3, SPREAD_OPP_MATURITY),
    spreadBookLeg('SHORT', 0.255),
  ]),
  missing: spreadBook(spreadBookPerps(0.555), []),
  'wrong-side': spreadBook(spreadBookPerps(0.555), [spreadBookLeg('LONG', 0.555)]),
  'spread-only': spreadBook([], [spreadBookLeg('SHORT', 0.555)]),
  'early-singles': spreadBook(spreadBookPerps(0.555), [
    hyperliquidSingleLeg(61, 0.555, OCT_30_2026_MATURITY),
    gateSingleLeg(62, 0.555, OCT_30_2026_MATURITY),
  ]),
  whale: makeSpreadWhaleBook(),
} satisfies Record<string, AssetViewResponse>;

export const spreadBookPositions = Object.fromEntries(
  Object.entries(spreadBookBodies).map(([name, body]) => [
    name,
    {
      ...positionsWithExposure(body.assets.flatMap((g) => g.perpOpen).map(positionFromPerp)),
      marginTiers: GATE_RISK_TIERS,
    },
  ]),
) as Record<keyof typeof spreadBookBodies, PositionsResponse>;

const spreadContextRow = (
  marketId: number, venue: string, name: string, maturity: number, midApr: number,
  spreadVenues: [string, string] | null = null,
): BorosPairMarketRow =>
  pairRow({
    marketId, venue, name, maturity, midApr, markApr: midApr, spreadVenues, collateralPriceUsd: SPREAD_BOOK_PRICE,
    maxRateDeviationApr: spreadVenues ? 0.02 : venue === 'GATE' ? 0.0137 : 0.01856,
  });

function spreadPairContext(spreads: 'listed' | 'none' | 'paused'): BorosPairContext {
  return {
    markets: [
      spreadContextRow(61, 'HYPERLIQUID', 'Hyperliquid ETH 30 Oct 2026', OCT_30_2026_MATURITY, 0.083),
      spreadContextRow(62, 'GATE', 'Gate ETHUSDT 30 Oct 2026', OCT_30_2026_MATURITY, 0.0482),
      spreadContextRow(51, 'HYPERLIQUID', 'Hyperliquid ETH 27 Nov 2026', SPREAD_OPP_MATURITY, 0.083),
      spreadContextRow(60, 'GATE', 'Gate ETHUSDT 27 Nov 2026', SPREAD_OPP_MATURITY, 0.0482),
      spreadContextRow(64, 'HYPERLIQUID', 'Hyperliquid ETH 25 Dec 2026', DEC_2026_MATURITY, 0.083),
      spreadContextRow(65, 'GATE', 'Gate ETHUSDT 25 Dec 2026', DEC_2026_MATURITY, 0.0482),
    ],
    spreadMarkets:
      spreads === 'none'
        ? []
        : [
            spreadContextRow(
              63, 'HL-GATE', 'ETH Spread HL-GATE 30 Oct 2026', OCT_30_2026_MATURITY, 0.0348,
              SPREAD_BOOK_VENUES,
            ),
            {
              ...spreadContextRow(
                SPREAD_OPP_MARKET_ID, 'HL-GATE', 'ETH Spread HL-GATE 27 Nov 2026', SPREAD_OPP_MATURITY,
                0.0348, SPREAD_BOOK_VENUES,
              ),
              closeOnly: spreads === 'paused',
              paused: spreads === 'paused',
            },
          ],
    crossByToken: [{ tokenId: 2, available: 116 }],
    isolatedByMarket: [],
    defaultSlippageApr: 0.0025,
    maxSlippageApr: 0.1,
  };
}

export const spreadPairContextBodies = {
  spread: spreadPairContext('listed'),
  'no-spread': spreadPairContext('none'),
  'spread-paused': spreadPairContext('paused'),
} satisfies Record<string, BorosPairContext>;

export function makeSpreadWhaleOpportunityPair(): OpportunityPair {
  const k = SPREAD_WHALE_NOTIONAL / OPP_NOTIONAL;
  const usd = (x: number | null): number | null => (x === null ? null : x * k);
  const pair = makeSpreadOpportunityPair();
  return {
    ...pair,
    costs: {
      ...pair.costs,
      borosTakerFeeUsd: pair.costs.borosTakerFeeUsd * k,
      borosSettleFeeUsd: pair.costs.borosSettleFeeUsd * k,
      perpEntryFeesUsd: usd(pair.costs.perpEntryFeesUsd),
      perpEntrySlippageUsd: usd(pair.costs.perpEntrySlippageUsd),
      perpExitFeesUsd: usd(pair.costs.perpExitFeesUsd),
      perpExitSlippageUsd: usd(pair.costs.perpExitSlippageUsd),
      totalUsd: usd(pair.costs.totalUsd),
    },
    capital: {
      ...pair.capital,
      borosIms: pair.capital.borosIms.map((im) => ({ ...im, imUsd: usd(im.imUsd) })),
      perpShortImUsd: usd(pair.capital.perpShortImUsd),
      perpLongImUsd: usd(pair.capital.perpLongImUsd),
    },
    capitalUsd: usd(pair.capitalUsd),
    estProfitUsd: usd(pair.estProfitUsd),
  };
}

function spreadSinglesOpportunityPair(): OpportunityPair {
  const spread = makeSpreadOpportunityPair();
  const nt = OPP_NOTIONAL * (spread.secondsToMaturity / SECONDS_IN_YEAR);
  const shortExecApr = 0.083 - 0.0005;
  const longExecApr = 0.0482 + 0.0005;
  const execSpreadApr = shortExecApr - longExecApr;
  const netFixedApr = execSpreadApr - (spread.costs.totalUsd ?? 0) / nt;
  const estProfitUsd = netFixedApr * nt;
  const capital = { ...spread.capital, borosIms: [{ marketId: 51, imUsd: 8 }, { marketId: 60, imUsd: 4 }] };
  const capitalUsd = 8 + 4 + (capital.perpShortImUsd ?? 0) + (capital.perpLongImUsd ?? 0);
  return {
    ...spread,
    borosLegs: [
      makeOpportunityBorosLeg({ marketId: 51, side: 'SHORT', venue: 'HYPERLIQUID', midApr: 0.083, execApr: shortExecApr }),
      makeOpportunityBorosLeg({ marketId: 60, side: 'LONG', venue: 'GATE', midApr: 0.0482, execApr: longExecApr }),
    ],
    execSpreadApr,
    borosImpactApr: spread.grossSpreadApr - execSpreadApr,
    capital,
    capitalUsd,
    netFixedApr,
    netFixedAprOnCapital: estProfitUsd / (capitalUsd * (nt / OPP_NOTIONAL)),
    effectiveLeverage: OPP_NOTIONAL / capitalUsd,
    estProfitUsd,
  };
}

function btcSpreadOnlyOpportunityPair(): OpportunityPair {
  const pair = makeSpreadOpportunityPair({
    base: 'BTC',
    shortLeg: makeOpportunityLeg({ crossexSymbol: 'HYPERLIQUID_FUTURE_BTC_USDC', base: 'BTC' }),
    longLeg: makeOpportunityLeg({
      venue: 'GATE', crossexVenue: 'GATE', crossexSymbol: 'GATE_FUTURE_BTC_USDT', base: 'BTC',
    }),
  });
  return {
    ...pair,
    borosLegs: pair.borosLegs.map((l) => ({ ...l, marketId: 58 })),
    capital: { ...pair.capital, borosIms: pair.capital.borosIms.map((im) => ({ ...im, marketId: 58 })) },
  };
}

function spreadOpportunities(
  pairs: OpportunityPair[], group: Partial<OpportunityGroup> = {}, notionalUsd = OPP_NOTIONAL,
): OpportunitiesResult {
  return makeOpportunitiesResult({
    groups: [
      makeOpportunityGroup({
        tokenId: 2, collateral: 'ETH', collateralPriceUsd: SPREAD_BOOK_PRICE, maturity: SPREAD_OPP_MATURITY,
        secondsToMaturity: SPREAD_OPP_MATURITY - SPREAD_OPP_NOW, underlying: 'ETH',
        markets: [
          makeOpportunityMarketRow({
            marketId: 51, name: 'Hyperliquid ETH 27 Nov 2026', midApr: 0.083, markApr: 0.083, floatingApr: 0.0712,
            execShortApr: 0.0825, execLongApr: 0.0835,
          }),
          makeOpportunityMarketRow({
            marketId: 60, name: 'Gate ETHUSDT 27 Nov 2026', venue: 'GATE', crossexVenue: 'GATE',
            crossexSymbol: 'GATE_FUTURE_ETH_USDT', midApr: 0.0482, markApr: 0.0482, floatingApr: 0.0641,
            execShortApr: 0.0477, execLongApr: 0.0487,
          }),
        ],
        pairs,
        ...group,
      }),
    ],
    meta: { ...makeOpportunitiesResult().meta, asOfSec: SPREAD_OPP_NOW, notionalUsd },
  });
}

export const spreadOpportunitiesBodies = {
  spread: spreadOpportunities([makeSpreadOpportunityPair()]),
  singles: spreadOpportunities([spreadSinglesOpportunityPair()]),
  'btc-spread-only': spreadOpportunities([btcSpreadOnlyOpportunityPair()], {
    tokenId: 1, collateral: 'BTC', collateralPriceUsd: null, underlying: 'BTC', markets: [],
  }),
  whale: spreadOpportunities([makeSpreadWhaleOpportunityPair()], {}, SPREAD_WHALE_NOTIONAL),
} satisfies Record<string, OpportunitiesResult>;
