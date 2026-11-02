/**
 * The cancel guard, end to end: route → ledger → reconcile loop.
 *
 * The unit tests pin that DELETE /api/orders/:id refuses an engine-owned id.
 * This one pins what that refusal BUYS: drive a real pair to a resting maker,
 * try to hand-cancel it through the route by both identifiers the venue
 * accepts, and prove the deal is untouched — it keeps acquiring and finishes
 * normally, instead of decoding the cancel as a deliberate user STOP and
 * permanently relinquishing the rest of the entry (decide.ts's
 * "maker canceled on venue = STOP" branch, which nothing can undo).
 *
 * The nock DELETE interceptor deliberately performs a REAL cancel on the fake
 * venue: if the guard ever leaks, the maker actually dies and the assertions
 * below fail loudly rather than passing on a technicality.
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { tickPair } from '../../src/engine/loop';
import { A_CONTRACT, assertInvariants, mkWorld } from '../unit/engine-sim';
import { gate, HOST, makeTestApp } from './helpers/gate-nock';

describe('hand-cancel cannot abandon a live deal', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  it('refuses by venue id AND by client text; the deal finishes normally', async () => {
    const w = mkWorld();
    app = makeTestApp({ engine: { store: w.store, venue: w.venue, clock: w.clock } });

    // Tick once: the maker rests on the venue and the ledger learns its id.
    await tickPair(w.deps, w.pairId);
    const resting = w.venue.liveOrder(A_CONTRACT)!;
    expect(resting).toBeDefined();
    const row = w.store.listOrders(w.pairId).find((o) => o.leg === 'A')!;
    expect(row.state).toBe('OPEN');
    expect(row.venueOrderId).not.toBeNull();

    // If the guard leaks, this really cancels the maker on the venue.
    let leaked = 0;
    gate()
      .delete(/\/orders\//)
      .times(2)
      .reply(() => {
        leaked += 1;
        w.venue.venueCancel(resting.clientText);
        return [200, { status: 'success' }];
      });

    for (const id of [row.venueOrderId!, row.clientId]) {
      const del = await app.inject({ method: 'DELETE', url: `/api/orders/${id}`, headers: HOST });
      expect(del.statusCode, `cancel by ${id}`).toBe(400);
      expect(del.json().error.message).toMatch(/belongs to a running deal/);
    }
    expect(leaked).toBe(0); // nothing reached the venue

    // The deal is untouched: still OPENING, maker still resting, and it fills
    // and completes as if no one had touched it.
    expect(w.store.getPair(w.pairId)!.mode).toBe('OPENING');
    expect(w.store.listOrders(w.pairId).find((o) => o.leg === 'A')!.cancelRequested).toBe(0);

    w.venue.fill(resting.clientText, '0.152');
    await w.step(6);

    const pair = w.store.getPair(w.pairId)!;
    expect(pair.mode).toBe('DONE');
    // The tell-tale of the bug this guard prevents: a relinquished acquisition
    // reports a shortfall. A clean finish acquires the whole target.
    expect(JSON.parse(pair.reportJson!).aFilled).toBe('0.152');
    assertInvariants(w);
  });
});
