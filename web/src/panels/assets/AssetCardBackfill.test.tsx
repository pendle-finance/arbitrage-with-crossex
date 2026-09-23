import { screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetGroup } from '../../api/types';
import { baseHandlers } from '../../test/fixtures';
import { server } from '../../test/server';
import { renderWithClient } from '../../test/utils';
import { AssetCard } from './AssetCard';
import { deriveAsset } from './assetModel';

const NOW = Date.UTC(2026, 8, 18, 12) / 1000;
const MARCH = Date.UTC(2026, 2, 1, 12) / 1000;
const JUNE = Date.UTC(2026, 5, 23, 12) / 1000;

const eth: AssetGroup = {
  base: 'ETH',
  supported: true,
  priceUsd: 2473,
  earliestSec: MARCH,
  perpOpen: [
    {
      symbol: 'GATE_FUTURE_ETH_USDT',
      venue: 'GATE',
      side: 'LONG',
      qty: 0.1,
      notionalUsd: 247.3,
      entryPrice: 2400,
      markPrice: 2473,
      leverage: 5,
      upnlUsd: 7.3,
      fundingUsd: 1.2,
      feesUsd: 0.1,
      imUsd: 49.46,
      openedAt: MARCH,
    },
  ],
  perpClosed: [],
  borosOpen: [],
  borosHistory: [],
};

function renderCard(over: Partial<ComponentProps<typeof AssetCard>> = {}) {
  const sinceSec = over.sinceSec ?? MARCH;
  return renderWithClient(
    <AssetCard
      group={eth}
      derived={deriveAsset(eth, {}, sinceSec, NOW, undefined)}
      sinceSec={sinceSec}
      windowPending={false}
      storedSinceSec={MARCH}
      defaultSinceSec={JUNE}
      onChangeSince={vi.fn()}
      backfilling={false}
      supportedCoins={['ETH', 'HYPE', 'BTC']}
      exclusions={{}}
      onExclude={vi.fn()}
      {...over}
    />,
  );
}

describe('AssetCard while older Boros history loads', () => {
  beforeEach(() => server.use(...baseHandlers()));

  it('covers the PnL box with the reading overlay, and only that box', () => {
    renderCard({ backfilling: true });
    const reading = screen.getByText('Reading Boros payments since 1 Mar…');
    const box = screen.getByText('Total PnL').closest('[aria-busy="true"]');
    expect(box).not.toBeNull();
    expect(box).toContainElement(reading);
  });

  it('shows no overlay once the read is done', () => {
    renderCard({ backfilling: false });
    expect(screen.queryByText(/Reading Boros payments/)).toBeNull();
    expect(screen.getByText('Total PnL').closest('[aria-busy]')).toBeNull();
  });
});
