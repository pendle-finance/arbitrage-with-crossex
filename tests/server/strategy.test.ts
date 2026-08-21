/**
 * GET /api/strategy/:address — address validation, the Boros→perp join through
 * the full route, Boros-only degradation when Gate is unconfigured, and
 * upstream-failure classification. The Boros backend is stubbed through the
 * AppDeps.borosFetch seam (global fetch is never touched); Gate via nock.
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { CoreError } from '../../src/core/errors';
import { Store } from '../../src/engine/db';
import { FakeVenue, VirtualClock } from '../unit/engine-sim';
import { HOST, makeTestApp, mockGateGet } from './helpers/gate-nock';
import { raw } from '../helpers/boros-fixtures';
import { borosStub } from '../helpers/boros-stub';

const ADDR = '0xB2684Cd15b0CF17050531C51d581A9dDc365f1ef';
/** The cross marketAcc wire handle for ADDR: accountId 0, tokenId 3, marketId 0xFFFFFF. */
const CROSS_ACC = `0x${ADDR.slice(2).toLowerCase()}000003ffffff`;
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

/** Minimal raw-API bodies (the canonical 4-leg book of
 * tests/helpers/boros-fixtures.ts, in the wire shape the client normalizes). */
function borosBodies() {
  const market = (marketId: number, platformName: string, paymentPeriod: number, markApr = 0.076) => ({
    marketId,
    tokenId: 3,
    imData: { name: `${platformName} ETH 31 Jul 2026`, maturity: NOW + 15 * DAY },
    extConfig: { settleFeeRate: '1000000000000000', paymentPeriod },
    platform: { name: platformName, platformId: platformName },
    metadata: { underlyingSymbol: 'ETH' },
    data: { markApr, floatingApr: 0.075, assetMarkPrice: 1880 },
  });
  const events = [
    { marketId: 155, timestamp: NOW - 12 * DAY, fee: raw(390), pnl: raw(-390), prevPositionS: '0', postPositionS: raw(-1_000_000) },
    { marketId: 158, timestamp: NOW - 12 * DAY, fee: raw(300), pnl: raw(-300), prevPositionS: '0', postPositionS: raw(1_000_000) },
  ];
  const bodies: Record<string, unknown> = {
    // The per-position markApr the old summary carried now comes off the
    // market itself — 158's market must carry the 0.032 the old fixture put
    // on the position.
    '/apis/v1/markets': {
      results: [market(155, 'Hyperliquid', 3600), market(158, 'OKX', 28800, 0.032)],
      resumeToken: null,
    },
    '/apis/v1/accounts/market-acc-infos': {
      results: [
        {
          marketAcc: CROSS_ACC,
          netBalance: raw(20_000),
          positions: [
            { marketId: 155, signedSize: raw(-1_000_000), initialMargin: raw(5_000) },
            { marketId: 158, signedSize: raw(1_000_000), initialMargin: raw(5_000) },
          ],
        },
      ],
    },
    '/apis/v1/accounts/active-positions': {
      results: [
        { marketAcc: CROSS_ACC, marketId: 155, fixedApr: 0.08, signedSize: raw(-1_000_000), unrealisedPnl: raw(820), settlementPnl: raw(3_205), isMatured: false },
        { marketAcc: CROSS_ACC, marketId: 158, fixedApr: 0.03, signedSize: raw(1_000_000), unrealisedPnl: raw(-300), settlementPnl: raw(1_120), isMatured: false },
      ],
    },
  };
  bodies['/apis/v1/accounts/position-update-events'] = (url: URL) => ({
    results: events.filter((e) => e.marketId === Number(url.searchParams.get('marketId'))),
    resumeToken: null,
  });
  return bodies;
}

/** Raw snake_case Gate positions matching the Boros book (SHORT HL / LONG OKX).
 * Entry gap: (1883.4 − 1883.0) × 531 = $212.40 entry slippage. */
const ENTRY_SLIPPAGE = (1883.4 - 1883.0) * 531;
const gatePositions = [
  {
    symbol: 'HYPERLIQUID_FUTURE_ETH_USDC',
    position_side: 'SHORT',
    position_qty: '-531',
    position_value: '1000000',
    entry_price: '1883.0',
    upnl: '50',
    funding_fee: '3120',
    fee: '-210',
    initial_margin: '12500',
    create_time: String((NOW - 12 * DAY) * 1000),
  },
  {
    symbol: 'OKX_FUTURE_ETH_USDT',
    position_side: 'LONG',
    position_qty: '531',
    position_value: '1000000',
    entry_price: '1883.4',
    upnl: '-45',
    funding_fee: '-1940',
    fee: '-202',
    initial_margin: '12500',
    create_time: String((NOW - 12 * DAY) * 1000),
  },
];

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /api/strategy/:address', () => {
  it('rejects a malformed address with a 400 validation envelope (no upstream calls)', async () => {
    const calls: string[] = [];
    app = makeTestApp({ borosFetch: borosStub({}, calls) });
    const res = await app.inject({ method: 'GET', url: '/api/strategy/nonsense', headers: HOST });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.category).toBe('validation');
    expect(calls).toHaveLength(0);
  });

  it('joins Boros legs with Gate perps into one hedged 4-leg strategy', async () => {
    app = makeTestApp({ borosFetch: borosStub(borosBodies()) });
    mockGateGet('/positions', { body: gatePositions });
    mockGateGet('/fee', {
      body: [
        { exchange_type: 'HYPERLIQUID', future_maker_fee: '0.0002', future_taker_fee: '0.00048' },
        { exchange_type: 'OKX', future_maker_fee: '0.0002', future_taker_fee: '0.00048' },
      ],
    });

    const res = await app.inject({ method: 'GET', url: `/api/strategy/${ADDR}`, headers: HOST });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();

    expect(data.address).toBe(ADDR.toLowerCase());
    expect(data.perpSource).toBe('connected-gate-account');
    expect(data.strategies).toHaveLength(1);
    const s = data.strategies[0];
    expect(s.base).toBe('ETH');
    expect(s.hedge).toBe('hedged');
    expect(s.legs).toHaveLength(4);
    // Boros legs ride the wire with their collateral identity; perp legs carry
    // their base-coin size but no collateral.
    const borosLeg = s.legs.find((l: { kind: string }) => l.kind === 'boros');
    expect(borosLeg).toMatchObject({ collateral: 'USDT', notionalToken: 1_000_000 });
    const perpLeg = s.legs.find((l: { kind: string }) => l.kind === 'perp');
    expect(perpLeg.collateral).toBeUndefined();
    expect(perpLeg.notionalToken).toBe(531);
    expect(s.spread).toBeCloseTo(0.05, 10);
    // ONE headline money pin proves the wire→domain normalization fed the math
    // real numbers; the full derivation (capital, fee splits, APR forms) is
    // pinned by tests/unit/boros-returns.test.ts — not re-asserted here.
    // Perp nets exclude price MtM; entry slippage subtracted once at pair level:
    // (3120−210) + (−1940−202) + 3635 + 520 − 212.40 = 4,710.60.
    expect(s.realizedPnlUsd).toBeCloseTo(2_910 - 2_142 + 3_635 + 520 - ENTRY_SLIPPAGE, 6);
    expect(s.realizedApr).not.toBeNull();
    // Exit fees from the wire schedule, maker+hedge: $1M × (2 + 4.8) bps.
    expect(s.feesUsd.future.perpExitFeesUsd).toBeCloseTo(680, 6);
    expect(s.feesUsd.future.perpExitSlippageUsd).toBeCloseTo(ENTRY_SLIPPAGE, 6);
    expect(data.totals.perpExitFeesTotalUsd).toBeCloseTo(680, 6);
    expect(data.totals.perpExitSlippageTotalUsd).toBeCloseTo(ENTRY_SLIPPAGE, 6);
  });

  it('chains a venue-migrated book’s entry slippage from the seeded deal journal', async () => {
    // The HL short predates the OKX long by 10 days: its live entry (1900.0)
    // vs OKX's (1883.4) is mostly drift — the route must answer from the
    // journal instead: (1900.4−1900.0)×531 + (1883.4−1883.0)×531 = $424.80.
    const migrated = structuredClone(gatePositions);
    migrated[0].entry_price = '1900.0';
    migrated[0].create_time = String((NOW - 22 * DAY) * 1000);

    const store = new Store(':memory:');
    const legDefaults = { lot: '1', minSize: '0', minNotional: '0', tick: '0.01' };
    const pairDefaults = {
      targetQty: '531', limitPrice: null, pricePolicy: 'touch' as const, deadlineAt: null,
      makerNotBefore: 0, hedgeNotBefore: 0, pocRejects: 0, hedgeRejectStreak: 0,
      maxClip: null, clipBandBp: null, haltReason: null, mode: 'DONE' as const,
    };
    store.createPair({
      ...pairDefaults,
      id: 'original',
      a: { ...legDefaults, contract: 'HYPERLIQUID_FUTURE_ETH_USDC', side: 'SELL' },
      b: { ...legDefaults, contract: 'GATE_FUTURE_ETH_USDT', side: 'BUY' },
      reportJson: JSON.stringify({ aFilled: '531', bFilled: '531', aAvgFill: '1900.0', bAvgFill: '1900.4' }),
      createdAt: (NOW - 22 * DAY) * 1000,
    });
    store.createPair({
      ...pairDefaults,
      id: 'migration',
      a: { ...legDefaults, contract: 'GATE_FUTURE_ETH_USDT', side: 'SELL', reduceOnly: true },
      b: { ...legDefaults, contract: 'OKX_FUTURE_ETH_USDT', side: 'BUY' },
      reportJson: JSON.stringify({ aFilled: '531', bFilled: '531', aAvgFill: '1883.0', bAvgFill: '1883.4' }),
      createdAt: (NOW - 12 * DAY) * 1000,
    });

    app = makeTestApp({
      borosFetch: borosStub(borosBodies()),
      engine: { store, venue: new FakeVenue(), clock: new VirtualClock() },
    });
    mockGateGet('/positions', { body: migrated });

    const res = await app.inject({ method: 'GET', url: `/api/strategy/${ADDR}`, headers: HOST });
    expect(res.statusCode).toBe(200);
    const s = res.json().data.strategies[0];
    expect(s.feesUsd.paid.perpEntrySlippageUsd).toBeCloseTo(2 * ENTRY_SLIPPAGE, 6);
    expect(s.feesUsd.future.perpExitSlippageUsd).toBeCloseTo(2 * ENTRY_SLIPPAGE, 6);
    expect(s.warnings.join(' ')).toMatch(/summed from 2 deals in this terminal's journal/);

    // …and each of those executions arrives itemised, keyed by the journal row
    // it came from, so the Positions box can charge or drop them one by one.
    const slip = s.perpEntryCostParts.filter((p: { kind: string }) => p.kind === 'slippage');
    expect(slip.map((p: { id: string }) => p.id)).toEqual([
      'slip:deal:original',
      'slip:deal:migration',
    ]);
    expect(slip.every((p: { usd: number }) => Math.abs(p.usd - ENTRY_SLIPPAGE) < 1e-6)).toBe(true);
    // Fees are per LIVE leg (Gate's cumulative position fee) — never per deal.
    const fees = s.perpEntryCostParts.filter((p: { kind: string }) => p.kind === 'fees');
    expect(fees).toHaveLength(2);
    expect(fees.every((p: { atSec: number | null }) => p.atSec === null)).toBe(true);
    // The invariant the client's add-back depends on.
    expect(
      s.perpEntryCostParts.reduce((a: number, p: { usd: number }) => a + p.usd, 0),
    ).toBeCloseTo(s.feesUsd.paid.perpTradingUsd + s.feesUsd.paid.perpEntrySlippageUsd, 6);
  });

  it('reports null exit fees when the fee schedule is unavailable (never a guess)', async () => {
    app = makeTestApp({ borosFetch: borosStub(borosBodies()) });
    mockGateGet('/positions', { body: gatePositions }); // no /fee mock → fetch fails
    const res = await app.inject({ method: 'GET', url: `/api/strategy/${ADDR}`, headers: HOST });
    expect(res.json().data.strategies[0].feesUsd.future.perpExitFeesUsd).toBeNull();
    expect(res.json().data.totals.perpExitFeesTotalUsd).toBeNull();
  });

  it('degrades to a Boros-only 200 when Gate is not configured (never a 503)', async () => {
    app = makeTestApp({
      borosFetch: borosStub(borosBodies()),
      getClients: () => {
        throw new CoreError('no credentials', 'not-configured');
      },
    });
    const res = await app.inject({ method: 'GET', url: `/api/strategy/${ADDR}`, headers: HOST });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.perpSource).toBeNull();
    expect(data.strategies[0].hedge).toBe('partial');
    expect(data.strategies[0].legs).toHaveLength(2);
    expect(data.warnings.join(' ')).toMatch(/Gate credentials are not configured/);
  });

  it('returns 200 with empty strategies for an address with no Boros positions', async () => {
    const bodies = borosBodies();
    bodies['/apis/v1/accounts/active-positions'] = { results: [] };
    app = makeTestApp({ borosFetch: borosStub(bodies) });
    mockGateGet('/positions', { body: [] });

    const res = await app.inject({ method: 'GET', url: `/api/strategy/${ADDR}`, headers: HOST });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.strategies).toHaveLength(0);
  });

  it('asserts the settlement-fee accrual and to-maturity projection through the wire (18-dec settleFeeRate)', async () => {
    app = makeTestApp({ borosFetch: borosStub(borosBodies()) });
    mockGateGet('/positions', { body: gatePositions });
    const res = await app.inject({ method: 'GET', url: `/api/strategy/${ADDR}`, headers: HOST });
    const s = res.json().data.strategies[0];

    const YEAR = 365 * DAY;
    // settleFeeRate '1000000000000000' → 0.001 APR; opened 12d ago, 15d left.
    const expectedSettleAccrued = 2 * 1_000_000 * 0.001 * ((12 * DAY) / YEAR);
    expect(s.feesUsd.paid.borosSettlementUsd).toBeCloseTo(expectedSettleAccrued, 1);
    const remainingSettle = 2 * 1_000_000 * 0.001 * ((15 * DAY) / YEAR);
    expect(s.feesUsd.future.borosSettlementUsd).toBeCloseTo(remainingSettle, 1);
    // Full-life spread return from the Boros open (12d ago) to maturity (15d ahead).
    const spreadReturn = 0.05 * 1_000_000 * ((27 * DAY) / YEAR);
    expect(s.spreadReturnUsd).toBeCloseTo(spreadReturn, 0);
    expect(s.clockStartSec).toBe(NOW - 12 * DAY);
    // Projection = spread return − paid costs − future settle fees (exit parts excluded).
    expect(s.expectedPnlToMaturityUsd).toBeCloseTo(
      spreadReturn - s.feesUsd.paid.totalUsd - remainingSettle,
      0,
    );
    expect(s.feesUsd.paid.perpEntrySlippageUsd).toBeCloseTo(ENTRY_SLIPPAGE, 1);
  });

  it('serves repeat requests from the per-address cache and busts it with ?fresh=1', async () => {
    const calls: string[] = [];
    app = makeTestApp({ borosFetch: borosStub(borosBodies(), calls) });
    mockGateGet('/positions', { body: gatePositions, times: 3 });

    await app.inject({ method: 'GET', url: `/api/strategy/${ADDR}`, headers: HOST });
    // markets + by-root + active-positions + one event stream per open market.
    const afterFirst = calls.length;
    expect(afterFirst).toBe(5);

    // Second request within TTL: everything served from cache.
    await app.inject({ method: 'GET', url: `/api/strategy/${ADDR}`, headers: HOST });
    expect(calls.length).toBe(afterFirst);

    // A DIFFERENT address must not reuse this address's collaterals/txns.
    const other = '0x' + 'cd'.repeat(20);
    await app.inject({ method: 'GET', url: `/api/strategy/${other}`, headers: HOST });
    const otherCalls = calls.slice(afterFirst);
    expect(otherCalls.some((c) => c.includes(`root=${other}`))).toBe(true);
    expect(otherCalls.some((c) => c.startsWith('/apis/v1/markets?'))).toBe(false); // markets are shared

    // fresh=1 bypasses the TTL for this address.
    const beforeFresh = calls.length;
    await app.inject({ method: 'GET', url: `/api/strategy/${ADDR}?fresh=1`, headers: HOST });
    expect(calls.length).toBeGreaterThan(beforeFresh);
  });

  it('honors ?since= as a custom APR-clock start and validates it', async () => {
    app = makeTestApp({ borosFetch: borosStub(borosBodies()) });
    mockGateGet('/positions', { body: gatePositions, times: 2 });

    const since = NOW - 6 * DAY;
    const ok = await app.inject({
      method: 'GET',
      url: `/api/strategy/${ADDR}?since=${since}`,
      headers: HOST,
    });
    const s = ok.json().data.strategies[0];
    expect(s.clockBasis).toBe('custom');
    expect(s.elapsedSeconds).toBeGreaterThanOrEqual(6 * DAY);
    expect(s.elapsedSeconds).toBeLessThan(6 * DAY + 60);

    const bad = await app.inject({ method: 'GET', url: `/api/strategy/${ADDR}?since=garbage`, headers: HOST });
    expect(bad.statusCode).toBe(400);
    const future = await app.inject({
      method: 'GET',
      url: `/api/strategy/${ADDR}?since=${NOW + DAY}`,
      headers: HOST,
    });
    expect(future.statusCode).toBe(400);
  });

  it('labels a TRANSIENT Gate failure honestly (never "credentials not configured")', async () => {
    app = makeTestApp({ borosFetch: borosStub(borosBodies()) });
    mockGateGet('/positions', { status: 429, body: { label: 'TOO_MANY_REQUESTS', message: 'slow down' } });
    const res = await app.inject({ method: 'GET', url: `/api/strategy/${ADDR}`, headers: HOST });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.perpSource).toBeNull();
    expect(data.warnings.join(' ')).toMatch(/Couldn't load Gate positions right now \(rate-limited\)/);
    expect(data.warnings.join(' ')).not.toMatch(/credentials are not configured/);
  });

  it('maps a Boros upstream failure to a 502 network envelope', async () => {
    app = makeTestApp({
      borosFetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    });
    const res = await app.inject({ method: 'GET', url: `/api/strategy/${ADDR}`, headers: HOST });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.category).toBe('network');
  });

  it('lowercases the address for caching and upstream calls', async () => {
    const calls: string[] = [];
    app = makeTestApp({ borosFetch: borosStub(borosBodies(), calls) });
    mockGateGet('/positions', { body: [] });
    await app.inject({ method: 'GET', url: `/api/strategy/${ADDR}`, headers: HOST });
    const collateralCall = calls.find((c) => c.startsWith('/apis/v1/accounts/active-positions'));
    expect(collateralCall).toContain(`root=${ADDR.toLowerCase()}`);
  });
});
