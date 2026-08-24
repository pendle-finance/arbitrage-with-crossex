/**
 * Trade-flow orchestrator: owns the single execution-view modal slot and the
 * pair-ticket prefill channel.
 *
 * Execution is inline everywhere now (hold-to-confirm + hover review via
 * <ExecuteControl>); this provider no longer gates money behind a review modal.
 * Its jobs: surface the DealModal once a deal is executing (openDeal is called
 * by ExecuteControl on a 202 and by the recovery banner), and carry "open the
 * perp legs" prefills from the strategy boxes to the PairTicket (prefillPair
 * bumps a nonce; the ticket consumes it once).
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { DealModal } from './DealModal';
import type { ExecMode } from './PairTicketBits';

export interface PairPrefill {
  base: string;
  /** Venue keys (BINANCE / HYPERLIQUID / …); null = leave that leg unselected. */
  longVenue: string | null;
  shortVenue: string | null;
  notionalUsd: number;
  /**
   * The same size as a BASE-COIN quantity, when the caller knows it.
   *
   * Sent alongside the USD figure rather than instead of it, because which one
   * the ticket should use is decided by `sizeUnit` below — and a caller that
   * knows only the USD notional must still be able to arm the ticket.
   */
  sizeBase?: number;
  /**
   * Which unit the size box should land in.
   *
   * Driven by the BOROS collateral of the position being completed: a
   * BTC-collateral market wants the perp sized in BTC so the two legs match
   * exactly, while a USDT-collateral one (HYPE) wants the USD figure. Omitted
   * = leave the ticket's own default.
   */
  sizeUnit?: 'base' | 'usd';
  /** Execution mode to arm the ticket with; omitted = leave the user's choice. */
  mode?: ExecMode;
  /** Monotonic — a new prefill with identical content still re-applies. */
  nonce: number;
}

/**
 * Arm the Boros ticket to OPEN a position's missing Boros legs.
 *
 * The mirror of `prefillPair`: a card with both perps and no Boros side knows
 * exactly which two markets it needs and at what size, so it hands them over
 * rather than making the user rebuild that in two dropdowns.
 */
export interface BorosOpenPrefill {
  /**
   * Venue keys the legs belong to, long side first.
   *
   * Supplying exactly ONE of these is meaningful, not degenerate: it arms the
   * ticket in SINGLE mode for that one leg. That is what a missing-leg row
   * needs — the position is short one Boros leg, and opening a pair would
   * create a second leg it never asked for.
   */
  longVenue: string | null;
  shortVenue: string | null;
  base: string;
  /**
   * The maturity these legs must sit at, in unix seconds.
   *
   * ⚠ Without it a venue+base match picks whichever market happens to come
   * first, which can be a DIFFERENT maturity than the card is quoting — the
   * two legs then fail each other's eligibility test and the ticket collapses
   * to a near-empty dropdown. Optional so existing callers still typecheck;
   * when absent the match falls back to venue+base.
   */
  maturity?: number;
  /**
   * USD notional per leg.
   *
   * A Boros leg is sized in its market's COLLATERAL, so which of these two the
   * ticket uses is decided by that collateral, not here:
   *   USD-pegged collateral (USDT/USDC) -> this figure IS the size;
   *   base-coin collateral (ETH/BTC)    -> `sizeBase` is.
   * Both travel because only the ticket knows which market was picked.
   */
  size: number;
  /** The same leg in BASE-COIN units (the perp's own quantity). */
  sizeBase?: number;
  /** Monotonic — a new prefill with identical content still re-applies. */
  nonce: number;
}

/**
 * Arm the SINGLE perp ticket with one leg.
 *
 * A missing-perp row names exactly one leg — one venue, one side, one size.
 * Routing that through the PAIR ticket would offer to open two legs when the
 * position is short one, which is the same mistake the Boros side made before
 * it grew a single mode.
 */
export interface SinglePerpPrefill {
  base: string;
  /** CrossEx venue key for the leg to open. */
  venue: string;
  side: 'BUY' | 'SELL';
  /** USD notional. */
  notionalUsd: number;
  /** The same size in base coin, when the caller knows it. */
  sizeBase?: number;
  /** Which unit the size box should land in. */
  sizeUnit?: 'base' | 'usd';
  nonce: number;
}

/**
 * Everything the guided 2-step wizard needs to open one full strategy: the
 * Boros rate legs (step 1) and the CrossEx perp hedge (step 2).
 *
 * Venues travel TWICE because the two halves are addressed differently: a
 * card's Boros leg and its perp leg sit at the same venue but under different
 * keys, and crossing them arms tickets with markets that do not exist.
 */
export interface StrategyWizardIntent {
  base: string;
  /** Boros venue keys for the rate legs, long side first. */
  borosLongVenue: string;
  borosShortVenue: string;
  /** Maturity of the Boros legs, unix seconds — see BorosOpenPrefill.maturity. */
  maturity?: number;
  /** CrossEx venue keys for the perp legs; null = no mapped symbol there. */
  crossexLongVenue: string | null;
  crossexShortVenue: string | null;
  /** USD notional per leg. */
  notionalUsd: number;
  /**
   * The same size in the base coin, for token-margined cohorts.
   *
   * ⚠ Set ONLY when the Boros collateral IS the base coin — that is the case
   * where the Boros size and the perp quantity are the same number, needing no
   * conversion. Every caller guards on it (the Opportunities card compares the
   * collateral symbol to the base; the Positions cue uses `baseSized`), and
   * the wizard turns its presence straight into `sizeUnit: 'base'`. Setting it
   * for a USDT-collateral coin would arm the perp box with a dollar figure
   * labelled as coins.
   */
  sizeBase?: number;
  /** Perp execution mode to arm step 2 with. */
  perpMode?: ExecMode;
  /**
   * Step to open at. 2 = the rate legs already exist (a boros-only position
   * resuming its hedge); default 1.
   */
  initialStep?: 1 | 2;
}

export interface TradeFlowApi {
  modalOpen: boolean;
  /** Show the live deal view (post-202, or the recovery banner). */
  openDeal: (dealId: string) => void;
  /** The guided open-a-strategy wizard; null = closed. */
  wizard: StrategyWizardIntent | null;
  openWizard: (w: StrategyWizardIntent) => void;
  closeWizard: () => void;
  /**
   * Bumped when a strategy is requested that cannot be executed yet because
   * credentials are unconfigured. The wizard deliberately does NOT open — a
   * two-step execution modal with no keys behind it is a dead end — so this
   * counter is the click's only trace, and the setup guide answers it by
   * scrolling to and flashing the API-key form.
   */
  setupNonce: number;
  /** Ask for setup instead of opening the wizard (first-run cards). */
  requestSetup: () => void;
  /**
   * The manual order ticket, now an on-demand drawer rather than a permanent
   * column. Any prefill fired while the wizard is closed opens it — a form
   * must never be populated out of sight.
   */
  railOpen: boolean;
  openRail: () => void;
  closeRail: () => void;
  pairPrefill: PairPrefill | null;
  /** Prefill the pair ticket (strategy-box "Open the perp legs" cue). */
  prefillPair: (p: Omit<PairPrefill, 'nonce'>) => void;
  borosOpenPrefill: BorosOpenPrefill | null;
  /** Arm the Boros ticket to open this position's missing Boros legs. */
  prefillBorosOpen: (p: Omit<BorosOpenPrefill, 'nonce'>) => void;
  singlePerpPrefill: SinglePerpPrefill | null;
  /** Arm the SINGLE perp ticket with one missing leg. */
  prefillSinglePerp: (p: Omit<SinglePerpPrefill, 'nonce'>) => void;
}

const Ctx = createContext<TradeFlowApi | null>(null);

export function useTradeFlow(): TradeFlowApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useTradeFlow must be used inside <TradeFlowProvider>');
  return ctx;
}

/** Null-tolerant variant for panels that render in provider-less unit tests. */
export function useTradeFlowOptional(): TradeFlowApi | null {
  return useContext(Ctx);
}

export function TradeFlowProvider({ children }: { children: ReactNode }) {
  const [dealId, setDealId] = useState<string | null>(null);
  const [pairPrefill, setPairPrefill] = useState<PairPrefill | null>(null);
  const [borosOpenPrefill, setBorosOpenPrefill] = useState<BorosOpenPrefill | null>(null);
  const [singlePerpPrefill, setSinglePerpPrefill] = useState<SinglePerpPrefill | null>(null);
  const [wizard, setWizard] = useState<StrategyWizardIntent | null>(null);
  const [railOpen, setRailOpen] = useState(false);
  const [setupNonce, setSetupNonce] = useState(0);
  const prefillNonce = useRef(0);
  // Read by the prefill callbacks, which must stay referentially stable: a
  // wizard-fired prefill arms the wizard's own tickets and must NOT pop the
  // manual drawer over it.
  const wizardRef = useRef<StrategyWizardIntent | null>(null);
  wizardRef.current = wizard;

  const openDeal = useCallback((id: string) => setDealId(id), []);
  /**
   * A prefill is a promise that the armed form is on screen. The rail is a
   * drawer now, so any prefill fired outside the wizard has to open it — and a
   * prefill fired BY the wizard must not, or the drawer would cover the wizard
   * and mount a second ticket consuming the same prefill.
   */
  const revealRail = () => {
    if (wizardRef.current === null) setRailOpen(true);
  };
  const prefillPair = useCallback((p: Omit<PairPrefill, 'nonce'>) => {
    prefillNonce.current += 1;
    setPairPrefill({ ...p, nonce: prefillNonce.current });
    revealRail();
  }, []);
  // Shares the nonce counter with prefillPair: both arm the same rail, so one
  // monotonic source means a stale prefill can never be applied.
  const prefillBorosOpen = useCallback((p: Omit<BorosOpenPrefill, 'nonce'>) => {
    prefillNonce.current += 1;
    setBorosOpenPrefill({ ...p, nonce: prefillNonce.current });
    revealRail();
  }, []);

  // Shares the one monotonic counter with the other prefills: they all arm the
  // same rail, so a single source means a stale prefill can never be applied.
  const prefillSinglePerp = useCallback((p: Omit<SinglePerpPrefill, 'nonce'>) => {
    prefillNonce.current += 1;
    setSinglePerpPrefill({ ...p, nonce: prefillNonce.current });
    revealRail();
  }, []);

  /**
   * Closing an execution surface retires its prefills. Without this, a ticket
   * mounted LATER (the drawer re-opened by hand) would find the old nonce
   * ahead of its own state and re-arm a form for a trade the user walked away
   * from — a loaded order whose subject matches nothing on screen.
   */
  const clearPrefills = () => {
    setPairPrefill(null);
    setBorosOpenPrefill(null);
    setSinglePerpPrefill(null);
  };
  const openWizard = useCallback((w: StrategyWizardIntent) => {
    setWizard(w);
    // One execution surface at a time: the wizard replaces whatever the
    // drawer was staging.
    setRailOpen(false);
    clearPrefills();
  }, []);
  const closeWizard = useCallback(() => {
    setWizard(null);
    clearPrefills();
  }, []);
  const requestSetup = useCallback(() => setSetupNonce((n) => n + 1), []);
  const openRail = useCallback(() => setRailOpen(true), []);
  const closeRail = useCallback(() => {
    setRailOpen(false);
    clearPrefills();
  }, []);

  const api = useMemo<TradeFlowApi>(
    () => ({
      modalOpen: dealId !== null,
      openDeal,
      wizard,
      openWizard,
      closeWizard,
      setupNonce,
      requestSetup,
      railOpen,
      openRail,
      closeRail,
      pairPrefill,
      prefillPair,
      borosOpenPrefill,
      prefillBorosOpen,
      singlePerpPrefill,
      prefillSinglePerp,
    }),
    [dealId, openDeal, wizard, openWizard, closeWizard, setupNonce, requestSetup, railOpen, openRail, closeRail, pairPrefill, prefillPair, borosOpenPrefill, prefillBorosOpen, singlePerpPrefill, prefillSinglePerp],
  );

  return (
    <Ctx.Provider value={api}>
      {children}
      {dealId !== null && <DealModal key={dealId} dealId={dealId} onClose={() => setDealId(null)} />}
    </Ctx.Provider>
  );
}
