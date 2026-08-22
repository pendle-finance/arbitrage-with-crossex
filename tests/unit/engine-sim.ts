/**
 * Simulation harness for the engine (not a test file): an adversarial fake
 * venue with scriptable wire outcomes, a virtual clock, and invariant checks
 * against VENUE TRUTH (not the engine's own books — that's the point).
 */
import { strict as assert } from 'node:assert';
import { Store } from '../../src/engine/db';
import { fx, fxMin, fxStr, type Fx } from '../../src/engine/fx';
import { tickPair, type LoopDeps } from '../../src/engine/loop';
import {
  TUNING,
  type CancelOutcome,
  type CreateOutcome,
  type LegSpec,
  type PairRow,
  type ReadOutcome,
  type Side,
  type SweepResult,
  type VenuePort,
} from '../../src/engine/types';

export const A_CONTRACT = 'HYPERLIQUID_FUTURE_ETH_USDC';
export const B_CONTRACT = 'OKX_FUTURE_ETH_USDT';

export type CreateDirective =
  | 'ok'
  | 'insta-cancel' // POC accepted-then-instantly-canceled (would cross)
  | 'unknown-delivered' // wire says unknown, the order WAS created & processed
  | 'unknown-lost' // wire says unknown, the order never reached the venue
  | `reject:${string}`;

interface SimOrder {
  venueOrderId: string;
  clientText: string;
  contract: string;
  side: Side;
  qty: Fx;
  price: string | null;
  tif: 'poc' | 'ioc';
  reduceOnly: boolean;
  cum: Fx;
  rawStatus: string;
  reason: string;
}

export class FakeVenue implements VenuePort {
  orders = new Map<string, SimOrder>(); // by clientText
  createCalls: string[] = []; // every create() call's clientText, in order
  nextCreate: CreateDirective[] = []; // consumed per create; default 'ok'
  /** Fill ratio applied to the next IOC creates (1 = full fill, 0 = whiff). */
  nextIocFill: number[] = [];
  readsFail = false;
  sweepCoverage = true;
  touchA: string | null = '2500';
  refPrices = new Map<string, string>([[A_CONTRACT, '2500'], [B_CONTRACT, '2500']]);
  private nextId = 1;

  private mkOrder(req: {
    contract: string;
    side: Side;
    qty: string;
    price?: string;
    tif: 'poc' | 'ioc';
    reduceOnly?: boolean;
    clientText: string;
  }): SimOrder {
    const o: SimOrder = {
      venueOrderId: `V${this.nextId++}`,
      clientText: req.clientText,
      contract: req.contract,
      side: req.side,
      qty: fx(req.qty),
      price: req.price ?? null,
      tif: req.tif,
      reduceOnly: Boolean(req.reduceOnly),
      cum: 0n,
      rawStatus: 'NEW',
      reason: '',
    };
    this.orders.set(req.clientText, o);
    return o;
  }

  async create(req: Parameters<VenuePort['create']>[0]): Promise<CreateOutcome> {
    this.createCalls.push(req.clientText);
    if (this.orders.has(req.clientText)) {
      throw new Error(`sim: duplicate clientText submitted to venue: ${req.clientText}`);
    }
    const directive = this.nextCreate.shift() ?? 'ok';
    if (directive.startsWith('reject:')) {
      return { kind: 'reject', label: directive.slice(7), message: directive };
    }
    if (directive === 'unknown-lost') {
      return { kind: 'unknown', message: 'sim: connection reset (order lost)' };
    }
    const o = this.mkOrder(req);
    if (directive === 'insta-cancel') {
      // Live-verified CrossEx shape (2026-07-23): a would-cross POC is ACCEPTED
      // and lands in state REJECT with a "label: ORDER_POC_IMMEDIATE, …" reason.
      o.rawStatus = 'REJECT';
      o.reason = 'label: ORDER_POC_IMMEDIATE, message: order price would cross';
    } else if (req.tif === 'ioc') {
      const ratio = this.nextIocFill.shift() ?? 1;
      o.cum = ratio >= 1 ? o.qty : (o.qty * BigInt(Math.round(ratio * 1000))) / 1000n;
      o.rawStatus = o.cum === o.qty ? 'FINISHED' : 'IOC_CANCELLED';
    }
    if (directive === 'unknown-delivered') {
      return { kind: 'unknown', message: 'sim: response lost (order delivered)' };
    }
    return { kind: 'ok', snapshot: this.snapshot(o) };
  }

  private snapshot(o: SimOrder) {
    return {
      venueOrderId: o.venueOrderId,
      rawStatus: o.rawStatus,
      cumQty: fxStr(o.cum),
      // A marketable IOC executes at the simulated touch/reference; its limit is
      // only the worst-price guard. A resting maker executes at its own price.
      avgFillPrice:
        o.cum > 0n
          ? o.tif === 'ioc'
            ? this.refPrices.get(o.contract) ?? o.price ?? '0'
            : o.price ?? '0'
          : '0',
      reason: o.reason,
    };
  }

  /** Fill ratio (of the remaining qty) applied DURING the next cancels — the
   * FIX B.1.c race: fills legally land while a cancel is in flight. */
  nextCancelRace: number[] = [];

  /** The venue cannot confirm cancels (outage). A cancel that is not confirmed
   * proves nothing, so the engine must keep treating the order as possibly live. */
  cancelsFail = false;

  async cancel(ref: { venueOrderId?: string; clientText: string }): Promise<CancelOutcome> {
    if (this.cancelsFail) return { kind: 'unknown', message: 'venue unreachable' };
    const o = this.byRef(ref);
    if (!o) return { kind: 'ok' }; // not found = already terminal = success
    if (o.rawStatus === 'NEW' || o.rawStatus === 'OPEN') {
      const race = this.nextCancelRace.shift() ?? 0;
      if (race > 0) {
        const remaining = o.qty - o.cum;
        o.cum += (remaining * BigInt(Math.round(race * 100))) / 100n;
      }
      o.rawStatus = o.cum === o.qty ? 'FILLED' : 'CANCELLED';
    }
    return { kind: 'ok' };
  }

  /** Venue purges an order entirely (it stops being readable) — pairs with an
   * alien status to reproduce quarantine-then-absent flows. */
  purge(clientText: string): void {
    this.orders.delete(clientText);
  }

  private byRef(ref: { venueOrderId?: string; clientText?: string }): SimOrder | undefined {
    if (ref.venueOrderId) {
      for (const o of this.orders.values()) if (o.venueOrderId === ref.venueOrderId) return o;
      return undefined;
    }
    return ref.clientText ? this.orders.get(ref.clientText) : undefined;
  }

  async getOrder(ref: { venueOrderId?: string; clientText: string }): Promise<ReadOutcome> {
    if (this.readsFail) return { kind: 'error', message: 'sim: venue read outage' };
    const o = this.byRef(ref);
    return o ? { kind: 'found', snapshot: this.snapshot(o) } : { kind: 'notFound' };
  }

  async sweepForOrder(contract: string, clientText: string): Promise<SweepResult> {
    if (this.readsFail || !this.sweepCoverage) return { covered: false };
    const o = this.orders.get(clientText);
    if (o && o.contract === contract) return { covered: true, found: this.snapshot(o) };
    return { covered: true };
  }

  async touch(_c?: string, _s?: Side, _t?: string): Promise<string | null> {
    return this.readsFail ? null : this.touchA;
  }

  async refPrice(contract: string): Promise<string | null> {
    return this.readsFail ? null : (this.refPrices.get(contract) ?? null);
  }

  // ---- test hooks (venue-side reality) ----

  /** Advance the resting maker's fill (venue truth). */
  fill(clientText: string, qty: string): void {
    const o = this.orders.get(clientText);
    if (!o) throw new Error(`sim: no order ${clientText}`);
    if (o.rawStatus !== 'NEW' && o.rawStatus !== 'OPEN') return; // terminal orders can't fill
    o.cum = fxMin(o.qty, o.cum + fx(qty));
    if (o.cum === o.qty) o.rawStatus = 'FILLED';
  }

  /** The user cancels the order on the venue UI (not through the engine). */
  venueCancel(clientText: string): void {
    const o = this.orders.get(clientText);
    if (o && (o.rawStatus === 'NEW' || o.rawStatus === 'OPEN')) o.rawStatus = 'CANCELLED';
  }

  setRawStatus(clientText: string, raw: string): void {
    const o = this.orders.get(clientText);
    if (o) o.rawStatus = raw;
  }

  /** Live (non-terminal) order for a contract, if any. */
  liveOrder(contract: string): SimOrder | undefined {
    for (const o of this.orders.values()) {
      if (o.contract === contract && (o.rawStatus === 'NEW' || o.rawStatus === 'OPEN')) return o;
    }
    return undefined;
  }

  /** VENUE TRUTH: total filled per contract — the invariant baseline. */
  truth(): { aTrue: Fx; bTrue: Fx } {
    let aTrue = 0n;
    let bTrue = 0n;
    for (const o of this.orders.values()) {
      if (o.contract === A_CONTRACT) aTrue += o.cum;
      else if (o.contract === B_CONTRACT) bTrue += o.cum;
    }
    return { aTrue, bTrue };
  }
}

export class VirtualClock {
  t = 1_000_000_000_000;
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

export interface World {
  store: Store;
  venue: FakeVenue;
  clock: VirtualClock;
  deps: LoopDeps;
  pairId: string;
  /** Run n ticks, advancing the clock by TICK_MS after each. */
  step(n?: number): Promise<void>;
}

export function legSpec(contract: string, side: Side, over?: Partial<LegSpec>): LegSpec {
  return { contract, side, lot: '0.001', minSize: '0', minNotional: '0', tick: '0.01', ...over };
}

export function mkWorld(opts?: {
  target?: string;
  limitPrice?: string;
  pricePolicy?: 'fixed' | 'touch';
  deadlineInMs?: number | null;
  mode?: PairRow['mode'];
  a?: Partial<LegSpec>;
  /** null = single-leg deal (no hedge leg). */
  b?: Partial<LegSpec> | null;
  maxClip?: string;
  clipBandBp?: number;
  hedgeBandBp?: number;
  crashAfterCommit?: () => boolean;
}): World {
  const store = new Store(':memory:');
  const venue = new FakeVenue();
  const clock = new VirtualClock();
  const pairId = 'p1';
  const pair: PairRow = {
    id: pairId,
    mode: opts?.mode ?? 'OPENING',
    a: legSpec(A_CONTRACT, 'BUY', opts?.a),
    b: opts?.b === null ? null : legSpec(B_CONTRACT, 'SELL', opts?.b ?? undefined),
    targetQty: opts?.target ?? '0.152',
    limitPrice: opts?.limitPrice ?? '2500',
    pricePolicy: opts?.pricePolicy ?? 'fixed',
    deadlineAt: opts?.deadlineInMs === null ? null : clock.now() + (opts?.deadlineInMs ?? 300_000),
    makerNotBefore: 0,
    hedgeNotBefore: 0,
    pocRejects: 0,
    hedgeRejectStreak: 0,
    maxClip: opts?.maxClip ?? null,
    clipBandBp: opts?.clipBandBp ?? null,
    hedgeBandBp: opts?.hedgeBandBp ?? null,
    haltReason: null,
    reportJson: null,
    createdAt: clock.now(),
  };
  store.createPair(pair);
  const deps: LoopDeps = {
    store,
    venue,
    clock,
    crashAfterCommit: opts?.crashAfterCommit,
  };
  return {
    store,
    venue,
    clock,
    deps,
    pairId,
    async step(n = 1): Promise<void> {
      for (let i = 0; i < n; i++) {
        await tickPair(deps, pairId);
        clock.advance(TUNING.TICK_MS);
      }
    },
  };
}

/** The prime invariants, checked against VENUE truth. Call after every step. */
export function assertInvariants(w: World): void {
  const { aTrue, bTrue } = w.venue.truth();
  assert.ok(bTrue <= aTrue, `OVER-HEDGE: hedge filled ${fxStr(bTrue)} > maker filled ${fxStr(aTrue)}`);
  const pair = w.store.getPair(w.pairId)!;
  assert.ok(
    aTrue <= fx(pair.targetQty),
    `OVER-ACQUIRE: maker leg filled ${fxStr(aTrue)} > target ${pair.targetQty}`,
  );
  const texts = w.venue.createCalls;
  assert.equal(new Set(texts).size, texts.length, `duplicate clientText submitted: ${texts.join(',')}`);
}

/** Honest-terminal check: the DONE report matches venue truth exactly. */
export function assertHonestReport(w: World): void {
  const pair = w.store.getPair(w.pairId)!;
  assert.equal(pair.mode, 'DONE');
  const report = JSON.parse(pair.reportJson!) as { aFilled: string; bFilled: string };
  const { aTrue, bTrue } = w.venue.truth();
  assert.equal(report.aFilled, fxStr(aTrue), 'report aFilled ≠ venue truth');
  assert.equal(report.bFilled, fxStr(bTrue), 'report bFilled ≠ venue truth');
}
