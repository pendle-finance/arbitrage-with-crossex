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

const openState = vi.hoisted(() => ({ pairs: [] as OpenPair[], loading: false, failed: false, retry: () => {} }));
const walletState = vi.hoisted(() => ({ state: 'can-trade' as string | null, canTrade: true, loginLabel: null as string | null }));

vi.mock('./assets/pairs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./assets/pairs')>()),
  useOpenPairs: () => openState,
}));

vi.mock('./trackedAddress', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./trackedAddress')>()),
  useActiveWallet: () => ({ address: '0xabc', viewOnly: false, endsSoon: null, openLogin: () => {}, ...walletState }),
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

function twapReply(close: number, input: NonNullable<DeleverRequest['twap']>): NonNullable<DeleverPlan['twap']> {
  const durationSec = input.durationSec ?? 0;
  const intervalSec = input.intervalSec ?? 0;
  const slices = Math.floor(durationSec / intervalSec);
  const sliceQty = String(close / slices);
  const plan = { slices, sliceQty, lastQty: sliceQty, intervalSec, durationSec, takerAfterSec: Math.floor(intervalSec * 0.8) };
  return { plan, refusal: null, price: 100_000 };
}

function servePlan(plan: DeleverPlan | { error: string }, twapOverride?: DeleverPlan['twap']) {
  const sent: DeleverRequest[] = [];
  server.use(
    http.post('/api/rebalance/delever/plan', async ({ request }) => {
      const body = (await request.json()) as DeleverRequest;
      sent.push(body);
      if ('error' in plan) return HttpResponse.json({ ok: false, error: { category: 'unknown', message: plan.error } }, { status: 400 });
      if (!body.twap) return HttpResponse.json(env({ ...plan, twap: null, priceImpact: null }));
      const lead = plan.legs[plan.makerLeg]!;
      const twap = twapOverride ?? twapReply(lead.closeQty, body.twap);
      return HttpResponse.json(env({ ...plan, twap, priceImpact: { whole: null, sliced: 1200 } }));
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
  openState.failed = false;
  Object.assign(walletState, { state: 'can-trade', canTrade: true, loginLabel: null });
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

  it('a failed pair read shows an error with retry, never no open pairs', async () => {
    const retry = vi.fn();
    openState.failed = true;
    openState.retry = retry;
    show(openPairs.none);
    expect(screen.queryByText('No open pairs')).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalled();
  });

  it('picker rows use the pair row maturity format', async () => {
    servePlan(deleverPlans.twentyPct);
    show(openPairs.btc900);
    expect(trigger()).toHaveTextContent(/Matures \d{4}-\d{2}-\d{2} · (\d+d left|matured)/);
  });

  it('escape closes the picker, not the dialog', async () => {
    const user = userEvent.setup();
    servePlan(deleverPlans.twentyPct);
    show(openPairs.btc900);
    const outer = vi.fn();
    window.addEventListener('keydown', outer);
    await user.click(trigger());
    expect(screen.getByRole('combobox', { name: 'Search coin or venue' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('combobox', { name: 'Search coin or venue' })).not.toBeInTheDocument();
    expect(outer).not.toHaveBeenCalled();
    window.removeEventListener('keydown', outer);
  });
});

describe('DeleverTab guards', () => {
  it.each(['0', 'abc', '-5'])('custom %s shows the invalid sentence and no hold', async (typed) => {
    const user = userEvent.setup();
    servePlan(deleverPlans.twentyPct);
    show(openPairs.btc900);
    await user.click(screen.getByRole('radio', { name: 'Custom' }));
    await user.type(screen.getByRole('textbox', { name: 'Custom' }), typed);
    expect(screen.getByText(/^(Not a number|Must be more than 0)$/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Hold to delever/ })).not.toBeInTheDocument();
  });

  it('custom above the pair size names the most and shows no hold', async () => {
    const user = userEvent.setup();
    servePlan(deleverPlans.twentyPct);
    show(openPairs.btc900);
    await user.click(screen.getByRole('radio', { name: 'Custom' }));
    await user.type(screen.getByRole('textbox', { name: 'Custom' }), '900.001');
    expect(screen.getByText('Maximum is 900')).toBeInTheDocument();
    expect(screen.queryByText(/^100(\.0+)?%$/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Hold to delever/ })).not.toBeInTheDocument();
  });

  it('an empty custom size says why and shows no hold, as 0 does', async () => {
    const user = userEvent.setup();
    servePlan(deleverPlans.twentyPct);
    show(openPairs.btc900);
    await user.click(screen.getByRole('radio', { name: 'Custom' }));
    expect(screen.getByRole('textbox', { name: 'Custom' })).toHaveValue('');
    expect(screen.getByText('Must be more than 0')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Hold to delever/ })).not.toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Custom' }), '0');
    expect(screen.getByText('Must be more than 0')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Hold to delever/ })).not.toBeInTheDocument();
  });

  it('the hold stays disabled until the plan for the picked size returns', async () => {
    const user = userEvent.setup();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.post('/api/rebalance/delever/plan', async ({ request }) => {
        const body = (await request.json()) as DeleverRequest;
        if (body.perps[0]?.qty === 270) await gate;
        return HttpResponse.json(env(deleverPlans.twentyPct));
      }),
    );
    show(openPairs.btc900);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Hold to delever 180 BTC' })).toBeEnabled());
    await user.click(screen.getByRole('radio', { name: '30%' }));
    const hold = screen.getByRole('button', { name: 'Hold to delever 270 BTC' });
    expect(hold).toBeDisabled();
    release();
    await waitFor(() => expect(hold).toBeEnabled());
  });

  it('a wallet that cannot trade cannot start a delever with a Boros leg', async () => {
    Object.assign(walletState, { state: 'not-approved', canTrade: false, loginLabel: null });
    servePlan(deleverPlans.twentyPct);
    show(openPairs.btc900);
    expect(await screen.findByText('This build cannot close Boros positions. Close them in the Boros app.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Hold to delever/ })).toBeDisabled();
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

  it('two perps on the same side refuse with no hold', async () => {
    servePlan(deleverPlans.sameSide);
    show(openPairs.btc900);
    expect(await screen.findByText('Both perps are on the same side. Delever needs one long and one short.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Hold to delever/ })).not.toBeInTheDocument();
  });

  it('after legs', async () => {
    servePlan(deleverPlans.twoBoros);
    show(openPairs.btc900);
    expect(await afterRows()).toEqual(
      expect.arrayContaining(['Hyperliquid Long · Gate Short 900 → 720 BTC each', 'Boros 500 → 400 YU', 'Boros 400 → 320 YU']),
    );
  });

  it('im used is one CrossEx row', async () => {
    servePlan(deleverPlans.twentyPct);
    show(openPairs.btc900);
    const rows = (await afterRows()).filter((row) => row.startsWith('IM used'));
    expect(rows).toEqual(['IM used · CrossEx 91.2% → 74.2%']);
  });

  it('boros gap line', async () => {
    const plan = deleverPlans.twentyPct;
    servePlan(plan);
    show(openPairs.btc900);
    const time = fmtAbout(defaultOption(plan).seconds.maker);
    expect(
      await screen.findByText(`Boros closes after the perps. Until then, the YU with no perp behind it grows to 180 by the end (${time}).`),
    ).toBeInTheDocument();
  });

  it('delever not hedged line', async () => {
    const plan = deleverPlans.twentyPct;
    servePlan(plan);
    show(openPairs.btc900);
    const text = `Not hedged during each slice: max ${sigGrouped(plan.notHedgedMaxQty)} BTC (${fmtUsd(plan.notHedgedMaxUsd, 0)})`;
    const line = await screen.findByText(text);
    expect(line.tagName).toBe('P');
    expect(line.closest('[role="alert"], .card')).toBeNull();
  });

  it('delever cost rows', async () => {
    const plan = deleverPlans.twentyPct;
    servePlan(plan);
    show(openPairs.btc900);
    const card = (await screen.findByText('Trading fee · perps')).closest('.card') as HTMLElement;
    const labels = ['Trading fee · perps', 'Trading fee · Boros', 'Price impact', 'Total cost'];
    const shown = within(card).getAllByText((_, el) => el?.tagName === 'SPAN' && labels.includes(el.textContent ?? '')).map((el) => el.textContent);
    expect([...new Set(shown)]).toEqual(labels);
    expect(within(card).getByRole('button', { name: /Price impact/ })).toBeInTheDocument();
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
    expect(limit).toHaveTextContent(`Limit + hedge ${fmtUsd(plan.estimates.maker.totalUsd, 0)} · ${fmtAbout(option.seconds.maker / option.count)} per slice`);
    expect(limit).toHaveAttribute('aria-checked', 'true');
    expect(market).toHaveTextContent(`Market ${fmtUsd(plan.estimates.market.totalUsd, 0)} · ${fmtAbout(option.seconds.market / option.count)} per slice`);
    expect(screen.getByText(new RegExp(`^Slice size \\$[\\d.]+k · ${option.count} slices?$`))).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Change' }));
    const slices = screen.getByRole('radiogroup', { name: 'Slice size' });
    expect(within(slices).getAllByRole('radio').length).toBe(plan.sliceOptions.filter((o) => !o.custom).length + 1);
  });

  it('a slice past the book refuses in place of the hold', async () => {
    const plan = deleverPlans.twentyPct;
    servePlan({ ...plan, sliceOptions: plan.sliceOptions.map((o) => (o.sizeUsd === plan.defaultSliceUsd ? { ...o, pastBook: true } : o)) });
    show(openPairs.btc900);
    expect(await screen.findByText('Order book too thin to price.')).toBeInTheDocument();
    expect(screen.getByText('Pick a smaller slice size.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Hold to delever/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change' })).toBeInTheDocument();
  });

  it('short hold label', async () => {
    const started = vi.fn();
    const starts: { delever: DeleverRequest }[] = [];
    server.use(
      http.post('/api/rebalance', async ({ request }) => {
        starts.push((await request.json()) as { delever: DeleverRequest });
        return HttpResponse.json(env({ id: 'delv0001' }));
      }),
    );
    const plan = deleverPlans.twentyPct;
    servePlan(plan);
    show(openPairs.btc900, null, started);
    const hold = await screen.findByRole('button', { name: 'Hold to delever 180 BTC' });
    await waitFor(() => expect(hold).toBeEnabled());
    fireEvent.pointerDown(hold);
    await waitFor(() => expect(started).toHaveBeenCalled());
    expect(starts[0]).toMatchObject({ kind: 'delever', exec: 'maker', costUsd: plan.estimates.maker.totalUsd, delever: { exec: 'maker' } });
    expect(starts[0]!.delever.twap).toBeUndefined();
  });

  it('a plan that fails shows the error, never a cost', async () => {
    servePlan({ error: 'No order book for GATE_FUTURE_BTC_USDT.' });
    show(openPairs.btc900);
    expect(await screen.findByText('No order book for GATE_FUTURE_BTC_USDT.')).toBeInTheDocument();
    expect(screen.queryByText('Total cost')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Hold to delever/ })).not.toBeInTheDocument();
  });
});

async function turnTwapOn(duration: string, interval: string) {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('switch', { name: 'TWAP' }));
  const durationBox = screen.getByRole('textbox', { name: 'Duration' });
  await user.clear(durationBox);
  await user.type(durationBox, duration);
  const intervalBox = screen.getByRole('textbox', { name: 'Interval' });
  await user.clear(intervalBox);
  await user.type(intervalBox, interval);
}

describe('DeleverTab TWAP', () => {
  it('twap off keeps slice size row', async () => {
    servePlan(deleverPlans.twentyPct);
    show(openPairs.btc900);
    expect(await screen.findByText(/^Slice size \$[\d.]+k · \d+ slices?$/)).toBeInTheDocument();
    expect(screen.queryByText('Boros close per slice')).not.toBeInTheDocument();
  });

  it('twap area with boros per slice', async () => {
    servePlan(deleverPlans.twentyPct);
    show(openPairs.btc900);
    await turnTwapOn('4h', '5m');
    expect(await screen.findByText(/^Slices 48/)).toBeInTheDocument();
    expect(screen.getByText('Boros close per slice')).toBeInTheDocument();
    expect(screen.getByText('3.75 YU')).toBeInTheDocument();
    expect(screen.queryByText(/^Slice size \$/)).not.toBeInTheDocument();
  });

  it('twap hold label', async () => {
    servePlan(deleverPlans.twentyPct);
    show(openPairs.btc900);
    await turnTwapOn('4h', '5m');
    expect(await screen.findByRole('button', { name: 'Hold to delever 180 BTC · TWAP 4h' })).toBeInTheDocument();
  });

  it('cost box kept with twap', async () => {
    servePlan(deleverPlans.twentyPct);
    show(openPairs.btc900);
    await turnTwapOn('4h', '5m');
    await screen.findByText(/^Slices 48/);
    expect(screen.getByText('Trading fee · perps')).toBeInTheDocument();
    expect(screen.getByText('Total cost')).toBeInTheDocument();
  });

  it('twap start body carries twap only with the switch on', async () => {
    const starts: { delever: DeleverRequest }[] = [];
    server.use(
      http.post('/api/rebalance', async ({ request }) => {
        starts.push((await request.json()) as { delever: DeleverRequest });
        return HttpResponse.json(env({ id: 'delv0002' }));
      }),
    );
    servePlan(deleverPlans.twentyPct);
    show(openPairs.btc900);
    await turnTwapOn('4h', '5m');
    const hold = await screen.findByRole('button', { name: 'Hold to delever 180 BTC · TWAP 4h' });
    await waitFor(() => expect(hold).toBeEnabled());
    fireEvent.pointerDown(hold);
    await waitFor(() => expect(starts).toHaveLength(1));
    expect(starts[0]!.delever.twap).toMatchObject({ durationSec: 14_400, slices: 48, repegBehindBp: 5 });
    expect(starts[0]!.delever.sliceUsd).toBeUndefined();
  });

  it('maker settings fold sends the taker wait and re-peg on the twap plan request', async () => {
    const sent = servePlan(deleverPlans.twentyPct);
    show(openPairs.btc900);
    await turnTwapOn('4h', '5m');
    await screen.findByText(/^Slices 48/);
    expect(screen.getByRole('button', { name: /Maker settings/ })).toBeInTheDocument();
    await waitFor(() => expect(sent[sent.length - 1]!.twap).toMatchObject({ repegBehindBp: 5 }));
    expect(sent[sent.length - 1]!.twap).toHaveProperty('takerAfterSec');
  });

  it('taker after Never sends a null taker wait, not the default', async () => {
    const sent = servePlan(deleverPlans.twentyPct);
    show(openPairs.btc900);
    await turnTwapOn('4h', '5m');
    await screen.findByText(/^Slices 48/);
    fireEvent.click(screen.getByRole('button', { name: /Maker settings/ }));
    fireEvent.click(await screen.findByRole('radio', { name: 'Never' }));
    await waitFor(() => expect(sent[sent.length - 1]!.twap).toMatchObject({ takerAfterSec: null }));
  });

  it('no maker settings fold with twap off', async () => {
    servePlan(deleverPlans.twentyPct);
    show(openPairs.btc900);
    await screen.findByText('Total cost');
    expect(screen.queryByRole('button', { name: /Maker settings/ })).toBeNull();
  });

  it('boros gas line with the close count in the cost box under twap', async () => {
    servePlan({ ...deleverPlans.twentyPct, borosCloses: 48, borosGasUsd: 0.24 } as DeleverPlan);
    show(openPairs.btc900);
    expect(screen.queryByText(/^Boros gas/)).toBeNull();
    await turnTwapOn('4h', '5m');
    expect(await screen.findByText('Boros gas · 48 closes')).toBeInTheDocument();
    expect(screen.getByText('$0.24')).toBeInTheDocument();
  });

  it('a twap slice past the book refuses with the text and fix from the plan', async () => {
    const refusal = {
      field: 'sliceSize' as const,
      text: 'Book too thin for 15 BTC a slice.',
      fix: { label: 'Use 9 BTC', patch: { durationSec: 3_600, sliceQty: '9' } },
    };
    servePlan(deleverPlans.twentyPct, { plan: null, refusal, price: 100_000 });
    show(openPairs.btc900);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('switch', { name: 'TWAP' }));
    expect(await screen.findByText(/^Book too thin for 15 BTC a slice\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use 9 BTC' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Hold to delever/ })).toBeDisabled();
  });

  it('the plan request carries the twap input and no slice size', async () => {
    const sent = servePlan(deleverPlans.twentyPct);
    show(openPairs.btc900);
    await turnTwapOn('4h', '5m');
    await screen.findByText(/^Slices 48/);
    const last = sent[sent.length - 1]!;
    expect(last.twap).toMatchObject({ durationSec: 14_400, intervalSec: 300 });
    expect(last.sliceUsd).toBeUndefined();
  });

  it('with twap on the not hedged line shows the per slice figure', async () => {
    servePlan(deleverPlans.twentyPct);
    show(openPairs.btc900);
    await turnTwapOn('4h', '5m');
    await screen.findByText(/^Slices 48/);
    expect(await screen.findByText(/^Not hedged during each slice: max 3\.75 BTC/)).toBeInTheDocument();
  });

  it('a twap refusal clears the cost box', async () => {
    const refusal = { field: 'sliceSize' as const, text: 'Book too thin for 15 BTC a slice.', fix: null };
    servePlan(deleverPlans.twentyPct, { plan: null, refusal, price: 100_000 });
    show(openPairs.btc900);
    expect(await screen.findByText('Total cost')).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('switch', { name: 'TWAP' }));
    expect(await screen.findByText(/^Book too thin for 15 BTC a slice\./)).toBeInTheDocument();
    expect(screen.queryByText('Total cost')).not.toBeInTheDocument();
  });
});
