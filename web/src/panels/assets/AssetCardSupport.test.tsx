import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetGroup, PositionsResponse } from '../../api/types';
import { baseHandlers, makeCrossexPosition } from '../../test/fixtures';
import { env, server } from '../../test/server';
import { renderWithClient } from '../../test/utils';
import { AssetCard } from './AssetCard';
import { deriveAsset } from './assetModel';

const NOW = Date.UTC(2026, 8, 18, 12) / 1000;
const JUNE = Date.UTC(2026, 5, 23, 12) / 1000;
const SOL_SYMBOL = 'GATE_FUTURE_SOL_USDT';

const sol: AssetGroup = {
  base: 'SOL',
  supported: false,
  priceUsd: 105.55,
  earliestSec: JUNE,
  perpOpen: [
    {
      symbol: SOL_SYMBOL,
      venue: 'GATE',
      side: 'LONG',
      qty: 2,
      notionalUsd: 211.1,
      entryPrice: 105,
      markPrice: 105.55,
      leverage: 5,
      upnlUsd: 1.1,
      fundingUsd: -0.11,
      feesUsd: 0.2,
      imUsd: 42.22,
      openedAt: JUNE,
    },
  ],
  perpClosed: [],
  borosOpen: [],
  borosHistory: [],
};

function renderSol() {
  return renderWithClient(
    <AssetCard
      group={sol}
      derived={deriveAsset(sol, {}, JUNE, NOW, undefined)}
      sinceSec={JUNE}
      windowPending={false}
      storedSinceSec={undefined}
      defaultSinceSec={JUNE}
      onChangeSince={vi.fn()}
      backfilling={false}
      supportedCoins={['ETH', 'HYPE', 'BTC']}
      exclusions={{}}
      onExclude={vi.fn()}
    />,
  );
}

describe('AssetCard for a held coin the terminal does not support', () => {
  beforeEach(() =>
    server.use(
      http.get('/api/positions', () =>
        HttpResponse.json(
          env<PositionsResponse>({
            positions: [makeCrossexPosition({ symbol: SOL_SYMBOL, positionQty: '2' })],
            exposure: [],
          }),
        ),
      ),
      ...baseHandlers(),
    ),
  );

  it('shows the amber line with what SOL loses and how to clear it, not supported line', () => {
    renderSol();
    const line = screen.getByText('No Telegram alerts and no new trades. Close its legs to clear this card.').parentElement!;
    expect(line).toHaveTextContent(/SOL is not supported/);
    expect(line).toHaveClass('border-amber-500/40', 'bg-amber-500/10', 'text-amber-400');
  });

  it('names the supported coins on hover, hover names the set', async () => {
    renderSol();
    await userEvent.hover(screen.getByRole('button', { name: /not supported/ }));
    expect(await screen.findByText('The terminal supports ETH, HYPE and BTC.')).toBeInTheDocument();
  });

  it('keeps Close leg on the SOL leg row, close leg stays', async () => {
    renderSol();
    const close = screen.getByRole('button', { name: /^Close .* LONG perp$/ });
    expect(close).toHaveTextContent('Close leg');
    await vi.waitFor(() =>
      expect(screen.getByRole('button', { name: /^Close .* LONG perp$/ })).not.toBeDisabled(),
    );
  });
});
