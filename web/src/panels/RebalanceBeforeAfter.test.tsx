import { cleanup, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { RebalanceBucket, RebalanceView, RoutePlan, WalletAfter } from '../api/types';
import { auditRebalanceViews, OWNER_BEFORE_PERPS, REALIZE_DONE_JOB, rebalanceViews } from '../test/fixtures';
import { RebalanceBeforeAfter, receiptChanges, walletChanges, type WalletChange } from './RebalanceBeforeAfter';

const owner = rebalanceViews.ownerBook;
const ownerRoute = (over: Partial<RoutePlan> = {}): RoutePlan => ({ ...owner.plans.even.routes.loop!, ...over });

function planCard(view: RebalanceView, route: RoutePlan) {
  render(<RebalanceBeforeAfter rows={walletChanges(view, view.plans.even, route)} mode="after" />);
}

const groups = (): HTMLElement[] => screen.getAllByRole('rowgroup');
const groupNames = (): string[] => groups().map((g) => g.getAttribute('aria-label') ?? '');
const linesOf = (group: HTMLElement): HTMLElement[] => within(group).getAllByRole('row').slice(1);
const labelsOf = (group: HTMLElement): string[] => linesOf(group).map((row) => within(row).getByRole('rowheader').textContent ?? '');

function valuesOf(group: HTMLElement, label: string): [string, string] {
  const row = linesOf(group).find((r) => within(r).getByRole('rowheader').textContent === label);
  if (!row) throw new Error(`no ${label} row`);
  const [before, after] = within(row).getAllByRole('cell');
  return [before!.textContent ?? '', after!.textContent ?? ''];
}

const group = (name: string): HTMLElement => screen.getByRole('rowgroup', { name });

describe('RebalanceBeforeAfter', () => {
  it('columns: Before and After heads, an arrow between, every number right-aligned in its column', () => {
    planCard(owner, ownerRoute({ marginFreedUsd: 5962 }));
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Before', 'After']);
    const rows = groups().flatMap(linesOf);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const [before, after] = within(row).getAllByRole('cell');
      for (const cell of [before!, after!]) expect(cell.className).toMatch(/\bw-28\b.*\btext-right\b|\btext-right\b.*\bw-28\b/);
      expect(after!.className).toContain('num');
      const arrows = row.querySelectorAll('svg.lucide-arrow-right');
      expect(arrows.length).toBe(before!.textContent === '' ? 0 : 1);
    }
    const [freesBefore, freesAfter] = valuesOf(group('USDT · CrossEx'), 'Frees');
    expect(freesBefore).toBe('');
    expect(freesAfter).toBe('$5,962.00');
  });

  it('grouped by wallet: one head per changed wallet, the borrowing wallet first', () => {
    planCard(owner, ownerRoute());
    expect(groupNames()).toEqual(['USDT · CrossEx', 'USDC · Hyperliquid']);
  });

  it('grouped by wallet: the borrowing wallet leads even when it is last in the plan', () => {
    const three = rebalanceViews.threeWallets;
    const route = three.plans.even.routes.loop!;
    const view = { ...three, buckets: [...three.buckets].reverse() };
    planCard(view, { ...route, after: [...route.after].reverse() });
    expect(groupNames()).toEqual(['USDT · CrossEx', 'USDC · Lighter', 'USDC · Hyperliquid']);
  });

  it('grouped by wallet: a wallet that does not change has no head', () => {
    const three = rebalanceViews.threeWallets;
    const route = three.plans.even.routes.loop!;
    const lighter = three.buckets.find((b) => b.venue === 'LIGHTER')!;
    const after = route.after.map((w) => (w.venue === 'LIGHTER' ? { ...w, cash: lighter.cash, equity: lighter.equity } : w));
    planCard(three, { ...route, after });
    expect(groupNames()).toEqual(['USDT · CrossEx', 'USDC · Hyperliquid']);
  });

  it('rows per wallet: Equity everywhere, Borrow, Interest a month and Frees on the borrower, Cash on a payer', () => {
    planCard(owner, ownerRoute());
    const usdt = group('USDT · CrossEx');
    const usdc = group('USDC · Hyperliquid');
    expect(labelsOf(usdt)).toEqual(['Equity', 'Borrow', 'Interest a month', 'Frees']);
    expect(labelsOf(usdc)).toEqual(['Equity', 'Cash']);
    expect(valuesOf(usdt, 'Equity')).toEqual(['-29,812', '7,687']);
    expect(valuesOf(usdt, 'Borrow')).toEqual(['29,812', '0']);
    expect(valuesOf(usdt, 'Interest a month')).toEqual(['$148.07', '$0.00']);
    expect(valuesOf(usdc, 'Equity')).toEqual(['45,314', '7,687']);
    expect(valuesOf(usdc, 'Cash')).toEqual(['3,140', '0']);
  });

  it('rows per wallet: three wallets, both payers show Cash', () => {
    const three = rebalanceViews.threeWallets;
    planCard(three, three.plans.even.routes.loop!);
    expect(labelsOf(group('USDC · Hyperliquid'))).toEqual(['Equity', 'Cash']);
    expect(labelsOf(group('USDC · Lighter'))).toEqual(['Equity', 'Cash']);
    expect(valuesOf(group('USDT · CrossEx'), 'Equity')).toEqual(['-338.25', '447.43']);
    expect(valuesOf(group('USDC · Lighter'), 'Cash')).toEqual(['276.57', '90.57']);
  });

  it('rows per wallet: a borrow left after the move keeps its share of the interest', () => {
    const route = ownerRoute({
      after: [
        { coin: 'USDT', venue: 'CROSSEX', cash: -14906, equity: -14906 },
        { coin: 'USDC', venue: 'HYPERLIQUID', cash: 0, equity: 30408 },
      ],
    });
    planCard(owner, route);
    const usdt = group('USDT · CrossEx');
    expect(valuesOf(usdt, 'Borrow')).toEqual(['29,812', '14,906']);
    expect(valuesOf(usdt, 'Interest a month')).toEqual(['$148.07', '$74.04']);
  });

  it('rows per wallet: Frees splits the route total by what each borrower repays', () => {
    const bucket = (coin: string, venue: string, cash: number): RebalanceBucket => ({
      coin, venue, cash, upnl: 0, equity: cash, borrow: Math.max(0, -cash), imHeldUsd: Math.max(0, -cash) * 0.2,
      mmHeldUsd: 0, interestPaidUsd: 0, interestPerDayUsd: Math.max(0, -cash) * 0.0001, ratePerYear: 0.05,
    });
    const buckets = [bucket('USDT', 'CROSSEX', -3000), bucket('USDC', 'LIGHTER', -1000), bucket('USDC', 'HYPERLIQUID', 9000)];
    const after: WalletAfter[] = [
      { coin: 'USDT', venue: 'CROSSEX', cash: 0, equity: 0 },
      { coin: 'USDC', venue: 'LIGHTER', cash: 0, equity: 0 },
      { coin: 'USDC', venue: 'HYPERLIQUID', cash: 5000, equity: 5000 },
    ];
    const rows = walletChanges({ ...owner, buckets }, owner.plans.even, ownerRoute({ after, marginFreedUsd: 800 }));
    const frees = rows.flatMap((g) => g.rows.filter((r) => r.label === 'Frees').map((r) => r.after));
    expect(rows.map((g) => g.key)).toEqual(['USDT/CROSSEX', 'USDC/LIGHTER', 'USDC/HYPERLIQUID']);
    expect(frees).toEqual([600, 200]);
  });

  it('no perps before the hold', () => {
    const rows = walletChanges(owner, owner.plans.even, ownerRoute());
    expect(rows.map((g) => g.key)).not.toContain('perps');
    render(<RebalanceBeforeAfter rows={rows} mode="after" />);
    expect(screen.queryByText('Perps')).toBeNull();
    expect(screen.queryByText(/ETH/)).toBeNull();
  });

  it('a refused realize still shows the plain move', () => {
    const refused = { ...owner.plans.even, realize: { legs: owner.plans.even.realize!.legs, refused: { reason: 'past-book' as const, bp: 54.5 } } };
    const rows = walletChanges(owner, refused, ownerRoute());
    expect(rows).toEqual(walletChanges(owner, owner.plans.even, ownerRoute()));
    expect(rows.length).toBeGreaterThan(0);
  });

  it('receipt reads Before and Now and ends with the perps at the same size', () => {
    render(<RebalanceBeforeAfter rows={receiptChanges(REALIZE_DONE_JOB, owner.buckets, null)} mode="now" />);
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Before', 'Now']);
    expect(groupNames()).toEqual(['USDT · CrossEx', 'USDC · Hyperliquid', 'Perps']);
    expect(labelsOf(group('USDT · CrossEx'))).toEqual(['Equity', 'Borrow', 'Interest a month']);
    expect(valuesOf(group('USDT · CrossEx'), 'Borrow')).toEqual(['29,812', '0']);
    expect(valuesOf(group('Perps'), 'Hyperliquid short')).toEqual(['66.0 ETH', '66.0 ETH']);
  });

  it.each([[66, '66.0'], [53.8, '53.8'], [0.954, '0.954']])('perp size %d reads %s', (qty, text) => {
    const job = { ...REALIZE_DONE_JOB, target: null, realize: { ...REALIZE_DONE_JOB.realize!, legs: [{ ...REALIZE_DONE_JOB.realize!.legs[0]!, positionQty: qty }] } };
    render(<RebalanceBeforeAfter rows={receiptChanges(job, owner.buckets, null)} mode="now" />);
    expect(valuesOf(group('Perps'), 'Hyperliquid short')).toEqual([`${text} ETH`, `${text} ETH`]);
  });

  it('receipt without a target still reports the perps', () => {
    const rows: WalletChange[] = receiptChanges({ ...REALIZE_DONE_JOB, target: null }, owner.buckets, null);
    expect(rows.map((g) => g.key)).toEqual(['perps']);
  });

  it.each([50, 6_000_000])('reads the full amount at $%d', (size) => {
    const scale = size / 29812;
    const buckets = owner.buckets.map((b) => ({
      ...b, cash: b.cash * scale, upnl: b.upnl * scale, equity: b.equity * scale, borrow: b.borrow * scale,
      imHeldUsd: b.imHeldUsd * scale, interestPerDayUsd: b.interestPerDayUsd * scale,
    }));
    const route = ownerRoute({ after: ownerRoute().after.map((w) => ({ ...w, cash: w.cash * scale, equity: w.equity * scale })) });
    const rows = walletChanges({ ...owner, buckets }, owner.plans.even, route);
    const borrow = rows[0]!.rows.find((r) => r.label === 'Borrow')!;
    expect(borrow.before).toBeCloseTo(size, 6);
    expect(borrow.after).toBe(0);
    planCard({ ...owner, buckets }, route);
    expect(valuesOf(group('USDT · CrossEx'), 'Borrow')[0]).toBe(size === 50 ? '50' : '6,000,000');
  });

  it.each([50 / 29812, 1, 200])('done now is before plus what landed on a trimmed route, at %s times the owner book', (by) => {
    const trimmed = auditRebalanceViews.realizeDonePartFill.job!;
    const buckets = owner.buckets.map((b) => ({ ...b, cash: b.cash * by, upnl: b.upnl * by, equity: b.equity * by, borrow: b.borrow * by, imHeldUsd: b.imHeldUsd * by }));
    const job = {
      ...trimmed,
      before: { buckets, perps: OWNER_BEFORE_PERPS },
      realize: { legs: trimmed.realize!.legs.map((leg) => ({ ...leg, realizedUsd: leg.realizedUsd * by })) },
      steps: trimmed.steps.map((step) => ({ ...step, planned: step.planned === null || step.perp ? step.planned : step.planned * by, qty: step.qty === null || step.perp ? step.qty : step.qty * by })),
    };
    const landedUsdt = (5742.2 + 4537 + 4537 + 2941) * by;
    const sentUsdc = (5742.2 + 4538 + 4538 + 2941.6) * by;
    const rows = receiptChanges(job, owner.buckets, null);
    const after = (key: string, label: string) => rows.find((g) => g.key === key)!.rows.find((r) => r.label === label)!.after;
    expect(after('USDT/CROSSEX', 'Equity')).toBeCloseTo(-29812 * by + landedUsdt, 1);
    expect(after('USDC/HYPERLIQUID', 'Equity')).toBeCloseTo(45314 * by - sentUsdc, 1);
    expect(after('USDT/CROSSEX', 'Borrow')).toBeCloseTo(29812 * by - landedUsdt, 1);
  });

  it('done now column shows a short reopen', () => {
    const job = { ...auditRebalanceViews.realizeDoneShortReopen.job!, before: { buckets: owner.buckets, perps: OWNER_BEFORE_PERPS } };
    render(<RebalanceBeforeAfter rows={receiptChanges(job, owner.buckets, null)} mode="now" />);
    expect(valuesOf(group('Perps'), 'Hyperliquid short')).toEqual(['66.0 ETH', '65.99 ETH']);
    expect(valuesOf(group('Perps'), 'Gate long')).toEqual(['66.0 ETH', '66.0 ETH']);
    cleanup();
    const live = [{ symbol: job.realize!.legs[0]!.symbol, exchange: 'HYPERLIQUID', side: 'SHORT' as const, qty: 60 }];
    render(<RebalanceBeforeAfter rows={receiptChanges(job, owner.buckets, live)} mode="now" />);
    expect(valuesOf(group('Perps'), 'Hyperliquid short')).toEqual(['66.0 ETH', '60.0 ETH']);
  });

  it('after mode leads with an After heading at 14px semibold; now mode has none', () => {
    planCard(owner, ownerRoute());
    const heading = screen.getByRole('caption');
    expect(heading.textContent).toBe('After');
    expect(heading.className).toContain('text-[14px]');
    expect(heading.className).toContain('font-semibold');
    cleanup();
    render(<RebalanceBeforeAfter rows={receiptChanges(REALIZE_DONE_JOB, owner.buckets, null)} mode="now" />);
    expect(screen.queryByRole('caption')).toBeNull();
  });

  it('pct, text and suffix rows', () => {
    const rows: WalletChange[] = [
      {
        key: 'delever',
        label: 'Delever',
        rows: [
          { label: 'Gate Long · Hyperliquid Short', before: 900, after: 720, unit: 'coin', coin: 'BTC', suffix: 'each' },
          { label: 'IM used · CrossEx', before: 0.88, after: 0.7, unit: 'pct' },
          { label: 'Pair PnL', before: null, after: 0, unit: 'text', text: { before: '', after: 'Unchanged, except cost' } },
          { label: 'Mode', before: null, after: 0, unit: 'text', text: { before: 'Limit', after: 'Market' } },
        ],
      },
    ];
    render(<RebalanceBeforeAfter rows={rows} mode="after" />);
    const g = group('Delever');
    expect(valuesOf(g, 'Gate Long · Hyperliquid Short')).toEqual(['900.0 BTC', '720.0 BTC each']);
    expect(valuesOf(g, 'IM used · CrossEx')).toEqual(['88.0%', '70.0%']);
    expect(valuesOf(g, 'Pair PnL')).toEqual(['', 'Unchanged, except cost']);
    expect(valuesOf(g, 'Mode')).toEqual(['Limit', 'Market']);
    const arrows = (label: string) =>
      linesOf(g).find((r) => within(r).getByRole('rowheader').textContent === label)!.querySelectorAll('svg.lucide-arrow-right').length;
    expect(arrows('Pair PnL')).toBe(0);
    expect(arrows('Mode')).toBe(1);
    expect(arrows('IM used · CrossEx')).toBe(1);
  });
});
