/**
 * Guided open-a-strategy wizard: one modal, two steps, one full strategy.
 *
 *   Step 1 — lock the rate   (both Boros legs, one atomic batch)
 *   Step 2 — hedge the perps (both CrossEx legs)
 *   Done   — hand off to the Positions page
 *
 * The four legs were always opened as exactly these two executions; the wizard
 * exists to SAY so. Two side-by-side card buttons styled primary/secondary read
 * as "pick one" — the universal idiom for alternatives — when the truth is
 * "both, in this order". A numbered surface that advances is the only shape
 * that states an ordered conjunction.
 *
 * The tickets themselves are the SAME components the manual drawer mounts,
 * armed through the same TradeFlow prefill channel — the wizard owns sequence
 * and framing, never execution. Both stay mounted once seen (TradeRail's own
 * rule): step 1's fill report and a mid-flight execution must survive the step
 * switch, because a buried live directional exposure is precisely the failure
 * this surface exists to prevent.
 *
 * Progress is never trusted from memory alone: closing after step 1 is safe
 * because the Positions page derives "rate locked, unhedged" from live legs
 * (StrategyCard's boros-only cue) and re-enters here at step 2.
 */
import { useEffect, useState } from 'react';
import type { BorosPairResult } from '../api/types';
import { Modal } from '../components/Modal';
import { isUsdCollateral } from '../lib/boros';
import { BorosPairTicket } from './BorosPairTicket';
import { PairResultReport } from './BorosPairBits';
import { PairTicket } from './PairTicket';
import { useTradeFlow, type StrategyWizardIntent, type TradeFlowApi } from './TradeFlow';

export function StrategyWizard({ onViewPositions }: { onViewPositions?: () => void }) {
  const flow = useTradeFlow();
  const w = flow.wizard;
  if (!w) return null;
  // Keyed per intent: a different strategy is a different wizard, never a
  // form-swap under the user's hands — the exact disorientation the old
  // always-on rail produced.
  return (
    <WizardBody
      // `initialStep` is part of the identity: a FRESH open and a RESUME of
      // the same coin/venues/maturity are different flows (one mounts the
      // Boros ticket, one must not), and sharing a key would carry one's
      // state into the other instead of remounting.
      key={`${w.base}|${w.borosLongVenue}|${w.borosShortVenue}|${w.maturity ?? ''}|${w.initialStep ?? 1}`}
      w={w}
      flow={flow}
      onViewPositions={onViewPositions}
    />
  );
}

type Step = 1 | 2 | 'done';

function WizardBody({
  w,
  flow,
  onViewPositions,
}: {
  w: StrategyWizardIntent;
  flow: TradeFlowApi;
  onViewPositions?: () => void;
}) {
  const [step, setStep] = useState<Step>(w.initialStep ?? 1);
  /** Step 1's last venue result — set on any accepted Boros execution. */
  const [locked, setLocked] = useState<BorosPairResult | null>(null);
  /** The unit `locked`'s sizes are in, straight from the ticket that traded. */
  const [lockedCollateral, setLockedCollateral] = useState('');
  /** Mirrors TradeRail's borosSeen: a visited step stays mounted, hidden. */
  const [perpSeen, setPerpSeen] = useState(w.initialStep === 2);
  /** Two-click close while leaving would strand a naked rate position. */
  const [leaveArmed, setLeaveArmed] = useState(false);

  const { prefillBorosOpen, prefillPair, closeWizard } = flow;

  // Arm step 1 the moment the wizard opens (or step 2 when resuming a
  // boros-only position). Deliberately once per wizard identity — the body is
  // keyed on it — so ticket edits are never fought by a re-arm.
  useEffect(() => {
    if ((w.initialStep ?? 1) === 1) {
      prefillBorosOpen({
        base: w.base,
        longVenue: w.borosLongVenue,
        shortVenue: w.borosShortVenue,
        maturity: w.maturity,
        size: w.notionalUsd,
        sizeBase: w.sizeBase,
      });
    } else {
      armPerps(w.notionalUsd, w.sizeBase);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const armPerps = (notionalUsd: number, sizeBase?: number) =>
    prefillPair({
      base: w.base,
      longVenue: w.crossexLongVenue,
      shortVenue: w.crossexShortVenue,
      notionalUsd,
      ...(sizeBase !== undefined && sizeBase > 0 ? { sizeUnit: 'base' as const, sizeBase } : {}),
      ...(w.perpMode ? { mode: w.perpMode } : {}),
    });

  const residual = locked !== null && locked.unhedgedSize > 0;

  const continueToHedge = () => {
    /**
     * The hedge is sized from what step 1 actually FILLED, not what was asked:
     * a short fill hedged at the intended size is a new directional position
     * wearing a hedge's name. `hedgedSize` is the size both legs share; on a
     * clean fill it equals the intent and this is a no-op. A completion result
     * (`bothLegsSubmitted` false) or a zero falls back to the original intent —
     * the report on screen is then the honest source and the field stays
     * editable.
     */
    const fillSize =
      locked && locked.bothLegsSubmitted && locked.hedgedSize > 0 ? locked.hedgedSize : null;
    /**
     * ⚠ What `fillSize` MEANS is a property of the market that traded, not of
     * what this wizard was told when it opened.
     *
     * `hedgedSize` is denominated in the executed market's COLLATERAL, so the
     * only safe discriminator is that collateral — captured from the ticket
     * that traded. Branching on `w.sizeBase !== undefined` (the old test)
     * asked "did the caller know a base quantity?", which is a different
     * question: an ETH cohort whose collateral price was unavailable arrives
     * with no `sizeBase`, and its ETH fill size was then armed as DOLLARS —
     * a ~$9,000 rate leg hedged with a $2 perp pair.
     */
    if (fillSize === null) {
      armPerps(w.notionalUsd, w.sizeBase);
    } else if (isUsdCollateral(lockedCollateral)) {
      // USD-collateral: the Boros size IS the dollar figure.
      armPerps(fillSize);
    } else if (w.sizeBase !== undefined && w.sizeBase > 0) {
      // Token-collateral, and we know the intended quantity — scale the USD
      // notional by how much of it actually filled.
      armPerps(w.notionalUsd * (fillSize / w.sizeBase), fillSize);
    } else {
      /**
       * Token-collateral with no conversion available (no `sizeBase`, so no
       * price to scale by). `fillSize` is a COIN quantity and must never be
       * passed as dollars, so the perps keep the intent's USD figure and the
       * user edits before executing — an approximate hedge they can see beats
       * an exact-looking one off by the coin price.
       */
      armPerps(w.notionalUsd);
    }
    setPerpSeen(true);
    setStep(2);
  };

  /**
   * Is there a rate leg on with no hedge against it?
   *
   * Either because this wizard just locked one (`locked`), or because it was
   * OPENED on one — a resume starts at step 2 precisely because the Boros legs
   * already exist and are unhedged. The second case is the same naked
   * exposure, and it used to leave silently: the guard tested `locked`, which
   * a resume never sets.
   */
  const unhedgedRateOn = locked !== null || (w.initialStep ?? 1) === 2;

  const requestClose = () => {
    // Rate locked but not hedged = naked directional exposure. Leaving is
    // always allowed (Positions derives the resume point), but never silently.
    if (unhedgedRateOn && step !== 'done' && !leaveArmed) {
      setLeaveArmed(true);
      return;
    }
    closeWizard();
  };

  const resuming = (w.initialStep ?? 1) === 2;
  /**
   * Venue pair for the subtitle, from whichever side is known.
   *
   * A resume is opened from a position whose venues come off its LEGS, and a
   * lopsided book can be missing one side entirely — so neither name is
   * assumed present, and a missing one is dropped rather than printed as an
   * empty gap between separators.
   */
  const venuePair = [
    w.borosShortVenue ? `short ${w.borosShortVenue.toLowerCase()}` : null,
    w.borosLongVenue ? `long ${w.borosLongVenue.toLowerCase()}` : null,
  ]
    .filter((p): p is string => p !== null)
    .join(' / ');
  const title = (
    <span className="flex items-baseline gap-2">
      {/* A resume is FINISHING a position that already exists — calling that
          "Open this strategy" tells the user they are starting something they
          are half-way through. */}
      <span>{resuming ? 'Finish this strategy' : 'Open this strategy'}</span>
      <span className="num text-[12px] font-normal text-ink-400">
        {w.base}
        {venuePair && ` · ${venuePair}`}
      </span>
    </span>
  );

  return (
    <Modal title={title} onClose={requestClose} widthClass="w-[480px]">
      <div className="flex flex-col gap-4">
        <StepStrip step={step} locked={locked !== null} />

        {leaveArmed && step !== 'done' && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/[0.08] px-3 py-2 text-[12px] leading-relaxed text-amber-100">
            <span>
              The rate is locked but not hedged — until the perp legs open you hold directional
              exposure. The Positions page will show this and offer to finish the hedge.
            </span>
            <span className="flex shrink-0 gap-2">
              <button type="button" className="btn !py-1 text-[11px]" onClick={closeWizard}>
                Leave
              </button>
              <button
                type="button"
                className="btn btn-primary !py-1 text-[11px]"
                onClick={() => setLeaveArmed(false)}
              >
                Stay
              </button>
            </span>
          </div>
        )}

        {/* --- Step 1: the Boros rate legs. Not mounted at all on a resume
            (initialStep 2): those rate legs already exist as a position, and
            an idle ticket for them would only poll a quote nobody wants. --- */}
        {(w.initialStep ?? 1) === 1 && (
        <div hidden={step !== 1}>
          {/**
           * ⚠ A SUCCEEDED step is a receipt, not a form.
           *
           * Once the rate is locked the ticket is replaced by its result. It
           * used to stay mounted underneath, which put TWO live CTAs in the
           * modal at once — the ticket's own `Confirm — 2 Boros market orders`
           * and the wizard's `Rate locked ✓ — hedge the perps` — so the same
           * pair could be fired a second time by a user the wizard had just
           * told the rate was locked. (Dismissing the ticket's fill report
           * calls `setReport(null)`, which returns it to its ordinary armed
           * state; the wizard's own `locked` never cleared, so both showed.)
           *
           * A PARTIAL fill is the exception: its Complete/Retry actions arm
           * the ticket again, so the form has to stay for that case — there
           * the residual, not the wizard, is what still needs an order.
           */}
          {locked !== null && !residual ? (
            <div className="flex flex-col gap-3">
              <StepOneReceipt result={locked} collateral={lockedCollateral} />
              <button type="button" className="btn btn-primary w-full" onClick={continueToHedge}>
                Rate locked ✓ — hedge the perps ▸
              </button>
            </div>
          ) : (
            <>
              <BorosPairTicket
                active={step === 1}
                onExecuted={(result, collateral) => {
                  /**
                   * ⚠ A COMPLETION must not replace the pair result.
                   *
                   * `onExecuted` fires for every accepted execution, including
                   * the one-leg completion the report's "Complete now" arms.
                   * A completion always reports `unhedgedSize: 0`
                   * (orders.ts: `bothSubmitted ? … : 0`), so overwriting
                   * `locked` with it flipped `residual` to false and made the
                   * receipt describe the 100-unit top-up instead of the
                   * 1,000-unit rate lock behind it — and sized the hedge off
                   * the wrong number.
                   *
                   * The PAIR result is the one that describes this step, so it
                   * is kept; a completion only clears the residual it closed.
                   */
                  setLockedCollateral(collateral);
                  setLocked((prev) =>
                    prev !== null && !result.bothLegsSubmitted
                      ? { ...prev, unhedgedSize: 0, unhedgedLeg: null }
                      : result,
                  );
                }}
              />
              {locked !== null && (
                <div className="mt-3 flex flex-col gap-2">
                  <p className="rounded-lg border border-amber-500/25 bg-amber-500/[0.04] px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-200">
                    {/* Deliberately does not say "the report above": that
                        report can be dismissed, and copy pointing at something
                        no longer on screen reads as a bug. The fact that
                        survives either way is what continuing would cost. */}
                    One leg filled short. Continuing now hedges only the size both legs share —
                    the rest stays directional until you complete or close it.
                  </p>
                  <button type="button" className="btn btn-primary w-full" onClick={continueToHedge}>
                    Continue anyway — hedge the perps ▸
                  </button>
                </div>
              )}
            </>
          )}
        </div>
        )}

        {/* --- Step 2: the CrossEx perp hedge ----------------------------- */}
        {(step === 2 || perpSeen) && (
          <div hidden={step !== 2}>
            {step === 2 && locked === null && (w.initialStep ?? 1) === 1 && (
              // Only reachable via the back link below after arriving armed —
              // still worth stating whose sizes the ticket is holding.
              <p className="mb-2 text-[11px] text-ink-400">
                Sized from the locked rate legs — edit before executing if they differ.
              </p>
            )}
            <PairTicket onExecuted={() => setStep('done')} />
            {step === 2 && (w.initialStep ?? 1) === 1 && (
              <button
                type="button"
                className="mt-3 text-[11px] text-ink-400 underline decoration-dotted hover:text-ink-200"
                onClick={() => setStep(1)}
              >
                ‹ Back to the rate legs
              </button>
            )}
          </div>
        )}

        {/* --- Done: hand off to Positions -------------------------------- */}
        {step === 'done' && (
          <div className="flex flex-col gap-3">
            <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/[0.05] px-3 py-2.5 text-[12.5px] leading-relaxed text-ink-100">
              <span className="mr-2 font-semibold text-emerald-400">✓ Strategy submitted.</span>
              The perp legs are executing — the deal view tracks their fills. Your position appears
              on the Positions page, which watches all four legs from here on.
            </div>
            <button
              type="button"
              className="btn btn-primary w-full"
              onClick={() => {
                closeWizard();
                onViewPositions?.();
              }}
            >
              View my position →
            </button>
            <button
              type="button"
              className="self-center text-[11px] text-ink-400 underline decoration-dotted hover:text-ink-200"
              onClick={closeWizard}
            >
              close
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}

/**
 * Step 1, done: what was traded, not a form that can be traded again.
 *
 * Reuses the ticket's own report so the numbers and their wording are the same
 * ones the ticket would have shown — a receipt that paraphrased the fill would
 * be a second source of truth about money. The report's Complete/Retry actions
 * are deliberately inert here: this renders only for a CLEAN fill, where there
 * is nothing left to complete, and a partial keeps the live ticket instead.
 */
function StepOneReceipt({
  result,
  collateral,
}: {
  result: BorosPairResult;
  collateral: string;
}) {
  return (
    <PairResultReport
      result={result}
      collateral={collateral}
      // A clean fill has no residual and no shortfall, so neither action is
      // rendered; `onDismiss` is omitted because the report IS this step now,
      // and hiding it would leave the step blank.
      onComplete={() => {}}
      onRetry={() => {}}
    />
  );
}

/** 1 ── 2 ── ✓, with the active step lit and finished steps checked. */
function StepStrip({ step, locked }: { step: Step; locked: boolean }) {
  const items: { n: 1 | 2; label: string; venue: string; done: boolean; active: boolean }[] = [
    {
      n: 1,
      label: 'Lock the rate',
      venue: 'Boros',
      done: locked || step === 2 || step === 'done',
      active: step === 1,
    },
    {
      n: 2,
      label: 'Hedge the perps',
      venue: 'Gate CrossEx',
      done: step === 'done',
      active: step === 2,
    },
  ];
  return (
    /* The strip is the wizard's spine — it is what says the two executions are
       ORDERED rather than alternatives, which is the whole reason this surface
       exists. At 11px with 20px bullets it read as a caption and got skipped;
       it now carries the weight of a heading, sitting on its own banded row so
       it separates from the ticket below instead of floating above it. */
    <ol className="flex items-center gap-3 rounded-lg border border-ink-800 bg-ink-900/40 px-3 py-2.5 text-[13px]">
      {items.map((it, i) => (
        <li key={it.n} className="flex min-w-0 flex-1 items-center gap-2.5">
          {i > 0 && <span aria-hidden className="h-px w-5 shrink-0 bg-ink-700" />}
          <span
            className={`num flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[12px] font-semibold ${
              it.done
                ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300'
                : it.active
                  ? 'border-cyan-400/70 bg-cyan-500/15 text-cyan-300'
                  : 'border-ink-700 bg-ink-900 text-ink-500'
            }`}
          >
            {it.done ? '✓' : it.n}
          </span>
          <span className="flex min-w-0 flex-col leading-tight">
            <span
              className={`truncate ${it.active ? 'font-semibold text-ink-100' : it.done ? 'text-ink-200' : 'text-ink-500'}`}
            >
              {it.label}
            </span>
            {/* The venue is the part that tells you WHICH book each step
                touches; it was buried in the same 11px run as the verb. */}
            <span className="truncate text-[10.5px] text-ink-500">{it.venue}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}
