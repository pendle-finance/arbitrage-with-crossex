import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import type { RebalanceBucket, RebalanceView } from '../api/types';
import { accountBodies, accountHandler, rebalanceViews, transferHandler, transferViews } from '../test/fixtures';
import { env, server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { MoveCashTab } from './MoveCashTab';

function bookWith(usdt: number, gate: number): RebalanceView {
  const book = rebalanceViews.ownerBook;
  const crossex = book.buckets.find((b) => b.coin === 'USDT' && b.venue === 'CROSSEX')!;
  const others = book.buckets.filter((b) => b !== crossex && !(b.coin === 'USDC' && b.venue === 'GATE'));
  const idle: RebalanceBucket = { ...crossex, coin: 'USDC', venue: 'GATE', cash: gate, equity: gate, upnl: 0, borrow: 0, imHeldUsd: 0, mmHeldUsd: 0 };
  return { ...book, buckets: [{ ...crossex, cash: usdt, equity: usdt, borrow: 0 }, ...others, idle] };
}

function show(view: RebalanceView, serverMax: number | null) {
  server.use(
    transferHandler(transferViews.spotZero),
    accountHandler(accountBodies.accountA),
    http.get('/api/positions', () => HttpResponse.json(env({ positions: [], exposure: [] }))),
    http.get('/api/rebalance', ({ request }) => {
      const search = new URL(request.url).searchParams;
      const from = search.get('from');
      const amount = Number(search.get('amount'));
      const base = view.plans.custom ?? rebalanceViews.ownerBook.plans.custom!;
      const custom =
        serverMax !== null && from !== null && amount > 0
          ? { ...base, goal: { kind: 'custom' as const, from: from as 'CROSSEX', to: search.get('to') as 'HYPERLIQUID', amount }, customMaxUsd: serverMax }
          : null;
      return HttpResponse.json(env({ ...view, plans: { ...view.plans, custom } }));
    }),
  );
  renderWithClient(<MoveCashTab view={view} holdMs={50} lock={null} onTab={vi.fn()} onStarted={vi.fn()} />);
}

async function customFromCrossex(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('radio', { name: 'Custom amount' }));
  await user.click(screen.getByRole('button', { name: 'From' }));
  await user.click(within(screen.getByRole('listbox', { name: 'From' })).getByRole('option', { name: /USDT · CrossEx/ }));
  await user.clear(screen.getByRole('textbox', { name: 'Amount' }));
}

describe('MoveCashTab custom Max', () => {
  it('counts idle Gate USDC with the CrossEx USDT before the plan is priced', async () => {
    const user = userEvent.setup();
    show(bookWith(5_000, 3_000), null);
    await customFromCrossex(user);
    expect(screen.getByRole('button', { name: 'Max 8,000.00 USDT' })).toBeEnabled();
  });

  it('counts idle Gate USDC on a $6,000,000 book', async () => {
    const user = userEvent.setup();
    show(bookWith(4_000_000, 2_000_000), null);
    await customFromCrossex(user);
    expect(screen.getByRole('button', { name: 'Max 6,000,000.00 USDT' })).toBeEnabled();
  });

  it('leaves out Gate USDC under one dollar, as the server does', async () => {
    const user = userEvent.setup();
    show(bookWith(50, 0.5), null);
    await customFromCrossex(user);
    expect(screen.getByRole('button', { name: 'Max 50.00 USDT' })).toBeEnabled();
  });

  it('shows the server max once the plan for this wallet is priced', async () => {
    const user = userEvent.setup();
    show(bookWith(5_000, 3_000), 7_999.5);
    await customFromCrossex(user);
    await user.click(screen.getByRole('button', { name: 'To' }));
    await user.click(within(screen.getByRole('listbox', { name: 'To' })).getByRole('option', { name: /USDC · Hyperliquid/ }));
    await user.type(screen.getByRole('textbox', { name: 'Amount' }), '100');
    expect(await screen.findByRole('button', { name: 'Max 7,999.50 USDT' }, { timeout: 3000 })).toBeEnabled();
  });
});
