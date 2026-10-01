/**
 * The Boros-only pair card: two offsetting rate legs whose perps are missing.
 * A perp that covers only part of its side is shown, with the rest of that
 * side as its own "missing" row; "Open both perps" sizes both sides alike, so
 * it is offered only while the two gaps match.
 */
import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AssetBorosOpen, AssetGroup, AssetPerpOpen } from '../../api/types';
import { server } from '../../test/server';
import { renderWithClient } from '../../test/utils';
import { AssetCard } from './AssetCard';
import { deriveAsset } from './assetModel';

const DAY = 86_400;
const PX = 2500;
const NOW = Math.floor(Date.now() / 1000);

const perp = (venue: string, side: 'LONG' | 'SHORT', qty: number): AssetPerpOpen => ({
  symbol: `${venue}_FUTURE_ETH_USDT`,
  venue,
  side,
  qty,
  notionalUsd: qty * PX,
  entryPrice: PX,
  markPrice: PX,
  leverage: 10,
  upnlUsd: 0,
  fundingUsd: 0,
  feesUsd: 0,
  imUsd: qty * 250,
  openedAt: NOW - 10 * DAY,
});

const yu = (marketId: number, venue: string, side: 'LONG' | 'SHORT', sizeToken: number, entryApr: number): AssetBorosOpen => ({
  marketId,
  venue,
  side,
  sizeToken,
  maturity: NOW + 40 * DAY,
  collateral: 'ETH',
  notionalUsd: sizeToken * PX,
  entryApr,
  markApr: entryApr,
  floatingApr: 0.09,
  settleUsd: 0,
  mtmUsd: 0,
  imUsd: sizeToken * 100,
});

/** 100 ETH long Gate / short Hyperliquid rate legs, plus whatever perps. */
const book = (perpOpen: AssetPerpOpen[]): AssetGroup => ({
  base: 'ETH',
  supported: true,
  priceUsd: PX,
  earliestSec: NOW - 10 * DAY,
  perpOpen,
  perpClosed: [],
  borosOpen: [yu(1, 'GATE', 'LONG', 100, 0.04), yu(2, 'HYPERLIQUID', 'SHORT', 100, 0.08)],
  borosHistory: [],
});

const renderCard = (group: AssetGroup) =>
  renderWithClient(
    <AssetCard
      group={group}
      derived={deriveAsset(group, {}, 0, NOW)}
      sinceSec={0}
      windowPending={false}
      storedSinceSec={undefined}
      defaultSinceSec={null}
      backfilling={false}
      supportedCoins={['ETH']}
      onChangeSince={() => {}}
      exclusions={{}}
      onExclude={() => {}}
    />,
  );

/** The expanded card's leg table (the one with a "Leg" header). */
const legTable = () => screen.getByRole('columnheader', { name: 'Leg' }).closest('table') as HTMLElement;

beforeEach(() => {
  server.use(
    http.get('/api/positions', () => HttpResponse.json({ positions: [] })),
    http.get('/api/boros/pair/context', () =>
      HttpResponse.json({ ok: true, data: { markets: [], crossByToken: [], isolatedByMarket: [], defaultSlippageApr: 0.005, maxSlippageApr: 0.05 } }),
    ),
  );
});

describe('BorosOnlyPairCard', () => {
  it('both perps missing: two gap rows and "Open both perps"', () => {
    renderCard(book([]));
    expect(screen.getByText('Perp legs missing')).toBeInTheDocument();
    const table = legTable();
    expect(within(table).getAllByText('missing')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Open both perps' })).toBeInTheDocument();
  });

  it('a part-covering perp is shown, the rest of its side is a gap, and "Open both perps" is withheld', () => {
    renderCard(book([perp('GATE', 'LONG', 40)]));
    const table = legTable();
    const rows = within(table).getAllByRole('row').slice(1);
    // Gate perp (held 40), Gate perp gap (60), Hyperliquid perp gap (100), two rate legs.
    expect(rows).toHaveLength(5);
    const missing = rows.filter((r) => within(r).queryByText('missing'));
    expect(missing).toHaveLength(2);
    expect(missing[0]).toHaveTextContent(/60/);
    expect(missing[1]).toHaveTextContent(/100/);
    expect(rows[0]).toHaveTextContent(/40/);
    expect(within(rows[0]).queryByText('missing')).toBeNull();
    // The gaps differ (60 vs 100): one prefill would under-hedge the short side.
    expect(screen.queryByRole('button', { name: 'Open both perps' })).toBeNull();
    expect(within(table).getAllByRole('button', { name: 'Open leg' })).toHaveLength(2);
  });
});
