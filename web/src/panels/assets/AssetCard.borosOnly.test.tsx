/**
 * The Boros-only pair card: two offsetting rate legs whose perps are missing.
 * A perp that covers only part of its side is shown, with the rest of that
 * side as its own "missing" row; "Open both perps" sizes both sides alike, so
 * it is offered only while the two gaps match.
 */
import { fireEvent, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AssetBorosOpen, AssetGroup, AssetPerpOpen } from '../../api/types';
import { fmtDateLocal } from '../../lib/fmt';
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
  spreadVenues: null,
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
    expect(within(table).getAllByText('missing 100 ETH')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Open both perps' })).toBeInTheDocument();
  });

  it('a part-covering perp reads held / target on one row, and "Open both perps" is withheld', () => {
    renderCard(book([perp('GATE', 'LONG', 40)]));
    const table = legTable();
    const rows = within(table).getAllByRole('row').slice(1);
    // Gate perp (40 of 100), Hyperliquid perp (0 of 100), two rate legs.
    expect(rows).toHaveLength(4);
    const missing = rows.filter((r) => within(r).queryByText(/^missing /));
    expect(missing).toHaveLength(2);
    expect(missing[0]).toHaveTextContent(/missing 60 ETH40 \/ 100 ETH/);
    expect(missing[1]).toHaveTextContent(/missing 100 ETH0 \/ 100 ETH/);
    // The gaps differ (60 vs 100): one prefill would under-hedge the short side.
    expect(screen.queryByRole('button', { name: 'Open both perps' })).toBeNull();
    expect(within(table).getAllByRole('button', { name: 'Open leg' })).toHaveLength(2);
  });

  it('gaps that differ by under $25 a side are even: "Open both perps" stays, at the smaller gap', () => {
    // 60 vs 59.995 ETH missing: 0.005 ETH is $12.50, rounding between venues.
    renderCard(book([perp('GATE', 'LONG', 40), perp('HYPERLIQUID', 'SHORT', 40.005)]));
    expect(screen.getByRole('button', { name: 'Open both perps' })).toHaveAttribute('title', expect.stringMatching(/60 ETH each$/));
  });

  it('gaps 1 ETH apart ($2,500) are not even: each side opens from its own row', () => {
    renderCard(book([perp('GATE', 'LONG', 40), perp('HYPERLIQUID', 'SHORT', 41)]));
    expect(screen.queryByRole('button', { name: 'Open both perps' })).toBeNull();
  });

  it('at size, a gap the compact label would hide prints exact: not "2.4k / 2.4k ETH"', () => {
    const g = book([perp('GATE', 'LONG', 2_351)]);
    g.borosOpen = [yu(1, 'GATE', 'LONG', 2_400, 0.04), yu(2, 'HYPERLIQUID', 'SHORT', 2_400, 0.08)];
    renderCard(g);
    const rows = within(legTable()).getAllByRole('row').slice(1);
    const gate = rows.find((r) => /Gate/.test(r.textContent ?? '') && /CrossEx/.test(r.textContent ?? ''));
    expect(gate?.textContent).not.toMatch(/2\.4k \/ 2\.4k/);
    expect(gate?.textContent).toMatch(/2,351 \/ 2,400 ETH/);
  });

  it("shows each rate leg's venue liquidation APR, looked up by market id", () => {
    const g = book([]);
    g.borosOpen = [
      { ...g.borosOpen[0], liquidationApr: 0.015 },
      { ...g.borosOpen[1], liquidationApr: 0.123 },
    ];
    renderCard(g);
    const table = legTable();
    expect(within(table).getByText('liq 1.50%')).toBeInTheDocument();
    expect(within(table).getByText('liq 12.30%')).toBeInTheDocument();
  });

  it('shows N/A, as the Boros app does, past max(250%, 10 × |mark|)', () => {
    const g = book([]);
    g.borosOpen = [
      { ...g.borosOpen[0], markApr: 0.05, liquidationApr: -9.57 },
      { ...g.borosOpen[1], markApr: 0.05, liquidationApr: 2.4 },
    ];
    renderCard(g);
    const table = legTable();
    expect(within(table).getByText('liq N/A')).toHaveAttribute(
      'title',
      'Position risk is low, so there is no liquidation rate for the time being.',
    );
    expect(within(table).getByText('liq 240.00%')).toBeInTheDocument();
  });

  /** 100 ETH hedged at OLD, and the same venues' rate legs at NEW: what a roll that keeps the old legs leaves. */
  const rolledBook = (newSize: number, hlPerp = 100): AssetGroup => ({
    base: 'ETH',
    supported: true,
    priceUsd: PX,
    earliestSec: NOW - 10 * DAY,
    perpOpen: [perp('GATE', 'LONG', 100), perp('HYPERLIQUID', 'SHORT', hlPerp)],
    perpClosed: [],
    borosOpen: [
      { ...yu(1, 'GATE', 'LONG', 100, 0.04), maturity: NOW + 8 * DAY },
      { ...yu(2, 'HYPERLIQUID', 'SHORT', 100, 0.08), maturity: NOW + 8 * DAY },
      { ...yu(11, 'GATE', 'LONG', newSize, 0.04), maturity: NOW + 45 * DAY },
      { ...yu(12, 'HYPERLIQUID', 'SHORT', newSize, 0.08), maturity: NOW + 45 * DAY },
    ],
    borosHistory: [],
  });
  const missingCard = () => screen.getByText('Perp legs missing').closest('div.overflow-x-auto') as HTMLElement;

  it('a roll that keeps the old legs: the new date holds the perps, the old legs show what they lack (mozzarella 2026-10-17)', () => {
    renderCard(rolledBook(100));
    expect(screen.queryByText(/^Rolled · covered from/)).toBeNull();
    const card = missingCard();
    expect(card).toHaveTextContent(`matures ${fmtDateLocal(NOW + 8 * DAY)}`);
    const table = within(card).getByRole('columnheader', { name: 'Leg' }).closest('table') as HTMLElement;
    // The badge names the gap; Size keeps held / needed.
    const gaps = within(table).getAllByText('missing 100 ETH');
    expect(gaps).toHaveLength(2);
    expect(gaps[0].closest('tr')).toHaveTextContent('0 / 100 ETH');
    expect(within(card).getByRole('button', { name: 'Open both perps' })).toBeInTheDocument();
  });

  it('a part perp left on the old card shows held / needed, and the badge the rest', () => {
    renderCard(rolledBook(100, 110));
    const table = within(missingCard()).getByRole('columnheader', { name: 'Leg' }).closest('table') as HTMLElement;
    const hl = within(table)
      .getAllByRole('row')
      .filter((r) => /HyperliquidCrossEx/.test(r.textContent ?? ''));
    expect(hl.map((r) => r.textContent)).toEqual([expect.stringMatching(/^HyperliquidCrossExSHORTmissing 90 ETH10 \/ 100 ETH/)]);
  });

  it('a Boros leg shared with another card shows its percent, and the hover breaks it down', () => {
    const g = book([]);
    g.borosOpen = [yu(1, 'GATE', 'LONG', 150, 0.04), yu(2, 'HYPERLIQUID', 'SHORT', 100, 0.08)];
    renderCard(g);
    const pct = within(legTable()).getByText('(66.67%)');
    expect(pct).toHaveAttribute(
      'title',
      ['This pair uses 66.67% of the position', 'Whole position\t150 ETH', 'This pair\t100 ETH', 'Other cards\t50 ETH'].join('\n'),
    );
    // The ungrouped card holds the other 50 ETH.
    fireEvent.click(screen.getByText('Ungrouped legs'));
    expect(screen.getByText('(33.33%)')).toHaveAttribute(
      'title',
      ['33.33% of the position is unpaired', 'Whole position\t150 ETH', 'Unpaired\t50 ETH', 'In pairs\t100 ETH'].join('\n'),
    );
  });

  it('a roll into a bigger size: the new date takes the perps, and both dates show what they lack', () => {
    // 100 hedged at OLD; 500 opened at NEW. The perps go to NEW; 400 at NEW and all 100 at OLD lack perps.
    renderCard(rolledBook(500));
    expect(screen.queryByText(/^Rolled · covered from/)).toBeNull();
    expect(screen.getAllByText('Perp legs missing')).toHaveLength(2);
  });
});
