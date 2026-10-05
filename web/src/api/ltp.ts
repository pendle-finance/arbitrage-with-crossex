import { useQuery } from '@tanstack/react-query';
import { fetchJson } from './client';
import type { BorosEntryMode, EntryMode, ExitMode } from './types';
import type { LtpOpportunitiesResult, LtpTier } from './ltpTypes';

const isValidOpportunityNotional = (n: number) => Number.isFinite(n) && n >= 1_000 && n <= 100_000_000;
const ltpQueryKey = (
  notionalUsd: number,
  borosEntry: BorosEntryMode,
  entryMode: EntryMode,
  exitMode: ExitMode,
  ltpTier: LtpTier | 'account',
  perpLeverage: number,
  borrowLeverage: number,
  loanRateApr: number,
) =>
  [
    'opportunities-ltp',
    notionalUsd,
    borosEntry,
    entryMode,
    exitMode,
    ltpTier,
    perpLeverage,
    borrowLeverage,
    loanRateApr,
  ] as const;

/** Mirror of the server's LTP tier list (src/core/ltp/feeTiers.ts) and knob
 * bounds (src/server/routes/opportunitiesLtp.ts) — anything outside is a 400,
 * so the hook must not send it. */
export const LTP_TIERS = ['vip1', 'vip2', 'vip3', 'vip4', 'vip5'] as const satisfies readonly LtpTier[];
export const LTP_PERP_LEVERAGE_MIN = 1;
export const LTP_PERP_LEVERAGE_MAX = 50;
export const LTP_BORROW_LEVERAGE_MIN = 1;
export const LTP_BORROW_LEVERAGE_MAX = 5;

export function isValidPerpLeverage(l: number): boolean {
  return Number.isFinite(l) && l >= LTP_PERP_LEVERAGE_MIN && l <= LTP_PERP_LEVERAGE_MAX;
}

export function isValidBorrowLeverage(m: number): boolean {
  return Number.isFinite(m) && m >= LTP_BORROW_LEVERAGE_MIN && m <= LTP_BORROW_LEVERAGE_MAX;
}

/** PERCENT, the unit the knob edits (9.5 = 9.5%/yr); the hook converts to the
 * wire's decimal fraction. 0 is allowed — a free-loan what-if. */
export function isValidLoanRatePct(pct: number): boolean {
  return Number.isFinite(pct) && pct >= 0 && pct <= 100;
}

export interface LtpOpportunitiesParams {
  notionalUsd: number;
  borosEntry: BorosEntryMode;
  entryMode: EntryMode;
  exitMode: ExitMode;
  /** 'account' omits the param, so the server prices from the account's own
   * fee schedule when LTP keys are configured (VIP1 + warning otherwise); an
   * explicit vipN is a what-if the server always honors. */
  ltpTier: LtpTier | 'account';
  perpLeverage: number;
  borrowLeverage: number;
  /** Percent (9.5), converted to the wire fraction here. */
  loanRatePct: number;
}

/** The Boros + LTP variant of useOpportunities: every knob is a server param
 * and part of the key. The compound `enabled` guard keeps out-of-bounds knob
 * states (mid-edit) from ever sending a 400-able request. */
export function useLtpOpportunities(
  p: LtpOpportunitiesParams,
  opts?: {
    /** First-paint seed (e.g. the caller's persisted last scan) — shown as
     * placeholder data (dimmed, `isPlaceholderData`) until the live fetch
     * lands. Previous live data still wins over the seed on knob changes. */
    placeholder?: LtpOpportunitiesResult;
  },
) {
  const loanRateApr = p.loanRatePct / 100;
  const search =
    `?notionalUsd=${p.notionalUsd}&borosEntry=${p.borosEntry}` +
    `&entryMode=${p.entryMode}&exitMode=${p.exitMode}` +
    (p.ltpTier === 'account' ? '' : `&ltpTier=${p.ltpTier}`) +
    `&perpLeverage=${p.perpLeverage}&borrowLeverage=${p.borrowLeverage}&loanRateApr=${loanRateApr}`;
  return useQuery({
    queryKey: ltpQueryKey(
      p.notionalUsd,
      p.borosEntry,
      p.entryMode,
      p.exitMode,
      p.ltpTier,
      p.perpLeverage,
      p.borrowLeverage,
      loanRateApr,
    ),
    queryFn: () => fetchJson<LtpOpportunitiesResult>(`/opportunities-ltp${search}`),
    enabled:
      isValidOpportunityNotional(p.notionalUsd) &&
      isValidPerpLeverage(p.perpLeverage) &&
      isValidBorrowLeverage(p.borrowLeverage) &&
      isValidLoanRatePct(p.loanRatePct),
    refetchInterval: 12_000,
    placeholderData: (prev: LtpOpportunitiesResult | undefined) => prev ?? opts?.placeholder,
  });
}
