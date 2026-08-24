/**
 * The home view: every position is a box of a 4-leg fixed-return position.
 *  - complete/partial/boros-only boxes come from the strategy feed (Boros legs
 *    by tracked address + Gate perp overlay, 30s poll),
 *  - perp-only and stray boxes come from the live exposure groups (4s poll),
 *  - buildBoxes guarantees every position appears in exactly one box.
 * Owns the persisted {address, since, exit flags} state and both queries;
 * the boxes themselves are prop-driven.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { qk, usePositions, useStrategy } from '../api/queries';
import type { CrossexPosition, StrategyRollup } from '../api/types';
import { EmptyState } from '../components/EmptyState';
import { Notes } from '../components/Notes';
import { QueryError } from '../components/QueryError';
import { TableSkeleton } from '../components/Skeleton';
import { fmtDateUtc, fmtUsdCompact, prettyVenue } from '../lib/fmt';
import { useTradeFlowOptional } from '../trade/TradeFlow';
import { useBookId } from './bookId';
import {
  loadOverrides,
  overrideFor,
  pruneOverrides,
  saveOverrides,
  withOverride,
  type EntryOverride,
} from './entryOverrideStore';
import { AddressForm, short, StrategyFreshness, TotalsStrip } from './HomeControls';
import { buildBoxes, rollupFromExposure } from './homeBoxes';
import { useTrackedAddress } from './trackedAddress';
import { PerpOnlyBox, type PerpOnlyCue } from './PerpOnlyBox';
import { StrategyCard } from './StrategyCard';
import {
  encodeRows,
  legRefKey,
  loadRows,
  newPositionId,
  pruneRows,
  saveRows,
  withRow,
  type MembershipRow,
} from './partitionStore';
import {
  legRefOf,
  positionVenues,
  type LegAssertion,
  type LegDestination,
} from './PartitionEditor';
import { crossexVenueFor, isUsdCollateral } from '../lib/boros';

/** Stable empty list, so a callback's deps don't change every render. */
const EMPTY_STRATEGIES: StrategyRollup[] = [];

/** One feed's last settled answer: which legs it reported, and which fetch
 * said so. The stamp is what makes a second look a second FETCH. */
interface Seen {
  at: number;
  legs: ReadonlySet<string>;
}

/**
 * Fold a feed's newest answer into what it said last time.
 *
 * `legs` is the union of the two — every leg either look reported, which is
 * what a prune is allowed to believe is gone — or null while this feed has
 * only been looked at once, which is not enough to delete anything.
 */
function confirmedLegs(
  prev: Seen | null,
  at: number,
  legs: ReadonlySet<string>,
): { seen: Seen; legs: ReadonlySet<string> | null } {
  if (prev === null) return { seen: { at, legs }, legs: null };
  // The same fetch re-read: keep the earlier pair, and keep answering with it,
  // so a re-render neither advances the count nor forgets a confirmed absence.
  if (prev.at === at) return { seen: prev, legs: null };
  return { seen: { at, legs }, legs: new Set([...prev.legs, ...legs]) };
}

/** A position, named the way its own card header names it. */
const labelFor = (s: StrategyRollup): string => {
  const { long, short } = positionVenues(s);
  const parts = [
    long ? `long ${prettyVenue(long)}` : null,
    short ? `short ${prettyVenue(short)}` : null,
  ].filter((p): p is string => p !== null);
  // A position with no legs at all cannot exist, so `parts` is empty only if
  // every leg lacks a side — fall back to the coin rather than an empty option.
  return parts.length ? parts.join(' / ') : s.base;
};

const grossUsd = (s: StrategyRollup): number =>
  s.legs.reduce((sum, l) => sum + l.notionalUsd, 0);

/**
 * Names for a set of positions, refined until no two read the same.
 *
 * Positions on one coin collide more often than they look like they should:
 * the hedged pair and the unhedged remainder of it hold the same venues, and
 * two tranches of the same pair differ only in when they were opened. Two
 * identical options are the same as no option at all, so each round of
 * ambiguity adds the next distinguishing fact — size, then start date, then
 * the id, which is unique by construction.
 */
function distinctLabels(items: readonly StrategyRollup[]): string[] {
  const details: Array<(s: StrategyRollup) => string | null> = [
    (s) => fmtUsdCompact(grossUsd(s)),
    (s) => (s.clockStartSec === null ? null : fmtDateUtc(s.clockStartSec)),
    (s) => s.strategyId,
  ];
  let labels = items.map(labelFor);
  for (const detail of details) {
    const seen = new Map<string, number>();
    for (const l of labels) seen.set(l, (seen.get(l) ?? 0) + 1);
    if ([...seen.values()].every((n) => n === 1)) break;
    labels = labels.map((l, i) => {
      if ((seen.get(l) ?? 0) < 2) return l;
      const extra = detail(items[i]);
      return extra ? `${l} · ${extra}` : l;
    });
  }
  return labels;
}

/**
 * The other cards a leg on `s` can be sent to: same coin, any shape.
 *
 * Shape is still not a filter — a card may hold one leg or six, a hedge that
 * is half-open, a spread with no perps yet. What each destination carries is
 * the Boros maturity it already holds, so the dialog can refuse the one shape
 * a solved card can never have: two maturities at once. See `LegDestination`.
 */
function destinationsFor(
  s: StrategyRollup,
  all: readonly StrategyRollup[],
): LegDestination[] {
  const others = all.filter((o) => o.strategyId !== s.strategyId && o.base === s.base);
  const labels = distinctLabels(others);
  return others.map((o, i) => {
    // The EARLIEST, because that is the one every number on that card is
    // computed against (`assembleStrategy` takes `Math.min`).
    const maturities = o.legs
      .filter((l) => l.kind === 'boros' && typeof l.maturity === 'number' && l.maturity > 0)
      .map((l) => l.maturity as number);
    return {
      id: o.strategyId,
      label: labels[i],
      borosMaturity: maturities.length ? Math.min(...maturities) : null,
    };
  });
}

/**
 * The one action an untracked card can offer: name the address holding the
 * Boros legs. Lazily reveals the form, exactly as PerpOnlyBox's add-address
 * cue does — a full input row on every card would shout, and most users have
 * one address to enter once.
 */
function AddBorosAddress({ onTrack }: { onTrack: (address: string) => void }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <>
        <button type="button" className="btn-primary !py-1 !px-3 text-sm" onClick={() => setOpen(true)}>
          Add Boros address
        </button>
        <span className="text-xs text-ink-500">
          to see whether these perps have a locked rate
        </span>
      </>
    );
  }
  return <AddressForm submitLabel="Track" onTrack={onTrack} onCancel={() => setOpen(false)} />;
}

export function PositionsHome() {
  const { address, since, capitalBasis, setAddress, setSince, openSettings } = useTrackedAddress();
  const qc = useQueryClient();
  const flow = useTradeFlowOptional();

  // Which (wallet, Gate account) pair is on screen — see bookId.ts.
  const bookId = useBookId(address);

  // What the user has said belongs where. Held here (one place owns the
  // queries) and sent to the server, which solves the rest around it.
  const [rows, setRows] = useState<MembershipRow[]>(() => loadRows(bookId));
  // Assertions belong to the book they were made on. EITHER half of that book
  // can change in place — the wallet from Settings, the Gate account from a
  // credentials swap — and this component never remounts for either, so
  // without this the previous book's rows would ride along in ?partition= and
  // be written into the new book's entry on the first edit.
  // What the user has said each card actually PAID for its share of a leg.
  // Scoped to the book for the same reason the rows are.
  const [entryRows, setEntryRows] = useState<EntryOverride[]>(() => loadOverrides(bookId));
  const [rowsFor, setRowsFor] = useState<string>(bookId);
  // WHEN this book came on screen. A credentials swap invalidates every query
  // but does not blank what they already hold, so for a beat `bookId` names
  // the new account while both feeds still answer for the old one — and
  // pruning against that would delete the new book's assertions using the old
  // book's legs. A response is only believed once it is stamped after this.
  const [bookSince, setBookSince] = useState<number>(() => Date.now());
  if (rowsFor !== bookId) {
    setRowsFor(bookId);
    setBookSince(Date.now());
    setRows(loadRows(bookId));
    setEntryRows(loadOverrides(bookId));
  }
  /**
   * Membership and asserted entries travel together.
   *
   * They are stored apart (different facts, asserted independently) but the
   * server needs both at once: an entry only means something against the claim
   * it belongs to, and conserving the venue's average requires seeing every
   * claim on a leg in one pass. Merged here, at the last possible moment.
   */
  const encodedPins = useMemo(() => {
    const byKey = new Map(entryRows.map((e) => [`${e.positionId}|${legRefKey(e.leg)}`, e.value]));
    if (!byKey.size) return encodeRows(rows);
    return encodeRows(
      rows.map((r) =>
        r.positionId === undefined
          ? r
          : (() => {
              const v = byKey.get(`${r.positionId}|${legRefKey(r.leg)}`);
              return v === undefined ? r : { ...r, entry: v };
            })(),
      ),
    );
  }, [rows, entryRows]);


  const positionsQuery = usePositions();
  const strategyQuery = useStrategy(address, since, encodedPins, capitalBasis);
  const strategies = strategyQuery.data?.strategies ?? EMPTY_STRATEGIES;

  /**
   * Ids minted for solver-proposed cards since the last server response.
   *
   * ⚠ ONE CONFIRM IS ONE CHANGE, however many facts it carries. `commit()`
   * emits an entry correction and a membership change as two `applyAssertion`
   * calls, and `freeze` decides whether a card already has an id by reading
   * `attribution.pinned` off the rollup PROP — which is still false during the
   * second call, because no response has landed in between. So the second call
   * minted a second id and wrote a second full row set, every leg ended up
   * claimed by two ids at once, and the server split the card down the middle
   * into two phantom positions with the asserted entry on one of them.
   *
   * Memoizing by the card's current strategyId makes `freeze` idempotent for
   * as long as the prop it cannot trust stays stale. Keyed on the `strategies`
   * array identity so a fresh response starts over — by then the card carries
   * its minted id as its own strategyId and takes the pinned branch anyway.
   */
  const mintedFor = useRef<{ solved: readonly StrategyRollup[]; ids: Map<string, string> }>({
    solved: EMPTY_STRATEGIES,
    ids: new Map(),
  });

  /**
   * Record where the user says one leg belongs.
   *
   * ⚠ Both ENDS of a move have to be frozen. A solver-proposed card has no
   * stable id, so the first thing said about it mints one and writes a row for
   * every leg it already had. Skip that on the destination and the leg lands
   * on a card the solver may regroup out from under it; skip it on the source
   * and the source hands its whole self back to the solver, which simply
   * proposes the same grouping again.
   */
  const applyAssertion = useCallback(
    (from: StrategyRollup, a: LegAssertion) => {
      setRows((prev) => {
        let next = prev;
        const freeze = (s: StrategyRollup): string => {
          if (s.attribution.pinned) return s.strategyId;
          if (mintedFor.current.solved !== strategies) {
            mintedFor.current = { solved: strategies, ids: new Map() };
          }
          // Same card, same tick, same id — see the note on `mintedFor`. Also
          // what makes this updater safe to run twice under StrictMode.
          const already = mintedFor.current.ids.get(s.strategyId);
          if (already !== undefined) return already;
          const id = newPositionId();
          mintedFor.current.ids.set(s.strategyId, id);
          for (const l of s.legs) {
            const ref = legRefOf(l);
            if (!ref) continue;
            next = withRow(next, {
              mode: 'assign',
              positionId: id,
              leg: ref,
              // A leg it owns outright is claimed as "all of it", so the row
              // keeps meaning the right thing if the venue size moves.
              qty: (l.share ?? 1) < 0.999 ? l.notionalToken : undefined,
            });
          }
          return id;
        };

        if (a.mode === 'assign') {
          const target = strategies.find((x) => x.strategyId === a.to) ?? from;
          // Freeze the SOURCE first when the leg is leaving it, or the rest of
          // its grouping goes back to the solver along with the leg.
          if (target.strategyId !== from.strategyId) {
            // ⚠ A move must RELEASE the leg from the source. Freezing it wrote
            // a row for every leg the source held, this one included — leaving
            // that row behind makes the leg claimed by both, which is a shared
            // leg, not a move, and the server would duly split it between them.
            const fromId = freeze(from);
            next = withRow(next, { mode: 'release', positionId: fromId, leg: a.leg });
          }
          // ⚠ Freeze BEFORE the call, never inline as an argument: `freeze`
          // reassigns `next`, and JS reads the first argument before it
          // evaluates the object literal — so an inline call silently throws
          // every frozen row away.
          const positionId = freeze(target);
          /**
           * Claiming the WHOLE venue leg displaces everyone else on it.
           *
           * Sized claims are drawn in row order and clamped to what is left, so
           * a card asking for all 0.047 of a leg whose sibling already states
           * 0.023 was handed 0.024 and a "clamped, not rescaled" note — the
           * assignment appeared to do nothing. Taking all of it is a statement
           * about the leg, not a request for whatever is spare, so the other
           * claims are released first. Sizes BELOW the whole are still a share:
           * they leave the siblings alone.
           */
          const legVenueTotal = (() => {
            const l = target.legs.find((x) => {
              const r = legRefOf(x);
              return r !== null && legRefKey(r) === legRefKey(a.leg);
            });
            const held = l?.notionalToken ?? 0;
            const sh = l?.share ?? 1;
            return sh > 0 ? held / sh : held;
          })();
          const takesWholeLeg =
            a.qty !== undefined &&
            legVenueTotal > 0 &&
            a.qty >= legVenueTotal - Math.max(1e-9, legVenueTotal * 1e-7);
          if (takesWholeLeg) {
            for (const s of strategies) {
              if (s.strategyId === target.strategyId) continue;
              if (!s.legs.some((x) => {
                const r = legRefOf(x);
                return r !== null && legRefKey(r) === legRefKey(a.leg);
              })) {
                continue;
              }
              const otherId = freeze(s);
              next = withRow(next, { mode: 'release', positionId: otherId, leg: a.leg });
            }
          }
          next = withRow(next, { mode: 'assign', positionId, leg: a.leg, qty: a.qty });
        } else if (a.mode === 'orphan') {
          // ⚠ Detach only what THIS position holds. A shared leg is on more
          // than one card, and an orphan with no size claims the whole venue
          // position — so letting go of a 0.024 share used to strip the other
          // card's 0.023 as well, a card the user never touched.
          const mine = from.legs.find((l) => {
            const r = legRefOf(l);
            return r !== null && legRefKey(r) === legRefKey(a.leg);
          });
          const share = mine?.share ?? 1;
          const fromId = freeze(from);
          next = withRow(next, { mode: 'release', positionId: fromId, leg: a.leg });
          next = withRow(next, {
            mode: 'orphan',
            leg: a.leg,
            // Whole leg → no size, so it stays orphaned if the venue grows it.
            ...(share < 0.999 ? { qty: mine?.notionalToken } : {}),
          });
        } else if (a.mode === 'closed') {
          /**
           * ⚠ ONLY A STATED SIZE CAN GO STALE, and only on the card that
           * stated it.
           *
           * A blanket claim ("all of it") is already relative — it re-derives
           * from whatever the venue still holds — and a solver-proposed card
           * is re-solved from the venue on every response. Both follow a close
           * on their own. Writing a row for either would PIN a grouping the
           * user never asserted, on their way out of the position, which is
           * the last moment to start freezing things.
           */
          const key = legRefKey(a.leg);
          const held = next.find(
            (r) =>
              r.positionId === from.strategyId && legRefKey(r.leg) === key && r.qty !== undefined,
          )?.qty;
          if (held !== undefined) {
            const left = held - a.qty;
            // Nothing left worth stating: drop the row, and this card simply
            // does not hold that leg any more. It cannot drift back — the
            // solver proposes nothing into a card that has rows of its own.
            next =
              left > Math.max(1e-9, held * 1e-6)
                ? withRow(next, {
                    mode: 'assign',
                    positionId: from.strategyId,
                    leg: a.leg,
                    qty: left,
                  })
                : withRow(next, {
                    mode: 'release',
                    positionId: from.strategyId,
                    leg: a.leg,
                  });
          }
        } else if (a.mode === 'entry') {
          // An entry says what THIS card paid, so it needs a stable id to hang
          // off — the same freeze the membership modes use. Nothing about the
          // grouping changes: `freeze` only writes down the split the solver
          // already proposed, so the card keeps its legs while the correction
          // has something durable to attach to.
          const positionId = freeze(from);
          setEntryRows((prevEntries) => {
            const nextEntries = withOverride(prevEntries, positionId, a.leg, a.value);
            saveOverrides(bookId, nextEntries, Math.floor(Date.now() / 1000));
            return nextEntries;
          });
        } else if (a.mode === 'auto') {
          /**
           * ⚠ FORGET ONLY WHAT THIS CARD SAID, never the whole leg.
           *
           * This dropped every row naming the leg. On a shared one that meant
           * pressing Automatic on the unclaimed 0.04 remainder also deleted
           * the 0.01 a pinned card held — a card the user never touched — and
           * the solver, now seeing all 0.05 free, swept it into one position.
           * The pinned card silently lost its leg. `orphan` above carries the
           * same warning; this mode simply never got it.
           *
           * Which rows are "this card's" follows from how the card exists at
           * all: a PINNED card owns rows under its own id, and an UNCLAIMED
           * card IS what an orphan row produces, so its rows carry no id. A
           * solver-proposed card asserted nothing, so it has nothing to
           * forget — Automatic is already true of it, and touching the orphan
           * rows from there would strip a neighbour's detachment instead.
           *
           * ⚠ `unclaimed`, NOT `source === 'unhedged'`. `source` answers how a
           * grouping was arrived at, which is a different question, and using
           * it here collided both ways: a solver tranche on a coin with no
           * Boros also reports `'unhedged'` (so Automatic there deleted a
           * neighbour's detachment — this exact bug, from the other side),
           * while the Boros remainder card reports `'boros-only'`/`'merged'`
           * (so Automatic there silently did nothing at all).
           */
          if (from.attribution.pinned) {
            next = withRow(next, { mode: 'auto', leg: a.leg, positionId: from.strategyId });
          } else if (from.attribution.unclaimed) {
            next = withRow(next, { mode: 'auto', leg: a.leg });
          }
        }
        saveRows(bookId, next, Math.floor(Date.now() / 1000));
        return next;
      });
    },
    [bookId, strategies],
  );
  const track = (next: string) => setAddress(next);
  const changeSince = (next: number | null) => setSince(next);

  const strategyData = strategyQuery.data;
  const positionsData = positionsQuery.data;
  const boxes = useMemo(
    () => buildBoxes(strategyData, positionsData),
    [strategyData, positionsData],
  );

  const livePositions = useMemo(() => {
    const map = new Map<string, CrossexPosition>();
    for (const p of positionsData?.positions ?? []) map.set(p.symbol, p);
    return map;
  }, [positionsData?.positions]);

  /**
   * Perp legs the book actually holds, as `legRefKey` strings.
   *
   * The POSITIONS feed is the authority, not the cards: a perp the user
   * detached never appears on one. `applyMembership` drops a detached perp
   * straight out of the pool and the derived pass reports it by subtraction —
   * so pruning perps against the cards would delete exactly the assertion that
   * made the leg invisible, handing the leg back to the solver on the next
   * poll. The cards are unioned in anyway: a leg on a card the 4s feed has not
   * caught up with yet is still open, and the union can only keep rows.
   */
  const livePerpLegs = useMemo(() => {
    const live = new Set<string>();
    for (const p of positionsData?.positions ?? []) {
      live.add(legRefKey({ kind: 'perp', symbol: p.symbol }));
    }
    for (const s of strategies) {
      for (const l of s.legs) {
        if (l.kind !== 'perp') continue;
        const ref = legRefOf(l);
        if (ref) live.add(legRefKey(ref));
      }
    }
    return live;
  }, [positionsData?.positions, strategies]);

  /**
   * Boros legs the book actually holds — from the payload's own count of live
   * positions, NEVER from the cards.
   *
   * ⚠ THE CARDS ARE NOT A CENSUS OF THE VENUE. This read them, on the
   * reasoning that every live Boros leg reaches a card: what no position
   * claimed and what the user detached both become their own unowned card.
   * That holds for the grouping passes and fails before them —
   * `buildBorosLegs` drops an entire collateral zone whose USD price cannot be
   * resolved, warns, and still answers 200. Those positions are open and on no
   * card, so the prune read them as closed and deleted the user's pins and
   * asserted entries for them: the exact irreversible loss the two-look guard
   * exists to prevent, reached by a route the guard cannot see.
   *
   * `liveBorosMarketIds` counts positions in the account's own zones and
   * nothing else, so no downstream filtering can shorten it.
   */
  const liveBorosLegs = useMemo(() => {
    const live = new Set<string>();
    for (const marketId of strategyData?.liveBorosMarketIds ?? []) {
      live.add(legRefKey({ kind: 'boros', marketId }));
    }
    // A card holding a leg the census somehow missed is still evidence that
    // leg is open. The union can only ever KEEP rows.
    for (const s of strategies) {
      for (const l of s.legs) {
        if (l.kind !== 'boros') continue;
        const ref = legRefOf(l);
        if (ref) live.add(legRefKey(ref));
      }
    }
    return live;
  }, [strategyData?.liveBorosMarketIds, strategies]);

  /**
   * What each feed reported the LAST time it settled.
   *
   * A leg has to be missing from two consecutive responses OF ITS OWN FEED
   * before its rows are deleted. Venues do answer 200 with an empty list
   * during an incident, and a single such poll would otherwise erase a whole
   * book of assertions with no undo — the user would rebuild the grouping from
   * memory, which is the failure `partitionStore` exists to prevent. Waiting
   * one more poll costs a cleanup 4s (perps) or 30s (Boros) of lateness.
   *
   * Per feed, and keyed by `dataUpdatedAt`, so neither a re-render nor the
   * perp feed's faster cadence can pass off one look as two.
   */
  const lastSeen = useRef<{ perp: Seen | null; boros: Seen | null }>({ perp: null, boros: null });

  const perpAt = positionsQuery.dataUpdatedAt;
  const borosAt = strategyQuery.dataUpdatedAt;
  // Both halves of the book have to be settled, and settled for THIS book —
  // see `bookSince`. Either one missing means we cannot tell a closed leg from
  // an unloaded one, and a prune is forever.
  const settledForBook =
    positionsQuery.isSuccess && strategyQuery.isSuccess && perpAt > bookSince && borosAt > bookSince;

  useEffect(() => {
    if (!settledForBook) {
      // A book change or a failed feed voids the first look; the next two
      // start the count again.
      lastSeen.current = { perp: null, boros: null };
      return;
    }
    const perp = confirmedLegs(lastSeen.current.perp, perpAt, livePerpLegs);
    const boros = confirmedLegs(lastSeen.current.boros, borosAt, liveBorosLegs);
    lastSeen.current = { perp: perp.seen, boros: boros.seen };
    if (perp.legs === null && boros.legs === null) return; // no feed looked again

    /**
     * ⚠ EACH KIND IS JUDGED BY ITS OWN FEED, and only while that feed has just
     * confirmed an absence. The feeds run 4s and 30s apart, so they practically
     * never advance on the same tick — requiring both would mean this never
     * ran at all. `null` is "that feed has nothing new to say", which is not
     * evidence of anything, so its rows are kept and it gets its own turn.
     */
    const nextRows = pruneRows(rows, (leg) =>
      leg.kind === 'perp'
        ? perp.legs === null || perp.legs.has(legRefKey(leg))
        : boros.legs === null || boros.legs.has(legRefKey(leg)),
    );
    // Membership first: an override outlives its leg only through its claim.
    const nextEntries = pruneOverrides(entryRows, nextRows);
    if (nextRows === rows && nextEntries === entryRows) return;
    const nowSec = Math.floor(Date.now() / 1000);
    if (nextRows !== rows) {
      saveRows(bookId, nextRows, nowSec);
      setRows(nextRows);
    }
    if (nextEntries !== entryRows) {
      saveOverrides(bookId, nextEntries, nowSec);
      setEntryRows(nextEntries);
    }
  }, [settledForBook, perpAt, borosAt, livePerpLegs, liveBorosLegs, rows, entryRows, bookId]);

  // Perp-only cue: never claim "no Boros position" unless the strategy feed
  // has actually SETTLED successfully for the tracked address.
  const perpOnlyCue: PerpOnlyCue = !address
    ? 'add-address'
    : strategyQuery.isSuccess
      ? 'execute-boros'
      : 'boros-pending';

  // Boros-only cue → prefill the pair ticket. Mapping: the perp side equals
  // the Boros side at the same venue (both cancel that venue's floating rate).
  // Sizing: the larger Boros side (identical to Σ/2 for the canonical 2-leg
  // book, and the full leg size when only one Boros leg exists so far) — or
  // the caller's explicit notional when the complete-the-hedge CTA passes the
  // per-leg top-up (the ticket must land sized to the GAP, not the whole book).
  /**
   * Arm the Boros ticket to lock the rate this position's perps are paying.
   * Sized off the perp legs, since they are what the Boros side must hedge.
   */
  /**
   * `only` narrows this to ONE leg: the missing-leg rows open exactly the leg
   * they name, at the size that row already displays. Without it the card can
   * only ask for the whole pair, which on a card that is missing one leg would
   * open a leg it already has.
   */
  const openBorosLegs =
    flow &&
    ((s: StrategyRollup, only?: { side: 'LONG' | 'SHORT'; sizeUsd: number; sizeBase?: number }) => {
      const perps = s.legs.filter((l) => l.kind === 'perp');
      const { long, short } = positionVenues(s);
      // Both readings of the same leg. The perps carry each one exactly — a
      // USD notional and a base-coin quantity — and a Boros size is one or the
      // other depending on the market's collateral, which the ticket resolves.
      // No price conversion anywhere, so neither can be wrong by an exchange
      // rate, and this works with no Boros leg present (which is when this cue
      // fires at all).
      const perSide = Math.max(...perps.map((l) => l.notionalUsd), 0);
      const perSideBase = Math.max(
        ...perps.map((l) => l.notionalToken ?? 0),
        0,
      );
      /**
       * ⚠ The maturity has to travel with the venues.
       *
       * A venue lists the same base at several expiries, so venue+base alone
       * resolves to whichever comes first. Land the two legs on DIFFERENT
       * maturities and each one filters the other out of its own dropdown —
       * both selects fall back to the placeholder and the ticket looks empty
       * and broken, while the state still holds two real market ids.
       */
      // 0 is the sentinel for "no Boros legs, so no maturity" — and that is
      // exactly the card this cue fires on. Sending it would match no market
      // at all, so it is omitted; the ticket then resolves the two legs
      // together, on the soonest maturity BOTH venues list (it used to take
      // each venue's first row independently, which armed mismatched expiries).

      const maturity = s.maturity > 0 ? s.maturity : undefined;
      if (only) {
        // Exactly one venue travels, which is what puts the ticket in Single
        // mode; the row's own target size travels with it rather than the
        // per-side figure derived from the perps.
        flow.prefillBorosOpen({
          base: s.base,
          longVenue: only.side === 'LONG' ? long : null,
          shortVenue: only.side === 'SHORT' ? short : null,
          maturity,
          size: only.sizeUsd,
          sizeBase: only.sizeBase,
        });
      } else {
        flow.prefillBorosOpen({
          base: s.base,
          longVenue: long,
          shortVenue: short,
          maturity,
          size: perSide,
          sizeBase: perSideBase > 0 ? perSideBase : undefined,
        });
      }
    });

  const openPerpLegs =
    flow &&
    ((s: StrategyRollup, notionalUsd?: number) => {
      const borosLegs = s.legs.filter((l) => l.kind === 'boros');
      const sideNotional = (side: 'LONG' | 'SHORT') =>
        borosLegs.filter((l) => l.side === side).reduce((sum, l) => sum + l.notionalUsd, 0);
      /**
       * Size the perps in whatever the BOROS side is collateralised in.
       *
       * A BTC-collateral market holds its Boros leg in BTC, so quoting the
       * perp in USDT left the user converting by eye to make the two legs
       * match — and any slip showed up later as a position this very card
       * flags as imbalanced. USD-collateral markets (HYPE) keep the USD
       * figure, which is the unit their Boros leg already uses.
       */
      const collateral = borosLegs.find((l) => l.collateral)?.collateral ?? '';
      const usdPegged = isUsdCollateral(collateral);
      // Only meaningful when the collateral IS the base coin — that is the
      // case where the Boros size and the perp quantity are the same number.
      const baseSized = !usdPegged && collateral.toUpperCase() === s.base.toUpperCase();
      const sideBase = (side: 'LONG' | 'SHORT') =>
        borosLegs
          .filter((l) => l.side === side)
          .reduce((sum, l) => sum + (l.notionalToken ?? 0), 0);
      const baseQty = Math.max(sideBase('LONG'), sideBase('SHORT'));
      const longVenue = borosLegs.find((l) => l.side === 'LONG')?.venue ?? null;
      const shortVenue = borosLegs.find((l) => l.side === 'SHORT')?.venue ?? null;
      const size = notionalUsd ?? Math.max(sideNotional('LONG'), sideNotional('SHORT'));
      // ⚠ Only when the caller did NOT name its own USD size. A row asking
      // for a partial top-up passes that figure, and the FULL base quantity
      // would silently overrule it with a bigger order than the row offered.
      const sizing =
        baseSized && baseQty > 0 && notionalUsd === undefined
          ? { sizeUnit: 'base' as const, sizeBase: baseQty }
          : {};
      /**
       * A whole-position ask opens the guided wizard AT THE HEDGE STEP; a
       * partial top-up (`notionalUsd` named by a missing-leg row) stays on the
       * bare ticket.
       *
       * The wizard's job is to say what a complete strategy is and to guard
       * the half-open state — which is exactly the position this cue fires on:
       * rate locked, no hedge. A top-up is not that. It is one leg being
       * evened up inside a position that already exists, so wrapping it in
       * "step 2 of 2" would narrate a strategy the user is not opening.
       */
      if (notionalUsd === undefined) {
        flow.openWizard({
          base: s.base,
          initialStep: 2,
          // Unused at step 2 (the Boros ticket is never mounted), but they
          // identify the wizard — the body is keyed on them, so a different
          // position is a different wizard rather than a form-swap.
          borosLongVenue: longVenue ?? '',
          borosShortVenue: shortVenue ?? '',
          maturity: s.maturity > 0 ? s.maturity : undefined,
          // ⚠ Boros keys are NOT CrossEx keys. They are identity for every
          // venue mapped today, which is exactly why omitting the translation
          // looks correct — but Lighter is live on Boros with no CrossEx
          // listing, and passing its raw key would arm a ticket for a venue
          // that cannot fill it. `crossexVenueFor` returns null there, which
          // correctly leaves the leg unselected.
          crossexLongVenue: crossexVenueFor(longVenue),
          crossexShortVenue: crossexVenueFor(shortVenue),
          notionalUsd: size,
          ...sizing,
        });
        return;
      }
      flow.prefillPair({
        base: s.base,
        longVenue,
        shortVenue,
        notionalUsd: size,
        ...sizing,
      });
    });

  /**
   * One missing perp row → one perp leg.
   *
   * The row's side is the BOROS side, and the perp at that venue takes the
   * SAME side — Boros SHORT on Hyperliquid means perp SELL there (the rule the
   * opportunities prefill already encodes). Flipping it would double the
   * exposure instead of hedging it.
   */
  const openPerpLeg =
    flow &&
    ((
      s: StrategyRollup,
      row: {
        venue: string;
        side: 'LONG' | 'SHORT';
        targetUsd: number;
        targetToken?: number;
        targetUnit?: string;
      },
    ) => {
      /**
       * ⚠ A row names a BOROS venue; the perp ticket needs a CROSSEX one.
       *
       * The two key spaces are identity for every venue mapped today, which is
       * exactly why passing the raw key looks correct — the bug only shows on
       * a Boros venue with no CrossEx listing (Lighter is live in the market
       * list right now). There, the ticket switches to Single, finds no symbol
       * for the venue, and leaves the picker blank with nothing said. Refusing
       * up front is the honest failure: the CTA is simply not offered.
       */
      const crossexVenue = crossexVenueFor(row.venue);
      if (!crossexVenue) return;
      // Size in the Boros collateral when that IS the base coin, so the two
      // legs match without an eyeballed conversion.
      const baseSized =
        row.targetUnit !== undefined &&
        row.targetToken !== undefined &&
        row.targetUnit.toUpperCase() === s.base.toUpperCase();
      flow.prefillSinglePerp({
        base: s.base,
        venue: crossexVenue,
        side: row.side === 'LONG' ? 'BUY' : 'SELL',
        notionalUsd: row.targetUsd,
        ...(baseSized ? { sizeUnit: 'base' as const, sizeBase: row.targetToken } : {}),
      });
    });

  const header = (
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
      {/* "4-leg" described the finished shape, but the list also holds books
          still being built and single orphan legs — a heading that names four
          legs over a one-leg card is telling the reader they lost three. */}
      <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-400">
        Fixed-return positions
      </h2>
      {address && (
        <span className="flex flex-wrap items-center gap-2 text-xs">
          {/* The address is edited in Settings now — the chip just jumps there. */}
          <button
            type="button"
            className="num text-ink-300 transition-colors hover:text-ink-100"
            title={`${address} — change the tracked address in Settings`}
            onClick={openSettings}
          >
            {short(address)} ✎
          </button>
          <StrategyFreshness
            dataUpdatedAt={strategyQuery.dataUpdatedAt || 0}
            staleError={strategyQuery.isError && strategyQuery.data !== undefined}
            onRefetch={() =>
              void qc.invalidateQueries({
                queryKey: qk.strategy(address, since, encodedPins, capitalBasis),
              })
            }
          />
        </span>
      )}
    </div>
  );

  // Nothing to draw boxes from yet. Also: with zero boxes we must not render
  // the definitive "No positions" claim while the strategy feed is still
  // pending — hold the skeleton until BOTH feeds have settled.
  const positionsPending = positionsQuery.isPending;
  const strategyPending = Boolean(address) && strategyQuery.isPending;
  // ⚠ Hold the skeleton while the STRATEGY feed is still pending, even with
  // boxes already in hand. The positions feed (4s) resolves long before the
  // strategy aggregate (30s, many venues), and with no rollups yet buildBoxes
  // classifies every live perp as a DEGRADED perp-only box — so the user saw
  // the old flat layout and its `Close both` flash past before the real cards
  // replaced them. The degraded path is for a feed that FAILED, not one that
  // has not answered yet.
  if (
    (positionsPending && (!address || strategyPending)) ||
    strategyPending ||
    (boxes.length === 0 && positionsPending)
  ) {
    return (
      <div>
        {header}
        <TableSkeleton rows={4} cols={6} />
      </div>
    );
  }

  const positionsFailed = positionsQuery.isError && !positionsData;
  const strategyFailed = Boolean(address) && strategyQuery.isError && !strategyQuery.data;

  return (
    <div>
      {header}
      {strategyData && <Notes items={strategyData.warnings} className="mb-2" />}
      {strategyFailed && (
        <QueryError
          title="Couldn't load Boros strategy data"
          error={strategyQuery.error}
          onRetry={() => void strategyQuery.refetch()}
          className="mb-3"
        />
      )}
      {positionsFailed && (
        <QueryError title="Couldn't load positions" error={positionsQuery.error} className="mb-3" />
      )}

      {boxes.length === 0 && !strategyFailed && !positionsFailed ? (
        !address ? (
          <EmptyState
            icon="◈"
            title="Track your 4-leg strategy"
            hint="Enter the EVM address holding your Boros legs — the terminal matches them with your Gate perp legs and shows your locked and realized return, net of all costs. Perp pairs without Boros legs show up here too."
            action={<AddressForm submitLabel="Track" onTrack={track} />}
          />
        ) : (
          <EmptyState
            icon="◎"
            title="No positions"
            hint={`No perp positions in the connected account and no Boros positions on ${short(address)} (accountId 0). Pick a pair on the Opportunities tab and open it — the guided flow locks the rate, then hedges it.`}
          />
        )
      ) : (
        <div className="flex flex-col gap-3">
          {strategyData && strategyData.strategies.length > 1 && (
            <TotalsStrip data={strategyData} />
          )}
          {boxes.map((box) =>
            box.kind === 'strategy' ? (
              <StrategyCard
                // The book is part of the identity: a card's excluded entry
                // parts are read once on mount, so a Gate swap that leaves the
                // strategyId unchanged has to remount rather than carry the
                // previous account's exclusions into this one.
                key={`s:${bookId}:${box.rollup.strategyId}`}
                bookId={bookId}
                strategy={box.rollup}
                perpSource={strategyData?.perpSource ?? null}
                since={since}
                onChangeSince={changeSince}
                livePositions={livePositions}
                onOpenPerpLegs={openPerpLegs || undefined}
                onOpenPerpLeg={openPerpLeg || undefined}
                onOpenBorosLegs={openBorosLegs || undefined}
                onAssert={(a) => applyAssertion(box.rollup, a)}
                destinations={destinationsFor(box.rollup, strategies)}
                // Only a PINNED card has a stable id to have asserted under;
                // an unpinned one has said nothing yet by definition.
                entryOverrides={
                  box.rollup.attribution.pinned
                    ? (leg) => overrideFor(entryRows, box.rollup.strategyId, leg)
                    : undefined
                }
              />
            ) : /**
             * No address tracked, and this is a real pair: render the SAME
             * card as a tracked position. A position should not change visual
             * language because of an input the user has not supplied yet — the
             * only honest difference is that we cannot speak about its Boros
             * legs, which `borosUnknown` enforces.
             *
             * The other degraded cases keep the simpler box: a stray is a
             * single leg (no pair to show), and a FAILED or pending feed is
             * not the same claim as an untracked one — there the card would
             * have to explain a backend fault, which is what PerpOnlyBox's
             * cues already do.
             */
            perpOnlyCue === 'add-address' && box.kind === 'perp-only' ? (
              <StrategyCard
                key={`untracked:${box.group.base}`}
                bookId={bookId}
                strategy={rollupFromExposure(box.group)}
                perpSource={strategyData?.perpSource ?? null}
                since={since}
                onChangeSince={changeSince}
                livePositions={livePositions}
                borosUnknown
                borosUnknownCta={<AddBorosAddress onTrack={track} />}
              />
            ) : (
              <PerpOnlyBox
                key={`${box.kind}:${box.group.base}`}
                group={box.group}
                stray={box.kind === 'stray'}
                livePositions={livePositions}
                cue={perpOnlyCue}
                address={address}
                onTrack={track}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}
