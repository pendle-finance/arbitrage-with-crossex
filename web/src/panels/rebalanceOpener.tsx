import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { GateAccount, TransferCoin } from '../api/types';
import { openAccounts } from './accounts/useAccountsView';

export type RebalanceTab = 'move' | 'realize' | 'delever';

type OpenOptions = { tab?: RebalanceTab; pairKey?: string };
type Opener = (opts?: OpenOptions) => void;
type OpenState = { open: boolean; tab: RebalanceTab | null; pairKey: string | null; close: () => void };
type TransferPick = (coin: TransferCoin, wallet: GateAccount) => void;

const noop = () => {};
const CLOSED: OpenState = { open: false, tab: null, pairKey: null, close: noop };

const OpenerContext = createContext<Opener>(noop);
const StateContext = createContext<OpenState>(CLOSED);
const TransferContext = createContext<{ current: TransferPick | null } | null>(null);

export function RebalanceOpenerProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<{ tab: RebalanceTab | null; pairKey: string | null } | null>(null);
  const open = useCallback<Opener>((opts = {}) => {
    if (opts.pairKey === undefined) openAccounts();
    setTarget({ tab: opts.tab ?? null, pairKey: opts.pairKey ?? null });
  }, []);
  const close = useCallback(() => setTarget(null), []);
  const transferPick = useRef<TransferPick | null>(null);
  const state = useMemo<OpenState>(
    () => (target === null ? { ...CLOSED, close } : { open: true, ...target, close }),
    [target, close],
  );
  return (
    <OpenerContext.Provider value={open}>
      <StateContext.Provider value={state}>
        <TransferContext.Provider value={transferPick}>{children}</TransferContext.Provider>
      </StateContext.Provider>
    </OpenerContext.Provider>
  );
}

export function useRebalanceOpener(): Opener {
  return useContext(OpenerContext);
}

export function useRebalanceOpenState(): OpenState {
  return useContext(StateContext);
}

export function useTransferPickTarget(pick: TransferPick) {
  const target = useContext(TransferContext);
  useEffect(() => {
    if (target === null) return;
    target.current = pick;
    return () => {
      if (target.current === pick) target.current = null;
    };
  }, [target, pick]);
}

export function useTransferPick(): TransferPick {
  const target = useContext(TransferContext);
  return useCallback<TransferPick>(
    (coin, wallet) => {
      openAccounts();
      requestAnimationFrame(() => target?.current?.(coin, wallet));
    },
    [target],
  );
}
