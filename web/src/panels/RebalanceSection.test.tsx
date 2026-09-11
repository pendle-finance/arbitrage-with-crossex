import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  RebalanceBucket,
  RebalanceJob,
  RebalancePlan,
  RebalanceRoute,
  RebalanceStep,
  RebalanceView,
} from '../api/types';
import { account, ethPosition } from '../test/fixtures';
import { env, server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { RebalanceSection } from './RebalanceSection';

const PAY_USDC_TEXT = 'Pays the USDC borrow back. Each USDC frees 0.20 initial and 0.10 maintenance margin.';
const PAY_USDT_TEXT = 'Pays the USDT borrow back. Each USDT frees 0.20 initial and 0.10 maintenance margin.';
const HOME_TEXT = 'Brings spare USDC home. Capped at what you own there, so it never borrows.';
/** A labelled fact's value, or null when the label is not on screen. */
const fact = (label: string) => screen.queryByText(label, { selector: 'dt' })?.nextElementSibling?.textContent ?? null;
const expectFacts = (facts: Record<string, string>) => {
  for (const [label, value] of Object.entries(facts)) expect(fact(label)).toBe(value);
};
const LOOP_FACTS = {
  Route: 'Spot loop · about 2.5 min',
  Sends: '900.00 USDT → 899.55 USDC @ 1.0005',
  Cost: '$0.50',
  'Borrow after': '$300.45',
  Frees: '$450.00 margin',
  Saves: '$0.29 / day',
};
const TO_USDT_FACTS = { Route: 'Spot loop · about 6.7 min', Sends: '400.00 USDC → 399.52 USDT @ 0.9988', Cost: '$0.60' };
const CONVERT_NOTE = 'Sends on a fresh quote within 30 bps of this one.';
const HOLD = 'Hold to move 900.00 USDT → USDC';
const TO_USDT_HOLD = 'Hold to move 400.00 USDC → USDT';

const usdc = (over: Partial<RebalanceBucket> = {}): RebalanceBucket => ({
  coin: 'USDC',
  venue: 'HYPERLIQUID',
  cash: -1200,
  upnl: 300,
  equity: -900,
  borrow: 1200,
  imHeldUsd: 240,
  mmHeldUsd: 120,
  interestPaidUsd: 4.2,
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
  interestPaidUsd: 0,
  interestPerDayUsd: 0,
};

const toUsdtBuckets = [
  usdc({ cash: 400, upnl: 100, equity: 500, borrow: 0, imHeldUsd: 0, mmHeldUsd: 0, interestPaidUsd: 0, interestPerDayUsd: 0 }),
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
  direction: 'toUsdc',
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

const toUsdtPlan = (over: Partial<RebalancePlan> = {}): RebalancePlan =>
  plan({
    direction: 'toUsdt',
    amount: 400,
    receives: 399.52,
    price: 0.9988,
    borrowAfterUsd: 0,
    routes: {
      loop: route({ costUsd: 0.6, waitSeconds: 400 }),
      convert: route({ costUsd: 0, waitSeconds: 0, available: false, reason: 'Convert runs only from USDT to USDC.' }),
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
  attempt: 0,
  status: 'pending',
  startedAt: null,
  doneAt: null,
  ...over,
});

const job = (over: Partial<RebalanceJob> = {}): RebalanceJob => ({
  id: 'rb-1',
  direction: 'toUsdc',
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

const byDirection = (toUsdc: RebalanceView, toUsdt: RebalanceView) => (url: URL) =>
  url.searchParams.get('direction') === 'toUsdt' ? toUsdt : toUsdc;

const borrowAccount = () => byDirection(view(), view({ plan: noRoutePlan({ direction: 'toUsdt' }) }));

const toUsdtAccount = () =>
  byDirection(view({ buckets: toUsdtBuckets, plan: noRoutePlan() }), view({ buckets: toUsdtBuckets, plan: toUsdtPlan() }));

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
const pickToUsdt = () => userEvent.click(screen.getByRole('radio', { name: 'Hyperliquid USDC → USDT' }));

/** The report's box, scaled to this account: $20k margin, $250k a leg, short
 * on Hyperliquid, 0.5% maintenance a leg. Liquidates at +64%; a $900 move to USDC
 * moves that to +64% still (900 of cover on a $250k leg is 0.4%). */
const liquidationAccount = () => ({
  ...account,
  marginBalance: '20000',
  maintenanceMargin: '2500',
  assets: [
    { coin: 'USDT', exchangeType: 'CROSSEX', balance: '20000', equity: '20000', availableBalance: '20000', upnl: '0', liability: '0' },
    { coin: 'USDC', exchangeType: 'HYPERLIQUID', balance: '0', equity: '0', availableBalance: '0', upnl: '0', liability: '0' },
  ],
});
const liquidationPositions = () => ({
  positions: [
    { ...ethPosition, symbol: 'GATE_FUTURE_ETH_USDT', positionValue: '250000', markPrice: '2300', maintenanceMargin: '1250' },
    { ...ethPosition, symbol: 'HYPERLIQUID_FUTURE_ETH_USDC', positionValue: '250000', markPrice: '2300', maintenanceMargin: '1250' },
  ],
  exposure: [
    {
      base: 'ETH',
      legs: [
        { symbol: 'GATE_FUTURE_ETH_USDT', exchange: 'GATE', quote: 'USDT', side: 'LONG' as const, qty: 108.7, value: 250000 },
        { symbol: 'HYPERLIQUID_FUTURE_ETH_USDC', exchange: 'HYPERLIQUID', quote: 'USDC', side: 'SHORT' as const, qty: 108.7, value: 250000 },
      ],
      longValue: 250000,
      shortValue: 250000,
      netValue: 0,
      grossValue: 500000,
      neutral: true,
      singleLeg: false,
    },
  ],
});

describe('RebalanceSection', () => {
  // The section reads the account and the positions for the liquidation
  // line. The defaults carry no positions, so no line and the quote lines
  // below stay as they were.
  beforeEach(() => {
    server.use(
      http.get('/api/account', () => HttpResponse.json(env(account))),
      http.get('/api/positions', () => HttpResponse.json(env({ positions: [], exposure: [] }))),
    );
  });

  it('adds how far the liquidation line moves to the quote line', async () => {
    server.use(
      http.get('/api/account', () => HttpResponse.json(env(liquidationAccount()))),
      http.get('/api/positions', () => HttpResponse.json(env(liquidationPositions()))),
    );
    serve(borrowAccount());
    renderWithClient(<RebalanceSection holdMs={50} />);

    await section();
    // 20000 = 2500 f + 25000 (f − 1) → f = 1.636: $3,764 at a 2,300 mark, +64%.
    // With 899.55 USDC of cover: 20000 = 2500 f + 0.1 (250000 (f − 1) − 899.55)
    // → $3,771, +64% still, rounded. The price is what a trader watches.
    await waitFor(() => expect(fact('Liquidation')).toBe('ETH ~$3,764 (+64%) → ~$3,771 (+64%)'));
    expectFacts(LOOP_FACTS);
  });

  it('shows the Rebalance header, the borrow pill, the cost line, and the two tiles', async () => {
    serve(view());
    renderWithClient(<RebalanceSection holdMs={50} />);

    await section();
    expect(screen.getByRole('heading', { name: 'Rebalance' })).toBeInTheDocument();
    expect(screen.getByText('move cash between USDT and Hyperliquid USDC')).toBeInTheDocument();
    expect(screen.getByText('Borrowing 1,200.00 USDC')).toHaveClass('border-amber-500/30');
    expectFacts({
      'Lent by Gate': '1,200.00 USDC',
      Interest: '$0.31 / day',
      'Interest paid · all time': '$4.20',
    });
    // The margin Gate holds is priced per unit in the explanation line, and
    // the spare is stated as `free …` on the field that can spend it — none
    // of the three earns a standing fact of its own.
    expect(fact('Initial margin held')).toBeNull();
    expect(fact('Maintenance margin held')).toBeNull();
    expect(fact('Spare USDC on Hyperliquid')).toBeNull();
    expect(fact('Liquidation')).toBeNull();
  });

  it('says so with a retry when the first fetch fails, instead of hiding the section', async () => {
    server.use(
      http.get('/api/rebalance', () =>
        HttpResponse.json({ ok: false, error: { category: 'upstream', message: 'gate down', retryable: true } }, { status: 502 }),
      ),
    );
    renderWithClient(<RebalanceSection holdMs={50} />);

    await section();
    expect(screen.getByRole('alert').textContent).toContain('Could not load the rebalance view.');
    expect(screen.queryByText(HOLD)).toBeNull();

    serve(view());
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText('Borrowing 1,200.00 USDC')).toBeInTheDocument());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('floors the borrow pill to cents so it never shows more than the button', async () => {
    serve(view({ buckets: [usdc({ borrow: 1200.999 }), usdt] }));
    renderWithClient(<RebalanceSection holdMs={50} />);

    await section();
    expect(screen.getByText('Borrowing 1,200.99 USDC')).toBeInTheDocument();
  });

  it('says in words that no interest runs yet under the threshold, and keeps every fact at zero', async () => {
    serve(view({ buckets: [usdc({ borrow: 8.5, imHeldUsd: 1.7, mmHeldUsd: 0.85, interestPaidUsd: 0, interestPerDayUsd: 0 }), usdt] }));
    renderWithClient(<RebalanceSection holdMs={50} />);

    await section();
    expect(screen.getByText('Borrowing 8.50 USDC')).toBeInTheDocument();
    expectFacts({
      'Lent by Gate': '8.50 USDC',
      Interest: 'none under 10,000 USDC',
      'Interest paid · all time': '$0.00',
    });
  });

  it('shows the same three facts without a borrow, zeros included, so the row never changes shape', async () => {
    serve(
      view({
        buckets: [usdc({ cash: 5, upnl: 0, equity: 5, borrow: 0, imHeldUsd: 0, mmHeldUsd: 0, interestPaidUsd: 2.5, interestPerDayUsd: 0 }), usdt],
        plan: noRoutePlan(),
      }),
    );
    renderWithClient(<RebalanceSection holdMs={50} />);

    await section();
    expect(screen.queryByText(/^Borrowing /)).toBeNull();
    expectFacts({
      'Lent by Gate': '0.00',
      Interest: '$0.00 / day',
      'Interest paid · all time': '$2.50',
    });
  });

  it('adds the interest paid on both wallets', async () => {
    serve(view({ buckets: [usdc({ interestPaidUsd: 4.2 }), { ...usdt, interestPaidUsd: 0.8 }] }));
    renderWithClient(<RebalanceSection holdMs={50} />);

    await section();
    expectFacts({ 'Interest paid · all time': '$5.00' });
  });

  it('shows the explanation line for each direction', async () => {
    serve(borrowAccount());
    renderWithClient(<RebalanceSection holdMs={50} />);

    await section();
    expect(screen.getByText(PAY_USDC_TEXT)).toBeInTheDocument();

    await pickToUsdt();

    expect(await screen.findByText(HOME_TEXT)).toBeInTheDocument();
    expect(screen.queryByText(PAY_USDC_TEXT)).toBeNull();
  });

  it('opens the what-and-why card from the info mark next to the title', async () => {
    serve(borrowAccount());
    renderWithClient(<RebalanceSection holdMs={50} />);

    await section();
    expect(screen.queryByRole('tooltip')).toBeNull();

    await userEvent.hover(screen.getByText('About rebalance').parentElement!);

    const card = await screen.findByRole('tooltip');
    expect(card).toHaveTextContent('Gate lends the coin: USDC for the Hyperliquid legs, USDT for the rest');
    expect(card).toHaveTextContent('20% as initial margin and 10% as maintenance margin');
    expect(card).toHaveTextContent('USDT → Hyperliquid USDC pays a USDC borrow back');
    expect(card).toHaveTextContent('Hyperliquid USDC → USDT pays a USDT borrow back');

    await userEvent.unhover(screen.getByText('About rebalance').parentElement!);

    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  });

  it('defaults the direction to USDT when there is no borrow and there is spare USDC', async () => {
    const urls = serve(toUsdtAccount());
    renderWithClient(<RebalanceSection holdMs={50} />);

    await section();
    expect(urls[0].searchParams.has('direction')).toBe(false);
    expect(await screen.findByRole('radio', { name: 'Hyperliquid USDC → USDT', checked: true })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'USDT → Hyperliquid USDC' })).not.toBeChecked();
    await waitFor(() => expect(urls.at(-1)?.searchParams.get('direction')).toBe('toUsdt'));
    expect(await screen.findByRole('button', { name: TO_USDT_HOLD })).toBeInTheDocument();
  });

  it('re-reads the plan and resets the input when the direction toggles', async () => {
    const urls = serve(toUsdtAccount());
    renderWithClient(<RebalanceSection holdMs={50} />);

    await screen.findByRole('button', { name: TO_USDT_HOLD });
    expect(screen.getByRole('radiogroup', { name: 'Direction' })).toBeInTheDocument();
    const usdcInput = amountInput('Amount (USDC) · free 400.00');
    expect(usdcInput).toHaveValue('400.00');
    expect(screen.getByText(HOME_TEXT)).toBeInTheDocument();
    expectFacts(TO_USDT_FACTS);
    await userEvent.clear(usdcInput);
    await userEvent.type(usdcInput, '77');
    expect(usdcInput).toHaveValue('77');

    await userEvent.click(screen.getByRole('radio', { name: 'USDT → Hyperliquid USDC' }));

    await waitFor(() => expect(urls.at(-1)?.searchParams.has('direction')).toBe(false));
    expect(screen.getByRole('radio', { name: 'USDT → Hyperliquid USDC' })).toBeChecked();
    const input = await screen.findByRole('textbox', { name: 'Amount (USDT) · free 5,000.00' });
    await waitFor(() => expect(input).toHaveValue('0.00'));
    expect(screen.getByText(PAY_USDC_TEXT)).toBeInTheDocument();
    expect(fact('Sends')).toBeNull();
    expect(screen.getByText('Nothing to move. There is no USDC borrow on Hyperliquid.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Hold to/ })).toBeNull();

    await pickToUsdt();

    await waitFor(() => expect(urls.at(-1)?.searchParams.get('direction')).toBe('toUsdt'));
    expect(await screen.findByRole('textbox', { name: 'Amount (USDC) · free 400.00' })).toHaveValue('400.00');
    expect(screen.getByText(HOME_TEXT)).toBeInTheDocument();
    await waitFor(() => expectFacts(TO_USDT_FACTS));
    expect(screen.getByRole('button', { name: TO_USDT_HOLD })).toBeInTheDocument();
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

  it('shows the USDC amount label with the smaller of cash and equity', async () => {
    serve(view({ buckets: [usdc({ cash: 600, upnl: -150, equity: 450, borrow: 0 }), usdt], plan: noRoutePlan() }));
    renderWithClient(<RebalanceSection holdMs={50} />);

    await section();
    expect(await screen.findByRole('textbox', { name: 'Amount (USDC) · free 450.00' })).toHaveValue('0.00');
  });

  it('shows the quote line for the spot loop', async () => {
    serve(view());
    renderWithClient(<RebalanceSection holdMs={50} />);

    await section();
    expectFacts(LOOP_FACTS);
    expect(fact('Liquidation')).toBeNull();
    expect(screen.queryByText(CONVERT_NOTE)).toBeNull();
  });

  it('shows the quote line for convert', async () => {
    serve(view({ plan: plan({ route: 'convert', price: 0.998, receives: 898.2 }) }));
    renderWithClient(<RebalanceSection holdMs={50} />);

    await section();
    expectFacts({
      Route: 'Convert · instant',
      Sends: '900.00 USDT → 898.20 USDC @ 0.9980',
      Cost: '$1.80 spread',
      'Borrow after': '$300.45',
      Frees: '$450.00 margin',
      Saves: '$0.29 / day',
    });
    expect(screen.getByText(CONVERT_NOTE)).toBeInTheDocument();
  });

  it('shows the quote line for a move to USDT', async () => {
    serve(toUsdtAccount());
    renderWithClient(<RebalanceSection holdMs={50} />);

    await section();
    await waitFor(() => expectFacts(TO_USDT_FACTS));
    expect(fact('Borrow after')).toBeNull();
  });

  it('shows the quote line for a move to USDT by convert and posts route convert', async () => {
    const convertToUsdt = toUsdtPlan({
      route: 'convert',
      price: 0.998,
      receives: 399.2,
      routes: { loop: route({ costUsd: 1.4, waitSeconds: 400 }), convert: route({ costUsd: 0.8, waitSeconds: 0 }) },
    });
    serve(byDirection(view({ buckets: toUsdtBuckets, plan: noRoutePlan() }), view({ buckets: toUsdtBuckets, plan: convertToUsdt })));
    const posts = recordStarts();
    renderWithClient(<RebalanceSection holdMs={50} />);

    await section();
    await waitFor(() =>
      expectFacts({ Route: 'Convert · instant', Sends: '400.00 USDC → 399.20 USDT @ 0.9980', Cost: '$0.80 spread' }),
    );
    expect(fact('Borrow after')).toBeNull();
    expect(screen.getByText(CONVERT_NOTE)).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole('button', { name: TO_USDT_HOLD }));

    await waitFor(() => expect(posts).toEqual([{ direction: 'toUsdt', amount: 400, route: 'convert' }]));
  });

  it('hides the hold and the quote line under 1 USDC and says why, for either direction', async () => {
    const tiny = usdc({ cash: -0.37, upnl: 0, equity: -0.37, borrow: 0.37, imHeldUsd: 0.07, mmHeldUsd: 0.03 });
    serve(view({ buckets: [tiny, usdt], plan: plan({ amount: 0.37, route: 'convert', receives: 0.36, price: 0.998 }) }));
    const { unmount } = renderWithClient(<RebalanceSection holdMs={50} />);

    await section();
    expect(screen.queryByText(/^Borrowing /)).toBeNull();
    expect(screen.getByText('Nothing to move. The USDC borrow is under 1 USDC.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Hold to/ })).toBeNull();
    expect(screen.queryByText(/^via /)).toBeNull();
    expect(screen.getByRole('radiogroup', { name: 'Direction' })).toBeInTheDocument();
    unmount();

    const spare = usdc({ cash: 0.5, upnl: 0, equity: 0.5, borrow: 0, imHeldUsd: 0, mmHeldUsd: 0 });
    serve(view({ buckets: [spare, usdt], plan: toUsdtPlan({ amount: 0.5, route: 'convert', receives: 0.49, price: 0.998 }) }));
    renderWithClient(<RebalanceSection holdMs={50} />);

    await section();
    expect(await screen.findByText('Nothing to move. Spare USDC is under 1 USDC.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Hold to/ })).toBeNull();
    expect(screen.queryByText(/^via /)).toBeNull();
  });

  it('asks for at least 1 USDT when the typed amount is under the floor and hides the hold', async () => {
    serve((url) => {
      const typed = url.searchParams.get('amount');
      return view({ plan: plan(typed ? { amount: Number(typed), route: 'convert', receives: Number(typed) * 0.998 } : {}) });
    });
    renderWithClient(<RebalanceSection holdMs={50} />);

    await screen.findByRole('button', { name: HOLD });
    const input = amountInput('Amount (USDT) · free 5,000.00');
    await userEvent.clear(input);
    await userEvent.type(input, '0.5');

    expect(await screen.findByRole('alert')).toHaveTextContent('Enter at least 1 USDT');
    expect(screen.queryByRole('button', { name: /^Hold to/ })).toBeNull();
    expect(screen.queryByText(/^via /)).toBeNull();
    expect(screen.queryByText(/^Capped at/)).toBeNull();
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
    expect(screen.getByText('USDC transfer is disabled')).toBeInTheDocument();
    expect(screen.queryByText(/convert quote failed/)).toBeNull();
    expect(screen.queryByText(/^via /)).toBeNull();
    expect(screen.queryByRole('button', { name: /^Hold to/ })).toBeNull();
    expect(amountInput('Amount (USDT) · free 5,000.00')).toHaveValue('900.00');
  });

  it('shows one plain line for a move to USDT with no route and never the convert reason', async () => {
    serve(
      view({
        buckets: [usdc({ cash: 1.29, upnl: 0, equity: 1.29, borrow: 0, imHeldUsd: 0, mmHeldUsd: 0 }), usdt],
        plan: toUsdtPlan({
          amount: 1.29,
          receives: 0,
          price: null,
          route: null,
          routes: {
            loop: route({ available: false, reason: 'Too small to move. Gate takes a flat $1 fee on the way out and needs at least 11 USDC to arrive. Move at least 12 USDC.' }),
            convert: route({ costUsd: 0, waitSeconds: 0, available: false, reason: 'Convert runs only from USDT to USDC.' }),
          },
        }),
      }),
    );
    renderWithClient(<RebalanceSection holdMs={50} />);

    await section();
    expect(await screen.findByText('Too small to move. Gate takes a flat $1 fee on the way out and needs at least 11 USDC to arrive. Move at least 12 USDC.')).toBeInTheDocument();
    expect(screen.queryByText(/Convert runs only/)).toBeNull();
    expect(screen.queryByText(/^Loop:/)).toBeNull();
    expect(screen.queryByRole('button', { name: /^Hold to/ })).toBeNull();
  });

  it('sends one POST /api/rebalance with the plan amount and route after a full hold', async () => {
    serve(view());
    const posts = recordStarts();
    renderWithClient(<RebalanceSection holdMs={50} />);

    const btn = await screen.findByRole('button', { name: HOLD });
    fireEvent.pointerDown(btn);

    await waitFor(() => expect(posts).toEqual([{ direction: 'toUsdc', amount: 900, route: 'loop' }]));
    await new Promise((r) => setTimeout(r, 200));
    expect(posts).toHaveLength(1);
  });

  it('posts direction toUsdt after a full hold toward USDT', async () => {
    serve(toUsdtAccount());
    const posts = recordStarts();
    renderWithClient(<RebalanceSection holdMs={50} />);

    fireEvent.pointerDown(await screen.findByRole('button', { name: TO_USDT_HOLD }));

    await waitFor(() => expect(posts).toEqual([{ direction: 'toUsdt', amount: 400, route: 'loop' }]));
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

  it('renders nothing with borrow 0, nothing to move, and no job', async () => {
    const urls = serve(view({ buckets: [usdc({ cash: 0, upnl: 0, equity: 0, borrow: 0 }), usdt], plan: noRoutePlan() }));
    renderWithClient(<RebalanceSection holdMs={50} />);

    await waitFor(() => expect(urls).toHaveLength(1));
    expect(screen.queryByRole('region', { name: 'Rebalance' })).toBeNull();
  });

  it('stays rendered when the borrow and the spareUsdc amount both floor to 0 but the bucket is in use', async () => {
    const onTheLine = usdc({ cash: 16.65, upnl: -16.646, equity: 0.004, borrow: 0, imHeldUsd: 0, mmHeldUsd: 0 });
    serve(view({ buckets: [onTheLine, usdt], plan: noRoutePlan() }));
    renderWithClient(<RebalanceSection holdMs={50} />);

    await section();
    expect(screen.queryByText(/^Borrowing /)).toBeNull();
    expect(screen.getByRole('radiogroup', { name: 'Direction' })).toBeInTheDocument();
    expect(screen.getByText('Nothing to move. There is no USDC borrow on Hyperliquid.')).toBeInTheDocument();
  });

  it('renders with borrow 0 and spare USDC, without the pill', async () => {
    serve(toUsdtAccount());
    renderWithClient(<RebalanceSection holdMs={50} />);

    await section();
    expect(screen.queryByText(/^Borrowing /)).toBeNull();
    expect(screen.getByRole('radiogroup', { name: 'Direction' })).toBeInTheDocument();
    expectFacts({ 'Lent by Gate': '0.00' });
    // The spare is not a fact any more — it is the ceiling on the field that spends it.
    expect(screen.getByRole('textbox', { name: 'Amount (USDC) · free 400.00' })).toBeInTheDocument();
  });

  it('renders with borrow 0 and nothing to move while a job runs', async () => {
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
    // No form CONTROLS while a job runs. The "About rebalance" info trigger
    // is a keyboard-reachable button too (aria-expanded), and stays.
    expect(screen.queryAllByRole('button').filter((b) => !b.hasAttribute('aria-expanded'))).toHaveLength(0);

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
    expect(screen.getByText('Borrowing 300.00 USDC')).toBeInTheDocument();
    expect(fact('Interest')).toBe('$0.08 / day');
  }, 10_000);

  it('goes back to the default direction with a fresh input once a job ends', async () => {
    serve(view({ job: job() }));
    renderWithClient(<RebalanceSection holdMs={50} />);

    await section();
    expect(screen.getAllByRole('progressbar')).toHaveLength(3);

    const done = job({ status: 'done' });
    serve(
      byDirection(
        view({ buckets: toUsdtBuckets, plan: noRoutePlan(), job: done }),
        view({ buckets: toUsdtBuckets, plan: toUsdtPlan(), job: done }),
      ),
    );

    expect(
      await screen.findByRole('radio', { name: 'Hyperliquid USDC → USDT', checked: true }, { timeout: 5_000 }),
    ).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: TO_USDT_HOLD })).toBeEnabled();
    expect(amountInput('Amount (USDC) · free 400.00')).toHaveValue('400.00');
    expect(screen.queryByText(/^Borrowing /)).toBeNull();
  }, 10_000);
});

describe('RebalanceSection — a USDT borrow', () => {
  // The legs on the other venues lost more than the USDT wallet held: Gate
  // lent 300 USDT. Hyperliquid holds 500 USDC of spare to repay it with.
  const spareUsdc = usdc({ cash: 500, upnl: 0, equity: 500, borrow: 0, imHeldUsd: 0, mmHeldUsd: 0, interestPaidUsd: 0, interestPerDayUsd: 0 });
  const usdtBorrowed: RebalanceBucket = {
    ...usdt,
    cash: 100,
    upnl: -400,
    equity: -300,
    borrow: 300,
    imHeldUsd: 60,
    mmHeldUsd: 30,
    interestPaidUsd: 1.25,
    interestPerDayUsd: 0,
  };
  const repayPlan = (over: Partial<RebalancePlan> = {}) =>
    toUsdtPlan({ amount: 300, receives: 298.7, borrowAfterUsd: 1.3, marginFreedUsd: 59.74, savesPerDayUsd: 0, ...over });
  const usdtBorrowAccount = (toUsdt: RebalancePlan = repayPlan()) =>
    byDirection(
      view({ buckets: [spareUsdc, usdtBorrowed], plan: noRoutePlan() }),
      view({ buckets: [spareUsdc, usdtBorrowed], plan: toUsdt }),
    );

  beforeEach(() => {
    server.use(
      http.get('/api/account', () => HttpResponse.json(env(account))),
      http.get('/api/positions', () => HttpResponse.json(env({ positions: [], exposure: [] }))),
    );
  });

  it('defaults to the toUsdt, reads it as a repayment, and shows the USDT borrow in the pill and the facts', async () => {
    serve(usdtBorrowAccount());
    renderWithClient(<RebalanceSection holdMs={50} />);

    expect(await screen.findByRole('button', { name: 'Hold to move 300.00 USDC → USDT' })).toBeInTheDocument();
    expect(screen.getByText('Borrowing 300.00 USDT')).toHaveClass('border-amber-500/30');
    expect(screen.getByText(PAY_USDT_TEXT)).toBeInTheDocument();
    expectFacts({
      'Lent by Gate': '300.00 USDT',
      Interest: 'none under 10,000 USDT',
      'Interest paid · all time': '$1.25',
    });
  });

  it('quotes the move to USDT with the borrow after, the margin it frees, and the interest it saves', async () => {
    serve(usdtBorrowAccount());
    renderWithClient(<RebalanceSection holdMs={50} />);

    await screen.findByRole('button', { name: 'Hold to move 300.00 USDC → USDT' });
    expectFacts({
      Route: 'Spot loop · about 6.7 min',
      Sends: '300.00 USDC → 298.70 USDT @ 0.9988',
      'Borrow after': '$1.30',
      Frees: '$59.74 margin',
      Saves: '$0.00 / day',
    });
  });

  it('says what stays borrowed when the spare does not cover the USDT borrow', async () => {
    serve(usdtBorrowAccount(repayPlan({ amount: 100, receives: 98.9, shortfall: { reason: 'spare', remaining: 200 } })));
    renderWithClient(<RebalanceSection holdMs={50} />);

    await screen.findByRole('button', { name: 'Hold to move 100.00 USDC → USDT' });
    expect(
      screen.getByText('Only 100.00 USDC can move. 200.00 USDT stays borrowed: there is no more spare USDC on Hyperliquid'),
    ).toHaveClass('text-amber-300');
  });

  it('shows the section for a USDT borrow even when the USDC wallet is empty', async () => {
    const empty = usdc({ cash: 0, upnl: 0, equity: 0, borrow: 0, imHeldUsd: 0, mmHeldUsd: 0, interestPaidUsd: 0, interestPerDayUsd: 0 });
    serve(view({ buckets: [empty, usdtBorrowed], plan: noRoutePlan({ direction: 'toUsdt' }) }));
    renderWithClient(<RebalanceSection holdMs={50} />);

    await section();
    expect(screen.getByText('Borrowing 300.00 USDT')).toBeInTheDocument();
    expect(screen.getByText('Nothing to move. There is no spare USDC on Hyperliquid.')).toBeInTheDocument();
  });

  it('keeps the USDC direction a plain repayment when the USDT borrow is the only one', async () => {
    serve(usdtBorrowAccount());
    renderWithClient(<RebalanceSection holdMs={50} />);

    await screen.findByRole('button', { name: 'Hold to move 300.00 USDC → USDT' });
    fireEvent.click(screen.getByRole('radio', { name: 'USDT → Hyperliquid USDC' }));
    expect(await screen.findByText('Nothing to move. There is no USDC borrow on Hyperliquid.')).toBeInTheDocument();
    expect(screen.getByText(PAY_USDC_TEXT)).toBeInTheDocument();
  });
});
