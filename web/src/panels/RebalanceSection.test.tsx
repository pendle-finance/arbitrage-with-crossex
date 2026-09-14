import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAccount, usePositions, useTransfer } from '../api/queries';
import type { CrossexAccount, PositionsResponse, RebalanceStep, RebalanceView, TransferView } from '../api/types';
import {
  accountBodies,
  accountHandler,
  makeCrossexPosition,
  REBALANCE_NOW,
  rebalanceHandler,
  rebalanceViews,
  transferHandler,
  transferViews,
} from '../test/fixtures';
import { env, server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { RebalanceSection } from './RebalanceSection';
import { TransferSection } from './TransferSection';

type User = ReturnType<typeof userEvent.setup>;

const NO_POSITIONS: PositionsResponse = { positions: [], exposure: [] };

const hypeLeg = (symbol: string, positionSide: 'LONG' | 'SHORT') =>
  makeCrossexPosition({
    symbol,
    positionSide,
    positionValue: '2000',
    markPrice: '44.35',
    maintenanceMargin: '20',
    initialMargin: '40',
  });

const HYPE_PAIR: PositionsResponse = {
  positions: [hypeLeg('GATE_FUTURE_HYPE_USDT', 'LONG'), hypeLeg('HYPERLIQUID_FUTURE_HYPE_USDC', 'SHORT')],
  exposure: [
    {
      base: 'HYPE',
      legs: [
        { symbol: 'GATE_FUTURE_HYPE_USDT', exchange: 'GATE', quote: 'USDT', side: 'LONG', qty: 45.1, value: 2000 },
        {
          symbol: 'HYPERLIQUID_FUTURE_HYPE_USDC',
          exchange: 'HYPERLIQUID',
          quote: 'USDC',
          side: 'SHORT',
          qty: 45.1,
          value: 2000,
        },
      ],
      longValue: 2000,
      shortValue: 2000,
      netValue: 0,
      grossValue: 4000,
      neutral: true,
      singleLeg: false,
    },
  ],
};

const HYPE_ACCOUNT: CrossexAccount = {
  ...accountBodies.accountA,
  marginBalance: '145.91',
  initialMargin: '109.41',
  maintenanceMargin: '54.705',
};

function serve({
  rebalance,
  transfer = transferViews.spotZero,
  account = accountBodies.accountA,
  positions = NO_POSITIONS,
}: {
  rebalance: RebalanceView;
  transfer?: TransferView;
  account?: CrossexAccount;
  positions?: PositionsResponse;
}) {
  server.use(
    rebalanceHandler(rebalance),
    transferHandler(transfer),
    accountHandler(account),
    http.get('/api/positions', () => HttpResponse.json(env(positions))),
  );
}

async function show(view: RebalanceView, over: { transfer?: TransferView; holdMs?: number } = {}) {
  serve({ rebalance: view, transfer: over.transfer });
  const onTransfer = vi.fn();
  renderWithClient(<RebalanceSection holdMs={over.holdMs} onTransfer={onTransfer} />);
  await screen.findByRole('region', { name: 'Rebalance' });
  return onTransfer;
}

const region = () => screen.getByRole('region', { name: 'Rebalance' });

const rowOf = (name: string) => screen.getByRole('radio', { name }).closest('label') as HTMLElement;

const routeNames = () =>
  screen
    .getAllByRole('radio')
    .map((radio) => document.getElementById(radio.getAttribute('aria-labelledby') ?? '')?.textContent);

const facts = (): Record<string, string | undefined> =>
  Object.fromEntries(
    [...region().querySelectorAll('dt')].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent ?? undefined]),
  );

const bars = (name: string): Record<string, string | null> => {
  const group = within(region()).getByRole('group', { name });
  return Object.fromEntries(
    [...group.querySelectorAll('span.num')].map((value) => [
      value.parentElement?.firstElementChild?.textContent ?? '',
      value.textContent,
    ]),
  );
};

const line = (text: string) => screen.queryByText((_, el) => el?.tagName === 'P' && el.textContent === text);

const realButton = (name: string) =>
  within(region())
    .getAllByRole('button', { name })
    .filter((el) => el.tagName === 'BUTTON');
async function hoverCard(user: User, name: string, scope: HTMLElement = document.body) {
  const [trigger] = await within(scope).findAllByRole('button', { name });
  await user.hover(trigger);
  const card = await screen.findByRole('tooltip');
  const shown = {
    text: card.textContent ?? '',
    terms: [...card.querySelectorAll('dt')].map((dt) => dt.textContent),
    rows: [...card.querySelectorAll('tbody tr')].map((tr) => tr.firstElementChild?.textContent),
  };
  await user.keyboard('{Escape}');
  await user.unhover(trigger);
  await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  return shown;
}

function Loaded() {
  const reads = [useTransfer().data, useAccount().data, usePositions().data];
  return reads.every(Boolean) ? <span>reads loaded</span> : null;
}

describe('RebalanceSection routes', () => {
  it('D three route rows', async () => {
    await show(rebalanceViews.exampleD);
    expect(routeNames()).toEqual(['Spot loop, then Convert', 'Spot loop', 'Convert']);
  });

  it('D recommended is picked', async () => {
    await show(rebalanceViews.exampleD);
    expect(screen.getByRole('radio', { name: 'Spot loop, then Convert' })).toBeChecked();
  });

  it('D tag on mix only', async () => {
    await show(rebalanceViews.exampleD);
    const tags = within(region()).getAllByText('Recommended');
    expect(tags).toHaveLength(1);
    expect(rowOf('Spot loop, then Convert')).toContainElement(tags[0]);
  });

  it('A two route rows', async () => {
    await show(rebalanceViews.accountA);
    expect(routeNames()).toEqual(['Spot loop', 'Convert']);
  });

  it('A tag on spot loop', async () => {
    await show(rebalanceViews.accountA);
    const tags = within(region()).getAllByText('Recommended');
    expect(tags).toHaveLength(1);
    expect(rowOf('Spot loop')).toContainElement(tags[0]);
  });

  it('D mix row text', async () => {
    await show(rebalanceViews.exampleD);
    expect(rowOf('Spot loop, then Convert')).toHaveTextContent('6 rounds, then Convert · about 13 min');
    expect(rowOf('Spot loop, then Convert')).toHaveTextContent('$15.68');
  });

  it('hold sends the picked route', async () => {
    const user = userEvent.setup();
    let body: unknown = null;
    server.use(
      http.post('/api/rebalance', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(env({ id: 'mtzunfww' }));
      }),
    );
    await show(rebalanceViews.exampleD, { holdMs: 50 });
    await user.click(screen.getByRole('radio', { name: 'Convert' }));
    expect(screen.getByRole('radio', { name: 'Convert' })).toBeChecked();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Hold to rebalance' }));
    await waitFor(() => expect(body).toEqual({ route: 'convert' }));
  });

  it('blocked row is disabled', async () => {
    await show(rebalanceViews.accountABlocked);
    expect(screen.getByRole('radio', { name: 'Spot loop' })).toBeDisabled();
  });

  it('blocked row shows reason', async () => {
    await show(rebalanceViews.accountABlocked);
    expect(rowOf('Spot loop')).toHaveTextContent('Gate paused USDC transfers.');
    expect(rowOf('Spot loop')).not.toHaveTextContent('5 rounds');
  });

  it('next run opens on recommended', async () => {
    const user = userEvent.setup();
    let view: RebalanceView = rebalanceViews.accountA;
    await show(view, { holdMs: 50 });
    server.use(
      http.get('/api/rebalance', () => HttpResponse.json(env(view))),
      http.post('/api/rebalance', () => {
        view = rebalanceViews.accountADone;
        return HttpResponse.json(env({ id: rebalanceViews.accountADone.job.id }));
      }),
    );
    await user.click(screen.getByRole('radio', { name: 'Convert' }));
    expect(screen.getByRole('radio', { name: 'Convert' })).toBeChecked();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Hold to rebalance' }));
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Spot loop' })).toBeChecked());
    expect(screen.getByRole('radio', { name: 'Convert' })).not.toBeChecked();
  });

  it('E mix row text', async () => {
    await show(rebalanceViews.exampleE);
    expect(rowOf('Spot loop, then Convert')).toHaveTextContent('1 round, then Convert · about 6.5 min');
    expect(rowOf('Spot loop, then Convert')).toHaveTextContent('$2.04');
  });

  it('clicking row text picks the route', async () => {
    const user = userEvent.setup();
    await show(rebalanceViews.exampleD);
    await user.click(within(rowOf('Spot loop')).getByText('Spot loop'));
    expect(screen.getByRole('radio', { name: 'Spot loop' })).toBeChecked();
    await user.click(within(rowOf('Spot loop, then Convert')).getByText('Recommended'));
    expect(screen.getByRole('radio', { name: 'Spot loop, then Convert' })).toBeChecked();
    await user.click(within(rowOf('Spot loop')).getByText('11 rounds'));
    expect(screen.getByRole('radio', { name: 'Spot loop' })).toBeChecked();
  });

  it('convert pick redraws after bars', async () => {
    const user = userEvent.setup();
    await show(rebalanceViews.accountA);
    await user.click(screen.getByRole('radio', { name: 'Convert' }));
    expect(Object.values(bars('After rebalance'))).toEqual(['28.54', '28.53', '0.00']);
  });

  it('load error shows the message and Retry reads again', async () => {
    const user = userEvent.setup();
    let reads = 0;
    serve({ rebalance: rebalanceViews.accountA });
    server.use(
      http.get('/api/rebalance', () => {
        reads += 1;
        if (reads > 1) return HttpResponse.json(env(rebalanceViews.accountA));
        return HttpResponse.json(
          { ok: false, error: { category: 'network', message: 'Gate did not answer.', retryable: true } },
          { status: 500 },
        );
      }),
    );
    renderWithClient(<RebalanceSection />);
    await waitFor(() => expect(line('Could not load the rebalance view. Gate did not answer.')).toBeInTheDocument());
    await user.click(within(region()).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('radiogroup', { name: 'Route' })).toBeInTheDocument();
    expect(reads).toBe(2);
    expect(line('Could not load the rebalance view. Gate did not answer.')).toBeNull();
  });

  it('load error stays while the retry poll runs', async () => {
    const user = userEvent.setup();
    let reads = 0;
    serve({ rebalance: rebalanceViews.accountA });
    server.use(
      http.get('/api/rebalance', () => {
        reads += 1;
        if (reads === 1) {
          return HttpResponse.json(
            { ok: false, error: { category: 'network', message: 'Gate did not answer.', retryable: true } },
            { status: 500 },
          );
        }
        return new Promise(() => undefined);
      }),
    );
    renderWithClient(<RebalanceSection />);
    await waitFor(() => expect(line('Could not load the rebalance view. Gate did not answer.')).toBeInTheDocument());
    await user.click(within(region()).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(reads).toBe(2));
    expect(line('Could not load the rebalance view. Gate did not answer.')).toBeInTheDocument();
    expect(within(region()).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('refused hold shows the server message', async () => {
    server.use(
      http.post('/api/rebalance', () =>
        HttpResponse.json(
          { ok: false, error: { category: 'validation', message: 'Already even.', retryable: false } },
          { status: 409 },
        ),
      ),
    );
    await show(rebalanceViews.accountA, { holdMs: 50 });
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Hold to rebalance' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Already even.');
    expect(within(region()).getByRole('radiogroup', { name: 'Route' })).toBeInTheDocument();
    expect(within(region()).getByRole('button', { name: 'Hold to rebalance' })).toBeEnabled();
  });
});

describe('RebalanceSection hovers and copy', () => {
  it('rounds hover labels', async () => {
    const user = userEvent.setup();
    await show(rebalanceViews.exampleD);
    expect((await hoverCard(user, '6 rounds')).terms).toEqual(['A round', 'Why more than one', 'Why 6']);
  });

  it('rounds hover names borrow margin', async () => {
    const user = userEvent.setup();
    await show(rebalanceViews.exampleD);
    expect((await hoverCard(user, '6 rounds')).text).toContain(
      'Your borrow locks $1,922.48 (20%) as initial margin.',
    );
  });

  it('one round hover', async () => {
    const user = userEvent.setup();
    await show(rebalanceViews.exampleE);
    const card = await hoverCard(user, '1 round');
    expect(card.terms).toEqual(['A round', 'Why 1']);
    expect(card.terms).not.toContain('Why more than one');
  });

  it('one round hover says why', async () => {
    const user = userEvent.setup();
    await show(rebalanceViews.exampleE);
    expect((await hoverCard(user, '1 round')).text).toContain('1 round, then Convert costs $2.04. 2 rounds cost $2.12.');
  });

  it('recommended hover', async () => {
    const user = userEvent.setup();
    await show(rebalanceViews.exampleD);
    expect((await hoverCard(user, 'Recommended')).text).toBe('Cheapest route that takes 15 min or less.');
  });

  it('info card', async () => {
    const user = userEvent.setup();
    await show(rebalanceViews.accountA);
    const card = await hoverCard(user, 'Rebalance', region());
    expect(card.text.startsWith('CrossEx margin sits in two wallets.')).toBe(true);
    expect(card.rows).toEqual(['Spot loop', 'Convert']);
  });

  it('every term has its hover', async () => {
    const user = userEvent.setup();
    const check = async (scope: string, terms: [string, string][]) => {
      const card = await screen.findByRole('region', { name: scope });
      for (const [name, text] of terms) expect((await hoverCard(user, name, card)).text).toContain(text);
    };

    serve({
      rebalance: rebalanceViews.accountA,
      transfer: transferViews.accountB,
      account: HYPE_ACCOUNT,
      positions: HYPE_PAIR,
    });
    let shown = renderWithClient(<RebalanceSection />);
    await check('Rebalance', [
      ['Rebalance', 'CrossEx margin sits in two wallets. USDT: Gate, Binance, OKX and Bybit legs. USDC: Hyperliquid legs.'],
      ['Rebalance', 'Rebalance makes their equity equal. A negative wallet is a borrow.'],
      ['USDT · CrossEx', 'CrossEx wallet. Margin for Gate, Binance, OKX and Bybit legs.'],
      ['USDC · Hyperliquid', 'CrossEx wallet. Margin for Hyperliquid legs.'],
      ['USDC · Gate', 'CrossEx wallet. USDC left from a spot buy. Still margin. Rebalance empties it.'],
      ['Now', 'Equity = cash + unrealized PnL.'],
      ['Interest', 'No interest under 10,000 USDC.'],
      ['Interest paid', 'Total interest paid, all time.'],
      ['Route', 'How the money moves. Cost includes Gate fees and spot spread.'],
      ['Recommended', 'Cheapest route that takes 15 min or less.'],
      [
        'Spot loop',
        'Buy USDC in CrossEx, move it through Gate spot into the CrossEx Hyperliquid wallet. Gate has no direct transfer between CrossEx wallets. Repeats in rounds.',
      ],
      ['Convert', 'Instant swap between your CrossEx USDT and USDC wallets. 0.2% fee.'],
      ['5 rounds', 'Buy USDC in CrossEx. Move it to Gate spot, then into the CrossEx Hyperliquid wallet. About 2 min.'],
      ['5 rounds', 'Gate caps each transfer by your free margin.'],
      ['5 rounds', 'Spot loop runs until even. That takes 5 rounds here.'],
      ['Frees', 'Initial margin the repaid borrow no longer locks.'],
      ['Saves', 'Borrow interest per day this stops.'],
      ['Liquidation', 'Price where Gate liquidates the account if only this coin moves. Now → after the rebalance.'],
      ['Gate spot', 'Not margin.'],
    ]);
    shown.unmount();

    serve({ rebalance: rebalanceViews.exampleD });
    shown = renderWithClient(<RebalanceSection />);
    await check('Rebalance', [
      ['Spot loop, then Convert', 'Spot loop for up to 6 rounds, then Convert the rest.'],
      ['6 rounds', 'Recommended stops at 6 rounds. Convert does the rest.'],
    ]);
    shown.unmount();

    serve({ rebalance: rebalanceViews.exampleC });
    shown = renderWithClient(<RebalanceSection />);
    await check('Rebalance', [
      [
        'Spot loop',
        'Move USDC from the CrossEx Hyperliquid wallet through Gate spot, back into CrossEx, and sell it for USDT. Repeats in rounds.',
      ],
      [
        '1 round',
        'Move USDC from the CrossEx Hyperliquid wallet to Gate spot, then back into CrossEx. Sell it for USDT. About 6.5 min.',
      ],
      ['1 round', 'One round moves it all.'],
      ['Short of even', 'Unrealized gain. Cannot move until those positions close.'],
    ]);
    shown.unmount();

    serve({ rebalance: rebalanceViews.accountARunning });
    shown = renderWithClient(<RebalanceSection />);
    await check('Rebalance', [['On the way', 'In transit through Gate spot. Not margin.']]);
    shown.unmount();

    serve({ rebalance: rebalanceViews.accountAHalted });
    shown = renderWithClient(<RebalanceSection />);
    await check('Rebalance', [
      ['Gate spot', 'Not margin.'],
      ['About Resume', 'Continue from the stopped step.'],
      ['About Abandon', 'Stop the run. Funds stay where they are.'],
    ]);
    shown.unmount();

    serve({ rebalance: rebalanceViews.accountB, transfer: transferViews.accountB, account: accountBodies.accountB });
    shown = renderWithClient(<TransferSection />);
    await check('Transfer', [
      ['Transfer', "Move funds between Gate spot and CrossEx. Gate's website cannot do this."],
      ['Fee', 'Gate fee. Into the CrossEx Hyperliquid wallet $0.05. Out of it $1.00. Others free.'],
      ['Time', 'Typical time. Moves out of the CrossEx Hyperliquid wallet can take longer.'],
      ['up to 816.10', "Free margin, capped at this wallet's cash."],
      ['Gate spot', 'Not margin.'],
    ]);
    shown.unmount();

    shown = renderWithClient(<TransferSection pick={{ coin: 'USDC', wallet: 'CROSSEX_HYPERLIQUID', nonce: 1 }} />);
    await check('Transfer', [
      ['Minimum', 'Gate minimum for moves into or out of the CrossEx Hyperliquid wallet. Fee included.'],
      ['up to 0.00', 'Your Gate spot balance.'],
    ]);
    shown.unmount();
  }, 60_000);

  it('subtitle', async () => {
    await show(rebalanceViews.accountA);
    expect(within(region()).getByText('Even out your CrossEx USDT and USDC wallets')).toBeInTheDocument();
  });

  it('no direction toggle', async () => {
    await show(rebalanceViews.accountA);
    expect(within(region()).getAllByRole('radiogroup').map((group) => group.getAttribute('aria-label'))).toEqual([
      'Route',
    ]);
    expect(within(region()).queryByText(/USDT → USDC|USDC → USDT/)).toBeNull();
  });

  it('no amount input', async () => {
    await show(rebalanceViews.accountA);
    expect(within(region()).getByRole('button', { name: 'Hold to rebalance' })).toBeInTheDocument();
    expect(within(region()).queryByRole('textbox')).toBeNull();
    expect(within(region()).queryByRole('spinbutton')).toBeNull();
  });

  it('hold label', async () => {
    await show(rebalanceViews.accountA);
    expect(within(region()).getByRole('button', { name: 'Hold to rebalance' })).toHaveTextContent('Hold to rebalance');
  });

  it('blocked reason has no hover', async () => {
    await show(rebalanceViews.accountABlocked);
    const reason = within(region()).getByText('Gate paused USDC transfers.');
    expect(reason.closest('[role="button"]')).toBeNull();
    expect(reason.closest('.border-dotted')).toBeNull();
  });
});

describe('RebalanceSection bars and facts', () => {
  it('A now bars', async () => {
    await show(rebalanceViews.accountA);
    expect(Object.values(bars('Now'))).toEqual(['92.54', '-147.05', '111.96']);
  });

  it('A after bars', async () => {
    await show(rebalanceViews.accountA);
    expect(Object.values(bars('After rebalance'))).toEqual(['28.61', '28.58', '0.00']);
  });

  it('bars draw a zero line', async () => {
    await show(rebalanceViews.accountA);
    for (const name of ['Now', 'After rebalance']) {
      const group = within(region()).getByRole('group', { name });
      const rows = [...group.querySelectorAll('span.num')].map((value) => value.parentElement as HTMLElement);
      for (const row of rows) {
        expect(row.querySelectorAll('[data-zero-line]')).toHaveLength(1);
      }
    }
  });

  it('C legend', async () => {
    await show(rebalanceViews.exampleC);
    expect(within(region()).getAllByText('cash')).toHaveLength(1);
    expect(within(region()).getAllByText('unrealized gain')).toHaveLength(1);
  });

  it('C moves fact', async () => {
    await show(rebalanceViews.exampleC);
    expect(facts().Moves).toBe('22.18 USDC');
  });

  it('C short fact', async () => {
    await show(rebalanceViews.exampleC);
    expect(facts()['Short of even']).toBe('8.00 USDC');
  });

  it('C chip', async () => {
    await show(rebalanceViews.exampleC);
    expect(within(region()).getByText('Ends as even as cash allows')).toBeInTheDocument();
  });

  it('frees fact', async () => {
    await show(rebalanceViews.accountA);
    expect(screen.getByRole('radio', { name: 'Spot loop' })).toBeChecked();
    expect(facts().Frees).toBe('$29.41 margin');
  });

  it('saves fact', async () => {
    await show(rebalanceViews.accountA);
    expect(screen.getByRole('radio', { name: 'Spot loop' })).toBeChecked();
    expect(facts().Saves).toBe('$0.00 / day');
  });

  it('no frees without borrow', async () => {
    await show(rebalanceViews.exampleC);
    expect(facts().Moves).toBe('22.18 USDC');
    expect(facts()).not.toHaveProperty('Frees');
  });

  it('no liquidation without a position', async () => {
    serve({ rebalance: rebalanceViews.accountA, account: HYPE_ACCOUNT, positions: NO_POSITIONS });
    renderWithClient(
      <>
        <RebalanceSection />
        <Loaded />
      </>,
    );
    await screen.findByText('reads loaded');
    expect(facts().Frees).toBe('$29.41 margin');
    expect(facts()).not.toHaveProperty('Liquidation');
  });

  it('liquidation before and after', async () => {
    serve({ rebalance: rebalanceViews.accountA, account: HYPE_ACCOUNT, positions: HYPE_PAIR });
    renderWithClient(<RebalanceSection />);
    await screen.findByRole('region', { name: 'Rebalance' });
    const pattern = /^HYPE (~\$[\d,.]+ \(\+\d+%\)) → (~\$[\d,.]+ \(\+\d+%\))$/;
    await waitFor(() => expect(facts().Liquidation).toMatch(pattern));
    const [, before, after] = pattern.exec(facts().Liquidation ?? '') ?? [];
    expect(before).not.toBe(after);
  });

  it('five rounds shown', async () => {
    const user = userEvent.setup();
    await show(rebalanceViews.accountA);
    await user.click(within(region()).getByRole('button', { name: 'Show the 5 rounds' }));
    expect(within(within(region()).getByRole('list')).getAllByRole('listitem')).toHaveLength(5);
  });

  it('round 4 text', async () => {
    const user = userEvent.setup();
    await show(rebalanceViews.accountA);
    await user.click(within(region()).getByRole('button', { name: 'Show the 5 rounds' }));
    const row = within(region()).getAllByRole('listitem')[3];
    expect(within(row).getByText('Buy 23.77 USDC, move 44.71 USDC to the CrossEx Hyperliquid wallet')).toBeInTheDocument();
  });

  it('round 4 sub text', async () => {
    const user = userEvent.setup();
    await show(rebalanceViews.accountA);
    await user.click(within(region()).getByRole('button', { name: 'Show the 5 rounds' }));
    const row = within(region()).getAllByRole('listitem')[3];
    expect(within(row).getByText('44.66 arrives · borrow left 11.53')).toBeInTheDocument();
  });

  it('last round pays the borrow', async () => {
    const user = userEvent.setup();
    await show(rebalanceViews.accountA);
    await user.click(within(region()).getByRole('button', { name: 'Show the 5 rounds' }));
    const row = within(region()).getAllByRole('listitem')[4];
    expect(within(row).getByText('40.10 arrives · borrow paid')).toBeInTheDocument();
  });

  it('no borrow shows arrives only', async () => {
    const user = userEvent.setup();
    await show(rebalanceViews.accountB);
    await user.click(within(region()).getByRole('button', { name: 'Show the round' }));
    const [row] = within(region()).getAllByRole('listitem');
    expect(within(row).getByText('477.24 arrives')).toBeInTheDocument();
    expect(within(region()).queryByText(/borrow paid/)).toBeNull();
  });

  it('no borrow job row shows arrives only', async () => {
    const job = rebalanceViews.balancedDone.job;
    await show({
      ...rebalanceViews.accountB,
      job: {
        ...job,
        status: 'halted',
        steps: job.steps.map((step, index): RebalanceStep => {
          if (index === 2) return { ...step, qty: null, status: 'running', doneAt: null };
          return step;
        }),
      },
    });
    const [row] = within(region()).getAllByRole('listitem');
    expect(within(row).getByText('477.24 arrives')).toBeInTheDocument();
    expect(within(region()).queryByText(/borrow paid/)).toBeNull();
  });
});

describe('RebalanceSection run states', () => {
  beforeEach(() => {
    vi.setSystemTime(REBALANCE_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('running facts', async () => {
    await show(rebalanceViews.accountARunning);
    expect(facts()).toEqual({ Route: 'Spot loop', Round: '3 of 5', Time: '4m 58s of about 11 min' });
  });

  it('no stop while running', async () => {
    await show(rebalanceViews.accountARunning);
    expect(facts().Round).toBe('3 of 5');
    expect(within(region()).queryByRole('button', { name: /^(Stop|Cancel|Abandon)$/ })).toBeNull();
  });

  it('running wait line', async () => {
    await show(rebalanceViews.accountARunning);
    expect(line('New deals and transfers wait until it ends.')).toBeInTheDocument();
  });

  it('on the way bar', async () => {
    await show(rebalanceViews.accountARunning);
    expect(bars('Now')['On the way']).toBe('36.58');
  });

  it('halted alert', async () => {
    await show(rebalanceViews.accountAHalted);
    const alert = within(region()).getByRole('alert');
    expect([...alert.querySelectorAll('p')].map((p) => p.textContent)).toEqual([
      'Stopped in round 3.',
      'Gate paused transfers into the CrossEx Hyperliquid wallet.',
    ]);
  });

  it('halted where the money is', async () => {
    await show(rebalanceViews.accountAHalted);
    expect(bars('Where your money is')['Gate spot']).toBe('36.58');
  });

  it('halted buttons', async () => {
    await show(rebalanceViews.accountAHalted);
    expect(realButton('Resume')).toHaveLength(1);
    expect(realButton('Abandon')).toHaveLength(1);
  });

  it('buttons off while a command is pending', async () => {
    const user = userEvent.setup();
    let answer: () => void = () => undefined;
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    server.use(
      http.post('/api/rebalance/:id/:command', async () => {
        await answered;
        return HttpResponse.json(env(rebalanceViews.accountAHalted.job));
      }),
    );
    await show(rebalanceViews.accountAHalted);
    const [resume] = realButton('Resume');
    const [abandon] = realButton('Abandon');
    await waitFor(() => expect(resume).toBeEnabled());
    await user.click(resume);
    await waitFor(() => expect(resume).toBeDisabled());
    expect(abandon).toBeDisabled();
    answer();
    await waitFor(() => expect(resume).toBeEnabled());
    expect(abandon).toBeEnabled();
  });

  it('halted with the money inside CrossEx', async () => {
    await show(rebalanceViews.haltedInside);
    const alert = within(region()).getByRole('alert');
    expect([...alert.querySelectorAll('p')].map((p) => p.textContent)).toEqual([
      'Stopped in round 3.',
      'The app restarted during the run.',
    ]);
    expect(Object.values(bars('Where your money is'))).toEqual(['92.54', '-92.71', '57.52']);
    expect(bars('Where your money is')).not.toHaveProperty('Gate spot');
  });

  it('running toward USDT', async () => {
    await show(rebalanceViews.exampleERunning);
    expect(facts()).toEqual({ Route: 'Spot loop', Round: '1 of 2', Time: '2m 30s of about 13 min' });
    const rows = within(region()).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(
      within(rows[0]).getByText('Move 745.44 USDC out of the CrossEx Hyperliquid wallet, sell 744.44 for USDT'),
    ).toBeInTheDocument();
    expect(within(rows[0]).getByText('CrossEx Hyperliquid wallet to Gate spot')).toBeInTheDocument();
    expect(within(rows[0]).getByText('2m 30s of about 6.5 min')).toBeInTheDocument();
    expect(
      within(rows[1]).getByText('Move 482.87 USDC out of the CrossEx Hyperliquid wallet, sell 481.87 for USDT'),
    ).toBeInTheDocument();
    expect(within(rows[1]).getByText('481.87 arrives · borrow paid')).toBeInTheDocument();
    expect(within(rows[1]).getByText('about 6.5 min')).toBeInTheDocument();
  });

  it('running mix at the Convert row', async () => {
    const job = rebalanceViews.exampleDRunningConvert.job;
    await show({
      ...rebalanceViews.exampleDRunningConvert,
      job: {
        ...job,
        stepIndex: 17,
        steps: job.steps.map((step, index): RebalanceStep => {
          if (index === 17) return { ...step, qty: null, status: 'running', doneAt: null };
          if (index === 18) return { ...step, status: 'pending', startedAt: null };
          return step;
        }),
      },
    });
    let rows = within(region()).getAllByRole('listitem');
    expect(rows).toHaveLength(7);
    expect(within(rows[6]).getByText('Convert')).toBeInTheDocument();
    expect(within(rows[6]).getByText('instant')).toBeInTheDocument();
    expect(facts().Round).toBe('6 of 6');
    cleanup();

    await show(rebalanceViews.exampleDRunningConvert);
    expect(facts()).toEqual({ Route: 'Spot loop, then Convert', Time: '13m 3s of about 13 min' });
    rows = within(region()).getAllByRole('listitem');
    expect(rows[6]).toHaveAttribute('aria-current', 'step');
    expect(within(rows[6]).getByText('Convert')).toBeInTheDocument();
    expect(within(rows[6]).getByText('Convert 7,521.59 USDT to USDC')).toBeInTheDocument();
  });

  it('halted buttons press from the keyboard', async () => {
    const user = userEvent.setup();
    const sent: string[] = [];
    server.use(
      http.post('/api/rebalance/:id/:command', ({ params }) => {
        sent.push(String(params.command));
        return HttpResponse.json(env(rebalanceViews.accountAHalted.job));
      }),
    );
    await show(rebalanceViews.accountAHalted);
    for (const name of ['Resume', 'Abandon']) {
      const buttons = within(region()).getAllByRole('button', { name });
      expect(buttons).toHaveLength(1);
      await waitFor(() => expect(buttons[0]).toBeEnabled());
      buttons[0].focus();
      await user.keyboard('{Enter}');
      await waitFor(() => expect(sent).toContain(name.toLowerCase()));
    }
  });

  it('running round shows its leg', async () => {
    await show(rebalanceViews.accountARunning);
    const rows = within(region()).getAllByRole('listitem');
    expect(within(rows[2]).getByText('Gate spot to the CrossEx Hyperliquid wallet')).toBeInTheDocument();
    expect(within(rows[3]).getByText('44.66 arrives · borrow left 11.53')).toBeInTheDocument();
  });

  it('running after bars', async () => {
    await show(rebalanceViews.accountARunning);
    expect(Object.values(bars('After rebalance'))).toEqual(['28.61', '28.58', '0.00']);
  });
});

describe('RebalanceSection balanced and spot money', () => {
  it('balanced chip', async () => {
    await show(rebalanceViews.balancedDone);
    expect(within(region()).getByText('Balanced')).toBeInTheDocument();
  });

  it('balanced hold off', async () => {
    await show(rebalanceViews.balancedDone);
    expect(within(region()).getByRole('button', { name: 'Hold to rebalance' })).toBeDisabled();
  });

  it('last run facts', async () => {
    await show(rebalanceViews.balancedDone);
    expect(facts()).toEqual({ 'Last run': '1 round of spot loop', Took: '2m 14s', Cost: '$0.10' });
  });

  it('old job hides cost', async () => {
    await show(rebalanceViews.oldDone);
    expect(facts()['Last run']).toBe('1 round of spot loop');
    expect(facts()).not.toHaveProperty('Cost');
  });

  it('last run for a mix job', async () => {
    await show(rebalanceViews.mixDone);
    expect(facts()).toEqual({ 'Last run': '6 rounds, then Convert', Took: '13m 3s', Cost: '$15.68' });
  });

  it('last run for a Convert job', async () => {
    await show(rebalanceViews.convertDone);
    expect(facts()).toEqual({ 'Last run': 'Convert', Took: '2s', Cost: '$0.36' });
  });

  it('balanced with no job', async () => {
    await show(rebalanceViews.balancedNoJob);
    expect(within(region()).getByText('Balanced')).toBeInTheDocument();
    expect(facts()).toEqual({});
  });

  it('one spot line per coin', async () => {
    const user = userEvent.setup();
    const onTransfer = await show(rebalanceViews.accountB, { transfer: transferViews.spotBoth });
    await waitFor(() => expect(within(region()).getAllByRole('button', { name: 'Transfer ▸' })).toHaveLength(2));
    const lines = [...region().querySelectorAll('p')]
      .map((p) => p.textContent)
      .filter((text) => text?.startsWith('Gate spot has'));
    expect(lines).toEqual([
      'Gate spot has 318.42 USDT. Move it in to use it.',
      'Gate spot has 25.00 USDC. Move it in to use it.',
    ]);
    await user.click(within(region()).getAllByRole('button', { name: 'Transfer ▸' })[1]);
    expect(onTransfer).toHaveBeenCalledWith('USDC', 'CROSSEX_HYPERLIQUID');
  });

  it('spot money line', async () => {
    const user = userEvent.setup();
    const onTransfer = await show(rebalanceViews.accountB, { transfer: transferViews.accountB });
    await waitFor(() => expect(line('Gate spot has 318.42 USDT. Move it in to use it.')).toBeInTheDocument());
    await user.click(within(region()).getByRole('button', { name: 'Transfer ▸' }));
    expect(onTransfer).toHaveBeenCalledWith('USDT', 'CROSSEX');
  });

  it('after abandon line', async () => {
    const user = userEvent.setup();
    const onTransfer = await show(rebalanceViews.accountAAbandoned, { transfer: transferViews.noSpot });
    await waitFor(() => expect(line('Last run left 36.58 USDC in Gate spot.')).toBeInTheDocument());
    await user.click(within(region()).getByRole('button', { name: 'Transfer ▸' }));
    expect(onTransfer).toHaveBeenCalledWith('USDC', 'CROSSEX_HYPERLIQUID');
  });

  it('no spot line under 1', async () => {
    serve({ rebalance: rebalanceViews.accountB, transfer: transferViews.spotDust });
    renderWithClient(
      <>
        <RebalanceSection />
        <Loaded />
      </>,
    );
    await screen.findByRole('region', { name: 'Rebalance' });
    await screen.findByText('reads loaded');
    expect(within(region()).queryByRole('button', { name: 'Transfer ▸' })).toBeNull();
    expect(within(region()).queryByText(/Gate spot has/)).toBeNull();
  });

  it('waits for transfer', async () => {
    await show(rebalanceViews.accountA, { transfer: transferViews.moving });
    await waitFor(() => expect(line('Rebalance waits until the transfer ends.')).toBeInTheDocument());
    expect(within(region()).getByRole('button', { name: 'Hold to rebalance' })).toBeDisabled();
  });
});
