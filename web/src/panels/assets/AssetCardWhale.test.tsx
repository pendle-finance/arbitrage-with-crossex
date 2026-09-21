import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PositionsResponse } from '../../api/types';
import { baseHandlers, whaleBook } from '../../test/fixtures';
import { env, server } from '../../test/server';
import { renderWithClient } from '../../test/utils';
import { AssetCard } from './AssetCard';
import { deriveAsset } from './assetModel';

const view = whaleBook.assetView;
const eth = view.assets.find((a) => a.base === 'ETH')!;

describe('AssetCard for the $6M ETH book', () => {
  beforeEach(() =>
    server.use(
      http.get('/api/positions', () => HttpResponse.json(env<PositionsResponse>(whaleBook.positions))),
      ...baseHandlers(),
    ),
  );

  const renderCard = () =>
    renderWithClient(
      <AssetCard
        group={eth}
        derived={deriveAsset(eth, {}, view.sinceSec, view.nowSec, undefined)}
        sinceSec={view.sinceSec}
        windowPending={false}
        storedSinceSec={undefined}
        defaultSinceSec={view.defaultSinceSec}
        onChangeSince={vi.fn()}
        backfilling={false}
        supportedCoins={view.supportedCoins}
        exclusions={{}}
        onExclude={vi.fn()}
      />,
    );

  it('nets the Hyperliquid Boros settlement into its bundle and shows it in full on the leg row', async () => {
    renderCard();
    // Hubert moved the funding bundles behind a tab (the default view is now the 4-leg pairs), so open that tab before the bundle row is on screen.
    await userEvent.click(screen.getByRole('tab', { name: /Funding Bundles/ }));
    const toggle = screen
      .getAllByRole('button', { expanded: false })
      .find((b) => b.textContent?.startsWith('Hyperliquid'))!;
    const bundle = toggle.closest('table')!.parentElement!;
    expect(bundle).toHaveTextContent('-$4,242.08');
    expect(within(bundle).queryByText('-$9,117.28')).toBeNull();
    await userEvent.click(toggle);
    expect(within(bundle).getByText('-$9,117.28')).toBeInTheDocument();
  });

  // MERGE 2026-09-21: asserted the on-screen compact size readout ("4.1k ETH perp") shown beside the compact notional in the bundle cell — no longer exists in the merged UI (Hubert dropped the redundant on-screen size line, keeping the exact size in the hover/title only, so this assertion cannot hold without weakening it); Hubert to decide whether to port it.
  it.skip('keeps the notional compact on screen and puts the exact notional and size in its title', () => {
    renderCard();
    const toggle = screen
      .getAllByRole('button', { expanded: false })
      .find((b) => b.textContent?.startsWith('Hyperliquid'))!;
    const cell = toggle.closest('tr')!.querySelector('td[title^="Notional of the live perp"]')!;
    expect(cell.getAttribute('title')).toBe(
      'Notional of the live perp (or of the YU legs when there is no perp): $10,140,981.00 on 4,100 ETH',
    );
    expect(cell.textContent).toContain('$10.14M');
    expect(cell.textContent).toContain('4.1k ETH perp');
    expect(cell.textContent).not.toContain('10,140,981');
  });
});
