/**
 * Deal creation: validate a DealRequest against live venue rules (and, for
 * reduce-only legs, live positions), snapshot the rules into a PairRow, and
 * hand it to the store. This is the ONLY validation gate before the loop —
 * nothing here talks to venue-mutating endpoints.
 *
 * Deal shapes (docs/MAKER-HEDGE.md): maker pair · taker pair · single open (maker or
 * taker, b = null) · close (taker, reduce-only legs; close-pair = both legs).
 */
import type { Symbol as RuleSymbol } from 'gate-api';
import type { Clients } from '../core/clients';
import { CoreError } from '../core/errors';
import { formatRestPrice, parseSymbol } from '../core/numbers';
import { preflightMargin, type PreflightDeps } from '../core/preflight';
import { fx, fxFloorToStep, fxStr } from './fx';
import type { LegSpec, PairRow, Side } from './types';

export interface DealLegRequest {
  symbol: string;
  side: Side;
  reduceOnly?: boolean;
}

export interface DealRequest {
  /** Client-generated id (≥ 6 chars) — the idempotency key. */
  id: string;
  a: DealLegRequest;
  b?: DealLegRequest | null;
  /** Resolved base qty (client sizes via /preview, as the execute path did). */
  qty: string;
  /** A-leg style: 'maker' rests post-only (OPENING); 'taker' clips (CONVERTING). */
  execution: 'maker' | 'taker';
  /** Maker limit price (required for maker execution; tick-snapped here). */
  price?: string;
  pricePolicy?: 'fixed' | 'touch';
  /** Maker PAIRS convert to taker after this many seconds (clamped [30, 3600],
   * default 300). Single-leg maker deals rest with NO deadline (a plain resting
   * post-only order — the user cancels or it fills). */
  timeoutSec?: number;
  /** Max A-clip size during CONVERTING (bounds peak unhedged exposure). */
  maxClip?: string;
  /** A-clip marketable-limit protection band, percent (closes: slippagePct). */
  clipBandPct?: number;
  /** Hedge marketable-limit protection band, percent (default 0.5%). */
  hedgeBandPct?: number;
  /** Leverage to set per leg BEFORE the deal is created (venue max from the UI). */
  leverage?: { a?: number; b?: number };
}

const ID_RE = /^[a-zA-Z0-9-]{6,40}$/;
const TIMEOUT_DEFAULT_S = 300;
const TIMEOUT_MIN_S = 30;
const TIMEOUT_MAX_S = 3_600;

/** Normalize a venue rule value to a plain decimal string the fx layer accepts
 * (rules can arrive as sci-notation like '1e-05', or null). Snapshotting a
 * malformed value would make EVERY later engine tick throw. */
function safeDec(v: unknown, fallback: string): string {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return fallback;
  if (n === 0) return '0';
  const s = n.toFixed(12).replace(/0+$/, '').replace(/\.$/, '');
  return s === '' ? fallback : s;
}

function legSpecOf(rule: RuleSymbol, req: DealLegRequest): LegSpec {
  return {
    contract: rule.symbol,
    side: req.side,
    lot: safeDec(rule.lotSize, '0.0001'),
    minSize: safeDec(rule.minSize, '0'),
    minNotional: safeDec(rule.minNotional, '0'),
    tick: safeDec(rule.tickSize, '0.0001'),
    ...(req.reduceOnly ? { reduceOnly: true } : {}),
  };
}

/** Validate + snapshot a deal. Throws CoreError on any violation; nothing sent. */
export async function resolveDeal(
  clients: Clients,
  req: DealRequest,
  now: number,
  opts?: { preflight?: PreflightDeps; refPriceA?: string | null },
): Promise<PairRow> {
  if (!ID_RE.test(req.id ?? '')) throw new CoreError('deal id must be 6-40 chars of [a-zA-Z0-9-]');
  if (req.execution !== 'maker' && req.execution !== 'taker') {
    throw new CoreError(`execution must be 'maker' or 'taker'`);
  }

  const symbols = [req.a.symbol.toUpperCase(), ...(req.b ? [req.b.symbol.toUpperCase()] : [])];
  const { body: ruleList } = await clients.crossEx.listCrossexRuleSymbols({ symbols: symbols.join(',') });
  const rules = new Map((ruleList ?? []).map((r) => [r.symbol, r]));
  const ruleFor = (symbol: string): RuleSymbol => {
    const rule = rules.get(symbol);
    if (!rule) throw new CoreError(`${symbol} not found on CrossEx`);
    if (rule.state !== 'live') throw new CoreError(`${symbol} is not tradable (state=${rule.state})`);
    if (rule.businessType !== 'FUTURE') throw new CoreError(`${symbol} is ${rule.businessType}, not a FUTURE perp`);
    return rule;
  };
  const aRule = ruleFor(symbols[0]);
  const bRule = req.b ? ruleFor(symbols[1]) : null;

  if (bRule) {
    if (aRule.symbol === bRule.symbol) {
      throw new CoreError('deal legs must be different contracts (a same-contract pair would net to nothing but fees)');
    }
    if (parseSymbol(aRule.symbol).base !== parseSymbol(bRule.symbol).base) {
      throw new CoreError(`deal legs are different coins (${aRule.symbol} vs ${bRule.symbol})`);
    }
    // Delta sign is a function of SIDE alone — BUY adds exposure, SELL removes
    // it — whether the leg opens or closes. So a two-leg deal that can open any
    // new exposure must have opposite sides, and the old exemption keyed on
    // `!req.a.reduceOnly` was too broad: it also waved through the MIXED shape
    // (leg A reduce-only, leg B not) on the SAME side, where A closes a long
    // while B opens a fresh short of the same size. Net delta swings by 2x the
    // deal instead of to zero, and nothing downstream notices — the unhedged
    // fold compares quantities, never directions, so the deal finishes DONE
    // reporting unhedged 0.
    //
    // Only a PURE close-pair stays exempt: with both legs reduce-only no new
    // exposure can be created on either side whatever the sides are.
    const bothReduceOnly = req.a.reduceOnly === true && req.b!.reduceOnly === true;
    if (req.a.side === req.b!.side && !bothReduceOnly) {
      throw new CoreError('a two-leg deal that opens exposure needs opposite sides (delta-neutral)');
    }
  }

  // Qty: positive, a multiple of BOTH lots (every fill increment must be
  // hedgeable without rounding drift), and at least leg A's minSize.
  const qty = fx(req.qty ?? '');
  if (qty <= 0n) throw new CoreError('qty must be a positive decimal string');
  const aLot = fx(safeDec(aRule.lotSize, '0.0001'));
  if (fxFloorToStep(qty, aLot) !== qty) {
    throw new CoreError(`qty ${req.qty} is not a multiple of ${aRule.symbol}'s lot ${aRule.lotSize}`);
  }
  if (bRule) {
    const bLot = fx(safeDec(bRule.lotSize, '0.0001'));
    if (fxFloorToStep(qty, bLot) !== qty) {
      throw new CoreError(`qty ${req.qty} is not a multiple of ${bRule.symbol}'s lot ${bRule.lotSize}`);
    }
  }
  if (qty < fx(safeDec(aRule.minSize, '0'))) {
    throw new CoreError(`qty ${req.qty} is below ${aRule.symbol}'s min size ${aRule.minSize}`);
  }
  // Leg B's minimum matters just as much as leg A's, and skipping it fails
  // SILENTLY rather than loudly: sizeFor returns FX_ZERO for every hedge, so
  // hedgeOwed is false, no B order is ever created, no reject is ever recorded,
  // hedgeRejectStreak stays 0 and the HALTED transition is unreachable. Leg A
  // acquires the full target and finishIfSettled writes mode DONE — a deal that
  // reports success while the user holds 100% naked directional exposure.
  if (bRule && qty < fx(safeDec(bRule.minSize, '0'))) {
    throw new CoreError(
      `qty ${req.qty} is below ${bRule.symbol}'s min size ${bRule.minSize} — the hedge leg could never be submitted`,
    );
  }

  // Maker price: required + tick-snapped AWAY from crossing. This price rests
  // post-only, so formatRestPrice (BUY floors, SELL ceils) — a nearest snap can
  // land it across the spread and the venue would reject it as would-cross on
  // every retry, burning the POC budget until the deal stops.
  let price: string | null = null;
  if (req.execution === 'maker') {
    const p = Number(req.price);
    if (!Number.isFinite(p) || p <= 0) throw new CoreError('maker execution requires a positive limit price');
    price = formatRestPrice(p, req.a.side, aRule.symbol, aRule.tickSize ?? '0.0001');
  }

  // A-leg minNotional at create (best-effort: maker → its limit price; taker →
  // the caller-provided venue ref). Without this, a sub-minimum close passes a
  // clean preview and then can never submit — the deal would finish having done
  // nothing (the engine names the residual, but a 400 here is honest EARLIER).
  const minNotionalA = fx(safeDec(aRule.minNotional, '0'));
  const refA = price ?? opts?.refPriceA ?? null;
  if (minNotionalA > 0n && refA) {
    try {
      if ((qty * fx(refA)) / 10n ** 12n < minNotionalA) {
        throw new CoreError(
          `qty ${req.qty} is below ${aRule.symbol}'s minimum notional (${safeDec(aRule.minNotional, '0')} at ~${refA}) — increase the size`,
        );
      }
    } catch (err) {
      if (err instanceof CoreError) throw err;
      /* unparseable ref — venue enforces; the engine reports the residual */
    }
  }
  // Same check for the HEDGE leg, whose minimum can be higher than leg A's — a
  // deal that clears A's $5 minimum but not B's $10 one hedges nothing, and the
  // engine has no way to complain (see the min-size note above: no B order is
  // ever submitted, so no reject is ever counted and HALTED is unreachable).
  // Both legs are the same base coin by the check above, so refA is a sound
  // basis: cross-venue perp prices differ by basis points, and a minimum-notional
  // gate does not need sub-percent precision.
  const minNotionalB = bRule ? fx(safeDec(bRule.minNotional, '0')) : 0n;
  if (bRule && minNotionalB > 0n && refA) {
    try {
      if ((qty * fx(refA)) / 10n ** 12n < minNotionalB) {
        throw new CoreError(
          `qty ${req.qty} is below ${bRule.symbol}'s minimum notional (${safeDec(bRule.minNotional, '0')} at ~${refA}) — the hedge leg could never be submitted, increase the size`,
        );
      }
    } catch (err) {
      if (err instanceof CoreError) throw err;
      /* unparseable ref — venue enforces; the engine reports the residual */
    }
  }

  // Venue MAXIMUM order sizes. actions.ts enforces these at preview time, so the
  // UI cannot get here - but this function is the only gate a direct API call
  // passes through, and an oversized deal is unhedgeable BY CONSTRUCTION: the
  // engine submits the hedge as ONE order for the whole unhedged amount and has
  // no splitting logic, so every attempt is rejected, the wall trips, and the
  // deal halts holding a one-sided position.
  //
  // Leg A is checked against the MARKET cap as well as the limit cap even for a
  // maker deal: timeout/convert is a designed outcome that turns the remainder
  // into a market order, and the market cap is routinely the smaller of the two.
  const maxOf = (v: unknown): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0; // 0/absent = uncapped
  };
  const qtyNum = Number(fxStr(qty));
  const capChecks: Array<{ label: string; cap: number; why: string }> = [
    { label: `${aRule.symbol} max MARKET order size`, cap: maxOf(aRule.maxMarketSize), why: 'the timeout/convert path submits market orders' },
    ...(req.execution === 'maker'
      ? [{ label: `${aRule.symbol} max LIMIT order size`, cap: maxOf(aRule.maxLimitSize), why: 'the maker leg rests as a limit order' }]
      : []),
    ...(bRule
      ? [
          { label: `${bRule.symbol} max LIMIT order size`, cap: maxOf(bRule.maxLimitSize), why: 'normal hedge catches are submitted as one limit order and are never split' },
          { label: `${bRule.symbol} max MARKET order size`, cap: maxOf(bRule.maxMarketSize), why: 'emergency flatten may submit the hedge as one market order and never splits it' },
        ]
      : []),
  ];
  for (const { label, cap, why } of capChecks) {
    if (cap > 0 && qtyNum > cap) {
      throw new CoreError(`qty ${req.qty} exceeds ${label} (${cap}) — ${why}; reduce the size`);
    }
  }

  // Reduce-only legs must match a live position (side opposite, qty within).
  if (req.a.reduceOnly || req.b?.reduceOnly) {
    const { body: positions } = await clients.crossEx.listCrossexPositions();
    const check = (leg: DealLegRequest, contract: string): void => {
      if (!leg.reduceOnly) return;
      const pos = (positions ?? []).find((p) => (p.symbol ?? '').toUpperCase() === contract);
      let posFx: ReturnType<typeof fx>;
      try {
        posFx = fx(String(pos?.positionQty ?? '0'));
      } catch {
        posFx = fx(safeDec(pos?.positionQty, '0')); // float/sci shapes: normalize, never 500
      }
      if (!pos || posFx === 0n) throw new CoreError(`no open position on ${contract} to reduce`);
      const closeSide: Side = posFx > 0n ? 'SELL' : 'BUY';
      if (leg.side !== closeSide) {
        throw new CoreError(`${contract} close side must be ${closeSide} (position is ${posFx > 0n ? 'long' : 'short'})`);
      }
      const absPos = posFx < 0n ? -posFx : posFx;
      if (qty > absPos) {
        throw new CoreError(`close qty ${req.qty} exceeds the ${contract} position (${fxStr(absPos)})`);
      }
    };
    check(req.a, aRule.symbol);
    if (req.b && bRule) check(req.b, bRule.symbol);
  }

  const clipBandBp =
    req.clipBandPct !== undefined && req.clipBandPct !== null
      ? (() => {
          const bp = Math.round(Number(req.clipBandPct) * 100);
          if (!Number.isFinite(bp) || bp <= 0 || bp > 1_000) {
            throw new CoreError('clipBandPct must be in (0, 10]');
          }
          return bp;
        })()
      : null;
  const hedgeBandBp =
    req.hedgeBandPct !== undefined && req.hedgeBandPct !== null
      ? (() => {
          const bp = Math.round(Number(req.hedgeBandPct) * 100);
          if (!Number.isFinite(bp) || bp <= 0 || bp > 1_000) {
            throw new CoreError('hedgeBandPct must be in (0, 10]');
          }
          return bp;
        })()
      : null;

  const maxClip = req.maxClip !== undefined && req.maxClip !== null ? fxStr(fx(req.maxClip)) : null;
  if (maxClip !== null && fx(maxClip) <= 0n) throw new CoreError('maxClip must be positive');

  const a = legSpecOf(aRule, { ...req.a, symbol: aRule.symbol });
  const b = bRule && req.b ? legSpecOf(bRule, { ...req.b, symbol: bRule.symbol }) : null;

  // Deadline: maker PAIRS must bound unhedged time; single maker deals rest.
  let deadlineAt: number | null = null;
  if (req.execution === 'maker' && b) {
    const t = Number.isFinite(Number(req.timeoutSec)) && Number(req.timeoutSec) > 0 ? Number(req.timeoutSec) : TIMEOUT_DEFAULT_S;
    deadlineAt = now + Math.min(TIMEOUT_MAX_S, Math.max(TIMEOUT_MIN_S, t)) * 1000;
  }

  const row: PairRow = {
    id: req.id,
    mode: req.execution === 'maker' ? 'OPENING' : 'CONVERTING',
    a,
    b,
    targetQty: fxStr(qty),
    limitPrice: price,
    pricePolicy: req.pricePolicy === 'fixed' ? 'fixed' : 'touch',
    deadlineAt,
    makerNotBefore: 0,
    hedgeNotBefore: 0,
    pocRejects: 0,
    hedgeRejectStreak: 0,
    maxClip,
    clipBandBp,
    hedgeBandBp,
    haltReason: null,
    reportJson: null,
    createdAt: now,
  };

  // Margin preflight for exposure-OPENING deals (reduce-only legs are exempt
  // inside preflightMargin — closes free margin). Fail-open on read errors;
  // a confirmed shortfall blocks with nothing sent.
  const openLegs = [
    { leg: a, lev: req.leverage?.a },
    ...(b ? [{ leg: b, lev: req.leverage?.b }] : []),
  ].filter((x) => !x.leg.reduceOnly);
  if (openLegs.length) {
    await preflightMargin(
      clients,
      openLegs.map(({ leg, lev }, i) => ({
        index: i,
        input: { kind: 'open-market' as const, symbol: leg.contract, side: leg.side, qty: row.targetQty },
        symbol: leg.contract,
        side: leg.side,
        type: 'MARKET' as const,
        tif: 'IOC' as const,
        reduceOnly: false,
        qty: row.targetQty,
        estNotional: 0,
        ...(lev ? { leverage: { requested: lev, max: lev } } : {}),
        violations: [],
        warnings: [],
      })),
      opts?.preflight,
    );
  }

  return row;
}
