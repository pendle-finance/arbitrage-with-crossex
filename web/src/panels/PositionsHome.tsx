/**
 * The home view: every position is a box of a 4-leg fixed-return position.
 *  - complete/partial/boros-only boxes come from the strategy feed (Boros legs
 *    by tracked address + Gate perp overlay, 30s poll),
 *  - perp-only and stray boxes come from the live exposure groups (4s poll),
 *  - buildBoxes guarantees every position appears in exactly one box.
 * Owns the persisted {address, since, exit flags} state and both queries;
 * the boxes themselves are prop-driven.
 */
import { useCallback, useMemo, useState } from 'react';
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
  saveOverrides,
  withOverride,
  type EntryOverride,
} from './entryOverrideStore';
import { AddressForm, short, StrategyFreshness, TotalsStrip } from './HomeControls';
import { buildBoxes } from './homeBoxes';
import { useTrackedAddress } from './trackedAddress';
import { PerpOnlyBox, type PerpOnlyCue } from './PerpOnlyBox';
import { StrategyCard } from './StrategyCard';
import {
  encodeRows,
  legRefKey,
  loadRows,
  newPositionId,
  saveRows,
  withRow,
  type MembershipRow,
  type RowChange,
} from './partitionStore';
import { legRefOf, positionVenues, type LegAssertion } from './PartitionEditor';
import { crossexVenueFor } from '../lib/boros';

/** Stable empty list, so a callback's deps don't change every render. */
const EMPTY_STRATEGIES: StrategyRollup[] = [];

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

/** The other cards a leg on `s` can be sent to: same coin, any shape. */
function destinationsFor(
  s: StrategyRollup,
  all: readonly StrategyRollup[],
): Array<{ id: string; label: string }> {
  const others = all.filter((o) => o.strategyId !== s.strategyId && o.base === s.base);
  const labels = distinctLabels(others);
  return others.map((o, i) => ({ id: o.strategyId, label: labels[i] }));
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
  if (rowsFor !== bookId) {
    setRowsFor(bookId);
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
          const id = newPositionId();
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
        } else {
          const change: RowChange = { mode: a.mode, leg: a.leg };
          next = withRow(next, change);
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
      // at all, so it is omitted and the resolver falls back to venue+base.
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
      const usdPegged = collateral === 'USDT' || collateral === 'USDC';
      // Only meaningful when the collateral IS the base coin — that is the
      // case where the Boros size and the perp quantity are the same number.
      const baseSized = !usdPegged && collateral.toUpperCase() === s.base.toUpperCase();
      const sideBase = (side: 'LONG' | 'SHORT') =>
        borosLegs
          .filter((l) => l.side === side)
          .reduce((sum, l) => sum + (l.notionalToken ?? 0), 0);
      const baseQty = Math.max(sideBase('LONG'), sideBase('SHORT'));
      flow.prefillPair({
        base: s.base,
        longVenue: borosLegs.find((l) => l.side === 'LONG')?.venue ?? null,
        shortVenue: borosLegs.find((l) => l.side === 'SHORT')?.venue ?? null,
        notionalUsd: notionalUsd ?? Math.max(sideNotional('LONG'), sideNotional('SHORT')),
        // ⚠ Only when the caller did NOT name its own USD size. A row asking
        // for a partial top-up passes that figure, and the FULL base quantity
        // would silently overrule it with a bigger order than the row offered.
        ...(baseSized && baseQty > 0 && notionalUsd === undefined
          ? { sizeUnit: 'base' as const, sizeBase: baseQty }
          : {}),
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
            hint={`No perp positions in the connected account and no Boros positions on ${short(address)} (accountId 0). Open a delta-neutral pair from the order ticket to start a 4-leg position.`}
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
