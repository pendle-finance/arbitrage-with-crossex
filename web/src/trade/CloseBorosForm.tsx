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
import { SignedNumber } from '../components/SignedNumber';
import { fmtPct, fmtTokenQty, fmtUsd, prettyVenue } from '../lib/fmt';
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
  const slipStr = slipEdited ?? String(seededSlipPct);
  const setSlipStr = setSlipEdited;

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
  const [sizes, setSizes] = useState<Record<number, string>>({});
  /** What the input shows: the user's text, or the live full size. */
  const shownSize = (l: StrategyLeg): string => {
    const raw = sizes[l.marketId as number];
    if (raw !== undefined) return raw;
    return String(Number((l.notionalToken ?? 0).toPrecision(8)));
  };

  const slipPct = Number(slipStr);
  const slipInvalid = !Number.isFinite(slipPct) || slipPct <= 0 || slipPct > 50;

  const sizeOf = (l: StrategyLeg): { value: number; invalid: boolean } => {
    const raw = shownSize(l);
    const n = Number(raw);
    const open = l.notionalToken ?? 0;
    // A relative tolerance: the shown value is rounded to 8 significant digits,
    // so on a large leg the round-trip differs from `open` by more than any
    // fixed epsilon would allow.
    const eps = Math.max(1e-9, open * 1e-7);
    return {
      value: Math.min(n, open),
      invalid: raw.trim() === '' || !Number.isFinite(n) || n <= 0 || n > open + eps,
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
    if (!address || closable.length === 0 || slipInvalid || anySizeInvalid) return null;
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
  }, [address, closable, slipStr, JSON.stringify(sizes), slipInvalid, anySizeInvalid, ctx.data]);

  const sim = useBorosPairSimulation(simReq, simReq !== null);
  const simLegFor = (i: number): BorosSimulatedLeg | null => {
    const s = sim.data?.simulation;
    if (!s) return null;
    return i === 0 ? s.legA : s.legB;
  };

  const agentReady = agent.data?.configured === true && agent.data.expired === false;
  const agentBlocked = agent.isSuccess && !agentReady;
  const agentReason = !agent.data?.configured
    ? 'No Boros wallet is connected on this install — connect one and approve an agent key before closing Boros legs.'
    : 'The Boros agent approval has expired — approve a new agent key before closing Boros legs.';

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
        if (r.fill?.failure) {
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
        } else if (r.fill!.filledSize < requested - dust) {
          // SHORT of what was asked: the book ran out inside the rate bound.
          // The only outcome that leaves something for a second press — so it
          // is also the only one that re-seeds the size, below, rather than
          // leaving the original amount armed under a line saying it is done.
          const filled = r.fill!.filledSize;
          const left = requested - filled;
          setPartial((prev) => [...prev, { marketId: id, filled, left }]);
          setSizes((prev) => ({ ...prev, [id]: String(Number(left.toPrecision(8))) }));
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
            {fmtTokenQty(residualYours, unit)} of this position is still open — you closed part of
            it. Close the rest whenever you like.
          </p>
        )}
        {residualOthers > 0 && (
          <p className="text-[11px] leading-relaxed text-ink-400">
            {fmtTokenQty(residualOthers, unit)} more is open on the venue — that is another
            position's share of the same leg, not yours.
          </p>
        )}
        <button type="button" className="btn-primary w-full" onClick={onDone}>
          Done
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12px] leading-relaxed text-ink-300">
        Cancels any resting orders on {closable.length === 1 ? 'this market' : 'these markets'}, then
        sends an opposite market order at the size below.
      </p>

      {agentBlocked && (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] leading-relaxed text-amber-300/90">
          {agentReason}
        </p>
      )}

      <div className="flex flex-col gap-2.5 rounded-lg border border-ink-800 bg-ink-950/60 px-3 py-2.5 text-[11px]">
        {closable.map((l, i) => {
          const id = l.marketId as number;
          const unit = l.collateral ?? '';
          const open = l.notionalToken ?? 0;
          const { value, invalid } = sizeOf(l);
          const q = simLegFor(i);
          const err = failed.find((f) => f.marketId === id);
          const part = partial.find((x) => x.marketId === id);
          // PnL at the rate the book would actually give, over the leg's life:
          // (locked − exec) × size × years, signed by the side being closed.
          const years = l.maturity ? Math.max(0, l.maturity - Date.now() / 1000) / 31_536_000 : null;
          const estPnl =
            q?.execApr != null && l.entryApr !== undefined && years !== null
              ? (l.side === 'LONG' ? q.execApr - l.entryApr : l.entryApr - q.execApr) * value * years
              : null;
          return (
            <div key={id} className="flex flex-col gap-0.5">
              <span className="flex items-center gap-1.5 text-ink-300">
                <span className="text-ink-200">
                  {prettyVenue(l.venue)} <span className="text-ink-500">{l.side}</span>
                </span>
                <span className="num ml-auto text-ink-100">{fmtTokenQty(open, unit)} open</span>
              </span>
              <label className="mt-0.5 flex items-center gap-2 text-ink-400">
                <span className="w-20">Close size</span>
                <input
                  className={`input num h-7 flex-1 px-2 py-0.5 ${invalid ? 'border-rose-500' : ''}`}
                  inputMode="decimal"
                  value={shownSize(l)}
                  onChange={(e) => setSizes((prev) => ({ ...prev, [id]: e.target.value }))}
                  aria-label={`Close size for the ${l.venue} Boros leg`}
                />
                {unit && <span className="text-ink-500">{unit}</span>}
              </label>
              {invalid ? (
                <span className="text-rose-400">
                  size must be above 0 and at most {fmtTokenQty(open, unit)}
                </span>
              ) : (
                <>
                  <span className="flex justify-between text-ink-400">
                    <span>est. execution rate</span>
                    <span className="num text-ink-100">
                      {q?.execApr != null ? fmtPct(q.execApr) : sim.isFetching ? 'quoting…' : '—'}
                      {q?.worstApr != null && (
                        <span className="text-ink-500"> (worst {fmtPct(q.worstApr)})</span>
                      )}
                    </span>
                  </span>
                  <span className="flex justify-between text-ink-400">
                    <span>est. PnL at that rate</span>
                    {estPnl !== null ? (
                      <SignedNumber value={estPnl} format={(n) => fmtUsd(n)} />
                    ) : (
                      <span className="text-ink-500">—</span>
                    )}
                  </span>
                  {/* A dust residual is not a shortfall: the walk returns
                      sizes like 419.49999999 for a book that fully covers
                      419.5, and warning on that reads as "no depth" on a
                      market that has plenty. */}
                  {q && q.shortfallSize > Math.max(1e-6, value * 1e-6) && (
                    <span className="text-amber-400/90">
                      the book only supports {fmtTokenQty(q.estFillSize, unit)} of this size — it
                      will fill short
                    </span>
                  )}
                  {q && q.bookStatus === 'unavailable' && (
                    <span className="text-amber-400/90">
                      order book unavailable — no rate can be quoted for this leg
                    </span>
                  )}
                </>
              )}
              {part && (
                <span className="text-amber-400/90">
                  filled {fmtTokenQty(part.filled, unit)} — {fmtTokenQty(part.left, unit)} of what
                  you asked for is still open. The size above is set to what is left; close again
                  to finish it.
                </span>
              )}
              {err && <span className="text-rose-400">{err.message}</span>}
            </div>
          );
        })}
      </div>

      <label className="flex items-center gap-2 text-[11px] text-ink-400">
        <span className="w-20">Slippage %</span>
        <input
          className={`input num h-7 flex-1 px-2 py-0.5 ${slipInvalid ? 'border-rose-500' : ''}`}
          inputMode="decimal"
          value={slipStr}
          onChange={(e) => setSlipStr(e.target.value)}
          aria-label="Close slippage tolerance, APR percent"
        />
        <span className="text-ink-500">APR</span>
      </label>
      {slipInvalid && <span className="text-[11px] text-rose-400">slippage must be in (0, 50]</span>}

      <p className="text-[11px] leading-relaxed text-ink-500">
        The bound is a rate, not a price: it caps the APR this close will accept, and a close that
        keeps missing it leaves the position open. Size is capped at whatever is actually open once
        the cancel lands — Boros has no reduce-only flag, so it can never cross past flat.
      </p>

      <HoldToConfirmButton
        tone="red"
        disabled={close.isPending || slipInvalid || anySizeInvalid || agentBlocked}
        onConfirm={run}
        className="w-full"
      >
        {close.isPending
          ? 'Closing…'
          : `Close ${closable.length === 1 ? 'leg' : `${closable.length} legs`} ▸`}
      </HoldToConfirmButton>
    </div>
  );
}
