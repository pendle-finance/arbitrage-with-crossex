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
import { sigFigsDirectional } from '../lib/ticks';
import type { BorosLegFill, BorosPairRequest, BorosSimulatedLeg, StrategyLeg } from '../api/types';
import { SpreadIcon, VenueIcon } from '../components/AssetIcon';
import { fixedRateText } from '../components/FixedRate';
import { SignedNumber } from '../components/SignedNumber';
import { QueryError } from '../components/QueryError';
import { daysToMaturity, knownRate } from '../lib/boros';
import { spreadName } from '../lib/spread';
import { fieldValue, fmtDateLocal, fmtPct, fmtTokenQty, fmtUsd, prettyVenue, sigGrouped } from '../lib/fmt';
import { Chip } from '../components/Chip';
import { AffixedInput, EstimateAge, EstimateRow, SlippageLine, SummaryCard } from './PairTicketBits';
import { TotalCostRow, TradeFeeRow } from './BorosPairBits';
import { FieldLabel } from './SymbolCombobox';
import {
  useBorosAgent,
  useBorosCancelAndClose,
  useBorosPairContext,
  useBorosPairSimulation,
  useExecuteBorosPair,
} from '../api/queries';
import { Trans, useTranslation } from 'react-i18next';
import { HoldToConfirmButton } from '../components/HoldToConfirmButton';
import { uuid } from '../lib/uuid';
import { useActiveWallet } from '../panels/trackedAddress';
import { BorosLogInButton } from './BorosAgentSetup';
import { localizeServerText } from '../i18n/serverMessages';

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

export function CloseBorosForm({
  legs,
  perpsUnhedged = false,
  onClosed,
  onDone,
  onSent,
}: {
  legs: CloseLeg[];
  perpsUnhedged?: boolean;
  onSent?: () => void;
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
  const { t } = useTranslation();
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
  const legsReason = t(closable.length > 2 ? 'pairTicket.closeBoros.legsReasonAll' : 'pairTicket.closeBoros.legsReasonBoth', { list: collaterals.join(', ') });

  const ctx = useBorosPairContext(address);
  const rowOf = (marketId: number | undefined) =>
    ctx.data?.markets.find((m) => m.marketId === marketId) ??
    ctx.data?.spreadMarkets?.find((m) => m.marketId === marketId);
  const spreadOf = (l: CloseLeg) => l.spreadVenues ?? rowOf(l.marketId)?.spreadVenues ?? null;
  const venueLabel = (l: CloseLeg): string => {
    const venues = spreadOf(l);
    return venues ? spreadName(l.base, venues) : prettyVenue(l.venue);
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
    const floored = sigFigsDirectional(pct, 1, 'down');
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
  const agentReason = t('pairTicket.closeBoros.agentReason');

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
    onSent?.();

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
              return settle(l, closeReq.legs[i].size, sent, open === undefined ? undefined : Math.abs(open), t('pairTicket.closeBoros.noPositionToClose'));
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
              ? t('pairTicket.closeBoros.cancelledNoPosition')
              : t('pairTicket.closeBoros.nothingClosed'),
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
    return <p className="text-[12px] text-ink-400">{t('pairTicket.closeBoros.noLegs')}</p>;
  }

  // A close that landed says so, and stays said until dismissed — the dialog
  // closing on its own gave no confirmation that anything had happened.
  if (allDone) {
    const unit = closable[0]?.collateral ?? '';
    return (
      <div className="flex flex-col gap-3">
        <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2.5 text-[12px] leading-relaxed text-emerald-300">
          {t('pairTicket.closeBoros.closedDone', { count: closable.length })}
        </p>
        {/* The venue leg outliving the close is normal. Said plainly and NOT
            as an amber warning: nothing went wrong. But the two halves are
            not interchangeable — one is the user's to close whenever they
            like, the other is not theirs at all. */}
        {residualYours > 0 && (
          <p className="text-[11px] leading-relaxed text-ink-400">
            {t('pairTicket.closeBoros.residualYours', { amount: `${sigGrouped(residualYours)} ${unit}` })}
          </p>
        )}
        {residualOthers > 0 && (
          <p className="text-[11px] leading-relaxed text-ink-400">
            {t('pairTicket.closeBoros.residualOthers', { amount: `${sigGrouped(residualOthers)} ${unit}` })}
          </p>
        )}
        <button type="button" className="btn-primary w-full" onClick={onDone}>
          {t('common.done')}
        </button>
      </div>
    );
  }

  const unit0 = closable[0]?.collateral ?? '';
  const simulation = sim.data?.simulation ?? null;
  const px = simulation?.collateralPriceUsd;
  const inUsd = px != null && px > 0;
  const money = (n: number) =>
    inUsd ? <SignedNumber value={n * (px as number)} format={(v) => fmtUsd(v)} /> : <SignedNumber value={n} format={(v) => fmtTokenQty(v, unit0)} />;
  const usdNote = (n: number | null): string => {
    if (n === null || !inUsd) return '';
    const usd = n * (px as number);
    return ` (${fmtUsd(usd, Math.abs(usd) < 100 ? 2 : 0)})`;
  };
  const nowSec = Date.now() / 1000;
  const yearsOf = (l: CloseLeg): number | null =>
    l.maturity
      ? Math.max(0, l.maturity - nowSec) / 31_536_000
      : simulation
        ? Math.max(0, simulation.secondsToMaturity) / 31_536_000
        : null;
  const legFacts = closable.map((l) => {
    const q = simLegFor(l);
    const value = sizeOf(l);
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
  const pendingFacts = legFacts.filter((f) => pending.includes(f.l));
  const slipCost = (aprOf: (f: (typeof legFacts)[number]) => number | null): number | null => {
    if (pendingFacts.length === 0) return null;
    let sum = 0;
    for (const f of pendingFacts) {
      const apr = aprOf(f);
      const years = yearsOf(f.l);
      if (apr === null || years === null) return null;
      sum += Math.max(0, apr) * f.value * years;
    }
    return sum;
  };
  const estSlipCost = simulation ? slipCost((f) => f.q?.estSlippageApr ?? null) : null;
  const maxSlipCost = slipInvalid ? null : slipCost(() => slipPct / 100);
  const atMax = closesAll;
  const sharedLeg = closable.some((l) => {
    const open = Math.abs(rowOf(l.marketId)?.currentSize ?? 0);
    return open > 0 ? wholeOf(l) < open : (l.share ?? 1) < 0.9995;
  });
  const flatAfter = atMax && !sharedLeg;
  const soleSpread = closable.length === 1 ? spreadOf(closable[0]) : null;
  const leftOf = (l: CloseLeg): number => {
    const left = heldWei(l) - toWei(sizeOf(l));
    return left > 0n ? fromWei(left) : 0;
  };
  const legName = (l: CloseLeg) => {
    const venues = spreadOf(l);
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        {venues ? <SpreadIcon venues={venues} size={14} /> : <VenueIcon venue={l.venue} size={14} />}
        <span className="truncate">{venueLabel(l)}</span>
      </span>
    );
  };

  const rateOf = (q: BorosSimulatedLeg | null) =>
    q?.execApr != null ? fmtPct(q.execApr) : sim.isFetching ? t('pairTicket.closeBoros.quoting') : '—';
  const feeOf = (q: BorosSimulatedLeg | null, unit: string) =>
    q?.takerFeeCost === undefined ? '—' : inUsd ? fmtUsd(q.takerFeeCost * (px as number)) : fmtTokenQty(q.takerFeeCost, unit);

  type Notice = { key: string; tone: 'amber' | 'rose' | 'dim'; text: string };
  const notices: Notice[] = [];
  if (agentBlocked && !loginLabel) notices.push({ key: 'agent', tone: 'amber', text: agentReason });
  if (legsBlocked) notices.push({ key: 'legs', tone: 'amber', text: legsReason });
  for (const f of legFacts) {
    const id = f.l.marketId as number;
    const unit = f.l.collateral ?? '';
    const prefix = closable.length > 1 ? `${venueLabel(f.l)}: ` : '';
    const finished = done.find((d) => d.marketId === id);
    const belowMin = sim.data?.gate.blockers.find((b) => b.code === 'below-min-order-value' && b.marketId === id);
    const err = failed.find((x) => x.marketId === id);
    const part = partial.find((x) => x.marketId === id);
    const q = f.q;
    if (finished && finished.yours > 0) {
      notices.push({ key: `yours-${id}`, tone: 'dim', text: t('pairTicket.closeBoros.legClosedYours', { prefix, amount: `${sigGrouped(finished.yours)} ${unit}` }) });
    }
    if (!finished && belowMin) notices.push({ key: `min-${id}`, tone: 'rose', text: `${prefix}${localizeServerText(belowMin.message)}` });
    if (!finished && q && q.shortfallSize > Math.max(1e-6, f.value * 1e-6)) {
      notices.push({ key: `short-${id}`, tone: 'amber', text: t('pairTicket.closeBoros.bookShort', { prefix, amount: sigGrouped(q.estFillSize), unit }) });
    }
    if (!finished && q && q.bookStatus === 'unavailable') {
      notices.push({ key: `book-${id}`, tone: 'amber', text: t('pairTicket.closeBoros.bookUnavailable', { prefix }) });
    }
    if (part) {
      notices.push({ key: `part-${id}`, tone: 'amber', text: t('pairTicket.closeBoros.partFilled', { prefix, filled: sigGrouped(part.filled), left: sigGrouped(part.left), unit }) });
    }
    if (err) notices.push({ key: `err-${id}`, tone: 'rose', text: `${prefix}${err.message}` });
  }
  for (const b of batchBlockers) notices.push({ key: `batch-${b.code}-${b.marketId ?? ''}`, tone: 'rose', text: localizeServerText(b.message) });
  if (batchError) notices.push({ key: 'batch-error', tone: 'rose', text: batchError });
  if (!loginLabel && unquoted) notices.push({ key: 'unquoted', tone: 'amber', text: t('pairTicket.closeBoros.unquoted', { slip: slipStr }) });
  const toneClass = { amber: 'text-amber-400/90', rose: 'text-rose-400', dim: 'text-ink-400' } as const;

  const positionAfter = flatAfter
    ? t('pairTicket.closeBoros.flat')
    : atMax
      ? t('pairTicket.closeBoros.sharedOpen')
      : closable.length === 1
        ? `${sigGrouped(leftOf(closable[0]))} ${unit0}`
        : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="card flex flex-col divide-y divide-ink-800/80 px-3">
        {closable.map((l) => {
          const venues = spreadOf(l);
          const days = l.maturity ? daysToMaturity(l.maturity, nowSec) : null;
          const rates = [
            l.entryApr !== undefined ? t('pairTicket.closeBoros.locked', { rate: fixedRateText(t, l.side === 'SHORT' ? l.entryApr : -l.entryApr) }) : null,
            knownRate(l.markApr) ? t('pairTicket.closeBoros.mark', { rate: fmtPct(l.markApr) }) : null,
          ].filter((s) => s !== null);
          return (
            <div key={l.marketId} className="flex flex-col gap-0.5 py-2">
              <div className="flex items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] font-semibold text-ink-50">
                  {venues ? <SpreadIcon venues={venues} size={16} /> : <VenueIcon venue={l.venue} size={16} />}
                  <span className="truncate">{venueLabel(l)}</span>
                  <Chip sm tone={l.side === 'LONG' ? 'green' : 'red'} className="font-semibold">
                    {t(l.side === 'LONG' ? 'common.longUpper' : 'common.shortUpper')}
                  </Chip>
                </span>
                <span className="num shrink-0 text-[12.5px] font-semibold text-ink-50">
                  {`${sigGrouped(l.notionalToken ?? 0)} ${l.collateral ?? ''}`}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-3 text-[11px] text-ink-400">
                <span className="num truncate">
                  {`${l.base}${l.maturity ? ` · ${fmtDateLocal(l.maturity)}` : ''}${days !== null ? ` · ${t('pairTicket.closeBoros.daysShort', { n: days })}` : ''}`}
                </span>
                {rates.length > 0 && <span className="num shrink-0">{rates.join(' · ')}</span>}
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-3">
          <FieldLabel htmlFor="boros-close-size">{closable.length > 2 ? t('pairTicket.closeBoros.closeSizeAll') : closable.length > 1 ? t('pairTicket.closeBoros.closeSizeBoth') : t('pairTicket.closeBoros.closeSize')}</FieldLabel>
          <button
            type="button"
            className="num text-[11px] text-ink-400 transition-colors hover:text-ink-100"
            onClick={() => setSizeEdited(fieldValue(maxCloseSize))}
          >
            {t('common.max')}{' '}
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
            aria-label={t('pairTicket.closeBoros.sizeAria')}
          />
        </AffixedInput>
        {anySizeInvalid ? (
          <span className="text-[11px] text-rose-300">
            {t('pairTicket.closeBoros.sizeInvalid', { max: sigGrouped(maxCloseSize), unit: unit0 })}
          </span>
        ) : (
          atMax && sharedLeg && <span className="text-[11px] text-ink-400">{t('pairTicket.closeBoros.sharedLabel')}</span>
        )}
      </div>

      <SummaryCard
        title={t('accounts.moveCash.cost')}
        aside={
          <EstimateAge
            dataUpdatedAt={sim.dataUpdatedAt}
            estimating={sim.isPlaceholderData || (sim.isFetching && !sim.data)}
            isError={sim.isError}
          />
        }
      >
        {closable.length === 1 ? (
          <EstimateRow label={t('pairTicket.closeBoros.estRate')} value={rateOf(legFacts[0].q)} />
        ) : (
          <table className="w-full">
            <thead>
              <tr className="text-[11px] text-ink-400">
                <th className="pb-1 text-left font-normal">{t('common.position')}</th>
                <th className="pb-1 text-right font-normal">{t('pairTicket.closeBoros.estRate')}</th>
                <th className="pb-1 text-right font-normal">{t('pairTicket.borosBits.tradeFee')}</th>
              </tr>
            </thead>
            <tbody>
              {legFacts.map((f) => {
                const id = f.l.marketId as number;
                const finished = done.find((d) => d.marketId === id);
                return (
                  <tr key={id} className="border-t border-ink-800/80">
                    <td className="py-1.5 text-[12px] text-ink-50">
                      <span className="flex items-center gap-1.5">
                        {legName(f.l)}
                        <Chip sm tone={f.l.side === 'LONG' ? 'green' : 'red'} className="font-semibold">
                          {t(f.l.side === 'LONG' ? 'common.longUpper' : 'common.shortUpper')}
                        </Chip>
                        {finished && (
                          <span className="inline-flex items-center gap-1 text-[11px] text-emerald-300">
                            {t('pairTicket.closeBoros.closedTag')}
                            <Check size={12} aria-hidden />
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="num py-1.5 text-right text-[12.5px] text-ink-50">{rateOf(f.q)}</td>
                    <td className="num py-1.5 text-right text-[12px] text-ink-50">{feeOf(f.q, f.l.collateral ?? '')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <SlippageLine
          est={estSlippageApr !== null ? `${fmtPct(estSlippageApr)}${usdNote(estSlipCost)}` : null}
          max={`${slipStr}%`}
          unit={`APR${usdNote(maxSlipCost)}`}
          open={slipOpen}
          onToggle={() => setSlipOpen((v) => !v)}
          value={slipStr}
          onChange={setSlipEdited}
          invalid={slipInvalid}
          invalidText={t('pairTicket.closeBoros.slipInvalid', { max: MAX_SLIP_PCT })}
          inputAriaLabel={t('pairTicket.closeBoros.slipAria')}
          hint={t('trade.close.bandHint')}
        />
        {simulation ? (
          <TradeFeeRow sim={simulation} />
        ) : (
          <EstimateRow label={t('pairTicket.borosBits.tradeFee')} value="—" />
        )}
        <div className="mt-0.5 border-t border-ink-800 pt-1.5">
          {simulation ? (
            <TotalCostRow sim={simulation} slippage={estSlipCost} />
          ) : (
            <EstimateRow strong label={t('pairTicket.borosBits.totalCost')} value="—" />
          )}
        </div>
      </SummaryCard>

      <SummaryCard title={t('accounts.moveCash.after')}>
        <EstimateRow
          strong
          label={t('pairTicket.closeBoros.estPnl')}
          sub={t('pairTicket.closeBoros.beforeFee')}
          value={totalPnl !== null ? money(totalPnl) : <span className="text-ink-500">—</span>}
        />
        {closable.length > 1 &&
          legFacts.map((f) => (
            <div key={f.l.marketId} className="flex items-baseline justify-between gap-3 pl-3 text-[11.5px] text-ink-400">
              {legName(f.l)}
              <span className="num text-[12px]">{f.estPnl !== null ? money(f.estPnl) : '—'}</span>
            </div>
          ))}
        <EstimateRow
          label={t('pairTicket.borosBits.positionAfter')}
          value={positionAfter ?? ''}
        />
        {positionAfter === null &&
          pendingFacts.map((f) => (
            <div key={f.l.marketId} className="flex items-baseline justify-between gap-3 pl-3 text-[11.5px] text-ink-400">
              {legName(f.l)}
              <span className="num text-[12px] text-ink-300">{`${sigGrouped(leftOf(f.l))} ${f.l.collateral ?? ''}`}</span>
            </div>
          ))}
        {perpsUnhedged && (
          <EstimateRow
            label={t('accounts.closePair.after.perps')}
            value={<span className="text-rose-400">{t('accounts.closePair.after.openFloating')}</span>}
          />
        )}
        {soleSpread && (
          <EstimateRow
            label={t('pairTicket.closeBoros.bundles')}
            value={
              <span className="inline-flex items-center gap-1.5">
                <Trans
                  i18nKey="pairTicket.closeBoros.leavesBundles"
                  values={{ a: prettyVenue(soleSpread[0]), b: prettyVenue(soleSpread[1]) }}
                  components={{ i0: <VenueIcon venue={soleSpread[0]} size={14} />, i1: <VenueIcon venue={soleSpread[1]} size={14} /> }}
                />
              </span>
            }
          />
        )}
      </SummaryCard>

      <div className="flex flex-col gap-1.5">
        {(sim.isError || notices.length > 0) && (
          <div className="flex flex-col gap-1">
            {sim.isError && <QueryError title={t('pairTicket.closeBoros.quoteFailed')} error={sim.error} onRetry={() => sim.refetch()} />}
            {notices.map((n) => (
              <p key={n.key} className={`text-[11px] leading-relaxed ${toneClass[n.tone]}`}>
                {n.text}
              </p>
            ))}
          </div>
        )}
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
            t('pairTicket.closeBoros.closing')
          ) : (
            <>
              {t('pairTicket.closeBoros.closeLegs', { count: closable.length })}
              <ChevronRight size={14} aria-hidden />
            </>
          )}
        </HoldToConfirmButton>
        )}
        {!loginLabel && (
          <p className="text-[11px] leading-relaxed text-ink-400">
            {closable.length === 1
              ? t('pairTicket.closeBoros.footOne')
              : pending.length < closable.length
                ? t('pairTicket.closeBoros.footLeft', { count: pending.length })
                : closable.length > 2
                  ? t('pairTicket.closeBoros.footAll', { n: closable.length })
                  : t('pairTicket.closeBoros.footBoth')}
          </p>
        )}
      </div>
    </div>
  );
}
