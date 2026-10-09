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
 */
import { Check, ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { BorosLegFill, BorosPairRequest, BorosSimulatedLeg, StrategyLeg } from '../api/types';
import { SpreadIcon, VenueIcon } from '../components/AssetIcon';
import { SignedNumber } from '../components/SignedNumber';
import { QueryError } from '../components/QueryError';
import { daysToMaturity, knownRate } from '../lib/boros';
import { spreadLabel } from '../lib/spread';
import { fieldValue, fmtDateLocal, fmtPct, fmtTokenQty, fmtUsd, prettyVenue, sigGrouped } from '../lib/fmt';
import { AffixedInput, EstimateCard, EstimateRow, LegCard, SlippageLine } from './PairTicketBits';
import { FieldLabel } from './SymbolCombobox';
import {
  useBorosAgent,
  useBorosCancelAndClose,
  useBorosPairContext,
  useBorosPairSimulation,
  useExecuteBorosPair,
} from '../api/queries';
import { HoldToConfirmButton } from '../components/HoldToConfirmButton';
import { uuid } from '../lib/uuid';
import { useActiveWallet } from '../panels/trackedAddress';
import { BorosLogInButton } from './BorosAgentSetup';

const newOrderIds = (count: number): string[] => Array.from({ length: count }, (_, i) => `${i}-${uuid()}`);

const WEI_DIGITS = 18;

function toWei(n: number): bigint {
  const [mantissa, exponent = '0'] = String(n).split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  const shift = WEI_DIGITS + Number(exponent) - fraction.length;
  const digits = BigInt(whole + fraction);
  return shift >= 0 ? digits * 10n ** BigInt(shift) : digits / 10n ** BigInt(-shift);
}

function fromWei(wei: bigint): number {
  const digits = wei.toString().padStart(WEI_DIGITS + 1, '0');
  return Number(`${digits.slice(0, -WEI_DIGITS)}.${digits.slice(-WEI_DIGITS)}`);
}

const ROUND_TRIP_DIGITS = 15;

function sizeAtOrBelow(wei: bigint): number {
  const drop = wei.toString().length - ROUND_TRIP_DIGITS;
  if (drop <= 0) return fromWei(wei);
  const unit = 10n ** BigInt(drop);
  return fromWei((wei / unit) * unit);
}

type CloseLeg = StrategyLeg & { spreadVenues?: [string, string] | null };

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
  legs: CloseLeg[];
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
  const execute = useExecuteBorosPair();
  const busy = close.isPending || execute.isPending;
  const agent = useBorosAgent();
  const { address, canTrade, loginLabel } = useActiveWallet();
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
  /** A refusal of the two-leg batch as a whole — one reason, said once. */
  const [batchError, setBatchError] = useState<string | null>(null);
  const [rest, setRest] = useState<{ marketId: number; wei: bigint }[] | null>(null);

  const closable = useMemo(() => legs.filter((l) => l.marketId !== undefined), [legs]);
  const pending = useMemo(() => closable.filter((l) => !done.some((d) => d.marketId === l.marketId)), [closable, done]);
  const collaterals = [...new Set(closable.map((l) => (l.collateral ?? '').toUpperCase()))];
  const legsBlocked = collaterals.length > 1;
  const legsReason = `These legs are sized in different collateral (${collaterals.join(', ')}), so one size cannot apply to ${closable.length > 2 ? 'all of them' : 'both'}. Close them one at a time from the legs table.`;

  const ctx = useBorosPairContext(address);
  const rowOf = (marketId: number | undefined) =>
    ctx.data?.markets.find((m) => m.marketId === marketId) ??
    ctx.data?.spreadMarkets?.find((m) => m.marketId === marketId);
  const spreadOf = (l: CloseLeg) => l.spreadVenues ?? rowOf(l.marketId)?.spreadVenues ?? null;
  const venueLabel = (l: CloseLeg): string => {
    const venues = spreadOf(l);
    return venues ? spreadLabel(venues) : prettyVenue(l.venue);
  };
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
      .map((l) => rowOf(l.marketId)?.maxRateDeviationApr)
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

  const [sizeEdited, setSizeEdited] = useState<string | null>(null);
  const heldWei = (l: CloseLeg): bigint =>
    rest?.find((r) => r.marketId === l.marketId)?.wei ?? toWei(l.notionalToken ?? 0);
  const heldOf = (l: CloseLeg): number => fromWei(heldWei(l));
  const wholeOf = (l: CloseLeg): number => {
    const held = heldOf(l);
    const open = Math.abs(rowOf(l.marketId)?.currentSize ?? 0);
    return open > held && open - held <= open * 1e-12 ? open : held;
  };
  const maxCloseWei = (() => {
    const byVenue = new Map<string, bigint>();
    const add = (venue: string, wei: bigint) => byVenue.set(venue, (byVenue.get(venue) ?? 0n) + wei);
    for (const l of pending) {
      const wei = heldWei(l);
      const signed = l.side === 'LONG' ? wei : -wei;
      const venues = spreadOf(l);
      add(venues?.[0] ?? l.venue, signed);
      if (venues) add(venues[1], -signed);
    }
    const sizes = [...pending.map(heldWei), ...[...byVenue.values()].map((w) => (w < 0n ? -w : w))];
    return sizes.reduce((max, w) => (w > max ? w : max), 0n);
  })();
  const maxCloseSize = fromWei(maxCloseWei);
  const shownSize = (): string => sizeEdited ?? fieldValue(maxCloseSize);

  const slipPct = Number(slipStr);
  // 10% is the quote endpoint's own cap (MAX_SLIPPAGE_APR): a bound it refuses
  // is a bound this form cannot quote, and it used to accept up to 50% — every
  // number went blank and Confirm still sent at that bound.
  const MAX_SLIP_PCT = 10;
  const slipInvalid = !Number.isFinite(slipPct) || slipPct <= 0 || slipPct > MAX_SLIP_PCT;

  const typedSize = Number(shownSize());
  const closesAll = Number.isFinite(typedSize) && typedSize >= maxCloseSize - Math.max(1e-9, maxCloseSize * 1e-7);
  const typedWei = Number.isFinite(typedSize) && typedSize > 0 ? toWei(typedSize) : 0n;
  const sizeOf = (l: CloseLeg): number => {
    if (closesAll) return wholeOf(l);
    if (maxCloseWei === 0n) return 0;
    return sizeAtOrBelow((heldWei(l) * typedWei) / maxCloseWei);
  };
  const anySizeInvalid =
    shownSize().trim() === '' ||
    !Number.isFinite(typedSize) ||
    typedSize <= 0 ||
    typedSize > maxCloseSize + Math.max(1e-9, maxCloseSize * 1e-7) ||
    pending.some((l) => !(sizeOf(l) > 0));

  const closeDir = (l: StrategyLeg) => (l.side === 'LONG' ? ('short' as const) : ('long' as const));
  const closeReq: BorosPairRequest | null = useMemo(() => {
    if (!address || pending.length === 0 || legsBlocked || slipInvalid || anySizeInvalid) return null;
    const slippageApr = slipPct / 100;
    return {
      address,
      legs: pending.map((l) => ({
        marketId: l.marketId as number,
        direction: closeDir(l),
        slippageApr,
        size: sizeOf(l),
      })),
      intent: 'close',
      // A close IS the reduction the gate asks to have acknowledged.
      opposingAcknowledged: true,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, pending, rest, slipStr, sizeEdited, slipInvalid, anySizeInvalid, ctx.data]);
  const simReq = closeReq && pending.every((l) => rowOf(l.marketId)) ? closeReq : null;

  const sim = useBorosPairSimulation(simReq, simReq !== null);
  // A replay key belongs to ONE intent: a different size or tolerance is a
  // different order and must not be answered with the previous one's fills.
  const [orderIds, setOrderIds] = useState(() => newOrderIds(closable.length));
  useEffect(() => {
    setOrderIds(newOrderIds(closable.length));
  }, [slipStr, sizeEdited, rest, closable.length]);
  const atomic = closable.length > 1;
  /** Boros refuses an order worth $10 or less, and the close cancels resting
   * orders before it prices anything — so letting it through costs those
   * orders and closes nothing. */
  const belowMinFor = (b: { code: string; marketId?: number }) =>
    b.code === 'below-min-order-value' && closable.some((l) => l.marketId === b.marketId);
  const gateBlockers = sim.data?.gate.blockers ?? [];
  const anyBelowMin = gateBlockers.some(belowMinFor);
  /** What stops the two-leg batch, beyond a leg under the venue minimum
   * (which is said on its own leg). The server refuses on the same list. */
  const batchBlockers = atomic ? gateBlockers.filter((b) => !belowMinFor(b)) : [];
  const simLegFor = (l: StrategyLeg): BorosSimulatedLeg | null =>
    sim.data?.simulation.legs?.find((q) => q.marketId === l.marketId) ?? null;

  /**
   * Estimated slippage: how far each leg's execution sits from its own mid,
   * worst leg first — a bound that clears the worst leg clears them all.
   * Per leg, never summed: a close is one rate per market, not a spread.
   * The quote's own figure, off the mid the bound is anchored to — not a
   * second reading against the context's mid, which polls on its own clock.
   */
  const estSlippageApr = ((): number | null => {
    const gaps = closable
      .map(simLegFor)
      .map((leg) => leg?.estSlippageApr ?? null)
      .filter((n): n is number => n !== null)
      // A fill better than mid is no slippage, not a negative one.
      .map((n) => Math.max(0, n));
    return gaps.length > 0 ? Math.max(...gaps) : null;
  })();
  const unquoted = simReq === null && !ctx.isLoading && !legsBlocked && !slipInvalid && !anySizeInvalid;


  const agentBlocked = agent.isSuccess && !canTrade;
  const agentReason = 'This build cannot close Boros legs. Close them in the Boros app.';

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

  /**
   * One leg's venue answer, folded into the form's outcomes.
   *
   * ⚠ A 200 is NOT a close.
   *
   * Both routes answer 200 for "nothing to close" (no fill) and for a fill
   * that fell short or was rejected at the venue (fill.failure). Reporting
   * HTTP success as a closed position told the user their position was gone
   * while it was still open — the worst possible lie on a trading surface.
   * Read the outcome instead.
   */
  const settle = (
    l: CloseLeg,
    requested: number,
    fill: BorosLegFill | null,
    /** What the venue held when the close was sized, when the route says. */
    openSize: number | undefined,
    nothingClosed: string,
  ): { marketId: number; wei: bigint; partial: boolean } | null => {
    const id = l.marketId as number;
    // The same tolerance the depth warning uses: a book that fully covers
    // 419.5 answers 419.49999999, and calling that a shortfall reads as "no
    // depth" on a market with plenty.
    const dust = Math.max(1e-6, requested * 1e-6);
    /**
     * The venue client stamps EVERY short fill with an `insufficient-depth`
     * failure, including one that took most of the size. That is a partial,
     * not a failure: something came off and the remainder is what the second
     * press must be armed with. Only a fill that took NOTHING, or failed for
     * another reason, is a failure.
     */
    const partialFill =
      fill !== null &&
      fill.filledSize > 0 &&
      fill.filledSize < requested - dust &&
      (fill.failure === null || fill.failure.code === 'insufficient-depth');
    if (fill?.failure && !partialFill) {
      setFailed((prev) => [...prev, { marketId: id, message: fill.failure!.message }]);
    } else if (!fill) {
      setFailed((prev) => [...prev, { marketId: id, message: nothingClosed }]);
    } else if (partialFill) {
      // SHORT of what was asked: the book ran out inside the rate bound.
      // The only outcome that leaves something for a second press — so it
      // is also the only one that re-seeds the size, below, rather than
      // leaving the original amount armed under a line saying it is done.
      const filled = fill.filledSize;
      const leftWei = toWei(requested) - toWei(filled);
      setPartial((prev) => [...prev, { marketId: id, filled, left: fromWei(leftWei) }]);
      onClosed?.(l, filled);
      return { marketId: id, wei: leftWei, partial: true };
    } else {
      // Everything asked for came off. What the venue still holds splits
      // in two, and only one half is somebody else's — worth SAYING,
      // neither worth arming a second close over.
      const filled = fill.filledSize;
      const mine = l.notionalToken === undefined ? filled : heldOf(l);
      // This card's own share that the user chose not to close.
      const yours = Math.max(0, mine - filled);
      // The rest of the venue leg, which other positions hold.
      const others = Math.max(0, (openSize ?? mine) - mine);
      setDone((prev) => [
        ...prev,
        { marketId: id, yours: yours > dust ? yours : 0, others: others > dust ? others : 0 },
      ]);
      onClosed?.(l, filled);
      return null;
    }
    return { marketId: id, wei: toWei(requested), partial: false };
  };

  const rearm = (outcomes: ({ marketId: number; wei: bigint; partial: boolean } | null)[]) => {
    const left = outcomes.filter((o) => o !== null);
    if (!left.some((o) => o.partial)) return;
    setRest(left.map(({ marketId, wei }) => ({ marketId, wei })));
    setSizeEdited(null);
  };

  const run = async () => {
    setFailed([]);
    setPartial([]);
    setBatchError(null);
    if (legsBlocked) return;

    if (atomic && closeReq) {
      try {
        const res = await execute.mutateAsync({
          ...closeReq,
          legs: closeReq.legs.map((leg, i) => ({ ...leg, clientOrderId: orderIds[closable.indexOf(pending[i])] })),
        });
        const fills = res.result.legs;
        const reason = fills[0]?.failure?.message;
        const refused = reason !== undefined && fills.every((f) => f.filledSize === 0 && f.failure?.message === reason);
        if (refused) {
          setBatchError(reason);
        } else {
          rearm(
            pending.map((l, i) => {
              const f = fills.find((x) => x.marketId === l.marketId) ?? null;
              const sent = f === null || (f.filledSize === 0 && f.shortfallSize === 0 && f.failure === null) ? null : f;
              const open = rowOf(l.marketId)?.currentSize;
              return settle(l, closeReq.legs[i].size, sent, open === undefined ? undefined : Math.abs(open), 'There was no open position to close.');
            }),
          );
        }
        // An outcome the venue never confirmed keeps its ids: a second hold
        // is answered from the server's memo instead of closing twice.
        if (!fills.some((f) => f.failure?.code === 'unknown')) setOrderIds(newOrderIds(closable.length));
      } catch (err) {
        setBatchError(err instanceof Error ? err.message : String(err));
      }
      return;
    }

    for (const l of pending) {
      const id = l.marketId as number;
      const requested = sizeOf(l);
      try {
        const r = await close.mutateAsync({
          marketId: id,
          size: requested,
          slippageApr: slipPct / 100,
          ...(address ? { address } : {}),
        });
        rearm([
          settle(
            l,
            requested,
            r.fill,
            r.openSize,
            r.cancelled
              ? 'Resting orders were cancelled, but there was no open position to close.'
              : 'Nothing was closed.',
          ),
        ]);
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
  const legFacts = closable.map((l) => {
    const q = simLegFor(l);
    const value = sizeOf(l);
    // PnL at the rate the book would actually give, over the leg's life:
    // (locked − exec) × size × years, signed by the side being closed.
    const years = l.maturity ? Math.max(0, l.maturity - nowSec) / 31_536_000 : null;
    const estPnl =
      q?.execApr != null && l.entryApr !== undefined && years !== null
        ? (l.side === 'LONG' ? q.execApr - l.entryApr : l.entryApr - q.execApr) * value * years
        : null;
    return { l, q, value, estPnl };
  });
  const totalPnl = legFacts.some((f) => f.estPnl !== null)
    ? legFacts.reduce((s, f) => s + (f.estPnl ?? 0), 0)
    : null;
  const atMax = closesAll;
  // A leg this close holds only a SLICE of (a pair's share of a shared venue
  // leg) never goes flat at the max: the rest of the leg stays open.
  const sharedLeg = closable.some((l) => (l.share ?? 1) < 0.9995);
  const flatAfter = atMax && !sharedLeg;
  const soleSpread = closable.length === 1 ? spreadOf(closable[0]) : null;

  return (
    <div className="flex flex-col gap-4">
      {agentBlocked && !loginLabel && (
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
          const days = l.maturity ? daysToMaturity(l.maturity, nowSec) : null;
          return (
            <LegCard
              key={l.marketId}
              kind="Boros"
              venue={venueLabel(l)}
              spreadVenues={spreadOf(l)}
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
        {soleSpread && (
          <span className="inline-flex items-center gap-1.5 text-[11px] text-ink-400">
            Leaves both bundles: <VenueIcon venue={soleSpread[0]} size={14} />
            {prettyVenue(soleSpread[0])} and <VenueIcon venue={soleSpread[1]} size={14} />
            {prettyVenue(soleSpread[1])}.
          </span>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-3">
          <FieldLabel htmlFor="boros-close-size">{closable.length > 2 ? 'Close size · all legs' : closable.length > 1 ? 'Close size · both legs' : 'Close size'}</FieldLabel>
          {/* The ceiling, stated where the number is typed — and clickable.
              It was only discoverable by overshooting and reading an error. */}
          <button
            type="button"
            className="num text-[11px] text-ink-400 transition-colors hover:text-ink-100"
            title={closable.length > 1 ? 'Close the whole position on every leg' : 'Close the whole position'}
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
            aria-label="Close size, applied to all legs"
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
                  whole pair · <span className="text-ink-200">flat after</span> on{' '}
                  {closable.length > 2 ? `all ${closable.length} markets` : 'both markets'}
                </>
              ) : (
                <>
                  whole position · <span className="text-ink-200">flat after</span>
                </>
              )
            ) : atMax ? (
              <span title="Part of a venue leg another position also holds. That part stays open.">
                this position's share · the rest of the shared leg stays open
              </span>
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
            const prefix = closable.length > 1 ? `${venueLabel(f.l)}: ` : '';
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
                    const venues = spreadOf(f.l);
                    return (
                      <tr key={id} className="border-t border-ink-800/80">
                        <td className="py-1.5 text-[12px] text-ink-50">
                          <span className="inline-flex items-center gap-1.5">
                            {venues ? (
                              <SpreadIcon venues={venues} size={14} />
                            ) : (
                              <VenueIcon venue={f.l.venue} size={14} />
                            )}
                            {venueLabel(f.l)}
                          </span>
                          {finished && <span className="ml-1.5 inline-flex items-center gap-1 text-[11px] text-emerald-300">closed<Check size={12} aria-hidden /></span>}
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
              {/* What stops the batch as a whole — the server's own words,
                  the same list it will refuse on. */}
              {batchBlockers.map((b) => (
                <span key={`${b.code}-${b.marketId ?? ''}`} className="text-[11px] text-rose-400">
                  {b.message}
                </span>
              ))}
              {batchError && <span className="text-[11px] text-rose-400">{batchError}</span>}
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
        {loginLabel ? (
          <BorosLogInButton />
        ) : (
        <HoldToConfirmButton
          tone="red"
          // No quote, no close: a hold with the numbers blank sends a bound
          // nothing on screen describes. That covers the moment the markets
          // are still loading; a leg that CAN have no quote says so below.
          disabled={
            busy ||
            slipInvalid ||
            anySizeInvalid ||
            agentBlocked ||
            legsBlocked ||
            sim.isError ||
            ctx.isLoading ||
            (simReq !== null && !sim.data) ||
            anyBelowMin ||
            batchBlockers.length > 0
          }
          onConfirm={run}
          className="w-full"
        >
          {busy ? (
            'Closing…'
          ) : (
            <>
              {`Close ${closable.length === 1 ? 'leg' : `${closable.length} legs`}`}
              <ChevronRight size={14} aria-hidden />
            </>
          )}
        </HoldToConfirmButton>
        )}
        {!loginLabel && unquoted && (
          <p className="text-[11px] leading-relaxed text-amber-400/90">
            No quote is available for this market. The close still goes out, within {slipStr}% of mid.
          </p>
        )}
        {!loginLabel && (
          <p className="text-[11px] leading-relaxed text-ink-400">
            {closable.length === 1
              ? `Cancels resting orders, then sends 1 market order. ${soleSpread ? 'The perps stay open.' : 'The perp stays open.'}`
              : pending.length < closable.length
                ? `Cancels resting orders, then closes the ${pending.length === 1 ? 'leg' : `${pending.length} legs`} left in one batch, all or none.`
                : `Cancels resting orders, then closes ${closable.length > 2 ? `all ${closable.length}` : 'both'} legs in one batch, all or none.`}
          </p>
        )}
      </div>
    </div>
  );
}
