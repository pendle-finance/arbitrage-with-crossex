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
 * The size the user holds is the thing they recognise — "50k YU of the 100k on
 * Hyperliquid" — so that is what the row states and what the editor takes.
 * The previous control said "51% of leg" behind a chevron: a percentage is not
 * a quantity anyone holds, cannot be typed back without knowing the venue
 * total, and hid the fact that a leg was split at all.
 *
 * Releasing size does not delete it. Whatever this position gives up becomes
 * unclaimed and shows up as its own orphan row, which carries the same control
 * — so a 100k leg split 50/50 is two rows the user can each place.
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
  const [draft, setDraft] = useState('');
  const ref = legRefOf(leg);
  // Read-only surfaces (the share page) get the fact without the affordance.
  if (!ref || !onAssert) {
    return <span className="text-[11px] text-ink-500">this position</span>;
  }

  const unit = leg.kind === 'boros' ? leg.collateral : leg.base;
  const held = leg.notionalToken ?? 0;
  const share = leg.share ?? 1;
  const venueTotal = share > 0 ? held / share : held;
  const shared = share < 0.999;
  const parsed = Number(draft);
  const valid = draft !== '' && Number.isFinite(parsed) && parsed >= 0 && parsed <= venueTotal + 1e-9;

  return (
    <span className="inline-flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => {
          setDraft(String(Number(held.toPrecision(8))));
          setOpen((v) => !v);
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
        {/* An UNSHARED leg is wholly this position's, and printing its size
            here just repeats the Notional column one cell to the left. The
            size only carries information when it is a FRACTION of what the
            venue holds — so that is the only time it is shown.
            "All" rather than "this position": the column header already says
            what it belongs to, and the cell has to share a row with five
            others inside a fixed-width card. */}
        {shared && unit ? (
          <>
            {fmtTokenQty(held, unit)}
            <span className="text-ink-500"> / {fmtTokenQty(venueTotal, unit)}</span>
          </>
        ) : (
          'All'
        )}
      </button>

      {open && (
        <Modal
          title={`Assign the ${leg.venue} ${leg.kind === 'boros' ? 'Boros' : 'perp'} leg`}
          onClose={() => setOpen(false)}
          widthClass="w-[420px]"
        >
        <div className="p-4 text-left">
          <div className="text-[12px] font-medium text-ink-200">
            How much of this leg is in this position?
          </div>
          <div className="num mt-1 text-[11px] text-ink-500">
            {fmtTokenQty(venueTotal, unit ?? '')} open on the venue
          </div>
          <div className="mt-2 flex items-center gap-1.5">
            <input
              type="number"
              min="0"
              max={venueTotal}
              step="any"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              aria-label={`${leg.venue} ${leg.kind} size for this position`}
              className="num w-32 rounded border border-ink-600 bg-ink-950 px-1.5 py-1 text-right text-ink-100"
            />
            {unit && <span className="text-[11px] text-ink-500">{unit}</span>}
            <button
              type="button"
              disabled={!valid}
              className="ml-auto rounded border border-cyan-500/40 bg-cyan-500/10 px-2 py-1 text-[11px] font-medium text-cyan-300 disabled:opacity-40"
              onClick={() => {
                if (!valid) return;
                onAssert({ mode: 'assign', leg: ref, to: strategyId, qty: parsed });
                setOpen(false);
              }}
            >
              Assign
            </button>
          </div>
          {valid && parsed < venueTotal - 1e-9 && (
            <div className="num mt-1.5 text-[10px] text-ink-500">
              {fmtTokenQty(venueTotal - parsed, unit ?? '')} stays unassigned — it appears as its own
              row to place.
            </div>
          )}

          {/* Whole-leg moves, for when the size is right and the OWNER is wrong. */}
          <div className="mt-2.5 flex flex-wrap gap-1.5 border-t border-ink-800 pt-2">
            {destinations.map((d) => (
              <button
                key={d.id}
                type="button"
                className="rounded border border-ink-600 px-1.5 py-0.5 text-[10px] text-ink-300 hover:border-ink-400 hover:text-ink-100"
                onClick={() => {
                  onAssert({ mode: 'assign', leg: ref, to: d.id });
                  setOpen(false);
                }}
              >
                → {d.label}
              </button>
            ))}
            <button
              type="button"
              className="rounded border border-ink-600 px-1.5 py-0.5 text-[10px] text-ink-300 hover:border-ink-400 hover:text-ink-100"
              onClick={() => {
                onAssert({ mode: 'orphan', leg: ref });
                setOpen(false);
              }}
            >
              Unassign
            </button>
            <button
              type="button"
              className="rounded border border-ink-600 px-1.5 py-0.5 text-[10px] text-ink-300 hover:border-ink-400 hover:text-ink-100"
              onClick={() => {
                onAssert({ mode: 'auto', leg: ref });
                setOpen(false);
              }}
            >
              Automatic
            </button>
          </div>
          <div className="mt-3 text-[11px] leading-relaxed text-ink-500">
            Changes how the app groups your positions. It places no orders.
          </div>
        </div>
        </Modal>
      )}
    </span>
  );
}

/**
 * Where one leg belongs, rendered inside that leg's own expanded row.
 *
 * It lives there rather than in a block of its own because the question is
 * about THIS leg, and the row above it already says which leg and how big —
 * repeating both in a separate list was the same information twice, on a card
 * that is already dense.
 *
 * A membership row IS (leg → position), so one picker says everything. The
 * five buttons this replaces were three indistinguishable flavours of "remove"
 * plus two of "claim" — and between them they still could not express the
 * commonest correction of all, moving a leg to the card next door.
 */
export function LegMembership({
  s,
  leg,
  destinations = [],
  onAssert,
}: {
  s: StrategyRollup;
  leg: StrategyLeg;
  destinations?: readonly LegDestination[];
  onAssert?: (a: LegAssertion) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const ref = legRefOf(leg);
  if (!ref || !onAssert) return null;

  const held = leg.notionalToken ?? 0;
  /**
   * What `notionalToken` counts on THIS leg — never the card's coin.
   *
   * A perp is sized in its base coin, but a Boros position is sized in the
   * COLLATERAL it is margined in, which is routinely a different token: a HYPE
   * card carrying a USDT-collateral Boros leg offered to hold "100000 HYPE"
   * when the figure was 100,000 USDT. The notional column already reads the
   * unit off the leg this way; the size editor did not.
   */
  const unit = leg.kind === 'boros' ? leg.collateral : leg.base;
  const share = leg.share ?? 1;
  const total = share > 0 ? held / share : held;
  const shared = share < 0.999;
  const parsed = Number(draft);
  const valid = draft !== null && draft !== '' && Number.isFinite(parsed) && parsed >= 0;

  const choose = (value: string) => {
    if (value === HERE) onAssert({ mode: 'assign', leg: ref, to: s.strategyId });
    else if (value === NOWHERE) onAssert({ mode: 'orphan', leg: ref });
    else if (value === AUTO) onAssert({ mode: 'auto', leg: ref });
    else onAssert({ mode: 'assign', leg: ref, to: value });
  };

  return (
    <div className="text-xs">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="flex items-center gap-1.5">
          <span className="text-ink-500">belongs to</span>
          <select
            aria-label={`Where the ${leg.venue} ${leg.kind} leg belongs`}
            className="rounded border border-ink-600 bg-ink-900 px-1.5 py-0.5 text-ink-100"
            value={HERE}
            onChange={(e) => choose(e.target.value)}
          >
            <option value={HERE}>this position</option>
            {destinations.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
            <option value={NOWHERE}>nothing — report as unhedged</option>
            <option value={AUTO}>automatic</option>
          </select>
          {/* The size is the rare refinement — only a shared leg needs one, and
              only when the split itself is wrong rather than the ownership. */}
          <button
            type="button"
            aria-label={`Set how much of the ${leg.venue} ${leg.kind} leg this position holds`}
            className="rounded border border-ink-600 px-1.5 py-0.5 text-[11px] text-ink-300 hover:border-ink-400 hover:text-ink-100"
            onClick={() =>
              setDraft((d) => (d === null ? String(Number(held.toPrecision(8))) : null))
            }
          >
            {draft === null ? 'part of it…' : 'Cancel'}
          </button>
        </span>
        {/* The table row above shows this position's size; only the WHOLE the
            venue reports is missing, and only when the leg is shared. */}
        {shared && unit && (
          <span className="num text-ink-500">
            {fmtTokenQty(held, unit)} of {fmtTokenQty(total, unit)} on the venue
          </span>
        )}
      </div>
      {draft !== null && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5">
            <span className="text-ink-500">This position holds</span>
            <input
              type="number"
              min="0"
              step="any"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              aria-label={`${leg.venue} ${leg.kind} size for this position`}
              className="num w-28 rounded border border-ink-600 bg-ink-900 px-1.5 py-0.5 text-right text-ink-100"
            />
            {/* Silent rather than wrong when the venue did not say what the
                leg is margined in — the number is still the one it reported. */}
            {unit && <span className="text-ink-500">{unit}</span>}
          </label>
          <button
            type="button"
            disabled={!valid}
            className="rounded border border-cyan-500/40 bg-cyan-500/10 px-2 py-0.5 text-cyan-300 disabled:opacity-40"
            onClick={() => {
              if (!valid) return;
              onAssert({ mode: 'assign', leg: ref, to: s.strategyId, qty: parsed });
              setDraft(null);
            }}
          >
            Set size
          </button>
        </div>
      )}
    </div>
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
