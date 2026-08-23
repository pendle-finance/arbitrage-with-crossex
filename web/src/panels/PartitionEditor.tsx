/**
 * Which legs belong to this position, as something the user can correct.
 *
 * When one venue leg is shared the server proposes a split — measured from the
 * execution record where it can, paired by price/open-time proximity where it
 * can't. A proposal is not a fact, so this is where it is overridden.
 *
 * ⚠ EVERY CONTROL HERE STATES MEMBERSHIP, not a size. "This leg is mine",
 * "this leg is not mine", "it belongs to nothing". A size is the optional
 * refinement — how much of a shared leg — never the way to say whose it is.
 * The sizes-only model this replaced could not express detaching a leg without
 * asserting a zero, and could not say anything at all about a leg it had no
 * grouping for.
 *
 * The first assertion on a card freezes its current legs into rows under a
 * newly minted id, so everything the solver had proposed is preserved and only
 * the correction changes.
 */
import { useState } from 'react';
import type { StrategyLeg, StrategyRollup } from '../api/types';
import { Chip } from '../components/Chip';
import { Modal } from '../components/Modal';
import { fmtTokenQty } from '../lib/fmt';
import type { LegRef } from './partitionStore';

/**
 * What the card sends up when the user says where one leg belongs.
 *
 * `to` names the DESTINATION CARD by its current strategyId, not a position
 * id: a solver-proposed card has no stable id until someone asserts something
 * about it. The parent resolves it — minting an id and freezing that card's
 * legs if this is the first thing said about it.
 */
export type LegAssertion =
  | { mode: 'assign'; leg: LegRef; to: string; qty?: number }
  | { mode: 'orphan'; leg: LegRef }
  | { mode: 'auto'; leg: LegRef };

/** Where a leg can be sent. */
export interface LegDestination {
  /** The destination card's current strategyId. */
  id: string;
  label: string;
}

/**
 * The venue on each side of a position — how its card header names it.
 *
 * The perp side wins; a Boros leg stands in where the perp leg is not open
 * yet (the perp side equals the Boros side at the same venue). Shared so the
 * destination picker and the header can never name the same position
 * differently — the picker used to insist on a long/short PERP PAIR and fall
 * back to the raw strategyId, which meant a position holding one perp and its
 * Boros legs offered itself as "7e1d80b8".
 */
export function positionVenues(s: StrategyRollup): {
  long: string | null;
  short: string | null;
} {
  const at = (side: 'LONG' | 'SHORT') =>
    s.legs.find((l) => l.kind === 'perp' && l.side === side)?.venue ??
    s.legs.find((l) => l.kind === 'boros' && l.side === side)?.venue ??
    null;
  return { long: at('LONG'), short: at('SHORT') };
}

/** The leg a row can name, or null for a leg the payload cannot address. */
export function legRefOf(l: StrategyLeg): LegRef | null {
  if (l.kind === 'perp') return l.symbol ? { kind: 'perp', symbol: l.symbol } : null;
  return l.marketId === undefined ? null : { kind: 'boros', marketId: l.marketId };
}

/** The chip that says this box is one strategy inside a bigger book. */
export function SplitChip({ s }: { s: StrategyRollup }) {
  // All three chips answer "how was this grouping arrived at". An unhedged
  // card is not a grouping — it is what was left after every grouping — and
  // its HedgeChip already says the one thing worth saying about it.
  if (s.attribution.source === 'unhedged') return null;
  const shared = s.legs.some((l) => l.kind === 'perp' && (l.share ?? 1) < 0.999);
  if (s.attribution.pinned) {
    // All three chips answer one question — how was this grouping arrived at —
    // so this one names the SOURCE, not the owner. "yours" said nothing: every
    // position on the page is the user's.
    return (
      <Chip sm tone="cyan" title="You said which legs are in this position — the rest of the book is solved around it">
        grouped by you
      </Chip>
    );
  }
  if (s.attribution.confidence === 'unconfirmed') {
    return (
      <Chip
        sm
        tone="amber"
        title="No execution record explained this grouping, so it was paired by price and open-time proximity — check it, and say so if it's wrong"
      >
        split unconfirmed
      </Chip>
    );
  }
  if (!shared) return null;
  return (
    <Chip
      sm
      tone="green"
      title="This strategy owns part of a shared venue leg; the split was rebuilt from the fills that opened it"
    >
      split measured
    </Chip>
  );
}

/** Sentinels in the destination picker that are not another card. Bracketed
 * so they cannot collide with a strategyId, and free of leading whitespace,
 * which an <option value> does not survive. */
const HERE = '<here>';
const NOWHERE = '<nowhere>';
const AUTO = '<auto>';

/**
 * A leg's membership, on the leg's own row, in the leg's own unit.
 *
 * The form asks two questions in the order they are decided: WHERE does this
 * leg belong, and then HOW MUCH of it. Nothing commits until Confirm, and
 * Confirm only lights up once something actually changed — so the dialog can
 * be opened, read, and dismissed without touching the book.
 *
 * Choosing "Automatic" hides the amount: the whole point of automatic is that
 * the grouper decides the split, so asking for a number would be asking for
 * something that is then discarded.
 */
export function LegAssignment({
  leg,
  strategyId,
  destinations = [],
  onAssert,
}: {
  leg: StrategyLeg;
  strategyId: string;
  destinations?: readonly LegDestination[];
  onAssert?: (a: LegAssertion) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = legRefOf(leg);

  const unit = leg.kind === 'boros' ? leg.collateral : leg.base;
  const held = leg.notionalToken ?? 0;
  const share = leg.share ?? 1;
  const venueTotal = share > 0 ? held / share : held;
  const shared = share < 0.999;

  /** Where the leg goes. HERE / a destination id / NOWHERE / AUTO. */
  const [where, setWhere] = useState<string>(HERE);
  const [draft, setDraft] = useState('');

  // Read-only surfaces (the share page) get the fact without the affordance.
  if (!ref || !onAssert) {
    return <span className="text-[11px] text-ink-500">this position</span>;
  }

  const reset = () => {
    setWhere(HERE);
    setDraft(String(Number(held.toPrecision(8))));
  };

  const isAuto = where === AUTO;
  const isNowhere = where === NOWHERE;
  const needsAmount = !isAuto && !isNowhere;
  const parsed = Number(draft);
  const amountValid =
    !needsAmount || (draft !== '' && Number.isFinite(parsed) && parsed >= 0 && parsed <= venueTotal + 1e-9);
  // Confirm is for CHANGES. Re-asserting the status quo is a no-op the user
  // should not be invited to perform.
  // A RELATIVE tolerance, not an absolute one: the input is seeded from
  // `toPrecision(8)`, so on a large leg the round-trip differs from `held` by
  // more than 1e-9 and Confirm lit up having changed nothing. The same
  // tolerance decides whether a residual is worth mentioning below.
  const eps = Math.max(1e-9, venueTotal * 1e-7);
  const amountEdited = needsAmount && Math.abs(parsed - held) > eps;
  const changed = where !== HERE || amountEdited;
  const canConfirm = amountValid && changed;

  const commit = () => {
    if (!canConfirm) return;
    if (isAuto) onAssert({ mode: 'auto', leg: ref });
    else if (isNowhere) onAssert({ mode: 'orphan', leg: ref });
    else {
      // A WHOLE leg is assigned without a qty: `qty` absent means "all of this
      // leg that no other position claims", which survives the leg growing and
      // is what a blanket move means. Sending the current size instead would
      // freeze a float snapshot (0.0065 of a token, in one case) as if the user
      // had typed it, and `decodeMembership` treats a typed size as outranking
      // a blanket claim.
      // Choosing a DESTINATION means the whole leg unless the amount was
      // deliberately changed: moving a leg to another card is a statement about
      // ownership, not about the half this card happens to hold right now. Only
      // an edited amount narrows it.
      const whole = where !== HERE ? !amountEdited : Math.abs(parsed - venueTotal) <= eps;
      onAssert({
        mode: 'assign',
        leg: ref,
        to: where === HERE ? strategyId : where,
        ...(whole ? {} : { qty: parsed }),
      });
    }
    setOpen(false);
  };

  const optionClass = (active: boolean) =>
    `rounded-md border px-2.5 py-1.5 text-left text-[11px] transition-colors ${
      active
        ? 'border-cyan-500/60 bg-cyan-500/10 text-cyan-200'
        : 'border-ink-700 bg-ink-900 text-ink-300 hover:border-ink-500 hover:text-ink-100'
    }`;

  return (
    <span className="inline-flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => {
          reset();
          setOpen(true);
        }}
        title={
          shared
            ? `This position holds ${fmtTokenQty(held, unit ?? '')} of the ${fmtTokenQty(venueTotal, unit ?? '')} open on ${leg.venue} — click to change`
            : `This position holds all ${fmtTokenQty(held, unit ?? '')} open on ${leg.venue} — click to assign part of it elsewhere`
        }
        className={`num rounded border border-dashed px-1.5 py-0.5 text-[11px] transition-colors ${
          shared
            ? 'border-amber-500/40 text-amber-300/90 hover:border-amber-400'
            : 'border-ink-600 text-ink-300 hover:border-ink-400 hover:text-ink-100'
        }`}
      >
        {shared && unit ? (
          <>
            {fmtTokenQty(held, unit)}
            <span className="text-ink-500"> / {fmtTokenQty(venueTotal, unit)}</span>
          </>
        ) : (
          // "All of it" rather than "All": the cell answers "how much of this
          // leg belongs here", and a bare "All" left the reader to guess all of
          // WHAT — the leg, the venue, the position.
          'All of it'
        )}
      </button>

      {open && (
        <Modal
          title={`Assign the ${leg.venue} ${leg.kind === 'boros' ? 'Boros' : 'perp'} leg`}
          onClose={() => setOpen(false)}
          widthClass="w-[440px]"
        >
          <div className="flex flex-col gap-4 px-4 py-4 text-left">
            <div>
              <div className="text-[11px] font-medium uppercase tracking-wider text-ink-400">
                Where does it belong?
              </div>
              <div className="mt-2 grid grid-cols-1 gap-1.5">
                <button type="button" className={optionClass(where === HERE)} onClick={() => setWhere(HERE)}>
                  This position
                </button>
                {destinations.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    className={optionClass(where === d.id)}
                    onClick={() => setWhere(d.id)}
                  >
                    {d.label}
                  </button>
                ))}
                <button
                  type="button"
                  className={optionClass(isNowhere)}
                  onClick={() => setWhere(NOWHERE)}
                >
                  Nothing — leave it unassigned
                </button>
                <button type="button" className={optionClass(isAuto)} onClick={() => setWhere(AUTO)}>
                  Automatic
                  <span className="ml-1 text-ink-500">— let the grouper decide</span>
                </button>
              </div>
            </div>

            {/* An amount is only a question when a destination was named. */}
            {needsAmount && (
              <div>
                <div className="text-[11px] font-medium uppercase tracking-wider text-ink-400">
                  How much of it?
                </div>
                <div className="num mt-1 text-[11px] text-ink-500">
                  {fmtTokenQty(venueTotal, unit ?? '')} open on {leg.venue}
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <input
                    type="number"
                    min="0"
                    max={venueTotal}
                    step="any"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    aria-label={`${leg.venue} ${leg.kind} size for this position`}
                    className="num w-36 rounded border border-ink-600 bg-ink-950 px-2 py-1.5 text-right text-ink-100"
                  />
                  {unit && <span className="text-[11px] text-ink-500">{unit}</span>}
                  <button
                    type="button"
                    className="ml-auto rounded border border-ink-700 px-2 py-1 text-[10px] text-ink-400 hover:border-ink-500 hover:text-ink-200"
                    onClick={() => setDraft(String(Number(venueTotal.toPrecision(8))))}
                  >
                    All
                  </button>
                </div>
                {amountValid && parsed < venueTotal - eps && (
                  <div className="num mt-1.5 text-[10px] text-ink-500">
                    {fmtTokenQty(venueTotal - parsed, unit ?? '')} stays unassigned — it appears as its
                    own row to place.
                  </div>
                )}
                {!amountValid && (
                  <div className="mt-1.5 text-[10px] text-rose-400">
                    Enter an amount between 0 and {fmtTokenQty(venueTotal, unit ?? '')}.
                  </div>
                )}
              </div>
            )}

            <div className="flex items-center gap-2 border-t border-ink-800 pt-3">
              <span className="text-[10px] leading-relaxed text-ink-500">
                Changes grouping only. It places no orders.
              </span>
              <button
                type="button"
                className="ml-auto rounded border border-ink-700 px-3 py-1.5 text-[11px] text-ink-300 hover:border-ink-500 hover:text-ink-100"
                onClick={() => setOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!canConfirm}
                onClick={commit}
                className="rounded border border-cyan-500/50 bg-cyan-500/10 px-3 py-1.5 text-[11px] font-medium text-cyan-300 transition-colors hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Confirm
              </button>
            </div>
          </div>
        </Modal>
      )}
    </span>
  );
}


/*
 * An orphaned leg needs no block of its own.
 *
 * It looked like it did: the card that released it drops it, so the picker
 * that undoes the assertion goes with it. But nothing actually disappears —
 * an orphaned PERP becomes unhedged size, which gets its own box with the
 * undo on it, and an orphaned BOROS leg becomes its own unmatched card, whose
 * leg row carries the ordinary picker. A third control listing orphans on
 * every OTHER card said the same thing three times over, in the one vocabulary
 * the user never sees — raw market ids.
 */
