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

  it('nets the Hyperliquid Boros settlement into its bundle and shows it in full on the leg row', async () => {
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
    const toggle = screen
      .getAllByRole('button', { expanded: false })
      .find((b) => b.textContent?.startsWith('Hyperliquid'))!;
    const bundle = toggle.closest('table')!.parentElement!;
    expect(bundle).toHaveTextContent('-$4,242.08');
    expect(within(bundle).queryByText('-$9,117.28')).toBeNull();
    await userEvent.click(toggle);
    expect(within(bundle).getByText('-$9,117.28')).toBeInTheDocument();
  });
});
