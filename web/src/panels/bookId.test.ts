/**
 * Book identity: which (wallet, Gate account) pair an annotation belongs to.
 *
 * Both halves of a position can be swapped independently, and every store that
 * remembers something ABOUT a position has to be keyed on both. These are the
 * cases that were silently wrong when they were not. Proven against
 * assetPrefsStore, the one store that carries per-book annotations.
 */
import { describe, expect, it } from 'vitest';
import { bookIdOf } from './bookId';
import { loadPrefs, savePrefs, type AssetViewPrefs } from './assets/assetPrefsStore';

const WALLET_A = '0xA'.padEnd(42, '1');
const WALLET_B = '0xB'.padEnd(42, '2');
const GATE_A = 'abcd…7890';
const GATE_B = 'wxyz…4321';

const EMPTY: AssetViewPrefs = { sinceByAsset: {}, exclusions: {}, legSince: {} };
const prefs: AssetViewPrefs = { sinceByAsset: {}, exclusions: { 'boros:42': 'all' }, legSince: {} };

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
  it('does not hand one Gate account the exclusions made on another', () => {
    // The exclusion names GATE_FUTURE_ETH_USDT. Keyed by the wallet alone it
    // applied to whatever the next Gate account held under that symbol.
    savePrefs(bookIdOf(WALLET_A, GATE_A), prefs);
    expect(loadPrefs(bookIdOf(WALLET_A, GATE_B))).toEqual(EMPTY);
    // …and switching back finds them again.
    expect(loadPrefs(bookIdOf(WALLET_A, GATE_A))).toEqual(prefs);
  });

  it('keeps two books' + ' annotations side by side', () => {
    const other: AssetViewPrefs = { sinceByAsset: { ETH: 1_700_000_000 }, exclusions: {}, legSince: {} };
    savePrefs(bookIdOf(WALLET_A, GATE_A), prefs);
    savePrefs(bookIdOf(WALLET_B, GATE_A), other);
    expect(loadPrefs(bookIdOf(WALLET_A, GATE_A))).toEqual(prefs);
    expect(loadPrefs(bookIdOf(WALLET_B, GATE_A))).toEqual(other);
  });
});
