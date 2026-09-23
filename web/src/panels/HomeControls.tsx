/**
 * The persisted address record and the
 * freshness badge — the header bits the Positions asset view still uses.
 * Everything here is presentational; the asset view owns its own state.
 */
import { FreshnessButton } from '../components/FreshnessIndicator';
import { readJson } from '../lib/storage';

export const STRATEGY_STORAGE_KEY = 'crossex.strategy.v1';
export const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export interface Stored {
  address: string | null;
  walletUpgraded?: true;
  walletUpgradeNote?: string;
  followWallet?: true;
}

/** Read the persisted shape. Older builds also wrote `since` / `sinceByAddress`
 * (a per-wallet APR-clock override) and `capitalBasis` (a capital toggle);
 * neither is read by anything now — the asset view keeps its own window store
 * — so unknown fields are simply ignored. */
export function loadStored(): Stored {
  return readJson<Stored>(STRATEGY_STORAGE_KEY, { address: null }, (parsed) => {
    const p = parsed as { address?: unknown; walletUpgraded?: unknown; walletUpgradeNote?: unknown; followWallet?: unknown } | null;
    const address =
      typeof p?.address === 'string' && EVM_ADDRESS_RE.test(p.address) ? p.address : null;
    return {
      address,
      ...(p?.walletUpgraded === true ? { walletUpgraded: true as const } : {}),
      ...(typeof p?.walletUpgradeNote === 'string' && EVM_ADDRESS_RE.test(p.walletUpgradeNote)
        ? { walletUpgradeNote: p.walletUpgradeNote }
        : {}),
      ...(p?.followWallet === true ? { followWallet: true as const } : {}),
    };
  });
}

export const short = (addr: string) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;

/** "⟳ 8s ago" ticking freshness for the strategy query (amber on stale error). */
export function StrategyFreshness({
  dataUpdatedAt,
  staleError,
  onRefetch,
}: {
  dataUpdatedAt: number;
  staleError: boolean;
  onRefetch: () => void;
}) {
  return (
    <FreshnessButton
      dense
      dataUpdatedAt={dataUpdatedAt}
      staleError={staleError}
      title="Refetch strategy data"
      onRefetch={onRefetch}
    />
  );
}

/** Compact totals strip shown when the address runs more than one strategy.
 * Covers the Boros-tracked strategies only — perp-only boxes are not in the
 * server totals. Exit parts re-derived per the checked flags. */
