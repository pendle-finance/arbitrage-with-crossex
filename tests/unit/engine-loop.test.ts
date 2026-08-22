/**
 * engine scenario tests: every lifecycle case from docs/MAKER-HEDGE.md, with the
 * prime invariants asserted against VENUE truth after every tick.
 */
import { describe, expect, it } from 'vitest';
import { fxStr, fx } from '../../src/engine/fx';
import { commands, startLoop } from '../../src/engine/loop';
import { Store } from '../../src/engine/db';
import { TUNING } from '../../src/engine/types';
import {
  A_CONTRACT,
  B_CONTRACT,
  assertHonestReport,
  assertInvariants,
  mkWorld,
  type World,
} from './engine-sim';

async function stepChecked(w: World, n = 1): Promise<void> {
  for (let i = 0; i < n; i++) {
    await w.step(1);
    assertInvariants(w);
  }
}

describe('happy path', () => {
  it('places the maker, hedges incrementally as it fills, finishes DONE with an honest report', async () => {
    const w = mkWorld();
    await stepChecked(w); // places maker
    const maker = w.venue.liveOrder(A_CONTRACT)!;
    expect(maker).toBeDefined();
    expect(maker.tif).toBe('poc');
    expect(fxStr(maker.qty)).toBe('0.152');

    w.venue.fill(maker.clientText, '0.05');
    await stepChecked(w); // observes fill, hedges 0.05
    let hedges = [...w.venue.orders.values()].filter((o) => o.contract === B_CONTRACT);
    expect(hedges.length).toBe(1);
    expect(fxStr(hedges[0].qty)).toBe('0.05');

    w.venue.fill(maker.clientText, '0.102'); // full
    await stepChecked(w, 2); // observe+hedge remainder, then finish
    hedges = [...w.venue.orders.values()].filter((o) => o.contract === B_CONTRACT);
    expect(hedges.reduce((s, o) => s + o.cum, 0n)).toBe(fx('0.152'));
    await stepChecked(w, 2);
    assertHonestReport(w);
    // End-to-end: the finished report carries each leg's realized average fill
    // (venue executed_avg_price folded through the orders) — the maker at its
    // resting limit, the hedge at the venue ref. This is what the deal report's
    // taker-vs-limit slippage row reads.
    const rep = JSON.parse(w.store.getPair(w.pairId)!.reportJson!);
    expect(rep.aAvgFill).toBe('2500');
    expect(rep.bAvgFill).toBe('2500');
  });
});

describe('commands racing a tick', () => {
  // tickPair awaits real network calls for touch/ref prices, and Fastify handlers
  // share this event loop: a user command COMMITS during those awaits. Deciding
  // on the snapshot taken before them ignored a Stop the API had already
  // acknowledged with a 200, and then placed an order against the abandoned mode.
  it('honors a Stop that commits while the tick is awaiting venue prices', async () => {
    const w = mkWorld({ pricePolicy: 'touch' }); // forces a touch() await
    const realTouch = w.venue.touch.bind(w.venue);
    let fired = false;
    w.venue.touch = async (c?, s?, t?) => {
      if (!fired) {
        fired = true;
        commands.stop(w.store, w.pairId); // the user presses Stop mid-fetch
      }
      return realTouch(c, s, t);
    };

    await w.step(1);

    expect(fired).toBe(true);
    // THE assertion: nothing may be acquired for a deal the user already
    // stopped. Before the re-read this placed a full-size POC maker.
    expect(w.venue.createCalls).toHaveLength(0);
    expect(w.venue.liveOrder(A_CONTRACT)).toBeUndefined();
    // The racing tick defers (its price context was fetched for the old mode);
    // what matters is that it never went back to acquiring, and the next tick —
    // which wake() has already queued in production — settles the Stop.
    expect(w.store.getPair(w.pairId)!.mode).not.toBe('OPENING');
    await w.step(2);
    expect(w.store.getPair(w.pairId)!.mode).toBe('DONE');
    expect(w.venue.createCalls).toHaveLength(0);
  });

  it('honors a Convert that commits mid-fetch (mode edit is not lost)', async () => {
    const w = mkWorld({ pricePolicy: 'touch' });
    const realTouch = w.venue.touch.bind(w.venue);
    let fired = false;
    w.venue.touch = async (c?, s?, t?) => {
      if (!fired) {
        fired = true;
        commands.convertNow(w.store, w.pairId);
      }
      return realTouch(c, s, t);
    };

    await w.step(1);

    expect(w.store.getPair(w.pairId)!.mode).toBe('CONVERTING');
    // A converting pair clips with a taker IOC — it must never rest a POC maker.
    for (const o of w.venue.orders.values()) expect(o.tif).not.toBe('poc');
  });

  // The re-read alone was not enough: the fetch predicates (needTouch/needRefA/
  // needRefB) were computed from the PRE-await mode, so a Convert committing
  // mid-fetch ran the CONVERTING branch with refA still at the '0' sentinel.
  // sizeFor read that as a real price — zero notional < minNotional — sized the
  // clip to FX_ZERO, and finishIfSettled wrote DONE "converted" with the whole
  // target unacquired. Every real CrossEx FUTURE has a positive min_notional,
  // so this was every real maker pair; only minNotional-0 test worlds missed it.
  it('a Convert committing mid-fetch defers — never DONE off the stale price context', async () => {
    const w = mkWorld({ pricePolicy: 'touch', a: { minNotional: '10' } });
    const realTouch = w.venue.touch.bind(w.venue);
    let fired = false;
    w.venue.touch = async (c?, s?, t?) => {
      if (!fired) {
        fired = true;
        commands.convertNow(w.store, w.pairId);
      }
      return realTouch(c, s, t);
    };

    await w.step(1);

    // The racing tick must NOT finish the deal: its ctx was fetched for
    // OPENING, so refA is the '0' sentinel and any decision from it is garbage.
    const pair = w.store.getPair(w.pairId)!;
    expect(pair.mode).toBe('CONVERTING');
    expect(pair.reportJson).toBeNull();

    // Subsequent ticks fetch refA for real and the convert actually converts.
    await stepChecked(w, 6);
    const done = w.store.getPair(w.pairId)!;
    expect(done.mode).toBe('DONE');
    expect(JSON.parse(done.reportJson!).aFilled).toBe('0.152');
  });
});

describe('unreadable live order', () => {
  // A failed read resolves NOTHING while the order stays live on the venue and
  // keeps filling: cum_qty freezes at its last good value, project() computes
  // unhedged from stale numbers, and the deal renders green and progressing.
  // observeOpen used to `return` silently with no counter and no alert, so a
  // revoked key or a venue outage was invisible for as long as it lasted.
  it('alerts once when reads keep failing on a resting maker', async () => {
    const w = mkWorld();
    await stepChecked(w); // maker rests
    expect(w.venue.liveOrder(A_CONTRACT)).toBeDefined();

    w.venue.readsFail = true; // credentials revoked / venue unreachable
    await w.step(TUNING.READ_FAIL_ALERT + 3);

    const orders = w.store.listOrders(w.pairId);
    const maker = orders.find((o) => o.leg === 'A')!;
    expect(maker.state).toBe('OPEN'); // still live: a failed read resolves nothing
    expect(maker.readFailStreak).toBeGreaterThanOrEqual(TUNING.READ_FAIL_ALERT);

    const alerts = w.store.listAlerts();
    const unreadable = alerts.filter((a) => /cannot read live order/.test(a.message));
    expect(unreadable).toHaveLength(1); // escalated, and exactly once — no per-tick nagging
    expect(unreadable[0].level).toBe('error');
  });

  it('clears the streak as soon as the venue is readable again', async () => {
    const w = mkWorld();
    await stepChecked(w);
    w.venue.readsFail = true;
    await w.step(2);
    expect(w.store.listOrders(w.pairId).find((o) => o.leg === 'A')!.readFailStreak).toBe(2);

    w.venue.readsFail = false;
    await stepChecked(w);
    expect(w.store.listOrders(w.pairId).find((o) => o.leg === 'A')!.readFailStreak).toBe(0);
  });
});

describe('hedge leg unsizable (no reference price)', () => {
  // refPrice() returns null on ANY failure, and every CrossEx FUTURE symbol has
  // a positive min_notional, so sizeFor answers "cannot size safely". No B order
  // is ever created — so no terminal is observed, bumpHedgeWall never fires from
  // applySnapshot, hedgeRejectStreak stays 0 and HEDGE_REJECT_HALT was
  // unreachable. Meanwhile OPENING did not gate on hedgeOwed, so leg A kept
  // acquiring to target: a fully naked deal in an 'active' mode, no alert.
  it('stops acquiring and halts instead of filling leg A naked', async () => {
    const w = mkWorld({ b: { minNotional: '10' } });
    await stepChecked(w); // maker rests
    const maker = w.venue.liveOrder(A_CONTRACT)!;
    w.venue.fill(maker.clientText, '0.05'); // 0.05 about to be unhedged
    w.venue.refPrices.delete(B_CONTRACT); // hedge book goes away BEFORE we observe it
    await stepChecked(w); // observes the fill; the hedge cannot be sized

    expect(w.venue.truth().bTrue).toBe(fx('0')); // nothing hedged it
    const beforeAcquired = w.venue.truth().aTrue;
    for (let i = 0; i < 15 && w.store.getPair(w.pairId)!.mode !== 'HALTED'; i++) {
      await stepChecked(w); // backoff 3s / tick 1s → wall reaches the halt threshold
    }

    const pair = w.store.getPair(w.pairId)!;
    expect(pair.hedgeRejectStreak).toBeGreaterThanOrEqual(TUNING.HEDGE_REJECT_HALT);
    expect(pair.mode).toBe('HALTED');
    // The maker must not have kept acquiring while the hedge was impossible.
    expect(w.venue.truth().aTrue).toBe(beforeAcquired);
    expect(w.venue.liveOrder(A_CONTRACT)).toBeUndefined(); // and it is not left resting
    assertInvariants(w);
  });

  it('counts a missing hedge reference as a wall even when minNotional is zero', async () => {
    const w = mkWorld({ b: { minNotional: '0' } });
    await stepChecked(w);
    const maker = w.venue.liveOrder(A_CONTRACT)!;
    w.venue.fill(maker.clientText, '0.05');
    w.venue.refPrices.delete(B_CONTRACT);
    await stepChecked(w);
    expect(w.venue.liveOrder(A_CONTRACT)).toBeUndefined(); // acquisition stops on the first failed ref read
    for (let i = 0; i < 14 && w.store.getPair(w.pairId)!.mode !== 'HALTED'; i++) {
      await stepChecked(w);
    }

    const pair = w.store.getPair(w.pairId)!;
    expect(pair.hedgeRejectStreak).toBeGreaterThanOrEqual(TUNING.HEDGE_REJECT_HALT);
    expect(pair.mode).toBe('HALTED');
    expect(w.venue.truth()).toEqual({ aTrue: fx('0.05'), bTrue: fx('0') });
    expect(w.venue.liveOrder(A_CONTRACT)).toBeUndefined();
  });

  it('resumes normally once the reference price comes back', async () => {
    const w = mkWorld({ b: { minNotional: '10' } });
    await stepChecked(w);
    const maker = w.venue.liveOrder(A_CONTRACT)!;
    w.venue.fill(maker.clientText, '0.05');
    w.venue.refPrices.delete(B_CONTRACT); // before the fill is observed
    await stepChecked(w, 2); // stalls, no hedge possible
    expect(w.venue.truth().bTrue).toBe(fx('0'));

    w.venue.refPrices.set(B_CONTRACT, '2500'); // book returns
    await stepChecked(w, 3);
    expect(w.venue.truth().bTrue).toBe(fx('0.05')); // hedge goes out
    expect(w.store.getPair(w.pairId)!.hedgeRejectStreak).toBe(0); // streak cleared
  });

  // Sub-lot dust is unhedgeable BY DESIGN — sizeFor answers FX_ZERO before ever
  // consulting the ref price — so a dead hedge book with only dust at risk is
  // not a hedge wall. The bump used to gate on unhedged > 0 alone; because no B
  // order is ever submitted for dust, the streak's only reset (a B fill) could
  // never fire, and isolated ref-price blips — even hours apart — accumulated
  // to HEDGE_REJECT_HALT and abandoned a healthy deal that never had a
  // submittable hedge to fail.
  it('sub-lot dust with a dead hedge book never bumps the wall or halts', async () => {
    // B's lot is 10x A's: a maker fill of 0.005 is real exposure on A but
    // permanently below B's lot — the steady state between fills.
    const w = mkWorld({ b: { minNotional: '10', lot: '0.01' } });
    await stepChecked(w); // maker rests
    const maker = w.venue.liveOrder(A_CONTRACT)!;
    w.venue.fill(maker.clientText, '0.005');
    w.venue.refPrices.delete(B_CONTRACT); // hedge book goes away

    await stepChecked(w, 15); // far past HEDGE_BACKOFF_MS × HEDGE_REJECT_HALT

    const pair = w.store.getPair(w.pairId)!;
    expect(pair.hedgeRejectStreak).toBe(0); // dust never counted as a wall
    expect(pair.mode).toBe('OPENING'); // deal stays healthy
    expect(w.venue.liveOrder(A_CONTRACT)).toBeDefined(); // maker keeps working
  });
});

describe('post-only handling', () => {
  it('re-places after a create-time POC reject, with backoff', async () => {
    const w = mkWorld();
    w.venue.nextCreate = ['reject:POC_FILL_IMMEDIATELY', 'ok'];
    await stepChecked(w); // reject → DEAD, pocRejects=1, backoff
    expect(w.venue.liveOrder(A_CONTRACT)).toBeUndefined();
    expect(w.store.getPair(w.pairId)!.pocRejects).toBe(1);
    await stepChecked(w, 3); // backoff passes (2s), re-places
    expect(w.venue.liveOrder(A_CONTRACT)).toBeDefined();
  });

  it('re-places after an accepted-then-instantly-canceled POC (not treated as user STOP)', async () => {
    const w = mkWorld();
    w.venue.nextCreate = ['insta-cancel', 'ok'];
    await stepChecked(w);
    expect(w.store.getPair(w.pairId)!.mode).toBe('OPENING'); // NOT STOPPING
    expect(w.store.getPair(w.pairId)!.pocRejects).toBe(1);
    await stepChecked(w, 3);
    expect(w.venue.liveOrder(A_CONTRACT)).toBeDefined();
  });

  it('gives up into STOPPING after repeated POC rejects', async () => {
    const w = mkWorld();
    w.venue.nextCreate = Array(TUNING.MAX_POC_REJECTS).fill('reject:POC_FILL_IMMEDIATELY');
    await stepChecked(w, 20);
    const pair = w.store.getPair(w.pairId)!;
    expect(pair.mode).toBe('DONE'); // STOPPING with nothing filled settles to DONE
    const report = JSON.parse(pair.reportJson!) as { aFilled: string; reason: string };
    expect(report.aFilled).toBe('0');
    // The report must carry the cause, not a bare 'stopped' — the deal modal
    // keys its "try again in the order form" guidance off this text.
    expect(report.reason).toMatch(/crossing the market/);
  });
});

describe('wire ambiguity (the tri-state)', () => {
  it('unknown-but-delivered maker: freezes, then adopts by probe — never re-submits', async () => {
    const w = mkWorld();
    w.venue.nextCreate = ['unknown-delivered'];
    await stepChecked(w); // create returns unknown; order actually live
    expect(w.store.listOrders(w.pairId)[0].state).toBe('PENDING');
    await stepChecked(w); // resolvePending probes → found → OPEN
    expect(w.store.listOrders(w.pairId)[0].state).toBe('OPEN');
    expect(w.venue.createCalls.length).toBe(1); // never re-submitted
    // and it keeps working: fills get hedged
    const maker = w.venue.liveOrder(A_CONTRACT)!;
    w.venue.fill(maker.clientText, '0.152');
    await stepChecked(w, 4);
    assertHonestReport(w);
  });

  it('unknown-and-lost maker: frozen through the ambiguity window, then declared dead and re-minted', async () => {
    const w = mkWorld();
    w.venue.nextCreate = ['unknown-lost', 'ok'];
    await stepChecked(w);
    expect(w.store.listOrders(w.pairId)[0].state).toBe('PENDING');
    // Frozen while ambiguous: no new orders during the window.
    const ticksInWindow = Math.ceil(TUNING.AMBIGUITY_MS / TUNING.TICK_MS);
    await stepChecked(w, ticksInWindow + 1);
    const orders = w.store.listOrders(w.pairId);
    expect(orders[0].state).toBe('DEAD');
    expect(orders[0].closeReason).toBe('never-reached-venue');
    await stepChecked(w, 1);
    expect(w.venue.liveOrder(A_CONTRACT)).toBeDefined(); // fresh id, fresh order
    expect(w.venue.createCalls.length).toBe(2);
    expect(new Set(w.venue.createCalls).size).toBe(2);
  });

  it('listing coverage failure blocks the dead verdict (absence of evidence ≠ evidence of absence)', async () => {
    const w = mkWorld();
    w.venue.nextCreate = ['unknown-lost'];
    w.venue.sweepCoverage = false;
    const ticksInWindow = Math.ceil(TUNING.AMBIGUITY_MS / TUNING.TICK_MS);
    await stepChecked(w, ticksInWindow + 5);
    expect(w.store.listOrders(w.pairId)[0].state).toBe('PENDING'); // still frozen
    const alerts = w.store.listAlerts({ unackedOnly: true });
    expect(alerts.some((a) => /could not prove absence/.test(a.message))).toBe(true);
    // Coverage restored → resolves
    w.venue.sweepCoverage = true;
    await stepChecked(w, 1);
    expect(w.store.listOrders(w.pairId)[0].state).toBe('DEAD');
  });

  it('unknown-but-delivered hedge: qty stays reserved; no second hedge fires for the same fill', async () => {
    const w = mkWorld();
    await stepChecked(w); // maker placed
    const maker = w.venue.liveOrder(A_CONTRACT)!;
    w.venue.fill(maker.clientText, '0.05');
    w.venue.nextCreate = ['unknown-delivered']; // the hedge create goes ambiguous
    await stepChecked(w); // hedge submitted, outcome unknown → PENDING
    await stepChecked(w, 2); // probe adopts it (filled IOC)
    const hedges = [...w.venue.orders.values()].filter((o) => o.contract === B_CONTRACT);
    expect(hedges.length).toBe(1); // exactly one hedge ever reached the venue
  });

  it('crash between reservation-commit and wire call: resolved as never-reached, then re-minted', async () => {
    let crashNext = false;
    const w = mkWorld({ crashAfterCommit: () => crashNext });
    crashNext = true;
    await stepChecked(w); // reservation committed; "crash" before wire
    crashNext = false;
    expect(w.store.listOrders(w.pairId)[0].state).toBe('PENDING');
    expect(w.venue.createCalls.length).toBe(0); // nothing reached the venue
    const ticksInWindow = Math.ceil(TUNING.AMBIGUITY_MS / TUNING.TICK_MS);
    await stepChecked(w, ticksInWindow + 2);
    expect(w.store.listOrders(w.pairId)[0].state).toBe('DEAD');
    expect(w.venue.liveOrder(A_CONTRACT)).toBeDefined(); // re-minted under a fresh id
  });
});

describe('user commands', () => {
  it('convert-now cancels the maker and completes both venues at market', async () => {
    const w = mkWorld();
    await stepChecked(w);
    const maker = w.venue.liveOrder(A_CONTRACT)!;
    w.venue.fill(maker.clientText, '0.05');
    await stepChecked(w); // hedge 0.05
    commands.convertNow(w.store, w.pairId);
    await stepChecked(w, 6); // cancel maker → clip A remainder → settle
    assertHonestReport(w);
    const { aTrue, bTrue } = w.venue.truth();
    expect(fxStr(aTrue)).toBe('0.152');
    expect(fxStr(bTrue)).toBe('0.152');
  });

  it('timeout converts exactly like convert-now', async () => {
    const w = mkWorld({ deadlineInMs: 10_000 });
    await stepChecked(w);
    w.clock.advance(20_000);
    await stepChecked(w, 6);
    assertHonestReport(w);
    expect(fxStr(w.venue.truth().aTrue)).toBe('0.152');
  });

  it('a venue-side cancel (not ours) is a STOP: hedge what filled, never complete', async () => {
    const w = mkWorld();
    await stepChecked(w);
    const maker = w.venue.liveOrder(A_CONTRACT)!;
    w.venue.fill(maker.clientText, '0.05');
    w.venue.venueCancel(maker.clientText); // the user kills it on the exchange UI
    await stepChecked(w, 5);
    const pair = w.store.getPair(w.pairId)!;
    expect(pair.mode).toBe('DONE');
    const report = JSON.parse(pair.reportJson!);
    expect(report.aFilled).toBe('0.05');
    expect(report.bFilled).toBe('0.05'); // hedged, but the remainder was NOT completed
    expect(report.reason).toContain('stopped');
  });

  it('re-peg: intent price edit → cancel → re-place remainder at the new price under a fresh id', async () => {
    const w = mkWorld();
    await stepChecked(w);
    const m1 = w.venue.liveOrder(A_CONTRACT)!;
    w.venue.fill(m1.clientText, '0.05');
    commands.repeg(w.store, w.pairId, '2499');
    await stepChecked(w, 2); // hedge the 0.05 first (priority), then cancel maker
    await stepChecked(w, 3); // replacement placed
    const m2 = w.venue.liveOrder(A_CONTRACT)!;
    expect(m2.clientText).not.toBe(m1.clientText);
    expect(m2.price).toBe('2499');
    expect(fxStr(m2.qty)).toBe('0.102'); // remainder only (0.152 − 0.05 locked cum)
    // fills on the replacement complete the pair
    w.venue.fill(m2.clientText, '0.102');
    await stepChecked(w, 4);
    assertHonestReport(w);
  });

  it('stop command: cancel maker, hedge fills, finish honestly partial', async () => {
    const w = mkWorld();
    await stepChecked(w);
    w.venue.fill(w.venue.liveOrder(A_CONTRACT)!.clientText, '0.03');
    commands.stop(w.store, w.pairId);
    await stepChecked(w, 5);
    const report = JSON.parse(w.store.getPair(w.pairId)!.reportJson!);
    expect(report.aFilled).toBe('0.03');
    expect(report.bFilled).toBe('0.03');
  });
});

describe('hedge walls (hazard 7)', () => {
  it('persistent hedge rejects HALT the pair: maker canceled, no completion, alert raised', async () => {
    const w = mkWorld();
    await stepChecked(w);
    const maker = w.venue.liveOrder(A_CONTRACT)!;
    w.venue.fill(maker.clientText, '0.05');
    // Persistent wall: every hedge attempt (including slow retries while HALTED) rejects.
    w.venue.nextCreate = Array(20).fill('reject:BALANCE_NOT_ENOUGH');
    await stepChecked(w, 30);
    const pair = w.store.getPair(w.pairId)!;
    expect(pair.mode).toBe('HALTED');
    expect(pair.haltReason).toContain('hedge failed');
    expect(w.venue.liveOrder(A_CONTRACT)).toBeUndefined(); // maker canceled — acquisition stopped
    expect([...w.venue.orders.values()].filter((o) => o.contract === B_CONTRACT && o.cum > 0n)).toHaveLength(0);
    // Operator resumes → STOPPING → cancel maker → hedge retries (now allowed) → DONE
    w.venue.nextCreate = [];
    commands.resumeAfterHalt(w.store, w.pairId);
    await stepChecked(w, 6);
    const done = w.store.getPair(w.pairId)!;
    expect(done.mode).toBe('DONE');
    expect(JSON.parse(done.reportJson!).bFilled).toBe('0.05'); // hedged after the wall cleared
  });
});

describe('venue weirdness', () => {
  it('an unclassifiable status string quarantines the order and freezes the pair', async () => {
    const w = mkWorld();
    await stepChecked(w);
    const maker = w.venue.liveOrder(A_CONTRACT)!;
    w.venue.fill(maker.clientText, '0.05');
    w.venue.setRawStatus(maker.clientText, 'MYSTERIOUS_STATE_7');
    const createsBefore = w.venue.createCalls.length;
    await stepChecked(w, 3);
    expect(w.venue.createCalls.length).toBe(createsBefore); // frozen: even the hedge waits
    const alerts = w.store.listAlerts({ unackedOnly: true });
    expect(alerts.some((a) => /unclassifiable venue status/.test(a.message))).toBe(true);
    // Status resolves → unfreezes → hedges the fill
    w.venue.setRawStatus(maker.clientText, 'OPEN');
    await stepChecked(w, 2);
    const hedges = [...w.venue.orders.values()].filter((o) => o.contract === B_CONTRACT);
    expect(hedges.length).toBe(1);
  });

  it('read outages stall the loop safely (no decisions from failed reads)', async () => {
    const w = mkWorld();
    await stepChecked(w);
    const maker = w.venue.liveOrder(A_CONTRACT)!;
    w.venue.fill(maker.clientText, '0.152');
    w.venue.readsFail = true;
    const createsBefore = w.venue.createCalls.length;
    await stepChecked(w, 10); // cannot observe the fill — places nothing, decides nothing
    expect(w.venue.createCalls.length).toBe(createsBefore);
    w.venue.readsFail = false;
    await stepChecked(w, 4); // observes, hedges, finishes
    assertHonestReport(w);
  });

  it('an IOC hedge whiff (zero fill) releases its reservation and re-fires after the wall backoff', async () => {
    const w = mkWorld();
    await stepChecked(w);
    w.venue.fill(w.venue.liveOrder(A_CONTRACT)!.clientText, '0.05');
    w.venue.nextIocFill = [0, 1]; // first hedge whiffs, second fills
    await stepChecked(w, 6); // whiff → backoff (whiffs count toward the wall) → re-fire
    const hedges = [...w.venue.orders.values()].filter((o) => o.contract === B_CONTRACT);
    expect(hedges.length).toBe(2);
    expect(fxStr(hedges[1].cum)).toBe('0.05');
    expect(w.store.getPair(w.pairId)!.hedgeRejectStreak).toBe(0); // reset by the fill
  });

  it('partial IOC hedge fills: the shortfall is re-hedged, never double-hedged', async () => {
    const w = mkWorld();
    await stepChecked(w);
    w.venue.fill(w.venue.liveOrder(A_CONTRACT)!.clientText, '0.1');
    w.venue.nextIocFill = [0.5, 1]; // hedge 1 fills half
    await stepChecked(w, 4);
    const { aTrue, bTrue } = w.venue.truth();
    expect(bTrue).toBe(fx('0.1'));
    expect(bTrue <= aTrue).toBe(true);
  });
});

describe('dust (hazard 8)', () => {
  it('a sub-lot residual is never rounded up; the report carries the honest shortfall', async () => {
    const w = mkWorld({ target: '0.152', b: { lot: '0.1' } }); // hedge lot coarser than fills
    await stepChecked(w);
    const maker = w.venue.liveOrder(A_CONTRACT)!;
    w.venue.fill(maker.clientText, '0.152');
    await stepChecked(w, 3); // hedge floors 0.152 → 0.1
    const { bTrue } = w.venue.truth();
    expect(fxStr(bTrue)).toBe('0.1'); // 0.052 dust — never rounded UP to 0.2
    await stepChecked(w, 3);
    const pair = w.store.getPair(w.pairId)!;
    expect(pair.mode).toBe('DONE');
    const report = JSON.parse(pair.reportJson!);
    expect(report.aFilled).toBe('0.152');
    expect(report.bFilled).toBe('0.1');
    expect(report.unhedged).toBe('0.052'); // named, not hidden
  });
});

describe('convert clips', () => {
  it('completion runs in clips, hedge-first, and never buys past target under interleaved fills', async () => {
    const w = mkWorld({ maxClip: '0.05' });
    await stepChecked(w);
    const maker = w.venue.liveOrder(A_CONTRACT)!;
    w.venue.fill(maker.clientText, '0.03');
    commands.convertNow(w.store, w.pairId);
    await stepChecked(w, 20); // hedge 0.03 → cancel maker → clips of ≤0.05 with hedges between
    assertHonestReport(w);
    const { aTrue, bTrue } = w.venue.truth();
    expect(fxStr(aTrue)).toBe('0.152');
    expect(fxStr(bTrue)).toBe('0.152');
    const clips = [...w.venue.orders.values()].filter((o) => o.contract === A_CONTRACT && o.tif === 'ioc');
    expect(clips.length).toBeGreaterThanOrEqual(3); // 0.05+0.05+0.019... capped clips
    for (const c of clips) expect(c.qty <= fx('0.05')).toBe(true);
  });
});

describe('review regressions', () => {
  it('[R1] a residual below the hedge venue MIN (not just lot) finishes as named dust — no livelock', async () => {
    // Dust dead-zone: unhedged 0.05 ≥ lot 0.001 but 0.05×2500=125 < minNotional 150.
    const w = mkWorld({ b: { minNotional: '150' } });
    await stepChecked(w);
    const maker = w.venue.liveOrder(A_CONTRACT)!;
    w.venue.fill(maker.clientText, '0.05');
    w.venue.venueCancel(maker.clientText); // STOP with an unhedgeable residual
    await stepChecked(w, 6);
    const pair = w.store.getPair(w.pairId)!;
    expect(pair.mode).toBe('DONE'); // pre-fix: idled forever on 'hedge branch owns it'
    const report = JSON.parse(pair.reportJson!);
    expect(report.aFilled).toBe('0.05');
    expect(report.bFilled).toBe('0');
    expect(report.unhedged).toBe('0.05'); // named, not hidden
  });

  it('[R1b] finishing in the dust dead-zone raises a LOUD alert, not just a report field', async () => {
    // Same dead-zone as [R1]: 0.05 is >= the lot but below the hedge venue's
    // minNotional, so it can never be submitted. Finishing there is the settled
    // behaviour - but the residual is a whole number of lots and can be most of
    // the deal, so it must not be discoverable only by reading report_json.
    const w = mkWorld({ b: { minNotional: '150' } });
    await stepChecked(w);
    const maker = w.venue.liveOrder(A_CONTRACT)!;
    w.venue.fill(maker.clientText, '0.05');
    w.venue.venueCancel(maker.clientText);
    await stepChecked(w, 6);

    const pair = w.store.getPair(w.pairId)!;
    expect(pair.mode).toBe('DONE');
    expect(JSON.parse(pair.reportJson!).unhedged).toBe('0.05');
    // The terminal reason names it...
    expect(JSON.parse(pair.reportJson!).reason).toMatch(/unhedged 0\.05/);
    // ...and an operator-visible alert says so outright.
    const alerts = w.store.listAlerts({ unackedOnly: true });
    const naked = alerts.filter((a) => /UNHEDGED/.test(a.message));
    expect(naked).toHaveLength(1);
    expect(naked[0].level).toBe('error');
  });

  it('[R1c] a sub-LOT remainder is true dust — finishes quietly, no alert', async () => {
    // Below the lot there is nothing any venue could accept, so this one really
    // is a rounding remainder and must not nag.
    const w = mkWorld({ b: { lot: '0.1' } });
    await stepChecked(w);
    const maker = w.venue.liveOrder(A_CONTRACT)!;
    w.venue.fill(maker.clientText, '0.152'); // hedges 0.1, leaves 0.052 < lot 0.1
    await stepChecked(w, 8);

    const pair = w.store.getPair(w.pairId)!;
    expect(pair.mode).toBe('DONE');
    expect(JSON.parse(pair.reportJson!).unhedged).toBe('0.052');
    const alerts = w.store.listAlerts({ unackedOnly: true });
    expect(alerts.filter((a) => /UNHEDGED/.test(a.message))).toHaveLength(0);
  });

  it('[R2] persistent IOC hedge whiffs count toward the wall: backoff, then HALT — never a 1-order-per-tick spin', async () => {
    const w = mkWorld();
    await stepChecked(w);
    const maker = w.venue.liveOrder(A_CONTRACT)!;
    w.venue.fill(maker.clientText, '0.05');
    w.venue.nextIocFill = Array(20).fill(0); // empty book: every hedge whiffs
    await stepChecked(w, 30);
    const pair = w.store.getPair(w.pairId)!;
    expect(pair.mode).toBe('HALTED'); // pre-fix: spun forever in OPENING
    expect(w.venue.liveOrder(A_CONTRACT)).toBeUndefined(); // acquisition stopped
    const hedgeAttempts = [...w.venue.orders.values()].filter((o) => o.contract === B_CONTRACT);
    expect(hedgeAttempts.length).toBeLessThan(15); // backoff paced, not one per tick
    const alerts = w.store.listAlerts({ unackedOnly: true });
    expect(alerts.some((a) => /hedge wall/.test(a.message))).toBe(true);
  });

  it('[R2b] STOPPING widens deterministically, then emergency-flattens and finishes honestly', async () => {
    const w = mkWorld({ hedgeBandBp: 50 });
    await stepChecked(w);
    const maker = w.venue.liveOrder(A_CONTRACT)!;
    w.venue.fill(maker.clientText, '0.05');
    commands.stop(w.store, w.pairId);
    w.venue.nextIocFill = [0, 0, 0, 0, 0, 0, 1];
    await stepChecked(w, 50);

    const hedges = [...w.venue.orders.values()].filter((o) => o.contract === B_CONTRACT);
    expect(hedges.map((o) => o.price)).toEqual([
      '2487.5',
      '2487.5',
      '2487.5',
      '2487.5',
      '2475',
      '2450',
      null,
    ]);
    const pair = w.store.getPair(w.pairId)!;
    expect(pair.mode).toBe('DONE');
    expect(JSON.parse(pair.reportJson!)).toMatchObject({ aFilled: '0.05', bFilled: '0.05', unhedged: '0' });
    expect(
      w.store
        .listAlerts({ unackedOnly: true })
        .some((a) => /emergency flatten: slippage cap lifted after 6 failed banded attempts/.test(a.message)),
    ).toBe(true);
    assertHonestReport(w);
    assertInvariants(w);
  });

  it('[R3] stop() on a HALTED pair sticks (the wall no longer re-halts a STOPPING pair)', async () => {
    const w = mkWorld();
    await stepChecked(w);
    w.venue.fill(w.venue.liveOrder(A_CONTRACT)!.clientText, '0.05');
    w.venue.nextCreate = Array(10).fill('reject:BALANCE_NOT_ENOUGH');
    await stepChecked(w, 30);
    expect(w.store.getPair(w.pairId)!.mode).toBe('HALTED');
    commands.stop(w.store, w.pairId);
    w.venue.nextCreate = []; // wall clears
    await stepChecked(w, 8);
    const pair = w.store.getPair(w.pairId)!;
    expect(pair.mode).toBe('DONE'); // pre-fix: STOPPING bounced straight back to HALTED
    expect(JSON.parse(pair.reportJson!).bFilled).toBe('0.05');
  });

  it('[R4] a quarantined in-doubt order that the venue then purges resolves DEAD (quarantine cleared) and the pair recovers', async () => {
    const w = mkWorld();
    w.venue.nextCreate = ['unknown-delivered'];
    await stepChecked(w); // PENDING, order live on venue
    const text = [...w.venue.orders.keys()][0];
    w.venue.setRawStatus(text, 'ALIEN_STATE');
    await stepChecked(w); // probe finds alien → quarantined, still PENDING
    expect(w.store.listOrders(w.pairId)[0].quarantinedStatus).toBe('ALIEN_STATE');
    w.venue.purge(text); // venue purges it entirely (cum was 0)
    const ticksInWindow = Math.ceil(TUNING.AMBIGUITY_MS / TUNING.TICK_MS);
    await stepChecked(w, ticksInWindow + 2);
    const o = w.store.listOrders(w.pairId)[0];
    expect(o.state).toBe('DEAD');
    expect(o.quarantinedStatus).toBeNull(); // pre-fix: leaked → permanent freeze
    expect(w.venue.liveOrder(A_CONTRACT)).toBeDefined(); // pair re-minted and continues
  });

  it('[R5] fills landing DURING the convert cancel (FIX B.1.c race) are captured and hedged', async () => {
    const w = mkWorld();
    await stepChecked(w);
    w.venue.fill(w.venue.liveOrder(A_CONTRACT)!.clientText, '0.05');
    commands.convertNow(w.store, w.pairId);
    w.venue.nextCancelRace = [1]; // the whole remainder fills while the cancel is in flight
    await stepChecked(w, 8);
    assertHonestReport(w);
    const { aTrue, bTrue } = w.venue.truth();
    expect(fxStr(aTrue)).toBe('0.152'); // race fill captured in the final cum
    expect(fxStr(bTrue)).toBe('0.152'); // and fully hedged — no clip was needed
    const clips = [...w.venue.orders.values()].filter((o) => o.contract === A_CONTRACT && o.tif === 'ioc');
    expect(clips.length).toBe(0); // completion sized from the post-cancel truth
  });
});

describe('generalized deal shapes', () => {
  it('single-leg maker deal (b=null): rests with no deadline; venue-cancel = STOP with the fill kept', async () => {
    const w = mkWorld({ b: null, deadlineInMs: null });
    await stepChecked(w, 60); // far beyond any maker-pair deadline — a single rests forever
    const maker = w.venue.liveOrder(A_CONTRACT)!;
    expect(maker.tif).toBe('poc');
    w.venue.fill(maker.clientText, '0.05');
    w.venue.venueCancel(maker.clientText);
    await stepChecked(w, 4);
    const pair = w.store.getPair(w.pairId)!;
    expect(pair.mode).toBe('DONE');
    const report = JSON.parse(pair.reportJson!);
    expect(report.aFilled).toBe('0.05'); // no hedge leg, no completion — just the honest fill
    expect([...w.venue.orders.values()]).toHaveLength(1); // nothing else was ever placed
  });

  it('taker pair born in CONVERTING: alternating clips + hedges to target, hedge-first', async () => {
    const w = mkWorld({ mode: 'CONVERTING', maxClip: '0.05' });
    await stepChecked(w, 20);
    assertHonestReport(w);
    const { aTrue, bTrue } = w.venue.truth();
    expect(fxStr(aTrue)).toBe('0.152');
    expect(fxStr(bTrue)).toBe('0.152');
    const aOrders = [...w.venue.orders.values()].filter((o) => o.contract === A_CONTRACT);
    expect(aOrders.every((o) => o.tif === 'ioc')).toBe(true); // no maker ever rests
    // No band on an open: still a plain MARKET IOC, the venue's own price-limit
    // band being the cap. Only a deal carrying clipBandBp gets a priced clip.
    expect(aOrders.every((o) => o.price === null)).toBe(true);
  });

  it('single reduce-only banded close: LIMIT IOC at ref·(1 − band), reduceOnly on the wire', async () => {
    const w = mkWorld({
      mode: 'CONVERTING',
      b: null,
      a: { side: 'SELL', reduceOnly: true },
      target: '0.1',
      clipBandBp: 50,
    });
    await stepChecked(w, 3);
    const clip = [...w.venue.orders.values()][0];
    expect(clip.tif).toBe('ioc');
    // A banded clip is a MARKETABLE LIMIT at ref·(1 − band) for a SELL, which is
    // what this test's name has always said and what the close UI promises
    // verbatim ("a reduce-only IOC limit at mark ± slippage"). It previously
    // asserted price === null — the shipped behaviour — so the user's slippage
    // number was validated, persisted, and then ignored on the wire.
    // ref 2500, band 50bp → 2500 · 0.995 = 2487.5.
    expect(clip.price).toBe('2487.5');
    expect(clip.reduceOnly).toBe(true);
    expect(w.store.getPair(w.pairId)!.mode).toBe('DONE');
    expect(JSON.parse(w.store.getPair(w.pairId)!.reportJson!).aFilled).toBe('0.1');
  });

  it('close pair (both legs reduce-only): leg B follows leg A down, delta-bounded', async () => {
    const w = mkWorld({
      mode: 'CONVERTING',
      a: { side: 'SELL', reduceOnly: true },
      b: { side: 'BUY', reduceOnly: true },
      target: '0.1',
      maxClip: '0.04',
    });
    await stepChecked(w, 15);
    assertHonestReport(w);
    const { aTrue, bTrue } = w.venue.truth();
    expect(fxStr(aTrue)).toBe('0.1');
    expect(fxStr(bTrue)).toBe('0.1');
    for (const o of w.venue.orders.values()) expect(o.reduceOnly).toBe(true);
  });
});

describe('cutover-review regressions', () => {
  it('[C1] order client texts stay inside the venue 28-byte cap even for uuid deal ids', async () => {
    const store = new Store(':memory:');
    const uuidId = 'a3f8c2d1-9b4e-4c6a-8f2e-1d5b7a9c3e60';
    const mkPair = (st: Store) =>
      st.createPair({
        id: uuidId,
        mode: 'OPENING',
        a: { contract: A_CONTRACT, side: 'BUY', lot: '0.001', minSize: '0', minNotional: '0', tick: '0.01' },
        b: null,
        targetQty: '1',
        limitPrice: '1',
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
        createdAt: 0,
      });
    mkPair(store);
    const o = store.insertPendingOrder({
      pairId: uuidId,
      leg: 'A',
      kind: 'maker',
      side: 'BUY',
      qty: '1',
      price: '1',
      tif: 'poc',
      now: 0,
    });
    expect(o.clientId.length).toBeLessThanOrEqual(28);
    expect(o.clientId.startsWith('t')).toBe(true);
    // Gate CrossEx rejects any non-alphanumeric order text
    // (TRADE_CLIENT_ORDER_ID_MATCH_ERROR, "Text only support letters and
    // numbers") — so the text must be letters and digits ONLY, no separators.
    expect(o.clientId).toMatch(/^[A-Za-z0-9]+$/);
    // Deterministic from durable state: the same id + seq → the same text.
    const store2 = new Store(':memory:');
    mkPair(store2);
    const o2 = store2.insertPendingOrder({
      pairId: uuidId, leg: 'A', kind: 'maker', side: 'BUY', qty: '1', price: '1', tif: 'poc', now: 0,
    });
    expect(o2.clientId).toBe(o.clientId);
    store.close();
    store2.close();
  });

  it('[C1b] avgFillPrice is the cum-weighted mean of a leg order fills, null when none', () => {
    const store = new Store(':memory:');
    store.createPair({
      id: 'p1', mode: 'OPENING',
      a: { contract: A_CONTRACT, side: 'BUY', lot: '0.001', minSize: '0', minNotional: '0', tick: '0.01' },
      b: { contract: B_CONTRACT, side: 'SELL', lot: '0.001', minSize: '0', minNotional: '0', tick: '0.01' },
      targetQty: '0.2', limitPrice: '100', pricePolicy: 'fixed', deadlineAt: null,
      makerNotBefore: 0, hedgeNotBefore: 0, pocRejects: 0, hedgeRejectStreak: 0,
      maxClip: null, clipBandBp: null, hedgeBandBp: null, haltReason: null, reportJson: null, createdAt: 0,
    });
    const filled = (leg: 'A' | 'B', side: 'BUY' | 'SELL', cum: string, avg: string) => {
      const o = store.insertPendingOrder({ pairId: 'p1', leg, kind: 'maker', side, qty: cum, price: avg, tif: 'poc', now: 0 });
      store.updateOrder('p1', leg, o.seq, { cumQty: cum, avgFillPrice: avg });
    };
    // Leg A: two re-peg orders at different prices → cum-weighted mean, not arithmetic.
    filled('A', 'BUY', '0.05', '100');
    filled('A', 'BUY', '0.15', '120');
    // (0.05·100 + 0.15·120) / 0.20 = 23 / 0.20 = 115
    expect(store.avgFillPrice('p1', 'A')).toBe('115');
    // Leg B: single filled clip → that price exactly.
    filled('B', 'SELL', '0.2', '118.5');
    expect(store.avgFillPrice('p1', 'B')).toBe('118.5');
    // An order that never filled (cum 0) or has no venue avg (0) is skipped.
    store.insertPendingOrder({ pairId: 'p1', leg: 'A', kind: 'maker', side: 'BUY', qty: '9', price: '999', tif: 'poc', now: 0 });
    expect(store.avgFillPrice('p1', 'A')).toBe('115');
    // A leg with no filled orders has no average.
    expect(store.avgFillPrice('p1', 'NONE')).toBeNull();
    store.close();
  });

  it('[C1c] dealFillReports returns only usable two-leg non-exit DONE deals, ordered', () => {
    const store = new Store(':memory:');
    const base = {
      a: { contract: A_CONTRACT, side: 'SELL' as const, lot: '0.001', minSize: '0', minNotional: '0', tick: '0.01' },
      b: { contract: B_CONTRACT, side: 'BUY' as const, lot: '0.001', minSize: '0', minNotional: '0', tick: '0.01' },
      targetQty: '1', limitPrice: null, pricePolicy: 'touch' as const, deadlineAt: null,
      makerNotBefore: 0, hedgeNotBefore: 0, pocRejects: 0, hedgeRejectStreak: 0,
      maxClip: null, clipBandBp: null, hedgeBandBp: null, haltReason: null,
    };
    const report = JSON.stringify({ aFilled: '1', bFilled: '1', unhedged: '0', reason: 'target reached', aAvgFill: '100.5', bAvgFill: '100.6' });
    // Usable, out of created_at order to pin the ORDER BY.
    store.createPair({ ...base, id: 'later', mode: 'DONE', reportJson: report, createdAt: 2_000 });
    store.createPair({ ...base, id: 'earlier', mode: 'DONE', reportJson: report, createdAt: 1_000 });
    // Excluded: still running, single-leg, both-reduce-only (an exit), corrupt
    // report, and a report whose hedge leg never got an avg fill.
    store.createPair({ ...base, id: 'running', mode: 'OPENING', reportJson: null, createdAt: 3_000 });
    store.createPair({ ...base, id: 'single', b: null, mode: 'DONE', reportJson: report, createdAt: 3_100 });
    store.createPair({
      ...base, id: 'exit', mode: 'DONE', reportJson: report, createdAt: 3_200,
      a: { ...base.a, reduceOnly: true }, b: { ...base.b, reduceOnly: true },
    });
    store.createPair({ ...base, id: 'corrupt', mode: 'DONE', reportJson: '{not json', createdAt: 3_300 });
    store.createPair({
      ...base, id: 'no-avg', mode: 'DONE', createdAt: 3_400,
      reportJson: JSON.stringify({ aFilled: '1', bFilled: '1', aAvgFill: '100.5', bAvgFill: null }),
    });
    // A one-reduce/one-open migration deal stays in.
    store.createPair({
      ...base, id: 'migration', mode: 'DONE', reportJson: report, createdAt: 4_000,
      a: { ...base.a, reduceOnly: true },
    });

    const rows = store.dealFillReports();
    expect(rows.map((r) => r.createdAtMs)).toEqual([1_000, 2_000, 4_000]);
    expect(rows[0]).toMatchObject({
      aContract: A_CONTRACT, aSide: 'SELL', bContract: B_CONTRACT, bSide: 'BUY',
      aFilled: '1', bFilled: '1', aAvgFill: '100.5', bAvgFill: '100.6',
    });
    store.close();
  });

  it('[C2] a venue-cancel observed AFTER the deadline is honored as STOP, never converted', async () => {
    const w = mkWorld({ deadlineInMs: 10_000 });
    await stepChecked(w);
    const maker = w.venue.liveOrder(A_CONTRACT)!;
    w.venue.fill(maker.clientText, '0.05');
    w.venue.venueCancel(maker.clientText); // user kills it on the exchange…
    w.clock.advance(60_000); // …and the next tick lands after deadlineAt
    await stepChecked(w, 5);
    const pair = w.store.getPair(w.pairId)!;
    expect(pair.mode).toBe('DONE');
    const report = JSON.parse(pair.reportJson!);
    expect(report.aFilled).toBe('0.05'); // NOT market-bought to 0.152
    expect(report.bFilled).toBe('0.05');
  });

  it('[C3] persistent A-clip rejects (position vanished) terminate the deal honestly with an alert', async () => {
    const w = mkWorld({ mode: 'CONVERTING', b: null, a: { side: 'SELL', reduceOnly: true }, target: '0.1' });
    w.venue.nextCreate = Array(10).fill('reject:REDUCE_ONLY');
    await stepChecked(w, 40); // budget of 5, 2s backoff between attempts
    const pair = w.store.getPair(w.pairId)!;
    expect(pair.mode).toBe('DONE'); // pre-fix: CONVERTING forever, one reject every 2s
    const report = JSON.parse(pair.reportJson!);
    expect(report.aFilled).toBe('0');
    expect(report.reason).toContain('failing repeatedly');
    expect(w.venue.createCalls.length).toBeLessThanOrEqual(6); // budget-bounded, not unbounded
    const alerts = w.store.listAlerts({ unackedOnly: true });
    expect(alerts.some((a) => /A-leg wall/.test(a.message))).toBe(true);
  });

  it('[C4] persistent banded-clip whiffs are budget-bounded too (no one-order-per-tick spin)', async () => {
    const w = mkWorld({ mode: 'CONVERTING', b: null, target: '0.1', clipBandBp: 10 });
    w.venue.nextIocFill = Array(20).fill(0); // spread wider than the band: every clip whiffs
    await stepChecked(w, 40);
    const pair = w.store.getPair(w.pairId)!;
    expect(pair.mode).toBe('DONE');
    expect(w.venue.createCalls.length).toBeLessThanOrEqual(6); // backoff + budget, not 1/tick
    expect(JSON.parse(pair.reportJson!).reason).toContain('failing repeatedly');
  });

  it('[C5] a close pair uses banded LIMIT IOC legs and still finishes honestly', async () => {
    const w = mkWorld({
      mode: 'CONVERTING',
      a: { side: 'SELL', reduceOnly: true },
      b: { side: 'BUY', reduceOnly: true },
      target: '0.1',
      clipBandBp: 50,
    });
    await stepChecked(w, 8);
    const aOrders = [...w.venue.orders.values()].filter((o) => o.contract === A_CONTRACT);
    const bOrders = [...w.venue.orders.values()].filter((o) => o.contract === B_CONTRACT);
    expect(aOrders).toHaveLength(1);
    expect(bOrders).toHaveLength(1);
    expect(aOrders[0]).toMatchObject({ price: '2487.5', reduceOnly: true, tif: 'ioc' });
    expect(bOrders[0]).toMatchObject({ price: '2512.5', reduceOnly: true, tif: 'ioc' });
    assertHonestReport(w);
  });

  it('[C6] a single-leg DONE report reads unhedged 0 (no false dust alarm)', async () => {
    const w = mkWorld({ mode: 'CONVERTING', b: null, target: '0.1' });
    await stepChecked(w, 4);
    const report = JSON.parse(w.store.getPair(w.pairId)!.reportJson!);
    expect(report.aFilled).toBe('0.1');
    expect(report.unhedged).toBe('0'); // pre-fix: '0.1' — the whole fill flagged as unhedged
  });

  it('[C7] A-leg fills reset the failure budget (occasional whiffs never accumulate into a stop)', async () => {
    const w = mkWorld({ mode: 'CONVERTING', b: null, target: '0.1', maxClip: '0.02' });
    // Alternate whiff, fill, whiff, fill… — 5 whiffs total but never consecutive past the cap.
    w.venue.nextIocFill = [0, 1, 0, 1, 0, 1, 0, 1, 0, 1];
    await stepChecked(w, 60);
    const pair = w.store.getPair(w.pairId)!;
    expect(pair.mode).toBe('DONE');
    expect(JSON.parse(pair.reportJson!).aFilled).toBe('0.1'); // completed despite interleaved whiffs
    expect(JSON.parse(pair.reportJson!).reason).not.toContain('failing repeatedly');
  });
});

describe('loop pacing (Stop must feel instant)', () => {
  it('a Stop converges through startLoop in fast-tick time (work-conserving pacing + wake)', async () => {
    // Real timers, tiny intervals: the loop must chain hedge → cancel → observe
    // → finish at FAST_TICK_MS between ACTING passes — not one step per TICK_MS.
    // No deadline: this test swaps in the REAL clock (startLoop paces with real
    // setTimeout), and the sim's virtual-clock deadline would read as long past.
    const w = mkWorld({ deadlineInMs: null });
    const abort = new AbortController();
    const deps = { ...w.deps, clock: { now: () => Date.now() }, tuning: { TICK_MS: 400, FAST_TICK_MS: 10 } };
    const loop = startLoop(deps, { signal: abort.signal });
    try {
      await new Promise((r) => setTimeout(r, 50)); // first pass places the maker
      const maker = w.venue.liveOrder(A_CONTRACT)!;
      expect(maker).toBeDefined();
      w.venue.fill(maker.clientText, '0.05');

      const t0 = Date.now();
      commands.stop(w.store, w.pairId);
      loop.wake();
      // Stop = observe fill → hedge → cancel maker → observe terminal → finish.
      // With TICK_MS=400 and ~5 steps, per-tick pacing would need ~2s; the
      // work-conserving loop must finish well under one TICK_MS-sized budget.
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error('stop did not converge in time')), 1_500);
        const poll = setInterval(() => {
          if (w.store.getPair(w.pairId)!.mode === 'DONE') {
            clearTimeout(deadline);
            clearInterval(poll);
            resolve();
          }
        }, 10);
      });
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeLessThan(1_000);
      const report = JSON.parse(w.store.getPair(w.pairId)!.reportJson!);
      expect(report.aFilled).toBe('0.05');
      expect(report.bFilled).toBe('0.05');
    } finally {
      abort.abort();
    }
  });
});

describe('stop on an in-doubt maker (the slow-stop fix)', () => {
  it('cancels an in-doubt (PENDING) maker immediately on Stop — never waits out the resolution window', async () => {
    const w = mkWorld();
    // The maker create goes UNKNOWN but the order IS live on the venue: it sits
    // PENDING (in-doubt) — the state that used to freeze Stop for ~90s.
    w.venue.nextCreate = ['unknown-delivered'];
    await stepChecked(w);
    expect(w.store.listOrders(w.pairId)[0].state).toBe('PENDING');
    const makerText = [...w.venue.orders.keys()][0];

    commands.stop(w.store, w.pairId);
    await stepChecked(w); // ONE tick: cancel bypasses the freeze
    expect(w.store.listOrders(w.pairId)[0].cancelRequested).toBe(1);
    // The venue order was actually canceled (not left resting for 90s).
    expect(w.venue.orders.get(makerText)!.rawStatus).toBe('CANCELLED');

    await stepChecked(w, 3); // observe terminal → finish
    const pair = w.store.getPair(w.pairId)!;
    expect(pair.mode).toBe('DONE');
    expect(JSON.parse(pair.reportJson!).aFilled).toBe('0'); // nothing filled, cleanly stopped
    // Never waited the ambiguity window: resolved in a handful of ticks.
    expect(w.venue.createCalls.length).toBe(1);
  });

  it('does NOT fetch venue prices while frozen or stopping (no blocking on a slow hedge venue)', async () => {
    const w = mkWorld({ pricePolicy: 'touch' });
    let touchCalls = 0;
    let refCalls = 0;
    const origTouch = w.venue.touch.bind(w.venue);
    const origRef = w.venue.refPrice.bind(w.venue);
    w.venue.touch = async (...a) => { touchCalls++; return origTouch(...a); };
    w.venue.refPrice = async (...a) => { refCalls++; return origRef(...a); };

    await stepChecked(w); // places the maker (needs a touch)
    w.venue.nextCreate = ['unknown-delivered']; // next order lands in-doubt
    const maker = w.venue.liveOrder(A_CONTRACT)!;
    w.venue.fill(maker.clientText, '0.05');
    commands.stop(w.store, w.pairId);
    const before = { touchCalls, refCalls };
    await stepChecked(w, 2); // stopping: cancel maker, then observe — no pricing needed
    // A stop cancels + finishes without fetching the (slow) hedge-venue book.
    expect(touchCalls).toBe(before.touchCalls); // no maker placement → no touch
  });
});

describe('recovery is the loop', () => {
  it('a "restart" mid-flight (fresh tick over the same DB) continues seamlessly', async () => {
    const w = mkWorld();
    await stepChecked(w);
    const maker = w.venue.liveOrder(A_CONTRACT)!;
    w.venue.fill(maker.clientText, '0.07'); // fills while "down"
    // Simulate a long outage: the process saw nothing; state is only in the DB.
    w.clock.advance(600_000); // past the deadline while down
    await stepChecked(w, 8); // first tick observes: deadline passed → convert
    assertHonestReport(w);
    const { aTrue, bTrue } = w.venue.truth();
    expect(fxStr(aTrue)).toBe('0.152'); // completed to target
    expect(fxStr(bTrue)).toBe('0.152');
  });
});

describe('venue statuses the decoder has not met', () => {
  // Live case (2026-07-31): CrossEx answered "FAIL" (label
  // NOT_BEST_ACCOUNT_ROUTER, "all trading channels are currently busy"). The
  // decoder knew FAILED but not FAIL, so a dead order quarantined and froze
  // its pair, and Stop could never finish it.
  it('decodes FAIL as terminal, like REJECT/REJECTED', async () => {
    const w = mkWorld();
    await stepChecked(w);
    const maker = w.venue.liveOrder(A_CONTRACT)!;
    w.venue.setRawStatus(maker.clientText, 'FAIL');
    await stepChecked(w, 2);

    const o = w.store.listOrders(w.pairId).find((x) => x.leg === 'A')!;
    expect(o.quarantinedStatus).toBeNull(); // NOT frozen
    expect(o.state).toBe('CLOSED');
    // 'rejected:', never 'cancelled' — the latter reads as a user STOP and
    // would permanently relinquish the acquisition.
    expect(o.closeReason).toMatch(/^rejected:/);
  });

  it("keeps the venue's own reason so the UI can explain the rejection", async () => {
    const w = mkWorld();
    await stepChecked(w);
    const maker = w.venue.liveOrder(A_CONTRACT)!;
    const reason = '{"label":"NOT_BEST_ACCOUNT_ROUTER","message":"All trading channels are busy."}';
    w.venue.orders.get(maker.clientText)!.reason = reason;
    w.venue.setRawStatus(maker.clientText, 'FAIL');
    await stepChecked(w, 2);

    expect(w.store.listOrders(w.pairId).find((x) => x.leg === 'A')!.venueReason).toBe(reason);
  });

  // The general escape hatch: a status that stays unclassifiable forever used
  // to wedge the deal, because quarantine only clears on a LATER known status.
  // Stop spun on "settling what filled" indefinitely.
  it('Stop finishes a deal frozen on a status that never resolves', async () => {
    const w = mkWorld();
    await stepChecked(w);
    const maker = w.venue.liveOrder(A_CONTRACT)!;
    w.venue.setRawStatus(maker.clientText, 'WAT'); // venue will keep saying this
    await stepChecked(w, 2);

    const frozen = w.store.listOrders(w.pairId).find((x) => x.leg === 'A')!;
    expect(frozen.quarantinedStatus).toBe('WAT');
    expect(w.store.getPair(w.pairId)!.mode).toBe('OPENING');

    commands.stop(w.store, w.pairId);
    await stepChecked(w, 4);

    const o = w.store.listOrders(w.pairId).find((x) => x.leg === 'A')!;
    expect(o.quarantinedStatus).toBeNull();
    expect(o.state).toBe('CLOSED');
    expect(o.closeReason).toBe('force-resolved:WAT');
    // The deal actually settles instead of spinning.
    expect(w.store.getPair(w.pairId)!.mode).toBe('DONE');
    assertInvariants(w);
  });

  it('never abandons a stuck order the venue will not confirm dead', async () => {
    // If the cancel cannot be confirmed, the order might still be live and
    // filling: staying frozen is correct, silently closing it is not.
    const w = mkWorld();
    await stepChecked(w);
    const maker = w.venue.liveOrder(A_CONTRACT)!;
    w.venue.setRawStatus(maker.clientText, 'WAT');
    await stepChecked(w, 2);
    w.venue.cancelsFail = true; // venue cannot confirm anything

    commands.stop(w.store, w.pairId);
    await stepChecked(w, 4);

    const o = w.store.listOrders(w.pairId).find((x) => x.leg === 'A')!;
    expect(o.quarantinedStatus).toBe('WAT'); // still frozen, on purpose
    expect(w.store.getPair(w.pairId)!.mode).toBe('STOPPING');
  });
});
