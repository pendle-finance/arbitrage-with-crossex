/**
 * The tracked-address form, the persisted address record it edits, and the
 * freshness badge — the header bits the Positions asset view still uses.
 * Everything here is presentational; the asset view owns its own state.
 */
import { useId, useState, type FormEvent } from 'react';
import { FreshnessButton } from '../components/FreshnessIndicator';
import { readJson } from '../lib/storage';

export const STRATEGY_STORAGE_KEY = 'crossex.strategy.v1';
export const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export interface Stored {
  address: string | null;
}

/** Read the persisted shape. Older builds also wrote `since` / `sinceByAddress`
 * (a per-wallet APR-clock override) and `capitalBasis` (a capital toggle);
 * neither is read by anything now — the asset view keeps its own window store
 * — so unknown fields are simply ignored. */
export function loadStored(): Stored {
  return readJson<Stored>(STRATEGY_STORAGE_KEY, { address: null }, (parsed) => {
    const p = parsed as { address?: unknown } | null;
    const address =
      typeof p?.address === 'string' && EVM_ADDRESS_RE.test(p.address) ? p.address : null;
    return { address };
  });
}

export const short = (addr: string) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;

/** Unix seconds → the local-time value a <input type="datetime-local"> wants. */
export function AddressForm({
  initial,
  submitLabel,
  onTrack,
  onCancel,
  full = false,
}: {
  initial?: string;
  submitLabel: string;
  onTrack: (address: string) => void;
  onCancel?: () => void;
  /** Fill the container instead of centring at a fixed width — for the narrow
   * settings drawer, where the fixed w-96 input would overflow. */
  full?: boolean;
}) {
  const id = useId();
  const [value, setValue] = useState(initial ?? '');
  const [touched, setTouched] = useState(false);
  const trimmed = value.trim();
  const valid = EVM_ADDRESS_RE.test(trimmed);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (valid) onTrack(trimmed);
  };

  return (
    <form onSubmit={submit} className={`flex flex-col gap-2 ${full ? 'items-stretch' : 'items-center'}`}>
      <div className={`flex items-center gap-2 ${full ? 'w-full' : ''}`}>
        <label htmlFor={id} className="sr-only">
          EVM address
        </label>
        <input
          id={id}
          type="text"
          autoComplete="off"
          spellCheck={false}
          placeholder="0x…"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className={`input num ${full ? 'min-w-0 flex-1' : 'w-96 max-w-full'} ${
            touched && !valid ? 'border-rose-500/60' : ''
          }`}
        />
        <button type="submit" className="btn-primary" disabled={touched && !valid}>
          {submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="btn-ghost-xs" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      {touched && !valid && (
        <div className="text-xs text-rose-400">
          That doesn't look like an EVM address (expected 0x followed by 40 hex characters).
        </div>
      )}
    </form>
  );
}

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
