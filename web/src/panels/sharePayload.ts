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
