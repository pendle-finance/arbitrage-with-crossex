import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import type { RealizeLeg, RealizeTwap, RebalanceView, TwapPlanView } from '../api/types';
import { accountBodies, accountHandler, rebalanceViews, transferHandler, transferViews, whaleRebalanceViews } from '../test/fixtures';
import { env, server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { RealizeTab } from './RealizeTab';
import { twapQueryOf } from './realizeTabCost';

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
    expect(screen.getByRole('switch', { name: 'Split the close' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('switch', { name: 'TWAP' }));
    await waitFor(() => expect(asked.some((q) => q.get('twapDurationSec') === '3600' && q.get('twapSlices') === '12')).toBe(true));
    expect(screen.queryByRole('switch', { name: 'Split the close' })).not.toBeInTheDocument();
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

  it('Market sends twap with no maker settings and the market estimate', async () => {
    const owner = rebalanceViews.ownerAccount;
    const lead = owner.realize!.clearDebt!.legs[0]!;
    const { sent } = render(owner, () => twapOf([lead], [12], 41.5));
    await userEvent.click(screen.getByRole('switch', { name: 'TWAP' }));
    await userEvent.click(within(screen.getByRole('radiogroup', { name: 'Orders' })).getAllByRole('radio')[1]!);
    const hold = await screen.findByRole('button', { name: 'Hold to realize · TWAP 1h' });
    await waitFor(() => expect(hold).toBeEnabled());
    fireEvent.pointerDown(hold);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.costUsd).toBeCloseTo(62.25, 6);
    expect(sent[0]!.twap).toEqual({ durationSec: 3600, slices: 12 });
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
