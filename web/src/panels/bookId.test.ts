import { describe, expect, it } from 'vitest';
import { bookIdOf, bookKey } from './bookId';

const WALLET_A = '0xA'.padEnd(42, '1');
const WALLET_B = '0xB'.padEnd(42, '2');
const GATE_A = 'abcd…7890';
const GATE_B = 'wxyz…4321';

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

describe('annotations follow the book, not the wallet', () => {
  it('gives one wallet on two Gate accounts two prefs keys', () => {
    expect(bookKey(bookIdOf(WALLET_A, GATE_A))).not.toBe(bookKey(bookIdOf(WALLET_A, GATE_B)));
  });

  it('gives one Gate account under two wallets two prefs keys', () => {
    expect(bookKey(bookIdOf(WALLET_A, GATE_A))).not.toBe(bookKey(bookIdOf(WALLET_B, GATE_A)));
  });

  it('gives a checksummed and a lowercase wallet one prefs key', () => {
    expect(bookKey(bookIdOf(WALLET_A.toUpperCase(), GATE_A))).toBe(bookKey(bookIdOf(WALLET_A.toLowerCase(), GATE_A)));
  });
});
