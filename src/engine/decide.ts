/**
 * The pure heart of the engine: projections (folds over the order registry)
 * and decide() — a pure function from (intent, projection, now, prices) to THE
 * single next action. No IO, no clocks, no randomness: this file plus the
 * submission protocol in loop.ts is the whole correctness review surface.
 */
import { roundToStep, sigFigsDirectional, stripZeros } from '../core/numbers';
import { fx, fxCeilToStep, fxFloorToStep, fxMax, fxMin, fxMul, fxStr, FX_ZERO, type Fx } from './fx';
import {
  TUNING,
  type Action,
  type LegSpec,
  type OrderRow,
  type PairRow,
  type Projection,
  type Report,
  type Tuning,
} from './types';

/** A close reason counts as a post-only rejection (requote), not a user STOP. */
export const POC_REASON = /POC|POST[-_ ]?ONLY|IMMEDIATE/i;

/**
 * Reservation accounting — the no-double-spend spine:
 *   reserved = full qty while PENDING/OPEN (in-doubt counts FULL — pessimism can
 *   only produce visible under-hedge, never over-hedge), final cum when CLOSED,
 *   0 when DEAD. Filled = Σ cum regardless of state.
 */
export function project(pair: PairRow, orders: OrderRow[]): Projection {
  let aFilled = FX_ZERO;
  let aReserved = FX_ZERO;
  let bFilled = FX_ZERO;
  let bReserved = FX_ZERO;
  let makerOrder: OrderRow | null = null;
  let anyPending = false;
  let anyQuarantined = false;
  let quarantinedOrder: OrderRow | null = null;

  for (const o of orders) {
    const cum = fx(o.cumQty);
    const reserved =
      o.state === 'PENDING' || o.state === 'OPEN' ? fx(o.qty) : o.state === 'CLOSED' ? cum : FX_ZERO;
    if (o.leg === 'A') {
      aFilled += cum;
      aReserved += reserved;
      if (o.kind === 'maker' && (!makerOrder || o.seq > makerOrder.seq)) makerOrder = o;
    } else {
      bFilled += cum;
      bReserved += reserved;
    }
    if (o.state === 'PENDING') anyPending = true;
    if (o.quarantinedStatus) {
      anyQuarantined = true;
      quarantinedOrder ??= o;
    }
  }

  const target = fx(pair.targetQty);
  return {
    aFilled: fxStr(aFilled),
    aReserved: fxStr(aReserved),
    bFilled: fxStr(bFilled),
    bReserved: fxStr(bReserved),
    unhedged: fxStr(fxMax(FX_ZERO, aFilled - bReserved)),
    residualA: fxStr(fxMax(FX_ZERO, target - aReserved)),
    makerOrder,
    anyPending,
    anyQuarantined,
    quarantinedOrder,
    allSettled:
      !anyPending &&
      !anyQuarantined &&
      orders.every((o) => o.state === 'CLOSED' || o.state === 'DEAD'),
  };
}

/**
 * Floor a raw quantity to a submittable size for a leg: floored DOWN to the lot,
 * zero when below minSize or below minNotional at `refPrice`. There is no
 * round-up path anywhere in the engine (hazard 8). When minNotional applies but
 * no reference price is available, returns null: "cannot size safely right now"
 * (the caller idles this tick rather than guessing).
 */
export function sizeFor(raw: Fx, leg: LegSpec, refPrice: string | null): Fx | null {
  const lot = fx(leg.lot);
  const floored = fxFloorToStep(raw, lot);
  if (floored <= FX_ZERO) return FX_ZERO;
  if (floored < fx(leg.minSize)) return FX_ZERO;
  const minNotional = fx(leg.minNotional);
  if (minNotional > FX_ZERO) {
    if (refPrice === null) return null;
    if (fxMul(floored, fx(refPrice)) < minNotional) return FX_ZERO;
  }
  return floored;
}

export interface DecideCtx {
  /** Fresh maker peg price on the maker contract — one bid–ask gap behind the
   * same-side touch (null = book unavailable). */
  touchA: string | null;
  /** Reference price on the hedge contract for min-notional sizing (null = unavailable). */
  refB: string | null;
  /** Reference price on the maker contract for min-notional sizing of convert clips. */
  refA: string | null;
  maxClip: string;
  /** Effective loop policy. Optional only for direct pure-function callers. */
  tuning?: Pick<Tuning, 'HEDGE_REJECT_HALT' | 'HEDGE_EMERGENCY_STREAK' | 'HEDGE_EMERGENCY_MAX_BP'>;
}

/** Marketable-limit price for a banded clip: ref·(1 ± bandBp/10000),
 * integer-exact (no float multipliers — 1 + 0.33/100 has float dust the fx
 * layer rejects), tick-rounded so the fill can never be worse than the band:
 * BUY floors (≤ ref·(1+band)), SELL ceils (≥ ref·(1−band)). Hyperliquid legs
 * are additionally capped to 5 significant figures IN THE SAME (band-preserving)
 * direction — HL rejects 6-sig-fig prices (TRADE_HYPERLIQUID_PRICE_SIGNIFICANT_
 * FIGURES_ERROR, verified live 2026-07-23). */
export function clipBandPrice(ref: string, leg: LegSpec, bandBp: number): string {
  const refFx = fx(ref);
  const bp = BigInt(Math.max(0, Math.round(bandBp)));
  const tick = fx(leg.tick);
  const dir = leg.side === 'BUY' ? 'down' : 'up';
  const raw =
    leg.side === 'BUY'
      ? fxFloorToStep((refFx * (10_000n + bp)) / 10_000n, tick)
      : fxCeilToStep((refFx * (10_000n - bp)) / 10_000n, tick);
  if (leg.contract.startsWith('HYPERLIQUID_')) {
    const capped = sigFigsDirectional(Number(fxStr(raw)), 5, dir);
    return stripZeros(roundToStep(capped, leg.tick, dir));
  }
  return fxStr(raw);
}

/** Effective hedge band is a pure fold of durable deal state. Acquiring modes
 * always retain the configured cap. Once acquisition has stopped, each full
 * hedge-wall threshold step doubles the cap up to the emergency maximum; after
 * the persistent emergency streak the cap is lifted only to drain exposure that
 * is already naked. Null therefore means MARKET only in STOPPING/HALTED. */
export function hedgeBandFor(
  pair: PairRow,
  policy: Pick<Tuning, 'HEDGE_REJECT_HALT' | 'HEDGE_EMERGENCY_STREAK' | 'HEDGE_EMERGENCY_MAX_BP'> = TUNING,
): number | null {
  const base = pair.hedgeBandBp ?? TUNING.HEDGE_BAND_BP;
  const draining = pair.mode === 'STOPPING' || pair.mode === 'HALTED';
  if (!draining) return base;
  if (pair.hedgeRejectStreak >= policy.HEDGE_EMERGENCY_STREAK) return null;
  const step = Math.max(0, pair.hedgeRejectStreak - policy.HEDGE_REJECT_HALT);
  return Math.min(base * 2 ** step, policy.HEDGE_EMERGENCY_MAX_BP);
}

function report(pair: PairRow, p: Projection, reason: string): Report {
  return {
    aFilled: p.aFilled,
    bFilled: p.bFilled,
    // A single-leg deal has no hedge obligation: projecting aFilled − bReserved
    // there would report the ENTIRE fill as "unhedged" (a false alarm).
    unhedged: pair.b ? p.unhedged : '0',
    reason,
  };
}

/**
 * Terminal check shared by every finishing mode. The gate must be EXACTLY the
 * complement of the hedge branch's ability to act, or a residual in the gap
 * livelocks: we finish precisely when the unhedged residual is PROVABLY
 * unsubmittable (`hedgeSized === 0n` — below lot/minSize/minNotional: permanent
 * dust, named in the report), idle while it is still hedgeable (> 0n), and idle
 * when we cannot tell (null — no reference price for the min-notional check).
 */
function finishIfSettled(pair: PairRow, p: Projection, reason: string, hedgeSized: Fx | null): Action {
  if (!p.allSettled) return { type: 'idle', reason: 'waiting for orders to settle' };
  if (hedgeSized === null) {
    return { type: 'idle', reason: 'cannot verify residual hedgeability (no reference price)' };
  }
  if (hedgeSized > FX_ZERO) {
    return { type: 'idle', reason: 'unhedged residual still hedgeable — hedge branch owns it' };
  }
  // Honesty: an unacquired A-side residual (sub-minimum, or an A-leg wall) and
  // any leftover UNHEDGED exposure must both be NAMED in the terminal report —
  // "converted"/"done" with a silent shortfall reads as success for a close that
  // closed nothing.
  const residual = fx(p.residualA);
  let named = reason;
  if (residual > FX_ZERO && !named.includes('residual')) {
    named += ` (unacquired residual ${p.residualA} — below the venue minimum or blocked)`;
  }
  if (pair.b !== null && fx(p.unhedged) > FX_ZERO && !named.includes('unhedged')) {
    named += ` (unhedged ${p.unhedged} — below ${pair.b.contract}'s lot, not submittable)`;
  }
  return { type: 'finish', report: report(pair, p, named) };
}

/**
 * THE decision function. Priority order is the correctness argument:
 *   0. terminal / freeze-while-in-doubt
 *   1. level-triggered mode edits (deadline, external cancel = STOP, hedge wall)
 *   2. hedge catch-up (every non-DONE mode — exposure never outruns the hedge)
 *   3. per-mode convergence (place/cancel/finish)
 * Returns exactly ONE action; the loop performs at most one wire mutation per tick.
 */
export function decide(pair: PairRow, p: Projection, now: number, ctx: DecideCtx): Action {
  const policy = ctx.tuning ?? TUNING;
  if (pair.mode === 'DONE') return { type: 'idle', reason: 'done' };

  const m = p.makerOrder;

  // A maker cancel is ALWAYS safe — risk-reducing, idempotent, and needs no
  // sizing math — so it must NOT wait out the in-doubt freeze below. A Stop /
  // Convert / Re-peg on an in-doubt (PENDING) or resting (OPEN) maker gets the
  // cancel in flight on the very next tick instead of stalling until the ~90s
  // resolution window closes. Cancel-by-text handles the no-orderId case; a
  // create still racing in lands OPEN next tick and is re-canceled.
  const makerCancelable = m !== null && (m.state === 'OPEN' || m.state === 'PENDING') && !m.cancelRequested;
  if (makerCancelable) {
    if (pair.mode === 'STOPPING' || pair.mode === 'HALTED' || pair.mode === 'CONVERTING') {
      return { type: 'cancel', order: m };
    }
    if (pair.mode === 'OPENING' && pair.limitPrice !== null && m.price !== pair.limitPrice) {
      return { type: 'cancel', order: m }; // re-peg: converge to the new price
    }
    // An OPENING pair with a RESTING maker is the one combination the freeze
    // below does not make safe: it blocks placement (so no hedge can go out)
    // while the maker stays live on the venue and keeps filling to the full
    // target. Exposure grows with nothing neutralizing it, and no hedge order is
    // ever submitted — so bumpHedgeWall never fires, hedgeRejectStreak stays 0
    // and the HALTED transition is unreachable. Stop acquiring what we cannot
    // hedge. m.state OPEN (never PENDING) keeps a freshly-placed maker alive
    // through its own in-doubt window; once the freeze clears, decide() re-places.
    if (pair.mode === 'OPENING' && m.state === 'OPEN' && (p.anyPending || p.anyQuarantined)) {
      return { type: 'cancel', order: m };
    }
  }

  // A quarantine freezes the pair until a LATER read returns a status we know,
  // which a venue that already answered with an unknown string may never do.
  // So a user who asked to get out (Stop, or a halted pair) would wait forever
  // on "settling what filled". Keep cancelling the stuck order: performCancel
  // treats a confirmed cancel ('no further fills can land') as licence to close
  // it out, which is the only thing that can unfreeze the pair. Deliberately
  // NOT gated on cancelRequested — the first cancel is what got us here.
  if (p.quarantinedOrder && (pair.mode === 'STOPPING' || pair.mode === 'HALTED')) {
    return { type: 'cancel', order: p.quarantinedOrder };
  }

  // FREEZE: never PLACE (acquire/hedge) while any order's fate is unresolved —
  // only cancels (above) bypass it.
  if (p.anyPending) return { type: 'idle', reason: 'frozen: order in doubt' };
  if (p.anyQuarantined) return { type: 'idle', reason: 'frozen: unclassifiable venue status' };

  // ---- level-triggered mode edits ----
  // The venue-cancel STOP outranks the deadline: a user who killed the maker on
  // the exchange (possibly during an outage that crossed deadlineAt) said STOP —
  // converting would market-buy the full remainder against an explicit relinquish.
  if (
    pair.mode === 'OPENING' &&
    m?.state === 'CLOSED' &&
    m.closeReason === 'cancelled' && // loop encodes POC insta-cancels as 'poc-reject', never 'cancelled'
    !m.cancelRequested
  ) {
    return { type: 'setMode', mode: 'STOPPING', reason: 'maker canceled on venue = STOP' };
  }
  if (pair.mode === 'OPENING' && pair.deadlineAt !== null && now >= pair.deadlineAt) {
    return { type: 'setMode', mode: 'CONVERTING', reason: 'maker timeout' };
  }
  // A hedge wall halts only the ACQUIRING modes: STOPPING already cancels the
  // maker and stops acquisition, so re-halting it would swallow a user STOP
  // (stop-on-HALTED must stick; the wall stays visible via the streak alert).
  if (
    pair.hedgeRejectStreak >= policy.HEDGE_REJECT_HALT &&
    (pair.mode === 'OPENING' || pair.mode === 'CONVERTING')
  ) {
    return {
      type: 'setMode',
      mode: 'HALTED',
      reason: 'persistent hedge wall',
      haltReason: `hedge failed ${pair.hedgeRejectStreak}x — stopped acquiring unhedgeable exposure`,
    };
  }

  // ---- hedge catch-up: priority 1 in every live mode (slow retries in HALTED).
  // Normal acquisition always uses a marketable LIMIT IOC around a sane fresh
  // book reference. A missing reference is a wall, even when minNotional=0.
  // STOPPING/HALTED widen deterministically, then may lift the cap only after
  // the persistent emergency streak to reduce exposure that is already naked.
  const hedgeRef = ctx.refB && ctx.refB !== '0' ? ctx.refB : null;
  const hedgeSized = pair.b ? sizeFor(fx(p.unhedged), pair.b, hedgeRef) : FX_ZERO;
  const emergencyMarket =
    pair.b !== null &&
    (pair.mode === 'STOPPING' || pair.mode === 'HALTED') &&
    pair.hedgeRejectStreak >= policy.HEDGE_EMERGENCY_STREAK;
  // Emergency flatten can still preserve lot/minSize floor-only sizing without
  // a reference. Only the min-notional check is unknowable; the venue remains
  // authoritative and a reject feeds the same durable wall/backoff.
  const hedgePlaceSized =
    emergencyMarket && hedgeSized === null && pair.b
      ? sizeFor(fx(p.unhedged), { ...pair.b, minNotional: '0' }, null)
      : hedgeSized;
  const hedgeOwed =
    pair.b !== null &&
    (hedgeSized === null ? fx(p.unhedged) >= fx(pair.b.lot) : hedgeSized > FX_ZERO);
  if (now >= pair.hedgeNotBefore && hedgePlaceSized !== null && hedgePlaceSized > FX_ZERO && pair.b) {
    const band = hedgeBandFor(pair, policy);
    if (band === null) {
      return { type: 'place', leg: 'B', kind: 'taker', tif: 'ioc', qty: fxStr(hedgePlaceSized) };
    }
    if (hedgeRef === null) {
      // A resting maker can keep filling while a normal banded hedge is
      // impossible. Cancel acquisition on the first failed reference read,
      // including minNotional=0 legs that can otherwise be sized without it.
      if (pair.mode === 'OPENING' && m?.state === 'OPEN') return { type: 'cancel', order: m };
      return { type: 'idle', reason: 'hedge deferred: no usable reference price' };
    }
    return {
      type: 'place',
      leg: 'B',
      kind: 'taker',
      tif: 'ioc',
      qty: fxStr(hedgePlaceSized),
      price: clipBandPrice(hedgeRef, pair.b, band),
    };
  }

  switch (pair.mode) {
    case 'HALTED':
      // Stop acquiring exposure that cannot be hedged: the maker must not rest.
      if (m && m.state === 'OPEN') return { type: 'cancel', order: m };
      return { type: 'idle', reason: 'halted — awaiting operator' };

    case 'STOPPING': {
      if (m && m.state === 'OPEN') return { type: 'cancel', order: m };
      return finishIfSettled(pair, p, pair.haltReason ?? 'stopped', hedgeSized);
    }

    case 'CONVERTING': {
      if (m && m.state === 'OPEN') return { type: 'cancel', order: m };
      // A-leg failure budget: repeated zero-progress clip terminals (definite
      // rejects — e.g. REDUCE_ONLY when the position vanished, margin walls —
      // or persistent banded whiffs) must TERMINATE the deal honestly, not
      // retry forever. Mirrors OPENING's POC budget; the loop bumps pocRejects
      // on every zero-fill A-leg terminal and resets it on any A-leg fill.
      if (pair.pocRejects >= TUNING.MAX_POC_REJECTS) {
        const why = 'A-leg failing repeatedly (position gone, venue wall, or persistent whiffs) — stopped honestly';
        return { type: 'setMode', mode: 'STOPPING', reason: why, haltReason: why };
      }
      // Hedge-first gating: never widen the unhedged gap while a hedge is owed
      // (or while we cannot prove it isn't).
      if (hedgeOwed) return { type: 'idle', reason: 'convert paused: hedge owed first' };
      if (now < pair.makerNotBefore) return { type: 'idle', reason: 'clip backoff' };
      const clipRaw = fxMin(fx(p.residualA), fx(ctx.maxClip));
      const clip = sizeFor(clipRaw, pair.a, ctx.refA);
      if (clip === null) return { type: 'idle', reason: 'clip deferred: no reference price' };
      if (clip > FX_ZERO) {
        // With a band set (closes carry the user's slippage as clipBandBp) the
        // clip is a MARKETABLE LIMIT at ref·(1 ± band) — this is what the close
        // UI promises verbatim: "a reduce-only IOC limit at mark ± slippage".
        // The band is priced off the venue REFERENCE price, not book mid, so it
        // stays inside the venue's own price-limit band; clipBandPrice rounds
        // BUY down / SELL up so the fill can never be worse than the band.
        // Without a band (opens) it stays a plain MARKET IOC and the venue's own
        // band is the cap. A banded clip that whiffs is already accounted for:
        // bumpClipWall counts zero-progress terminals and decide() stops the
        // deal honestly at MAX_POC_REJECTS rather than retrying forever.
        if (pair.clipBandBp !== null) {
          // '0' is the loop's "not fetched" sentinel, not a price.
          const ref = ctx.refA && ctx.refA !== '0' ? ctx.refA : null;
          // Never fall back to an unpriced MARKET here: the user set a cap, and
          // silently ignoring it is exactly the bug this branch exists to fix.
          // Defer like the min-notional path above and retry next tick.
          if (ref === null) {
            return { type: 'idle', reason: 'clip deferred: no reference price for the slippage band' };
          }
          return {
            type: 'place',
            leg: 'A',
            kind: 'taker',
            tif: 'ioc',
            qty: fxStr(clip),
            price: clipBandPrice(ref, pair.a, pair.clipBandBp),
          };
        }
        return { type: 'place', leg: 'A', kind: 'taker', tif: 'ioc', qty: fxStr(clip) };
      }
      return finishIfSettled(pair, p, 'converted', hedgeSized);
    }

    case 'OPENING': {
      // Hedge-first gating: never leave or re-place a maker while an owed,
      // normally banded hedge has no sane reference. This applies even when
      // minNotional is zero, where sizeFor can determine a quantity without a
      // reference but clipBandPrice still cannot determine a safe limit.
      // loop.ts counts the missing reference toward the hedge wall so HALTED
      // remains reachable.
      if (hedgeOwed && hedgeRef === null) {
        if (m && m.state === 'OPEN') return { type: 'cancel', order: m };
        return { type: 'idle', reason: 'acquisition paused: hedge owed but cannot be safely priced (no reference)' };
      }
      if (m && m.state === 'OPEN') {
        // Re-peg is an intent edit: live maker price ≠ intent price → converge.
        if (pair.limitPrice !== null && m.price !== pair.limitPrice) {
          return { type: 'cancel', order: m };
        }
        return { type: 'idle', reason: 'maker resting' };
      }
      // No live maker (fresh pair, POC reject, insta-cancel, or post-repeg-cancel).
      const price = pair.pricePolicy === 'touch' ? (ctx.touchA ?? pair.limitPrice) : pair.limitPrice;
      // Maker is a LIMIT order: its min-notional is checked at the placement price.
      const residual = price !== null ? sizeFor(fx(p.residualA), pair.a, price) : null;
      if (residual !== null && residual <= FX_ZERO) {
        const rawResidual = fx(p.residualA);
        const reason =
          rawResidual > FX_ZERO
            ? `target reached (unacquired sub-minimum residual ${p.residualA} on the maker leg)`
            : 'target reached';
        return finishIfSettled(pair, p, reason, hedgeSized);
      }
      if (pair.pocRejects >= TUNING.MAX_POC_REJECTS) {
        // The venue rejects a post-only order whose price would cross the book,
        // so the maker never rested. haltReason carries the cause into the
        // terminal report — STOPPING finishes with `haltReason ?? 'stopped'`,
        // and a bare "stopped" hides the one failure the user can immediately
        // fix (the modal keys its try-again guidance off this text).
        const why = `the limit price kept crossing the market — the venue rejected the post-only maker ${TUNING.MAX_POC_REJECTS} times in a row`;
        return { type: 'setMode', mode: 'STOPPING', reason: why, haltReason: why };
      }
      if (now < pair.makerNotBefore) return { type: 'idle', reason: 'maker backoff' };
      if (price === null || residual === null) {
        return { type: 'idle', reason: 'no price available — never place blind' };
      }
      return { type: 'place', leg: 'A', kind: 'maker', tif: 'poc', qty: fxStr(residual), price };
    }
  }
}
