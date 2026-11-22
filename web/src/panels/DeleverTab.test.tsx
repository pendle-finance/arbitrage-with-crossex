import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeleverPlan, DeleverRequest } from '../api/types';
import { fmtAbout, fmtUsd, sigGrouped } from '../lib/fmt';
import { deleverPlans, openPairs } from '../test/fixtures';
import { env, server } from '../test/server';
import { renderWithClient } from '../test/utils';
import type { OpenPair } from './assets/pairs';
import { DeleverTab } from './DeleverTab';

const openState = vi.hoisted(() => ({ pairs: [] as OpenPair[], loading: false }));

vi.mock('./assets/pairs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./assets/pairs')>()),
  useOpenPairs: () => openState,
}));

const BTC = openPairs.btc900[0]!;
const ETH: OpenPair = {
  ...BTC,
  key: 'ETH:HYPERLIQUID:GATE:1794816000:spread',
  base: 'ETH',
  size: 6200,
  imUsd: 1_100_000,
  perps: BTC.perps.map((p) => ({ ...p, symbol: p.symbol.replace('BTC', 'ETH'), qty: 6200 })),
  boros: [{ marketId: 201, size: 6200 }],
};
const BTC_LIGHTER: OpenPair = { ...BTC, key: 'BTC:GATE:LIGHTER:1797379200:spread', longVenue: 'GATE', shortVenue: 'LIGHTER', size: 250, imUsd: 1_700_000 };

function servePlan(plan: DeleverPlan | { error: string }) {
  const sent: DeleverRequest[] = [];
  server.use(
    http.post('/api/rebalance/delever/plan', async ({ request }) => {
      sent.push((await request.json()) as DeleverRequest);
      if ('error' in plan) return HttpResponse.json({ ok: false, error: { category: 'unknown', message: plan.error } }, { status: 400 });
      return HttpResponse.json(env(plan));
    }),
  );
  return sent;
}

function show(pairs: OpenPair[], pairKey: string | null = null, onStarted = () => {}) {
  openState.pairs = pairs;
  return renderWithClient(<DeleverTab pairKey={pairKey} holdMs={50} lock={null} onStarted={onStarted} />);
}

const trigger = () => screen.getByRole('button', { name: 'Pair' });
async function afterRows(): Promise<string[]> {
  const table = (await screen.findByText('Before')).closest<HTMLElement>('[role="table"]')!;
  return within(table)
    .getAllByRole('row')
    .flatMap((row) => {
      const [before, after] = within(row)
        .queryAllByRole('cell')
        .map((cell) => cell.textContent ?? '');
      if (after === undefined) return [];
      const head = within(row).getByRole('rowheader').textContent ?? '';
      return [before ? `${head} ${before} → ${after}` : `${head} ${after}`];
    });
}

const defaultOption = (plan: DeleverPlan) => plan.sliceOptions.find((o) => !o.custom && o.sizeUsd === plan.defaultSliceUsd)!;

beforeEach(() => {
  openState.loading = false;
});

describe('DeleverTab pair', () => {
  it('opens on the largest IM pair', () => {
    servePlan(deleverPlans.twentyPct);
    show([ETH, BTC_LIGHTER, BTC]);
    expect(trigger()).toHaveTextContent('BTC');
    expect(trigger()).toHaveTextContent('900 BTC');
    expect(trigger()).toHaveTextContent('Hyperliquid');
  });

  it('opens on the pair it is given', () => {
    servePlan(deleverPlans.twentyPct);
    show([BTC, ETH], ETH.key);
    expect(trigger()).toHaveTextContent('6,200 ETH');
  });

  it('picker filters by coin or venue, in Fixed Rate Pairs order', async () => {
    const user = userEvent.setup();
    servePlan(deleverPlans.twentyPct);
    show([BTC, BTC_LIGHTER, ETH]);
    await user.click(trigger());
    const list = screen.getByRole('listbox');
    expect(within(list).getAllByRole('option')).toHaveLength(3);
    for (const head of ['Pair', 'Size', 'Initial margin']) expect(screen.getAllByText(head).length).toBeGreaterThan(0);
    await user.type(screen.getByRole('combobox', { name: 'Search coin or venue' }), 'eth');
    expect(within(list).getAllByRole('option')).toHaveLength(1);
    expect(within(list).getByRole('option')).toHaveTextContent('6,200 ETH');
    await user.clear(screen.getByRole('combobox'));
    await user.type(screen.getByRole('combobox'), 'lighter');
    expect(within(list).getAllByRole('option')).toHaveLength(1);
    expect(within(list).getByRole('option')).toHaveTextContent('250 BTC');
  });

  it('picker says no pairs match when a search finds none', async () => {
    const user = userEvent.setup();
    servePlan(deleverPlans.twentyPct);
    show([BTC, BTC_LIGHTER, ETH]);
    await user.click(trigger());
    await user.type(screen.getByRole('combobox', { name: 'Search coin or venue' }), 'doge');
    const list = screen.getByRole('listbox');
    expect(within(list).queryAllByRole('option')).toHaveLength(0);
    expect(within(list).getByText('No pairs match')).toBeInTheDocument();
    await user.clear(screen.getByRole('combobox'));
    expect(within(list).getAllByRole('option')).toHaveLength(3);
    expect(within(list).queryByText('No pairs match')).not.toBeInTheDocument();
  });

  it('no open pairs', () => {
    show(openPairs.none);
    expect(screen.getByText('No open pairs')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
  });

  it('no open pairs when only a dollar-sized pair is open', () => {
    show(openPairs.dollarPair);
    expect(screen.getByText('No open pairs')).toBeInTheDocument();
  });
});

describe('DeleverTab size', () => {
  it('reduce by options', () => {
    servePlan(deleverPlans.twentyPct);
    show(openPairs.btc900);
    const group = screen.getByRole('radiogroup', { name: 'Reduce by' });
    expect(within(group).getAllByRole('radio').map((r) => r.textContent)).toEqual(['10%', '20%', '30%', 'Custom']);
    expect(within(group).getByRole('radio', { name: '20%' })).toHaveAttribute('aria-checked', 'true');
  });

  it('custom coin size shows percent', async () => {
    const user = userEvent.setup();
    const sent = servePlan(deleverPlans.twentyPct);
    show(openPairs.btc900);
    await user.click(screen.getByRole('radio', { name: 'Custom' }));
    const field = screen.getByRole('textbox', { name: 'Custom' });
    await user.type(field, '90');
    expect(within(field.closest('.flex.items-center') as HTMLElement).getByText('10%')).toBeInTheDocument();
    await waitFor(() => expect(sent.at(-1)?.perps.map((p) => p.qty)).toEqual([90, 90]));
    expect(sent.at(-1)?.boros).toEqual([{ marketId: 101, size: 90 }]);
  });

  it('asks the plan for the same coin size on both perps and the same share of Boros', async () => {
    const sent = servePlan(deleverPlans.twentyPct);
    show(openPairs.btc900);
    await waitFor(() => expect(sent.length).toBeGreaterThan(0));
    expect(sent[0]).toEqual({
      perps: BTC.perps.map((p) => ({ symbol: p.symbol, qty: 180 })),
      boros: [{ marketId: 101, size: 180 }],
      exec: 'maker',
    });
  });
});

describe('DeleverTab plan', () => {
  it('below venue minimum', async () => {
    servePlan(deleverPlans.belowMin);
    show(openPairs.btc900);
    expect(await screen.findByText('Gate takes at least 0.001 BTC')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Hold to delever/ })).not.toBeInTheDocument();
  });

  it('after legs', async () => {
    servePlan(deleverPlans.twoBoros);
    show(openPairs.btc900);
    expect(await afterRows()).toEqual(
      expect.arrayContaining(['Hyperliquid Long · Gate Short 900 → 720 BTC each', 'Boros 500 → 400 YU', 'Boros 400 → 320 YU']),
    );
  });

  it('im used per account', async () => {
    servePlan(deleverPlans.twoAccounts);
    show(openPairs.btc900);
    expect(await afterRows()).toEqual(expect.arrayContaining(['IM used · CrossEx 91.2% → 74.2%', 'IM used · Hyperliquid 55.0% → 46.0%']));
  });

  it('boros gap line', async () => {
    const plan = deleverPlans.twentyPct;
    servePlan(plan);
    show(openPairs.btc900);
    const time = fmtAbout(defaultOption(plan).seconds.maker);
    expect(
      await screen.findByText(`Boros closes after the perps. Until then, up to 180 YU has no perp behind it (${time}).`),
    ).toBeInTheDocument();
  });

  it('delever not hedged line', async () => {
    const plan = deleverPlans.twentyPct;
    servePlan(plan);
    show(openPairs.btc900);
    const text = `Not hedged during each slice: max ${sigGrouped(plan.notHedgedMaxQty)} BTC (${fmtUsd(plan.notHedgedMaxUsd, 0)})`;
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it('delever cost rows', async () => {
    const plan = deleverPlans.twentyPct;
    servePlan(plan);
    show(openPairs.btc900);
    const card = (await screen.findByText('Trading fee · perps')).closest('.card') as HTMLElement;
    const labels = ['Trading fee · perps', 'Trading fee · Boros', 'Price impact', 'Total cost'];
    expect(within(card).getAllByText((_, el) => el?.tagName === 'SPAN' && labels.includes(el.textContent ?? '')).map((el) => el.textContent)).toEqual(labels);
    expect(card).toHaveTextContent(fmtUsd(plan.estimates.maker.totalUsd));
  });

  it('slice row and orders toggle', async () => {
    const user = userEvent.setup();
    const plan = deleverPlans.twentyPct;
    servePlan(plan);
    show(openPairs.btc900);
    const orders = await screen.findByRole('radiogroup', { name: 'Orders' });
    const [limit, market] = within(orders).getAllByRole('radio');
    const option = defaultOption(plan);
    expect(limit).toHaveTextContent(`Limit + hedge ${fmtUsd(plan.estimates.maker.totalUsd, 0)} · ${fmtAbout(option.seconds.maker)}`);
    expect(limit).toHaveAttribute('aria-checked', 'true');
    expect(market).toHaveTextContent(`Market ${fmtUsd(plan.estimates.market.totalUsd, 0)} · ${fmtAbout(option.seconds.market)}`);
    expect(screen.getByText(new RegExp(`^Slice size \\$[\\d.]+k · ${option.count} slices?$`))).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Change' }));
    const slices = screen.getByRole('radiogroup', { name: 'Slice size' });
    expect(within(slices).getAllByRole('radio').length).toBe(plan.sliceOptions.filter((o) => !o.custom).length + 1);
  });

  it('delever hold label', async () => {
    const started = vi.fn();
    const starts: unknown[] = [];
    server.use(
      http.post('/api/rebalance', async ({ request }) => {
        starts.push(await request.json());
        return HttpResponse.json(env({ id: 'delv0001' }));
      }),
    );
    const plan = deleverPlans.twentyPct;
    servePlan(plan);
    show(openPairs.btc900, null, started);
    const hold = await screen.findByRole('button', { name: 'Hold to delever BTC Hyperliquid / Gate by 20% (180 BTC)' });
    await waitFor(() => expect(hold).toBeEnabled());
    fireEvent.pointerDown(hold);
    await waitFor(() => expect(started).toHaveBeenCalled());
    expect(starts[0]).toMatchObject({ kind: 'delever', exec: 'maker', costUsd: plan.estimates.maker.totalUsd, delever: { exec: 'maker' } });
  });

  it('a plan that fails shows the error, never a cost', async () => {
    servePlan({ error: 'No order book for GATE_FUTURE_BTC_USDT.' });
    show(openPairs.btc900);
    expect(await screen.findByText('No order book for GATE_FUTURE_BTC_USDT.')).toBeInTheDocument();
    expect(screen.queryByText('Total cost')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Hold to delever/ })).not.toBeInTheDocument();
  });
});
