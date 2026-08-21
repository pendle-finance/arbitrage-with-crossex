/**
 * Which BOOK the per-position annotations belong to.
 *
 * A position on screen is half Boros (the tracked wallet) and half perp (the
 * connected Gate account), and both halves can be swapped independently. Every
 * annotation the user makes about a position — which legs belong to it, which
 * entry fills it is not charged for — is therefore only meaningful for one
 * (wallet, Gate account) PAIR, and has to be stored under both.
 *
 * Keyed by the wallet alone, a membership row naming `GATE_FUTURE_ETH_USDT`
 * silently applied to whatever the NEXT Gate account happened to hold under
 * that symbol. Keyed by neither — which is how excluded entry parts were
 * stored — `ETH#BINANCE-HYPERLIQUID#exec` is the same id for every account
 * running that pair, so one account's exclusions quietly reduced another's
 * cost basis.
 *
 * ⚠ Rotating the Gate API key for the SAME account reads as a new book and
 * resets these annotations. That is the deliberate direction to fail in: the
 * alternative is applying one account's statements to another's positions.
 */
import { useCredentials } from '../api/queries';

/** Stands in for a half nobody has chosen yet, so the id is always well-formed
 * and a book with no Gate account still has a stable bucket of its own. */
const NONE = 'none';

export function bookIdOf(address: string | null, gateKeyMasked: string | null): string {
  return `${(address ?? NONE).toLowerCase()}|${gateKeyMasked ?? NONE}`;
}

/**
 * The current book's id.
 *
 * `keyMasked` identifies the Gate account: it is the only stable thing the
 * browser is told about it (the key itself never leaves the server). While the
 * credentials query is unresolved it reads as `none` — which cannot strand a
 * write, because App does not mount the positions view until it has settled.
 */
export function useBookId(address: string | null): string {
  return bookIdOf(address, useCredentials().data?.keyMasked ?? null);
}
