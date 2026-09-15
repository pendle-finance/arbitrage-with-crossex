/**
 * Gate CrossEx USDT-margined futures fee schedule per Gate VIP tier — the
 * SIMULATED fallback used when there is no account to read (`?feeTier=vipN` on
 * /api/opportunities; the unconfigured first-run view always sends one).
 *
 * Source: Gate Help Center, "Cross-Exchange Account Fee Schedule"
 * (https://www.gate.com/help/crossex/functional/49701, last updated 2026-07-14)
 * — the page gate.com/crossex links as its fee schedule. CrossEx charges these
 * rates itself per venue; the venue's own public schedule does not additionally
 * apply. Cross-checked against Gate's fee API (apiw/v2/futures/usdt/fee_list,
 * Wayback 2026-07-03) and the CrossEx FAQ (help/crossex/functional/49324).
 *
 * Rates are decimal-rate STRINGS in the exact shape GET /crossex/fee returns
 * (VenueFeeRow), so everything downstream treats simulated and live rows
 * identically. Live accounts can also carry per-symbol special_fee_list
 * overrides — a simulation can't know those, which is one reason it is only a
 * default where no account exists.
 */
import { CoreError } from '../errors';
import type { VenueFeeRow } from './fees';

export const CROSSEX_FEE_TIERS = [
  'vip0',
  'vip1',
  'vip2',
  'vip3',
  'vip4',
  'vip5',
  'vip6',
  'vip7',
  'vip8',
  'vip9',
  'vip10',
  'vip11',
  'vip12',
  'vip13',
  'vip14',
  'vip15',
  'vip16',
] as const;
export type CrossexFeeTier = (typeof CROSSEX_FEE_TIERS)[number];

type MakerTaker = readonly [maker: string, taker: string];

/** VIP0..VIP16 [maker, taker] — identical on every venue up to VIP10. */
const BASE_LADDER: readonly MakerTaker[] = [
  ['0.0002', '0.0005'], // VIP0   0.02% / 0.05%
  ['0.0002', '0.0005'], // VIP1
  ['0.0002', '0.0005'], // VIP2
  ['0.0002', '0.00048'], // VIP3
  ['0.0002', '0.00048'], // VIP4
  ['0.0002', '0.00045'], // VIP5
  ['0.00018', '0.00042'], // VIP6
  ['0.00016', '0.000375'], // VIP7
  ['0.00014', '0.00035'], // VIP8
  ['0.00012', '0.00032'], // VIP9
  ['0.0001', '0.0003'], // VIP10
  ['0.00008', '0.00028'], // VIP11
  ['0.00006', '0.00026'], // VIP12
  ['0.00005', '0.00024'], // VIP13
  ['0.00002', '0.00022'], // VIP14
  ['0', '0.00018'], // VIP15
  ['0', '0.00016'], // VIP16
];

/** Where a venue's floor diverges from the base ladder (high tiers only). */
const VENUE_OVERRIDES: Record<string, Record<number, MakerTaker>> = {
  BINANCE: { 15: ['0.000018', '0.00018'], 16: ['0.000018', '0.00018'] },
  OKX: {
    13: ['0.00005', '0.00025'],
    14: ['0.00002', '0.00025'],
    15: ['0', '0.00025'],
    16: ['0', '0.00025'],
  },
  BYBIT: { 15: ['0', '0.0002'], 16: ['0', '0.0002'] },
  KRAKEN: { 15: ['0', '0.0002'], 16: ['0', '0.0002'] },
  HYPERLIQUID: {
    11: ['0.000084', '0.00028'],
    12: ['0.000084', '0.00028'],
    13: ['0.000084', '0.00028'],
    14: ['0.000084', '0.00028'],
    15: ['0.000084', '0.00028'],
    16: ['0.000084', '0.00028'],
  },
};

export function feeTierLabel(tier: CrossexFeeTier): string {
  return `VIP ${tier.slice(3)}`;
}

/** Query-param form ('vip0'..'vip16') → tier; absent stays absent; anything
 * else is a 400. */
export function parseFeeTier(raw: string | undefined): CrossexFeeTier | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (!(CROSSEX_FEE_TIERS as readonly string[]).includes(raw)) {
    throw new CoreError(
      `invalid feeTier (expected ${CROSSEX_FEE_TIERS[0]}–${CROSSEX_FEE_TIERS[CROSSEX_FEE_TIERS.length - 1]})`,
      'validation',
    );
  }
  return raw as CrossexFeeTier;
}

/** The tier's schedule in /crossex/fee row shape — one row per venue. */
export function feeRowsForTier(tier: CrossexFeeTier, venues: Iterable<string>): VenueFeeRow[] {
  const level = Number(tier.slice(3));
  return [...venues].map((venue) => {
    const [futureMakerFee, futureTakerFee] = VENUE_OVERRIDES[venue]?.[level] ?? BASE_LADDER[level];
    return { exchangeType: venue, futureMakerFee, futureTakerFee };
  });
}
