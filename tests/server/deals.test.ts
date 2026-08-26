/**
 * /api/deals — the app's only execution surface. Route-level behavior: creation
 * validation + idempotency + leverage phase, views, commands, alerts. Engine
 * behavior itself is covered by tests/unit/v2-*.ts; here the loop is DRIVEN
 * MANUALLY (tickPair) against the same FakeVenue the unit sim uses, proving the
 * route → store → loop wiring end to end without timers.
 */
import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterEach, describe, expect, it } from 'vitest';
import { tickPair, type LoopDeps } from '../../src/engine/loop';
import { Store } from '../../src/engine/db';
import { A_CONTRACT, B_CONTRACT, FakeVenue, VirtualClock } from '../unit/engine-sim';
import { gate, HOST, makeTestApp, mockGateGet } from './helpers/gate-nock';

let app: FastifyInstance;

afterEach(async () => {
  await app?.close();
  nock.cleanAll();
});

/** Rule fixture rows for the sim contracts (raw snake_case, as Gate sends). */
function simRules(): unknown[] {
  const row = (symbol: string) => ({
    symbol,
    state: 'live',
    business_type: 'FUTURE',
    lot_size: '0.001',
    min_size: '0',
    min_notional: '0',
    tick_size: '0.01',
    max_market_size: '10000',
    max_limit_size: '10000',
  });
  return [row(A_CONTRACT), row(B_CONTRACT)];
}

function mkApp(): { app: FastifyInstance; store: Store; venue: FakeVenue; clock: VirtualClock; loop: LoopDeps } {
  const store = new Store(':memory:');
  const venue = new FakeVenue();
  const clock = new VirtualClock();
  const a = makeTestApp({ engine: { store, venue, clock } });
  return { app: a, store, venue, clock, loop: { store, venue, clock } };
}

const makerPayload = (over?: Record<string, unknown>) => ({
  id: 'deal-000001',
  a: { symbol: A_CONTRACT, side: 'BUY' },
  b: { symbol: B_CONTRACT, side: 'SELL' },
  qty: '0.152',
  execution: 'maker',
  price: '2500',
  pricePolicy: 'fixed',
  timeoutSec: 300,
  ...over,
});

describe('POST /api/deals', () => {
  it('creates a maker pair deal (202), and the driven loop opens + hedges it to DONE', async () => {
    const w = mkApp();
    app = w.app;
    mockGateGet('/rule/symbols', { body: simRules() });
    mockGateGet('/accounts', { fixture: 'account.json' });

    const res = await app.inject({ method: 'POST', url: '/api/deals', headers: HOST, payload: makerPayload() });
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json().data).toEqual({ id: 'deal-000001' });

    const pair = w.store.getPair('deal-000001')!;
    expect(pair.mode).toBe('OPENING');
    expect(pair.deadlineAt).not.toBeNull(); // maker PAIRS always bound unhedged time
    expect(pair.hedgeBandBp).toBeNull(); // legacy/null state resolves to the 50bp engine default

    // Drive the engine: place maker → venue fills → hedge → DONE.
    await tickPair(w.loop, pair.id);
    const maker = w.venue.liveOrder(A_CONTRACT)!;
    expect(maker.tif).toBe('poc');
    w.venue.fill(maker.clientText, '0.152');
    for (let i = 0; i < 5; i++) {
      await tickPair(w.loop, pair.id);
      w.clock.advance(1000);
    }
    const hedge = [...w.venue.orders.values()].find((o) => o.contract === B_CONTRACT)!;
    expect(hedge.price).toBe('2487.5'); // default 50bp guard reached the wire
    const got = await app.inject({ method: 'GET', url: '/api/deals/deal-000001', headers: HOST });
    const view = got.json().data;
    expect(view.pair.mode).toBe('DONE');
    expect(view.projection.aFilled).toBe('0.152');
    expect(view.projection.bFilled).toBe('0.152');
  });

  it('is idempotent on the deal id (duplicate → 202, nothing new created)', async () => {
    const w = mkApp();
    app = w.app;
    mockGateGet('/rule/symbols', { body: simRules() });
    mockGateGet('/accounts', { fixture: 'account.json' });
    await app.inject({ method: 'POST', url: '/api/deals', headers: HOST, payload: makerPayload() });
    const dup = await app.inject({ method: 'POST', url: '/api/deals', headers: HOST, payload: makerPayload() });
    expect(dup.statusCode).toBe(202);
    expect(dup.json().data).toEqual({ id: 'deal-000001', duplicate: true });
    expect(w.store.listPairs()).toHaveLength(1);
  });

  it('rejects a same-contract pair, a bad qty, and a maker without a price (400, nothing created)', async () => {
    const w = mkApp();
    app = w.app;
    const bads = [
      makerPayload({ b: { symbol: A_CONTRACT, side: 'SELL' } }), // same contract
      makerPayload({ qty: '0.0005' }), // not a lot multiple
      makerPayload({ price: undefined }), // maker without price
      makerPayload({ hedgeBandPct: 0 }),
      makerPayload({ hedgeBandPct: 10.01 }),
    ];
    for (const payload of bads) {
      mockGateGet('/rule/symbols', { body: simRules() });
      const res = await app.inject({ method: 'POST', url: '/api/deals', headers: HOST, payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(w.store.listPairs()).toHaveLength(0);
  });

  // The delta-neutral guard was short-circuited whenever leg A was reduce-only,
  // which also exempted the MIXED shape: A closes a long while B opens a fresh
  // short the same size. Net delta swings 2x instead of to zero, and the deal
  // still finishes DONE reporting unhedged 0 (the fold compares quantities, not
  // directions). create.ts is the only gate before the loop, so it must hold.
  it('rejects a same-side pair where only leg A is reduce-only (would double exposure)', async () => {
    const w = mkApp();
    app = w.app;
    mockGateGet('/rule/symbols', { body: simRules() });
    const res = await app.inject({
      method: 'POST',
      url: '/api/deals',
      headers: HOST,
      payload: makerPayload({
        a: { symbol: A_CONTRACT, side: 'SELL', reduceOnly: true },
        b: { symbol: B_CONTRACT, side: 'SELL' }, // opens NEW short exposure
      }),
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.message).toMatch(/opposite sides/);
    expect(w.store.listPairs()).toHaveLength(0);
  });

  // Leg B's minimums were never checked, and the failure is SILENT rather than
  // loud: sizeFor returns 0 for every hedge, so no B order is ever created, no
  // reject is ever recorded, hedgeRejectStreak stays 0, HALTED is unreachable —
  // leg A acquires the full target and the deal finishes DONE while the user
  // holds 100% naked directional exposure. A 400 here is the only honest answer.
  it('rejects a deal whose HEDGE leg is below its own venue minimums (400, nothing created)', async () => {
    const w = mkApp();
    app = w.app;
    const rulesWithB = (over: Record<string, unknown>) =>
      (simRules() as Array<Record<string, unknown>>).map((r) =>
        r.symbol === B_CONTRACT ? { ...r, ...over } : r,
      );
    const cases = [
      { over: { min_size: '1' }, why: 'B min size above qty 0.152' },
      { over: { min_notional: '500' }, why: 'B min notional above 0.152 @ 2500 = 380' },
    ];
    for (const c of cases) {
      mockGateGet('/rule/symbols', { body: rulesWithB(c.over) });
      const res = await app.inject({
        method: 'POST',
        url: '/api/deals',
        headers: HOST,
        payload: makerPayload(),
      });
      expect(res.statusCode, c.why).toBe(400);
      expect(res.json().error.message, c.why).toMatch(/hedge leg could never be submitted/);
    }
    expect(w.store.listPairs()).toHaveLength(0);
  });

  // The hedge is submitted as ONE order for the whole unhedged amount and is
  // never split: normal catches are LIMIT, emergency flatten is MARKET. A deal
  // above either venue cap is unhedgeable by construction. actions.ts blocks
  // this at preview, but resolveDeal is the gate for direct API calls.
  it('rejects a deal that exceeds a venue max order size (400, nothing created)', async () => {
    const w = mkApp();
    app = w.app;
    const withCaps = (over: Record<string, unknown>, symbol: string) =>
      (simRules() as Array<Record<string, unknown>>).map((r) =>
        r.symbol === symbol ? { ...r, ...over } : r,
      );
    const cases = [
      { over: { max_market_size: '0.1' }, symbol: B_CONTRACT, why: 'hedge leg market cap' },
      { over: { max_limit_size: '0.1' }, symbol: B_CONTRACT, why: 'hedge leg limit cap' },
      { over: { max_market_size: '0.1' }, symbol: A_CONTRACT, why: 'maker leg market cap (convert path)' },
      { over: { max_limit_size: '0.1' }, symbol: A_CONTRACT, why: 'maker leg limit cap' },
    ];
    for (const c of cases) {
      mockGateGet('/rule/symbols', { body: withCaps(c.over, c.symbol) });
      const res = await app.inject({
        method: 'POST',
        url: '/api/deals',
        headers: HOST,
        payload: makerPayload(), // qty 0.152 > cap 0.1
      });
      expect(res.statusCode, c.why).toBe(400);
      expect(res.json().error.message, c.why).toMatch(/exceeds .* max (MARKET|LIMIT) order size/);
    }
    expect(w.store.listPairs()).toHaveLength(0);
  });

  it('applies the leverage phase BEFORE creating; a leverage failure aborts with nothing created', async () => {
    const w = mkApp();
    app = w.app;
    mockGateGet('/rule/symbols', { body: simRules() });
    mockGateGet('/accounts', { fixture: 'account.json' });
    mockGateGet('/rule/risk_limits', { body: [{ symbol: A_CONTRACT, tiers: [{ leverage_max: '50' }] }] });
    gate().get(/positions\/leverage/).reply(200, { [A_CONTRACT]: '10' }); // previous value
    gate().post('/api/v4/crossex/positions/leverage').reply(400, { label: 'RISK_LIMIT', message: 'too high' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/deals',
      headers: HOST,
      payload: makerPayload({ leverage: { a: 50 } }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/leverage set failed/);
    expect(w.store.listPairs()).toHaveLength(0);
  });

  // These arrive as raw JSON and were applied with no checks at all, unlike the
  // sibling PUT /leverage/:symbol which validates type, finiteness and bounds.
  it('rejects an out-of-range or non-numeric leverage before touching the venue', async () => {
    const w = mkApp();
    app = w.app;
    for (const lev of [999, '50']) {
      mockGateGet('/rule/symbols', { body: simRules() });
      mockGateGet('/accounts', { fixture: 'account.json' });
      mockGateGet('/rule/risk_limits', { body: [{ symbol: A_CONTRACT, tiers: [{ leverage_max: '20' }] }] });
      const res = await app.inject({
        method: 'POST',
        url: '/api/deals',
        headers: HOST,
        payload: makerPayload({ leverage: { a: lev } }),
      });
      expect(res.statusCode, String(lev)).toBe(400);
      // The message must come from VALIDATION, not from a failed wire call —
      // the old code sent whatever it was given and wrapped the venue's refusal
      // as "leverage set failed", which is also a 400 and hides the real cause.
      expect(res.json().error.message, String(lev)).toMatch(/must be (a number|between 1 and 20x)/);
      expect(res.json().error.message, String(lev)).not.toMatch(/leverage set failed/);
      expect(w.store.listPairs()).toHaveLength(0);
    }
  });

  // Leg A's leverage used to stay changed after leg B's call failed and the
  // request returned "nothing was created" — a user's existing position had its
  // liquidation price moved for a deal that never existed.
  it('restores leg A leverage when leg B fails', async () => {
    const w = mkApp();
    app = w.app;
    mockGateGet('/rule/symbols', { body: simRules() });
    mockGateGet('/accounts', { fixture: 'account.json' });
    mockGateGet('/rule/risk_limits', {
      body: [
        { symbol: A_CONTRACT, tiers: [{ leverage_max: '50' }] },
        { symbol: B_CONTRACT, tiers: [{ leverage_max: '50' }] },
      ],
      times: 2,
    });
    gate().get(/positions\/leverage/).reply(200, { [A_CONTRACT]: '5' }); // A's previous value
    const sets: unknown[] = [];
    gate()
      .post('/api/v4/crossex/positions/leverage')
      .times(3)
      .reply(function (_uri, reqBody) {
        sets.push(reqBody);
        // 1st = A→20 (ok), 2nd = B→20 (fails), 3rd = the A rollback (ok)
        return sets.length === 2 ? [400, { label: 'RISK_LIMIT', message: 'too high' }] : [200, {}];
      });

    const res = await app.inject({
      method: 'POST',
      url: '/api/deals',
      headers: HOST,
      payload: makerPayload({ leverage: { a: 20, b: 20 } }),
    });

    expect(res.statusCode).toBe(400);
    expect(w.store.listPairs()).toHaveLength(0);
    expect(sets).toHaveLength(3); // the third call is the rollback
    expect(sets[2]).toMatchObject({ symbol: A_CONTRACT, leverage: '5' }); // restored
  });

  it('creates a reduce-only close deal validated against the live position', async () => {
    const w = mkApp();
    app = w.app;
    mockGateGet('/rule/symbols', { body: simRules(), times: 2 });
    mockGateGet('/positions', {
      body: [{ symbol: A_CONTRACT, position_qty: '0.5', mark_price: '2500' }],
      times: 2,
    });
    // Wrong side → 400
    const bad = await app.inject({
      method: 'POST',
      url: '/api/deals',
      headers: HOST,
      payload: {
        id: 'close-000001',
        a: { symbol: A_CONTRACT, side: 'BUY', reduceOnly: true }, // long position closes with SELL
        qty: '0.1',
        execution: 'taker',
        clipBandPct: 0.5,
      },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toMatch(/close side must be SELL/);

    const res = await app.inject({
      method: 'POST',
      url: '/api/deals',
      headers: HOST,
      payload: {
        id: 'close-000001',
        a: { symbol: A_CONTRACT, side: 'SELL', reduceOnly: true },
        qty: '0.1',
        execution: 'taker',
        clipBandPct: 0.5,
        hedgeBandPct: 0.75,
      },
    });
    expect(res.statusCode, res.body).toBe(202);
    const pair = w.store.getPair('close-000001')!;
    expect(pair.mode).toBe('CONVERTING'); // taker deals clip from birth
    expect(pair.a.reduceOnly).toBe(true);
    expect(pair.clipBandBp).toBe(50);
    expect(pair.hedgeBandBp).toBe(75);
    expect(pair.b).toBeNull();

    // The driven loop clips it closed with a reduce-only marketable LIMIT IOC at
    // ref·(1 − band) — the user's 0.5% slippage actually reaches the wire.
    // ref 2500, 50bp → 2487.5.
    await tickPair(w.loop, pair.id);
    const clip = [...w.venue.orders.values()][0];
    expect(clip.tif).toBe('ioc');
    expect(clip.price).toBe('2487.5');
    expect(clip.reduceOnly).toBe(true);
    await tickPair(w.loop, pair.id);
    expect(w.store.getPair(pair.id)!.mode).toBe('DONE');
  });
});

describe('deal commands + alerts', () => {
  async function mkWorking(): Promise<ReturnType<typeof mkApp> & { id: string }> {
    const w = mkApp();
    app = w.app;
    mockGateGet('/rule/symbols', { body: simRules() });
    mockGateGet('/accounts', { fixture: 'account.json' });
    await app.inject({ method: 'POST', url: '/api/deals', headers: HOST, payload: makerPayload() });
    await tickPair(w.loop, 'deal-000001'); // maker resting
    return { ...w, id: 'deal-000001' };
  }

  it('convert flips OPENING → CONVERTING; 400 on unknown/settled deals', async () => {
    const w = await mkWorking();
    const res = await app.inject({ method: 'POST', url: `/api/deals/${w.id}/convert`, headers: HOST });
    expect(res.statusCode).toBe(200);
    expect(w.store.getPair(w.id)!.mode).toBe('CONVERTING');
    const again = await app.inject({ method: 'POST', url: `/api/deals/${w.id}/convert`, headers: HOST });
    expect(again.statusCode).toBe(400);
    const unknown = await app.inject({ method: 'POST', url: '/api/deals/nope-1/convert', headers: HOST });
    expect(unknown.statusCode).toBe(400);
  });

  it('repeg updates the price intent from the venue touch when no price is given', async () => {
    const w = await mkWorking();
    w.venue.touchA = '2499';
    const res = await app.inject({ method: 'POST', url: `/api/deals/${w.id}/repeg`, headers: HOST, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.price).toBe('2499');
    expect(w.store.getPair(w.id)!.limitPrice).toBe('2499');
    // Book unavailable → 400, intent untouched.
    w.venue.touchA = null;
    const down = await app.inject({ method: 'POST', url: `/api/deals/${w.id}/repeg`, headers: HOST, payload: {} });
    expect(down.statusCode).toBe(400);
  });

  // A pair ticket's maker leg is pricePolicy 'touch', and decide() re-derives
  // the placement price from `ctx.touchA ?? limitPrice` every time. So writing
  // the user's price without pinning the policy meant the route returned 200
  // echoing their number while the engine re-placed at whatever the market had
  // moved to — intermittently, because it IS honored when the book is down.
  it('an explicit re-peg price is honored, not overwritten by the live touch', async () => {
    const w = await mkWorking();
    w.store.updatePair(w.id, { pricePolicy: 'touch' });
    w.venue.touchA = '2505'; // market ran away from the user

    const res = await app.inject({
      method: 'POST',
      url: `/api/deals/${w.id}/repeg`,
      headers: HOST,
      payload: { price: '2470' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.price).toBe('2470');

    const pinned = w.store.getPair(w.id)!;
    expect(pinned.limitPrice).toBe('2470');
    expect(pinned.pricePolicy).toBe('fixed'); // the user took manual control

    // Drive the loop: the maker is cancelled and re-placed AT THE USER'S PRICE.
    for (let i = 0; i < 6; i++) {
      await tickPair(w.loop, w.id);
      w.clock.advance(1000);
    }
    const resting = w.venue.liveOrder(A_CONTRACT);
    expect(resting?.price).toBe('2470'); // not 2505
  });

  it('re-peg to touch restores book tracking on a pinned deal', async () => {
    const w = await mkWorking();
    w.store.updatePair(w.id, { pricePolicy: 'fixed', limitPrice: '2470' });
    w.venue.touchA = '2499';
    const res = await app.inject({ method: 'POST', url: `/api/deals/${w.id}/repeg`, headers: HOST, payload: {} });
    expect(res.statusCode).toBe(200);
    const pair = w.store.getPair(w.id)!;
    expect(pair.limitPrice).toBe('2499');
    expect(pair.pricePolicy).toBe('touch');
  });

  it('rejects a non-numeric re-peg price instead of writing it as the intent', async () => {
    const w = await mkWorking();
    const before = w.store.getPair(w.id)!.limitPrice;
    for (const price of ['abc', '0', '-5']) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/deals/${w.id}/repeg`,
        headers: HOST,
        payload: { price },
      });
      expect(res.statusCode, price).toBe(400);
    }
    expect(w.store.getPair(w.id)!.limitPrice).toBe(before);
  });

  it('stop → STOPPING → honest partial DONE via the driven loop', async () => {
    const w = await mkWorking();
    w.venue.fill(w.venue.liveOrder(A_CONTRACT)!.clientText, '0.05');
    const res = await app.inject({ method: 'POST', url: `/api/deals/${w.id}/stop`, headers: HOST });
    expect(res.statusCode).toBe(200);
    for (let i = 0; i < 6; i++) {
      await tickPair(w.loop, w.id);
      w.clock.advance(1000);
    }
    const view = (await app.inject({ method: 'GET', url: `/api/deals/${w.id}`, headers: HOST })).json().data;
    expect(view.pair.mode).toBe('DONE');
    const report = JSON.parse(view.pair.reportJson);
    expect(report.aFilled).toBe('0.05');
    expect(report.bFilled).toBe('0.05'); // the fill was hedged, remainder relinquished
  });

  it('alerts surface over the API and ack works', async () => {
    const w = await mkWorking();
    w.store.alert('error', w.id, 'test standing alert', Date.now());
    const list = (await app.inject({ method: 'GET', url: '/api/alerts?unacked=1', headers: HOST })).json().data;
    expect(list).toHaveLength(1);
    const ack = await app.inject({ method: 'POST', url: `/api/alerts/${list[0].id}/ack`, headers: HOST });
    expect(ack.statusCode).toBe(200);
    const after = (await app.inject({ method: 'GET', url: '/api/alerts?unacked=1', headers: HOST })).json().data;
    expect(after).toHaveLength(0);
  });

  it('GET /api/deals?active=1 lists only working deals', async () => {
    const w = await mkWorking();
    const active = (await app.inject({ method: 'GET', url: '/api/deals?active=1', headers: HOST })).json().data;
    expect(active).toHaveLength(1);
    w.store.updatePair(w.id, { mode: 'DONE' });
    const after = (await app.inject({ method: 'GET', url: '/api/deals?active=1', headers: HOST })).json().data;
    expect(after).toHaveLength(0);
  });
});
