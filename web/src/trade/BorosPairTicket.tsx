/**
 * Boros two-leg market ticket: pick two markets, enter a size, see the
 * estimated and worst-case spread, confirm once. Both legs go out as market
 * orders.
 *
 * ⚠ ATOMIC ACCEPTANCE, NOT ATOMIC FILL. Both legs ride one on-chain batch, so
 * neither can be refused while the other trades. Each can still fill SHORT —
 * an IOC that matches part of its size succeeds rather than reverting — so the
 * panel's job is unchanged: the simulation shows what each leg can actually
 * fill at this size, and the post-trade report shows what each leg got plus
 * the residual left directional.
 *
 * Deliberate mirrors of the perp pair ticket (§1's consistency requirement):
 * the same size field position, the same slippage control shape, the same
 * order of readouts, the same hold-to-confirm. The two places they genuinely
 * cannot match are the Boros margin buckets (§6) and the collateral-unit
 * denomination of size — a Boros book is sized in its collateral token, not in
 * USD notional.
 *
 * Slippage is quoted in APR TICKS, not as a percentage of the rate. A Boros
 * book is priced in rate space with a 1bp tick, so "25 ticks" is a fixed
 * distance on the book; "0.25% of the rate" would be a different number of
 * ticks on a 3% book than on a 30% one, which is not what a tolerance means.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTradeFlowOptional } from './TradeFlow';
import {
  useBorosAgent,
  useBorosCancelAndClose,
  useBorosPairContext,
  useBorosPairSimulation,
  useExecuteBorosPair,
  useTopUpGas,
} from '../api/queries';
import type {
  BorosLegDirection,
  BorosPairIntent,
  BorosPairMarketRow,
  BorosPairRequest,
  BorosPairResult,
} from '../api/types';
import { HoldToConfirmButton } from '../components/HoldToConfirmButton';
import { QueryError } from '../components/QueryError';
import { SegmentedToggle } from '../components/SegmentedToggle';
import { amountError } from '../lib/amount';
import { isUsdCollateral } from '../lib/boros';
import { fieldValue } from '../lib/fmt';
import { useNow } from '../lib/useNow';
import { uuid } from '../lib/uuid';
import { useTrackedAddressOptional } from '../panels/trackedAddress';
import { BorosAgentSetup } from './BorosAgentSetup';
import {
  BlockerList,
  GasTopUp,
  DirectionToggle,
  MarketSelect,
  PairCosts,
  PairResultReport,
  PositionArithmetic,
  SpreadReadout,
} from './BorosPairBits';

/**
 * Mirrors SIMULATION_MAX_AGE_MS in src/core/boros/pair.ts. The server cannot
 * apply it (its own quote is always 0ms old), so the client owns this gate.
 */
const SIMULATION_MAX_AGE_MS = 12_000;

/**
 * Tolerance is entered as a PERCENT of APR, matching the close dialog — one
 * unit for the same idea across both surfaces. Basis points were exact but
 * asked the user to convert; 0.8 reads the way the venue states its own cap.
 */
const FALLBACK_SLIP_PCT = 0.25;
const MAX_SLIP_PCT = 10;

/** Largest 1-significant-figure value at or below `x` (0.8208 → 0.8). */
function floorTo1Sf(x: number): number {
  if (!Number.isFinite(x) || x <= 0) return 0;
  const step = 10 ** Math.floor(Math.log10(x));
  // toPrecision trims the binary noise `Math.floor(x / step) * step` leaves
  // (0.0001234 floors to 0.00009999999999999999 without it).
  return Number((Math.floor(x / step) * step).toPrecision(12));
}

/** Client order ids must survive a lost response so a resend cannot double-fill,
 * but must be fresh for a genuinely new order. Keyed on the intent below. */
const newOrderIds = () => ({ a: `a-${uuid()}`, b: `b-${uuid()}` });

/** `active` = the ticket is the visible venue. A hidden-but-mounted ticket
 * (see TradeRail) keeps its report and completion state but stops polling the
 * simulation — a quote nobody can see should not cost a request every 4s.
 * `onExecuted` fires on every accepted execution (full, partial, or a
 * completion) with the venue's result — the wizard advances its step off it. */
export function BorosPairTicket({
  active = true,
  onExecuted,
  onBusyChange,
}: {
  active?: boolean;
  /**
   * The collateral travels WITH the result: it is what the size figures are
   * denominated in, and the caller (the wizard) renders its own receipt from
   * these. Re-deriving it there could disagree with the ticket that traded.
   */
  onExecuted?: (result: BorosPairResult, collateral: string) => void;
  /**
   * True while an execution is in flight. The surface hosting this ticket
   * (wizard modal, order-ticket drawer) locks its close controls off it:
   * unmounting mid-execution skips the mutate-level onSuccess, so the fill
   * report — including a partial fill's Complete/Unwind remediation — and the
   * replay-protection order ids would die with the component while the order
   * executes at the venue regardless.
   */
  onBusyChange?: (busy: boolean) => void;
} = {}) {
  const tracked = useTrackedAddressOptional();
  const agent = useBorosAgent();

  /**
   * Which account this ticket prices against.
   *
   * The AGENT'S ROOT WINS whenever one is configured, because that is the
   * account the orders will actually hit. The tracked address is a
   * watch-anything setting for the read-only Positions view; letting it drive
   * the ticket would price the pair against one account's positions, margin
   * and blockers while trading a different one — the resulting-position rows
   * and the margin gate would all describe the wrong account.
   *
   * The tracked address is only a fallback for an install with no agent, where
   * nothing can be sent anyway and the panel is pure pricing.
   */
  const agentRoot = agent.data?.configured ? agent.data.root : null;
  const trackedAddress = tracked?.address ?? null;
  /**
   * Until the agent status has RESOLVED we do not know whether a root exists,
   * and falling back to the tracked address in that window would price a
   * different account than the one about to be traded — the server now refuses
   * that outright, so this is also what keeps the panel from flashing an error
   * on every load.
   */
  const agentKnown = !agent.isPending;
  const address = agentRoot ?? (agentKnown ? trackedAddress : null);
  const addressMismatch = Boolean(
    agentRoot && trackedAddress && agentRoot.toLowerCase() !== trackedAddress.toLowerCase(),
  );
  const context = useBorosPairContext(address);

  const [marketA, setMarketA] = useState<number | null>(null);
  const [marketB, setMarketB] = useState<number | null>(null);
  const [dirA, setDirA] = useState<BorosLegDirection>('short');
  const [dirB, setDirB] = useState<BorosLegDirection>('long');
  const [sizeStr, setSizeStr] = useState('');
  const [intent, setIntent] = useState<BorosPairIntent>('open');
  const [gasTopUpStr, setGasTopUpStr] = useState('5');

  /**
   * A card asked to open its missing Boros legs: pick the two markets that
   * match its venues, and arm the size it needs.
   *
   * Matched on venue + the collateral/maturity pair the card already trades,
   * so the ticket lands on the legs that actually hedge those perps rather
   * than the first market that happens to share a venue name.
   */
  const markets = context.data?.markets ?? [];
  const openPrefill = useTradeFlowOptional()?.borosOpenPrefill ?? null;
  /** Gates the prefill effect: it cannot resolve venues to markets until the
   * list has arrived, and must re-run when it does. */
  const marketsReady = markets.length > 0;
  const openNonce = openPrefill?.nonce ?? 0;
  useEffect(() => {
    // ⚠ `markets` arrives asynchronously. Bailing here USED to be permanent —
    // the effect keyed on the nonce alone, so a prefill fired before the list
    // loaded (the common case: a card's button is one click away from a cold
    // ticket) was dropped and the ticket just sat empty. `marketsReady` in the
    // deps re-runs it the moment the list is there.
    if (!openNonce || !openPrefill || markets.length === 0) return;
    const at = (venue: string | null) =>
      venue === null
        ? []
        : markets.filter(
            (m) =>
              m.venue.toUpperCase() === venue.toUpperCase() &&
              m.base.toUpperCase() === openPrefill.base.toUpperCase() &&
              // A venue lists the same base at several maturities; picking the
              // wrong one gives two legs that cannot pair with each other.
              (openPrefill.maturity === undefined || m.maturity === openPrefill.maturity),
          );
    const longAt = at(openPrefill.longVenue);
    const shortAt = at(openPrefill.shortVenue);
    /**
     * ⚠ Resolve the two legs TOGETHER, on a maturity they SHARE.
     *
     * Taking each leg's first match independently is a bug the caller cannot
     * fix from outside: the cue that opens a card's missing Boros legs has no
     * maturity to send (that card has no Boros legs, so its maturity is the 0
     * sentinel), and the venues then land wherever their own list order puts
     * them. Observed live: Gate lists exactly one ETH market (25 Sep) while
     * Hyperliquid lists 25 Dec FIRST — so the ticket armed Gate-Sep against
     * HL-Dec, a pair that cannot trade. Each leg then filtered the other out
     * of its own dropdown and the ticket reported "different maturity" about
     * a pair the user never chose.
     *
     * The intersection is both the fix and the honest answer: when the two
     * venues share no maturity there is no pair to arm, and leaving the legs
     * unresolved beats arming an impossible one.
     *
     * Soonest shared maturity wins — the nearest expiry is the liquid one.
     */
    type Market = (typeof markets)[number];
    const soonest = (ms: Market[]): Market | undefined =>
      [...ms].sort((a, b) => a.maturity - b.maturity)[0];
    let long: Market | undefined;
    let short: Market | undefined;
    if (longAt.length > 0 && shortAt.length > 0) {
      const shortMaturities = new Set(shortAt.map((m) => m.maturity));
      long = soonest(longAt.filter((m) => shortMaturities.has(m.maturity)));
      short = long ? shortAt.find((m) => m.maturity === long!.maturity) : undefined;
    } else {
      // Single-leg prefills: only one side was asked for, so there is nothing
      // to agree with and the soonest at that venue is the right default.
      long = soonest(longAt);
      short = soonest(shortAt);
    }
    /**
     * One venue = one leg. A missing-leg row asks for exactly the leg it is
     * missing, so opening a PAIR here would silently create a second position
     * the card never asked for — and on a card that is already lopsided, that
     * is the opposite of the repair the user clicked.
     */
    const onlyOne = (openPrefill.longVenue === null) !== (openPrefill.shortVenue === null);
    /**
     * ⚠ Always ASSIGN, never "assign if found".
     *
     * These used to be `if (long) setMarketA(...)`, which left a previous
     * prefill's market in place whenever the new one resolved to nothing. A
     * stale leg is not a harmless leftover here: each leg filters the other's
     * dropdown by collateral and maturity, so one leftover 25 Dec market
     * narrowed the other leg to the handful that could pair with IT — the
     * ticket looked broken, showing one wrong-maturity option and a caption
     * blaming a pair the user never chose. Clearing to null is always right:
     * a market that could not be resolved is one this ticket must not claim.
     */
    if (onlyOne) {
      // Single mode trades leg A, so whichever side is real becomes leg A.
      const solo = long ?? short;
      setMarketA(solo ? solo.marketId : null);
      setMarketB(null);
      setMode('single');
      setDirA(openPrefill.shortVenue !== null ? 'short' : 'long');
    } else {
      setMarketA(long ? long.marketId : null);
      setMarketB(short ? short.marketId : null);
      setMode('pair');
      // A Boros leg hedges the perp at its OWN venue, so the side mirrors it.
      // Seeding leg A is enough: the coupling above gives leg B the far side.
      setDirA('long');
    }
    setIntent('open');
    /**
     * A Boros size is denominated in the market's COLLATERAL, so the collateral
     * picks which figure to use — no price conversion, and nothing that can be
     * wrong by an exchange rate:
     *   USDT/USDC collateral → the USD notional IS the size;
     *   ETH/BTC collateral   → the perp's base-coin quantity is.
     * Unknown collateral leaves the field empty rather than guessing.
     */
    const picked = long ?? short;
    const usdPegged = isUsdCollateral(picked?.collateral);
    const chosen = usdPegged ? openPrefill.size : openPrefill.sizeBase;
    setSizeStr(chosen !== undefined && chosen > 0 ? fieldValue(chosen) : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openNonce, marketsReady]);
  const [sharedSlip, setSharedSlip] = useState<string | null>(null);
  // Per-leg overrides for pairs where one book is much thinner than the other.
  // null = follow the shared value.
  const [slipA, setSlipA] = useState<string | null>(null);
  const [slipB, setSlipB] = useState<string | null>(null);
  const [perLeg, setPerLeg] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [orderIds, setOrderIds] = useState(newOrderIds);
  const [report, setReport] = useState<BorosPairResult | null>(null);
  /** True when the report on screen is a REPLAY of an earlier submission —
   * the server answered from its memo and no new order went out. */
  const [reportReplayed, setReportReplayed] = useState(false);
  /** Set by "complete now at market": trade only the leg that filled LESS. */
  /**
   * Set by a PARTIAL FILL: "the pair half-filled, send the deficient leg".
   * Recovery state the panel enters on the user's behalf — not the same thing
   * as the mode below, which is a deliberate choice made before anything is
   * sent. Both end up as the wire's `onlyLeg`, but only one is undoable by
   * flipping a toggle, so they are kept apart.
   */
  const [onlyLeg, setOnlyLeg] = useState<'A' | 'B' | null>(null);
  /** Pair (both legs) or Single (leg A alone) — the user's own choice. */
  const [mode, setMode] = useState<'pair' | 'single'>('pair');

  const byId = useMemo(
    () => new Map(markets.map((m) => [m.marketId, m])),
    [markets],
  );
  const rowA = marketA !== null ? byId.get(marketA) ?? null : null;
  const rowB = marketB !== null ? byId.get(marketB) ?? null : null;

  // §2: eligibility is shared collateral + shared maturity. Computed here only
  // to grey the OTHER leg's options with a reason; the server re-decides.
  const reasonAgainst = (other: BorosPairMarketRow | null) => (m: BorosPairMarketRow): string | null => {
    if (!other) return null;
    if (m.marketId === other.marketId) return 'already the other leg';
    if (m.tokenId !== other.tokenId) return 'different collateral';
    if (m.maturity !== other.maturity) return 'different maturity';
    return null;
  };

  /**
   * Leg A always flips leg B to the opposite side (§2).
   *
   * ⚠ This used to stop permanently the first time the user touched leg B, via
   * a `dirBTouched` latch meant to protect a deliberate choice. But the latch
   * never cleared: one click on leg B disabled the coupling for the rest of the
   * session, invisibly, with no way to get it back short of a remount — so the
   * ticket silently stopped behaving the way it had a moment earlier.
   *
   * A spread is opposite-by-construction, so the coupling is the rule rather
   * than a convenience. Setting leg B directly still works and still sticks;
   * it just no longer switches the rule off. Moving leg A is the user saying
   * "this is the pair now", and the far side follows.
   */
  useEffect(() => {
    setDirB(dirA === 'short' ? 'long' : 'short');
  }, [dirA]);

  const sizeNum = Number(sizeStr);
  const sizeErr = amountError(sizeStr);
  const sizeOk = Number.isFinite(sizeNum) && sizeNum > 0;

  /**
   * The default tolerance, from the markets' OWN max rate deviation.
   *
   * A bound wider than the venue's cap can never fill, and a close is not
   * hunting a rate, so half the cap is the natural default — the same rule the
   * close dialog uses. Across a SPREAD both legs must clear their own cap, so
   * the seed is the mean of the two halves: `(capA + capB) / 2 / 2` — which is
   * `(capA + capB) / 4`. On a single leg it degenerates to that leg's cap / 2.
   *
   * Floored to one significant figure, and never rounded up: a seeded bound
   * must stay strictly inside the cap it came from.
   */
  const capOf = (id: number | null): number | null => {
    const m = id === null ? undefined : byId.get(id);
    const cap = m?.maxRateDeviationApr;
    return typeof cap === 'number' && cap > 0 ? cap : null;
  };
  const seedFor = (ids: (number | null)[]): number => {
    const caps = ids.map(capOf).filter((c): c is number => c !== null);
    if (caps.length === 0) return FALLBACK_SLIP_PCT;
    const meanHalf = caps.reduce((sum, c) => sum + c / 2, 0) / caps.length;
    const pctVal = floorTo1Sf(meanHalf * 100);
    return pctVal > 0 ? pctVal : FALLBACK_SLIP_PCT;
  };
  // One leg drives a single-leg ticket; both drive a spread.
  const singleLeg = onlyLeg ?? (mode === 'single' ? 'A' : null);
  const seededShared = seedFor(
    singleLeg === 'A' ? [marketA] : singleLeg === 'B' ? [marketB] : [marketA, marketB],
  );
  const slipStrShared = sharedSlip ?? String(seededShared);
  const slipStrA = slipA ?? String(seedFor([marketA]));
  const slipStrB = slipB ?? String(seedFor([marketB]));

  const pctToApr = (raw: string, fallbackPct: number): number => {
    const n = Number(raw);
    const safe = !Number.isFinite(n) || n <= 0 ? fallbackPct : Math.min(n, MAX_SLIP_PCT);
    return safe / 100;
  };
  const aprA = pctToApr(perLeg ? slipStrA : slipStrShared, seededShared);
  const aprB = pctToApr(perLeg ? slipStrB : slipStrShared, seededShared);
  /**
   * ⚠ Say when the typed number is not the sent number.
   *
   * `pctToApr` clamps to MAX_SLIP_PCT, so typing 50 left "50" on screen while
   * 10 went on the wire — and because the client clamped first, the server's
   * own guard ("silently coercing a bad value would set the rate bound the
   * order actually carries, so it is rejected instead", borosPair.ts) could
   * never fire. The clamp stays as the last line of defence; this makes the
   * disagreement visible instead of silent.
   */
  const slipOutOfRange = (raw: string): boolean => {
    // ⚠ Two-sided on purpose. Flagging only the too-large direction left the
    // other half of the same dishonesty in place: a typed zero, negative, or
    // cleared value fell through to `pctToApr`'s fallback and the order went
    // out carrying the SEEDED default as its rate bound — a bound the user
    // explicitly did not choose, with nothing on screen saying so. (The boxes
    // are seeded, so an empty value only exists after a deliberate clear.)
    const n = Number(raw);
    return raw.trim() === '' || !Number.isFinite(n) || n <= 0 || n > MAX_SLIP_PCT;
  };
  const slipInvalid = perLeg
    ? slipOutOfRange(slipStrA) || slipOutOfRange(slipStrB)
    : slipOutOfRange(slipStrShared);

  const request = useMemo<BorosPairRequest | null>(() => {
    /**
     * Single mode still needs a leg B on the wire.
     *
     * `/simulate` and `/execute` take a PAIR shape, and the route refuses a
     * request whose two legs name the same market ("a leg cannot offset
     * itself") — which also stops it walking either book. So a single-leg
     * ticket borrows a real, eligible partner (same collateral and maturity)
     * purely to satisfy the shape; `onlyLeg: 'A'` sizes it to zero, so it is
     * quoted and never traded.
     */
    const partnerId =
      mode === 'single'
        ? (markets.find(
            (m) =>
              m.marketId !== marketA &&
              rowA !== null &&
              m.tokenId === rowA.tokenId &&
              m.maturity === rowA.maturity,
          )?.marketId ?? null)
        : marketB;
    if (!address || marketA === null || partnerId === null || !sizeOk) return null;
    return {
      address,
      legA: { marketId: marketA, direction: dirA, slippageApr: aprA },
      legB: { marketId: partnerId, direction: dirB, slippageApr: aprB },
      size: sizeNum,
      intent,
      opposingAcknowledged: acknowledged,
      // Recovery takes precedence: a half-filled pair must complete the leg
      // that fell short, whatever mode the toggle is showing.
      ...(onlyLeg ? { onlyLeg } : mode === 'single' ? { onlyLeg: 'A' as const } : {}),
    };
  }, [address, marketA, marketB, dirA, dirB, aprA, aprB, sizeNum, sizeOk, intent, acknowledged, onlyLeg, mode, markets, rowA]);

  // Paused while a report is on screen: the numbers behind that report must not
  // shift under it, and nothing can be confirmed until it is dismissed. Also
  // paused while the ticket is hidden behind the other venue.
  const sim = useBorosPairSimulation(request, report === null && active);
  const simulation = sim.data?.simulation ?? null;
  const gate = sim.data?.gate ?? null;

  // A changed intent is a NEW order — fresh idempotency keys, so a resend of the
  // previous intent can never be mistaken for this one. Slippage is part of the
  // intent too: a re-confirm at a different tolerance is a different order, and
  // must not coalesce with the previous one in the server's replay memo.
  useEffect(() => {
    setOrderIds(newOrderIds());
  }, [marketA, marketB, dirA, dirB, sizeStr, intent, aprA, aprB]);

  // The acknowledgement is about a SPECIFIC position and size; any change to
  // what is being confirmed must retract it rather than carry it forward.
  useEffect(() => {
    setAcknowledged(false);
  }, [marketA, marketB, dirA, dirB, sizeStr, intent]);

  // A completion is armed for ONE specific residual; changing the pair or the
  // intent makes it meaningless, so it must not survive into a normal ticket.
  useEffect(() => {
    setOnlyLeg(null);
  }, [marketA, marketB, dirA, dirB, intent]);

  const execute = useExecuteBorosPair();
  const cancelClose = useBorosCancelAndClose();
  const topUpGas = useTopUpGas();

  // Tell the host surface an execution is in flight, so it can lock its close
  // controls (see the prop doc). Cleared on unmount so a host never stays
  // locked by a ticket that is gone. A follow-up could make an interrupted
  // execution genuinely recoverable — persist the in-flight order ids the way
  // pendingBasket.ts does and re-POST on remount to hit the server's replay
  // memo — but while the report lives only in this component, blocking the
  // close is what keeps a live fill visible.
  const busy = execute.isPending;
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

  /**
   * Freshness is judged HERE, not by the server's gate.
   *
   * `/simulate` evaluates staleness against the timestamp it just generated, so
   * its age is always 0 and the `stale-simulation` blocker can never appear in
   * the response. Only the client knows how long the quote has sat on screen —
   * a backgrounded tab or a stalled poll otherwise keeps an unblocked Confirm
   * over an arbitrarily old price, which is exactly what §7 forbids.
   *
   * Age is measured on ONE clock: react-query's `dataUpdatedAt` (the client's
   * receive time, as ExecuteControl does). Judging the browser's `now` against
   * the server's `simulatedAtMs` stamp would fold clock skew into the age —
   * a server 12s+ behind blocks confirm forever, one ahead never blocks at
   * all. While a placeholder from a previous request is showing,
   * `dataUpdatedAt` is 0 and the quote counts as infinitely old — a quote for
   * a DIFFERENT request must never unlock this confirm.
   */
  const now = useNow(1_000);
  const receivedAtMs = sim.dataUpdatedAt;
  const quoteAgeMs = receivedAtMs > 0 ? Math.max(0, now - receivedAtMs) : Number.POSITIVE_INFINITY;
  const quoteStale = simulation !== null && quoteAgeMs > SIMULATION_MAX_AGE_MS;

  const blockers = [
    ...(gate?.blockers ?? []),
    ...(slipInvalid
      ? [
          {
            code: 'slippage-out-of-range',
            message: `Max slippage must be greater than 0 and at most ${MAX_SLIP_PCT}% APR — the order would otherwise carry a rate bound you did not choose.`,
          },
        ]
      : []),
    ...(quoteStale
      ? [{ code: 'stale-simulation', message: 'The quote is out of date — waiting for a fresh one.' }]
      : []),
    // Surfaced BEFORE the confirm, not as an AuthAgentExpired venue rejection
    // after it — the server's write routes refuse an expired key too.
    ...(agent.data?.expired
      ? [
          {
            code: 'agent-expired',
            message: 'The Boros agent approval has expired — approve a new agent key before trading.',
          },
        ]
      : []),
  ];
  const canConfirm =
    request !== null && simulation !== null && blockers.length === 0 && !execute.isPending;

  const onConfirm = () => {
    if (!request) return;
    execute.mutate(
      { ...request, clientOrderIdA: orderIds.a, clientOrderIdB: orderIds.b },
      {
        onSuccess: (res) => {
          setReport(res.result);
          setReportReplayed(Boolean(res.replayed));
          // A replay is the EARLIER submission's result — it already fired.
          if (!res.replayed) onExecuted?.(res.result, simulation?.collateral ?? '');
          setAcknowledged(false);
          // This execution is DONE — the ids have served their replay-protection
          // purpose. Fresh ones now, so a later confirm of the same unchanged
          // ticket is a genuinely new order rather than a silent replay.
          setOrderIds(newOrderIds());
        },
      },
    );
  };

  if (!address) {
    return (
      <div className="flex flex-col gap-3">
        <BorosAgentSetup />
        <div className="flex flex-col gap-2 text-[12px] text-ink-300">
        <p>Connect a wallet above, or set a Boros address to price rate legs.</p>
        <button
          type="button"
          className="self-start rounded border border-ink-600 px-2 py-1 text-[11px] text-ink-200 hover:border-ink-400"
          onClick={() => tracked?.openSettings()}
        >
          Open settings
        </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Setup sits ABOVE the form, not behind the confirm: finding out the
          terminal cannot send only after pricing a pair wastes the quote. */}
      <BorosAgentSetup />

      {onlyLeg && (
        // The ticket looks like a two-leg pair but will send ONE order; saying
        // so is the difference between completing a hedge and opening a new
        // directional position by accident.
        <div className="rounded-lg border border-cyan-500/30 bg-cyan-500/[0.06] px-2.5 py-2 text-[11px] leading-relaxed text-cyan-100">
          Completing leg {onlyLeg} only — one order, sized to the residual. The other leg is
          untouched.{' '}
          <button
            type="button"
            className="underline decoration-dotted hover:text-white"
            onClick={() => setOnlyLeg(null)}
          >
            Trade both legs instead
          </button>
        </div>
      )}

      {addressMismatch && (
        // Not a blocker — the ticket is already using the right account — but
        // the Positions view below is showing a DIFFERENT one, and two sets of
        // numbers for "your Boros position" is exactly how someone ends up
        // reasoning about the wrong account.
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/[0.05] px-2.5 py-2 text-[11px] leading-relaxed text-amber-200">
          This ticket prices and trades <span className="num">{shortAddr(agentRoot)}</span> — the
          account your agent key signs for. The Positions view is tracking{' '}
          <span className="num">{shortAddr(trackedAddress)}</span>, so its numbers are a different
          account.
        </p>
      )}

      {context.isError && <QueryError title="Couldn’t load the Boros markets" error={context.error} onRetry={() => context.refetch()} />}

      {/* Pair or one leg. A spread is the usual trade here, so Pair leads;
          Single is for locking one venue's rate on its own — the same control
          the perp rail carries, so the two tickets read alike. */}
      <SegmentedToggle<'pair' | 'single'>
        ariaLabel="Boros ticket mode"
        value={mode}
        onChange={setMode}
        fill
        options={[
          { value: 'pair', label: 'Pair' },
          { value: 'single', label: 'Single' },
        ]}
      />

      {/* --- Legs (§2) --------------------------------------------------- */}
      <div className="flex flex-col gap-1.5">
        <MarketSelect
          id="boros-leg-a"
          label={mode === 'single' ? 'Market' : 'Leg A'}
          value={marketA}
          markets={markets}
          // Single mode trades leg A alone, so nothing constrains it: the
          // collateral/maturity rules exist to keep a PAIR compatible.
          reasonFor={reasonAgainst(mode === 'single' ? null : rowB)}
          onPick={setMarketA}
          disabled={context.isPending}
        />
        <DirectionToggle value={dirA} onChange={setDirA} idPrefix="Leg A" />
      </div>
      {mode === 'pair' && (
      <div className="flex flex-col gap-1.5">
        <MarketSelect
          id="boros-leg-b"
          label="Leg B"
          value={marketB}
          markets={markets}
          reasonFor={reasonAgainst(rowA)}
          onPick={setMarketB}
          disabled={context.isPending}
        />
        <DirectionToggle
          value={dirB}
          onChange={setDirB}
          idPrefix="Leg B"
        />
      </div>
      )}

      {/* --- Size + intent (§4) ------------------------------------------- */}
      <div className="flex flex-col gap-1">
        <label htmlFor="boros-size" className="text-[11px] text-ink-400">
          {/* The unit comes off the picked market, not the simulation: there
              is no simulation until a size is typed, and "(collateral)" is
              not a unit anyone can size against. */}
          {/* "per leg" only means something when there are two. */}
          {mode === 'single' ? 'Size' : 'Size per leg'}
          {rowA ? ` (${simulation?.collateral || rowA.collateral || 'collateral'})` : ''}
        </label>
        <input
          id="boros-size"
          className={`input num ${sizeErr ? '!border-rose-500/60' : ''}`}
          inputMode="decimal"
          placeholder={mode === 'single' ? 'size' : 'size per leg'}
          aria-invalid={sizeErr ? true : undefined}
          aria-describedby={sizeErr ? 'boros-size-error' : undefined}
          value={sizeStr}
          onChange={(e) => setSizeStr(e.target.value)}
        />
        {sizeErr && (
          <p id="boros-size-error" role="alert" className="text-[11px] text-rose-300">
            {sizeErr}
          </p>
        )}
      </div>

      <SegmentedToggle<BorosPairIntent>
        ariaLabel="Pair intent"
        value={intent}
        onChange={setIntent}
        fill
        // Only Close is tinted, and only while active. Open is the ordinary
        // thing to be doing, so it stays neutral; rose is reserved for the
        // side that reduces a position, not spent on both.
        className={intent === 'close' ? 'seg-rose' : undefined}
        options={[
          { value: 'open', label: 'Open' },
          {
            value: 'close',
            label: 'Close',
            sub: 'reduce-only',
            // Boros has no reduce-only order type: the cap is applied HERE, by
            // us, not guaranteed by the venue. Whose promise it is matters, so
            // the qualification survives — on the badge that makes the claim.
            subTitle:
              'Enforced here by capping the size at your current position — Boros has no reduce-only order type, so check the resulting-position row.',
          },
        ]}
      />

      {/* --- Slippage (§2) — one shared value, per-leg override ------------ */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          {/* The seed is half the venue's own cap on how far one trade may
              move the rate — wider than the cap can never fill. That was a
              caption under the field; it is the same sentence on hover. */}
          <label
            htmlFor="boros-slip"
            className="text-[11px] text-ink-400"
            title={`Defaults to half ${mode === 'single' ? 'the' : 'each'} market's max rate deviation — wider than that cap can never fill.`}
          >
            Max slippage (% APR)
          </label>
          {/* One leg, one tolerance: the override only means something when
              there are two legs to differ. */}
          {mode === 'pair' && (
            <button
              type="button"
              className="text-[10.5px] text-ink-400 underline decoration-dotted hover:text-ink-200"
              onClick={() => {
                setPerLeg((v) => !v);
                setSlipA(slipStrShared);
                setSlipB(slipStrShared);
              }}
            >
              {perLeg ? 'use one value' : 'per leg'}
            </button>
          )}
        </div>
        {perLeg && mode === 'pair' ? (
          <div className="grid grid-cols-2 gap-2">
            <SlipInput id="boros-slip-a" label="Leg A %" value={slipStrA} onChange={setSlipA} />
            <SlipInput id="boros-slip-b" label="Leg B %" value={slipStrB} onChange={setSlipB} />
          </div>
        ) : (
          <input
            id="boros-slip"
            className="input num"
            inputMode="decimal"
            value={slipStrShared}
            onChange={(e) => setSharedSlip(e.target.value)}
          />
        )}

      </div>

      {/* --- Simulation (§3) ---------------------------------------------- */}
      {sim.isError && <QueryError title="Couldn’t price this pair" error={sim.error} onRetry={() => sim.refetch()} />}
      {simulation && (
        <>
          {/* Renders in BOTH modes now that it carries the per-leg rates: on
              one leg it is that leg's Est. APR, and the spread lines above it
              are suppressed, since a "spread" against a borrowed partner
              would be a number about a trade nobody is making. */}
          <SpreadReadout sim={simulation} singleLeg={mode === 'single'} />
          <PairCosts sim={simulation} singleLeg={mode === 'single'} />
          <PositionArithmetic sim={simulation} singleLeg={mode === 'single'} />
        </>
      )}

      {simulation?.reasons.length ? (
        <ul className="flex flex-col gap-1 text-[10.5px] leading-relaxed text-ink-400">
          {simulation.reasons.map((r) => (
            <li key={r}>· {r}</li>
          ))}
        </ul>
      ) : null}

      {/* --- §4 acknowledgement ------------------------------------------- */}
      {gate?.requiresAcknowledgement && simulation && (
        <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.05] px-2.5 py-2 text-[11px] leading-relaxed text-amber-100">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
          />
          <span>
            {gate.opposingLegs
              .map((k) => acknowledgementText(k === 'A' ? simulation.legA : simulation.legB, simulation.collateral))
              .join(' ')}
          </span>
        </label>
      )}

      {/* --- §7 warnings + blockers --------------------------------------- */}
      {gate?.warnings.map((w) => (
        <p
          key={w}
          className="rounded-lg border border-amber-500/25 bg-amber-500/[0.04] px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-200"
        >
          {w}
        </p>
      ))}
      <BlockerList
        blockers={blockers}
        collateral={simulation?.collateral ?? ''}
        busyMarketId={cancelClose.isPending ? cancelClose.variables?.marketId ?? null : null}
        onCancelAndClose={(marketId) => cancelClose.mutate({ marketId })}
      />
      <GasTopUp
        gasBalanceUsd={sim.data?.gasBalanceUsd}
        amount={gasTopUpStr}
        onAmountChange={setGasTopUpStr}
        onTopUp={() => topUpGas.mutate(Number(gasTopUpStr))}
        busy={topUpGas.isPending}
      />
      {topUpGas.isSuccess && (
        <p className="rounded-lg border border-emerald-500/25 bg-emerald-500/[0.04] px-2.5 py-1.5 text-[11px] leading-relaxed text-emerald-200">
          Sent a ${topUpGas.data.sentUsd} gas top-up. Boros credits it once the transaction is
          indexed, so the balance above catches up within a minute — no need to send it again.
        </p>
      )}
      {topUpGas.isError && (
        <QueryError title="The gas top-up did not confirm" error={topUpGas.error} />
      )}

      {execute.isError && <QueryError title="The pair was not sent" error={execute.error} />}

      {/* --- §5 report ----------------------------------------------------- */}
      {report && reportReplayed && (
        <p className="rounded-lg border border-amber-500/25 bg-amber-500/[0.04] px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-200">
          This is the earlier submission&apos;s result, replayed — this confirm did not send a new
          order.
        </p>
      )}
      {report && (
        <PairResultReport
          result={report}
          collateral={simulation?.collateral ?? ''}
          busy={execute.isPending}
          onComplete={() => {
            // The gap is closed by adding to the leg that filled LESS — which
            // is the OPPOSITE of `unhedgedLeg`, the one carrying the surplus.
            // Arming both legs at the residual (the previous behaviour) grew
            // the book at the same imbalance and doubled the exposure instead
            // of hedging anything.
            //
            // Still the user re-issuing, never automatic: the ticket is armed
            // and they confirm at a tolerance they choose.
            const deficient = report.unhedgedLeg === 'A' ? 'B' : 'A';
            setOnlyLeg(deficient);
            setSizeStr(String(report.unhedgedSize));
            setOrderIds(newOrderIds());
            setReport(null);
          }}
          onRetry={() => {
            // Re-issue only what did NOT fill, on the legs that actually fell
            // short. When only ONE leg is short, re-arming both at its
            // shortfall would trade on top of the leg that already succeeded —
            // that case arms a single-leg completion instead. When both are
            // short, both re-arm at the SMALLER shortfall (the ticket has one
            // size); any leftover imbalance is the residual the Complete
            // action exists for.
            const sA = report.legA.shortfallSize;
            const sB = report.legB.shortfallSize;
            const shared = Math.min(sA, sB);
            const size = shared > 0 ? shared : Math.max(sA, sB);
            if (size > 0) setSizeStr(String(size));
            setOnlyLeg(shared > 0 || size === 0 ? null : sA > sB ? 'A' : 'B');
            setOrderIds(newOrderIds());
            setReport(null);
          }}
          onDismiss={() => {
            /**
             * ⚠ Clear the size with the report.
             *
             * Dismiss returns the ticket to its ordinary armed state, and
             * `sizeStr` still held the ORIGINAL request — so on a partial fill
             * the Confirm underneath came back armed for the WHOLE pair, on
             * top of the part that had already filled. (Fresh order ids mean
             * the replay guard does not cover it.) The size that produced this
             * report has been spent; re-entering one is the point of
             * dismissing rather than using Complete or Retry, which set their
             * own sizes.
             */
            setSizeStr('');
            setReport(null);
          }}
        />
      )}

      {/* --- Confirm ------------------------------------------------------- */}
      {!report && (
        <>
          <HoldToConfirmButton
            tone="cyan"
            className="w-full"
            disabled={!canConfirm}
            onConfirm={onConfirm}
          >
            {execute.isPending
              ? 'Sending…'
              : onlyLeg
                ? `Confirm — complete leg ${onlyLeg} ▸`
                : mode === 'single'
                  ? 'Confirm — 1 Boros market order ▸'
                  : 'Confirm — 2 Boros market orders ▸'}
          </HoldToConfirmButton>
          {/* Every market this will touch, NAMED before anything is sent —
              the names are the part the button cannot show. It already says
              how many orders go out ("2 Boros market orders"), so the prose
              that repeated that is gone; the atomicity rule keeps its meaning
              on hover, where it is there for whoever wants it. */}
          <p
            className="text-center text-[10.5px] leading-relaxed text-ink-400"
            title={
              mode === 'pair' && !onlyLeg
                ? 'One atomic batch — neither leg trades unless both are accepted, but each can still fill short.'
                : undefined
            }
          >
            {mode === 'single' ? (
              rowA ? (
                rowA.name
              ) : (
                'Pick a Boros market.'
              )
            ) : rowA && rowB ? (
              onlyLeg ? (
                onlyLeg === 'A' ? rowA.name : rowB.name
              ) : (
                <>
                  {rowA.name} + {rowB.name}
                </>
              )
            ) : (
              'Pick two Boros markets sharing a collateral and maturity.'
            )}
          </p>
        </>
      )}
    </div>
  );
}

/** 0x1234…abcd */
const shortAddr = (a: string | null): string =>
  a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—';

function acknowledgementText(
  leg: { marketName: string; sizing: { currentSize: number; resultingSize: number; flips: boolean } },
  collateral: string,
): string {
  const { sizing } = leg;
  const held = Math.abs(sizing.currentSize).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const side = sizing.currentSize > 0 ? 'long' : 'short';
  if (sizing.flips) {
    const opened = Math.abs(sizing.resultingSize).toLocaleString('en-US', { maximumFractionDigits: 2 });
    return `I understand this closes my existing ${leg.marketName} ${side} position of ${held} ${collateral}, realising its PnL, and opens ${opened} ${collateral} in the opposite direction.`;
  }
  if (sizing.resultingSize === 0) {
    return `I understand this closes my existing ${leg.marketName} ${side} position of ${held} ${collateral} in full, realising its PnL.`;
  }
  const to = Math.abs(sizing.resultingSize).toLocaleString('en-US', { maximumFractionDigits: 2 });
  return `I understand this reduces my existing ${leg.marketName} ${side} position of ${held} ${collateral} to ${to} ${collateral}, realising part of its PnL.`;
}

function SlipInput({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-[10.5px] text-ink-500">
        {label}
      </label>
      <input
        id={id}
        className="input num"
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
