import { spreadPlatform, type SpreadVenues } from '../lib/spread';

/** "ETH Spread HL-GATE", styled as the Boros app styles it: the platform half dimmer. */
export function SpreadName({ base, venues, className = '' }: { base: string; venues: SpreadVenues; className?: string }) {
  return (
    <span className={`truncate ${className}`}>
      <span className="font-medium text-ink-50">{base} Spread</span> <span className="font-medium text-ink-400">{spreadPlatform(venues)}</span>
    </span>
  );
}
