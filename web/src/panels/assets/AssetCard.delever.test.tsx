import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AssetBorosOpen, AssetGroup, AssetPerpOpen, RebalanceJob } from '../../api/types';
import { server, env } from '../../test/server';
import { makeRebalanceView, rebalanceHandler } from '../../test/fixtures';
import { renderWithClient } from '../../test/utils';
import { RebalanceOpenerProvider, useRebalanceOpenState } from '../rebalanceOpener';
import { AssetCard } from './AssetCard';
import { deriveAsset, type AssetDerived } from './assetModel';
import { openPairKey } from './pairs';

const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);
const MATURITY = NOW + 90 * DAY;

const perp = (venue: string, side: 'LONG' | 'SHORT', qty: number): AssetPerpOpen => ({
  symbol: `${venue}_FUTURE_ETH_USDT`,
  venue,
  side,
  qty,
  notionalUsd: qty * 2500,
  entryPrice: 2500,
  markPrice: 2500,
  leverage: 10,
  upnlUsd: 0,
  fundingUsd: 0,
  feesUsd: 0,
  imUsd: qty * 250,
  openedAt: NOW - 10 * DAY,
});

const yu = (marketId: number, venue: string, side: 'LONG' | 'SHORT', sizeToken: number): AssetBorosOpen => ({
  marketId,
  venue,
  side,
  sizeToken,
  maturity: MATURITY,
  spreadVenues: null,
  collateral: 'ETH',
  notionalUsd: sizeToken * 2500,
  entryApr: 0.08,
  markApr: 0.08,
  floatingApr: 0.09,
  settleUsd: 0,
  mtmUsd: 0,
  imUsd: sizeToken * 100,
});

const GROUP: AssetGroup = {
  base: 'ETH',
  supported: true,
  priceUsd: 2500,
  earliestSec: NOW - 10 * DAY,
  perpOpen: [perp('GATE', 'LONG', 100), perp('HYPERLIQUID', 'SHORT', 100)],
  perpClosed: [],
  borosOpen: [yu(1, 'GATE', 'LONG', 100), yu(2, 'HYPERLIQUID', 'SHORT', 100)],
  borosHistory: [],
};

const derivedOf = (unit: 'base' | 'usd' = 'base'): AssetDerived => {
  const derived = deriveAsset(GROUP, {}, 0, NOW);
  return { ...derived, pairs: derived.pairs.map((p) => ({ ...p, unit })) };
};

function OpenState() {
  const state = useRebalanceOpenState();
  return <output aria-label="opener">{state.open ? `${state.tab}|${state.pairKey}` : 'closed'}</output>;
}

const renderCard = (derived: AssetDerived) =>
  renderWithClient(
    <RebalanceOpenerProvider>
      <OpenState />
      <AssetCard
        group={GROUP}
        derived={derived}
        sinceSec={0}
        windowPending={false}
        storedSinceSec={undefined}
        defaultSinceSec={null}
        backfilling={false}
        supportedCoins={['ETH']}
        onChangeSince={() => {}}
        exclusions={{}}
        onExclude={() => {}}
      />
    </RebalanceOpenerProvider>,
  );

const openPair = async () => {
  const panel = screen.getByRole('tabpanel', { name: /^Fixed Rate Pairs/ });
  await userEvent.click(within(panel).getByRole('button', { name: /Gate LONG \/ Hyperliquid SHORT/ }));
  return panel;
};

const deleverJob = (over: Partial<RebalanceJob>): RebalanceJob => ({
  id: 'delv0001',
  goal: 'even',
  route: 'convert',
  amount: 0,
  costUsd: 40,
  target: null,
  status: 'running',
  stepIndex: 0,
  steps: [],
  fundsAt: 'CROSSEX',
  haltReason: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  inTransit: null,
  kind: 'delever',
  slice: { index: 3, count: 7, sizeUsd: 250_000 },
  delever: {
    pct: 20,
    legs: [
      { symbol: 'GATE_FUTURE_ETH_USDT', exchange: 'GATE', base: 'ETH', side: 'LONG', before: 100, after: 90 },
      { symbol: 'HYPERLIQUID_FUTURE_ETH_USDT', exchange: 'HYPERLIQUID', base: 'ETH', side: 'SHORT', before: 100, after: 90 },
    ],
    boros: [
      { marketId: 1, before: 100, after: 100, closed: 0 },
      { marketId: 2, before: 100, after: 100, closed: 0 },
    ],
  },
  ...over,
});

const withJob = (job: RebalanceJob | null) => {
  const served = { done: false };
  server.use(
    http.get('/api/rebalance', () => {
      served.done = true;
      return HttpResponse.json(env({ ...makeRebalanceView(), job }));
    }),
  );
  return served;
};

const pillAfterLoad = async (served: { done: boolean }) => {
  const panel = await openPair();
  await waitFor(() => expect(served.done).toBe(true));
  await act(async () => {});
  return within(panel).getByRole('button', { name: /^(Delever|Slice|Pausing|Paused|Stopped|Running)/ });
};

beforeEach(() => {
  server.use(
    http.get('/api/positions', () => HttpResponse.json(env({ positions: [], exposure: [] }))),
    http.get('/api/boros/pair/context', () =>
      HttpResponse.json(env({ markets: [], crossByToken: [], isolatedByMarket: [], defaultSlippageApr: 0.005, maxSlippageApr: 0.05 })),
    ),
    rebalanceHandler(),
  );
});

describe('AssetCard — Delever on the pair row', () => {
  it('delever before close perps', async () => {
    renderCard(derivedOf());
    const panel = await openPair();
    const delever = within(panel).getByRole('button', { name: 'Delever' });
    const closePerps = within(panel).getByRole('button', { name: 'Close perps' });
    expect(delever.compareDocumentPosition(closePerps) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(delever).toBeEnabled();
    expect(delever).toHaveAttribute('title', 'Make this pair smaller: both perps by the same coin size, then Boros.');
  });

  it('delever disabled on dollar pairs', async () => {
    renderCard(derivedOf('usd'));
    const panel = await openPair();
    const delever = within(panel).getByRole('button', { name: 'Delever' });
    const closePerps = within(panel).getByRole('button', { name: 'Close perps' });
    expect(delever).toBeDisabled();
    expect(closePerps).toBeDisabled();
    expect(delever.getAttribute('title')).toBe(closePerps.getAttribute('title'));
  });

  it('opens delever with the pair', async () => {
    const derived = derivedOf();
    renderCard(derived);
    const panel = await openPair();
    expect(screen.getByLabelText('opener')).toHaveTextContent('closed');
    await userEvent.click(within(panel).getByRole('button', { name: 'Delever' }));
    expect(screen.getByLabelText('opener')).toHaveTextContent(`delever|${openPairKey('ETH', derived.pairs[0])}`);
  });

  it('a running, pausing, paused or stopped delever keeps the pill as Delever, and the pill opens the run', async () => {
    const jobs: RebalanceJob[] = [
      deleverJob({}),
      deleverJob({ pauseRequested: true }),
      deleverJob({ status: 'halted', paused: true }),
      deleverJob({ status: 'halted', slice: null, haltReason: 'Boros filled only part of the close.' }),
    ];
    for (const job of jobs) {
      withJob(job);
      const derived = derivedOf();
      const view = renderCard(derived);
      const panel = await openPair();
      const pill = await within(panel).findByRole('button', { name: 'Delever' });
      expect(within(panel).queryByRole('button', { name: /Slice|Stopped/ })).toBeNull();
      await userEvent.click(pill);
      expect(screen.getByLabelText('opener')).toHaveTextContent(`delever|${openPairKey('ETH', derived.pairs[0])}`);
      view.unmount();
    }
  });

  it('a delever on another pair, a done job or a move job leaves the pill as Delever', async () => {
    const other = deleverJob({});
    const cases: RebalanceJob[] = [
      { ...other, delever: { ...other.delever!, boros: [{ marketId: 9, before: 100, after: 100, closed: 0 }] } },
      deleverJob({ status: 'done' }),
      deleverJob({ status: 'abandoned' }),
      deleverJob({ kind: 'move', delever: null }),
    ];
    for (const job of cases) {
      const served = withJob(job);
      const view = renderCard(derivedOf());
      expect(await pillAfterLoad(served)).toHaveTextContent(/^Delever$/);
      view.unmount();
    }
  });
});
