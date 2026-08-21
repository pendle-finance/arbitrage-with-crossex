/**
 * The tracked Boros address (+ the APR-clock start), lifted out of PositionsHome
 * so the settings drawer can EDIT what the positions view READS. Persisted to
 * localStorage under STRATEGY_STORAGE_KEY, same shape as before.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { CapitalBasis } from '../api/types';
import { writeJson } from '../lib/storage';
import { loadStored, STRATEGY_STORAGE_KEY, type Stored } from './HomeControls';

interface TrackedAddressApi {
  address: string | null;
  /** Custom APR-clock start (unix seconds); null = default (Boros open). */
  since: number | null;
  /** Whether a Boros position's capital is its posted balance or the margin
   * its legs actually consume. */
  capitalBasis: CapitalBasis;
  setAddress: (address: string | null) => void;
  setSince: (since: number | null) => void;
  setCapitalBasis: (basis: CapitalBasis) => void;
  /** Open the settings drawer — the one place the address is edited. */
  openSettings: () => void;
}

const TrackedAddressCtx = createContext<TrackedAddressApi | null>(null);

export function TrackedAddressProvider({
  onOpenSettings,
  children,
}: {
  onOpenSettings?: () => void;
  children: ReactNode;
}) {
  const [stored, setStored] = useState<Stored>(loadStored);

  const update = useCallback((next: Partial<Stored>) => {
    setStored((prev) => {
      const merged: Stored = { ...prev, ...next };
      writeJson(STRATEGY_STORAGE_KEY, merged);
      return merged;
    });
  }, []);

  const api = useMemo<TrackedAddressApi>(() => {
    // The override belongs to the wallet it was set on. Reading and writing it
    // through this key is what keeps a start date from following the user to
    // the next book — `setAddress` needs no say in it, and switching back
    // still finds the date that was set here.
    const key = stored.address?.toLowerCase() ?? null;
    return {
      address: stored.address,
      since: key === null ? null : (stored.sinceByAddress[key] ?? null),
      capitalBasis: stored.capitalBasis,
      setAddress: (address) => update({ address }),
      setSince: (since) => {
        if (key === null) return; // nothing to anchor an override to
        const next = { ...stored.sinceByAddress };
        if (since === null) delete next[key];
        else next[key] = since;
        update({ sinceByAddress: next });
      },
      setCapitalBasis: (capitalBasis) => update({ capitalBasis }),
      openSettings: () => onOpenSettings?.(),
    };
  }, [stored, update, onOpenSettings]);

  return <TrackedAddressCtx.Provider value={api}>{children}</TrackedAddressCtx.Provider>;
}

export function useTrackedAddress(): TrackedAddressApi {
  const ctx = useContext(TrackedAddressCtx);
  if (!ctx) throw new Error('useTrackedAddress must be used inside <TrackedAddressProvider>');
  return ctx;
}

/** Null-tolerant variant, mirroring `useTradeFlowOptional`: for panels that
 * render in provider-less unit tests, and that have a sensible "no address
 * yet" state of their own. */
export function useTrackedAddressOptional(): TrackedAddressApi | null {
  return useContext(TrackedAddressCtx);
}
