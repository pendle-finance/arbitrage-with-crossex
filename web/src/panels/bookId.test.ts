/**
 * Book identity: which (wallet, Gate account) pair an annotation belongs to.
 *
 * Both halves of a position can be swapped independently, and every store that
 * remembers something ABOUT a position has to be keyed on both. These are the
 * cases that were silently wrong when they were not.
 */
import { describe, expect, it } from 'vitest';
import { bookIdOf } from './bookId';
import { loadRows, saveRows, type MembershipRow } from './partitionStore';

const WALLET_A = '0xA'.padEnd(42, '1');
const WALLET_B = '0xB'.padEnd(42, '2');
const GATE_A = 'abcd…7890';
const GATE_B = 'wxyz…4321';

const row: MembershipRow = { positionId: 'aaaa0001', leg: { kind: 'perp', symbol: 'GATE_FUTURE_ETH_USDT' } };

describe('bookIdOf', () => {
  it('separates the same wallet on two Gate accounts', () => {
    expect(bookIdOf(WALLET_A, GATE_A)).not.toBe(bookIdOf(WALLET_A, GATE_B));
  });

  it('separates the same Gate account under two wallets', () => {
    expect(bookIdOf(WALLET_A, GATE_A)).not.toBe(bookIdOf(WALLET_B, GATE_A));
  });

  it('is case-insensitive in the wallet, which arrives checksummed or not', () => {
    expect(bookIdOf(WALLET_A.toUpperCase(), GATE_A)).toBe(bookIdOf(WALLET_A.toLowerCase(), GATE_A));
  });

  it('is stable, and distinct, when either half is missing', () => {
    expect(bookIdOf(null, null)).toBe(bookIdOf(null, null));
    expect(bookIdOf(WALLET_A, null)).not.toBe(bookIdOf(null, GATE_A));
    expect(bookIdOf(WALLET_A, null)).not.toBe(bookIdOf(WALLET_A, GATE_A));
  });
});

describe('membership rows follow the book, not the wallet', () => {
  it('does not hand one Gate account the assertions made on another', () => {
    // The row names GATE_FUTURE_ETH_USDT. Keyed by the wallet alone it applied
    // to whatever the next Gate account held under that symbol.
    saveRows(bookIdOf(WALLET_A, GATE_A), [row], 1_700_000_000);
    expect(loadRows(bookIdOf(WALLET_A, GATE_B))).toEqual([]);
    // …and switching back finds them again.
    expect(loadRows(bookIdOf(WALLET_A, GATE_A))).toEqual([row]);
  });

  it('keeps two books' + ' assertions side by side', () => {
    const other: MembershipRow = { leg: { kind: 'boros', marketId: 128 } };
    saveRows(bookIdOf(WALLET_A, GATE_A), [row], 1_700_000_000);
    saveRows(bookIdOf(WALLET_B, GATE_A), [other], 1_700_000_000);
    expect(loadRows(bookIdOf(WALLET_A, GATE_A))).toEqual([row]);
    expect(loadRows(bookIdOf(WALLET_B, GATE_A))).toEqual([other]);
  });
});
