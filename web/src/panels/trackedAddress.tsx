/**
 * The active Boros wallet, shared so the settings drawer can EDIT what every
 * panel READS. Persisted to localStorage under STRATEGY_STORAGE_KEY.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useBorosAgent } from '../api/queries';
import { writeJson } from '../lib/storage';
import { readWalletAccount, watchWalletAccount } from '../lib/wallet';
import { loadStored, short, STRATEGY_STORAGE_KEY, type Stored } from './HomeControls';
import { useLoginInFlight } from '../lib/loginInFlight';

interface TrackedAddressApi {
  address: string | null;
  setAddress: (address: string | null) => void;
  followBrowserWallet: (address: string) => void;
  followWallet: boolean;
  /** Open the settings drawer — the one place the address is edited. */
  openSettings: () => void;
  openLogin: () => void;
  upgradeNote: string | null;
  dismissUpgradeNote: () => void;
}

const TrackedAddressCtx = createContext<TrackedAddressApi | null>(null);

export const isSameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

function persist(prev: Stored, next: Partial<Stored>): Stored {
  const merged: Stored = { ...prev, ...next };
  if (merged.walletUpgradeNote === undefined) delete merged.walletUpgradeNote;
  if (merged.followWallet === undefined) delete merged.followWallet;
  if (merged.manual === undefined) delete merged.manual;
  writeJson(STRATEGY_STORAGE_KEY, merged);
  return merged;
}

function followed(prev: Stored, address: string): Stored {
  const already =
    prev.followWallet &&
    prev.walletUpgraded &&
    !prev.manual &&
    prev.walletUpgradeNote === undefined &&
    prev.address !== null &&
    isSameAddress(prev.address, address);
  return already
    ? prev
    : persist(prev, { address, followWallet: true, walletUpgraded: true, walletUpgradeNote: undefined, manual: undefined });
}

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
  const [walletRead, setWalletRead] = useState<'pending' | 'account' | 'none'>('pending');
  const agent = useBorosAgent();
  const root = agent.data?.configured ? (agent.data.root ?? null) : null;

  const update = useCallback((next: Partial<Stored>) => setStored((prev) => persist(prev, next)), []);

  useEffect(() => {
    let live = true;
    void readWalletAccount().then((account) => {
      if (!live) return;
      if (account) setStored((prev) => (prev.manual ? prev : followed(prev, account)));
      setWalletRead(account ? 'account' : 'none');
    });
    const stop = watchWalletAccount((account) => setStored((prev) => followed(prev, account)));
    return () => {
      live = false;
      stop();
    };
  }, []);

  useEffect(() => {
    if (walletRead !== 'none' || stored.walletUpgraded || stored.manual || !root) return;
    const sameAsRoot = stored.address !== null && isSameAddress(stored.address, root);
    update(
      sameAsRoot
        ? { walletUpgraded: true }
        : { address: root, walletUpgraded: true, walletUpgradeNote: stored.address ? root : undefined },
    );
  }, [walletRead, stored.walletUpgraded, stored.manual, stored.address, root, update]);

  const following = stored.followWallet === true;

  const api = useMemo<TrackedAddressApi>(
    () => ({
      address: stored.address,
      setAddress: (address) =>
        update({ address, walletUpgradeNote: undefined, followWallet: undefined, manual: address ? true : undefined }),
      followBrowserWallet: (address) =>
        update({ address, walletUpgradeNote: undefined, followWallet: true, manual: undefined }),
      followWallet: following,
      openSettings: () => onOpenSettings?.(),
      openLogin: () => (onOpenLogin ?? onOpenSettings)?.(),
      upgradeNote: stored.walletUpgradeNote ?? null,
      dismissUpgradeNote: () => update({ walletUpgradeNote: undefined }),
    }),
    [stored, following, update, onOpenSettings, onOpenLogin],
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

/** Warn this long before the login ends. The login lasts a year. */
export const RENEW_WARN_SECONDS = 14 * 24 * 3600;

export type ActiveWalletState =
  /** Logged in, and the chain shows a live approval. */
  | 'can-trade'
  /** Another wallet is logged in. */
  | 'view-only'
  /** This wallet's login ended. */
  | 'expired'
  /** This wallet's key is stored but the chain has no approval for it. */
  | 'not-approved'
  /** A login for this wallet is running: the key is saved, the signature or
   * Boros's confirmation is still to come. */
  | 'logging-in'
  | 'unchecked'
  | 'not-logged-in';

export interface ActiveWallet {
  address: string | null;
  state: ActiveWalletState | null;
  canTrade: boolean;
  viewOnly: boolean;
  /** Unix seconds, when a live login ends within RENEW_WARN_SECONDS. */
  endsSoon: number | null;
  loginLabel: string | null;
  openLogin: () => void;
}

export function useActiveWallet(): ActiveWallet {
  const tracked = useTrackedAddressOptional();
  const agent = useBorosAgent();
  const address = tracked?.address ?? null;
  const status = agent.data;
  const inFlight = useLoginInFlight();
  const isRoot =
    status?.configured === true && status.root !== null && address !== null && isSameAddress(status.root, address);
  const state: ActiveWalletState | null =
    address === null || status === undefined
      ? null
      : !status.configured
        ? 'not-logged-in'
        : !isRoot
          ? 'view-only'
          : inFlight && (status.expired || status.approval !== 'approved')
            ? 'logging-in'
            : status.expired
            ? 'expired'
            : status.approval === 'not-approved'
              ? 'not-approved'
              : status.approval === 'unknown'
                ? 'unchecked'
                : 'can-trade';
  const canTrade = state === 'can-trade' || state === 'unchecked';
  const viewOnly =
    status?.configured === true && status.root !== null && address !== null && !isRoot;
  const canLogIn = status !== undefined && (status.configured || status.canProvision);
  const nowSec = Math.floor(Date.now() / 1000);
  const endsSoon =
    canTrade && status?.expiry != null && status.expiry - nowSec < RENEW_WARN_SECONDS ? status.expiry : null;
  return {
    address,
    state,
    canTrade,
    viewOnly,
    endsSoon,
    loginLabel:
      address && !canTrade && canLogIn
        ? state === 'expired'
          ? `Renew login for ${short(address)}`
          : `Log in to trade ${short(address)}`
        : null,
    openLogin: () => tracked?.openLogin(),
  };
}
