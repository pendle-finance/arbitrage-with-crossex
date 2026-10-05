/**
 * LTP VIP fee tiers — USDT-margin FUTURES rates only (the LTP opportunities
 * engine trades perp legs; spot never enters the math).
 *
 * LTP does not publish its fee schedule: `GET /trading/userFeeRate` reports
 * only the calling account's own level, and the full VIP ladder is shared with
 * clients privately. This repo is public, so the committed default carries
 * VIP1 ONLY — the same maker/taker pair LTP's own public API-doc examples use,
 * which publishes nothing new. The operator supplies the rest of the ladder in
 * a local, gitignored JSON (see `parseLtpLadder` for the accepted shapes; the
 * route loads it from LTP_FEE_TIERS_PATH, default scripts/ltp/fee-tiers.local.json).
 *
 * Rates are per-fill decimal FRACTIONS of notional (0.00035 = 3.5 bp), never
 * percent. Negative makerRate = a rebate (VIP4+), and flows through the cost
 * model as a negative cost.
 */

export const LTP_FEE_TIERS = ['vip1', 'vip2', 'vip3', 'vip4', 'vip5'] as const;
export type LtpFeeTier = (typeof LTP_FEE_TIERS)[number];

export interface LtpTierRates {
  makerRate: number;
  takerRate: number;
}

/** Tier → futures rates; tiers absent from the merged ladder can't be priced. */
export type LtpLadder = Partial<Record<LtpFeeTier, LtpTierRates>>;

/** Committed fallback: VIP1 only (see module doc for why). */
export const LTP_DEFAULT_LADDER: LtpLadder = {
  vip1: { makerRate: 0.0001, takerRate: 0.00035 },
};

export function parseLtpFeeTier(raw: string | undefined): LtpFeeTier | undefined {
  return (LTP_FEE_TIERS as readonly string[]).includes(raw ?? '') ? (raw as LtpFeeTier) : undefined;
}

export function ltpFeeTierLabel(tier: LtpFeeTier): string {
  return `VIP ${tier.slice(3)}`;
}

const asRate = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v;
  // Fees are fractions: anything at or beyond ±10% per fill is junk (a percent
  // value pasted where a fraction belongs), not a plausible rate.
  return typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 0.1 ? n : null;
};

/**
 * Tolerant ladder coercion for the operator-supplied JSON. Accepts, per tier:
 *   { "vip2": { "makerRate": 0.00005, "takerRate": 0.00025 } }
 *   { "vip2": [0.00005, 0.00025] }            // [maker, taker]
 * Values may be numbers or numeric strings, but are always FRACTIONS —
 * percent-vs-fraction is never guessed. Invalid entries are dropped, never
 * defaulted, so a malformed tier reads as "not configured" downstream.
 */
export function parseLtpLadder(json: unknown): LtpLadder {
  const out: LtpLadder = {};
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return out;
  for (const tier of LTP_FEE_TIERS) {
    const entry = (json as Record<string, unknown>)[tier];
    if (entry === undefined || entry === null) continue;
    let maker: number | null = null;
    let taker: number | null = null;
    if (Array.isArray(entry)) {
      maker = asRate(entry[0]);
      taker = asRate(entry[1]);
    } else if (typeof entry === 'object') {
      const rec = entry as Record<string, unknown>;
      maker = asRate(rec.makerRate);
      taker = asRate(rec.takerRate);
    }
    if (maker !== null && taker !== null) out[tier] = { makerRate: maker, takerRate: taker };
  }
  return out;
}

/**
 * Rates for a tier from the merged ladder (file entries win over the committed
 * default); null when the tier isn't configured — the caller degrades with a
 * warning rather than guessing.
 */
export function ltpFeeRatesForTier(ladder: LtpLadder, tier: LtpFeeTier): LtpTierRates | null {
  return ladder[tier] ?? LTP_DEFAULT_LADDER[tier] ?? null;
}
