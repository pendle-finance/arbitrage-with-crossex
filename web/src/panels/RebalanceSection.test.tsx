import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import type {
  RebalanceBucket,
  RebalanceJob,
  RebalancePlan,
  RebalanceRoute,
  RebalanceStep,
  RebalanceView,
} from '../api/types';
import { env, server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { RebalanceSection } from './RebalanceSection';

const usdc = (over: Partial<RebalanceBucket> = {}): RebalanceBucket => ({
  coin: 'USDC',
  venue: 'HYPERLIQUID',
  cash: -1200,
  upnl: 300,
  equity: -900,
  borrow: 1200,
  interestPaid30dUsd: 4.2,
  interestPerDayUsd: 0.31,
  ...over,
});

const usdt: RebalanceBucket = {
  coin: 'USDT',
  venue: 'CROSSEX',
  cash: 5000,
  upnl: 0,
  equity: 5000,
  borrow: 0,
  interestPaid30dUsd: 0,
  interestPerDayUsd: 0,
};

const route = (over: Partial<RebalanceRoute> = {}): RebalanceRoute => ({
  costUsd: 0.5,
  waitSeconds: 150,
  available: true,
  reason: null,
  ...over,
});

const plan = (over: Partial<RebalancePlan> = {}): RebalancePlan => ({
  amount: 900,
  shortfall: null,
  routes: { loop: route(), convert: route({ costUsd: 1.8, waitSeconds: 0 }) },
  route: 'loop',
  savesPerDayUsd: 0.29,
  marginFreedUsd: 450,
  ...over,
});

const step = (name: string, over: Partial<RebalanceStep> = {}): RebalanceStep => ({
  name,
  text: null,
  quoteId: null,
  venueId: null,
  qty: null,
  balanceBefore: null,
  attempt: 0,
  status: 'pending',
  startedAt: null,
  doneAt: null,
  ...over,
});

const job = (over: Partial<RebalanceJob> = {}): RebalanceJob => ({
  id: 'rb-1',
  route: 'loop',
  amount: 900,
  status: 'running',
  stepIndex: 1,
  steps: [
    step('Buy USDC', { status: 'done', startedAt: 1_000, doneAt: 3_000, venueId: 'o-1' }),
    step('To spot', { status: 'running', startedAt: 3_000 }),
    step('To Hyperliquid'),
  ],
  fundsAt: 'GATE',
  haltReason: null,
  createdAt: 1_000,
  updatedAt: 3_000,
  ...over,
});

const view = (over: Partial<RebalanceView> = {}): RebalanceView => ({
  buckets: [usdc(), usdt],
  plan: plan(),
  job: null,
  ...over,
});

function serve(v: RebalanceView) {
  let gets = 0;
  server.use(
    http.get('/api/rebalance', () => {
      gets += 1;
      return HttpResponse.json(env(v));
    }),
  );
  return () => gets;
}

function refuseStart() {
  server.use(
    http.post('/api/rebalance', () =>
      HttpResponse.json(
        {
          ok: false,
          error: { category: 'validation', message: 'a trade is unfilled: deal-7', retryable: true },
        },
        { status: 409 },
      ),
    ),
  );
}

const section = () => screen.findByRole('region', { name: 'Pay down' });

describe('RebalanceSection', () => {
  it('shows the three tiles and the cost line with the loop wait', async () => {
    serve(view());
    renderWithClient(<RebalanceSection holdMs={50} />);

    await section();
    expect(screen.getByText('Borrow (USDC)')).toBeInTheDocument();
    expect(screen.getByText('1,200.00')).toBeInTheDocument();
    expect(screen.getByText('Interest / day')).toBeInTheDocument();
    expect(screen.getByText('$0.31')).toBeInTheDocument();
    expect(screen.getByText('Interest paid · 30 d')).toBeInTheDocument();
    expect(screen.getByText('$4.20')).toBeInTheDocument();
    expect(
      screen.getByText('costs $0.50 · saves $0.29/day · frees $450.00 margin · about 2.5 min'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pay down 900.00 USDC' })).toBeEnabled();
  });

  it('says instant for the convert route', async () => {
    serve(view({ plan: plan({ route: 'convert' }) }));
    renderWithClient(<RebalanceSection holdMs={50} />);

    await section();
    expect(
      screen.getByText('costs $1.80 · saves $0.29/day · frees $450.00 margin · instant'),
    ).toBeInTheDocument();
  });

  it('shows the shortfall line with the cash reason', async () => {
    serve(view({ plan: plan({ amount: 600, shortfall: { reason: 'cash', remaining: 300 } }) }));
    renderWithClient(<RebalanceSection holdMs={50} />);

    await section();
    expect(
      screen.getByText(
        'Only 600.00 USDC can move. 300.00 USDC stays borrowed: unrealised profit cannot move until the position closes',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pay down 600.00 USDC' })).toBeInTheDocument();
  });

  it('shows both route reasons and no cost line when there is no route', async () => {
    serve(
      view({
        plan: plan({
          route: null,
          routes: {
            loop: route({ available: false, reason: 'USDC transfer is disabled' }),
            convert: route({ available: false, reason: 'convert quote failed' }),
          },
        }),
      }),
    );
    renderWithClient(<RebalanceSection holdMs={50} />);

    await section();
    expect(screen.getByText('Loop: USDC transfer is disabled')).toBeInTheDocument();
    expect(screen.getByText('Convert: convert quote failed')).toBeInTheDocument();
    expect(screen.queryByText(/costs \$/)).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders nothing with borrow 0 and no job', async () => {
    const gets = serve(view({ buckets: [usdc({ cash: 0, equity: 0, borrow: 0 }), usdt], plan: plan({ amount: 0, route: null }) }));
    renderWithClient(<RebalanceSection holdMs={50} />);

    await waitFor(() => expect(gets()).toBe(1));
    expect(screen.queryByRole('region', { name: 'Pay down' })).toBeNull();
  });

  it('shows one row per step for a running job', async () => {
    serve(view({ job: job() }));
    renderWithClient(<RebalanceSection holdMs={50} />);

    await section();
    const rows = screen.getAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Buy USDC'),
      expect.stringContaining('To spot'),
      expect.stringContaining('To Hyperliquid'),
    ]);
    expect(rows[0].textContent).toContain('done');
    expect(rows[0].textContent).toContain('2s');
    expect(rows[1].textContent).toContain('running');
    expect(rows[2].textContent).toContain('pending');
    expect(rows[2].textContent).toContain('—');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows the halt reason, the funds location, Resume and Abandon', async () => {
    serve(
      view({
        job: job({
          status: 'halted',
          haltReason: 'timeout',
          fundsAt: 'SPOT',
          steps: [
            step('Buy USDC', { status: 'done', startedAt: 1_000, doneAt: 3_000 }),
            step('To spot', { status: 'done', startedAt: 3_000, doneAt: 8_000 }),
            step('To Hyperliquid', { status: 'running', startedAt: 8_000 }),
          ],
        }),
      }),
    );
    renderWithClient(<RebalanceSection holdMs={50} />);

    await section();
    expect(screen.getByText('timeout')).toHaveClass('text-rose-300');
    expect(screen.getByText('Funds are in SPOT')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resume' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Abandon' })).toBeEnabled();
  });

  it('posts resume for the halted job on Resume', async () => {
    const halted = job({ status: 'halted', haltReason: 'server restarted', fundsAt: 'GATE' });
    serve(view({ job: halted }));
    const posts: string[] = [];
    server.use(
      http.post('/api/rebalance/:id/:cmd', ({ params }) => {
        posts.push(`${params.id}/${params.cmd}`);
        return HttpResponse.json(env({ ...halted, status: 'running' }));
      }),
    );
    renderWithClient(<RebalanceSection holdMs={50} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Resume' }));

    await waitFor(() => expect(posts).toEqual(['rb-1/resume']));
  });

  it('stops a halted step counter at the halt time', async () => {
    serve(
      view({
        job: job({
          status: 'halted',
          haltReason: 'timeout',
          fundsAt: 'SPOT',
          updatedAt: 13_000,
          steps: [
            step('Buy USDC', { status: 'done', startedAt: 1_000, doneAt: 3_000 }),
            step('To spot', { status: 'done', startedAt: 3_000, doneAt: 8_000 }),
            step('To Hyperliquid', { status: 'running', startedAt: 8_000 }),
          ],
        }),
      }),
    );
    renderWithClient(<RebalanceSection holdMs={50} />);

    await section();
    const rows = screen.getAllByRole('listitem');
    expect(within(rows[2]).getByText('5s')).toBeInTheDocument();
  });

  it('sends one POST /api/rebalance with the plan amount and route after a full hold', async () => {
    serve(view());
    const posts: unknown[] = [];
    server.use(
      http.post('/api/rebalance', async ({ request }) => {
        posts.push(await request.json());
        return HttpResponse.json(env({ id: 'rb-2' }), { status: 202 });
      }),
    );
    renderWithClient(<RebalanceSection holdMs={50} />);

    const btn = await screen.findByRole('button', { name: 'Pay down 900.00 USDC' });
    fireEvent.pointerDown(btn);

    await waitFor(() => expect(posts).toEqual([{ amount: 900, route: 'loop' }]));
    await new Promise((r) => setTimeout(r, 200));
    expect(posts).toHaveLength(1);
  });

  it('shows the 409 message when the start is refused', async () => {
    serve(view());
    refuseStart();
    renderWithClient(<RebalanceSection holdMs={50} />);

    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Pay down 900.00 USDC' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('a trade is unfilled: deal-7');
  });

  it('drops a refused start error once the poll shows a halted job', async () => {
    serve(view());
    refuseStart();
    renderWithClient(<RebalanceSection holdMs={50} />);

    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Pay down 900.00 USDC' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('a trade is unfilled: deal-7');

    serve(view({ job: job({ status: 'halted', haltReason: 'timeout', fundsAt: 'SPOT' }) }));

    await screen.findByRole('button', { name: 'Resume' }, { timeout: 6_000 });
    expect(screen.getByRole('button', { name: 'Abandon' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  }, 10_000);
});
