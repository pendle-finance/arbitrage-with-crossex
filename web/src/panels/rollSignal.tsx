/**
 * The roll-over signal, lifted out of the asset card so the whole app can
 * show it.
 *
 * The numbers are only computable where the positions are — a pair's
 * fee-adjusted APR needs its own fee switches, and the roll's rate needs its
 * live quotes — so `AssetCard` stays the one that PUBLISHES. This context is
 * the wire: cards publish per pair, the sticky banner under the navbar reads
 * them all, and "Show me" asks the Positions tab to open the pairs that
 * matter (his call 2026-09-20 — the banner belonged on every tab, not buried
 * in one asset's card).
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

/** What one pair is offering, as the card worked it out. */
export interface RollChance {
  maturity: number;
  rate: number;
  current: number;
  currentMaturity: number;
}

export interface RollSignal {
  /** Stable per pair: asset + the two venues + the maturity held. */
  key: string;
  asset: string;
  longVenue: string;
  shortVenue: string;
  /** When the pair being held settles. */
  maturity: number;
  /** A better rate is available at a later maturity; null when the only
   * reason to act is that this pair is about to settle. */
  opportunity: RollChance | null;
  opportunities: RollChance[];
}

interface RollSignalApi {
  signals: RollSignal[];
  /** Cards call this on every change; passing null clears that pair. */
  publish: (key: string, signal: RollSignal | null) => void;
  /** Bumped by the banner's "Show me" — the Positions tab watches it. */
  showNonce: number;
  requestShow: () => void;
}

const Ctx = createContext<RollSignalApi | null>(null);

export function RollSignalProvider({ children }: { children: ReactNode }) {
  const [byKey, setByKey] = useState<Record<string, RollSignal>>({});
  const [showNonce, setShowNonce] = useState(0);
  const publish = useCallback((key: string, signal: RollSignal | null) => {
    setByKey((prev) => {
      const cur = prev[key];
      if (signal === null) {
        if (!cur) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      }
      // Identity churn would re-render every consumer on each 4s poll.
      if (cur && same(cur, signal)) return prev;
      return { ...prev, [key]: signal };
    });
  }, []);
  const requestShow = useCallback(() => setShowNonce((n) => n + 1), []);
  const signals = useMemo(
    () =>
      Object.values(byKey).sort(
        (a, b) => Number(b.opportunity !== null) - Number(a.opportunity !== null) || a.maturity - b.maturity,
      ),
    [byKey],
  );
  const value = useMemo(() => ({ signals, publish, showNonce, requestShow }), [signals, publish, showNonce, requestShow]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

const sameChance = (a: RollChance, b: RollChance): boolean =>
  a.maturity === b.maturity && a.rate === b.rate && a.current === b.current && a.currentMaturity === b.currentMaturity;

const same = (a: RollSignal, b: RollSignal): boolean =>
  a.maturity === b.maturity &&
  a.asset === b.asset &&
  a.longVenue === b.longVenue &&
  a.shortVenue === b.shortVenue &&
  a.opportunities.length === b.opportunities.length &&
  a.opportunities.every((o, i) => sameChance(o, b.opportunities[i]));

/** Null outside the provider (unit tests render panels bare). */
export function useRollSignalsOptional(): RollSignalApi | null {
  return useContext(Ctx);
}

/** A card's publisher: stable across renders, clears on unmount. */
export function useRollPublisher(): (key: string, signal: RollSignal | null) => void {
  const api = useRollSignalsOptional();
  const ref = useRef(api?.publish);
  ref.current = api?.publish;
  return useCallback((key, signal) => ref.current?.(key, signal), []);
}
