import { useTranslation } from 'react-i18next';
import { spreadPlatform, type SpreadVenues } from '../lib/spread';

/** "ETH Spread HL-GATE", styled as the Boros app styles it: the platform half dimmer. */
export function SpreadName({ base, venues, className = '' }: { base: string; venues: SpreadVenues; className?: string }) {
  const { t } = useTranslation();
  return (
    <span className={`truncate ${className}`}>
      <span className="font-medium text-ink-50">{t('app.spreadName', { base })}</span> <span className="font-medium text-ink-400">{spreadPlatform(venues)}</span>
    </span>
  );
}
