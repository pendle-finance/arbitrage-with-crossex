import { fireEvent, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RebalanceJob } from '../api/types';
import { makeDealView, makeRebalanceView } from '../test/fixtures';
import { env, server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { RecoveryBanner } from './RecoveryBanner';
import { TradeFlowProvider } from './TradeFlow';

const openDealMock = vi.fn();
const openRebalanceMock = vi.fn();
vi.mock('../panels/rebalanceOpener', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../panels/rebalanceOpener')>()),
  useRebalanceOpener: () => openRebalanceMock,
}));
vi.mock('./TradeFlow', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./TradeFlow')>()),
  useTradeFlow: () => ({ modalOpen: false, openDeal: openDealMock }),
}));

afterEach(() => {
  vi.clearAllMocks();
});

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

function twapJob(overrides: Partial<RebalanceJob> = {}): RebalanceJob {
  return {
    id: 'job1',
    kind: 'twap',
    status: 'running',
    twap: { slice: 3, of: 12, makerLeg: 'a' },
    legs: [
      { name: 'Gate', exchange: 'gate', symbol: 'GATE_FUTURE_ETH_USDT', side: 'LONG', reduceOnly: false },
      { name: 'Binance', exchange: 'binance', symbol: 'BINANCE_FUTURE_ETH_USDT', side: 'SHORT', reduceOnly: false },
    ],
    ...overrides,
  } as unknown as RebalanceJob;
}

function renderTwap(job: RebalanceJob, deals: ReturnType<typeof makeDealView>[] = []) {
  server.use(
    http.get('/api/rebalance', () => HttpResponse.json(env({ ...makeRebalanceView(), job }))),
  );
  return renderBanner(deals);
}

describe('RecoveryBanner', () => {
  it('a realize TWAP shows its own band and hides its child deals', async () => {
    const realize = twapJob({
      kind: 'realize',
      legs: [],
      realize: { legs: [{ symbol: 'HYPERLIQUID_FUTURE_ETH_USDC', exchange: 'HYPERLIQUID', base: 'ETH' }] },
      steps: [{ name: 'Slices', status: 'running', perp: { symbol: 'HYPERLIQUID_FUTURE_ETH_USDC' } }],
    } as unknown as Partial<RebalanceJob>);
    const child = makeDealView();
    renderTwap(realize, [{ ...child, pair: { ...child.pair, id: 'job1-s3-1' } }]);
    expect(await screen.findByRole('alert')).toHaveTextContent('TWAP · Realize uPnL · ETH · slice 3/12');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it('a realize TWAP that a venue halted names the venue of its leg', async () => {
    const realize = twapJob({
      kind: 'realize',
      status: 'halted',
      haltKind: 'hedge-margin',
      legs: [],
      realize: { legs: [{ symbol: 'GATE_FUTURE_BTC_USDT', exchange: 'GATE', base: 'BTC' }] },
      steps: [],
    } as unknown as Partial<RebalanceJob>);
    renderTwap(realize);
    expect(await screen.findByRole('alert')).toHaveTextContent('TWAP paused: Gate refused the hedge · Realize uPnL · BTC · slice 3/12');
  });

  it('twap band', async () => {
    renderTwap(twapJob());
    expect(await screen.findByRole('alert')).toHaveTextContent('TWAP · ETH pair open · slice 3/12');
    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    expect(openRebalanceMock).toHaveBeenCalled();
  });

  it('no deal band for a twap child', async () => {
    renderTwap(twapJob(), [makeDealView({ pair: { id: 'job1-s3-1', mode: 'OPENING' } })]);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('TWAP · ETH pair open');
    expect(alert).not.toHaveTextContent(/deal is still working/i);
  });

  it('paused band', async () => {
    renderTwap(twapJob({ paused: true }));
    expect(await screen.findByRole('alert')).toHaveTextContent('TWAP paused · ETH pair open · slice 3/12');
  });

  it('restart band', async () => {
    renderTwap(twapJob({ status: 'halted', haltKind: 'restart' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'TWAP paused: app restarted · ETH pair open · slice 3/12',
    );
  });

  it('refused band', async () => {
    renderTwap(twapJob({ status: 'halted', haltKind: 'refused', twap: { slice: 4, of: 12, makerLeg: 'a' } as never }));
    expect(await screen.findByRole('alert')).toHaveTextContent('TWAP paused: Gate refused slice 4 · ETH pair open');
  });

  it('a size refusal names the slice and the venue of the breach, not a venue refusal', async () => {
    const sizeRefusal = { slice: 7, venue: 'Binance', limit: '$20', bound: 'min' as const, wholeRest: false };
    renderTwap(twapJob({ status: 'halted', haltKind: 'refused', sizeRefusal, twap: { slice: 6, of: 12, makerLeg: 'a' } as never }));
    expect(await screen.findByRole('alert')).toHaveTextContent("TWAP paused: slice 7 under Binance's $20 minimum · ETH pair open");
  });

  it('a close names the coin from the symbol and says close', async () => {
    const legs = twapJob().legs!.map((leg) => ({ ...leg, reduceOnly: true }));
    renderTwap(twapJob({ legs }));
    expect(await screen.findByRole('alert')).toHaveTextContent('TWAP · ETH pair close · slice 3/12');
  });

  it('a one-leg run is named as the run view names it', async () => {
    renderTwap(twapJob({ legs: twapJob().legs!.slice(0, 1) }));
    expect(await screen.findByRole('alert')).toHaveTextContent('TWAP · ETH long open · Gate · slice 3/12');
  });

  it('a hedge refusal names the hedge venue, not the limit venue', async () => {
    renderTwap(twapJob({ status: 'halted', haltKind: 'hedge-margin' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('TWAP paused: Binance refused the hedge · ETH pair open · slice 3/12');
  });

  it('a rest left after the last slice says opened for an open and closed for a close', async () => {
    const { unmount } = renderTwap(twapJob({ status: 'halted', haltKind: 'capped-rest' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('TWAP paused: rest not opened · ETH pair open');
    unmount();
    const legs = twapJob().legs!.map((leg) => ({ ...leg, reduceOnly: true }));
    renderTwap(twapJob({ status: 'halted', haltKind: 'capped-rest', legs }));
    expect(await screen.findByRole('alert')).toHaveTextContent('TWAP paused: rest not closed · ETH pair close');
  });

  it('pausing reads differently from running', async () => {
    renderTwap(twapJob({ pauseRequested: true }));
    expect(await screen.findByRole('alert')).toHaveTextContent('TWAP pausing · ETH pair open · slice 3/12');
  });

  it('a Delever TWAP halted at the Boros close shows its strip', async () => {
    const legs = twapJob().legs!.map((leg) => ({ ...leg, reduceOnly: true }));
    renderTwap(twapJob({ kind: 'delever', status: 'halted', haltKind: 'boros', legs }), [
      makeDealView({ pair: { id: 'job1-s3-1', mode: 'OPENING' } }),
    ]);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('TWAP paused: Boros close refused · ETH pair close');
    expect(alert).not.toHaveTextContent(/deal is still working/i);
  });

  it('a halted plain deal still shows under the TWAP strip', async () => {
    renderTwap(twapJob(), [makeDealView({ pair: { id: 'plain1', mode: 'HALTED' } })]);
    await screen.findByText(/halted — needs you/);
    expect(screen.getAllByRole('alert')).toHaveLength(2);
  });

  it('a failed deal read says so', async () => {
    server.use(
      http.get('/api/deals', () => HttpResponse.json({ ok: false, error: { category: 'network', message: 'boom', retryable: true } }, { status: 500 })),
      http.get('/api/alerts', () => HttpResponse.json(env([]))),
    );
    renderWithClient(
      <TradeFlowProvider>
        <RecoveryBanner />
      </TradeFlowProvider>,
    );
    expect(await screen.findByRole('alert', {}, { timeout: 5000 })).toHaveTextContent('Could not load live deals. One may be working.');
  });

  it('a run that ends leaves a done note', async () => {
    let job = twapJob();
    server.use(http.get('/api/rebalance', () => HttpResponse.json(env({ ...makeRebalanceView(), job }))));
    renderBanner([]);
    await screen.findByText(/TWAP · ETH pair open/);
    job = twapJob({ status: 'done' });
    expect(await screen.findByText('TWAP done · ETH pair open', {}, { timeout: 4000 })).toBeInTheDocument();
  });

  it('never deal keeps its band', async () => {
    renderBanner([makeDealView({ pair: { id: 'plain1', mode: 'OPENING', deadlineAt: null } })]);
    expect(await screen.findByRole('alert')).toHaveTextContent(/deal is still working/i);
    expect(screen.getByRole('button', { name: 'View' })).toBeInTheDocument();
  });

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
    expect(await screen.findByRole('alert')).toHaveTextContent(/halted — needs you/);
  });

  it('standing engine alerts render with an ack control when no deal is active', async () => {
    renderBanner([], [{ id: 1, ts: 0, level: 'error', pairId: null, message: 'hedge wall: retries failing', ack: 0 }]);
    expect(await screen.findByRole('alert')).toHaveTextContent(/hedge wall/);
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
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

  it('an engine alert with a pair id opens that deal', async () => {
    renderBanner(
      [],
      [{ id: 1, ts: 0, level: 'error', pairId: 'deal-1', message: 'hedge wall: retries failing', ack: 0 }],
    );
    fireEvent.click(await screen.findByRole('button', { name: 'View' }));
    expect(openDealMock).toHaveBeenCalledWith('deal-1');
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

  describe('own account line', () => {
    const NOTE = "This TWAP runs on this terminal's Gate account.";
    const A = '0x1111111111111111111111111111111111111111';
    const B = '0x2222222222222222222222222222222222222222';
    const agent = (root: string | null) =>
      http.get('/api/boros/agent', () =>
        HttpResponse.json(env({ configured: root !== null, root, rootMasked: null, accountId: 1, expiry: null, expired: false, canProvision: true, approval: 'approved' })),
      );

    afterEach(() => localStorage.clear());

    it('shows in view-only mode', async () => {
      localStorage.setItem('crossex.strategy.v1', JSON.stringify({ address: B, walletUpgraded: true }));
      server.use(agent(A));
      renderTwap(twapJob());
      expect(await screen.findByText(NOTE)).toBeTruthy();
    });

    it('shows when logged out', async () => {
      server.use(agent(null));
      renderTwap(twapJob());
      expect(await screen.findByText(NOTE)).toBeTruthy();
    });

    it('is absent in normal mode', async () => {
      localStorage.setItem('crossex.strategy.v1', JSON.stringify({ address: A, walletUpgraded: true }));
      server.use(agent(A));
      renderTwap(twapJob());
      await screen.findByText(/TWAP · ETH pair open/);
      await new Promise((r) => setTimeout(r, 50));
      expect(screen.queryByText(NOTE)).toBeNull();
    });
  });
});
