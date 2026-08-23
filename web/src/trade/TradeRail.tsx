/**
 * Right rail: the order ticket.
 *
 * The top-level choice is the VENUE, not the execution style:
 *
 *   CrossEx perps ──┬─ Pair   ─┬─ 2 market orders
 *                   │          └─ Limit + hedge
 *                   └─ Single
 *   Boros rates ────── Market order, 2 legs
 *
 * WHY venue-first. The Boros two-leg market ticket and the perp pair's "2
 * market orders" mode are near-identical surfaces — same verb, same two-leg
 * shape, same size and slippage controls — that put on DIFFERENT exposure on
 * DIFFERENT venues. Someone who takes the wrong one ends up unhedged while
 * believing they are hedged. As three sibling tabs those two sit adjacent and
 * a label is the only thing between them; nesting execution style UNDER the
 * venue means they can never be one mis-click apart, and the thing the user
 * has to hold in their head is reduced to "which venue" — which the rail then
 * states outright rather than leaving to be inferred.
 *
 * Everything downstream repeats the venue rather than assuming it: the ticket
 * header names it, and the Boros confirm names the venue and both markets
 * before anything is sent.
 */
import { useEffect, useRef, useState } from 'react';
import { UnderlineTabs } from '../components/UnderlineTabs';
import { BorosPairTicket } from './BorosPairTicket';
import { PairTicket } from './PairTicket';
import { SingleTicket } from './SingleTicket';
import { useTradeFlowOptional } from './TradeFlow';

/** Which venue's legs the ticket will touch. */
type Venue = 'perp' | 'boros';
/** Perp-only sub-choice; Boros has a single ticket, so it needs none. */
type PerpMode = 'single' | 'pair';

const VENUE_BLURB: Record<Venue, string> = {
  perp: 'Opens perp positions on Gate CrossEx.',
  boros: 'Opens fixed-rate positions on Boros.',
};

export function TradeRail() {
  const [venue, setVenue] = useState<Venue>('perp');
  // Pair is the default within perps: the terminal exists for delta-neutral
  // pair entries.
  const [perpMode, setPerpMode] = useState<PerpMode>('pair');
  // Once visited, the Boros ticket stays MOUNTED (hidden) across venue flips.
  // Its §5 fill report, unhedged-residual warning and armed completion are
  // component state — unmounting on a venue flip would bury a live
  // directional exposure behind a tab switch, and drop a mid-flight
  // execution's result entirely.
  const [borosSeen, setBorosSeen] = useState(false);
  const flow = useTradeFlowOptional();
  const asideRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (venue === 'boros') setBorosSeen(true);
  }, [venue]);

  // A strategy-box "Open the perp legs" prefill lands here: make sure the perp
  // pair ticket is visible (PairTicket itself consumes the field values). The
  // venue is set explicitly — a prefill that arrived while the Boros ticket was
  // open must not silently fill a form the user cannot see.
  const prefillNonce = flow?.pairPrefill?.nonce ?? 0;
  useEffect(() => {
    if (!prefillNonce) return;
    setVenue('perp');
    setPerpMode('pair');
    asideRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [prefillNonce]);

  // A missing-perp ROW asks for one leg, so the rail shows the single ticket
  // rather than the pair — same contract as the pair prefill above, opposite
  // mode.
  const singlePerpNonce = flow?.singlePerpPrefill?.nonce ?? 0;
  useEffect(() => {
    if (!singlePerpNonce) return;
    setVenue('perp');
    setPerpMode('single');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [singlePerpNonce]);

  // The Boros counterpart of the perp prefill: show the ticket it fills, so a
  // form is never populated out of sight.
  const borosOpenNonce = flow?.borosOpenPrefill?.nonce ?? 0;
  useEffect(() => {
    if (!borosOpenNonce) return;
    setVenue('boros');
    asideRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [borosOpenNonce]);

  return (
    // The 340px is mirrored by TabBar's right slot so the active tab's cyan
    // shelf ends exactly where this rail begins — change both together.
    <aside ref={asideRef} className="flex w-[340px] shrink-0 flex-col gap-4" aria-label="Order ticket">
      <div className="card px-4 py-4">
        {/* No "Order ticket" heading: the rail is the only thing in this column
            and the tabs below name what it is. The venue and mode switches are
            NAVIGATION — which ticket am I on — so they read as underline tabs,
            while the settings inside each ticket keep their boxed toggles. */}
        <UnderlineTabs<Venue>
          ariaLabel="Venue"
          value={venue}
          onChange={setVenue}
          options={[
            { value: 'perp', label: 'CrossEx perps' },
            { value: 'boros', label: 'Boros rates' },
          ]}
        />
        {/* Stated, never inferred: the rail says which venue's legs this
            ticket touches before the user reads a single field. */}
        <p className="mt-2 mb-3 text-[11px] text-ink-400">{VENUE_BLURB[venue]}</p>

        {venue === 'perp' && (
          <>
            <UnderlineTabs<PerpMode>
              ariaLabel="Perp ticket mode"
              value={perpMode}
              onChange={setPerpMode}
              className="mb-3"
              options={[
                { value: 'pair', label: 'Pair' },
                { value: 'single', label: 'Single' },
              ]}
            />
            {perpMode === 'single' ? <SingleTicket /> : <PairTicket />}
          </>
        )}
        {(venue === 'boros' || borosSeen) && (
          <div hidden={venue !== 'boros'}>
            <BorosPairTicket active={venue === 'boros'} />
          </div>
        )}
      </div>
    </aside>
  );
}
