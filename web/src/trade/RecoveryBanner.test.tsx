import { fireEvent, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { makeDealView } from '../test/fixtures';
import { env, server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { RecoveryBanner } from './RecoveryBanner';
import { TradeFlowProvider } from './TradeFlow';

function renderBanner(
  deals: ReturnType<typeof makeDealView>[],
  alerts: unknown[] = [],
  onOpenTab?: (tab: 'balances') => void,
) {
  server.use(
    http.get('/api/deals', () => HttpResponse.json(env(deals))),
    http.get('/api/alerts', () => HttpResponse.json(env(alerts))),
  );
  return renderWithClient(
    <TradeFlowProvider>
      <RecoveryBanner onOpenTab={onOpenTab} />
    </TradeFlowProvider>,
  );
}

describe('RecoveryBanner', () => {
  it('renders nothing with no active deals and no alerts', async () => {
    renderBanner([]);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('surfaces a working deal after a tab reload with a way back into the live view', async () => {
    renderBanner([makeDealView({ pair: { mode: 'OPENING' } })]);
    expect(await screen.findByRole('alert')).toHaveTextContent(/deal is still working/i);
    expect(screen.getByRole('button', { name: 'View' })).toBeInTheDocument();
  });

  it('a HALTED deal takes priority with the loud styling', async () => {
    renderBanner([
      makeDealView({ pair: { id: 'ok1', mode: 'OPENING' } }),
      makeDealView({ pair: { id: 'bad1', mode: 'HALTED' } }),
    ]);
    expect(await screen.findByRole('alert')).toHaveTextContent(/HALTED\. Operator needed\./);
  });

  it('standing engine alerts render with an ack control when no deal is active', async () => {
    renderBanner([], [{ id: 1, ts: 0, level: 'error', pairId: null, message: 'hedge wall: retries failing', ack: 0 }]);
    expect(await screen.findByRole('alert')).toHaveTextContent(/hedge wall/);
    expect(screen.getByRole('button', { name: 'ack' })).toBeInTheDocument();
  });

  it('rebalance alert has view', async () => {
    renderBanner(
      [],
      [
        {
          id: 1,
          ts: 0,
          level: 'error',
          pairId: 'rebalance:mtzunfww',
          message: 'Rebalance stopped in round 3. 36.58 USDC is in Gate spot.',
          ack: 0,
        },
      ],
      () => {},
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Rebalance stopped in round 3. 36.58 USDC is in Gate spot.',
    );
    expect(screen.getByRole('button', { name: 'View' })).toBeInTheDocument();
  });

  it('view opens balances', async () => {
    const onOpenTab = vi.fn();
    renderBanner(
      [],
      [
        {
          id: 1,
          ts: 0,
          level: 'error',
          pairId: 'rebalance:mtzunfww',
          message: 'Rebalance stopped in round 3. 36.58 USDC is in Gate spot.',
          ack: 0,
        },
      ],
      onOpenTab,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'View' }));
    expect(onOpenTab).toHaveBeenCalledWith('balances');
  });

  it('server alert row has view', async () => {
    renderBanner(
      [],
      [
        {
          id: 1,
          ts: 0,
          level: 'error',
          pair_id: 'rebalance:mtzunfww',
          message: 'Rebalance stopped in round 3. 36.58 USDC is in Gate spot.',
          ack: 0,
        },
      ],
      () => {},
    );
    expect(await screen.findByRole('button', { name: 'View' })).toBeInTheDocument();
  });
});
