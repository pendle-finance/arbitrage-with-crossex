/**
 * The active Boros wallet, shared so the settings drawer can EDIT what every
 * panel READS. Persisted to localStorage under STRATEGY_STORAGE_KEY.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useBorosAgent } from '../api/queries';
import { writeJson } from '../lib/storage';
import { loadStored, short, STRATEGY_STORAGE_KEY, type Stored } from './HomeControls';

interface TrackedAddressApi {
  address: string | null;
  setAddress: (address: string | null) => void;
  /** Open the settings drawer — the one place the address is edited. */
  openSettings: () => void;
  openLogin: () => void;
  upgradeNote: string | null;
  dismissUpgradeNote: () => void;
}

const TrackedAddressCtx = createContext<TrackedAddressApi | null>(null);

export const isSameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export function TrackedAddressProvider({
  onOpenSettings,
  onOpenLogin,
  children,
}: {
  onOpenSettings?: () => void;
  onOpenLogin?: () => void;
  children: ReactNode;
}) {
  const [stored, setStored] = useState<Stored>(loadStored);
  const agent = useBorosAgent();
  const root = agent.data?.configured ? (agent.data.root ?? null) : null;

  const update = useCallback((next: Partial<Stored>) => {
    setStored((prev) => {
      const merged: Stored = { ...prev, ...next };
      if (merged.walletUpgradeNote === undefined) delete merged.walletUpgradeNote;
      writeJson(STRATEGY_STORAGE_KEY, merged);
      return merged;
    });
  }, []);

  useEffect(() => {
    if (stored.walletUpgraded || !root) return;
    if (stored.address && isSameAddress(stored.address, root)) {
      update({ walletUpgraded: true });
      return;
    }
    update({
      address: root,
      walletUpgraded: true,
      walletUpgradeNote: stored.address ? root : undefined,
    });
  }, [stored.walletUpgraded, stored.address, root, update]);

  const api = useMemo<TrackedAddressApi>(
    () => ({
      address: stored.address,
      setAddress: (address) => update({ address, walletUpgradeNote: undefined }),
      openSettings: () => onOpenSettings?.(),
      openLogin: () => (onOpenLogin ?? onOpenSettings)?.(),
      upgradeNote: stored.walletUpgradeNote ?? null,
      dismissUpgradeNote: () => update({ walletUpgradeNote: undefined }),
    }),
    [stored, update, onOpenSettings, onOpenLogin],
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

export interface ActiveWallet {
  address: string | null;
  canTrade: boolean;
  loginLabel: string | null;
  openLogin: () => void;
}

export function useActiveWallet(): ActiveWallet {
  const tracked = useTrackedAddressOptional();
  const agent = useBorosAgent();
  const address = tracked?.address ?? null;
  const status = agent.data;
  const canTrade =
    status?.configured === true &&
    !status.expired &&
    status.root !== null &&
    address !== null &&
    isSameAddress(status.root, address);
  const canLogIn = status !== undefined && (status.configured || status.canProvision);
  return {
    address,
    canTrade,
    loginLabel: address && !canTrade && canLogIn ? `Log in to trade ${short(address)}` : null,
    openLogin: () => tracked?.openLogin(),
  };
}
