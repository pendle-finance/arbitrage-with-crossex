import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render as rtlRender, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import type { RealizeLeg, RealizePlan, RealizeTwap, RebalanceView, TwapPlanView } from '../api/types';
import { ToastProvider } from '../components/Toast';
import { num } from '../lib/fmt';
import { accountBodies, accountHandler, realizeCustomPlan, rebalanceViews, transferHandler, transferViews, whaleRebalanceViews } from '../test/fixtures';
import { env, server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { RealizeTab } from './RealizeTab';
import { twapQueryOf } from './realizeTabCost';
import { TrackedAddressProvider } from './trackedAddress';

type Body = { kind?: string; costUsd?: number; maker?: unknown; twap?: Record<string, unknown> };

const planOf = (slices: number, sliceQty: string, lastQty: string): TwapPlanView => ({
  slices,
  sliceQty,
  lastQty,
  intervalSec: 300,
  durationSec: slices * 300,
  takerAfterSec: 240,
});

function twapOf(legs: RealizeLeg[], counts: number[], totalUsd: number): RealizeTwap {
  const slices = counts.reduce((sum, n) => sum + n, 0);
  return {
    plan: planOf(slices, String(legs[0]!.qty / counts[0]!), String(legs[0]!.qty / counts[0]!)),
    refusal: null,
    price: 3200,
    legs: legs.map((leg, i) => ({ symbol: leg.symbol, slices: counts[i]!, plan: planOf(counts[i]!, String(leg.qty / counts[i]!), String(leg.qty / counts[i]!)) })),
    estimates: { maker: { feeUsd: totalUsd * 0.8, impactUsd: totalUsd * 0.2, totalUsd }, market: { feeUsd: totalUsd, impactUsd: totalUsd * 0.5, totalUsd: totalUsd * 1.5 } },
  };
}

function render(view: RebalanceView, twap: (search: URLSearchParams) => RealizeTwap) {
  const asked: URLSearchParams[] = [];
  const sent: Body[] = [];
  server.use(
    transferHandler(transferViews.spotZero),
    accountHandler(accountBodies.accountA),
    http.get('/api/positions', () => HttpResponse.json(env({ positions: [], exposure: [] }))),
    http.get('/api/rebalance', ({ request }) => {
      const search = new URL(request.url).searchParams;
      asked.push(search);
      const realizeTwap = search.has('twapSlices') ? { clearDebt: twap(search), all: twap(search), custom: null } : null;
      return HttpResponse.json(env({ ...view, realizeTwap }));
    }),
    http.post('/api/rebalance', async ({ request }) => {
      sent.push((await request.json()) as Body);
      return HttpResponse.json(env({ id: 'real0001' }));
    }),
  );
  renderWithClient(<RealizeTab view={view} holdMs={50} lock={null} onTab={vi.fn()} onStarted={vi.fn()} />);
  return { asked, sent };
}

const withLegs = (view: RebalanceView, legs: RealizeLeg[]): RebalanceView => ({
  ...view,
  realize: { ...view.realize!, clearDebt: { ...view.realize!.clearDebt!, legs }, all: { ...view.realize!.all!, legs } },
});

describe('RealizeTab TWAP', () => {
  it('the toggle sends duration and slices to the plan, and twap with its cost to the start', async () => {
    const owner = rebalanceViews.ownerAccount;
    const lead = owner.realize!.clearDebt!.legs[0]!;
    const { asked, sent } = render(owner, () => twapOf([lead], [12], 41.5));
    await userEvent.click(screen.getByRole('switch', { name: 'TWAP' }));
    await waitFor(() => expect(asked.some((q) => q.get('twapDurationSec') === '3600' && q.get('twapSlices') === '12')).toBe(true));
    const hold = await screen.findByRole('button', { name: 'Hold to realize · TWAP 1h' });
    await waitFor(() => expect(hold).toBeEnabled());
    expect(screen.getByText('Slices 12')).toBeInTheDocument();
    fireEvent.pointerDown(hold);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.kind).toBe('realize');
    expect(sent[0]!.maker).toBeUndefined();
    expect(sent[0]!.costUsd).toBeCloseTo(41.5, 6);
    expect(sent[0]!.twap).toMatchObject({ durationSec: 3600, slices: 12 });
    expect(sent[0]!.twap).toHaveProperty('takerAfterSec');
  });

  it('Market sends twap at the Market span, with no maker settings and the market estimate', async () => {
    const owner = rebalanceViews.ownerAccount;
    const lead = owner.realize!.clearDebt!.legs[0]!;
    const { sent } = render(owner, () => twapOf([lead], [12], 41.5));
    await userEvent.click(screen.getByRole('switch', { name: 'TWAP' }));
    await userEvent.click(within(screen.getByRole('radiogroup', { name: 'Orders' })).getAllByRole('radio')[1]!);
    expect(screen.getByRole('textbox', { name: 'Duration' })).toHaveValue('12m');
    const hold = await screen.findByRole('button', { name: 'Hold to realize · TWAP 1h' });
    await waitFor(() => expect(hold).toBeEnabled());
    fireEvent.pointerDown(hold);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.costUsd).toBeCloseTo(62.25, 6);
    expect(sent[0]!.twap).toEqual({ durationSec: 720, slices: 12 });
  });

  describe('price impact line', () => {
    const impactRow = (): Element | null => document.querySelector('span.ml-auto.text-ink-400');
    const impactView = (pastBook: boolean): RebalanceView => {
      const owner = rebalanceViews.ownerAccount;
      const lead: RealizeLeg = { ...owner.realize!.clearDebt!.legs[0]!, closeImpactUsd: 15, reopenImpactUsd: 25 };
      const estimates = { maker: { feeUsd: 5, impactUsd: 25, totalUsd: 30 }, market: { feeUsd: 5, impactUsd: 40, totalUsd: 45 } };
      const view = withLegs(owner, [lead]);
      const whole = view.realize!.sliceOptions.find((o) => o.whole)!;
      const options = view.realize!.sliceOptions.map((o) => (o.whole ? { ...whole, impactUsd: 15, reopenImpactUsd: 25, pastBook } : o));
      return { ...view, realize: { ...view.realize!, sliceOptions: options, clearDebt: { ...view.realize!.clearDebt!, estimates }, all: { ...view.realize!.all!, estimates } } };
    };

    it('shows the one-order and the sliced figure for Limit + hedge and for Market', async () => {
      const view = impactView(false);
      render(view, () => twapOf(view.realize!.clearDebt!.legs, [12], 40));
      await userEvent.click(screen.getByRole('switch', { name: 'TWAP' }));
      await waitFor(() => expect(impactRow()).toHaveTextContent('$25'));
      expect(impactRow()).toHaveTextContent('$8');
      await userEvent.click(within(screen.getByRole('radiogroup', { name: 'Orders' })).getAllByRole('radio')[1]!);
      await waitFor(() => expect(impactRow()).toHaveTextContent('$40'));
      expect(impactRow()).toHaveTextContent('$20');
    });

    it('says the book is too thin when one order runs past it', async () => {
      const view = impactView(true);
      render(view, () => twapOf(view.realize!.clearDebt!.legs, [12], 40));
      await userEvent.click(screen.getByRole('switch', { name: 'TWAP' }));
      expect(await screen.findByText('Book too thin to price')).toBeInTheDocument();
    });
  });

  it('two legs show one slice count per leg', async () => {
    const owner = rebalanceViews.ownerAccount;
    const eth = owner.realize!.clearDebt!.legs[0]!;
    const btc: RealizeLeg = { ...eth, symbol: 'GATE_FUTURE_BTC_USDT', exchange: 'GATE', base: 'BTC', qty: 0.4, positionQty: 1.2 };
    render(withLegs(owner, [eth, btc]), () => twapOf([eth, btc], [8, 4], 50));
    await userEvent.click(screen.getByRole('switch', { name: 'TWAP' }));
    expect(await screen.findByText('BTC · Gate')).toBeInTheDocument();
    expect(screen.getByText(`ETH · ${eth.exchange === 'GATE' ? 'Gate' : 'Hyperliquid'}`)).toBeInTheDocument();
    expect(screen.getByText('Slices 8')).toBeInTheDocument();
    expect(screen.getByText('Slices 4')).toBeInTheDocument();
    expect(screen.getByText('Slices 12')).toBeInTheDocument();
  });

  it('shows the size of the TWAP plan, not the plan without TWAP', async () => {
    const owner = rebalanceViews.ownerAccount;
    const lead = owner.realize!.clearDebt!.legs[0]!;
    const twapLead: RealizeLeg = { ...lead, qty: 7.77, positionQty: Math.max(lead.positionQty, 7.77) };
    const twapped = withLegs(owner, [twapLead]);
    const asked: URLSearchParams[] = [];
    server.use(
      transferHandler(transferViews.spotZero),
      accountHandler(accountBodies.accountA),
      http.get('/api/positions', () => HttpResponse.json(env({ positions: [], exposure: [] }))),
      http.get('/api/rebalance', ({ request }) => {
        const search = new URL(request.url).searchParams;
        asked.push(search);
        if (!search.has('twapSlices')) return HttpResponse.json(env({ ...owner, realizeTwap: null }));
        const realizeTwap = { clearDebt: twapOf([twapLead], [12], 41.5), all: twapOf([twapLead], [12], 41.5), custom: null };
        return HttpResponse.json(env({ ...twapped, realizeTwap }));
      }),
    );
    renderWithClient(<RealizeTab view={owner} holdMs={50} lock={null} onTab={vi.fn()} onStarted={vi.fn()} />);
    expect(screen.queryByText(/7\.77 of/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('switch', { name: 'TWAP' }));
    await waitFor(() => expect(asked.some((q) => q.has('twapSlices'))).toBe(true));
    expect(await screen.findByText(/7\.77 of/)).toBeInTheDocument();
  });

  it('a refused TWAP plan blocks the hold', async () => {
    const owner = rebalanceViews.ownerAccount;
    const lead = owner.realize!.clearDebt!.legs[0]!;
    const refused = (): RealizeTwap => ({ ...twapOf([lead], [12], 41.5), plan: null, estimates: null, refusal: { field: 'interval', text: 'Interval at least 1m.', fix: null } });
    render(owner, refused);
    await userEvent.click(screen.getByRole('switch', { name: 'TWAP' }));
    expect(await screen.findByText('Interval at least 1m.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hold to realize' })).toBeDisabled();
  });

  it('a $6M realize sends the whale TWAP estimate', async () => {
    const whale = whaleRebalanceViews.realizeWhale;
    const lead = whale.realize!.clearDebt!.legs[0]!;
    const { sent } = render(whale, () => twapOf([lead], [12], 6_480.25));
    await userEvent.click(screen.getByRole('switch', { name: 'TWAP' }));
    const hold = await screen.findByRole('button', { name: 'Hold to realize · TWAP 1h' });
    await waitFor(() => expect(hold).toBeEnabled());
    fireEvent.pointerDown(hold);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.costUsd).toBeCloseTo(6_480.25, 6);
  });
});

function renderCustom(view: RebalanceView, customOf: (usd: number) => RealizePlan, gate: { wait: Promise<void> | null } = { wait: null }) {
  const sent: (Body & { realizeUsd?: number; realizeTarget?: string })[] = [];
  server.use(
    transferHandler(transferViews.spotZero),
    accountHandler(accountBodies.accountA),
    http.get('/api/positions', () => HttpResponse.json(env({ positions: [], exposure: [] }))),
    http.get('/api/rebalance', async ({ request }) => {
      const usd = Number(new URL(request.url).searchParams.get('realizeUsd') ?? 0);
      if (gate.wait) await gate.wait;
      return HttpResponse.json(env({ ...view, realize: { ...view.realize!, custom: usd > 0 ? customOf(usd) : null }, realizeTwap: null }));
    }),
    http.post('/api/rebalance', async ({ request }) => {
      sent.push((await request.json()) as Body & { realizeUsd?: number });
      return HttpResponse.json(env({ id: 'real0002' }));
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchInterval: false, refetchOnWindowFocus: false } } });
  rtlRender(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <TrackedAddressProvider>
          <RealizeTab view={view} holdMs={50} lock={null} onTab={vi.fn()} onStarted={vi.fn()} />
        </TrackedAddressProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { sent, client };
}

async function typeCustom(text: string) {
  const box = screen.getByRole('textbox', { name: 'Amount to realize' });
  await userEvent.clear(box);
  await userEvent.type(box, text);
}

describe('RealizeTab amounts', () => {
  it('a Custom realize sends the amount it was priced at, not the net after cost', async () => {
    const { sent } = renderCustom(rebalanceViews.ownerAccount, (usd) => realizeCustomPlan(usd + 200));
    await typeCustom('5000');
    const hold = await screen.findByRole('button', { name: 'Hold to realize' });
    await waitFor(() => expect(hold).toBeEnabled());
    fireEvent.pointerDown(hold);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ realizeTarget: 'custom', realizeUsd: 5000 });
  });

  it('a background read of the Custom plan keeps the hold on', async () => {
    const gate: { wait: Promise<void> | null } = { wait: null };
    const { client } = renderCustom(rebalanceViews.ownerAccount, (usd) => realizeCustomPlan(usd), gate);
    await typeCustom('5000');
    const hold = await screen.findByRole('button', { name: 'Hold to realize' });
    await waitFor(() => expect(hold).toBeEnabled());
    let release: () => void = () => {};
    gate.wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    void client.refetchQueries();
    await waitFor(() => expect(client.isFetching()).toBeGreaterThan(0));
    expect(screen.getByRole('button', { name: 'Hold to realize' })).toBeEnabled();
    release();
  });

  it('the After card counts the reopen Convert and the borrow it pays for the Debt amount', async () => {
    const owner = rebalanceViews.ownerAccount;
    render(owner, () => twapOf(owner.realize!.clearDebt!.legs, [12], 41.5));
    expect(screen.getByRole('radio', { name: /^Debt/ })).toHaveAttribute('aria-checked', 'true');
    const group = screen.getByRole('rowgroup', { name: 'USDT · CrossEx' });
    expect(within(group).getAllByRole('row').length).toBeGreaterThan(1);
  });
});

describe('RealizeTab Custom cap with TWAP', () => {
  const owner = rebalanceViews.ownerAccount;
  const all = owner.realize!.all!;
  const realized = all.legs.reduce((sum, leg) => sum + leg.realizedUsd, 0);
  const oneOrder = { feeUsd: 600, impactUsd: 0, totalUsd: 600 };
  const view: RebalanceView = { ...owner, realize: { ...owner.realize!, all: { ...all, estimates: { maker: oneOrder, market: oneOrder } } } };
  const twapNet = realized - 41.5;

  function renderTwap() {
    const asked: URLSearchParams[] = [];
    server.use(
      transferHandler(transferViews.spotZero),
      accountHandler(accountBodies.accountA),
      http.get('/api/positions', () => HttpResponse.json(env({ positions: [], exposure: [] }))),
      http.get('/api/rebalance', ({ request }) => {
        const search = new URL(request.url).searchParams;
        asked.push(search);
        const usd = Number(search.get('realizeUsd') ?? 0);
        const custom = usd > 0 ? realizeCustomPlan(usd) : null;
        const realizeTwap = search.has('twapSlices')
          ? { clearDebt: twapOf(all.legs, [12], 41.5), all: twapOf(all.legs, [12], 41.5), custom: custom ? twapOf(custom.legs, [12], 41.5) : null }
          : null;
        return HttpResponse.json(env({ ...view, realize: { ...view.realize!, custom }, realizeTwap }));
      }),
    );
    renderWithClient(<RealizeTab view={view} holdMs={50} lock={null} onTab={vi.fn()} onStarted={vi.fn()} />);
    return asked;
  }

  it('a Custom amount under the TWAP max is not cut to the one-order max', async () => {
    const asked = renderTwap();
    await userEvent.click(screen.getByRole('switch', { name: 'TWAP' }));
    expect(await screen.findByRole('radio', { name: `All (${num(twapNet, 0)} USDC)` })).toBeInTheDocument();
    const typed = Math.round(realized - 100);
    await typeCustom(String(typed));
    await waitFor(() => expect(asked.some((q) => Number(q.get('realizeUsd')) === typed && q.has('twapSlices'))).toBe(true), { timeout: 3000 });
    expect(screen.queryByText(/More than you can realize/)).toBeNull();
  });

  it('a Custom amount over the TWAP max asks for and names the TWAP max', async () => {
    const asked = renderTwap();
    await userEvent.click(screen.getByRole('switch', { name: 'TWAP' }));
    expect(await screen.findByRole('radio', { name: `All (${num(twapNet, 0)} USDC)` })).toBeInTheDocument();
    await typeCustom(String(Math.round(realized + 500)));
    await waitFor(() => expect(asked.some((q) => Math.abs(Number(q.get('realizeUsd')) - twapNet) < 1e-6)).toBe(true), { timeout: 3000 });
    expect(await screen.findByText(`More than you can realize. This realizes all ${num(twapNet, 0)} USDC.`)).toBeInTheDocument();
  });
});

describe('RealizeTab steps', () => {
  it('lists the Convert after the close and reopen it follows, as the job runs them', () => {
    const owner = rebalanceViews.ownerAccount;
    const lead = owner.realize!.clearDebt!.legs[0]!;
    expect(lead.convert?.feeUsd).toBeGreaterThan(0);
    render(owner, () => twapOf([lead], [12], 41.5));
    const close = screen.getByText(new RegExp(`^${lead.base} (Long|Short) .* of `));
    const convert = screen.getAllByText(/^Convert [\d,]+ /)[0]!;
    expect(close.compareDocumentPosition(convert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('twapQueryOf', () => {
  it('keeps duration and slices', () => {
    expect(twapQueryOf({ durationSec: 3_600, slices: 7 }, 1)).toEqual({ durationSec: 3_600, slices: 7 });
  });

  it('counts slices from duration and interval', () => {
    expect(twapQueryOf({ durationSec: 3_600, intervalSec: 700 }, 1)).toEqual({ durationSec: 3_600, slices: 5 });
  });

  it('counts slices from a slice size at $50 and at $6M', () => {
    expect(twapQueryOf({ durationSec: 3_600, sliceQty: '0.005' }, 0.0156)).toEqual({ durationSec: 3_600, slices: 4 });
    expect(twapQueryOf({ durationSec: 3_600, sliceQty: '0.1' }, 1.1)).toEqual({ durationSec: 3_600, slices: 11 });
    expect(twapQueryOf({ intervalSec: 300, sliceQty: '100' }, 1_875)).toEqual({ durationSec: 5_700, slices: 19 });
  });

  it('needs a lead size for a slice size', () => {
    expect(twapQueryOf({ durationSec: 3_600, sliceQty: '0.1' }, 0)).toBeNull();
  });
});
