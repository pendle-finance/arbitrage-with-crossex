import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/engine/db';
import { A_CONTRACT, B_CONTRACT, FakeVenue, VirtualClock, legSpec } from '../unit/engine-sim';
import { gate, HOST, makeTestApp, mockGateDelete, mockGateGet, orderBody } from './helpers/gate-nock';

describe('/api/orders', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  it('GET /orders/open returns the resting order (cached)', async () => {
    app = makeTestApp();
    const scope = mockGateGet('/open_orders', { fixture: 'open-orders.json' });

    const res = await app.inject({ method: 'GET', url: '/api/orders/open', headers: HOST });
    expect(res.statusCode).toBe(200);
    expect(res.json().data[0].orderId).toBe('900001');
    expect(res.json().data[0].timeInForce).toBe('GTC');

    const again = await app.inject({ method: 'GET', url: '/api/orders/open', headers: HOST });
    expect(again.statusCode).toBe(200); // served from cache — single interceptor
    expect(scope.isDone()).toBe(true);
  });

  it('GET /orders/history pages with defaults and reports hasMore', async () => {
    app = makeTestApp();
    mockGateGet('/history_orders', { fixture: 'history-orders.json', query: { page: 1, limit: 2 } });

    const res = await app.inject({ method: 'GET', url: '/api/orders/history?limit=2', headers: HOST });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.orders).toHaveLength(2);
    expect(data.hasMore).toBe(true); // full page of 2
  });

  it('GET /orders/:id returns the order', async () => {
    app = makeTestApp();
    mockGateGet('/orders/900101', { fixture: 'order.filled.json' });

    const res = await app.inject({ method: 'GET', url: '/api/orders/900101', headers: HOST });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.executedAvgPrice).toBe('61896.1');
    expect(res.json().data.state).toBe('FILLED');
  });

  it('DELETE /orders/:id cancels and busts the open-orders cache', async () => {
    app = makeTestApp();
    const openScope = mockGateGet('/open_orders', { fixture: 'open-orders.json', times: 2 });
    mockGateDelete('/orders/900001', { body: { order_id: '900001', status: 'success' } });

    await app.inject({ method: 'GET', url: '/api/orders/open', headers: HOST });
    const del = await app.inject({ method: 'DELETE', url: '/api/orders/900001', headers: HOST });
    expect(del.statusCode).toBe(200);

    // Second Gate read proves the cache was busted (TTL had not expired).
    await app.inject({ method: 'GET', url: '/api/orders/open', headers: HOST });
    expect(openScope.isDone()).toBe(true);
  });

  // The engine's leg-A maker is indistinguishable from a hand-placed order in
  // the Open Orders table. Cancelling it from here bypassed the loop AND left
  // cancel_requested at 0 — which decide() reads as "the user killed the maker
  // on the exchange" = an explicit STOP that permanently relinquishes the rest
  // of the acquisition. One click silently abandoned a half-filled two-leg entry.
  it('DELETE /orders/:id refuses an order the engine owns', async () => {
    const store = new Store(':memory:');
    const venue = new FakeVenue();
    const clock = new VirtualClock();
    app = makeTestApp({ engine: { store, venue, clock } });

    store.createPair({
      id: 'deal-000009',
      mode: 'OPENING',
      a: legSpec(A_CONTRACT, 'BUY'),
      b: legSpec(B_CONTRACT, 'SELL'),
      targetQty: '0.152',
      limitPrice: '2500',
      pricePolicy: 'fixed',
      deadlineAt: null,
      makerNotBefore: 0,
      hedgeNotBefore: 0,
      pocRejects: 0,
      hedgeRejectStreak: 0,
      maxClip: null,
      clipBandBp: null,
      hedgeBandBp: null,
      haltReason: null,
      reportJson: null,
      createdAt: clock.now(),
    });
    const o = store.insertPendingOrder({
      pairId: 'deal-000009',
      leg: 'A',
      kind: 'maker',
      side: 'BUY',
      qty: '0.152',
      price: '2500',
      tif: 'poc',
      now: clock.now(),
    });
    store.updateOrder(o.pairId, o.leg, o.seq, { state: 'OPEN', venueOrderId: '900001' });

    const del = await app.inject({ method: 'DELETE', url: '/api/orders/900001', headers: HOST });
    expect(del.statusCode).toBe(400);
    expect(del.json().error.message).toMatch(/managed by the engine/);
    // Nothing reached the venue: no DELETE interceptor was registered at all.
    expect(store.listOrders('deal-000009')[0].cancelRequested).toBe(0);
  });


  /** The canonical live-maker fixture the guard cases below share. */
  function seedPair(store: Store, clock: VirtualClock) {
    store.createPair({
      id: 'deal-000009',
      mode: 'OPENING',
      a: legSpec(A_CONTRACT, 'BUY'),
      b: legSpec(B_CONTRACT, 'SELL'),
      targetQty: '0.152',
      limitPrice: '2500',
      pricePolicy: 'fixed',
      deadlineAt: null,
      makerNotBefore: 0,
      hedgeNotBefore: 0,
      pocRejects: 0,
      hedgeRejectStreak: 0,
      maxClip: null,
      clipBandBp: null,
      hedgeBandBp: null,
      haltReason: null,
      reportJson: null,
      createdAt: clock.now(),
    });
    return store.insertPendingOrder({
      pairId: 'deal-000009',
      leg: 'A',
      kind: 'maker',
      side: 'BUY',
      qty: '0.152',
      price: '2500',
      tif: 'poc',
      now: clock.now(),
    });
  }

  // BYPASS (a): the venue accepts our CLIENT TEXT on cancel exactly as it
  // accepts its own numeric id — venueGate.cancel depends on that — and the
  // text is readable straight off /api/deals. A guard keyed on the venue id
  // alone was one curl away from the permanent-STOP relinquish.
  it('DELETE /orders/:clientId refuses too — the client text is not a back door', async () => {
    const store = new Store(':memory:');
    const clock = new VirtualClock();
    app = makeTestApp({ engine: { store, venue: new FakeVenue(), clock } });
    const o = seedPair(store, clock);
    store.updateOrder(o.pairId, o.leg, o.seq, { state: 'OPEN', venueOrderId: '900001' });

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/orders/${o.clientId}`,
      headers: HOST,
    });
    expect(del.statusCode).toBe(400);
    expect(del.json().error.message).toMatch(/managed by the engine/);
    // No DELETE interceptor is registered — a leak would fail the request loudly.
    expect(store.listOrders('deal-000009')[0].cancelRequested).toBe(0);
  });

  // BYPASS (b): between a create that came back 'unknown' and the read that
  // confirms it, the order can be LIVE on the venue while our row still has
  // venue_order_id NULL — and the pair is frozen, which is exactly when a user
  // reaches for Cancel. The ledger can't disprove ownership, so the guard asks
  // the venue whose order it is.
  it('refuses a venue-id cancel that the venue says is ours, while our row awaits confirmation', async () => {
    const store = new Store(':memory:');
    const clock = new VirtualClock();
    app = makeTestApp({ engine: { store, venue: new FakeVenue(), clock } });
    const o = seedPair(store, clock); // stays PENDING, venueOrderId NULL
    mockGateGet('/orders/900001', { body: orderBody({ order_id: '900001', text: o.clientId }) });

    const del = await app.inject({ method: 'DELETE', url: '/api/orders/900001', headers: HOST });
    expect(del.statusCode).toBe(400);
    expect(del.json().error.message).toMatch(/managed by the engine/);
  });

  it('still cancels a genuinely hand-placed order during that same window', async () => {
    // The guard must not become a blanket denial: the deal is in doubt, but
    // this order is demonstrably not ours, so the user keeps control of it.
    const store = new Store(':memory:');
    const clock = new VirtualClock();
    app = makeTestApp({ engine: { store, venue: new FakeVenue(), clock } });
    seedPair(store, clock);
    mockGateGet('/orders/777777', { body: orderBody({ order_id: '777777', text: 'apiv4-web' }) });
    mockGateDelete('/orders/777777', { body: { order_id: '777777', status: 'success' } });

    const del = await app.inject({ method: 'DELETE', url: '/api/orders/777777', headers: HOST });
    expect(del.statusCode).toBe(200);
  });

  it('refuses when the venue cannot say whose order it is (proves nothing → fail closed)', async () => {
    const store = new Store(':memory:');
    const clock = new VirtualClock();
    app = makeTestApp({ engine: { store, venue: new FakeVenue(), clock } });
    seedPair(store, clock);
    gate().get(/\/orders\/900001/).reply(502, { label: 'SERVER_ERROR' });

    const del = await app.inject({ method: 'DELETE', url: '/api/orders/900001', headers: HOST });
    expect(del.statusCode).toBe(400);
    expect(del.json().error.message).toMatch(/could not confirm/);
  });


  // A single resting limit order has no hedge leg to strand, and "give up the
  // rest" is exactly what cancelling a limit order means. Refusing it was the
  // bug: the user places a plain order, sees it in this table, and cannot
  // cancel it from here. The route now translates the hand-cancel into the
  // deal's own Stop so the LOOP does the venue call (single-writer holds).
  it('DELETE /orders/:id stops the deal for a single resting limit order', async () => {
    const store = new Store(':memory:');
    const clock = new VirtualClock();
    app = makeTestApp({ engine: { store, venue: new FakeVenue(), clock } });

    store.createPair({
      id: 'deal-plain-1',
      mode: 'OPENING',
      a: legSpec(A_CONTRACT, 'BUY'),
      b: null, // single leg — this is what makes it a plain order
      targetQty: '0.152',
      limitPrice: '2500',
      pricePolicy: 'fixed',
      deadlineAt: null,
      makerNotBefore: 0,
      hedgeNotBefore: 0,
      pocRejects: 0,
      hedgeRejectStreak: 0,
      maxClip: null,
      clipBandBp: null,
      hedgeBandBp: null,
      haltReason: null,
      reportJson: null,
      createdAt: clock.now(),
    });
    const o = store.insertPendingOrder({
      pairId: 'deal-plain-1',
      leg: 'A',
      kind: 'maker',
      side: 'BUY',
      qty: '0.152',
      price: '2500',
      tif: 'poc',
      now: clock.now(),
    });
    store.updateOrder(o.pairId, o.leg, o.seq, { state: 'OPEN', venueOrderId: '910001' });

    const del = await app.inject({ method: 'DELETE', url: '/api/orders/910001', headers: HOST });

    expect(del.statusCode).toBe(200);
    expect(del.json().data).toMatchObject({ dealId: 'deal-plain-1', cancelling: true });
    // The deal is stopping; the LOOP cancels on the venue, not this route —
    // no DELETE interceptor is registered, so a direct wire call would fail.
    expect(store.getPair('deal-plain-1')!.mode).toBe('STOPPING');
  });

  // The exception is exactly that: single-leg AND resting. A hedged pair must
  // still refuse, or one click abandons a half-filled two-leg entry.
  it('still refuses when the same order belongs to a hedged pair', async () => {
    const store = new Store(':memory:');
    const clock = new VirtualClock();
    app = makeTestApp({ engine: { store, venue: new FakeVenue(), clock } });
    const o = seedPair(store, clock); // has a b leg
    store.updateOrder(o.pairId, o.leg, o.seq, { state: 'OPEN', venueOrderId: '910002' });

    const del = await app.inject({ method: 'DELETE', url: '/api/orders/910002', headers: HOST });
    expect(del.statusCode).toBe(400);
    expect(del.json().error.message).toMatch(/managed by the engine/);
    expect(store.getPair('deal-000009')!.mode).toBe('OPENING'); // untouched
  });

  it('DELETE /orders/:id still cancels a hand-placed order while a deal is running', async () => {
    const store = new Store(':memory:');
    app = makeTestApp({ engine: { store, venue: new FakeVenue(), clock: new VirtualClock() } });
    mockGateDelete('/orders/777777', { body: { order_id: '777777', status: 'success' } });

    const del = await app.inject({ method: 'DELETE', url: '/api/orders/777777', headers: HOST });
    expect(del.statusCode).toBe(200);
  });
});
