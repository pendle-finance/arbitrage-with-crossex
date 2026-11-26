import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetBorosOpen, AssetGroup, AssetPerpOpen } from '../../api/types';
import { fmtDateLocal } from '../../lib/fmt';
import { renderWithClient } from '../../test/utils';
import { ClosePairModal, RollPairModal } from './ClosePairModal';
import { pairEntriesOf, type PairEntry } from './pairs';

const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);

const openState = vi.hoisted(() => ({ entries: [] as PairEntry[] }));
const mounts = vi.hoisted(() => ({ n: 0 }));
const sends = vi.hoisted(() => [] as string[][]);

vi.mock('./pairs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pairs')>()),
  useOpenPairs: () => ({ pairs: openState.entries.map((e) => e.open), entries: openState.entries, loading: false, failed: false, retry: () => {} }),
}));

function useMount() {
  const [id] = useState(() => ++mounts.n);
  return id;
}

vi.mock('../PerpOnlyBox', () => ({
  ClosePairForm: ({ legs, borosUnhedged, allowTwap, onSent }: { legs: { symbol: string; qty: number; partial?: boolean }[]; allowTwap?: boolean; borosUnhedged?: { qty: number; coin: string } | null; onSent?: () => void }) => {
    const id = useMount();
    const max = String(Math.min(...legs.map((l) => l.qty)));
    const [size, setSize] = useState(max);
    return (
      <div data-testid="perp-form" data-mount={id}>
        <span>{legs.map((l) => l.symbol).join(' ')}</span>
        <span>{allowTwap ? 'twap allowed' : 'no twap'}</span>
        <span>{borosUnhedged ? `unhedged ${borosUnhedged.qty} ${borosUnhedged.coin}` : 'hedged'}</span>
        <input aria-label="Close size" value={size} onChange={(e) => setSize(e.target.value)} />
        <button
          type="button"
          onClick={() => {
            sends.push(legs.map((l) => `${l.symbol}:${l.qty}${l.partial ? ':partial' : ''}`));
            onSent?.();
          }}
        >
          Close both
        </button>
      </div>
    );
  },
}));

vi.mock('../../trade/CloseBorosForm', () => ({
  CloseBorosForm: ({ legs, underPicker, onSent }: { legs: { marketId: number; spreadVenues: unknown }[]; underPicker?: boolean; onSent?: () => void }) => {
    const id = useMount();
    const [sent, setSent] = useState(false);
    return (
      <div data-testid="boros-form" data-mount={id}>
        <span>{legs.map((l) => `market ${l.marketId}`).join(' ')}</span>
        <span>{underPicker ? 'under picker' : 'full box'}</span>
        {sent && <span>Closed</span>}
        <button
          type="button"
          onClick={() => {
            setSent(true);
            onSent?.();
          }}
        >
          Close position
        </button>
      </div>
    );
  },
}));

vi.mock('./AssetCard', () => ({
  RollOverModal: ({ pair, base, picker }: { pair: { soonestMaturitySec: number; size: number }; base: string; picker: ReactNode }) => {
    const id = useMount();
    const [rolled, setRolled] = useState(false);
    return (
      <div role="dialog" data-testid="roll" data-mount={id}>
        {picker}
        <span>{`roll ${base} ${pair.size}`}</span>
        {rolled && <span>{`Rolled ${pair.size} ${base}`}</span>}
        <button type="button" onClick={() => setRolled(true)}>
          Roll over
        </button>
      </div>
    );
  },
}));

const perp = (base: string, venue: string, side: 'LONG' | 'SHORT', qty: number, px: number): AssetPerpOpen => ({
  symbol: `${venue}_FUTURE_${base}_USDT`,
  venue,
  side,
  qty,
  notionalUsd: qty * px,
  entryPrice: px,
  markPrice: px,
  leverage: 10,
  upnlUsd: 0,
  fundingUsd: 0,
  feesUsd: 0,
  imUsd: (qty * px) / 10,
  openedAt: NOW - 10 * DAY,
});

const yu = (base: string, marketId: number, venue: string, side: 'LONG' | 'SHORT', size: number, maturity: number, px: number): AssetBorosOpen => ({
  marketId,
  venue,
  side,
  sizeToken: size,
  maturity,
  spreadVenues: null,
  collateral: base === 'ETH' || base === 'BTC' ? base : 'USDT',
  notionalUsd: size * px,
  entryApr: 0.08,
  markApr: 0.08,
  floatingApr: 0.09,
  settleUsd: 0,
  mtmUsd: 0,
  imUsd: size * px * 0.04,
});

const group = (base: string, qty: number, px: number, days: number, ids: [number, number]): AssetGroup => ({
  base,
  supported: true,
  priceUsd: px,
  earliestSec: NOW - 10 * DAY,
  perpOpen: [perp(base, 'GATE', 'LONG', qty, px), perp(base, 'HYPERLIQUID', 'SHORT', qty, px)],
  perpClosed: [],
  borosOpen: [
    yu(base, ids[0], 'GATE', 'LONG', qty, NOW + days * DAY, px),
    yu(base, ids[1], 'HYPERLIQUID', 'SHORT', qty, NOW + days * DAY, px),
  ],
  borosHistory: [],
});

const entriesOf = (...groups: AssetGroup[]) => pairEntriesOf(groups, { exclusions: {}, sinceSec: 0, nowSec: NOW });

const ETH = group('ETH', 100, 2500, 8, [1, 2]);
const BTC = group('BTC', 2, 90_000, 8, [11, 12]);
const HYPE = group('HYPE', 500, 40, 8, [21, 22]);
const BTC_MATURED = group('BTC', 3, 90_000, -1, [31, 32]);

const [ethEntry] = entriesOf(ETH);

function Refetchable({ next, children }: { next: () => PairEntry[]; children: () => ReactNode }) {
  const [, setTick] = useState(0);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          openState.entries = next();
          setTick((n) => n + 1);
        }}
      >
        Refetch
      </button>
      {children()}
    </>
  );
}

function closeModal(kind: 'perps' | 'boros', next: () => PairEntry[] = () => openState.entries) {
  return renderWithClient(
    <Refetchable next={next}>
      {() => <ClosePairModal kind={kind} pair={ethEntry.pair} group={ETH} livePositions={new Map()} onClose={() => {}} />}
    </Refetchable>,
  );
}

async function pick(user: ReturnType<typeof userEvent.setup>, text: RegExp) {
  await user.click(screen.getByRole('button', { name: 'Pair' }));
  const option = within(screen.getByRole('listbox')).getAllByRole('option').find((o) => text.test(o.textContent ?? ''));
  await user.click(option!);
}

const optionTexts = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: 'Pair' }));
  const texts = within(screen.getByRole('listbox'))
    .getAllByRole('option')
    .map((o) => o.textContent ?? '');
  await user.click(screen.getByRole('button', { name: 'Pair' }));
  return texts;
};

beforeEach(() => {
  openState.entries = entriesOf(ETH, BTC, HYPE);
});

describe('ClosePairModal', () => {
  it('opens on the clicked pair', () => {
    closeModal('perps');
    expect(screen.getByRole('heading', { name: 'Close perps' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pair' })).toHaveTextContent(/ETH/);
    expect(screen.getByTestId('perp-form')).toHaveTextContent('GATE_FUTURE_ETH_USDT HYPERLIQUID_FUTURE_ETH_USDT');
  });

  it('Close perps passes the pair\'s Boros size, Close Boros trims its box under the picker', () => {
    const perps = closeModal('perps');
    expect(screen.getByTestId('perp-form')).toHaveTextContent(`unhedged ${ethEntry.pair.size} ETH`);
    expect(screen.getByTestId('perp-form')).toHaveTextContent('twap allowed');
    perps.unmount();
    closeModal('boros');
    expect(screen.getByTestId('boros-form')).toHaveTextContent('under picker');
  });

  it('Close perps: picking another pair resets a typed size and targets the new pair\'s symbols', async () => {
    const user = userEvent.setup();
    closeModal('perps');
    const first = screen.getByTestId('perp-form').dataset.mount;
    await user.clear(screen.getByRole('textbox', { name: 'Close size' }));
    await user.type(screen.getByRole('textbox', { name: 'Close size' }), '0.5');
    await pick(user, /BTC/);
    const form = screen.getByTestId('perp-form');
    expect(form.dataset.mount).not.toBe(first);
    expect(form).toHaveTextContent('GATE_FUTURE_BTC_USDT HYPERLIQUID_FUTURE_BTC_USDT');
    expect(within(form).getByRole('textbox', { name: 'Close size' })).toHaveValue('2');
  });

  it('Close Boros: picking another coin\'s pair closes that pair\'s Boros markets', async () => {
    const user = userEvent.setup();
    closeModal('boros');
    expect(screen.getByTestId('boros-form')).toHaveTextContent('market 1 market 2');
    await pick(user, /BTC/);
    expect(screen.getByTestId('boros-form')).toHaveTextContent('market 11 market 12');
  });

  it('Close perps lists only coin-margined pairs; Close Boros lists every pair with a Boros leg', async () => {
    const user = userEvent.setup();
    const perps = closeModal('perps');
    const perpRows = await optionTexts(user);
    expect(perpRows).toHaveLength(2);
    expect(perpRows.some((r) => r.includes('HYPE'))).toBe(false);
    perps.unmount();
    closeModal('boros');
    const borosRows = await optionTexts(user);
    expect(borosRows).toHaveLength(3);
    expect(borosRows.some((r) => r.includes('HYPE'))).toBe(true);
  });

  it('a picked pair that leaves the asset view keeps the form on that pair', async () => {
    const user = userEvent.setup();
    closeModal('boros', () => entriesOf(ETH, HYPE));
    await pick(user, /BTC/);
    const mounted = screen.getByTestId('boros-form').dataset.mount;
    await user.click(screen.getByRole('button', { name: 'Close position' }));
    await user.click(screen.getByRole('button', { name: 'Refetch' }));
    const form = screen.getByTestId('boros-form');
    expect(form.dataset.mount).toBe(mounted);
    expect(form).toHaveTextContent('market 11 market 12');
    expect(form).toHaveTextContent('Closed');
    expect(screen.getByRole('button', { name: 'Pair' })).toHaveTextContent(/BTC/);
  });

  describe('two pairs share one perp: a part close of one, then 100% sends the new size', () => {
    const shared = (perps: number, near: number, far: number): AssetGroup => ({
      ...ETH,
      perpOpen: [perp('ETH', 'GATE', 'LONG', perps, 2500), perp('ETH', 'HYPERLIQUID', 'SHORT', perps, 2500)],
      borosOpen: [
        yu('ETH', 1, 'GATE', 'LONG', near, NOW + 8 * DAY, 2500),
        yu('ETH', 2, 'HYPERLIQUID', 'SHORT', near, NOW + 8 * DAY, 2500),
        yu('ETH', 3, 'GATE', 'LONG', far, NOW + 60 * DAY, 2500),
        yu('ETH', 4, 'HYPERLIQUID', 'SHORT', far, NOW + 60 * DAY, 2500),
      ],
    });
    const before = shared(10, 5, 5);
    const after = shared(7.5, 5, 2.5);
    const [near, far] = entriesOf(before);
    const legsAt = (qty: number) => [`GATE_FUTURE_ETH_USDT:${qty}:partial`, `HYPERLIQUID_FUTURE_ETH_USDT:${qty}:partial`];

    beforeEach(() => {
      sends.length = 0;
      openState.entries = entriesOf(before);
    });

    it('the clicked pair', async () => {
      const user = userEvent.setup();
      renderWithClient(
        <Refetchable next={() => entriesOf(after)}>
          {() => <ClosePairModal kind="perps" pair={far.pair} group={before} livePositions={new Map()} onClose={() => {}} />}
        </Refetchable>,
      );
      await user.click(screen.getByRole('button', { name: 'Close both' }));
      await user.click(screen.getByRole('button', { name: 'Refetch' }));
      await user.click(screen.getByRole('button', { name: 'Close both' }));
      expect(sends).toEqual([legsAt(5), legsAt(2.5)]);
    });

    it('a pair picked in the picker', async () => {
      const user = userEvent.setup();
      renderWithClient(
        <Refetchable next={() => entriesOf(after)}>
          {() => <ClosePairModal kind="perps" pair={near.pair} group={before} livePositions={new Map()} onClose={() => {}} />}
        </Refetchable>,
      );
      await user.click(screen.getByRole('button', { name: 'Pair' }));
      await user.click(within(screen.getByRole('listbox')).getAllByRole('option')[1]);
      expect(screen.getByRole('button', { name: 'Pair' })).toHaveTextContent(new RegExp(fmtDateLocal(far.open.maturitySec)));
      await user.click(screen.getByRole('button', { name: 'Close both' }));
      await user.click(screen.getByRole('button', { name: 'Refetch' }));
      await user.click(screen.getByRole('button', { name: 'Close both' }));
      expect(sends).toEqual([legsAt(5), legsAt(2.5)]);
    });
  });

  it('the picker locks once an order is sent', async () => {
    const user = userEvent.setup();
    closeModal('perps');
    expect(screen.getByRole('button', { name: 'Pair' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Close both' }));
    expect(screen.getByRole('button', { name: 'Pair' })).toBeDisabled();
  });
});

describe('RollPairModal', () => {
  const roll = (next: () => PairEntry[] = () => openState.entries) =>
    renderWithClient(
      <Refetchable next={next}>{() => <RollPairModal pair={ethEntry.pair} group={ETH} nowSec={NOW} onClose={() => {}} />}</Refetchable>,
    );

  it('lists only pairs that have not matured', async () => {
    const user = userEvent.setup();
    openState.entries = entriesOf(ETH, BTC_MATURED, BTC);
    roll();
    const rows = await optionTexts(user);
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.includes('3 BTC'))).toBe(false);
  });

  it('a roll of a picked pair keeps its result after the pair moves to the new maturity', async () => {
    const user = userEvent.setup();
    roll(() => entriesOf(ETH, group('BTC', 2, 90_000, 60, [41, 42])));
    await pick(user, /BTC/);
    const mounted = screen.getByTestId('roll').dataset.mount;
    expect(screen.getByTestId('roll')).toHaveTextContent('roll BTC 2');
    await user.click(screen.getByRole('button', { name: 'Roll over' }));
    await user.click(screen.getByRole('button', { name: 'Refetch' }));
    const modal = screen.getByTestId('roll');
    expect(modal.dataset.mount).toBe(mounted);
    expect(modal).toHaveTextContent('Rolled 2 BTC');
    expect(modal).not.toHaveTextContent('roll ETH');
  });

  it('starts on the clicked pair', () => {
    roll();
    expect(screen.getByTestId('roll')).toHaveTextContent('roll ETH 100');
  });
});
