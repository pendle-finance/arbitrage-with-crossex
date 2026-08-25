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
import type { BorosLegFill, BorosPairResult } from '../api/types';
import { Modal } from '../components/Modal';
import { isUsdCollateral } from '../lib/boros';
import { sig } from '../lib/fmt';
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

/**
 * One leg slot of the wizard's step-1 book. `size` is SIGNED — +long / −short,
 * in the executed market's collateral — so a close (which always carries the
 * direction opposing the position) subtracts on its own, with no intent flag.
 */
type SlotFill = { size: number; marketId: number; execApr: number | null };

/**
 * What step 1 has actually put on, folded across EVERY accepted execution —
 * the pair fill, its retries, its completions, single-leg orders, and closes.
 *
 * The old shape was a single `BorosPairResult` gated on `unhedgedSize > 0`,
 * and every non-clean path broke it: a both-legs-zero fill reported
 * unhedgedSize 0 and read as "Rate locked ✓"; a completion's merge kept the
 * stale hedgedSize; a pair-shaped retry REPLACED the aggregate; a single-leg
 * or close execution read as a pair lock. A cumulative signed book has none of
 * those cases — every execution is the same fold.
 *
 * This is the wizard's session-relative view only. Account truth lives on the
 * Positions page (see the header comment); in particular a §6A cancel-and-close
 * fired from a ticket blocker bypasses `onExecuted` and is invisible here.
 */
type StepOneBook = {
  a: SlotFill;
  b: SlotFill;
  /** The unit every `size` is in, from the ticket that traded. */
  collateral: string;
  /** Display only (spread attribution) — never a source of leg identity:
   * a not-submitted leg's sentinel carries a HARDCODED direction (orders.ts). */
  lastResult: BorosPairResult | null;
  /** True when the whole book is one clean pair execution — the only case
   * where that execution's realisedSpreadApr describes the book. */
  soleClean: boolean;
};

const EMPTY_SLOT: SlotFill = { size: 0, marketId: 0, execApr: null };
const EMPTY_BOOK: StepOneBook = {
  a: EMPTY_SLOT,
  b: EMPTY_SLOT,
  collateral: '',
  lastResult: null,
  soleClean: false,
};

/** Was this leg actually sent to the venue? A not-submitted sentinel is
 * all-zero with no failure (orders.ts `notSubmitted`); a REJECTED leg has
 * filledSize 0 but a shortfall and a failure, and must still count. */
const legSubmitted = (leg: BorosLegFill): boolean =>
  leg.filledSize !== 0 || leg.shortfallSize > 0 || leg.failure !== null;

const foldLeg = (slot: SlotFill, leg: BorosLegFill): SlotFill => {
  if (!legSubmitted(leg)) return slot;
  return {
    // The venue's own defence: never trust the raw sign of filledSize.
    size: slot.size + (leg.direction === 'long' ? 1 : -1) * Math.abs(leg.filledSize),
    marketId: leg.marketId,
    execApr: leg.execApr ?? slot.execApr,
  };
};

/** Fills round-trip 18-decimal venue values through float64, so exact-zero
 * comparisons on the folded book can be off by ~1e-11 forever. */
const EPS = 1e-9;

function WizardBody({
  w,
  flow,
  onViewPositions,
}: {
  w: StrategyWizardIntent;
  flow: TradeFlowApi;
  onViewPositions?: () => void;
}) {
  const resuming = (w.initialStep ?? 1) === 2;
  const [step, setStep] = useState<Step>(w.initialStep ?? 1);
  /** Everything step 1 has executed, as one signed book — see StepOneBook. */
  const [book, setBook] = useState<StepOneBook>(EMPTY_BOOK);
  /** The hedged size the perp ticket was last armed with. Continue re-arms
   * ONLY when the book's hedged size differs — a Back → Continue round-trip
   * with nothing new executed must not wipe the user's step-2 edits. */
  const [lastArmedHedge, setLastArmedHedge] = useState<number | null>(null);
  /** Mirrors TradeRail's borosSeen: a visited step stays mounted, hidden. */
  const [perpSeen, setPerpSeen] = useState(w.initialStep === 2);
  /** Two-click close while leaving would strand a naked rate position. */
  const [leaveArmed, setLeaveArmed] = useState(false);
  /** A Boros execution is in flight — the modal must not be closable: the
   * response (and a partial fill's remediation) dies with the ticket. */
  const [executing, setExecuting] = useState(false);

  const { prefillBorosOpen, prefillPair, closeWizard } = flow;

  // Arm step 1 the moment the wizard opens (or step 2 when resuming a
  // boros-only position). Deliberately once per wizard identity — the body is
  // keyed on it — so ticket edits are never fought by a re-arm.
  useEffect(() => {
    if (!resuming) {
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

  /** Fold one accepted execution into the book. Replays never reach this —
   * the ticket skips `onExecuted` for them. */
  const recordExecution = (result: BorosPairResult, collateral: string) =>
    setBook((prev) => {
      /**
       * ⚠ Reset before folding when the legs stopped being the same book.
       *
       * The ticket's selects stay editable inside the wizard, so the user can
       * repick both legs to a different cohort — a different market, possibly
       * a different COLLATERAL — and execute. Summing ETH into a USDT book
       * would produce a hedged size in no unit at all, so a submitted leg
       * whose market differs from the slot's recorded one (or a collateral
       * change) starts the book over from this execution alone.
       */
      const marketChanged =
        (legSubmitted(result.legA) && prev.a.marketId !== 0 && prev.a.marketId !== result.legA.marketId) ||
        (legSubmitted(result.legB) && prev.b.marketId !== 0 && prev.b.marketId !== result.legB.marketId);
      const collateralChanged =
        prev.collateral !== '' && collateral !== '' && prev.collateral !== collateral;
      const base = marketChanged || collateralChanged ? EMPTY_BOOK : prev;
      const wasEmpty = Math.abs(base.a.size) <= EPS && Math.abs(base.b.size) <= EPS;
      return {
        a: foldLeg(base.a, result.legA),
        b: foldLeg(base.b, result.legB),
        collateral: collateral || base.collateral,
        lastResult: result,
        soleClean: wasEmpty && result.bothLegsSubmitted && !result.partial,
      };
    });

  // The book, read out: total exposure, the part that cancels (hedged) and
  // the part that does not (residual). Same-signed slots — a deliberate
  // single-leg lock, say — have hedged 0 and read as all-residual, which is
  // exactly what they are.
  const exposure = Math.abs(book.a.size) + Math.abs(book.b.size);
  const residualSize = Math.abs(book.a.size + book.b.size);
  const hedged = (exposure - residualSize) / 2;
  const stepOneDone = hedged > EPS && residualSize <= EPS * Math.max(1, exposure);
  const lopsided = !stepOneDone && hedged > EPS;
  const oneSided = !stepOneDone && hedged <= EPS && exposure > EPS;

  const continueToHedge = () => {
    /**
     * The hedge is sized from what step 1 actually FILLED — the book's hedged
     * size — not what was asked: a short fill hedged at the intended size is a
     * new directional position wearing a hedge's name. Both buttons that lead
     * here are gated on `hedged > 0`, so there is always a real size.
     *
     * ⚠ What `hedged` MEANS is a property of the market that traded, not of
     * what this wizard was told when it opened. It is denominated in the
     * executed market's COLLATERAL, so that collateral — captured from the
     * ticket that traded — is the only safe discriminator. Branching on
     * `w.sizeBase !== undefined` asked "did the caller know a base quantity?",
     * which is a different question: an ETH cohort whose collateral price was
     * unavailable arrives with no `sizeBase`, and its ETH fill size was then
     * armed as DOLLARS — a ~$9,000 rate leg hedged with a $2 perp pair.
     */
    if (lastArmedHedge === null || Math.abs(hedged - lastArmedHedge) > EPS) {
      if (isUsdCollateral(book.collateral)) {
        // USD-collateral: the Boros size IS the dollar figure.
        armPerps(hedged);
      } else if (w.sizeBase !== undefined && w.sizeBase > 0) {
        // Token-collateral, and we know the intended quantity — scale the USD
        // notional by how much of it actually filled.
        armPerps(w.notionalUsd * (hedged / w.sizeBase), hedged);
      } else {
        /**
         * Token-collateral with no conversion available (no `sizeBase`, so no
         * price to scale by). `hedged` is a COIN quantity and must never be
         * passed as dollars, so the perps keep the intent's USD figure and the
         * user edits before executing — an approximate hedge they can see
         * beats an exact-looking one off by the coin price.
         */
        armPerps(w.notionalUsd);
      }
      setLastArmedHedge(hedged);
    }
    setPerpSeen(true);
    setStep(2);
  };

  /**
   * Is there a rate leg on with no hedge against it?
   *
   * Either because this wizard put exposure on (any nonzero side of the book —
   * a one-sided fill counts, and a book closed back to zero through the wizard
   * stops counting), or because it was OPENED on one — a resume starts at
   * step 2 precisely because the Boros legs already exist and are unhedged.
   */
  const unhedgedRateOn = exposure > EPS || resuming;

  const requestClose = () => {
    // Rate locked but not hedged = naked directional exposure. Leaving is
    // always allowed (Positions derives the resume point), but never silently
    // — and never by momentum: once the warning is up, further Escape presses
    // and backdrop clicks do nothing, because a held key's auto-repeat or a
    // double-click would otherwise arm and close in one perceived gesture.
    // Only the banner's explicit Leave button closes from here.
    if (unhedgedRateOn && step !== 'done') {
      setLeaveArmed(true);
      return;
    }
    closeWizard();
  };

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
    <Modal title={title} locked={executing} onClose={requestClose} widthClass="w-[480px]">
      <div className="flex flex-col gap-4">
        <StepStrip step={step} locked={stepOneDone} />

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
        {!resuming && (
        <div hidden={step !== 1}>
          {/**
           * ⚠ A SUCCEEDED step is a receipt, not a form — and "succeeded"
           * means the BOOK is clean (hedged > 0, residual 0), never a
           * property of the last result alone. A both-legs-zero fill reports
           * unhedgedSize 0 and used to render this receipt for a trade where
           * nothing filled; the book stays empty there and the live ticket —
           * with its real failure report and working Retry — stays up.
           *
           * The ticket is replaced (not just covered) once done: leaving it
           * mounted put TWO live CTAs in the modal at once, so the same pair
           * could be fired a second time by a user the wizard had just told
           * the rate was locked.
           */}
          {stepOneDone ? (
            <div className="flex flex-col gap-3">
              <StepOneReceipt book={book} hedged={hedged} />
              <button type="button" className="btn btn-primary w-full" onClick={continueToHedge}>
                Rate locked ✓ — hedge the perps ▸
              </button>
            </div>
          ) : (
            <>
              <BorosPairTicket
                active={step === 1}
                onBusyChange={setExecuting}
                onExecuted={recordExecution}
              />
              {lopsided && (
                <div className="mt-3 flex flex-col gap-2">
                  <p className="rounded-lg border border-amber-500/25 bg-amber-500/[0.04] px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-200">
                    {/* Deliberately does not say "the report above": that
                        report can be dismissed, and copy pointing at something
                        no longer on screen reads as a bug. The fact that
                        survives either way is what continuing would cost. */}
                    The rate legs are lopsided — {sig(residualSize)}
                    {book.collateral ? ` ${book.collateral}` : ''} is unmatched. Continuing hedges
                    only the size both legs share; the rest stays directional until you complete or
                    close it.
                  </p>
                  <button type="button" className="btn btn-primary w-full" onClick={continueToHedge}>
                    Continue anyway — hedge the perps ▸
                  </button>
                </div>
              )}
              {oneSided && (
                /* Sometimes deliberate (the ticket's Single mode), so this
                   describes the position, not a failure — and offers no
                   Continue: with no shared size there is nothing to hedge,
                   and arming the intent size here was exactly the bug where
                   a one-leg book got a full-size "hedge". */
                <p className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/[0.04] px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-200">
                  Only one side of the rate pair is on — that is directional exposure, not a locked
                  spread. There is no shared size to hedge yet; complete the other leg, or close
                  this one.
                </p>
              )}
            </>
          )}
        </div>
        )}

        {/* --- Step 2: the CrossEx perp hedge ----------------------------- */}
        {(step === 2 || perpSeen) && (
          <div hidden={step !== 2}>
            {step === 2 &&
              !resuming &&
              lastArmedHedge !== null &&
              Math.abs(hedged - lastArmedHedge) > EPS && (
                // An execution that was still in flight when Continue was
                // clicked has landed and moved the book. Re-arming here would
                // wipe the user's edits — the exact bug the lastArmedHedge
                // gate fixes — so say it instead and let them re-continue.
                <p className="mb-2 rounded-lg border border-amber-500/25 bg-amber-500/[0.04] px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-200">
                  The rate legs changed since this hedge was sized — go back to the rate legs and
                  continue again to re-size it.
                </p>
              )}
            <PairTicket onExecuted={() => setStep('done')} />
            {step === 2 && !resuming && (
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
 * be a second source of truth about money. It renders the BOOK (the fold of
 * every execution), synthesized as a clean result: only reachable when the
 * book is clean, so the report shows no Complete/Retry, and `onDismiss` is
 * omitted because the report IS this step now.
 *
 * ⚠ Leg identity comes from the book's slots, never from any raw result: a
 * not-submitted leg's sentinel carries a HARDCODED direction (orders.ts), and
 * after a completion the "last result" describes only the top-up.
 */
function StepOneReceipt({ book, hedged }: { book: StepOneBook; hedged: number }) {
  const synthLeg = (slot: SlotFill): BorosLegFill => ({
    marketId: slot.marketId,
    direction: slot.size > 0 ? 'long' : 'short',
    filledSize: Math.abs(slot.size),
    shortfallSize: 0,
    execApr: slot.execApr,
    feeSize: null,
    failure: null,
  });
  const result: BorosPairResult = {
    legA: synthLeg(book.a),
    legB: synthLeg(book.b),
    bothLegsSubmitted: true,
    hedgedSize: hedged,
    unhedgedSize: 0,
    unhedgedLeg: null,
    // Attributable only when the whole book is one clean execution; a spread
    // stitched across a partial and its top-up would mislabel money.
    realisedSpreadApr: book.soleClean ? (book.lastResult?.realisedSpreadApr ?? null) : null,
    partial: false,
  };
  return (
    <PairResultReport
      result={result}
      collateral={book.collateral}
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
