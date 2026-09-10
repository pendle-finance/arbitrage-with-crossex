/** StrategyRollup + StrategyCard's displayed locals → the v1 share payload.
 *
 * WHITELIST-COPY ONLY — every field is named here explicitly, and the rollup
 * is never spread. That is the privacy contract: `warnings[]` (free text),
 * `symbol`, the entry-cost part ids and everything else identifying simply
 * have no path into the wire format. The APR/PnL inputs are the numbers the
 * card DISPLAYS (post-applyCostFlags) — this module never re-derives them, so
 * what the viewer of the link sees is exactly what the sharer saw. */
import type { StrategyRollup } from '../api/types';
import type { ShareLegV1, SharePayloadV1 } from '../lib/shareCodec';
import { legTokenSize, type CostFlags } from './strategyMath';
import type { PairEstimate } from './assets/assetModel';

export function buildSharePayload(opts: {
  s: StrategyRollup;
  /** StrategyCard's own displayed locals — non-null by the Share gating. */
  fixedAprOnCapital: number;
  expectedUsd: number;
  flags: CostFlags;
  nowSec: number;
}): SharePayloadV1 {
  const { s } = opts;
  // Float-noise trim for tn below — NOT the privacy rounding. That job is done
  // by re-expressing the already-$100-rounded n in tokens: 4 sig figs alone
  // would be ~200x finer than n's bucket on a small book.
  const sig4 = (v: number) => Number(v.toPrecision(4));
  // Codec BASE_RE, checked here so an out-of-charset upstream symbol (or a
  // silly quantity) drops the bracket instead of throwing in encodeSharePayload
  // and taking the Share button down with it.
  const SYMBOL_RE = /^[A-Z0-9]{1,12}$/;
  const legs: ShareLegV1[] = s.legs.map((l) => {
    const leg: ShareLegV1 = {
      k: l.kind === 'boros' ? 'b' : 'p',
      x: l.venue,
      s: l.side === 'SHORT' ? 'S' : 'L',
      // Nearest $100: what fmtUsdCompact displays anyway. Exact whole-dollar
      // notionals would join a public Boros fill uniquely — share display
      // precision, not book precision.
      n: Math.round(l.notionalUsd / 100) * 100,
    };
    if (l.kind === 'boros' && l.entryApr !== undefined) leg.r = l.entryApr;
    // Shared with the card's notional column, so a shared image can never
    // bracket a leg differently than the card it was taken from.
    const token = legTokenSize(l);
    if (token && SYMBOL_RE.test(token.symbol) && token.qty > 0 && l.notionalUsd > 0) {
      // The rounded n re-expressed in tokens at the leg's own implied price:
      // tn carries nothing n doesn't already say — the same $100 bucket, in
      // token terms — then sig4 trims float noise (display shows at most 4).
      const tn = sig4((leg.n * token.qty) / l.notionalUsd);
      if (tn > 0 && tn < 1e12) {
        leg.tn = tn;
        leg.ts = token.symbol;
      }
    }
    return leg;
  });
  // Deterministic order (Boros before perp, SHORT before LONG, then venue):
  // identical books encode to identical links.
  const rank = (l: ShareLegV1) => `${l.k === 'b' ? 0 : 1}:${l.s === 'S' ? 0 : 1}:${l.x}`;
  legs.sort((a, b) => (rank(a) < rank(b) ? -1 : rank(a) > rank(b) ? 1 : 0));
  const h: SharePayloadV1['h'] = s.hedge === 'hedged' ? 'h' : s.hedge === 'partial' ? 'p' : 'u';
  // The fee block must reconcile with the DISPLAYED p/q. When individual entry
  // executions are excluded (itemisation), the headline numbers hand their cost
  // back — so the shared fee lines carry only the CHARGED entry parts, the same
  // chargedEntryUsd doctrine as the card. With the master switch off (ce=0) the
  // raw paid figures stay: the label says they're unattributed, not unspent.
  let paidPerpFees = s.feesUsd.paid.perpTradingUsd;
  let paidPerpSlippage = s.feesUsd.paid.perpEntrySlippageUsd;
  const excluded = opts.flags.excludedEntryPartIds;
  if (opts.flags.inclEntryCost && excluded && excluded.size > 0) {
    for (const part of s.perpEntryCostParts ?? []) {
      if (!excluded.has(part.id)) continue;
      if (part.kind === 'fees') paidPerpFees -= part.usd;
      else if (paidPerpSlippage !== null) paidPerpSlippage -= part.usd;
    }
  }
  return {
    v: 1,
    b: s.base,
    t: opts.nowSec,
    m: s.maturity,
    // UTC-day bucket. The page's timeline renders dates, never seconds — and
    // the exact open second is the strongest join key against public Boros
    // fills. Coarsen what display never uses.
    cs: s.clockStartSec === null ? null : s.clockStartSec - (s.clockStartSec % 86_400),
    a: opts.fixedAprOnCapital,
    c: s.capitalUsd,
    cp: s.capitalSplit.perpUsd,
    cb: s.capitalSplit.borosUsd,
    p: opts.expectedUsd,
    sp: s.spread,
    h,
    ce: opts.flags.inclEntryCost ? 1 : 0,
    cx: opts.flags.inclExitFees ? 1 : 0,
    // A split the terminal PROPOSED (no execution record explained how the
    // shared leg divides) must not read as fact on a public page.
    ...(s.attribution?.confidence === 'unconfirmed' ? { uc: 1 as const } : {}),
    l: legs,
    f: {
      pp: paidPerpFees,
      ps: paidPerpSlippage,
      pb: s.feesUsd.paid.borosTradeUsd,
      pl: s.feesUsd.paid.borosSettlementUsd,
      fp: s.feesUsd.future.perpExitFeesUsd,
      fs: s.feesUsd.future.perpExitSlippageUsd,
      fb: s.feesUsd.future.borosSettlementUsd,
    },
  };
}

/** PairEstimate → the same v1 payload, for the asset view's pair popup.
 *
 * Same WHITELIST-COPY contract as `buildSharePayload`: every field is named
 * explicitly, the pair is never spread, and the displayed numbers are passed
 * in rather than re-derived so the link shows exactly what the sharer saw.
 *
 * A pair is an ESTIMATE (the short side is sliced proportionally), so it always
 * mints `uc: 1` — the shared page must not present a proposed split as fact. */
export function pairSharePayload(
  pair: PairEstimate,
  base: string,
  opts: {
    nowSec: number;
    inclPerpFees: boolean;
    inclExitFee: boolean;
    /** The popup's displayed net APR / net dollars. */
    netApr: number | null;
    netUsd: number | null;
  },
): SharePayloadV1 {
  const sig4 = (v: number) => Number(v.toPrecision(4));
  const SYMBOL_RE = /^[A-Z0-9]{1,12}$/;
  // Same $100 bucket as the strategy card: an exact notional would join a
  // public Boros fill uniquely.
  const round100 = (v: number) => Math.round(v / 100) * 100;
  // `pair.notionalUsd` is the TWO PERP legs' notional at `pair.size` each, so
  // one unit of size is worth notionalUsd / (2 × size). Every leg — perp or
  // YU — is priced off that. (Dividing the pair notional across all four
  // legs' sizes halved each leg's figure: the YU legs are the same size as
  // the perps but were never part of that notional.)
  const usdPerUnit = pair.size > 0 ? pair.notionalUsd / (2 * pair.size) : 0;
  const legs: ShareLegV1[] = pair.legs.map((l) => {
    const leg: ShareLegV1 = {
      k: l.kind === 'yu' ? 'b' : 'p',
      x: l.venue,
      s: l.side === 'SHORT' ? 'S' : 'L',
      n: round100(Math.abs(l.size) * usdPerUnit),
    };
    if (l.kind === 'yu' && l.lockedApr !== null) leg.r = l.lockedApr;
    // `tn`/`ts` is a COIN quantity; a USD-unit asset's sizes are dollars, and
    // dollars stamped with the coin's ticker would put "20k SOL" on a card
    // for a $20k position.
    if (pair.unit === 'base' && SYMBOL_RE.test(base) && Math.abs(l.size) > 0 && leg.n > 0) {
      const tn = sig4(Math.abs(l.size));
      if (tn > 0 && tn < 1e12) {
        leg.tn = tn;
        leg.ts = base;
      }
    }
    return leg;
  });
  const rank = (l: ShareLegV1) => `${l.k === 'b' ? 0 : 1}:${l.s === 'S' ? 0 : 1}:${l.x}`;
  legs.sort((a, b) => (rank(a) < rank(b) ? -1 : rank(a) > rank(b) ? 1 : 0));
  return {
    v: 1,
    b: base,
    t: opts.nowSec,
    m: pair.soonestMaturitySec,
    // UTC-day bucket, as above: the exact open second is the strongest join
    // key against public Boros fills, and the timeline only renders dates.
    cs:
      pair.hedgedSinceSec === null
        ? null
        : pair.hedgedSinceSec - (pair.hedgedSinceSec % 86_400),
    a: opts.netApr ?? 0,
    c: pair.capitalUsd,
    // The pair model carries one capital figure, not a perp/Boros split.
    cp: null,
    cb: null,
    p: opts.netUsd ?? 0,
    // The card prints this as "N% locked spread", and a spread is a rate on
    // NOTIONAL: what the receive leg locks minus what the pay leg locks, net
    // of settlement fees. `lockedAprFwd` is that same carry over CAPITAL —
    // the leveraged figure the headline APR already shows — and it read as
    // a 32% "spread" beside a 26% APR. Recover the notional basis from it:
    // carry per year = lockedAprFwd × capital; per-leg notional = half the
    // pair's two perp notionals.
    sp: (() => {
      const perLegNotional = pair.notionalUsd / 2;
      return pair.lockedAprFwd !== null && perLegNotional > 0 ? (pair.lockedAprFwd * pair.capitalUsd) / perLegNotional : 0;
    })(),
    // A pair only exists once both sides are on, and assetModel builds it from
    // legs that are open on both venues.
    h: 'h',
    // The perp-side cost switches the popup exposes.
    ce: opts.inclPerpFees ? 1 : 0,
    cx: opts.inclExitFee ? 1 : 0,
    // Always: the short side is sliced by today's sizes, never measured.
    uc: 1,
    l: legs,
    f: {
      pp: opts.inclPerpFees ? pair.perpFeesPaidUsd : 0,
      ps: null,
      // The pair model does not separate Boros trade from settlement fees.
      pb: pair.borosFeesPaidUsd,
      pl: 0,
      fp: opts.inclExitFee ? pair.exitFeeUsd : null,
      fs: null,
      fb: 0,
    },
  };
}
