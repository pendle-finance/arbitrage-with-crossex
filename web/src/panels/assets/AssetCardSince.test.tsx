import { screen } from '@testing-library/react';
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

function renderCard(storedSinceSec: number | undefined) {
  const sinceSec = storedSinceSec ?? JUNE;
  return renderWithClient(
    <AssetCard
      group={eth}
      derived={deriveAsset(eth, {}, sinceSec, NOW, undefined)}
      sinceSec={sinceSec}
      windowPending={false}
      storedSinceSec={storedSinceSec}
      defaultSinceSec={JUNE}
      onChangeSince={vi.fn()}
      backfilling={false}
      supportedCoins={['ETH', 'HYPE', 'BTC']}
      exclusions={{}}
      onExclude={vi.fn()}
    />,
  );
}

describe('AssetCard since chip on the full card', () => {
  beforeEach(() => server.use(...baseHandlers()));

  it('shows no all time link on a default or a moved card, no all-time link', () => {
    // MERGE 2026-09-21: scope the check to the since chip CONTROL (role=button)
    // instead of raw text — Hubert's redesigned card added an unrelated
    // "All time Cost" metric label that a broad /all time/i text query catches.
    const { unmount } = renderCard(undefined);
    expect(screen.queryByRole('button', { name: /all time/i })).toBeNull();
    unmount();

    renderCard(MARCH);
    expect(screen.queryByRole('button', { name: /all time/i })).toBeNull();
  });
});
