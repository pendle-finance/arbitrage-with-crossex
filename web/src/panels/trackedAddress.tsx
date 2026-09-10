/**
 * The tracked Boros address, shared so the settings drawer can EDIT what the
 * positions view READS. Persisted to localStorage under STRATEGY_STORAGE_KEY.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { writeJson } from '../lib/storage';
import { loadStored, STRATEGY_STORAGE_KEY, type Stored } from './HomeControls';

interface TrackedAddressApi {
  address: string | null;
  setAddress: (address: string | null) => void;
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

  const api = useMemo<TrackedAddressApi>(
    () => ({
      address: stored.address,
      setAddress: (address) => update({ address }),
      openSettings: () => onOpenSettings?.(),
    }),
    [stored, update, onOpenSettings],
  );

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
