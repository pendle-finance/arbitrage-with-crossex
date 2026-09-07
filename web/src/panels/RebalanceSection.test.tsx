import { fireEvent, screen, waitFor } from '@testing-library/react';
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

const PAY_DOWN_TEXT =
  "Sends USDT to Hyperliquid as USDC and pays the borrow back. Each USDC paid back cuts the borrow by 1 USDC and frees 0.20 USDC of initial margin and 0.10 USDC of maintenance margin. Your account total changes only by the route's cost.";
const PULL_TEXT =
  'Brings USDC from Hyperliquid back to USDT. You can pull at most the USDC you own there, so a pull never starts a new borrow.';
const LOOP_LINE =
  'via spot loop · 900.00 USDT → 899.55 USDC @ 1.0005 · costs $0.50 · saves $0.29/day · frees $450.00 margin · borrow after $300.45 · about 2.5 min';
const PULL_LINE = 'via spot loop · 400.00 USDC → 399.52 USDT @ 0.9988 · costs $0.60 · about 6.7 min';
const HOLD = 'Hold to move 900.00 USDT → USDC';
const PULL_HOLD = 'Hold to pull 400.00 USDC → USDT';

const usdc = (over: Partial<RebalanceBucket> = {}): RebalanceBucket => ({
  coin: 'USDC',
  venue: 'HYPERLIQUID',
  cash: -1200,
  upnl: 300,
  equity: -900,
  borrow: 1200,
  imHeldUsd: 240,
  mmHeldUsd: 120,
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
  imHeldUsd: 0,
  mmHeldUsd: 0,
  interestPaid30dUsd: 0,
  interestPerDayUsd: 0,
};

const pullBuckets = [
  usdc({ cash: 400, upnl: 100, equity: 500, borrow: 0, imHeldUsd: 0, mmHeldUsd: 0, interestPaid30dUsd: 0, interestPerDayUsd: 0 }),
  usdt,
];

const route = (over: Partial<RebalanceRoute> = {}): RebalanceRoute => ({
  costUsd: 0.5,
  waitSeconds: 150,
  available: true,
  reason: null,
  ...over,
});

const plan = (over: Partial<RebalancePlan> = {}): RebalancePlan => ({
  direction: 'payDown',
  amount: 900,
  receives: 899.55,
  price: 1.0005,
  borrowAfterUsd: 300.45,
  shortfall: null,
  routes: { loop: route(), convert: route({ costUsd: 1.8, waitSeconds: 0 }) },
  route: 'loop',
  savesPerDayUsd: 0.29,
  marginFreedUsd: 450,
  ...over,
});

const pullPlan = (over: Partial<RebalancePlan> = {}): RebalancePlan =>
  plan({
    direction: 'pull',
    amount: 400,
    receives: 399.52,
    price: 0.9988,
    borrowAfterUsd: 0,
    routes: {
      loop: route({ costUsd: 0.6, waitSeconds: 400 }),
      convert: route({ costUsd: 0, waitSeconds: 0, available: false, reason: 'convert runs one way only' }),
    },
    savesPerDayUsd: 0,
    marginFreedUsd: 0,
    ...over,
  });

const noRoutePlan = (over: Partial<RebalancePlan> = {}): RebalancePlan =>
  plan({
    amount: 0,
    receives: 0,
    price: null,
    borrowAfterUsd: 0,
    routes: {
      loop: route({ available: false, reason: 'nothing to move' }),
      convert: route({ waitSeconds: 0, available: false, reason: 'nothing to move' }),
    },
    route: null,
    savesPerDayUsd: 0,
    marginFreedUsd: 0,
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
  direction: 'payDown',
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

const haltedJob = () =>
  job({
    status: 'halted',
    haltReason: 'timeout',
    fundsAt: 'SPOT',
    updatedAt: 13_000,
    steps: [
      step('Buy USDC', { status: 'done', startedAt: 1_000, doneAt: 3_000 }),
      step('To spot', { status: 'done', startedAt: 3_000, doneAt: 8_000 }),
      step('To Hyperliquid', { status: 'running', startedAt: 8_000 }),
    ],
  });

const view = (over: Partial<RebalanceView> = {}): RebalanceView => ({
  buckets: [usdc(), usdt],
  plan: plan(),
  job: null,
  ...over,
});

type Answer = RebalanceView | ((url: URL) => RebalanceView);

function serve(answer: Answer) {
  const urls: URL[] = [];
  server.use(
    http.get('/api/rebalance', ({ request }) => {
      const url = new URL(request.url);
      urls.push(url);
      return HttpResponse.json(env(typeof answer === 'function' ? answer(url) : answer));
    }),
  );
  return urls;
}

const byDirection = (payDown: RebalanceView, pull: RebalanceView) => (url: URL) =>
  url.searchParams.get('direction') === 'pull' ? pull : payDown;

const borrowAccount = () => byDirection(view(), view({ plan: noRoutePlan({ direction: 'pull' }) }));

const pullAccount = () =>
  byDirection(view({ buckets: pullBuckets, plan: noRoutePlan() }), view({ buckets: pullBuckets, plan: pullPlan() }));

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

function recordStarts() {
  const posts: unknown[] = [];
  server.use(
    http.post('/api/rebalance', async ({ request }) => {
      posts.push(await request.json());
      return HttpResponse.json(env({ id: 'rb-2' }), { status: 202 });
    }),
  );
  return posts;
}

const section = () => screen.findByRole('region', { name: 'Rebalance' });
const amountInput = (label: string) => screen.getByRole('textbox', { name: label });
const toPull = () => userEvent.click(screen.getByRole('radio', { name: 'Hyperliquid USDC → USDT' }));

describe('RebalanceSection', () => {
  it('shows the Rebalance header, the borrow pill, and the two tiles', async () => {
    serve(view());
    renderWithClient(<RebalanceSection holdMs={50} />);

    await section();
    expect(screen.getByRole('heading', { name: 'Rebalance' })).toBeInTheDocument();
    expect(screen.getByText('move cash between USDT and Hyperliquid USDC')).toBeInTheDocument();
    expect(screen.getByText('Borrow $1,200.00 · +$240.00 IM · +$120.00 MM')).toHaveClass('border-amber-500/30');
    expect(screen.getByText('Interest / day')).toBeInTheDocument();
    expect(screen.getByText('$0.31')).toBeInTheDocument();
    expect(screen.getByText('Interest paid · 30 d')).toBeInTheDocument();
    expect(screen.getByText('$4.20')).toBeInTheDocument();
    expect(screen.queryByText('Borrow (USDC)')).toBeNull();
  });

  it('floors the borrow pill to cents so it never shows more than the button', async () => {
    serve(view({ buckets: [usdc({ borrow: 1200.999 }), usdt] }));
    renderWithClient(<RebalanceSection holdMs={50} />);

    await section();
    expect(screen.getByText('Borrow $1,200.99 · +$240.00 IM · +$120.00 MM')).toBeInTheDocument();
  });

  it('shows the explanation line for each direction', async () => {
    serve(borrowAccount());
    renderWithClient(<RebalanceSection holdMs={50} />);

    await section();
    expect(screen.getByText(PAY_DOWN_TEXT)).toBeInTheDocument();

    await toPull();

    expect(await screen.findByText(PULL_TEXT)).toBeInTheDocument();
    expect(screen.queryByText(PAY_DOWN_TEXT)).toBeNull();
  });

  it('opens the what-and-why card from the info mark next to the title', async () => {
    serve(borrowAccount());
    renderWithClient(<RebalanceSection holdMs={50} />);

    await section();
    expect(screen.queryByRole('tooltip')).toBeNull();

    await userEvent.hover(screen.getByText('About rebalance').parentElement!);

    const card = await screen.findByRole('tooltip');
    expect(card).toHaveTextContent('Gate lends you the USDC to cover it');
    expect(card).toHaveTextContent('20% as initial margin and 10% as maintenance margin');
    expect(card).toHaveTextContent('USDT → Hyperliquid USDC pays the borrow back');

    await userEvent.unhover(screen.getByText('About rebalance').parentElement!);

    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  });

  it('defaults the direction to pull when there is no borrow and USDC can be pulled', async () => {
    const urls = serve(pullAccount());
    renderWithClient(<RebalanceSection holdMs={50} />);

    await section();
    expect(urls[0].searchParams.has('direction')).toBe(false);
    expect(await screen.findByRole('radio', { name: 'Hyperliquid USDC → USDT', checked: true })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'USDT → Hyperliquid USDC' })).not.toBeChecked();
    await waitFor(() => expect(urls.at(-1)?.searchParams.get('direction')).toBe('pull'));
    expect(await screen.findByRole('button', { name: PULL_HOLD })).toBeInTheDocument();
  });

  it('re-reads the plan and resets the input when the direction toggles', async () => {
    const urls = serve(pullAccount());
    renderWithClient(<RebalanceSection holdMs={50} />);

    await screen.findByRole('button', { name: PULL_HOLD });
    expect(screen.getByRole('radiogroup', { name: 'Direction' })).toBeInTheDocument();
    const pullInput = amountInput('Amount (USDC) · free 400.00');
    expect(pullInput).toHaveValue('400.00');
    expect(screen.getByText(PULL_TEXT)).toBeInTheDocument();
    expect(screen.getByText(PULL_LINE)).toBeInTheDocument();
    await userEvent.clear(pullInput);
    await userEvent.type(pullInput, '77');
    expect(pullInput).toHaveValue('77');

    await userEvent.click(screen.getByRole('radio', { name: 'USDT → Hyperliquid USDC' }));

    await waitFor(() => expect(urls.at(-1)?.searchParams.has('direction')).toBe(false));
    expect(screen.getByRole('radio', { name: 'USDT → Hyperliquid USDC' })).toBeChecked();
    const input = await screen.findByRole('textbox', { name: 'Amount (USDT) · free 5,000.00' });
    await waitFor(() => expect(input).toHaveValue('0.00'));
    expect(screen.getByText(PAY_DOWN_TEXT)).toBeInTheDocument();
    expect(screen.queryByText(PULL_LINE)).toBeNull();
    expect(screen.getByText('Loop: nothing to move')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Hold to/ })).toBeNull();

    await toPull();

    await waitFor(() => expect(urls.at(-1)?.searchParams.get('direction')).toBe('pull'));
    expect(await screen.findByRole('textbox', { name: 'Amount (USDC) · free 400.00' })).toHaveValue('400.00');
    expect(screen.getByText(PULL_TEXT)).toBeInTheDocument();
    expect(await screen.findByText(PULL_LINE)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: PULL_HOLD })).toBeInTheDocument();
  });

  it('prefills the amount and re-reads the plan with the typed amount after 300 ms', async () => {
    const urls = serve((url) => {
      const typed = url.searchParams.get('amount');
      return typed === null ? view() : view({ plan: plan({ amount: Math.min(Number(typed), 900) }) });
    });
    renderWithClient(<RebalanceSection holdMs={50} />);

    await section();
    const input = amountInput('Amount (USDT) · free 5,000.00');
    expect(input).toHaveValue('900.00');
    expect(screen.getByRole('button', { name: HOLD })).toBeEnabled();

    await userEvent.clear(input);
    await userEvent.type(input, '500');

    expect(input).toHaveValue('500');
    expect(urls.some((u) => u.searchParams.has('amount'))).toBe(false);
    await waitFor(() => expect(urls.at(-1)?.searchParams.get('amount')).toBe('500'));
    expect(await screen.findByRole('button', { name: 'Hold to move 500.00 USDT → USDC' })).toBeEnabled();
    expect(input).toHaveValue('500');
    expect(screen.queryByText(/Capped at/)).toBeNull();
  });

  it('shows Capped at in amber when the typed amount is above the plan amount', async () => {
    serve((url) => (url.searchParams.get('amount') === '1000' ? view({ plan: plan({ amount: 900 }) }) : view()));
    renderWithClient(<RebalanceSection holdMs={50} />);

    await section();
    const input = amountInput('Amount (USDT) · free 5,000.00');
    await userEvent.clear(input);
    await userEvent.type(input, '1000');

    expect(await screen.findByText('Capped at 900.00')).toHaveClass('text-amber-300');
    expect(input).toHaveValue('1000');
    expect(screen.getByRole('button', { name: HOLD })).toBeEnabled();
  });

  it('asks for an amount after blur when it is empty, zero, or not a number, and disables the hold', async () => {
    serve(view());
    renderWithClient(<RebalanceSection holdMs={50} />);

    await section();
    const input = amountInput('Amount (USDT) · free 5,000.00');
    await userEvent.clear(input);
    expect(screen.queryByText('Enter an amount')).toBeNull();
    expect(screen.getByRole('button', { name: HOLD })).toBeDisabled();

    await userEvent.tab();

    expect(await screen.findByRole('alert')).toHaveTextContent('Enter an amount');
    expect(input).toHaveAttribute('aria-invalid', 'true');

    await userEvent.type(input, '0');
    expect(screen.getByRole('alert')).toHaveTextContent('Enter an amount');
    expect(screen.getByRole('button', { name: HOLD })).toBeDisabled();

    await userEvent.clear(input);
    await userEvent.type(input, 'abc');
    expect(screen.getByRole('alert')).toHaveTextContent('Enter an amount');
    expect(screen.getByRole('button', { name: HOLD })).toBeDisabled();

    await userEvent.clear(input);
    await userEvent.type(input, '12');
    expect(screen.queryByRole('alert')).toBeNull();
    await waitFor(() => expect(screen.getByRole('button', { name: HOLD })).toBeEnabled());
  });

  it('shows the pull amount label with the smaller of cash and equity', async () => {
    serve(view({ buckets: [usdc({ cash: 600, upnl: -150, equity: 450, borrow: 0 }), usdt], plan: noRoutePlan() }));
    renderWithClient(<RebalanceSection holdMs={50} />);

    await section();
    expect(await screen.findByRole('textbox', { name: 'Amount (USDC) · free 450.00' })).toHaveValue('0.00');
  });

  it('shows the quote line for the spot loop', async () => {
    serve(view());
    renderWithClient(<RebalanceSection holdMs={50} />);

    await section();
    expect(screen.getByText(LOOP_LINE)).toBeInTheDocument();
  });

  it('shows the quote line for convert', async () => {
    serve(view({ plan: plan({ route: 'convert', price: 0.998, receives: 898.2 }) }));
    renderWithClient(<RebalanceSection holdMs={50} />);

    await section();
    expect(
      screen.getByText(
        'via convert · 900.00 USDT → 898.20 USDC @ 0.9980 · spread $1.80 · saves $0.29/day · frees $450.00 margin · borrow after $300.45 · instant · sends on a fresh quote within 30 bps of this one',
      ),
    ).toBeInTheDocument();
  });

  it('shows the quote line for a pull', async () => {
    serve(pullAccount());
    renderWithClient(<RebalanceSection holdMs={50} />);

    await section();
    expect(await screen.findByText(PULL_LINE)).toBeInTheDocument();
  });

  it('shows the shortfall line in amber under the quote line with the cash reason', async () => {
    serve(view({ plan: plan({ amount: 600, shortfall: { reason: 'cash', remaining: 300 } }) }));
    renderWithClient(<RebalanceSection holdMs={50} />);

    await section();
    expect(
      screen.getByText(
        'Only 600.00 USDC can move. 300.00 USDC stays borrowed: unrealised profit cannot move until the position closes',
      ),
    ).toHaveClass('text-amber-300');
    expect(screen.getByRole('button', { name: 'Hold to move 600.00 USDT → USDC' })).toBeInTheDocument();
  });

  it('shows both route reasons and no quote line or hold when there is no route', async () => {
    serve(
      view({
        plan: noRoutePlan({
          amount: 900,
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
    expect(screen.queryByText(/^via /)).toBeNull();
    expect(screen.queryByRole('button', { name: /^Hold to/ })).toBeNull();
    expect(amountInput('Amount (USDT) · free 5,000.00')).toHaveValue('900.00');
  });

  it('sends one POST /api/rebalance with the plan amount and route after a full hold', async () => {
    serve(view());
    const posts = recordStarts();
    renderWithClient(<RebalanceSection holdMs={50} />);

    const btn = await screen.findByRole('button', { name: HOLD });
    fireEvent.pointerDown(btn);

    await waitFor(() => expect(posts).toEqual([{ direction: 'payDown', amount: 900, route: 'loop' }]));
    await new Promise((r) => setTimeout(r, 200));
    expect(posts).toHaveLength(1);
  });

  it('posts direction pull after a full hold in the pull direction', async () => {
    serve(pullAccount());
    const posts = recordStarts();
    renderWithClient(<RebalanceSection holdMs={50} />);

    fireEvent.pointerDown(await screen.findByRole('button', { name: PULL_HOLD }));

    await waitFor(() => expect(posts).toEqual([{ direction: 'pull', amount: 400, route: 'loop' }]));
  });

  it('shows the 409 message when the start is refused', async () => {
    serve(view());
    refuseStart();
    renderWithClient(<RebalanceSection holdMs={50} />);

    fireEvent.pointerDown(await screen.findByRole('button', { name: HOLD }));

    expect(await screen.findByRole('alert')).toHaveTextContent('a trade is unfilled: deal-7');
  });

  it('drops a refused start error once the poll shows a halted job', async () => {
    serve(view());
    refuseStart();
    renderWithClient(<RebalanceSection holdMs={50} />);

    fireEvent.pointerDown(await screen.findByRole('button', { name: HOLD }));
    expect(await screen.findByRole('alert')).toHaveTextContent('a trade is unfilled: deal-7');

    serve(view({ job: job({ status: 'halted', haltReason: 'timeout', fundsAt: 'SPOT' }) }));

    await screen.findByRole('button', { name: 'Resume' }, { timeout: 6_000 });
    expect(screen.getByRole('button', { name: 'Abandon' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  }, 10_000);

  it('renders nothing with borrow 0, nothing to pull, and no job', async () => {
    const urls = serve(view({ buckets: [usdc({ cash: 0, upnl: 0, equity: 0, borrow: 0 }), usdt], plan: noRoutePlan() }));
    renderWithClient(<RebalanceSection holdMs={50} />);

    await waitFor(() => expect(urls).toHaveLength(1));
    expect(screen.queryByRole('region', { name: 'Rebalance' })).toBeNull();
  });

  it('renders with borrow 0 when USDC can be pulled, without the pill', async () => {
    serve(pullAccount());
    renderWithClient(<RebalanceSection holdMs={50} />);

    await section();
    expect(screen.queryByText(/^Borrow \$/)).toBeNull();
    expect(screen.getByRole('radiogroup', { name: 'Direction' })).toBeInTheDocument();
    expect(screen.getByText('Interest / day')).toBeInTheDocument();
  });

  it('renders with borrow 0 and nothing to pull while a job runs', async () => {
    serve(view({ buckets: [usdc({ cash: 0, upnl: 0, equity: 0, borrow: 0 }), usdt], plan: noRoutePlan(), job: job() }));
    renderWithClient(<RebalanceSection holdMs={50} />);

    await section();
    expect(screen.getAllByRole('progressbar')).toHaveLength(3);
  });

  it('shows a progress bar with one segment per step for a running job that ticks every second', async () => {
    const t0 = Date.now();
    serve(
      view({
        job: job({
          steps: [
            step('Buy USDC', { status: 'done', startedAt: t0 - 10_000, doneAt: t0 - 8_000 }),
            step('To spot', { status: 'running', startedAt: t0 - 2_000 }),
            step('To Hyperliquid'),
          ],
        }),
      }),
    );
    renderWithClient(<RebalanceSection holdMs={50} />);

    await section();
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();

    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toBe('Buy USDC2s');
    expect(rows[1].textContent).toMatch(/^To spot[23]s \/ ~5s$/);
    expect(rows[2].textContent).toBe('To Hyperliquid~2m 7s');

    expect(screen.getByRole('progressbar', { name: 'Buy USDC' })).toHaveAttribute('aria-valuenow', '100');
    const running = Number(screen.getByRole('progressbar', { name: 'To spot' }).getAttribute('aria-valuenow'));
    expect(running).toBeGreaterThanOrEqual(40);
    expect(running).toBeLessThanOrEqual(60);
    expect(screen.getByRole('progressbar', { name: 'To Hyperliquid' })).toHaveAttribute('aria-valuenow', '0');

    const before = rows[1].textContent;
    await waitFor(() => expect(rows[1].textContent).not.toBe(before), { timeout: 3_000 });
  });

  it('caps the running segment of the progress bar at 95%', async () => {
    const t0 = Date.now();
    serve(
      view({
        job: job({
          steps: [
            step('Buy USDC', { status: 'done', startedAt: t0 - 70_000, doneAt: t0 - 68_000 }),
            step('To spot', { status: 'running', startedAt: t0 - 60_500 }),
            step('To Hyperliquid'),
          ],
        }),
      }),
    );
    renderWithClient(<RebalanceSection holdMs={50} />);

    await section();
    expect(screen.getByRole('progressbar', { name: 'To spot' })).toHaveAttribute('aria-valuenow', '95');
    expect(screen.getAllByRole('listitem')[1].textContent).toBe('To spot1m 0s / ~5s');
  });

  it('shows the halted segment in rose with the halt reason, the funds location, Resume and Abandon', async () => {
    serve(view({ job: haltedJob() }));
    renderWithClient(<RebalanceSection holdMs={50} />);

    await section();
    expect(screen.getByText('halted at 5s')).toHaveClass('text-rose-300');
    expect(screen.getByRole('progressbar', { name: 'To Hyperliquid' })).toHaveAttribute('aria-valuenow', '4');
    expect(screen.getByRole('progressbar', { name: 'To Hyperliquid' }).firstChild).toHaveClass('bg-rose-500');
    expect(screen.getByText('timeout')).toHaveClass('text-rose-300');
    expect(screen.getByText('Funds are in SPOT')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resume' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Abandon' })).toBeEnabled();
  });

  it('labels the step a halted job stopped on as halted, not running', async () => {
    serve(view({ job: job({ status: 'halted', haltReason: 'timeout', fundsAt: 'GATE' }) }));
    renderWithClient(<RebalanceSection holdMs={50} />);

    await section();
    const rows = screen.getAllByRole('listitem');
    expect(rows[1].textContent).toContain('To spot');
    expect(rows[1].textContent).toContain('halted at');
    expect(rows[1].textContent).not.toContain('/ ~');
  });

  it('stops a halted step counter at the halt time', async () => {
    serve(view({ job: haltedJob() }));
    renderWithClient(<RebalanceSection holdMs={50} />);

    await section();
    expect(screen.getAllByRole('listitem')[2].textContent).toBe('To Hyperliquidhalted at 5s');
    await new Promise((r) => setTimeout(r, 1_100));
    expect(screen.getAllByRole('listitem')[2].textContent).toBe('To Hyperliquidhalted at 5s');
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

  it('returns to the idle state and re-reads the tiles within 5 s after the job is done', async () => {
    serve(view({ job: job() }));
    renderWithClient(<RebalanceSection holdMs={50} />);

    await section();
    expect(screen.getAllByRole('progressbar')).toHaveLength(3);

    serve(view({ buckets: [usdc({ borrow: 300, interestPerDayUsd: 0.08 }), usdt], job: job({ status: 'done' }) }));

    expect(await screen.findByRole('button', { name: HOLD }, { timeout: 5_000 })).toBeEnabled();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getByText('Borrow $300.00 · +$240.00 IM · +$120.00 MM')).toBeInTheDocument();
    expect(screen.getByText('$0.08')).toBeInTheDocument();
  }, 10_000);
});
