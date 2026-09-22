import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetGroup } from '../../api/types';
import { baseHandlers } from '../../test/fixtures';
import { server } from '../../test/server';
import { renderWithClient } from '../../test/utils';
import { AssetCard } from './AssetCard';
import { deriveAsset } from './assetModel';

const NOW = Date.UTC(2026, 8, 21, 12) / 1000;
const SINCE = Date.UTC(2026, 5, 23, 12) / 1000;
const STALE_AT = new Date(2026, 8, 21, 14, 32).getTime();

const eth: AssetGroup = {
  base: 'ETH',
  supported: true,
  priceUsd: 2473,
  earliestSec: SINCE,
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
      openedAt: SINCE,
    },
  ],
  perpClosed: [],
  borosOpen: [],
  borosHistory: [],
};

function renderCard(liquidation: { base: string; venue: string; sinceMs: number }) {
  return renderWithClient(
    <AssetCard
      group={eth}
      derived={deriveAsset(eth, {}, SINCE, NOW, undefined)}
      sinceSec={SINCE}
      windowPending={false}
      storedSinceSec={undefined}
      defaultSinceSec={SINCE}
      onChangeSince={vi.fn()}
      backfilling={false}
      supportedCoins={['ETH', 'HYPE', 'BTC']}
      exclusions={{}}
      onExclude={vi.fn()}
      liquidation={liquidation}
    />,
  );
}

describe('the asset card when Gate stops sending a mark', () => {
  beforeEach(() => server.use(...baseHandlers()));

  it('says there is no estimate, and names the venue and the time on hover', async () => {
    renderCard({ base: 'ETH', venue: 'Hyperliquid', sinceMs: STALE_AT });

    const trigger = screen.getByRole('button', { name: /No liquidation estimate/ });
    expect(trigger).toHaveTextContent('No liquidation estimate');

    await userEvent.hover(trigger);
    expect(
      await screen.findByText(
        'No liquidation estimate: Gate has not sent a price for the Hyperliquid leg since 14:32.',
      ),
    ).toBeInTheDocument();
  });
});
