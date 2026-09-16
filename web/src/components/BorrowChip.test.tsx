import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { borrowTotalUsd } from '../lib/borrow';
import { num } from '../lib/fmt';
import { rebalanceHandler, rebalanceViews } from '../test/fixtures';
import { server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { BorrowChip } from './BorrowChip';

describe('BorrowChip', () => {
  it('hover rows', async () => {
    server.use(rebalanceHandler(rebalanceViews.accountA));
    renderWithClient(<BorrowChip onOpen={vi.fn()} />);

    const pill = await screen.findByRole('button', { name: 'Borrowing 147.05 USDC' });
    await userEvent.hover(pill);

    const card = await screen.findByRole('tooltip');
    expect(within(card).getByText('Lent by Gate')).toBeInTheDocument();
    expect(within(card).getByText('147.05 USDC')).toBeInTheDocument();
    expect(within(card).getByText('For')).toBeInTheDocument();
    expect(within(card).getByText('Hyperliquid legs')).toBeInTheDocument();
    expect(within(card).getByText('Held against the borrow')).toBeInTheDocument();
    expect(within(card).getByText('$29.41')).toBeInTheDocument();
  });

  it('hover link', async () => {
    server.use(rebalanceHandler(rebalanceViews.accountA));
    const onOpen = vi.fn();
    renderWithClient(<BorrowChip onOpen={onOpen} />);

    const pill = await screen.findByRole('button', { name: 'Borrowing 147.05 USDC' });
    await userEvent.hover(pill);

    const card = await screen.findByRole('tooltip');
    const link = within(card).getByRole('button', { name: 'Rebalance on Balances ▸' });
    await userEvent.click(link);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('enter then the card link is focused', async () => {
    server.use(rebalanceHandler(rebalanceViews.accountA));
    renderWithClient(<BorrowChip onOpen={vi.fn()} />);

    const pill = await screen.findByRole('button', { name: 'Borrowing 147.05 USDC' });
    pill.focus();
    await userEvent.keyboard('{Enter}');

    const card = await screen.findByRole('tooltip');
    expect(within(card).getByRole('button', { name: 'Rebalance on Balances ▸' })).toHaveFocus();
  });

  it('USDT borrow legs', async () => {
    server.use(rebalanceHandler(rebalanceViews.exampleE));
    renderWithClient(<BorrowChip onOpen={vi.fn()} />);

    const pill = await screen.findByRole('button', { name: 'Borrowing 612.35 USDT' });
    await userEvent.hover(pill);

    const card = await screen.findByRole('tooltip');
    expect(within(card).getByText('Gate, Binance, OKX and Bybit legs')).toBeInTheDocument();
  });

  it('Lighter borrow legs', async () => {
    const view = rebalanceViews.exampleC;
    const lighter = { coin: 'USDC', venue: 'LIGHTER', cash: -500, upnl: 0, equity: -500, borrow: 500, imHeldUsd: 100, mmHeldUsd: 50, interestPaidUsd: 0, interestPerDayUsd: 0.15 };
    server.use(rebalanceHandler({ ...view, buckets: [...view.buckets, lighter] }));
    renderWithClient(<BorrowChip onOpen={vi.fn()} />);

    const pill = await screen.findByRole('button', { name: 'Borrowing 500.00 USDC' });
    await userEvent.hover(pill);

    const card = await screen.findByRole('tooltip');
    expect(within(card).getByText('Lighter legs')).toBeInTheDocument();
  });

  it('a click on the pill opens Balances', async () => {
    server.use(rebalanceHandler(rebalanceViews.accountA));
    const onOpen = vi.fn();
    renderWithClient(<BorrowChip onOpen={onOpen} />);

    const pill = await screen.findByText('Borrowing 147.05 USDC');
    await userEvent.click(pill);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('no title no icon', async () => {
    server.use(rebalanceHandler(rebalanceViews.accountA));
    renderWithClient(<BorrowChip onOpen={vi.fn()} />);

    const pill = await screen.findByRole('button', { name: 'Borrowing 147.05 USDC' });
    expect(pill.getAttribute('title') ?? '').toBe('');
    expect(pill.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it('pill sums every borrow', async () => {
    server.use(rebalanceHandler(rebalanceViews.twoBorrows));
    renderWithClient(<BorrowChip onOpen={vi.fn()} />);

    const pill = await screen.findByRole('button', { name: 'Borrowing 244.00 USDC' });
    await userEvent.hover(pill);

    const card = await screen.findByRole('tooltip');
    expect(within(card).getByText('USDC · Hyperliquid')).toBeInTheDocument();
    expect(within(card).getByText('USDC · Lighter')).toBeInTheDocument();
    expect(within(card).getByText('112.00 USDC')).toBeInTheDocument();
    expect(within(card).getByText('132.00 USDC')).toBeInTheDocument();
    expect(within(card).getByText('$22.40')).toBeInTheDocument();
    expect(within(card).getByText('$26.40')).toBeInTheDocument();
  });

  it('two coins fall back to a dollar total', async () => {
    const view = rebalanceViews.exampleE;
    const lighter = { coin: 'USDC', venue: 'LIGHTER', cash: -200, upnl: 0, equity: -200, borrow: 200, imHeldUsd: 40, mmHeldUsd: 20, interestPaidUsd: 0, interestPerDayUsd: 0.06 };
    server.use(rebalanceHandler({ ...view, buckets: [...view.buckets, lighter] }));
    renderWithClient(<BorrowChip onOpen={vi.fn()} />);

    const pill = await screen.findByRole('button', { name: 'Borrowing $812.35' });
    await userEvent.hover(pill);

    const card = await screen.findByRole('tooltip');
    expect(within(card).getByText('USDT · CrossEx')).toBeInTheDocument();
    expect(within(card).getByText('USDC · Lighter')).toBeInTheDocument();
  });

  it('one wallet keeps the coin pill, not the two wallet table', async () => {
    server.use(rebalanceHandler(rebalanceViews.oneBorrow));
    renderWithClient(<BorrowChip onOpen={vi.fn()} />);

    const pill = await screen.findByRole('button', { name: 'Borrowing 132.00 USDC' });
    await userEvent.hover(pill);

    const card = await screen.findByRole('tooltip');
    expect(within(card).getByText('Lent by Gate')).toBeInTheDocument();
    expect(within(card).queryByText('Wallet')).toBeNull();
  });

  it('pill total equals card total with a borrow under $1', async () => {
    const view = rebalanceViews.oneBorrow;
    const buckets = view.buckets.map((b) =>
      b.coin === 'USDC' && b.venue === 'HYPERLIQUID'
        ? { ...b, cash: -0.4, upnl: 0, equity: -0.4, borrow: 0.4, imHeldUsd: 0.08, mmHeldUsd: 0.04, interestPerDayUsd: 0 }
        : b,
    );
    server.use(rebalanceHandler({ ...view, buckets }));
    renderWithClient(<BorrowChip onOpen={vi.fn()} />);

    const cardTotal = num(borrowTotalUsd(buckets), 2);
    expect(await screen.findByRole('button', { name: `Borrowing ${cardTotal} USDC` })).toBeInTheDocument();
  });

  it('no pill under a dollar', async () => {
    server.use(rebalanceHandler(rebalanceViews.borrowUnderOne));
    renderWithClient(<BorrowChip onOpen={vi.fn()} />);

    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('button', { name: /^Borrowing/ })).toBeNull();
  });
});
