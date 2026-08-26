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
import { fieldValue, fmtDateUtc, fmtTokenQty } from '../lib/fmt';
import { overrunsVenue, reconcileEntries } from './entryOverrideStore';
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
  | { mode: 'auto'; leg: LegRef }
  /**
   * What this position actually paid for its share of the leg — a PRICE for a
   * perp, an APR (as a fraction) for a Boros leg. `value: null` clears it.
   *
   * Separate from `assign` because it answers a different question and is
   * asserted independently: a leg can be split without correcting its entry,
   * and an entry can be corrected without moving anything. The venue's own
   * average is never changed — see entryOverrideStore's conservation note.
   */
  | { mode: 'entry'; leg: LegRef; value: number | null }
  /**
   * This position just CLOSED `qty` of the leg at the venue.
   *
   * Not a regrouping — a statement that the size this card claims is now
   * smaller. It exists because a claim written as an explicit `qty` is an
   * ABSOLUTE number while a venue position NETS: closing a card's own share of
   * a shared leg shrank the venue leg and left the row claiming the same
   * amount out of what remained, quietly taking it from the cards sharing it.
   * The card looked untouched by its own close — the size never moved, only
   * the denominator beside it.
   */
  | { mode: 'closed'; leg: LegRef; qty: number };

/** Where a leg can be sent. */
export interface LegDestination {
  /** The destination card's current strategyId. */
  id: string;
  label: string;
  /**
   * The Boros maturity this card already holds, or null when it holds no
   * Boros leg and so has none to disagree with.
   *
   * ⚠ ONE MATURITY PER POSITION. Cohorts are keyed `(base, maturity)` and
   * `mergedStrategies` emits one card per cohort, so a SOLVED card is
   * single-maturity structurally — there is no check because the shape cannot
   * arise. The manual path had no such floor, and two maturities on one card
   * break more than the hedge ratios: `maturity` is `Math.min` across the
   * legs, and the countdown, `secondsToMaturity`, `spreadReturnUsd` and the
   * PnL projection are all computed against it, so the later leg's rate
   * accrues to the earlier leg's date. Silently — unlike a size mismatch,
   * which at least says so.
   *
   * A card holding several maturities already (a share link, a pin made
   * before this rule) reports its EARLIEST here: it is the one the card's own
   * numbers use, and any leg that disagrees with it is refused anyway.
   */
  borosMaturity: number | null;
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
  entryOverride: entryOverrideProp = null,
  venueEntry: venueEntryProp = null,
}: {
  leg: StrategyLeg;
  strategyId: string;
  destinations?: readonly LegDestination[];
  onAssert?: (a: LegAssertion) => void;
  /** What this position has already asserted it paid, if anything. */
  entryOverride?: number | null;
  /** The venue's own blended entry over the WHOLE position — the number an
   * override divides up. Null when the venue reports none, in which case the
   * field still works but has nothing to reconcile against. */
  venueEntry?: number | null;
}) {
  const [open, setOpen] = useState(false);
  const ref = legRefOf(leg);

  /**
   * A value that is not a number is not a value. Both of these arrive from
   * JSON and from localStorage, and both formatters mishandle a non-finite
   * one: the price branch prints "0", which reads as a real price, and the
   * rate branch prints "NaN". The component already draws "the venue reports
   * none" correctly and that path is tested, so fold non-finite into it rather
   * than formatting a number nobody has.
   */
  const entryOverride = Number.isFinite(entryOverrideProp) ? entryOverrideProp : null;
  const venueEntry = Number.isFinite(venueEntryProp) ? venueEntryProp : null;

  const unit = leg.kind === 'boros' ? leg.collateral : leg.base;
  const held = leg.notionalToken ?? 0;
  const share = leg.share ?? 1;
  const venueTotal = share > 0 ? held / share : held;
  const shared = share < 0.999;

  /**
   * A destination this leg may not go to, and why — see `LegDestination`.
   *
   * Only ever a MATURITY clash. Shape is not policed here: a card holding six
   * legs, or a hedge half-open, is a position the user is entitled to assert.
   * Two maturities is different because it is not a shape the solver can even
   * produce, and because the card's own countdown and every projection on it
   * are computed against one date — so the disagreement does not show up as a
   * warning, it shows up as numbers that are quietly wrong.
   *
   * ⚠ A PERP LEG IS NEVER BLOCKED. A perp is perpetual: one position hedges
   * every maturity cohort at once, which is why the solver attaches perps
   * across cohorts freely. It has no maturity to clash with.
   */
  const blockedReason = (d: LegDestination): string | null => {
    if (leg.kind !== 'boros') return null;
    const mine = leg.maturity;
    if (!mine || d.borosMaturity === null || d.borosMaturity === mine) return null;
    return `matures ${fmtDateUtc(d.borosMaturity)}`;
  };

  /** Where the leg goes. HERE / a destination id / NOWHERE / AUTO. */
  const [where, setWhere] = useState<string>(HERE);
  const [draft, setDraft] = useState('');
  /**
   * The asserted entry, as TYPED.
   *
   * A Boros rate is stored as a fraction but read and written as a percent —
   * nobody types 0.0544 for 5.44% — so the conversion happens here at the UI
   * edge and nowhere else. A perp price needs no conversion.
   */
  const isRate = leg.kind === 'boros';
  // A rate reads as a percent to 2dp — eight decimals of APR is noise, and the
  // Rate column beside it already shows 5.91%. A price keeps its precision:
  // rounding one would misstate a fill.
  // A RATE is always 2dp — as a percent, an APR's third decimal is a
  // hundredth of a basis point and nobody trades on it; carrying it made the
  // field and its placeholder read "5.90778377". A PRICE keeps its precision,
  // where rounding would misstate an actual fill.
  const toDisplay = (v: number) =>
    isRate ? Number((v * 100).toFixed(2)) : Number(fieldValue(v, 10));
  const showEntry = (v: number) => (isRate ? `${(v * 100).toFixed(2)}%` : String(toDisplay(v)));
  const fromDisplay = (v: number) => (isRate ? v / 100 : v);
  const [entryDraft, setEntryDraft] = useState('');

  // Read-only surfaces (the share page) get the fact without the affordance.
  if (!ref || !onAssert) {
    return <span className="text-[11px] text-ink-500">this position</span>;
  }

  const reset = () => {
    setWhere(HERE);
    setDraft(fieldValue(held));
    /**
     * Seeded from THIS claim's current entry, which after any assertion on the
     * leg is the reconciled figure the server computed for it — not the venue
     * blend, and not empty.
     *
     * Once someone has divided the leg, every portion HAS a number, so opening
     * an un-asserted portion and seeing a blank box (with the venue's average
     * behind it as a placeholder) misrepresented what that portion is currently
     * worth. Confirming without editing is a no-op either way: `entryEdited`
     * compares against `entryOverride`, so re-stating the same value changes
     * nothing.
     *
     * Empty still means "nobody has said anything about this leg" — the state
     * before the first assertion, where the venue's blend genuinely is every
     * claim's entry.
     */
    setEntryDraft(entryOverride === null ? '' : String(toDisplay(entryOverride)));
  };

  const isAuto = where === AUTO;
  const isNowhere = where === NOWHERE;
  const needsAmount = !isAuto && !isNowhere;
  const parsed = Number(draft);
  const amountValid =
    !needsAmount || (draft !== '' && Number.isFinite(parsed) && parsed >= 0 && parsed <= venueTotal + 1e-9);
  // Confirm is for CHANGES. Re-asserting the status quo is a no-op the user
  // should not be invited to perform.
  const eps = Math.max(1e-9, venueTotal * 1e-7);
  const amountEdited = needsAmount && Math.abs(parsed - held) > eps;

  // The entry is asked only when this card keeps the leg: an entry is what THIS
  // position paid, so it is meaningless once the leg has been sent elsewhere or
  // handed back to the grouper.
  // Only on a leg this card KEEPS, and only when it genuinely shares it.
  //
  // On a wholly-owned leg there is no "rest of the leg" to absorb a correction:
  // the venue's entry IS this position's entry, so an assertion here would be
  // pure fabrication with nothing to balance it — and the reconciliation line
  // would be a lie ("the rest of the GATE leg takes whatever balances back to
  // …" when there is no rest). Correcting a wholly-owned entry means disputing
  // the venue's own fill report, which is not what this control is for.
  //
  // ⚠ Judged on the size being claimed IN THIS DIALOG, not just the leg's
  // current split: taking ALL of a shared leg leaves no remainder either, so
  // the question stops making sense the moment the amount is raised to the
  // whole. Without this the form kept offering an entry and promising "the
  // other 0.01 becomes 2461.85" while the user was claiming all 0.02 — naming
  // a portion that would no longer exist.
  const claimsWholeLeg = needsAmount && amountValid && parsed >= venueTotal - eps;
  const asksEntry = where === HERE && shared && !claimsWholeLeg;
  const entryParsed = Number(entryDraft);
  const entryCleared = entryDraft.trim() === '';
  // A price/rate must be positive — a zero or negative entry is not a fill, and
  // it would poison the weighted average it feeds.
  const entryPositive = !asksEntry || entryCleared || (Number.isFinite(entryParsed) && entryParsed > 0);
  const entryValue = entryCleared ? null : fromDisplay(entryParsed);
  /**
   * Does this assertion leave the REST of the venue leg impossible?
   *
   * Conservation means the size this card does not hold has to absorb whatever
   * the assertion moves. Claim a high enough entry and the implied price for
   * that remainder goes negative — nobody bought at −95,119 per ETH — and the
   * "balances back to" promise below becomes a falsehood. `overrunsVenue` is
   * the same check the store's own maths uses; this is where it earns its keep.
   */
  const entryOverruns =
    asksEntry &&
    entryPositive &&
    !entryCleared &&
    entryValue !== null &&
    venueEntry !== null &&
    venueTotal > 0 &&
    overrunsVenue(
      [
        { positionId: strategyId, qty: held, asserted: entryValue },
        // Everything else open on the venue, as one un-asserted claim: it is
        // what has to absorb the difference.
        { positionId: '<rest>', qty: venueTotal - held, asserted: null },
      ],
      venueEntry,
      venueTotal,
    );
  const entryValid = entryPositive && !entryOverruns;
  /**
   * What the rest of the venue leg becomes if this assertion is confirmed.
   *
   * Computed with the SAME `reconcileEntries` the store and the backend use,
   * never a second formula written for the label — a preview that disagreed
   * with the result would be worse than no preview. Null when there is nothing
   * to show (no assertion, or an overrun the caller is already refusing), and
   * the line falls back to naming the mechanism.
   */
  const impliedRest =
    asksEntry && entryValid && !entryCleared && entryValue !== null && venueEntry !== null && venueTotal > 0
      ? (reconcileEntries(
          [
            { positionId: strategyId, qty: held, asserted: entryValue },
            { positionId: '<rest>', qty: venueTotal - held, asserted: null },
          ],
          venueEntry,
          venueTotal,
        ).get('<rest>') ?? null)
      : null;
  const entryEdited =
    asksEntry &&
    entryValid &&
    (entryValue === null
      ? entryOverride !== null
      : entryOverride === null || Math.abs(entryValue - entryOverride) > Math.abs(entryValue) * 1e-9);

  const changed = where !== HERE || amountEdited || entryEdited;
  const canConfirm = amountValid && entryValid && changed;

  const commit = () => {
    if (!canConfirm) return;
    // The entry rides along with — never instead of — the membership change.
    // Emitted FIRST so a leg that is also being resized already carries the
    // corrected entry when the parent re-solves.
    if (entryEdited) onAssert({ mode: 'entry', leg: ref, value: entryValue });
    // Membership untouched: the user only corrected the entry, and re-asserting
    // "this position, all of it" would pin a leg the solver was free to move.
    if (!(where !== HERE || amountEdited)) {
      setOpen(false);
      return;
    }
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
      //
      // ⚠ Staying HERE and RAISING the amount is different. A blanket claim
      // means "all of this leg that NO OTHER position claims", so on a leg a
      // sibling already holds part of, pressing All and confirming drew only
      // the leftover — which was nothing, and the assignment silently did
      // nothing at all. Naming the size instead makes it a stated claim, which
      // is drawn before blanket ones and takes the size back off the sibling.
      // That is what the user asked for by typing the venue's whole amount.
      const whole =
        where !== HERE
          ? !amountEdited
          : !amountEdited && Math.abs(parsed - venueTotal) <= eps;
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
          title={`Adjust the ${leg.venue} ${leg.kind === 'boros' ? 'Boros' : 'perp'} leg`}
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
                {destinations.map((d) => {
                  const blocked = blockedReason(d);
                  return (
                    <button
                      key={d.id}
                      type="button"
                      disabled={blocked !== null}
                      title={
                        blocked === null
                          ? undefined
                          : `That position ${blocked}; this leg matures ${fmtDateUtc(leg.maturity ?? 0)}. A position runs to ONE date — its countdown and every projection on it are computed against a single maturity.`
                      }
                      className={`${optionClass(where === d.id)} ${
                        blocked === null ? '' : 'cursor-not-allowed opacity-40'
                      }`}
                      onClick={() => blocked === null && setWhere(d.id)}
                    >
                      {d.label}
                      {blocked !== null && (
                        <span className="ml-1 text-ink-500">— {blocked}, not this one</span>
                      )}
                    </button>
                  );
                })}
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
                    onClick={() => setDraft(fieldValue(venueTotal))}
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

            {/* Only for a leg this card is keeping — see `asksEntry`. */}
            {asksEntry && (
              <div>
                <div className="text-[11px] font-medium uppercase tracking-wider text-ink-400">
                  {isRate ? 'What rate did it lock?' : 'What did it cost?'}
                </div>
                <div className="num mt-1 text-[11px] text-ink-500">
                  {venueEntry !== null
                    ? `${leg.venue} reports ${showEntry(venueEntry)} across the whole position`
                    : `${leg.venue} reports no ${isRate ? 'rate' : 'entry price'} for this leg`}
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={entryDraft}
                    onChange={(e) => setEntryDraft(e.target.value)}
                    placeholder={venueEntry !== null ? String(toDisplay(venueEntry)) : ''}
                    aria-label={`${leg.venue} ${leg.kind} entry ${isRate ? 'rate' : 'price'} for this position`}
                    className="num w-36 rounded border border-ink-600 bg-ink-950 px-2 py-1.5 text-right text-ink-100"
                  />
                  <span className="text-[11px] text-ink-500">{isRate ? '% APR' : 'per coin'}</span>
                  {entryOverride !== null && (
                    <button
                      type="button"
                      className="ml-auto rounded border border-ink-700 px-2 py-1 text-[10px] text-ink-400 hover:border-ink-500 hover:text-ink-200"
                      onClick={() => setEntryDraft('')}
                    >
                      Clear
                    </button>
                  )}
                </div>
                {entryOverruns && venueEntry !== null && (
                  <div className="mt-1.5 text-[10px] text-rose-400">
                    Nothing could balance that. {fmtTokenQty(venueTotal - held, unit ?? '')} of this
                    leg belongs to other positions, and for the {leg.venue} average to stay{' '}
                    {showEntry(venueEntry)} they would have to
                    have entered below zero.
                  </div>
                )}
                {entryValid && !entryCleared && venueEntry !== null && (
                  // The whole promise of the feature, said plainly: what you
                  // claim here does not change the venue's total, it decides
                  // how that total is divided.
                  //
                  // ⚠ It states the OUTCOME, not just the mechanism. Saying
                  // only "takes whatever balances back to X" leaves the reader
                  // to compute what is being written into a position they are
                  // not looking at — which is the wrong homework to set before
                  // a Confirm, and testers stopped here rather than press it.
                  <div className="num mt-1.5 text-[10px] text-ink-500">
                    {impliedRest === null ? (
                      <>
                        The rest of the {leg.venue} leg takes whatever balances back to{' '}
                        {showEntry(venueEntry)}.
                      </>
                    ) : (
                      <>
                        The other {fmtTokenQty(venueTotal - held, unit ?? '')} on {leg.venue}{' '}
                        becomes <span className="text-ink-300">{showEntry(impliedRest)}</span>, which
                        keeps the venue average at {showEntry(venueEntry)}.
                      </>
                    )}
                  </div>
                )}
                {entryValid && entryCleared && (
                  <div className="mt-1.5 text-[10px] text-ink-500">
                    Empty — this position takes its share of the {leg.venue} average.
                  </div>
                )}
                {/* Only the not-a-number case. The overrun above is also
                    invalid, but it has its own, more specific message — showing
                    both told the user to enter something above zero when what
                    they typed already was. */}
                {!entryPositive && (
                  <div className="mt-1.5 text-[10px] text-rose-400">
                    Enter a {isRate ? 'rate' : 'price'} above zero, or leave it empty.
                  </div>
                )}
                <div className="mt-1.5 text-[10px] text-ink-600">
                  Fees stay pro-rated by size — correcting an entry never restates what you paid in
                  fees.
                </div>
              </div>
            )}

            <div className="flex items-center gap-2 border-t border-ink-800 pt-3">
              {/* Reached from a Positions table full of live [Close] buttons,
                  so "will this trade?" is the first question a reader has. It
                  was the smallest text in the dialog, losing to a prominent
                  Confirm — testers assumed Confirm would place an order. */}
              <span className="text-[11px] font-medium leading-relaxed text-ink-300">
                Changes grouping only — it places no orders.
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
