/**
 * Closing Boros legs, quoted against the book.
 *
 * Boros has no close primitive and no reduce-only flag: a close is an opposing
 * market order sized to the position, sent after cancelling anything resting
 * (see borosPair.ts's cancel-and-close). Two things follow.
 *
 * **Size and rate bound are the caller's.** `BorosClosePositionRequest` says so
 * outright — "the caller computes them from the live netted position and shows
 * them". The server clamps the size to what is actually open, because a size
 * past the position would cross flat and open a fresh one the other way.
 *
 * **The quote comes from the pair simulator, not from the mark.** The mark rate
 * and the position's mark-to-market answer "what is this leg worth right now",
 * which is not the question a close asks. `/boros/pair/simulate` walks the real
 * book at the size being closed and returns the rate it would actually execute
 * at (`execApr`), the worst the bound allows (`worstApr`), and any depth
 * shortfall — so the form shows what the close will DO rather than what the
 * position currently IS.
 *
 * Each leg is its own request: the route takes one marketId, and a partial
 * failure must leave the other leg's outcome legible.
 */
import { useMemo, useState } from 'react';
import type { BorosPairRequest, BorosSimulatedLeg, StrategyLeg } from '../api/types';
import { VenueIcon } from '../components/AssetIcon';
import { SignedNumber } from '../components/SignedNumber';
import { QueryError } from '../components/QueryError';
import { knownRate } from '../lib/boros';
import { fieldValue, fmtDateLocal, fmtPct, fmtTokenQty, fmtUsd, prettyVenue, sigGrouped } from '../lib/fmt';
import { AffixedInput, EstimateCard, EstimateRow, LegCard, SlippageLine } from './PairTicketBits';
import { FieldLabel } from './SymbolCombobox';
import {
  useBorosAgent,
  useBorosCancelAndClose,
  useBorosPairContext,
  useBorosPairSimulation,
} from '../api/queries';
import { HoldToConfirmButton } from '../components/HoldToConfirmButton';
import { useTrackedAddress } from '../panels/trackedAddress';

/** Used until the market's own deviation cap is known, or if it is degenerate. */
const FALLBACK_SLIPPAGE_PCT = 1;

/** Largest 1-significant-figure value at or below `x` (0.8208 → 0.8). */
function floorTo1Sf(x: number): number {
  if (!Number.isFinite(x) || x <= 0) return 0;
  const step = 10 ** Math.floor(Math.log10(x));
  // toPrecision trims the float noise that `Math.floor(x / step) * step`
  // leaves behind (0.4 / 0.1 is 4.000000000000001 in binary floating point).
  return Number((Math.floor(x / step) * step).toPrecision(12));
}

export function CloseBorosForm({
  legs,
  onClosed,
  onDone,
}: {
  legs: StrategyLeg[];
  /**
   * What actually came off each market, so the caller can shrink a claim that
   * states an absolute size.
   *
   * The EXACT filled size, not the requested one — unlike a perp close, this
   * route answers with the fill, so a leg that came back short shrinks the
   * claim by what it really closed. Fires for a partial too: those are the
   * ones where the number matters.
   */
  onClosed?: (leg: StrategyLeg, filled: number) => void;
  onDone?: () => void;
}) {
  const close = useBorosCancelAndClose();
  const agent = useBorosAgent();
  const { address } = useTrackedAddress();
  /**
   * Legs whose close filled everything it ASKED for, with whatever the venue
   * still holds afterwards.
   *
   * ⚠ NOT the same as the venue going flat, which is what `closed` reports.
   * A card closing its own share of a shared leg satisfies its request while
   * the leg stays open, and so does a dust residual — `closed` is
   * `shortfall === 0 && size >= openSize`, an exact comparison a size like
   * 419.49999999 fails. Keying the done panel off `closed` meant a close that
   * did exactly what was asked reported itself as unfinished: one small amber
   * line, the confirm button still armed at the same size, and "close again to
   * finish it" for a leg with nothing left to finish. The dialog answers the
   * question the user asked it, and mentions the venue residual separately.
   */
  const [done, setDone] = useState<{ marketId: number; yours: number; others: number }[]>([]);
  const [failed, setFailed] = useState<{ marketId: number; message: string }[]>([]);
  /** Filled SHORT of what was asked — the book ran out inside the rate bound.
   * `left` is what of this request is still open, never `shortfallSize`
   * dressed up: that is requested − filled, which is the same number only when
   * the request covered the whole venue position. */
  const [partial, setPartial] = useState<{ marketId: number; filled: number; left: number }[]>([]);

  const closable = useMemo(() => legs.filter((l) => l.marketId !== undefined), [legs]);
  /**
   * ⚠ ONE size, TWO legs, ONE unit — or no close at all.
   *
   * The quote prices closable[0] and closable[1]; the run loop closes EVERY
   * leg at the shared box number. A third leg would go out unquoted, and a
   * USDT-margined leg beside an ETH-margined one would be sent the same raw
   * number as two different quantities. Neither is a close the user was
   * shown, so the form refuses and points at the legs table, where each leg
   * closes on its own terms.
   */
  const collaterals = [...new Set(closable.map((l) => (l.collateral ?? '').toUpperCase()))];
  const legsBlocked = closable.length > 2 || collaterals.length > 1;
  const legsReason =
    closable.length > 2
      ? `This close spans ${closable.length} Boros legs, but one size can only be quoted and sent for two. Close them one at a time from the legs table.`
      : `These legs are sized in different collateral (${collaterals.join(', ')}), so one size cannot apply to both. Close them one at a time from the legs table.`;

  const ctx = useBorosPairContext(address);
  /**
   * Half the MARKET'S max rate deviation — the venue's own cap on how far one
   * trade may move the rate. A bound wider than the cap can never fill, and a
   * close is not hunting a rate, so half of it is the natural default.
   *
   * Per market, so a multi-leg close seeds from the tightest of them: one
   * tolerance drives the form, and the tighter cap is the binding one.
   */
  const seededSlipPct = (() => {
    const caps = closable
      .map((l) => ctx.data?.markets.find((m) => m.marketId === l.marketId)?.maxRateDeviationApr)
      .filter((v): v is number => typeof v === 'number' && v > 0);
    if (caps.length === 0) return FALLBACK_SLIPPAGE_PCT;
    const pct = (Math.min(...caps) / 2) * 100;
    // Round DOWN to one significant figure: 0.8208% ⇒ 0.8%. Down rather than
    // to-nearest so the seeded bound always stays strictly inside the venue's
    // cap — rounding up could seed a tolerance the venue will not accept.
    // Flooring a positive number to 1 s.f. cannot reach zero, but a degenerate
    // cap can, and a zero tolerance would block every close.
    const floored = floorTo1Sf(pct);
    return floored > 0 ? floored : FALLBACK_SLIPPAGE_PCT;
  })();
  const [slipEdited, setSlipEdited] = useState<string | null>(null);
  /** The tolerance popover — closed until asked for. */
  const [slipOpen, setSlipOpen] = useState(false);
  const slipStr = slipEdited ?? String(seededSlipPct);

  /**
   * Size per market. Empty means "all of it", resolved against the leg CURRENT
   * size rather than one captured when the dialog opened.
   *
   * ⚠ It used to seed the input from `notionalToken` in a lazy `useState`. That
   * ran once, but the strategy feed refreshes every 30s and a leg's size drifts
   * — so the seeded number could end up larger than the leg it came from, and
   * the form rejected its own autofilled value as exceeding the maximum. An
   * unset field cannot go stale.
   */
  /**
   * ONE size for the whole close, not one per leg.
   *
   * The request already sends `min(...)` across the legs — two boxes could
   * only ever disagree with what actually goes out — and a hedge is closed
   * as a unit: taking 500 off one leg and 300 off the other leaves a naked
   * 200 nobody asked for. The cap is the SMALLEST leg, for the same reason.
   */
  const [sizeEdited, setSizeEdited] = useState<string | null>(null);
  const maxCloseSize = closable.length
    ? Math.min(...closable.map((l) => l.notionalToken ?? 0))
    : 0;
  const shownSize = (): string => sizeEdited ?? fieldValue(maxCloseSize);

  const slipPct = Number(slipStr);
  // 10% is the quote endpoint's own cap (MAX_SLIPPAGE_APR): a bound it refuses
  // is a bound this form cannot quote, and it used to accept up to 50% — every
  // number went blank and Confirm still sent at that bound.
  const MAX_SLIP_PCT = 10;
  const slipInvalid = !Number.isFinite(slipPct) || slipPct <= 0 || slipPct > MAX_SLIP_PCT;

  const sizeOf = (l: StrategyLeg): { value: number; invalid: boolean } => {
    const raw = shownSize();
    const n = Number(raw);
    const open = l.notionalToken ?? 0;
    // A relative tolerance: the shown value is rounded to 8 significant digits,
    // so on a large leg the round-trip differs from `open` by more than any
    // fixed epsilon would allow.
    const eps = Math.max(1e-9, maxCloseSize * 1e-7);
    return {
      value: Math.min(n, open),
      invalid: raw.trim() === '' || !Number.isFinite(n) || n <= 0 || n > maxCloseSize + eps,
    };
  };
  const anySizeInvalid = closable.some((l) => sizeOf(l).invalid);

  /**
   * Quote every leg in ONE simulation.
   *
   * The simulator is a two-leg shape, so a single close names the same market
   * twice and asks for leg A only — `onlyLeg` sizes the other to zero. Closing
   * reverses the position, so each leg's direction is the opposite of the one
   * it holds.
   */
  const closeDir = (l: StrategyLeg) => (l.side === 'LONG' ? ('short' as const) : ('long' as const));
  const simReq: BorosPairRequest | null = useMemo(() => {
    if (!address || closable.length === 0 || legsBlocked || slipInvalid || anySizeInvalid) return null;
    const a = closable[0];
    const slippageApr = slipPct / 100;

    /**
     * ⚠ A single close cannot name the same market for both legs.
     *
     * `pairEligibility` rejects that outright ("same market — a leg cannot
     * offset itself"), and the route only walks the books once a pair is
     * eligible. So the duplicate-market trick returned `book: null` for BOTH
     * legs and every quote read "book unavailable / supports 0" no matter how
     * deep the book actually was. Leg B has to be a real, eligible partner —
     * any market sharing this one's collateral and maturity — and `onlyLeg`
     * then sizes it to zero so it is quoted but never traded.
     */
    const self = ctx.data?.markets.find((m) => m.marketId === a.marketId);
    const partner =
      closable[1] ??
      (self
        ? ctx.data?.markets.find(
            (m) =>
              m.marketId !== self.marketId &&
              m.tokenId === self.tokenId &&
              m.maturity === self.maturity,
          )
        : undefined);
    // No eligible partner ⇒ no quote is possible; say nothing rather than
    // report a bogus "no depth".
    if (!partner) return null;
    const b = closable[1] ?? { marketId: partner.marketId, side: a.side } as StrategyLeg;

    return {
      address,
      onlyLeg: closable.length === 1 ? 'A' : undefined,
      legA: { marketId: a.marketId as number, direction: closeDir(a), slippageApr },
      legB: { marketId: b.marketId as number, direction: closeDir(b), slippageApr },
      // One size drives the pair, so a two-leg close quotes at the smaller of
      // the two — the honest figure when the legs differ.
      size: Math.min(...closable.map((l) => sizeOf(l).value)),
      intent: 'close',
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, closable, slipStr, sizeEdited, slipInvalid, anySizeInvalid, ctx.data]);

  const sim = useBorosPairSimulation(simReq, simReq !== null);
  /** Boros refuses an order worth $10 or less, and the close cancels resting
   * orders before it prices anything — so letting it through costs those
   * orders and closes nothing. Only this blocker: the quote is a synthetic
   * pair, and its other blockers describe the zero-sized partner leg. */
  const anyBelowMin = (sim.data?.gate.blockers ?? []).some(
    (b) => b.code === 'below-min-order-value' && closable.some((l) => l.marketId === b.marketId),
  );
  const simLegFor = (i: number): BorosSimulatedLeg | null => {
    const s = sim.data?.simulation;
    if (!s) return null;
    return i === 0 ? s.legA : s.legB;
  };

  /**
   * Estimated slippage: how far each leg's execution sits from its own mid,
   * worst leg first — a bound that clears the worst leg clears them all.
   * Per leg, never summed: a close is one rate per market, not a spread.
   */
  const estSlippageApr = ((): number | null => {
    // A one-leg close quotes with a synthetic, zero-sized partner leg B
    // purely to make the pair eligible — its slippage is not this close's.
    const sim = simLegFor(0) ? (closable.length > 1 ? [simLegFor(0), simLegFor(1)] : [simLegFor(0)]) : [];
    const gaps = sim
      .map((leg) => {
        if (!leg || leg.execApr === null) return null;
        const mid = ctx.data?.markets.find((m) => m.marketId === leg.marketId)?.midApr;
        return knownRate(mid) ? Math.abs(leg.execApr - mid) : null;
      })
      .filter((n): n is number => n !== null);
    return gaps.length > 0 ? Math.max(...gaps) : null;
  })();


  const agentReady = agent.data?.configured === true && agent.data.expired === false;
  /**
   * ⚠ The legs on this form belong to the TRACKED address; the server closes
   * the account the agent key signs for. Those are the same account for a
   * user watching their own book and DIFFERENT ones for someone tracking
   * another wallet — and a close from that card would act on the agent's
   * own position, sized off the other book. Refused here (and again server
   * side, which is why the request names the address).
   */
  const agentRoot = agent.data?.configured ? agent.data.root : null;
  const addressMismatch = Boolean(agentRoot && address && agentRoot.toLowerCase() !== address.toLowerCase());
  const agentBlocked = agent.isSuccess && (!agentReady || addressMismatch);
  const agentReason = !agent.data?.configured
    ? 'No Boros wallet is connected on this install — connect one and approve an agent key before closing Boros legs.'
    : agent.data.expired
      ? 'The Boros agent approval has expired — approve a new agent key before closing Boros legs.'
      : `These legs belong to ${address} — a different account from the one your agent key signs for (${agentRoot}). Track that address to close its legs.`;

  const allDone = closable.length > 0 && done.length === closable.length;
  /**
   * What the venue still holds on legs that DID satisfy their request, split
   * by WHOSE it is.
   *
   * ⚠ Two different remainders, and reporting them as one told the user a
   * falsehood about their own money: `openSize − filled` is `(openSize −
   * myShare)`, which belongs to whoever else holds the leg, PLUS `(myShare −
   * filled)`, which is theirs and was left open on purpose. Closing 0.004 of a
   * sole-owned 0.01 announced that the remaining 0.006 was "another position's
   * share, not yours".
   */
  const residualYours = done.reduce((sum, d) => sum + d.yours, 0);
  const residualOthers = done.reduce((sum, d) => sum + d.others, 0);

  const run = async () => {
    setFailed([]);
    setPartial([]);
    if (legsBlocked) return;
    for (const l of closable) {
      const id = l.marketId as number;
      if (done.some((d) => d.marketId === id)) continue;
      const requested = sizeOf(l).value;
      // The same tolerance the depth warning uses: a book that fully covers
      // 419.5 answers 419.49999999, and calling that a shortfall reads as "no
      // depth" on a market with plenty.
      const dust = Math.max(1e-6, requested * 1e-6);
      try {
        const r = await close.mutateAsync({
          marketId: id,
          size: requested,
          slippageApr: slipPct / 100,
          ...(address ? { address } : {}),
        });
        /**
         * ⚠ A 200 is NOT a close.
         *
         * The route answers 200 for "cancelled, nothing to close" (fill null)
         * and for a fill that fell short or was rejected at the venue
         * (fill.failure). Reporting HTTP success as a closed position told the
         * user their position was gone while it was still open — the worst
         * possible lie on a trading surface. Read the outcome instead.
         */
        /**
         * The venue client stamps EVERY short fill with an
         * `insufficient-depth` failure, including one that took most of the
         * size. That is a partial, not a failure: something came off and the
         * remainder is what the second press must be armed with. Only a fill
         * that took NOTHING, or failed for another reason, is a failure.
         */
        const partialFill =
          r.fill !== null &&
          r.fill.filledSize > 0 &&
          r.fill.filledSize < requested - dust &&
          (r.fill.failure === null || r.fill.failure.code === 'insufficient-depth');
        if (r.fill?.failure && !partialFill) {
          setFailed((prev) => [...prev, { marketId: id, message: r.fill!.failure!.message }]);
        } else if (!r.fill) {
          setFailed((prev) => [
            ...prev,
            {
              marketId: id,
              message: r.cancelled
                ? 'Resting orders were cancelled, but there was no open position to close.'
                : 'Nothing was closed.',
            },
          ]);
        } else if (partialFill) {
          // SHORT of what was asked: the book ran out inside the rate bound.
          // The only outcome that leaves something for a second press — so it
          // is also the only one that re-seeds the size, below, rather than
          // leaving the original amount armed under a line saying it is done.
          const filled = r.fill!.filledSize;
          const left = requested - filled;
          setPartial((prev) => [...prev, { marketId: id, filled, left }]);
          // Re-seed the shared box with what this leg still has open. With
          // one size for both, the SMALLEST remainder is the one that can be
          // closed on both legs — arming more would re-strand the other.
          setSizeEdited((prev) => {
            const n = Number(prev ?? '');
            return Number.isFinite(n) && n > 0 ? fieldValue(Math.min(n, left)) : fieldValue(left);
          });
          onClosed?.(l, filled);
        } else {
          // Everything asked for came off. What the venue still holds splits
          // in two, and only one half is somebody else's — worth SAYING,
          // neither worth arming a second close over.
          const filled = r.fill!.filledSize;
          const mine = l.notionalToken ?? filled;
          // This card's own share that the user chose not to close.
          const yours = Math.max(0, mine - filled);
          // The rest of the venue leg, which other positions hold.
          const others = Math.max(0, (r.openSize ?? mine) - mine);
          setDone((prev) => [
            ...prev,
            { marketId: id, yours: yours > dust ? yours : 0, others: others > dust ? others : 0 },
          ]);
          onClosed?.(l, filled);
        }
      } catch (err) {
        setFailed((prev) => [
          ...prev,
          { marketId: id, message: err instanceof Error ? err.message : String(err) },
        ]);
      }
    }
  };

  if (closable.length === 0) {
    return <p className="text-[12px] text-ink-400">No Boros legs on this position.</p>;
  }

  // A close that landed says so, and stays said until dismissed — the dialog
  // closing on its own gave no confirmation that anything had happened.
  if (allDone) {
    const unit = closable[0]?.collateral ?? '';
    return (
      <div className="flex flex-col gap-3">
        <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2.5 text-[12px] leading-relaxed text-emerald-300">
          {closable.length === 1 ? 'Leg closed.' : `${closable.length} legs closed.`} The position is
          re-reading from the venue now — the card updates on its own.
        </p>
        {/* The venue leg outliving the close is normal. Said plainly and NOT
            as an amber warning: nothing went wrong. But the two halves are
            not interchangeable — one is the user's to close whenever they
            like, the other is not theirs at all. */}
        {residualYours > 0 && (
          <p className="text-[11px] leading-relaxed text-ink-400">
            {`${sigGrouped(residualYours)} ${unit}`} of this position is still open — you closed part of
            it. Close the rest whenever you like.
          </p>
        )}
        {residualOthers > 0 && (
          <p className="text-[11px] leading-relaxed text-ink-400">
            {`${sigGrouped(residualOthers)} ${unit}`} more is open on the venue — that is another
            position's share of the same leg, not yours.
          </p>
        )}
        <button type="button" className="btn-primary w-full" onClick={onDone}>
          Done
        </button>
      </div>
    );
  }

  const unit0 = closable[0]?.collateral ?? '';
  const px = sim.data?.simulation.collateralPriceUsd;
  const inUsd = px != null && px > 0;
  /** A collateral figure, in dollars when the quote carries a price. */
  const money = (n: number) =>
    inUsd ? <SignedNumber value={n * (px as number)} format={(v) => fmtUsd(v)} /> : <SignedNumber value={n} format={(v) => fmtTokenQty(v, unit0)} />;
  const nowSec = Date.now() / 1000;
  const legFacts = closable.map((l, i) => {
    const q = simLegFor(i);
    const { value, invalid } = sizeOf(l);
    // PnL at the rate the book would actually give, over the leg's life:
    // (locked − exec) × size × years, signed by the side being closed.
    const years = l.maturity ? Math.max(0, l.maturity - nowSec) / 31_536_000 : null;
    const estPnl =
      q?.execApr != null && l.entryApr !== undefined && years !== null
        ? (l.side === 'LONG' ? q.execApr - l.entryApr : l.entryApr - q.execApr) * value * years
        : null;
    return { l, q, value, invalid, estPnl };
  });
  const totalPnl = legFacts.some((f) => f.estPnl !== null)
    ? legFacts.reduce((s, f) => s + (f.estPnl ?? 0), 0)
    : null;
  const sizeShown = Number(shownSize());
  const flatAfter = Number.isFinite(sizeShown) && sizeShown >= maxCloseSize - Math.max(1e-9, maxCloseSize * 1e-7);

  return (
    <div className="flex flex-col gap-4">
      {agentBlocked && (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] leading-relaxed text-amber-300/90">
          {agentReason}
        </p>
      )}
      {legsBlocked && (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] leading-relaxed text-amber-300/90">
          {legsReason}
        </p>
      )}

      {/* What is held, leg by leg: the market, its size, the rate it locked
          and where the mark is now. */}
      <div className="flex flex-col gap-1.5">
        {closable.map((l) => {
          const days = l.maturity ? Math.max(0, Math.round((l.maturity - nowSec) / 86_400)) : null;
          return (
            <LegCard
              key={l.marketId}
              kind="Boros"
              venue={prettyVenue(l.venue)}
              side={l.side}
              sub={`${l.base}${l.maturity ? ` · ${fmtDateLocal(l.maturity)}` : ''}${days !== null ? ` · ${days}d` : ''}`}
              value={`${sigGrouped(l.notionalToken ?? 0)} ${l.collateral ?? ''}`}
              valueSub={
                l.entryApr !== undefined || knownRate(l.markApr) ? (
                  <>
                    {l.entryApr !== undefined ? `locked ${fmtPct(l.entryApr)}` : ''}
                    {l.entryApr !== undefined && knownRate(l.markApr) ? ' · ' : ''}
                    {knownRate(l.markApr) ? `mark ${fmtPct(l.markApr)}` : ''}
                  </>
                ) : undefined
              }
            />
          );
        })}
      </div>

      {/* One size for the close, applied to both legs: they are one hedge,
          and the request already sends the smaller of the two. Capped at the
          smallest leg — past that the bigger leg would be left naked. */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-3">
          <FieldLabel htmlFor="boros-close-size">{closable.length > 1 ? 'Close size · both legs' : 'Close size'}</FieldLabel>
          {/* The ceiling, stated where the number is typed — and clickable.
              It was only discoverable by overshooting and reading an error. */}
          <button
            type="button"
            className="num text-[11px] text-ink-400 transition-colors hover:text-ink-100"
            title={closable.length > 1 ? 'Close the whole position on both legs' : 'Close the whole position'}
            onClick={() => setSizeEdited(fieldValue(maxCloseSize))}
          >
            max{' '}
            <span className="text-link underline decoration-link/40 underline-offset-2">
              {`${sigGrouped(maxCloseSize)} ${unit0}`}
            </span>
          </button>
        </div>
        <AffixedInput affix={unit0 ? <span>{unit0}</span> : null}>
          <input
            id="boros-close-size"
            className={`input num pr-16 ${anySizeInvalid ? '!border-rose-500/60' : ''}`}
            inputMode="decimal"
            value={shownSize()}
            onChange={(e) => setSizeEdited(e.target.value)}
            aria-label="Close size, applied to both legs"
          />
        </AffixedInput>
        {anySizeInvalid ? (
          <span className="text-[11px] text-rose-300">
            size must be above 0 and at most {sigGrouped(maxCloseSize)} {unit0}
          </span>
        ) : (
          <span className="text-[11px] text-ink-400">
            {flatAfter ? (
              closable.length > 1 ? (
                <>
                  whole pair · <span className="text-ink-200">flat after</span> on both markets
                </>
              ) : (
                <>
                  whole position · <span className="text-ink-200">flat after</span>
                </>
              )
            ) : (
              'partial close'
            )}
            {closable.length === 1 && (
              <>
                {' · '}
                <span title="The size is capped at what is open, so it can never cross past flat.">
                  capped at open size
                </span>
              </>
            )}
          </span>
        )}
      </div>

      {sim.isError && <QueryError title="Couldn’t quote this close" error={sim.error} onRetry={() => sim.refetch()} />}
      <EstimateCard
        dataUpdatedAt={sim.dataUpdatedAt}
        estimating={sim.isPlaceholderData || (sim.isFetching && !sim.data)}
        isError={sim.isError}
      >
        {/* The PnL this close realises — (locked − execution rate) × size ×
            time to maturity, before the fee — summed over the legs. */}
        <div className="flex items-end justify-between gap-3">
          <div className="flex flex-col">
            <span className="text-[12.5px] text-ink-50">Est. PnL</span>
            <span className="text-[11px] text-ink-400">before fee</span>
          </div>
          <span className="num text-lg font-semibold">
            {totalPnl !== null ? money(totalPnl) : <span className="text-ink-500">—</span>}
          </span>
        </div>
        {/* Per-leg simulation. One leg: plain rows. Two legs: a table, one
            row per market, with any per-leg notice under it. */}
        {(() => {
          const noticeFor = (f: (typeof legFacts)[number]) => {
            const id = f.l.marketId as number;
            const unit = f.l.collateral ?? '';
            /** Read off the quote, not recomputed: the gate owns the threshold,
             * the collateral price and the flatten exemption. Matched on
             * marketId — the quote is a pair, and its other blockers are about
             * the partner leg. */
            const belowMin = sim.data?.gate.blockers.find(
              (b) => b.code === 'below-min-order-value' && b.marketId === id,
            );
            const err = failed.find((x) => x.marketId === id);
            const part = partial.find((x) => x.marketId === id);
            const finished = done.find((d) => d.marketId === id);
            const q = f.q;
            const prefix = closable.length > 1 ? `${prettyVenue(f.l.venue)}: ` : '';
            return (
              <>
                {finished && (
                  <span className="text-[11px] text-ink-400">
                    {prefix}This leg is closed; it will not be sent again.
                    {finished.yours > 0 && ` ${sigGrouped(finished.yours)} ${unit} of it is still open — you closed part.`}
                  </span>
                )}
                {/* The server's own words — a copy here could disagree at the boundary. */}
                {!finished && belowMin && <span className="text-[11px] text-rose-400">{prefix}{belowMin.message}</span>}
                {/* A dust residual is not a shortfall: the walk returns sizes
                    like 419.49999999 for a book that fully covers 419.5, and
                    warning on that reads as "no depth" on a market that has
                    plenty. */}
                {!finished && q && q.shortfallSize > Math.max(1e-6, f.value * 1e-6) && (
                  <span className="text-[11px] text-amber-400/90">
                    {prefix}the book only supports {sigGrouped(q.estFillSize)} {unit} of this size — it
                    will fill short
                  </span>
                )}
                {!finished && q && q.bookStatus === 'unavailable' && (
                  <span className="text-[11px] text-amber-400/90">
                    {prefix}order book unavailable — no rate can be quoted for this leg
                  </span>
                )}
                {part && (
                  <span className="text-[11px] text-amber-400/90">
                    {prefix}filled {sigGrouped(part.filled)} {unit} — {sigGrouped(part.left)} {unit} of what
                    you asked for is still open. The size above is set to what is left; close again
                    to finish it.
                  </span>
                )}
                {err && <span className="text-[11px] text-rose-400">{prefix}{err.message}</span>}
              </>
            );
          };
          const rateOf = (q: BorosSimulatedLeg | null) =>
            q?.execApr != null ? fmtPct(q.execApr) : sim.isFetching ? 'quoting…' : '—';
          const feeOf = (q: BorosSimulatedLeg | null, unit: string) =>
            q?.takerFeeCost !== undefined ? (
              <span className="text-guava">
                −{inUsd ? fmtUsd(q.takerFeeCost * (px as number)) : fmtTokenQty(q.takerFeeCost, unit)}
              </span>
            ) : (
              '—'
            );
          if (closable.length === 1) {
            const f = legFacts[0];
            return (
              <div className="flex flex-col gap-1.5 border-t border-ink-800/80 pt-2">
                <EstimateRow
                  label="Est. rate"
                  title="Market order after cancelling any resting orders on this market"
                  value={rateOf(f.q)}
                />
                {/* The taker fee THIS order pays, from the simulation: rate ×
                    size × years to maturity. Settlement fees are not here —
                    a close ends the settlements that would have paid them. */}
                <EstimateRow
                  label="Est. fee"
                  title="Boros taker fee on this order: rate × size × time to maturity"
                  value={feeOf(f.q, f.l.collateral ?? '')}
                />
                {noticeFor(f)}
              </div>
            );
          }
          return (
            <div className="flex flex-col gap-1">
              <table className="w-full">
                <thead>
                  <tr className="text-[12px] font-normal text-ink-300">
                    <th className="pb-1 text-left font-medium">leg</th>
                    <th className="pb-1 text-right font-medium">est rate</th>
                    <th className="pb-1 text-right font-medium">pnl</th>
                    <th className="pb-1 text-right font-medium">est fee</th>
                  </tr>
                </thead>
                <tbody>
                  {legFacts.map((f) => {
                    const id = f.l.marketId as number;
                    const finished = done.find((d) => d.marketId === id);
                    return (
                      <tr key={id} className="border-t border-ink-800/80">
                        <td className="py-1.5 text-[12px] text-ink-50">
                          <span className="inline-flex items-center gap-1.5">
                            <VenueIcon venue={f.l.venue} size={14} />
                            {prettyVenue(f.l.venue)}
                          </span>
                          {finished && <span className="ml-1.5 text-[11px] text-emerald-300">closed ✓</span>}
                        </td>
                        <td className="num py-1.5 text-right text-[12.5px] text-ink-50">{rateOf(f.q)}</td>
                        <td className="num py-1.5 text-right text-[12px]">
                          {f.estPnl !== null ? money(f.estPnl) : <span className="text-ink-500">—</span>}
                        </td>
                        <td className="num py-1.5 text-right text-[12px] text-ink-50">{feeOf(f.q, f.l.collateral ?? '')}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {legFacts.map((f) => (
                <span key={f.l.marketId} className="contents">
                  {noticeFor(f)}
                </span>
              ))}
            </div>
          );
        })()}

        {/* Same shape as the Boros ticket: the bound is stated inline and only
            becomes editable when asked for. A close differs in that the bound
            applies to EACH leg being closed — there is no spread here, just one
            rate per market — so it is never summed. */}
        <div className="border-t border-ink-800/80 pt-2">
          <SlippageLine
            est={estSlippageApr !== null ? fmtPct(estSlippageApr) : null}
            max={`${slipStr}%`}
            unit="APR"
            open={slipOpen}
            onToggle={() => setSlipOpen((v) => !v)}
            value={slipStr}
            onChange={setSlipEdited}
            invalid={slipInvalid}
            invalidText={`slippage must be in (0, ${MAX_SLIP_PCT}]`}
            inputAriaLabel="Close slippage tolerance, APR percent"
            title="The worst APR this close accepts, per leg. A close that misses it leaves the position open."
            hint="Max rate this close will accept. A wider tolerance may be needed for a large size or a thin book."
          />
        </div>
      </EstimateCard>

      <div className="flex flex-col gap-1.5">
        <HoldToConfirmButton
          tone="red"
          // No quote, no close: a hold with the numbers blank sends a bound
          // nothing on screen describes.
          disabled={close.isPending || slipInvalid || anySizeInvalid || agentBlocked || legsBlocked || sim.isError || (simReq !== null && !sim.data) || anyBelowMin}
          onConfirm={run}
          className="w-full"
        >
          {close.isPending
            ? 'Closing…'
            : `Close ${closable.length === 1 ? 'leg' : `${closable.length} legs`} ▸`}
        </HoldToConfirmButton>
        <p className="text-[11px] leading-relaxed text-ink-400">
          {closable.length === 1
            ? 'Cancels any resting orders on this market first, then sends one market order. The perp leg stays open.'
            : `Cancels resting orders on both markets, then ${closable.length === 2 ? 'two' : closable.length} market orders. Size is capped at what is open once the cancel lands.`}
        </p>
      </div>
    </div>
  );
}
