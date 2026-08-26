/**
 * Margin preflight — the money-safety gate that keeps a pair from opening one leg
 * when the account can only fund one. Runs inside `planExecution` (pre-202, nothing
 * sent yet), so a shortfall aborts the WHOLE basket with a clean 400 rather than
 * leaving one filled leg naked (the venue rejects the second leg on margin, and the
 * engine has no rollback — it only surfaces the imbalance for manual remediation).
 *
 * Design invariants:
 *  - **Reduce-only legs consume no margin** (a close FREES it). They contribute 0 to
 *    the requirement, so a close (or close-pair) is never blocked — including for an
 *    underwater account, which is exactly the account that most needs to close.
 *  - **An open leg is netted against the live opposite position.** `reduceOnly` is a
 *    flag on the ORDER, not a description of its effect: in one-way mode a plain BUY
 *    against a short shrinks the position and releases IM. The pair ticket unwinds a
 *    hedged book exactly this way (BUY the short venue, SELL the long venue) with two
 *    ordinary opens. Only the excess PAST flat is charged. ONE-WAY MODE ONLY: in hedge
 *    mode that BUY opens a separate long at full IM, so netting would UNDER-require —
 *    the one direction this file must never move in. Gated on positionMode.
 *  - **Fail-open on any READ failure.** If the account / reference-price / leverage
 *    read throws (endpoint down, 429, unreachable), the preflight SKIPS rather than
 *    blocks: fail-closed would turn a flaky Gate endpoint into a trading outage that
 *    also blocks hedge-opens and remediation — strictly worse than today for a
 *    delta-neutral book, where the venue is already the authoritative margin check at
 *    submit. A SUCCESSFUL read that shows a shortfall always blocks. The preflight can
 *    only ever REMOVE a failure mode, never add one.
 *  - **Slightly over-require, on purpose.** A small IM buffer + a taker-fee reserve
 *    absorb 2s-stale reads and the parts of Gate's margin formula this repo can't see;
 *    the buffer is deliberately small so it never false-blocks a legitimate near-full
 *    deploy (H1 is an order-of-magnitude shortfall, not a rounding one).
 */
import type { CrossexAccount } from 'gate-api';
import type { ResolvedAction } from './actions';
import type { Clients } from './clients';
import { CoreError } from './errors';
import { parseSymbol } from './numbers';
import { resolveReferencePrice } from './orders';

/** Reserve for entry taker fees, as a fraction of notional. Recorded Gate CrossEx
 * future taker is ~4.8bps (some overrides 4bps); 10bps is ~2x headroom and, being a
 * constant, keeps the preflight to one account GET (no fee-table fetch on the hot
 * path) while never under-reserving in the dangerous direction by more than bps. */
export const TAKER_FEE_RESERVE = 0.001;

/** Multiplier on the initial-margin term: covers mark drift over the ≤2s-stale account
 * read, unverified venue-formula details (mark vs order price, funding accrual), and
 * USDT/USDC quote-proxy skew. Small on purpose — a big buffer would false-block users
 * deploying near-full margin, a real cost on a money product. */
export const PREFLIGHT_MARGIN_BUFFER = 1.05;

export interface PreflightDeps {
  /** Cache-backed account read (the server passes one keyed on the shared `account`
   * cache); defaults to a direct `getCrossexAccount`. */
  getAccount?: () => Promise<CrossexAccount>;
  /** Reference price for a BASE_QUOTE pair (test seam); defaults to Gate spot/futures. */
  getReferencePrice?: (pair: string) => Promise<number | null>;
  /** Current effective per-symbol leverage (test seam); defaults to Gate CrossEx.
   * Values may be numbers or strings (the SDK returns strings) — coerced below. */
  getPositionLeverage?: (symbols: string[]) => Promise<Record<string, string | number>>;
  /** Live positions, for netting an unwinding leg (test seam). A failure charges every
   * leg in full — over-requiring, not under. */
  getPositions?: () => Promise<Array<{ symbol?: string; positionQty?: string | number }>>;
}

interface LegRequirement {
  index: number;
  symbol: string;
  notional: number;
  leverage: number;
}

/**
 * Throw `CoreError('insufficient-margin')` when the resolved basket needs more margin
 * than the account has available. Never throws for a read failure (fail-open).
 */
export async function preflightMargin(
  clients: Clients,
  resolved: ResolvedAction[],
  deps: PreflightDeps = {},
): Promise<void> {
  // Reduce-only (close) legs lock no IM — exclude them entirely.
  const openLegs = resolved.filter((r) => !r.reduceOnly);
  if (openLegs.length === 0) return;

  const refPriceFor =
    deps.getReferencePrice ??
    (async (pair: string) => {
      try {
        return (await resolveReferencePrice(clients, { pairs: [pair] })).price;
      } catch {
        return null;
      }
    });

  // Price each open leg. Market opens carry estNotional=0 at execute time (the qty is
  // already resolved so resolveActions skips the ref lookup), so we must price them
  // ourselves. A per-leg pricing failure EXEMPTS that leg (fail-open), not the basket.
  const refCache = new Map<string, number | null>();
  const priced: Array<{ leg: ResolvedAction; index: number; symbol: string; notional: number; leverage?: number }> = [];
  for (const leg of openLegs) {
    let notional = leg.estNotional > 0 ? leg.estNotional : 0;
    if (notional <= 0) {
      const { pair } = parseSymbol(leg.symbol);
      if (!refCache.has(pair)) {
        try {
          refCache.set(pair, await refPriceFor(pair));
        } catch {
          refCache.set(pair, null);
        }
      }
      const px = refCache.get(pair);
      if (px == null || !(px > 0)) continue; // unpriceable → exempt this leg
      notional = Number(leg.qty) * px;
    }
    if (!(notional > 0)) continue;
    priced.push({ leg, index: leg.index, symbol: leg.symbol, notional, leverage: leg.leverage?.requested });
  }
  if (priced.length === 0) return; // nothing priceable — no account read needed

  // Read once, after pricing: gives both the comparison and the netting mode. Fail-open.
  let account: CrossexAccount;
  try {
    account = deps.getAccount ? await deps.getAccount() : (await clients.crossEx.getCrossexAccount()).body;
  } catch (err) {
    console.warn(`[preflight] account read failed — skipping margin check (fail-open): ${(err as Error).message}`);
    return;
  }
  const available = Number(account.availableMargin);
  if (!Number.isFinite(available)) {
    console.warn('[preflight] account.availableMargin not a number — skipping margin check (fail-open)');
    return;
  }

  // Net off the share of each leg that only unwinds. Symbols uppercased both sides (as
  // create.ts/actions.ts do): a casing miss silently charges in full, i.e. the bug back.
  if (isOneWayMode(account.positionMode)) {
    const posQty = new Map<string, number>();
    try {
      const rows = deps.getPositions
        ? await deps.getPositions()
        : (await clients.crossEx.listCrossexPositions()).body ?? [];
      for (const r of rows) {
        const q = Number(r?.positionQty);
        if (r?.symbol && Number.isFinite(q) && q !== 0) posQty.set(r.symbol.toUpperCase(), q);
      }
    } catch (err) {
      console.warn(`[preflight] positions read failed — charging every leg in full: ${(err as Error).message}`);
    }
    for (const p of priced) p.notional *= 1 - offsetFraction(p.leg, posQty.get(p.symbol.toUpperCase()));
  } else {
    console.warn(`[preflight] positionMode '${account.positionMode}' is not one-way — charging every leg in full`);
  }
  const opening = priced.filter((p) => p.notional > 0);
  if (opening.length === 0) return;

  // Fill in leverage for legs that don't carry a requested value (remediation
  // completeLeg, hand-built baskets) from the account's CURRENT effective leverage —
  // one batched read. A failure exempts those legs (fail-open).
  const needLev = opening.filter((p) => !(p.leverage && p.leverage > 0));
  if (needLev.length > 0) {
    const symbols = [...new Set(needLev.map((p) => p.symbol))];
    let levMap: Record<string, string | number> = {};
    try {
      levMap = deps.getPositionLeverage
        ? await deps.getPositionLeverage(symbols)
        : (await clients.crossEx.getCrossexPositionsLeverage({ symbols: symbols.join(',') })).body ?? {};
    } catch (err) {
      console.warn(`[preflight] leverage read failed — exempting ${needLev.length} leg(s): ${(err as Error).message}`);
      levMap = {};
    }
    for (const p of needLev) {
      const lev = Number(levMap[p.symbol]);
      if (Number.isFinite(lev) && lev > 0) p.leverage = lev;
    }
  }

  const legs: LegRequirement[] = opening
    .filter((p) => !!p.leverage && p.leverage > 0)
    .map((p) => ({ index: p.index, symbol: p.symbol, notional: p.notional, leverage: p.leverage as number }));
  if (legs.length === 0) return; // nothing we can size confidently → fail-open

  const required =
    legs.reduce((s, l) => s + l.notional / l.leverage, 0) * PREFLIGHT_MARGIN_BUFFER +
    legs.reduce((s, l) => s + l.notional, 0) * TAKER_FEE_RESERVE;

  if (required > available) {
    throw new CoreError(
      `insufficient margin: this basket needs ≈ $${required.toFixed(2)} ` +
        `(incl. taker-fee reserve + ${Math.round((PREFLIGHT_MARGIN_BUFFER - 1) * 100)}% buffer) ` +
        `but only $${available.toFixed(2)} is available — nothing was sent`,
      'insufficient-margin',
      { required, available, legs },
    );
  }
}

/** Fraction of an open leg that only nets down an opposite position (1 = fully
 * offsetting). Unknown/aligned ⇒ 0 (charge in full). Mirrors web/src/trade/previewBits.tsx. */
function offsetFraction(leg: ResolvedAction, positionQty: number | undefined): number {
  const qty = Number(leg.qty);
  if (positionQty === undefined || !Number.isFinite(qty) || qty <= 0) return 0;
  const opposes = leg.side === 'BUY' ? positionQty < 0 : positionQty > 0;
  if (!opposes) return 0;
  return Math.min(qty, Math.abs(positionQty)) / qty;
}

/** One-way (netting) mode? Gate reports 'SINGLE'. Anything else — hedge mode, or an
 * unrecognised value — answers NO and charges in full: a wrong YES can half-fill a pair. */
function isOneWayMode(mode: string | undefined): boolean {
  const m = (mode ?? '').toUpperCase();
  return m === 'SINGLE' || m === 'ONE_WAY' || m === 'ONEWAY';
}
