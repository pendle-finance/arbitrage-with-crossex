/**
 * Every trading account — CrossEx and each
 * Boros account — in ONE format: balance and available, initial margin used,
 * maintenance margin used. Every account liquidates when maintenance margin
 * used reaches 100%, so one scale and one verdict cover them all.
 */
import type { AssetBorosMargin, CrossexAccount } from '../../api/types';
import { marginParts } from '../../lib/margin';
import { prettyVenue } from '../../lib/fmt';

export type RiskLevel = 'ok' | 'watch' | 'risk';

/** Amber from 67% maintenance margin used, red from 91%. */
export const WATCH_MM_USED = 0.67;
export const RISK_MM_USED = 0.91;

export const levelOf = (mmUsed: number | null): RiskLevel =>
  mmUsed === null ? 'ok' : mmUsed >= RISK_MM_USED ? 'risk' : mmUsed >= WATCH_MM_USED ? 'watch' : 'ok';

export interface AccountRow {
  key: string;
  venue: 'CrossEx' | 'Boros';
  name: string;
  /** Account value (CrossEx margin balance; Boros equity), USD. */
  balanceUsd: number | null;
  availableUsd: number | null;
  /** Boros: the same two figures in the account's collateral (ETH, BTC…).
   * Null for CrossEx, and for a dollar collateral (already shown in $). */
  token: { symbol: string; available: number; balance: number | null } | null;
  /** Initial margin ÷ balance. */
  imUsed: number | null;
  /** Maintenance margin ÷ balance — liquidates at 100%. */
  mmUsed: number | null;
  level: RiskLevel;
}

export interface AccountsView {
  rows: AccountRow[];
  level: RiskLevel;
  /** How many accounts sit at the verdict's level. */
  flagged: number;
  /** The account the verdict is about (the fullest at the worst level). */
  worst: AccountRow | null;
  /** Per venue, for the header: Boros sums every account. */
  totals: Record<'CrossEx' | 'Boros', { availableUsd: number; balanceUsd: number } | null>;
}

const ratio = (part: number | null, whole: number | null): number | null =>
  part === null || whole === null || !(whole > 0) ? null : Math.max(0, part) / whole;

export function buildAccountsView(input: {
  acc: CrossexAccount | null | undefined;
  borosMargin: AssetBorosMargin[];
}): AccountsView {
  const rows: AccountRow[] = [];

  if (input.acc) {
    const p = marginParts(input.acc);
    rows.push({
      key: 'crossex',
      venue: 'CrossEx',
      name: 'Gate CrossEx',
      balanceUsd: p.hasFunds ? p.balance : null,
      availableUsd: Number(input.acc.availableMargin) || 0,
      token: null,
      imUsed: p.hasFunds ? p.imPct : null,
      mmUsed: p.hasFunds ? p.mmPct : null,
      level: levelOf(p.hasFunds ? p.mmPct : null),
    });
  }

  for (const m of input.borosMargin) {
    const balance = m.equityUsd;
    // An empty account (no value at all) is not worth a row.
    if (!(balance !== null && balance > 0.005)) continue;
    const available = m.availableUsd;
    // Boros reports equity, maintenance and what is free; initial margin is
    // the rest of the equity.
    const imUsed = available === null ? null : ratio(balance - available, balance);
    const mmUsed = ratio(m.maintMarginUsd, balance);
    // The token balance: the server's own figure, else what the venue's
    // available implies (an older server sent dollars only).
    const px = m.availableUsd !== null && m.availableToken > 0 ? m.availableUsd / m.availableToken : null;
    const balanceToken = m.equityToken ?? (px !== null && px > 0 ? balance / px : null);
    const stable = /^(USDT|USDC|USD)$/i.test(m.collateral);
    rows.push({
      key: `boros:${m.tokenId}:${m.isCross ? 'cross' : (m.marketId ?? '')}`,
      venue: 'Boros',
      name: m.isCross
        ? `${m.collateral} cross`
        : `${m.marketVenue ? `${prettyVenue(m.marketVenue)} ${m.marketBase ?? ''}`.trim() : m.collateral} isolated`,
      balanceUsd: balance,
      availableUsd: available,
      token: stable
        ? null
        : { symbol: m.collateral, available: m.availableToken, balance: balanceToken },
      imUsed,
      mmUsed,
      level: levelOf(mmUsed),
    });
  }

  const rank: Record<RiskLevel, number> = { ok: 0, watch: 1, risk: 2 };
  const level = rows.reduce<RiskLevel>((w, r) => (rank[r.level] > rank[w] ? r.level : w), 'ok');
  const atLevel = rows.filter((r) => r.level === level);
  const worst =
    level === 'ok' ? null : atLevel.reduce((a, b) => ((b.mmUsed ?? 0) > (a.mmUsed ?? 0) ? b : a), atLevel[0]);
  const total = (venue: 'CrossEx' | 'Boros') => {
    const mine = rows.filter((r) => r.venue === venue);
    return mine.length === 0
      ? null
      : {
          availableUsd: mine.reduce((t, r) => t + (r.availableUsd ?? 0), 0),
          balanceUsd: mine.reduce((t, r) => t + (r.balanceUsd ?? 0), 0),
        };
  };
  return {
    rows,
    level,
    flagged: level === 'ok' ? 0 : atLevel.length,
    worst,
    totals: { CrossEx: total('CrossEx'), Boros: total('Boros') },
  };
}

export function verdictText(v: Pick<AccountsView, 'level' | 'flagged'>): string {
  if (v.level === 'ok') return 'All accounts healthy';
  const n = `${v.flagged} account${v.flagged === 1 ? '' : 's'}`;
  return v.level === 'risk' ? `${n} near liquidation` : `${n} need${v.flagged === 1 ? 's' : ''} attention`;
}
