import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  BorosCancelAndCloseResult,
  BorosLegFill,
  BorosPairContext,
  BorosPairExecuteResponse,
  BorosPairMarketRow,
  BorosPairSimulateResponse,
} from '../../web/src/api/types';
import { makeBorosApiOrderClient, USD_TOKEN_ID } from '../../src/core/boros/borosApi';
import {
  BOROS_TOKEN_SYMBOLS,
  fetchBorosCollaterals,
  fetchBorosMarkets,
  norm18,
  resolveBorosFetch,
  type BorosCollateralZone,
  type BorosMarket,
} from '../../src/core/boros/client';
import type { BorosOrderClient } from '../../src/core/boros/orders';
import { MIN_ORDER_VALUE_USD, type BorosLegDirection, type PairIntent } from '../../src/core/boros/pair';
import { buildApp } from '../../src/server/app';
import { readBorosAgentConfig, type BorosAgentConfig } from '../../src/server/borosAgent';
import { TTL, TtlCache } from '../../src/server/cache';
import { sleep } from '../../src/server/routes/rebalance';
import { budget, TAG } from './env';
import { assertAck, assertCredentials, assertLiveTestsEnabled, assertNotionalCeiling } from './guards';

const TOKEN = 'live-boros-close-token';
const HEADERS = { host: 'localhost', 'x-arb-token': TOKEN };
const OPEN_NOTIONAL_USD = MIN_ORDER_VALUE_USD + 1;
const MARGIN_SHARE = 0.1;
const READ_BACK_MS = 120_000;
const READ_BACK_POLL_MS = 5_000;
const PATH_TIMEOUT_MS = 300_000;
const CLOSE_RUNNING = 'A close on this market is already running.';

type Leg = { marketId: number; direction: BorosLegDirection };

interface Pick {
  a: BorosPairMarketRow;
  b: BorosPairMarketRow;
  size: number;
  priceUsd: number;
}

interface Cost {
  label: string;
  feeUsd: number;
  cashUsd: number;
  gasUsd: number | null;
}

const opposite = (direction: BorosLegDirection): BorosLegDirection => (direction === 'long' ? 'short' : 'long');

const dataOf = <T>(res: LightMyRequestResponse): T => (res.json() as { data: T }).data;

const errorOf = (res: LightMyRequestResponse): string =>
  (res.json() as { error?: { message?: string } }).error?.message ?? '';

const positionOf = (zones: BorosCollateralZone[], marketId: number): number => {
  for (const zone of zones) {
    for (const group of [...(zone.cross ? [zone.cross] : []), ...zone.isolated]) {
      const row = group.marketPositions.find((p) => p.marketId === marketId);
      if (row) return norm18(row.notionalSize);
    }
  }
  return 0;
};

const cashOf = (zones: BorosCollateralZone[], tokenId: number): number =>
  norm18(zones.find((z) => z.tokenId === tokenId)?.cross?.netBalance ?? '0');

const busyMarkets = (zones: BorosCollateralZone[]): Set<number> => {
  const busy = new Set<number>();
  for (const zone of zones) {
    for (const group of [...(zone.cross ? [zone.cross] : []), ...zone.isolated]) {
      for (const p of group.marketPositions) {
        if (!group.isCross || norm18(p.notionalSize) !== 0 || p.hasRestingOrders !== false) busy.add(p.marketId);
      }
    }
  }
  return busy;
};

describe.skipIf(process.env.BOROS_CLOSE !== '1')('live Boros closes: one market and a pair', () => {
  const fetchImpl = resolveBorosFetch();
  const opened = new Set<number>();
  const costs: Cost[] = [];
  let app: FastifyInstance | null = null;
  let agent: BorosAgentConfig | null = null;
  let orders: BorosOrderClient | undefined;
  let markets: BorosMarket[] = [];
  let pick: Pick | null = null;
  let skipReason = '';
  let slippageApr = 0;
  let seq = 0;

  const nextId = (): string => `${TAG}-${++seq}`;

  const readZones = (): Promise<BorosCollateralZone[]> =>
    fetchBorosCollaterals(fetchImpl, agent!.root, markets, agent!.accountId);

  const readGas = async (): Promise<number | null> =>
    orders?.getGasBalance ? orders.getGasBalance().catch(() => null) : null;

  const waitFor = async (
    check: (zones: BorosCollateralZone[]) => boolean,
    label: string,
  ): Promise<BorosCollateralZone[]> => {
    const deadline = Date.now() + READ_BACK_MS;
    for (;;) {
      const zones = await readZones();
      if (check(zones)) return zones;
      if (Date.now() > deadline) throw new Error(`waited ${READ_BACK_MS / 1000} s for ${label}`);
      await sleep(READ_BACK_POLL_MS);
    }
  };

  const post = (url: string, payload: object): Promise<LightMyRequestResponse> =>
    app!.inject({ method: 'POST', url, headers: HEADERS, payload });

  const pairRequest = (legA: Leg, legB: Leg, size: number, intent: PairIntent, onlyLeg?: 'A') => ({
    address: agent!.root,
    legA: { ...legA, slippageApr },
    legB: { ...legB, slippageApr },
    size,
    intent,
    opposingAcknowledged: intent === 'close',
    clientOrderIdA: nextId(),
    clientOrderIdB: nextId(),
    ...(onlyLeg ? { onlyLeg } : {}),
  });

  const record = (
    label: string,
    fills: Array<BorosLegFill | null>,
    cash: [number, number],
    gas: [number | null, number | null],
  ): void => {
    const { priceUsd } = pick!;
    const feeUsd = fills.reduce((total, fill) => total + (fill?.feeSize ?? 0), 0) * priceUsd;
    const cashUsd = (cash[1] - cash[0]) * priceUsd;
    const gasUsd = gas[0] !== null && gas[1] !== null ? gas[1] - gas[0] : null;
    costs.push({ label, feeUsd, cashUsd, gasUsd });
    console.log(
      `  ▸ ${label}: fees $${feeUsd.toFixed(4)}, cross cash change $${cashUsd.toFixed(4)}, gas change ${gasUsd === null ? 'unread' : `$${gasUsd.toFixed(4)}`}`,
    );
  };

  const choosePair = async (): Promise<Pick | null> => {
    const res = await app!.inject({
      method: 'GET',
      url: `/api/boros/pair/context?address=${agent!.root}&fresh=1`,
      headers: HEADERS,
    });
    expect(res.statusCode, res.body).toBe(200);
    const context = dataOf<BorosPairContext>(res);
    slippageApr = context.defaultSlippageApr;
    const busy = busyMarkets(await readZones());
    const free = context.markets.filter(
      (m) =>
        !m.closeOnly &&
        !m.isolatedOnly &&
        !m.onIsolatedMargin &&
        !m.isolatedHasPositionOrOrders &&
        m.currentSize === 0 &&
        !busy.has(m.marketId) &&
        (m.collateralPriceUsd ?? 0) > 0,
    );
    const groups = new Map<string, BorosPairMarketRow[]>();
    for (const m of free) {
      const key = `${m.tokenId}:${m.maturity}:${m.base.toLowerCase()}`;
      groups.set(key, [...(groups.get(key) ?? []), m]);
    }
    const isUsdt = (tokenId: number) => Number(BOROS_TOKEN_SYMBOLS[tokenId] === 'USDT');
    const pairs = [...groups.values()]
      .filter((g) => g.length >= 2)
      .sort((x, y) => isUsdt(y[0].tokenId) - isUsdt(x[0].tokenId));
    console.log(`  ▸ ${free.length} free markets, ${pairs.length} pairable groups (${busy.size} markets hold a position or an order)`);

    for (const [a, b] of pairs) {
      const priceUsd = a.collateralPriceUsd!;
      const candidate: Pick = { a, b, size: OPEN_NOTIONAL_USD / priceUsd, priceUsd };
      const sim = await post(
        '/api/boros/pair/simulate',
        pairRequest({ marketId: a.marketId, direction: 'short' }, { marketId: b.marketId, direction: 'long' }, candidate.size, 'open'),
      );
      if (sim.statusCode !== 200) {
        console.log(`  ▸ ${a.name} + ${b.name}: simulate HTTP ${sim.statusCode} ${sim.body}`);
        continue;
      }
      const { simulation, gate, gasBalanceUsd } = dataOf<BorosPairSimulateResponse>(sim);
      const margin = (simulation.legA.marginRequired ?? Infinity) + (simulation.legB.marginRequired ?? Infinity);
      const available = context.crossByToken.find((c) => c.tokenId === a.tokenId)?.available ?? 0;
      console.log(
        `  ▸ ${a.name} + ${b.name}: margin ${margin} of ${available} free ${a.collateral}, gas $${gasBalanceUsd}, blockers ${gate.blockers.map((x) => x.code).join(',') || 'none'}`,
      );
      if (gate.blockers.length === 0 && margin <= MARGIN_SHARE * available) return candidate;
    }
    return null;
  };

  beforeAll(async () => {
    assertLiveTestsEnabled();
    assertAck();
    assertNotionalCeiling();
    const clients = assertCredentials();
    agent = readBorosAgentConfig();
    if (!agent) {
      skipReason = 'No Boros agent in .env: BOROS_ROOT_ADDRESS and BOROS_AGENT_PRIVATE_KEY are unset.';
      return;
    }
    if (agent.accountId !== 0) {
      skipReason = `BOROS_ACCOUNT_ID is ${agent.accountId}, and the close routes read account 0.`;
      return;
    }
    const cache = new TtlCache();
    const loadMarkets = async (): Promise<BorosMarket[]> =>
      (await cache.get('boros:markets', TTL.boros, () => fetchBorosMarkets(fetchImpl))).value;
    orders = makeBorosApiOrderClient({
      ...agent,
      tokenIdForMarket: async (marketId) => (await loadMarkets()).find((m) => m.marketId === marketId)?.tokenId,
      usdMarketId: async () => (await loadMarkets()).find((m) => m.tokenId === USD_TOKEN_ID)?.marketId,
    });
    app = buildApp({
      getClients: () => clients,
      cache,
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'boros-close-live-')),
      authToken: TOKEN,
      getBorosOrders: () => orders,
    });
    markets = await fetchBorosMarkets(fetchImpl);
    pick = await choosePair();
    if (!pick) {
      skipReason = `No pair of Boros markets with no position, no open order, and margin under ${MARGIN_SHARE * 100}% of free margin.`;
      return;
    }
    console.log(
      `  ▸ picked ${pick.a.name} (#${pick.a.marketId}) and ${pick.b.name} (#${pick.b.marketId}), size ${pick.size} ${pick.a.collateral} ≈ $${(pick.size * pick.priceUsd).toFixed(2)} a leg`,
    );
  }, 180_000);

  const cleanUp = async (): Promise<void> => {
    if (!app || !pick || opened.size === 0) return;
    const { a, b } = pick;
    const zones = await readZones();
    for (const marketId of opened) {
      const held = positionOf(zones, marketId);
      if (held === 0) continue;
      const direction: BorosLegDirection = held > 0 ? 'short' : 'long';
      const partner = marketId === a.marketId ? b.marketId : a.marketId;
      budget.beforeOrder(0, `boros cleanup close #${marketId}`);
      const res = await post(
        '/api/boros/pair/execute',
        pairRequest({ marketId, direction }, { marketId: partner, direction: opposite(direction) }, Math.abs(held), 'close', 'A'),
      );
      console.log(`  ▸ cleanup close on #${marketId} (held ${held}): HTTP ${res.statusCode} ${res.body}`);
    }
    try {
      await waitFor((z) => [...opened].every((id) => positionOf(z, id) === 0), 'cleanup to read flat');
    } catch {
      const left = await readZones();
      for (const id of opened) {
        const held = positionOf(left, id);
        if (held !== 0) console.error(`  ▸ LEFT OPEN on Boros market #${id}: ${held} ${a.collateral}. Close it on Boros.`);
      }
    }
  };

  afterAll(async () => {
    try {
      await cleanUp();
    } finally {
      const fees = costs.reduce((total, c) => total + c.feeUsd, 0);
      const cash = costs.reduce((total, c) => total + c.cashUsd, 0);
      const gas = costs.reduce((total, c) => total + (c.gasUsd ?? 0), 0);
      console.log(`  ▸ Boros close suite total: fees $${fees.toFixed(4)}, cross cash change $${cash.toFixed(4)}, gas change $${gas.toFixed(4)}`);
      await app?.close();
    }
  }, PATH_TIMEOUT_MS);

  it('closes one market, and refuses a second close on it while the first runs', async (ctx) => {
    if (!app || !pick) return ctx.skip(skipReason);
    const { a, b, size, priceUsd } = pick;
    const cashBefore = cashOf(await readZones(), a.tokenId);
    const gasBefore = await readGas();

    console.log(`  ▸ single: short ${size} ${a.collateral} ≈ $${(size * priceUsd).toFixed(2)} on ${a.name} (#${a.marketId})`);
    budget.beforeOrder(size * priceUsd, 'boros single open');
    opened.add(a.marketId);
    const open = await post(
      '/api/boros/pair/execute',
      pairRequest({ marketId: a.marketId, direction: 'short' }, { marketId: b.marketId, direction: 'long' }, size, 'open', 'A'),
    );
    expect(open.statusCode, open.body).toBe(200);
    const { result } = dataOf<BorosPairExecuteResponse>(open);
    expect(result.legA.failure, result.legA.failure?.message).toBeNull();
    expect(result.legA.filledSize).toBeGreaterThan(0);
    await waitFor((zones) => positionOf(zones, a.marketId) < 0, `${a.name} to read short`);

    budget.beforeOrder(0, 'boros cancel-and-close');
    const close = () =>
      post(`/api/boros/pair/market/${a.marketId}/cancel-and-close`, { clientOrderId: nextId(), address: agent!.root });
    const replies = await Promise.all([close(), close()]);
    for (const reply of replies) console.log(`  ▸ cancel-and-close #${a.marketId}: HTTP ${reply.statusCode} ${reply.body}`);
    const refused = replies.filter((r) => r.statusCode === 409);
    const done = replies.filter((r) => r.statusCode === 200);
    expect(refused.map(errorOf)).toEqual([CLOSE_RUNNING]);
    expect(done).toHaveLength(1);
    const closed = dataOf<BorosCancelAndCloseResult>(done[0]);
    expect(closed.closed, done[0].body).toBe(true);
    expect(closed.fill?.shortfallSize).toBe(0);

    const after = await waitFor((zones) => positionOf(zones, a.marketId) === 0, `${a.name} to read flat`);
    record('single close', [result.legA, closed.fill], [cashBefore, cashOf(after, a.tokenId)], [gasBefore, await readGas()]);
  }, PATH_TIMEOUT_MS);

  it('closes a Boros pair with intent close and reads both legs flat', async (ctx) => {
    if (!app || !pick) return ctx.skip(skipReason);
    const { a, b, size, priceUsd } = pick;
    const cashBefore = cashOf(await readZones(), a.tokenId);
    const gasBefore = await readGas();

    console.log(
      `  ▸ pair: short ${size} ${a.collateral} on ${a.name} (#${a.marketId}), long ${size} on ${b.name} (#${b.marketId}), ≈ $${(2 * size * priceUsd).toFixed(2)} in all`,
    );
    budget.beforeOrder(2 * size * priceUsd, 'boros pair open');
    opened.add(a.marketId);
    opened.add(b.marketId);
    const open = await post(
      '/api/boros/pair/execute',
      pairRequest({ marketId: a.marketId, direction: 'short' }, { marketId: b.marketId, direction: 'long' }, size, 'open'),
    );
    expect(open.statusCode, open.body).toBe(200);
    const opening = dataOf<BorosPairExecuteResponse>(open).result;
    expect(opening.filledNothing, open.body).toBe(false);
    expect(opening.partial, open.body).toBe(false);

    const held = await waitFor(
      (zones) => positionOf(zones, a.marketId) < 0 && positionOf(zones, b.marketId) > 0,
      'both legs to read open',
    );
    const closeSize = Math.max(Math.abs(positionOf(held, a.marketId)), Math.abs(positionOf(held, b.marketId)));

    budget.beforeOrder(0, 'boros pair close');
    const shut = await post(
      '/api/boros/pair/execute',
      pairRequest({ marketId: a.marketId, direction: 'long' }, { marketId: b.marketId, direction: 'short' }, closeSize, 'close'),
    );
    console.log(`  ▸ pair close: HTTP ${shut.statusCode} ${shut.body}`);
    expect(shut.statusCode, shut.body).toBe(200);
    const closing = dataOf<BorosPairExecuteResponse>(shut).result;
    for (const leg of [closing.legA, closing.legB]) {
      expect(leg.failure, leg.failure?.message).toBeNull();
      expect(leg.shortfallSize).toBe(0);
    }

    const after = await waitFor(
      (zones) => positionOf(zones, a.marketId) === 0 && positionOf(zones, b.marketId) === 0,
      'both legs to read flat',
    );
    record(
      'pair close',
      [opening.legA, opening.legB, closing.legA, closing.legB],
      [cashBefore, cashOf(after, a.tokenId)],
      [gasBefore, await readGas()],
    );
  }, PATH_TIMEOUT_MS);
});
