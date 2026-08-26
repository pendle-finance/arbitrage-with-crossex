/**
 * Canonical action/basket contract + resolver, shared by the preview route and
 * (mirrored) the web SPA.
 *
 * `resolveActions` turns raw ActionInputs into fully-resolved orders (rules fetched,
 * qty/price resolved, pair groups validated) WITHOUT side effects. Per-action problems
 * become structured `violations` — it never throws for them, so previews can render
 * every problem inline; the execute route rejects the basket if any hard violation
 * exists. Estimates (fill price, fees) are layered on top by the preview service.
 */
import type { Symbol as RuleSymbol } from 'gate-api';
import type { Clients } from './clients';
import { DEFAULT_STEP, formatLimitPrice, formatRestPrice, parseSymbol, roundToStep } from './numbers';
import {
  direction,
  getLeverageMax,
  isMultipleOf,
  marketableClosePrice,
  resolveQty,
  resolveReferencePrice,
  type Side,
} from './orders';

// ---------------------------------------------------------------------------
// Action inputs
// ---------------------------------------------------------------------------

/** Maker-hedge pair roles: the `maker` leg rests post-only (POC) and the engine
 * auto-fires market orders on the `hedge` leg as the maker fills. Only valid on
 * a pairGroupId'd open pair — one maker (open-limit) + one hedge (open-market). */
export type PairRole = 'maker' | 'hedge';

interface OpenMarketAction {
  kind: 'open-market';
  symbol: string;
  side: Side;
  /** Resolved base qty string — REQUIRED at execute time (never re-sized server-side). */
  qty?: string;
  /** Preview-only sizing; a violation at execute time. */
  notional?: string;
  leverage?: number;
  reduceOnly?: boolean;
  /** Links delta-neutral legs (open/open or close/close) for the unhedged guard. */
  pairGroupId?: string;
  /** Maker-hedge mode: this leg must be 'hedge' (market legs can't rest). */
  pairRole?: PairRole;
}

interface OpenLimitAction {
  kind: 'open-limit';
  symbol: string;
  side: Side;
  qty?: string;
  notional?: string;
  /** Limit price; tick-snapped (and HL 5-sig-fig-capped) during resolution. */
  price: string;
  tif?: 'GTC' | 'IOC' | 'FOK' | 'POC';
  leverage?: number;
  reduceOnly?: boolean;
  pairGroupId?: string;
  /** Maker-hedge mode: this leg must be 'maker' (tif is forced to POC). */
  pairRole?: PairRole;
  /** Maker-hedge mode: unfilled remainder converts to taker after this many
   * seconds (clamped [30, 3600] at plan time; default 300). */
  makerTimeoutSec?: number;
  /** Maker-hedge maker leg only: re-peg the INITIAL submit price to the fresh
   * same-side touch at t=submit (BUY→best bid, SELL→best ask). Set by the ticket
   * when the maker price is auto-tracking, so a resting order is priced from the
   * venue book at submit rather than a stale client value; `price` above stays
   * the fallback reference used when the book is unavailable. */
  pegToTouch?: boolean;
}

interface ClosePositionAction {
  kind: 'close-position';
  symbol: string;
  /** Partial close qty; default = full position (re-derived from the live position). */
  qty?: string;
  /** Marketable-limit protection band, percent. Default 0.5, bounded (0, 10]. */
  slippagePct?: number;
  pairGroupId?: string;
}

export type ActionInput = OpenMarketAction | OpenLimitAction | ClosePositionAction;

// ---------------------------------------------------------------------------
// Estimates (implemented in core/estimate/*; typed here as part of the contract)
// ---------------------------------------------------------------------------

export interface FillEstimate {
  qty: string;
  avgPrice: number;
  worstPrice: number;
  midPrice?: number;
  /** avg vs mid (or reference when no book), percent, signed against the taker. */
  slippagePct: number;
  source: 'venue-orderbook' | 'gate-orderbook' | 'reference+spread' | 'mark';
  confidence: 'high' | 'medium' | 'low';
  venue: string;
  /** Book was thinner than qty — the tail is extrapolated at the last level. */
  partialDepth?: boolean;
}

export interface FeeEstimate {
  makerRate: number;
  takerRate: number;
  specialOverride: boolean;
  /** Fee currency = the symbol's quote (USDT / USD / USDC — never assume USDT). */
  quote: string;
  /** MARKET/IOC ⇒ taker only; POC ⇒ maker only; resting-capable LIMIT ⇒ both (a range). */
  est: { taker?: number; maker?: number };
}

// ---------------------------------------------------------------------------
// Resolution results
// ---------------------------------------------------------------------------

export interface Violation {
  code:
    | 'symbol-not-found'
    | 'symbol-not-live'
    | 'not-a-perp'
    | 'qty-missing'
    | 'qty-invalid'
    | 'notional-at-execute'
    | 'sizing-failed'
    | 'below-min-size'
    | 'below-min-notional'
    | 'lot-incompatible'
    | 'exceeds-max-market-size'
    | 'exceeds-max-limit-size'
    | 'price-missing'
    | 'price-invalid'
    | 'leverage-exceeds-max'
    | 'slippage-invalid'
    | 'ref-price-unavailable'
    | 'no-position'
    | 'qty-exceeds-position'
    | 'pair-legs-invalid'
    | 'pair-side-conflict'
    | 'pair-base-mismatch'
    | 'pair-qty-mismatch'
    | 'pair-type-restricted'
    | 'pair-role-invalid'
    | 'pair-mode-mixed-actions';
  message: string;
}

export interface ResolvedAction {
  index: number;
  input: ActionInput;
  symbol: string;
  side: Side;
  type: 'MARKET' | 'LIMIT';
  tif: 'GTC' | 'IOC' | 'FOK' | 'POC';
  reduceOnly: boolean;
  /** Final lot-floored base qty ('' when unresolvable — a violation explains why). */
  qty: string;
  price?: string;
  estNotional: number;
  refPrice?: { value: number; source: string };
  leverage?: { requested: number; max: number };
  rule?: RuleSymbol;
  /** Present on close actions: what the close was derived from. */
  closing?: { positionQty: string; upnl: string; mark: number };
  violations: Violation[];
  warnings: string[];
}

/** Touch prices for a RESTING (POC) leg — it doesn't cross, so instead of a fill
 * estimate the ticket needs the book's edge to price the maker order at. */
export interface RestEstimate {
  bestBid: number;
  bestAsk: number;
  mid: number;
}

export interface PreviewResult extends ResolvedAction {
  fillEstimate?: FillEstimate;
  fees?: FeeEstimate;
  restEstimate?: RestEstimate;
}

/** Locate the maker/hedge legs of a maker-hedge basket; null when not that mode. */
export function makerHedgeRoles(actions: ActionInput[]): { makerIndex: number; hedgeIndex: number } | null {
  const makerIndex = actions.findIndex((a) => 'pairRole' in a && a.pairRole === 'maker');
  const hedgeIndex = actions.findIndex((a) => 'pairRole' in a && a.pairRole === 'hedge');
  return makerIndex >= 0 && hedgeIndex >= 0 ? { makerIndex, hedgeIndex } : null;
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

interface ResolveOpts {
  /** Preview allows `notional` sizing; execute requires resolved qty/price strings. */
  mode: 'preview' | 'execute';
}

const DEFAULT_SLIPPAGE = 0.5;

/**
 * Resolve every action against live rules/positions/prices. Batches Gate reads
 * (one rules call, one positions call, one risk-limits call). Never throws for
 * per-action problems — inspect `violations`.
 */
export async function resolveActions(
  clients: Clients,
  actions: ActionInput[],
  opts: ResolveOpts,
): Promise<ResolvedAction[]> {
  const { crossEx } = clients;

  // ---- batched reads ----
  const symbols = [...new Set(actions.map((a) => a.symbol.toUpperCase()))];
  const { body: ruleList } = symbols.length
    ? await crossEx.listCrossexRuleSymbols({ symbols: symbols.join(',') })
    : { body: [] as RuleSymbol[] };
  const rules = new Map((ruleList ?? []).map((r) => [r.symbol, r]));

  const needsPositions = actions.some((a) => a.kind === 'close-position');
  const positions = needsPositions ? ((await crossEx.listCrossexPositions()).body ?? []) : [];

  const levSymbols = [
    ...new Set(actions.filter((a) => 'leverage' in a && a.leverage).map((a) => a.symbol.toUpperCase())),
  ];
  const levMax = levSymbols.length ? await getLeverageMax(crossEx, levSymbols) : new Map<string, number>();

  // Reference prices per distinct pair, resolved lazily (only when sizing needs one).
  const refCache = new Map<string, { value: number; source: string } | null>();
  const refFor = async (symbol: string): Promise<{ value: number; source: string } | null> => {
    const { pair } = parseSymbol(symbol);
    if (!refCache.has(pair)) {
      try {
        const { price, source } = await resolveReferencePrice(clients, { pairs: [pair] });
        refCache.set(pair, { value: price, source });
      } catch {
        refCache.set(pair, null);
      }
    }
    return refCache.get(pair) ?? null;
  };

  const resolved: ResolvedAction[] = [];
  for (let index = 0; index < actions.length; index++) {
    const input = actions[index];
    const violations: Violation[] = [];
    const warnings: string[] = [];
    const symbol = input.symbol.toUpperCase();
    const rule = rules.get(symbol);

    // ---- symbol/rule validation (all kinds) ----
    if (!rule) {
      violations.push({ code: 'symbol-not-found', message: `${symbol} not found on CrossEx` });
    } else {
      if (rule.state !== 'live') {
        violations.push({ code: 'symbol-not-live', message: `${symbol} is not tradable (state=${rule.state})` });
      }
      if (rule.businessType !== 'FUTURE') {
        violations.push({ code: 'not-a-perp', message: `${symbol} is ${rule.businessType}, not a FUTURE perp` });
      }
    }

    if (input.kind === 'close-position') {
      resolved.push(await resolveClose(index, input, symbol, rule, positions, violations, warnings));
      continue;
    }

    // ---- open-market / open-limit ----
    const type: 'MARKET' | 'LIMIT' = input.kind === 'open-market' ? 'MARKET' : 'LIMIT';
    let tif: 'GTC' | 'IOC' | 'FOK' | 'POC' = input.kind === 'open-limit' ? (input.tif ?? 'GTC') : 'IOC';
    // A maker-hedge maker leg is post-only BY DEFINITION: the whole mode exists to
    // earn maker fees, and a crossing limit would silently pay taker. Force POC.
    if (input.kind === 'open-limit' && input.pairRole === 'maker' && tif !== 'POC') {
      if (input.tif !== undefined) warnings.push(`maker leg tif forced to POC (was ${input.tif})`);
      tif = 'POC';
    }
    // Execute mode always carries a resolved qty, so the reference price is only
    // informational — skip the lookup (preview already sized/validated with one).
    const ref = opts.mode === 'execute' && input.qty ? null : await refFor(symbol);

    // Limit price first (it can serve as the sizing reference).
    let price: string | undefined;
    if (input.kind === 'open-limit') {
      const p = Number(input.price);
      if (!Number.isFinite(p) || p <= 0) {
        violations.push({ code: 'price-invalid', message: `limit price "${input.price}" is not a positive number` });
      } else if (rule) {
        // A POC order rests: snap AWAY from crossing so the snap itself can't
        // turn it into a would-cross reject. Every other tif may legitimately be
        // marketable, so those keep the nearest-tick snap.
        price =
          tif === 'POC'
            ? formatRestPrice(p, input.side, symbol, rule.tickSize)
            : formatLimitPrice(p, symbol, rule.tickSize);
        if (price !== input.price) {
          warnings.push(`price adjusted to venue tick/precision rules: ${input.price} → ${price}`);
        }
      } else {
        price = input.price;
      }
    }

    // Qty resolution.
    let qty = '';
    let estNotional = 0;
    const sizingRef = price ? Number(price) : ref?.value;
    if (input.notional && opts.mode === 'execute') {
      violations.push({
        code: 'notional-at-execute',
        message: 'execute requires a resolved qty string; notional sizing is preview-only',
      });
    } else if (!input.qty && !input.notional) {
      violations.push({ code: 'qty-missing', message: 'provide qty (or notional in preview)' });
    } else if (!input.qty && input.notional && !sizingRef) {
      violations.push({ code: 'ref-price-unavailable', message: `no reference price for ${symbol}; enter qty directly` });
    } else if (rule) {
      try {
        // Without a price there is no notional to check — warn instead of false-failing
        // (preview validates it with a live reference; Gate enforces it at the venue).
        const minNotional = sizingRef ? Number(rule.minNotional ?? 0) : 0;
        if (!sizingRef && Number(rule.minNotional ?? 0) > 0) {
          warnings.push('min-notional not re-checked (no reference price at execute time)');
        }
        const r = resolveQty({
          notional: input.qty ? undefined : input.notional,
          qty: input.qty,
          refPrice: sizingRef ?? 0,
          legs: [{ lotSize: rule.lotSize, minSize: Number(rule.minSize ?? 0), minNotional }],
        });
        qty = r.qtyStr;
        estNotional = r.estNotional;
      } catch (err) {
        violations.push({ code: sizingViolationCode(err), message: (err as Error).message });
      }
      // Venue max order sizes (rule fields are decimal strings; 0/empty = no cap).
      const maxSize = Number(type === 'MARKET' ? rule.maxMarketSize : rule.maxLimitSize);
      if (qty && maxSize > 0 && Number(qty) > maxSize) {
        violations.push({
          code: type === 'MARKET' ? 'exceeds-max-market-size' : 'exceeds-max-limit-size',
          message: `qty ${qty} exceeds the venue max ${type.toLowerCase()} order size ${maxSize}`,
        });
      }
    } else if (input.qty) {
      qty = input.qty; // symbol unknown — keep input for display; violations already block execution
    }

    // Leverage.
    let leverage: ResolvedAction['leverage'];
    if (input.leverage) {
      const max = levMax.get(symbol) ?? 0;
      leverage = { requested: input.leverage, max };
      if (max > 0 && input.leverage > max) {
        violations.push({ code: 'leverage-exceeds-max', message: `leverage ${input.leverage}x exceeds max ${max}x for ${symbol}` });
      }
    }

    if (opts.mode === 'preview' && !ref && !price) {
      warnings.push('no reference price available — estimates unavailable');
    }

    resolved.push({
      index,
      input,
      symbol,
      side: input.side,
      type,
      tif,
      reduceOnly: Boolean(input.reduceOnly),
      qty,
      price,
      estNotional,
      refPrice: ref ?? undefined,
      leverage,
      rule,
      violations,
      warnings,
    });
  }

  applySharedPairSizing(resolved);
  applyPairGroupChecks(resolved);
  return resolved;
}

function applySharedPairSizing(resolved: ResolvedAction[]): void {
  const groups = new Map<string, ResolvedAction[]>();
  for (const r of resolved) {
    const id = r.input.pairGroupId;
    if (id && r.input.kind !== 'close-position') {
      const g = groups.get(id) ?? [];
      g.push(r);
      groups.set(id, g);
    }
  }
  for (const legs of groups.values()) {
    if (legs.length !== 2) continue;
    const [a, b] = legs;
    if (!a.rule || !b.rule) continue;
    const inA = a.input as OpenMarketAction;
    const inB = b.input as OpenMarketAction;
    const sizeA = inA.qty ?? inA.notional;
    const sizeB = inB.qty ?? inB.notional;
    if (!sizeA || !sizeB) continue;
    if (Boolean(inA.qty) !== Boolean(inB.qty)) {
      for (const l of legs) {
        l.violations.push({ code: 'pair-qty-mismatch', message: 'pair legs are sized differently — one in coins, one in dollars; size both the same way' });
      }
      continue;
    }
    // drops leg B's intent. Flag it rather than reconcile downward without warning.
    const numA = Number(sizeA);
    const numB = Number(sizeB);
    if (Number.isFinite(numA) && Number.isFinite(numB) && numA !== numB) {
      const unit = inA.qty ? 'qty' : 'notional';
      for (const l of legs) {
        l.violations.push({ code: 'pair-qty-mismatch', message: `pair legs have different ${unit} (${numA} vs ${numB}) — use one shared ${unit}` });
      }
      continue;
    }
    const ref = a.refPrice ?? b.refPrice;
    if (!inA.qty && !ref) continue;
    try {
      const shared = resolveQty({
        notional: inA.qty ? undefined : inA.notional,
        qty: inA.qty,
        refPrice: ref?.value,
        legs: legs.map((l) => ({
          lotSize: l.rule!.lotSize,
          minSize: Number(l.rule!.minSize ?? 0),
          minNotional: Number(l.rule!.minNotional ?? 0),
        })),
      });
      for (const l of legs) {
        if (Number(l.qty) !== shared.qty) {
          l.warnings.push(`size set to ${shared.qtyStr} (was ${l.qty || '—'}) so both legs trade the same amount`);
        }
        l.qty = shared.qtyStr;
        if (ref) l.estNotional = shared.estNotional;
        // Per-leg sizing violations are superseded by the successful shared sizing.
        l.violations = l.violations.filter(
          (v) => !['below-min-size', 'below-min-notional', 'lot-incompatible', 'qty-invalid', 'sizing-failed'].includes(v.code),
        );
      }
    } catch (err) {
      const code = sizingViolationCode(err);
      const message =
        code === 'lot-incompatible'
          ? `${a.symbol} trades in steps of ${a.rule!.lotSize} and ${b.symbol} in steps of ${b.rule!.lotSize} — no size fits both legs`
          : `pair sizing: ${(err as Error).message}`;
      for (const l of legs) {
        l.violations.push({ code, message });
      }
    }
  }
}

/** Resolve a close action from the live position (the one execute-time re-derivation). */
async function resolveClose(
  index: number,
  input: ClosePositionAction,
  symbol: string,
  rule: RuleSymbol | undefined,
  positions: Array<{ symbol?: string; positionQty?: string; positionSide?: string; markPrice?: string; entryPrice?: string; upnl?: string }>,
  violations: Violation[],
  warnings: string[],
): Promise<ResolvedAction> {
  const slippage = input.slippagePct ?? DEFAULT_SLIPPAGE;
  if (!Number.isFinite(slippage) || slippage <= 0 || slippage > 10) {
    violations.push({ code: 'slippage-invalid', message: `slippage ${input.slippagePct}% must be in (0, 10]` });
  }

  const pos = positions.find((p) => (p.symbol ?? '').toUpperCase() === symbol && Number(p.positionQty ?? 0) !== 0);
  let side: Side = 'SELL';
  let qty = '';
  let price: string | undefined;
  let estNotional = 0;
  let closing: ResolvedAction['closing'];

  if (!pos) {
    violations.push({ code: 'no-position', message: `no open position on ${symbol}` });
  } else {
    const posQty = Math.abs(Number(pos.positionQty ?? 0));
    side = direction(pos.positionSide, pos.positionQty ?? 0) === 'LONG' ? 'SELL' : 'BUY';
    const lot = rule?.lotSize ?? DEFAULT_STEP;
    if (input.qty) {
      const requested = Number(input.qty);
      if (!Number.isFinite(requested) || requested <= 0) {
        violations.push({ code: 'qty-invalid', message: `close qty "${input.qty}" is not a positive number` });
      } else if (requested > posQty + 1e-12) {
        violations.push({ code: 'qty-exceeds-position', message: `close qty ${input.qty} exceeds position ${posQty}` });
      } else {
        qty = roundToStep(requested, lot, 'down');
        if (!isMultipleOf(requested, lot)) warnings.push(`close qty floored to lot ${lot}: ${input.qty} → ${qty}`);
      }
    } else {
      qty = roundToStep(posQty, lot, 'down');
    }
    // A dust position (or a partial-close request) smaller than one lot floors to
    // '0.0000' — a truthy string that would otherwise pass a zero-qty order to Gate.
    if (qty && Number(qty) <= 0) {
      violations.push({ code: 'below-min-size', message: `position ${posQty} is smaller than one lot (${lot}) — nothing to close` });
      qty = '';
    }
    const mark = Number(pos.markPrice ?? 0) || Number(pos.entryPrice ?? 0);
    if (!(mark > 0)) {
      violations.push({ code: 'ref-price-unavailable', message: `no mark price for ${symbol} — cannot price the close` });
    } else if (qty && violations.every((v) => v.code !== 'slippage-invalid')) {
      price = marketableClosePrice(mark, side, slippage, symbol, rule?.tickSize ?? DEFAULT_STEP);
      estNotional = Number(qty) * mark;
    }
    closing = { positionQty: String(pos.positionQty ?? ''), upnl: String(pos.upnl ?? ''), mark };
  }

  return {
    index,
    input,
    symbol,
    side,
    type: 'LIMIT',
    tif: 'IOC',
    reduceOnly: true,
    qty,
    price,
    estNotional,
    rule,
    closing,
    violations,
    warnings,
  };
}

function sizingViolationCode(err: unknown): Violation['code'] {
  const m = (err as Error).message ?? '';
  if (/min size/.test(m)) return 'below-min-size';
  if (/min notional/.test(m)) return 'below-min-notional';
  if (/lot sizes incompatible/.test(m)) return 'lot-incompatible';
  if (/qty is 0|must be a positive/.test(m)) return 'qty-invalid';
  return 'sizing-failed';
}

/**
 * Validate explicit pair groups and warn about implicit ones.
 * A valid group = exactly two legs, both opens (opposite sides, same base, equal qty,
 * MARKET only) or both closes (same base). Violations attach to every leg in the group.
 */
function applyPairGroupChecks(resolved: ResolvedAction[]): void {
  const groups = new Map<string, ResolvedAction[]>();
  for (const r of resolved) {
    const id = r.input.pairGroupId;
    if (id) {
      const g = groups.get(id) ?? [];
      g.push(r);
      groups.set(id, g);
    }
  }

  for (const [id, legs] of groups) {
    const flag = (code: Violation['code'], message: string) =>
      legs.forEach((l) => l.violations.push({ code, message }));

    if (legs.length !== 2) {
      flag('pair-legs-invalid', `pair group ${id} has ${legs.length} legs (need exactly 2)`);
      continue;
    }
    const [a, b] = legs;
    const kinds = [a.input.kind, b.input.kind];
    const bothOpens = kinds.every((k) => k !== 'close-position');
    const bothCloses = kinds.every((k) => k === 'close-position');
    if (!bothOpens && !bothCloses) {
      flag('pair-legs-invalid', `pair group ${id} mixes open and close legs`);
      continue;
    }
    if (parseSymbol(a.symbol).base !== parseSymbol(b.symbol).base) {
      flag('pair-base-mismatch', `pair group ${id} legs are different coins (${a.symbol} vs ${b.symbol})`);
    }
    if (bothOpens) {
      if (a.side === b.side) {
        flag('pair-side-conflict', `pair group ${id} legs are both ${a.side} — a delta-neutral pair needs opposite sides`);
      }
      const roles = legs.map((l) => ('pairRole' in l.input ? l.input.pairRole : undefined));
      if (roles.some(Boolean)) {
        applyMakerHedgeChecks(id, legs, resolved, flag);
      } else if (a.type !== 'MARKET' || b.type !== 'MARKET') {
        // Role-less pairs keep the historical invariant: an unmanaged resting
        // limit leg leaves you unhedged. Maker-hedge mode is the managed exception.
        flag('pair-type-restricted', `pair group ${id} legs must be MARKET/IOC — a resting limit leg leaves you unhedged (use maker-hedge mode for a managed limit leg)`);
      }
      // Compare numerically: each leg's qty string is formatted to its own lot's
      // decimals ("0.03250" vs "0.0325" are the same size on different venues).
      if (a.qty && b.qty && Number(a.qty) !== Number(b.qty)) {
        flag('pair-qty-mismatch', `pair group ${id} legs have different qty (${a.qty} vs ${b.qty})`);
      }
    } else if (legs.some((l) => 'pairRole' in l.input && l.input.pairRole)) {
      flag('pair-role-invalid', `pair group ${id}: maker/hedge roles are only valid on OPEN pairs`);
    }
  }

  // A pairRole WITHOUT a pairGroupId would fork the execution engine into the
  // maker-hedge machinery while skipping every group check above (they only run
  // per group) — reject it outright.
  for (const r of resolved) {
    if ('pairRole' in r.input && r.input.pairRole && !r.input.pairGroupId) {
      r.violations.push({
        code: 'pair-role-invalid',
        message: `action #${r.index + 1} has pairRole '${r.input.pairRole}' but no pairGroupId — maker-hedge legs must be pair-linked`,
      });
    }
  }

  // Implicit pair heuristic: unlinked same-base opposite-side opens get a warning only.
  const opens = resolved.filter((r) => r.input.kind !== 'close-position' && !r.input.pairGroupId);
  for (let i = 0; i < opens.length; i++) {
    for (let j = i + 1; j < opens.length; j++) {
      const a = opens[i];
      const b = opens[j];
      if (parseSymbol(a.symbol).base === parseSymbol(b.symbol).base && a.side !== b.side) {
        const note = `looks like a delta-neutral pair with action #${b.index + 1} — link them (pairGroupId) to arm the unhedged guard`;
        a.warnings.push(note);
        b.warnings.push(`looks like a delta-neutral pair with action #${a.index + 1} — link them (pairGroupId) to arm the unhedged guard`);
      }
    }
  }
}

/**
 * Maker-hedge role validation for one open pair group. Requirements:
 * exactly one 'maker' (open-limit — tif already forced POC in resolution) and one
 * 'hedge' (open-market); a valid timeout when supplied; maker qty a multiple of the
 * HEDGE lot (each fill increment must be hedgeable without rounding drift); and —
 * single-pair scope — the basket contains nothing besides this one pair.
 */
function applyMakerHedgeChecks(
  id: string,
  legs: ResolvedAction[],
  resolved: ResolvedAction[],
  flag: (code: Violation['code'], message: string) => void,
): void {
  const maker = legs.find((l) => 'pairRole' in l.input && l.input.pairRole === 'maker');
  const hedge = legs.find((l) => 'pairRole' in l.input && l.input.pairRole === 'hedge');
  if (!maker || !hedge) {
    flag('pair-role-invalid', `pair group ${id} needs exactly one 'maker' and one 'hedge' leg`);
    return;
  }
  if (maker.input.kind !== 'open-limit') {
    flag('pair-role-invalid', `pair group ${id}: the maker leg must be an open-limit order (it rests post-only)`);
  }
  if (hedge.input.kind !== 'open-market') {
    flag('pair-role-invalid', `pair group ${id}: the hedge leg must be an open-market order`);
  }
  const timeout = maker.input.kind === 'open-limit' ? maker.input.makerTimeoutSec : undefined;
  if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) {
    flag('pair-role-invalid', `pair group ${id}: makerTimeoutSec must be a positive number of seconds`);
  }
  // Every maker fill increment must be expressible on the hedge venue: require the
  // shared qty to be a multiple of the hedge lot (sub-lot tails would be unhedgeable).
  const hedgeLot = hedge.rule?.lotSize;
  if (maker.qty && hedgeLot && Number(hedgeLot) > 0 && !isMultipleOf(Number(maker.qty), hedgeLot)) {
    flag('lot-incompatible', `pair group ${id}: maker qty ${maker.qty} is not a multiple of the hedge venue lot ${hedgeLot}`);
  }
  // Timeout/convert is a DESIGNED outcome: the maker remainder becomes a MARKET
  // order, so the maker qty must be market-executable up front. Its LIMIT-side
  // validation alone admits sizes the (routinely smaller) market cap rejects —
  // which mid-flight means a deterministic one-sided completion.
  const makerMaxMkt = Number(maker.rule?.maxMarketSize);
  if (maker.qty && makerMaxMkt > 0 && Number(maker.qty) > makerMaxMkt) {
    flag(
      'exceeds-max-market-size',
      `pair group ${id}: maker qty ${maker.qty} exceeds ${maker.symbol}'s max MARKET order size ${maker.rule?.maxMarketSize} — the timeout/convert path submits market orders; reduce the size`,
    );
  }
  // single-pair scope: one maker-hedge pair per basket, nothing else — the engine's phase
  // machine owns the whole basket lifecycle and does not compose with other actions.
  // (The child-order text budget is validated in planExecution, where the tag is known.)
  if (resolved.length !== 2) {
    flag('pair-mode-mixed-actions', `a maker-hedge basket must contain exactly the two pair legs (got ${resolved.length} actions)`);
  }
}

/** Hard violations across a resolved basket (what blocks /api/execute). */
export function collectViolations(resolved: ResolvedAction[]): Array<{ index: number; violation: Violation }> {
  return resolved.flatMap((r) => r.violations.map((violation) => ({ index: r.index, violation })));
}
