import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SegmentedToggle } from '../components/SegmentedToggle';
import { UnderlineTabs } from '../components/UnderlineTabs';
import { BorosPairTicket } from './BorosPairTicket';
import { PairTicket } from './PairTicket';
import { SingleTicket } from './SingleTicket';
import { useTradeFlowOptional } from './TradeFlow';

/** Which venue's legs the ticket will touch. */
export type Venue = 'perp' | 'boros';
type TicketMode = 'single' | 'pair';

export function TradeRailTabs({ venue, onChange }: { venue: Venue; onChange: (next: Venue) => void }) {
  const { t } = useTranslation();
  return (
    <UnderlineTabs<Venue>
      ariaLabel={t('common.venue')}
      value={venue}
      onChange={onChange}
      look="glow"
      className="flex-1"
      options={[
        { value: 'perp', label: t('trade.rail.crossexPerps') },
        { value: 'boros', label: t('trade.rail.borosRates') },
      ]}
    />
  );
}

export function TradeRail({
  venue,
  onVenueChange,
  onBusyChange,
}: {
  venue: Venue;
  onVenueChange: (next: Venue) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useTranslation();
  // Pair is the default within perps: the terminal exists for delta-neutral
  // pair entries.
  const [mode, setMode] = useState<TicketMode>('pair');
  // Once visited, the Boros ticket stays MOUNTED (hidden) across venue flips.
  // Its §5 fill report, unhedged-residual warning and armed completion are
  // component state — unmounting on a venue flip would bury a live
  // directional exposure behind a tab switch, and drop a mid-flight
  // execution's result entirely.
  const [borosSeen, setBorosSeen] = useState(false);
  const flow = useTradeFlowOptional();

  useEffect(() => {
    if (venue === 'boros') setBorosSeen(true);
  }, [venue]);

  // A Positions "open perp leg" prefill lands here: make sure the perp
  // pair ticket is visible (PairTicket itself consumes the field values). The
  // venue is set explicitly — a prefill that arrived while the Boros ticket was
  // open must not silently fill a form the user cannot see. No scrolling any
  // more: the drawer opens over the page, so the armed form is always in view.
  const prefillNonce = flow?.pairPrefill?.nonce ?? 0;
  useEffect(() => {
    if (!prefillNonce) return;
    onVenueChange('perp');
    setMode('pair');
  }, [prefillNonce, onVenueChange]);

  // A missing-perp ROW asks for one leg, so the rail shows the single ticket
  // rather than the pair — same contract as the pair prefill above, opposite
  // mode.
  const singlePerpNonce = flow?.singlePerpPrefill?.nonce ?? 0;
  useEffect(() => {
    if (!singlePerpNonce) return;
    onVenueChange('perp');
    setMode('single');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [singlePerpNonce]);

  // The Boros counterpart of the perp prefill: show the ticket it fills, so a
  // form is never populated out of sight.
  const borosOpenNonce = flow?.borosOpenPrefill?.nonce ?? 0;
  useEffect(() => {
    if (!borosOpenNonce) return;
    onVenueChange('boros');
  }, [borosOpenNonce, onVenueChange]);

  return (
    <div className="flex flex-col gap-3">
      <SegmentedToggle<TicketMode>
        ariaLabel={t('trade.rail.ticketKindAria')}
        value={mode}
        onChange={setMode}
        fill
        options={[
          { value: 'pair', label: t('common.pair') },
          { value: 'single', label: t('trade.rail.single') },
        ]}
      />
      <div>
        {venue === 'perp' && (mode === 'single' ? <SingleTicket /> : <PairTicket />)}
        {(venue === 'boros' || borosSeen) && (
          <div hidden={venue !== 'boros'}>
            <BorosPairTicket active={venue === 'boros'} onBusyChange={onBusyChange} mode={mode} onModeChange={setMode} />
          </div>
        )}
      </div>
    </div>
  );
}
