/** The /ltp pitch page: a hub that opens three panels and prices everything
 * through GET /api/opportunities-ltp with the assumptions-widget knobs. The
 * canonical LTP fixture: short Hyperliquid / long Binance, hero APR on $2,012
 * posted capital. */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ltpOpportunitiesHandler, makeLtpOpportunitiesResult } from './test/ltpFixtures';
import { server } from './test/server';
import { renderWithClient } from './test/utils';
import { LtpLandingApp } from './LtpLandingApp';

const paramsOf = (url: string) => Object.fromEntries(new URL(url).searchParams);

describe('LtpLandingApp (pitch page)', () => {
  it('renders the hub and prices with the default assumptions', async () => {
    const urls: string[] = [];
    server.use(ltpOpportunitiesHandler(makeLtpOpportunitiesResult(), { urls }));
    renderWithClient(<LtpLandingApp />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Fixed Return Funding Rate Arbitrage',
    );

    await waitFor(() => expect(urls.length).toBeGreaterThan(0));
    const params = paramsOf(urls[0]);
    expect(params).toMatchObject({
      notionalUsd: '200000',
      borosEntry: 'market',
      entryMode: 'maker-hedge',
      exitMode: 'close',
      perpLeverage: '15',
      borrowLeverage: '2',
      loanRateApr: '0.105',
      ltpTier: 'vip2',
    });

    // The hub's live tile carries the fixture's best APR.
    const apr = makeLtpOpportunitiesResult().groups[0].bestPair!.netFixedAprOnCapital!;
    const hub = await screen.findByRole('button', { name: /open live opportunities/i });
    await waitFor(() => expect(hub).toHaveTextContent(`${(apr * 100).toFixed(1)}% Fixed`));
  });

  it('opens the live panel and re-prices when an assumption changes', async () => {
    const urls: string[] = [];
    server.use(ltpOpportunitiesHandler(makeLtpOpportunitiesResult(), { urls }));
    renderWithClient(<LtpLandingApp />);

    await userEvent.click(screen.getByRole('button', { name: /open live opportunities/i }));
    // The fixture card renders with its venues (the system diagram repeats
    // them, so more than one match is expected).
    await screen.findByText('Fixed APR');
    expect(screen.getAllByText('Hyperliquid').length).toBeGreaterThan(0);

    // Open the assumptions widget and drop the MarginX borrow to 1×.
    await userEvent.click(screen.getByRole('button', { name: /assumptions/i }));
    // The fixture's short leg is a DMA account — the maintenance-fee note shows.
    expect(screen.getByText(/min \$2,000 \/ month/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '1×' }));
    await waitFor(() => expect(urls.some((u) => paramsOf(u).borrowLeverage === '1')).toBe(true));
  });

  it('boxes toggle their own sections open and closed', async () => {
    server.use(ltpOpportunitiesHandler(makeLtpOpportunitiesResult()));
    renderWithClient(<LtpLandingApp />);
    const box = () => screen.getByRole('button', { name: 'Three parts of the strategy' });

    expect(box()).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(box());
    await waitFor(() => expect(box()).toHaveAttribute('aria-expanded', 'true'));
    await userEvent.click(box());
    await waitFor(() => expect(box()).toHaveAttribute('aria-expanded', 'false'));
  });
});
