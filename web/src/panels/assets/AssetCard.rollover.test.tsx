/**
 * The roll-over path through the asset card: a pair whose rate legs mature
 * inside the 14-day window is counted once in the banner, flagged on its
 * card in the 4 Leg Pairs tab, and offered a Roll over button that opens
 * the popup. A pair outside the window gets none of it.
 */
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AssetBorosOpen, AssetGroup, AssetPerpOpen } from '../../api/types';
import { server } from '../../test/server';
import { renderWithClient } from '../../test/utils';
import { AssetCard } from './AssetCard';
import { deriveAsset } from './assetModel';

const DAY = 86_400;

const perp = (o: Partial<AssetPerpOpen> & { venue: string; side: 'LONG' | 'SHORT'; qty: number }): AssetPerpOpen => ({
  symbol: `${o.venue}_FUTURE_ETH_USDT`,
  notionalUsd: o.qty * 2500,
  entryPrice: 2500,
  markPrice: 2500,
  leverage: 10,
  upnlUsd: 0,
  fundingUsd: 0,
  feesUsd: 0,
  imUsd: o.qty * 250,
  openedAt: Math.floor(Date.now() / 1000) - 10 * DAY,
  ...o,
});

const yu = (o: Partial<AssetBorosOpen> & { marketId: number; venue: string; side: 'LONG' | 'SHORT'; sizeToken: number; maturity: number }): AssetBorosOpen => ({
  collateral: 'ETH',
  notionalUsd: o.sizeToken * 2500,
  entryApr: 0.08,
  markApr: 0.08,
  floatingApr: 0.09,
  settleUsd: 0,
  mtmUsd: 0,
  imUsd: o.sizeToken * 100,
  ...o,
});

/** One Gate/Hyperliquid pair of 100 ETH, maturing `days` from now. */
const book = (days: number): AssetGroup => {
  const now = Math.floor(Date.now() / 1000);
  return {
    base: 'ETH',
    priceUsd: 2500,
    earliestSec: now - 10 * DAY,
    perpOpen: [perp({ venue: 'GATE', side: 'LONG', qty: 100 }), perp({ venue: 'HYPERLIQUID', side: 'SHORT', qty: 100 })],
    perpClosed: [],
    borosOpen: [
      yu({ marketId: 1, venue: 'GATE', side: 'LONG', sizeToken: 100, maturity: now + days * DAY, entryApr: 0.04 }),
      yu({ marketId: 2, venue: 'HYPERLIQUID', side: 'SHORT', sizeToken: 100, maturity: now + days * DAY }),
    ],
    borosHistory: [],
  };
};

const renderCard = (group: AssetGroup) =>
  renderWithClient(
    <AssetCard
      group={group}
      derived={deriveAsset(group, {}, 0, Math.floor(Date.now() / 1000))}
      sinceSec={0}
      windowPending={false}
      onChangeSince={() => {}}
      exclusions={{}}
      onExclude={() => {}}
    />,
  );

beforeEach(() => {
  // The card polls the live positions for its close tickets; nothing here closes.
  server.use(
    http.get('/api/positions', () => HttpResponse.json({ positions: [] })),
    // The popup gates its confirm on the agent key's status.
    http.get('/api/boros/agent', () =>
      HttpResponse.json({ ok: true, data: { configured: true, root: null, rootMasked: null, accountId: 0, expiry: null, expired: false, canProvision: true }, meta: { ts: Date.now() } }),
    ),
    // Roll targets come from the pairable universe, not this book's own
    // legs: an empty list is what "nothing to roll into" looks like.
    http.get('/api/boros/pair/context', () =>
      HttpResponse.json({ ok: true, data: { markets: [], crossByToken: [], isolatedByMarket: [], defaultSlippageApr: 0.005, maxSlippageApr: 0.05 } }),
    ),
  );
});

describe('AssetCard — roll over', () => {
  it('"Show me" re-opens a rollable pair the user had folded', async () => {
    renderCard(book(10));
    await userEvent.click(screen.getByRole('button', { name: /that you can roll over/ }));
    const panel = screen.getByRole('tabpanel', { name: /4 Leg Pairs/ });
    // Opened by default (it can roll) — fold it by hand.
    expect(within(panel).getByRole('button', { name: 'Roll over' })).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('button', { name: /Gate \/ S Hyperliquid/ }));
    expect(within(panel).queryByRole('button', { name: 'Roll over' })).not.toBeInTheDocument();
    // The banner must show it again, not leave the fold as the user left it.
    await userEvent.click(screen.getByRole('button', { name: /that you can roll over/ }));
    expect(within(panel).getByRole('button', { name: 'Roll over' })).toBeInTheDocument();
  });

  it('a pair maturing in 10 days: one banner, a flag and a button on its card, a placeholder popup', async () => {
    renderCard(book(10));
    // The banner counts pairs and sends the trader to the pairs tab.
    const banner = screen.getByRole('button', { name: /You have 1 pair that you can roll over/ });
    expect(screen.getByRole('tab', { name: /Funding Bundles/ })).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(banner);
    expect(screen.getByRole('tab', { name: /4 Leg Pairs/ })).toHaveAttribute('aria-selected', 'true');

    // The summary row carries the FLAG; the action lives in the expansion —
    // and a rollable pair opens EXPANDED, so the action is already on
    // screen (his call 2026-09-18). No click on the row: that would fold it.
    const panel = screen.getByRole('tabpanel', { name: /4 Leg Pairs/ });
    expect(within(panel).getByText('ready to roll')).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('button', { name: 'Roll over' }));

    // The popup names the pair; with nothing to roll into there is no target,
    // so the pick page's "Roll over →" stays disabled.
    const dialog = screen.getByRole('dialog');
    // Venues only — the maturity heads the Exit card inside (his call 2026-09-18).
    expect(within(dialog).getByRole('heading', { name: 'Roll over — Gate / Hyperliquid' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Roll over →' })).toBeDisabled();
    // No maturity lists a market at BOTH venues, so there is nothing to roll
    // into -- the table says so rather than inventing a target.
    expect(await within(dialog).findByText(/No later maturity lists a market at BOTH venues/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('a pair maturing in 40 days: no banner, no flag, no button', () => {
    renderCard(book(40));
    expect(screen.queryByText(/that you can roll over/)).not.toBeInTheDocument();
    expect(screen.queryByText('ready to roll')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Roll over' })).not.toBeInTheDocument();
  });
});
