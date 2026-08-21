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
import {
  useBorosAgent,
  useBorosCancelAndClose,
  useBorosPairContext,
  useBorosPairSimulation,
  useExecuteBorosPair,
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
import { useNow } from '../lib/useNow';
import { uuid } from '../lib/uuid';
import { useTrackedAddressOptional } from '../panels/trackedAddress';
import { BorosAgentSetup } from './BorosAgentSetup';
import {
  BlockerList,
  DirectionToggle,
  LegSimTable,
  MarketSelect,
  PairCosts,
  PairResultReport,
  PositionArithmetic,
  SpreadReadout,
  bpToApr,
} from './BorosPairBits';

/**
 * Mirrors SIMULATION_MAX_AGE_MS in src/core/boros/pair.ts. The server cannot
 * apply it (its own quote is always 0ms old), so the client owns this gate.
 */
const SIMULATION_MAX_AGE_MS = 12_000;

/** Default tolerance, in basis points of APR (25bp = 0.25% APR per leg). */
const DEFAULT_BP = 25;
const MAX_BP = 1_000;

/** Client order ids must survive a lost response so a resend cannot double-fill,
 * but must be fresh for a genuinely new order. Keyed on the intent below. */
const newOrderIds = () => ({ a: `a-${uuid()}`, b: `b-${uuid()}` });

/** `active` = the ticket is the visible venue. A hidden-but-mounted ticket
 * (see TradeRail) keeps its report and completion state but stops polling the
 * simulation — a quote nobody can see should not cost a request every 4s. */
export function BorosPairTicket({ active = true }: { active?: boolean } = {}) {
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
  const [sharedBp, setSharedBp] = useState(DEFAULT_BP);
  // Per-leg overrides for pairs where one book is much thinner than the other.
  // null = follow the shared value.
  const [bpA, setBpA] = useState<number | null>(null);
  const [bpB, setBpB] = useState<number | null>(null);
  const [perLeg, setPerLeg] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [orderIds, setOrderIds] = useState(newOrderIds);
  const [report, setReport] = useState<BorosPairResult | null>(null);
  /** True when the report on screen is a REPLAY of an earlier submission —
   * the server answered from its memo and no new order went out. */
  const [reportReplayed, setReportReplayed] = useState(false);
  /** Set by "complete now at market": trade only the leg that filled LESS. */
  const [onlyLeg, setOnlyLeg] = useState<'A' | 'B' | null>(null);

  const markets = context.data?.markets ?? [];
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

  // Leg B's direction defaults to the opposite of A (§2) — but only while the
  // user has not deliberately set it, which `dirBTouched` tracks.
  const [dirBTouched, setDirBTouched] = useState(false);
  useEffect(() => {
    if (!dirBTouched) setDirB(dirA === 'short' ? 'long' : 'short');
  }, [dirA, dirBTouched]);

  const sizeNum = Number(sizeStr);
  const sizeErr = amountError(sizeStr);
  const sizeOk = Number.isFinite(sizeNum) && sizeNum > 0;

  const aprA = bpToApr(perLeg && bpA !== null ? bpA : sharedBp);
  const aprB = bpToApr(perLeg && bpB !== null ? bpB : sharedBp);

  const request = useMemo<BorosPairRequest | null>(() => {
    if (!address || marketA === null || marketB === null || !sizeOk) return null;
    return {
      address,
      legA: { marketId: marketA, direction: dirA, slippageApr: aprA },
      legB: { marketId: marketB, direction: dirB, slippageApr: aprB },
      size: sizeNum,
      intent,
      opposingAcknowledged: acknowledged,
      ...(onlyLeg ? { onlyLeg } : {}),
    };
  }, [address, marketA, marketB, dirA, dirB, aprA, aprB, sizeNum, sizeOk, intent, acknowledged, onlyLeg]);

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

      {/* --- Legs (§2) --------------------------------------------------- */}
      <div className="flex flex-col gap-1.5">
        <MarketSelect
          id="boros-leg-a"
          label="Leg A"
          value={marketA}
          markets={markets}
          reasonFor={reasonAgainst(rowB)}
          onPick={setMarketA}
          disabled={context.isPending}
        />
        <DirectionToggle value={dirA} onChange={setDirA} idPrefix="Leg A" />
      </div>
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
          onChange={(d) => {
            setDirBTouched(true);
            setDirB(d);
          }}
          idPrefix="Leg B"
        />
      </div>

      {/* --- Size + intent (§4) ------------------------------------------- */}
      <div className="flex flex-col gap-1">
        <label htmlFor="boros-size" className="text-[11px] text-ink-400">
          {/* The unit comes off the picked market, not the simulation: there
              is no simulation until a size is typed, and "(collateral)" is
              not a unit anyone can size against. */}
          Size per leg{rowA ? ` (${simulation?.collateral || rowA.collateral || 'collateral'})` : ''}
        </label>
        <input
          id="boros-size"
          className={`input num ${sizeErr ? '!border-rose-500/60' : ''}`}
          inputMode="decimal"
          placeholder="size per leg"
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
        options={[
          { value: 'open', label: 'Open' },
          { value: 'close', label: 'Close', sub: 'reduce-only' },
        ]}
      />
      {intent === 'close' && (
        // Boros has no reduce-only order flag, so "reduce-only" here is us
        // capping the size at what you actually hold — not a venue guarantee.
        // Saying so beats implying the exchange will catch an overshoot.
        <p className="-mt-1.5 text-[10.5px] leading-relaxed text-ink-400">
          Reduce-only is enforced here by capping the size at your current position — Boros has no
          reduce-only order type, so the resulting-position row is the thing to check.
        </p>
      )}

      {/* --- Slippage (§2) — one shared value, per-leg override ------------ */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <label htmlFor="boros-slip" className="text-[11px] text-ink-400">
            Max slippage (bp of APR)
          </label>
          <button
            type="button"
            className="text-[10.5px] text-ink-400 underline decoration-dotted hover:text-ink-200"
            onClick={() => {
              setPerLeg((v) => !v);
              setBpA(sharedBp);
              setBpB(sharedBp);
            }}
          >
            {perLeg ? 'use one value' : 'per leg'}
          </button>
        </div>
        {perLeg ? (
          <div className="grid grid-cols-2 gap-2">
            <BpInput id="boros-slip-a" label="Leg A bp" value={bpA ?? sharedBp} onChange={setBpA} />
            <BpInput id="boros-slip-b" label="Leg B bp" value={bpB ?? sharedBp} onChange={setBpB} />
          </div>
        ) : (
          <input
            id="boros-slip"
            className="input num"
            inputMode="numeric"
            value={sharedBp}
            onChange={(e) => setSharedBp(clampBp(e.target.value))}
          />
        )}
      </div>

      {/* --- Simulation (§3) ---------------------------------------------- */}
      {sim.isError && <QueryError title="Couldn’t price this pair" error={sim.error} onRetry={() => sim.refetch()} />}
      {simulation && (
        <>
          <SpreadReadout sim={simulation} />
          <LegSimTable sim={simulation} />
          <PairCosts sim={simulation} gasBalanceUsd={sim.data?.gasBalanceUsd} />
          <PositionArithmetic sim={simulation} />
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
        busyMarketId={cancelClose.isPending ? cancelClose.variables ?? null : null}
        onCancelAndClose={(marketId) => cancelClose.mutate(marketId)}
      />

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
          onDismiss={() => setReport(null)}
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
                : 'Confirm — 2 Boros market orders ▸'}
          </HoldToConfirmButton>
          {/* The venue and both markets, named before anything is sent. */}
          <p className="text-center text-[10.5px] leading-relaxed text-ink-400">
            {rowA && rowB ? (
              onlyLeg ? (
                <>
                  Sends ONE market order on <span className="text-ink-200">Boros</span>:{' '}
                  {onlyLeg === 'A' ? rowA.name : rowB.name}.
                </>
              ) : (
                <>
                  Sends two market orders on <span className="text-ink-200">Boros</span>: {rowA.name}{' '}
                  and {rowB.name}. One atomic batch — neither leg trades unless both are accepted,
                  but each can still fill short.
                </>
              )
            ) : (
              'Pick two Boros markets that share a collateral token and a maturity.'
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

function clampBp(raw: string): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, MAX_BP);
}

function BpInput({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-[10.5px] text-ink-500">
        {label}
      </label>
      <input
        id={id}
        className="input num"
        inputMode="numeric"
        value={value}
        onChange={(e) => onChange(clampBp(e.target.value))}
      />
    </div>
  );
}

/**
 * Mirrors `acknowledgementCopy` in src/core/boros/pair.ts. The spec's sentence
 * describes a FLIP; a delta that only reduces does something materially
 * different, so it gets wording that does not overstate it.
 */
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
