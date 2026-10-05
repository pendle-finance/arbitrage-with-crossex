/**
 * Gate CrossEx margin as shares of the margin balance — the figures the
 * Accounts tab and the header read.
 */
import type { CrossexAccount } from '../api/types';

export interface MarginParts {
  balance: number;
  /** Locked by open positions. */
  initial: number;
  /** Free = balance − initial (derived so the pie always closes). */
  available: number;
  /** The liquidation floor. */
  maintenance: number;
  /** Initial margin as a fraction of balance (0..1). */
  imPct: number;
  /** Maintenance margin as a fraction of balance (0..1). */
  mmPct: number;
  hasFunds: boolean;
}

/**
 * Utilization computed as margin ÷ balance — NOT Gate's `*MarginRate` fields,
 * which are coverage ratios (balance ÷ requirement) and read as "reversed"
 * (maintenance's ratio is larger than initial's because its requirement is
 * smaller). "How much of my balance is locked" is the intuitive number.
 */
export function marginParts(acc: CrossexAccount): MarginParts {
  const balance = Number(acc.marginBalance) || 0;
  const initial = Math.max(0, Number(acc.initialMargin) || 0);
  const maintenance = Math.max(0, Number(acc.maintenanceMargin) || 0);
  const hasFunds = balance > 0;
  // Derive free from balance so used + free always equals the whole ring; fall
  // back to the reported available only when balance is unavailable.
  const available = Math.max(0, hasFunds ? balance - initial : Number(acc.availableMargin) || 0);
  return {
    balance,
    initial,
    available,
    maintenance,
    imPct: hasFunds ? initial / balance : 0,
    mmPct: hasFunds ? maintenance / balance : 0,
    hasFunds,
  };
}
