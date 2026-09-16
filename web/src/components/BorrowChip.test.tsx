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
  return [...(dt?.parentElement?.querySelectorAll('dd') ?? [])].map((dd) => dd.textContent ?? '');
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
    expect(factLines(card, 'Held against the borrow')).toEqual(['$29.41']);
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
    const lighter = { coin: 'USDC', venue: 'LIGHTER', cash: -500, upnl: 0, equity: -500, borrow: 500, imHeldUsd: 100, mmHeldUsd: 50, interestPaidUsd: 0, interestPerDayUsd: 0.15 };
    server.use(rebalanceHandler({ ...view, buckets: [...view.buckets, lighter] }));
    renderWithClient(<BorrowChip onOpen={vi.fn()} />);

    const card = await hoverPill('Borrowing 500.00 USDC');
    expect(factLines(card, 'Borrowing')).toEqual(['500.00 USDC', 'USDC · Lighter']);
    expect(legLines(card)).toEqual(['Lighter legs']);
    expect(factLines(card, 'Held against the borrow')).toEqual(['$100.00']);
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
    expect(factLines(card, 'Borrowing')).toEqual(['244.00 USDC', 'Lighter 132.00 · Hyperliquid 112.00']);
    expect(factLines(card, 'Held against the borrow')).toEqual(['$48.80', 'Lighter $26.40 · Hyperliquid $22.40']);
    expect(within(card).queryByRole('table')).toBeNull();
  });

  it('two wallets show both legs lines in the Borrowing order', async () => {
    server.use(rebalanceHandler(rebalanceViews.twoBorrows));
    renderWithClient(<BorrowChip onOpen={vi.fn()} />);

    const card = await hoverPill('Borrowing 244.00 USDC');
    expect(factLines(card, 'Borrowing')[1]).toBe('Lighter 132.00 · Hyperliquid 112.00');
    expect(legLines(card)).toEqual(['Lighter legs', 'Hyperliquid legs']);
    expect([...card.querySelectorAll('dt')].map((dt) => dt.textContent)).toEqual(['Borrowing', 'For', 'Held against the borrow']);
  });

  it('two coins fall back to a dollar total', async () => {
    const view = rebalanceViews.exampleE;
    const lighter = { coin: 'USDC', venue: 'LIGHTER', cash: -200, upnl: 0, equity: -200, borrow: 200, imHeldUsd: 40, mmHeldUsd: 20, interestPaidUsd: 0, interestPerDayUsd: 0.06 };
    server.use(rebalanceHandler({ ...view, buckets: [...view.buckets, lighter] }));
    renderWithClient(<BorrowChip onOpen={vi.fn()} />);

    const card = await hoverPill('Borrowing $812.35');
    expect(factLines(card, 'Borrowing')).toEqual(['$812.35', 'CrossEx $612.35 · Lighter $200.00']);
  });

  it('one wallet names the wallet under the total, no table', async () => {
    server.use(rebalanceHandler(rebalanceViews.oneBorrow));
    renderWithClient(<BorrowChip onOpen={vi.fn()} />);

    const card = await hoverPill('Borrowing 132.00 USDC');
    expect(factLines(card, 'Borrowing')).toEqual(['132.00 USDC', 'USDC · Lighter']);
    expect(factLines(card, 'Held against the borrow')).toEqual(['$26.40']);
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
    expect(factLines(card, 'Borrowing')).toEqual(['132.40 USDC', 'Lighter 132.00 · Hyperliquid 0.40']);
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
