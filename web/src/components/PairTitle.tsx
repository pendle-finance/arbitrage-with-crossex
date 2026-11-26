import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { prettyVenue } from '../lib/fmt';
import { VenueIcon } from './AssetIcon';

export function PairTitle({ longVenue, shortVenue, sides = true, children }: { longVenue: string; shortVenue: string; sides?: boolean; children?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-[7px]">
      <span className="inline-flex items-center gap-[6px]">
        <VenueIcon venue={longVenue} size={18} />
        {prettyVenue(longVenue)}
        {sides && <span className="text-[9.5px] font-semibold tracking-[0.1em] text-grass">{t('common.longUpper')}</span>}
      </span>
      <span className="text-ink-600">/</span>
      <span className="inline-flex items-center gap-[6px]">
        <VenueIcon venue={shortVenue} size={18} />
        {prettyVenue(shortVenue)}
        {sides && <span className="text-[9.5px] font-semibold tracking-[0.1em] text-guava">{t('common.shortUpper')}</span>}
      </span>
      {children}
    </span>
  );
}
