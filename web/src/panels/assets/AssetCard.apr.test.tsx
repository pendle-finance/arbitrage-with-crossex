/**
 * The asset hero's APR. A fully locked book shows its fixed rate exactly as
 * before; a book that is NOT fully locked — which used to show "—" — shows an
 * estimate instead, labelled without "(Fixed)" and split into its fixed and
 * floating parts (his call 2026-10-01).
 */
import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AssetBorosOpen, AssetGroup, AssetPerpOpen } from '../../api/types';
import { server } from '../../test/server';
import { renderWithClient } from '../../test/utils';
import { AssetCard } from './AssetCard';
import { deriveAsset } from './assetModel';

const DAY = 86_400;
const PX = 2500;

const perp = (venue: string, side: 'LONG' | 'SHORT', fundingApr7d: number): AssetPerpOpen => ({
  symbol: `${venue}_FUTURE_ETH_USDT`,
  venue,
  side,
  qty: 100,
  notionalUsd: 100 * PX,
  entryPrice: PX,
  markPrice: PX,
  leverage: 10,
  upnlUsd: 0,
  fundingUsd: 0,
  feesUsd: 0,
  imUsd: 25_000,
  openedAt: Math.floor(Date.now() / 1000) - 10 * DAY,
  fundingApr7d,
});

const yu = (marketId: number, venue: string, side: 'LONG' | 'SHORT', sizeToken: number, entryApr: number): AssetBorosOpen => ({
  marketId,
  venue,
  side,
  sizeToken,
  maturity: Math.floor(Date.now() / 1000) + 40 * DAY,
  collateral: 'ETH',
  notionalUsd: sizeToken * PX,
  entryApr,
  markApr: entryApr,
  floatingApr: 0.09,
  settleUsd: 0,
  mtmUsd: 0,
  imUsd: sizeToken * 100,
});

/** 100 ETH long Gate / short Hyperliquid, with `locked` ETH of rate legs on each. */
const book = (locked: number): AssetGroup => ({
  base: 'ETH',
  supported: true,
  priceUsd: PX,
  earliestSec: Math.floor(Date.now() / 1000) - 10 * DAY,
  // Gate's LONG paid 4%; Hyperliquid's SHORT received 10%.
  perpOpen: [perp('GATE', 'LONG', -0.04), perp('HYPERLIQUID', 'SHORT', 0.1)],
  perpClosed: [],
  borosOpen: [yu(1, 'GATE', 'LONG', locked, 0.04), yu(2, 'HYPERLIQUID', 'SHORT', locked, 0.08)],
  borosHistory: [],
});

const renderCard = (group: AssetGroup) =>
  renderWithClient(
    <AssetCard
      group={group}
      derived={deriveAsset(group, {}, 0, Math.floor(Date.now() / 1000))}
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

beforeEach(() => {
  server.use(
    http.get('/api/positions', () => HttpResponse.json({ positions: [] })),
    http.get('/api/boros/pair/context', () =>
      HttpResponse.json({ ok: true, data: { markets: [], crossByToken: [], isolatedByMarket: [], defaultSlippageApr: 0.005, maxSlippageApr: 0.05 } }),
    ),
  );
});

describe('the asset hero APR', () => {
  it('a fully locked book keeps "Current APR (Fixed)" and its fixed rate, with no split', () => {
    renderCard(book(100));
    expect(screen.getByText('Current APR (Fixed)')).toBeInTheDocument();
    expect(screen.queryByText(/· Floating/)).not.toBeInTheDocument();
  });

  it('a part-locked book shows the estimate where the dash was, split fixed and floating', () => {
    renderCard(book(60));
    expect(screen.queryByText('Current APR (Fixed)')).not.toBeInTheDocument();
    const label = screen.getByText('Current APR');
    // The hover names each venue's unlocked size and the funding it used —
    // as two-cell rows, so the value cell stays short enough not to overflow.
    const title = label.parentElement?.getAttribute('title') ?? '';
    expect(title).toMatch(/^Gate\tLONG \$100(\.0)?k · 4\.00%$/m);
    expect(title).toMatch(/^Hyperliquid\tSHORT \$100(\.0)?k · 10\.00%$/m);
    for (const row of title.split('\n').filter((l) => l.includes('\t'))) {
      expect(row.split('\t')).toHaveLength(2);
    }

    // Capital: 2 × $25,000 perps + 2 × 6,000 rate legs = $62,000.
    // Fixed: (8% − 4%) on 60 ETH = $6,000. Floating: 40 ETH × (10% − 4%) = $6,000.
    const split = screen.getByText(/· Floating/).closest('div') as HTMLElement;
    expect(split).toHaveTextContent('Fixed 9.68% · Floating 9.68%');
    expect(screen.getByText('19.35%')).toBeInTheDocument();
  });
});
