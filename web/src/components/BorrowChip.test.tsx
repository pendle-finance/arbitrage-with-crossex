import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { borrowTotalUsd } from '../lib/borrow';
import { num } from '../lib/fmt';
import { rebalanceHandler, rebalanceViews } from '../test/fixtures';
import { server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { BorrowChip } from './BorrowChip';

async function hoverPill(name: string): Promise<HTMLElement> {
  const pill = await screen.findByRole('button', { name });
  await userEvent.hover(pill);
  return screen.findByRole('tooltip');
}

function factLines(card: HTMLElement, label: string): string[] {
  const dt = within(card).getByText(label).closest('dt');
  return [...(dt?.parentElement?.querySelectorAll('dd:not([data-fact-rows])') ?? [])].map((dd) => dd.textContent ?? '');
}

function factRows(card: HTMLElement, label: string): { name: string; value: string }[] {
  const dt = within(card).getByText(label).closest('dt');
  const grid = dt?.parentElement?.querySelector('[data-fact-rows]');
  if (!grid) return [];
  const spans = [...grid.querySelectorAll('span')];
  const out: { name: string; value: string }[] = [];
  for (let i = 0; i < spans.length; i += 2) out.push({ name: spans[i].textContent ?? '', value: spans[i + 1].textContent ?? '' });
  return out;
}

function legLines(card: HTMLElement): string[] {
  const dt = within(card).getByText('For').closest('dt');
  return [...(dt?.parentElement?.querySelectorAll('dd span') ?? [])].map((span) => span.textContent ?? '');
}

describe('BorrowChip', () => {
  it('hover facts for one borrow', async () => {
    server.use(rebalanceHandler(rebalanceViews.accountA));
    renderWithClient(<BorrowChip onOpen={vi.fn()} />);

    const card = await hoverPill('Borrowing 147.05 USDC');
    expect(factLines(card, 'Borrowing')).toEqual(['147.05 USDC', 'USDC · Hyperliquid']);
    expect(within(card).queryByText('Held against the borrow')).toBeNull();
    expect(legLines(card)).toEqual(['Hyperliquid legs']);
    expect(within(card).queryByText('Lent by Gate')).toBeNull();
  });

  it('hover link', async () => {
    server.use(rebalanceHandler(rebalanceViews.accountA));
    const onOpen = vi.fn();
    renderWithClient(<BorrowChip onOpen={onOpen} />);

    const card = await hoverPill('Borrowing 147.05 USDC');
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

  it('USDT borrow names the CrossEx wallet', async () => {
    server.use(rebalanceHandler(rebalanceViews.exampleE));
    renderWithClient(<BorrowChip onOpen={vi.fn()} />);

    const card = await hoverPill('Borrowing 612.35 USDT');
    expect(factLines(card, 'Borrowing')).toEqual(['612.35 USDT', 'USDT · CrossEx']);
    expect(legLines(card)).toEqual(['Gate, Binance, OKX and Bybit legs']);
  });

  it('Lighter borrow names the Lighter wallet', async () => {
    const view = rebalanceViews.exampleC;
    const lighter = { coin: 'USDC', venue: 'LIGHTER', cash: -500, upnl: 0, equity: -500, borrow: 500, imHeldUsd: 100, mmHeldUsd: 50, interestPaidUsd: 0, interestPerDayUsd: 0.15, ratePerYear: 0.1095 };
    server.use(rebalanceHandler({ ...view, buckets: [...view.buckets, lighter] }));
    renderWithClient(<BorrowChip onOpen={vi.fn()} />);

    const card = await hoverPill('Borrowing 500.00 USDC');
    expect(factLines(card, 'Borrowing')).toEqual(['500.00 USDC', 'USDC · Lighter']);
    expect(legLines(card)).toEqual(['Lighter legs']);
    expect(within(card).queryByText('Held against the borrow')).toBeNull();
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

  it('pill sums every borrow, one line per fact, no table', async () => {
    server.use(rebalanceHandler(rebalanceViews.twoBorrows));
    renderWithClient(<BorrowChip onOpen={vi.fn()} />);

    const card = await hoverPill('Borrowing 244.00 USDC');
    expect(factLines(card, 'Borrowing')).toEqual(['244.00 USDC']);
    expect(factRows(card, 'Borrowing')).toEqual([
      { name: 'Lighter', value: '132.00' },
      { name: 'Hyperliquid', value: '112.00' },
    ]);
    expect(within(card).queryByText('Held against the borrow')).toBeNull();
    expect(within(card).queryByRole('table')).toBeNull();
  });

  it('two wallets show both legs lines in the Borrowing order', async () => {
    server.use(rebalanceHandler(rebalanceViews.twoBorrows));
    renderWithClient(<BorrowChip onOpen={vi.fn()} />);

    const card = await hoverPill('Borrowing 244.00 USDC');
    expect(factRows(card, 'Borrowing').map((row) => row.name)).toEqual(['Lighter', 'Hyperliquid']);
    expect(legLines(card)).toEqual(['Lighter legs', 'Hyperliquid legs']);
    expect([...card.querySelectorAll('dt')].map((dt) => dt.textContent)).toEqual(['Borrowing', 'For']);
  });

  it('two coins fall back to a dollar total', async () => {
    const view = rebalanceViews.exampleE;
    const lighter = { coin: 'USDC', venue: 'LIGHTER', cash: -200, upnl: 0, equity: -200, borrow: 200, imHeldUsd: 40, mmHeldUsd: 20, interestPaidUsd: 0, interestPerDayUsd: 0.06, ratePerYear: 0.1095 };
    server.use(rebalanceHandler({ ...view, buckets: [...view.buckets, lighter] }));
    renderWithClient(<BorrowChip onOpen={vi.fn()} />);

    const card = await hoverPill('Borrowing $812.35');
    expect(factLines(card, 'Borrowing')).toEqual(['$812.35']);
    expect(factRows(card, 'Borrowing')).toEqual([
      { name: 'CrossEx', value: '$612.35' },
      { name: 'Lighter', value: '$200.00' },
    ]);
  });

  it('one wallet names the wallet under the total, no table', async () => {
    server.use(rebalanceHandler(rebalanceViews.oneBorrow));
    renderWithClient(<BorrowChip onOpen={vi.fn()} />);

    const card = await hoverPill('Borrowing 132.00 USDC');
    expect(factLines(card, 'Borrowing')).toEqual(['132.00 USDC', 'USDC · Lighter']);
    expect(within(card).queryByText('Held against the borrow')).toBeNull();
    expect(within(card).queryByRole('table')).toBeNull();
  });

  it('a wallet under $1 counts in the pill total and the hover line', async () => {
    const view = rebalanceViews.oneBorrow;
    const buckets = view.buckets.map((b) =>
      b.coin === 'USDC' && b.venue === 'HYPERLIQUID'
        ? { ...b, cash: -0.4, upnl: 0, equity: -0.4, borrow: 0.4, imHeldUsd: 0.08, mmHeldUsd: 0.04, interestPerDayUsd: 0 }
        : b,
    );
    server.use(rebalanceHandler({ ...view, buckets }));
    renderWithClient(<BorrowChip onOpen={vi.fn()} />);

    const cardTotal = num(borrowTotalUsd(buckets), 2);
    const card = await hoverPill(`Borrowing ${cardTotal} USDC`);
    expect(factLines(card, 'Borrowing')).toEqual(['132.40 USDC']);
    expect(factRows(card, 'Borrowing')).toEqual([
      { name: 'Lighter', value: '132.00' },
      { name: 'Hyperliquid', value: '0.40' },
    ]);
  });

  it('pill shows when every borrow is under a dollar', async () => {
    server.use(rebalanceHandler(rebalanceViews.borrowUnderOne));
    renderWithClient(<BorrowChip onOpen={vi.fn()} />);

    const card = await hoverPill('Borrowing 0.40 USDC');
    expect(factLines(card, 'Borrowing')).toEqual(['0.40 USDC', 'USDC · Hyperliquid']);
  });

  it('no pill without a borrow', async () => {
    server.use(rebalanceHandler(rebalanceViews.accountB));
    renderWithClient(<BorrowChip onOpen={vi.fn()} />);

    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('button', { name: /^Borrowing/ })).toBeNull();
  });
});
