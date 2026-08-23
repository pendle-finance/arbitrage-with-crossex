import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ActionInput, DealRequest, PreviewResponse, PreviewResult, SymbolRule } from '../api/types';
import { baseHandlers, BTC_BINANCE, ETH_GATE, previewFor, symbolHandlers } from '../test/fixtures';
import { env, server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { PairTicket } from './PairTicket';
import { useTradeFlow, type PairPrefill } from './TradeFlow';

const ETH_OKX: SymbolRule = { ...ETH_GATE, symbol: 'OKX_FUTURE_ETH_USDT', exchange: 'OKX' };

const ethSymbolHandlers = () => symbolHandlers([ETH_GATE, ETH_OKX]);

interface VenueRates {
  maker: number;
  taker: number;
}

const TOUCH = { bestBid: 2499, bestAsk: 2501, mid: 2500 };

/**
 * POST /api/preview handler: pushes every request's actions into `calls`;
 * market legs answer with taker fees + a fill estimate, the maker (open-limit
 * POC) leg with maker-only fees + the venue touch (restEstimate).
 */
function previewHandler(opts: {
  calls: ActionInput[][];
  rates?: Record<string, VenueRates>;
  touch?: typeof TOUCH;
}) {
  const rates = opts.rates ?? {
    GATE: { maker: 0.0002, taker: 0.0005 },
    OKX: { maker: 0.0002, taker: 0.0005 },
  };
  const touch = opts.touch ?? TOUCH;
  return http.post('/api/preview', async ({ request }) => {
    const { actions } = (await request.json()) as { actions: ActionInput[] };
    opts.calls.push(actions);
    const previews = actions.map((a, i): PreviewResult => {
      const venue = a.symbol.split('_')[0];
      const r = rates[venue];
      const feesBase = { makerRate: r.maker, takerRate: r.taker, specialOverride: false, quote: 'USDT' };
      // Echo the action's leverage like the real resolver — the ticket's margin
      // line divides estNotional by it.
      const leverage =
        a.kind !== 'close-position' && a.leverage
          ? { requested: a.leverage, max: a.leverage }
          : undefined;
      if (a.kind === 'open-limit') {
        return previewFor(a, {
          index: i,
          type: 'LIMIT',
          tif: 'POC',
          price: a.price || String(touch.mid),
          qty: '0.4',
          estNotional: 1000,
          leverage,
          restEstimate: touch,
          fees: { ...feesBase, est: { maker: 1000 * r.maker } },
        });
      }
      return previewFor(a, {
        index: i,
        qty: '0.4',
        estNotional: 1000,
        leverage,
        fillEstimate: {
          qty: '0.4',
          avgPrice: 2500.5,
          worstPrice: 2501,
          midPrice: touch.mid,
          slippagePct: 0.02,
          source: 'venue-orderbook',
          confidence: 'high',
          venue,
        },
        fees: { ...feesBase, est: { taker: 1000 * r.taker } },
      });
    });
    return HttpResponse.json(env<PreviewResponse>({ previews }));
  });
}

/** Fill an already-mounted ticket: ETH via quick-pick, GATE as the LONG venue,
 * OKX as the SHORT venue, $1000/leg. Split from setupTwoVenuePair so the
 * remount-idempotency test can re-fill a SECOND freshly mounted ticket. */
async function fillTwoVenuePair() {
  await userEvent.click(screen.getByRole('button', { name: 'ETH' }));
  const longRow = screen.getByText('LONG venue').parentElement as HTMLElement;
  await userEvent.click(await within(longRow).findByRole('button', { name: 'GATE' }));
  const shortRow = screen.getByText('SHORT venue').parentElement as HTMLElement;
  await userEvent.click(within(shortRow).getByRole('button', { name: 'OKX' }));
  // The size box now defaults to the BASE coin, so a USD figure has to say so.
  await userEvent.click(within(screen.getByRole('radiogroup', { name: 'Size unit' })).getByRole('radio', { name: 'USDT' }));
  await userEvent.type(screen.getByLabelText('Size per leg (USDT)'), '1000');
}

/** ETH via quick-pick, GATE as the LONG venue, OKX as the SHORT venue, $1000/leg. */
async function setupTwoVenuePair() {
  renderWithClient(<PairTicket />);
  await fillTwoVenuePair();
}

/** Wait for the initial preview to land (fees become known). */
async function waitForFirstPreview() {
  await screen.findByText(/shared qty/, undefined, { timeout: 4000 });
}

const makerPanel = () => screen.getByText('Maker leg:').parentElement as HTMLElement;

/** The book+impact graph fetches a live touch per leg via GET /api/books/:symbol.
 * A default two-sided quote (bid 2499 / ask 2501, mid 2500) for every test; a
 * case wanting a different or missing book overrides it with its own server.use. */
beforeEach(() => {
  server.use(
    http.get('/api/books/:symbol', ({ params }) =>
      HttpResponse.json(env({ symbol: String(params.symbol), bestBid: 2499, bestAsk: 2501, mid: 2500 })),
    ),
  );
});

describe('PairTicket size unit', () => {
  it('sends qty (not notional) when the box is in the base coin', async () => {
    // The two keys are NOT interchangeable: `notional` is a USD figure the
    // engine divides by a reference price, `qty` is already a base quantity.
    // Sending 0.4 as `notional` would open a $0.40 order instead of 0.4 ETH.
    const calls: ActionInput[][] = [];
    server.use(...baseHandlers(), ...ethSymbolHandlers(), previewHandler({ calls }));
    renderWithClient(<PairTicket />);
    await userEvent.click(await screen.findByRole('button', { name: 'ETH' }));
    const longRow = screen.getByText('LONG venue').parentElement as HTMLElement;
    await userEvent.click(await within(longRow).findByRole('button', { name: 'GATE' }));
    const shortRow = screen.getByText('SHORT venue').parentElement as HTMLElement;
    await userEvent.click(within(shortRow).getByRole('button', { name: 'OKX' }));

    // Base is the DEFAULT — the label says so without anything being clicked.
    await userEvent.type(screen.getByLabelText('Size per leg (ETH)'), '0.4');
    await userEvent.click(screen.getByRole('radio', { name: '2 market orders' }));

    await waitFor(() => expect(calls.at(-1)?.[0]).toMatchObject({ qty: '0.4' }), {
      timeout: 4000,
    });
    for (const action of calls.at(-1)!) {
      expect(action).toMatchObject({ qty: '0.4' });
      // The pin: the USD key must be absent, not merely also-present.
      expect(action).not.toHaveProperty('notional');
    }
  });
});

describe('PairTicket execution modes', () => {
  it('defaults to "Limit + hedge"; "2 market orders" previews two plain open-market legs', async () => {
    const calls: ActionInput[][] = [];
    server.use(...baseHandlers(), ...ethSymbolHandlers(), previewHandler({ calls }));
    await setupTwoVenuePair();

    expect(screen.getByRole('radio', { name: /Limit \+ hedge/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: '2 market orders' })).toHaveAttribute('aria-checked', 'false');

    await userEvent.click(screen.getByRole('radio', { name: '2 market orders' }));
    await waitFor(
      () => expect(calls.at(-1)?.[0]).toMatchObject({ kind: 'open-market', notional: '1000' }),
      { timeout: 4000 },
    );
    const actions = calls.at(-1)!;
    expect(actions).toHaveLength(2);
    expect(actions[0]).toMatchObject({
      kind: 'open-market',
      symbol: 'GATE_FUTURE_ETH_USDT',
      side: 'BUY',
      notional: '1000',
    });
    expect(actions[1]).toMatchObject({
      kind: 'open-market',
      symbol: 'OKX_FUTURE_ETH_USDT',
      side: 'SELL',
      notional: '1000',
    });
    // Legacy market mode: no maker-hedge fields, but the legs share a pair group.
    expect(actions[0]).not.toHaveProperty('pairRole');
    expect(actions[1]).not.toHaveProperty('pairRole');
    expect(actions[0]).not.toHaveProperty('makerTimeoutSec');
    expect(actions[0].pairGroupId).toBeTruthy();
    expect(actions[1].pairGroupId).toBe(actions[0].pairGroupId);
  });

  it('shows the book + market-impact graph, and a limit line only in maker mode', async () => {
    const calls: ActionInput[][] = [];
    server.use(...baseHandlers(), ...ethSymbolHandlers(), previewHandler({ calls }));
    await setupTwoVenuePair();
    await waitForFirstPreview();

    // 2 market orders: the live two-sided quote (2499/2501 from the book handler)
    // and the market-order fill (2500.5 from the preview's fillEstimate) on
    // both legs.
    await userEvent.click(screen.getByRole('radio', { name: '2 market orders' }));
    expect(document.querySelector('[data-price-graph]')).not.toBeNull();
    await waitFor(() =>
      expect(
        document.querySelector('[data-leg="long"] [data-mark="fill"]')?.getAttribute('data-price'),
      ).toBe('2500.5'),
    );
    expect(
      document.querySelector('[data-leg="short"] [data-mark="fill"]')?.getAttribute('data-price'),
    ).toBe('2500.5');
    expect(document.querySelector('[data-leg="long"] [data-mark="bid"]')?.getAttribute('data-price')).toBe('2499');
    // The redundant per-leg footer rows are gone — exact numbers live on the
    // axis gutter and the marks' hover titles.
    expect(screen.queryByText('2499 / 2501')).toBeNull();
    // Both-market mode has no resting limit.
    expect(document.querySelector('[data-mark="limit"]')).toBeNull();

    // Limit + hedge (equal fees → the long leg rests): a cyan limit line appears
    // on the maker leg once the price auto-tracks the touch.
    await userEvent.click(screen.getByRole('radio', { name: /Limit \+ hedge/ }));
    await waitFor(() =>
      expect(document.querySelector('[data-leg="long"] [data-mark="limit"]')).not.toBeNull(),
    );
    expect(document.querySelector('[data-leg="short"] [data-mark="limit"]')).toBeNull();
  });

  it('leverage is PER LEG at each venue max (never min of the two, no input)', async () => {
    const calls: ActionInput[][] = [];
    // Asymmetric caps: GATE max 10x, OKX max 50x (like HL 5x vs Bybit 20x live).
    server.use(
      ...baseHandlers(),
      ...symbolHandlers([ETH_GATE, ETH_OKX], { GATE_FUTURE_ETH_USDT: 10, OKX_FUTURE_ETH_USDT: 50 }),
      previewHandler({ calls }),
    );
    await setupTwoVenuePair();

    // Each leg runs at its OWN venue max \u2014 never min of the two.
    await waitFor(() => expect(calls.at(-1)?.[0]).toMatchObject({ leverage: 10 }), { timeout: 4000 });
    expect(calls.at(-1)?.[1]).toMatchObject({ symbol: 'OKX_FUTURE_ETH_USDT', leverage: 50 });
    // Shown, not editable.
    expect(screen.getByText('10x long / 50x short (venue max)')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/venue max/)).not.toBeInTheDocument();
    // Total initial margin the pair posts: 1000/10 + 1000/50 = $120.
    expect(screen.getByText('Margin required')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('\u2248 $120')).toBeInTheDocument(), { timeout: 4000 });
  });

  it('holding Execute pair in maker mode POSTs a touch-pegged maker deal (while tracking)', async () => {
    const calls: ActionInput[][] = [];
    const dealCalls: DealRequest[] = [];
    server.use(
      ...baseHandlers(),
      ...ethSymbolHandlers(),
      previewHandler({ calls }),
      http.post('/api/deals', async ({ request }) => {
        dealCalls.push((await request.json()) as DealRequest);
        return HttpResponse.json(env({ id: dealCalls[0].id }), { status: 202 });
      }),
    );
    await setupTwoVenuePair();
    await waitForFirstPreview();
    await userEvent.click(screen.getByRole('radio', { name: /Limit \+ hedge/ }));
    // Price auto-tracks one gap behind the bid (unpinned): 2499 − 2 = 2497.
    await waitFor(() => expect(screen.getByLabelText(/Maker price/)).toHaveValue('2497'), { timeout: 4000 });

    const btn = screen.getByRole('button', { name: 'Execute pair ▸' });
    await waitFor(() => expect(btn).toBeEnabled(), { timeout: 4000 });
    fireEvent.pointerDown(btn); // hold-to-confirm (default 800ms)
    await waitFor(() => expect(dealCalls).toHaveLength(1), { timeout: 2_000 });

    // The tracking ticket maps to a maker deal: pricePolicy 'touch' (the engine
    // re-pegs at submit), the tracked book-offset as the fallback price, the
    // hedge leg opposite, and the ticket's timeout carried through.
    expect(dealCalls[0]).toMatchObject({
      execution: 'maker',
      pricePolicy: 'touch',
      price: '2497',
      timeoutSec: 300,
      a: { side: 'BUY' },
      b: { side: 'SELL' },
    });
  });

  it('maker mode builds [maker POC, hedge market] positionally and auto-fills the price from the touch', async () => {
    const calls: ActionInput[][] = [];
    server.use(...baseHandlers(), ...ethSymbolHandlers(), previewHandler({ calls }));
    await setupTwoVenuePair();
    await waitForFirstPreview();

    await userEvent.click(screen.getByRole('radio', { name: /Limit \+ hedge/ }));

    // Equal venue rates → auto-choice settles on the LONG leg (GATE, BUY maker),
    // so the tracked price is one gap behind the bid: 2499 − 2 = 2497.
    const priceInput = await screen.findByLabelText(/Maker price/);
    await waitFor(() => expect(priceInput).toHaveValue('2497'), { timeout: 4000 });

    await waitFor(
      () => {
        const pair = calls.find((c) => {
          const a = c[0];
          return a?.kind === 'open-limit' && a.price === '2497';
        });
        expect(pair).toBeDefined();
      },
      { timeout: 4000 },
    );
    const pair = calls.find((c) => {
      const a = c[0];
      return a?.kind === 'open-limit' && a.price === '2497';
    })!;
    // Positional order stays [LONG leg, SHORT leg] even though roles are attached.
    expect(pair[0]).toMatchObject({
      kind: 'open-limit',
      symbol: 'GATE_FUTURE_ETH_USDT',
      side: 'BUY',
      tif: 'POC',
      pairRole: 'maker',
      makerTimeoutSec: 300,
      notional: '1000',
      price: '2497',
    });
    expect(pair[1]).toMatchObject({
      kind: 'open-market',
      symbol: 'OKX_FUTURE_ETH_USDT',
      side: 'SELL',
      pairRole: 'hedge',
      notional: '1000',
    });
    expect(pair[1].pairGroupId).toBe(pair[0].pairGroupId);
  });

  it('auto-chooses the cheaper maker venue and shows the saving — no swap override', async () => {
    const calls: ActionInput[][] = [];
    server.use(
      ...baseHandlers(),
      ...ethSymbolHandlers(),
      previewHandler({
        calls,
        // GATE (long): maker 2bps / taker 4.8bps · OKX (short): maker 0bps / taker 5bps
        // maker-on-GATE = 2 + 5 = 7bps · maker-on-OKX = 0 + 4.8 = 4.8bps → OKX wins.
        rates: { GATE: { maker: 0.0002, taker: 0.00048 }, OKX: { maker: 0, taker: 0.0005 } },
      }),
    );
    await setupTwoVenuePair();
    await waitForFirstPreview();

    await userEvent.click(screen.getByRole('radio', { name: /Limit \+ hedge/ }));

    const panel = makerPanel();
    expect(within(panel).getByText('OKX')).toBeInTheDocument();
    expect(within(panel).getByText('auto')).toBeInTheDocument();
    // (4.8+5 − 4.8) bps × $1000 = $0.5
    expect(screen.getByText(/saves ≈ 0\.5 USDT/)).toBeInTheDocument();
    // The auto-choice is authoritative — there is no swap/override control.
    expect(within(panel).queryByRole('button', { name: 'swap' })).toBeNull();
    expect(within(panel).queryByText('manual')).toBeNull();

    await waitFor(
      () => {
        const c = calls.at(-1)!;
        expect(c[0]).toMatchObject({
          kind: 'open-market',
          symbol: 'GATE_FUTURE_ETH_USDT',
          side: 'BUY',
          pairRole: 'hedge',
        });
        expect(c[1]).toMatchObject({
          kind: 'open-limit',
          symbol: 'OKX_FUTURE_ETH_USDT',
          side: 'SELL',
          tif: 'POC',
          pairRole: 'maker',
        });
      },
      { timeout: 4000 },
    );
  });

  it('picking a timeout sends makerTimeoutSec on the maker leg', async () => {
    const calls: ActionInput[][] = [];
    server.use(...baseHandlers(), ...ethSymbolHandlers(), previewHandler({ calls }));
    await setupTwoVenuePair();
    await waitForFirstPreview();

    await userEvent.click(screen.getByRole('radio', { name: /Limit \+ hedge/ }));
    const timeoutGroup = screen.getByRole('radiogroup', { name: 'Maker timeout' });
    await userEvent.click(within(timeoutGroup).getByRole('radio', { name: '15m' }));
    expect(within(timeoutGroup).getByRole('radio', { name: '15m' })).toHaveAttribute('aria-checked', 'true');

    await waitFor(
      () => {
        const hit = calls.find((c) =>
          c.some((a) => a.kind === 'open-limit' && a.makerTimeoutSec === 900),
        );
        expect(hit).toBeDefined();
      },
      { timeout: 4000 },
    );
  });

  it('typing a price pins it against new touches; "track book" resumes tracking', async () => {
    const calls: ActionInput[][] = [];
    server.use(...baseHandlers(), ...ethSymbolHandlers(), previewHandler({ calls }));
    await setupTwoVenuePair();
    await waitForFirstPreview();

    await userEvent.click(screen.getByRole('radio', { name: /Limit \+ hedge/ }));
    const priceInput = await screen.findByLabelText(/Maker price/);
    // One gap behind the touch: bid 2499 − (2501 − 2499) = 2497.
    await waitFor(() => expect(priceInput).toHaveValue('2497'), { timeout: 4000 });
    expect(screen.getByText(/tracking the book/)).toBeInTheDocument();

    await userEvent.clear(priceInput);
    await userEvent.type(priceInput, '2450');
    expect(screen.getByText(/\(pinned/)).toBeInTheDocument();

    // Another preview cycle completes for the typed price (its response still
    // reports the touch at 2499/2501) — the pinned input must NOT be overwritten.
    await waitFor(
      () => {
        expect(
          calls.some((c) => {
            const a = c[0];
            return a?.kind === 'open-limit' && a.price === '2450';
          }),
        ).toBe(true);
      },
      { timeout: 4000 },
    );
    expect(priceInput).toHaveValue('2450');

    // Un-pinning resumes tracking: the input snaps back to the book offset.
    await userEvent.click(screen.getByRole('button', { name: 'track book' }));
    await waitFor(() => expect(priceInput).toHaveValue('2497'), { timeout: 4000 });
    expect(screen.getByText(/tracking the book/)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Lost-response idempotency across a REAL remount
// ---------------------------------------------------------------------------

describe('PairTicket idempotency across remount', () => {
  // Regression for the real-component gap the previous fix missed: its tests
  // exercised ExecuteControl with hand-supplied STABLE intentKeys, but the
  // actual PairTicket put pairGroupId — a fresh uuid every mount — INTO its
  // intentKey. So on the pre-fix code this test FAILS: after the unmount the
  // recomputed key never matches the persisted intent, readPendingBasket
  // returns null, a fresh uuid is minted, and the two POSTs carry DIFFERENT
  // ids — which on the live server means a second full delta-neutral pair
  // (2x notional on both venues). Post-fix the key is mount-stable (the group
  // id stays only in the actions) and the same id is resent for the server to
  // dedupe.
  it('resends the SAME deal id after a lost response, full unmount, and remount with the same inputs', async () => {
    const calls: ActionInput[][] = [];
    const dealCalls: DealRequest[] = [];
    server.use(
      ...baseHandlers(),
      ...ethSymbolHandlers(),
      previewHandler({ calls }),
      // Every POST "loses" its response (the server may or may not have created
      // the deal — only resending the same id makes the retry safe either way).
      http.post('/api/deals', async ({ request }) => {
        dealCalls.push((await request.json()) as DealRequest);
        return HttpResponse.json(
          { ok: false, error: { category: 'network', message: 'socket hang up', retryable: true } },
          { status: 500 },
        );
      }),
    );

    // First mount: fill the ticket and confirm — the response is lost.
    const first = renderWithClient(<PairTicket />);
    await fillTwoVenuePair();
    await waitFor(() => expect(screen.getByLabelText(/Maker price/)).toHaveValue('2497'), { timeout: 4000 });
    const btn1 = screen.getByRole('button', { name: 'Execute pair ▸' });
    await waitFor(() => expect(btn1).toBeEnabled(), { timeout: 4000 });
    fireEvent.pointerDown(btn1); // hold-to-confirm (default 800ms)
    await waitFor(() => expect(dealCalls).toHaveLength(1), { timeout: 2_000 });

    // Full unmount + fresh mount (what the Single/Pair toggle and a reload do),
    // then rebuild the EXACT same intent by hand.
    first.unmount();
    renderWithClient(<PairTicket />);
    await fillTwoVenuePair();
    await waitFor(() => expect(screen.getByLabelText(/Maker price/)).toHaveValue('2497'), { timeout: 4000 });
    const btn2 = screen.getByRole('button', { name: 'Execute pair ▸' });
    await waitFor(() => expect(btn2).toBeEnabled(), { timeout: 4000 });
    fireEvent.pointerDown(btn2);
    await waitFor(() => expect(dealCalls).toHaveLength(2), { timeout: 2_000 });

    // Same intent → the persisted id is recovered and resent; the server
    // dedupes it into the ORIGINAL deal instead of opening a second pair.
    expect(dealCalls[1].id).toBe(dealCalls[0].id);
  });
});

// ---------------------------------------------------------------------------
// Strategy-box prefill ("Open the perp legs" cue)
// ---------------------------------------------------------------------------

function PrefillHarness({ prefills }: { prefills: Array<Omit<PairPrefill, 'nonce'>> }) {
  const flow = useTradeFlow();
  return (
    <>
      {prefills.map((p, i) => (
        <button key={i} type="button" onClick={() => flow.prefillPair(p)}>
          fire-{i}
        </button>
      ))}
      <PairTicket />
    </>
  );
}

describe('PairTicket prefill', () => {
  it('lands base, venue symbols, and a rounded notional from a pairPrefill', async () => {
    const calls: ActionInput[][] = [];
    server.use(...baseHandlers(), ...ethSymbolHandlers(), previewHandler({ calls }));
    renderWithClient(
      <PrefillHarness
        prefills={[{ base: 'ETH', longVenue: 'OKX', shortVenue: 'GATE', notionalUsd: 1234.6 }]}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'fire-0' }));

    await waitFor(() => expect(screen.getByLabelText('Size per leg (USDT)')).toHaveValue('1235'));
    // Symbols resolved by venue → the preview fires with the mapped legs, in
    // the ticket's default Limit + hedge shape (equal fees → the long leg
    // rests as the maker, the short leg hedges at market).
    await waitFor(
      () => expect(calls.at(-1)?.[0]).toMatchObject({ notional: '1235', kind: 'open-limit' }),
      { timeout: 4000 },
    );
    const actions = calls.at(-1)!;
    expect(actions[0]).toMatchObject({
      kind: 'open-limit',
      symbol: 'OKX_FUTURE_ETH_USDT',
      side: 'BUY',
      pairRole: 'maker',
    });
    expect(actions[1]).toMatchObject({
      kind: 'open-market',
      symbol: 'GATE_FUTURE_ETH_USDT',
      side: 'SELL',
      pairRole: 'hedge',
    });
  });

  it('leaves a leg unselected when its venue has no CrossEx symbol (no preview fires)', async () => {
    const calls: ActionInput[][] = [];
    server.use(...baseHandlers(), ...ethSymbolHandlers(), previewHandler({ calls }));
    renderWithClient(
      <PrefillHarness
        prefills={[{ base: 'ETH', longVenue: 'BINANCE', shortVenue: 'GATE', notionalUsd: 500 }]}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'fire-0' }));
    await waitFor(() => expect(screen.getByLabelText('Size per leg (USDT)')).toHaveValue('500'));
    // The LONG leg stays unselected (BINANCE lists no ETH rule here) — with
    // only one symbol no preview can fire.
    await new Promise((r) => setTimeout(r, 250));
    expect(calls).toHaveLength(0);
  });

  it('arms the execution mode when the prefill carries one, price left tracking', async () => {
    const calls: ActionInput[][] = [];
    server.use(...baseHandlers(), ...ethSymbolHandlers(), previewHandler({ calls }));
    renderWithClient(
      <PrefillHarness
        prefills={[
          { base: 'ETH', longVenue: 'OKX', shortVenue: 'GATE', notionalUsd: 1000, mode: 'maker' },
        ]}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'fire-0' }));

    await waitFor(() =>
      expect(screen.getByRole('radio', { name: /Limit \+ hedge/ })).toHaveAttribute('aria-checked', 'true'),
    );
    expect(screen.getByRole('radio', { name: '2 market orders' })).toHaveAttribute('aria-checked', 'false');
    // Same invariant as the manual toggle: the maker price is not pinned.
    expect(screen.getByText(/tracking the book/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Size per leg (USDT)')).toHaveValue('1000'));
  });

  it('leaves the current mode untouched when the prefill carries none', async () => {
    const calls: ActionInput[][] = [];
    server.use(...baseHandlers(), ...ethSymbolHandlers(), previewHandler({ calls }));
    renderWithClient(
      <PrefillHarness
        prefills={[{ base: 'ETH', longVenue: 'OKX', shortVenue: 'GATE', notionalUsd: 1000 }]}
      />,
    );

    await userEvent.click(screen.getByRole('radio', { name: /Limit \+ hedge/ }));
    await userEvent.click(screen.getByRole('button', { name: 'fire-0' }));

    await waitFor(() => expect(screen.getByLabelText('Size per leg (USDT)')).toHaveValue('1000'));
    expect(screen.getByRole('radio', { name: /Limit \+ hedge/ })).toHaveAttribute('aria-checked', 'true');
  });
});

describe('PairTicket prefill — stale symbol-rules cache', () => {
  it("never resolves venues against the PREVIOUS base's keepPreviousData rows", async () => {
    const calls: ActionInput[][] = [];
    const BTC_OKX: SymbolRule = { ...BTC_BINANCE, symbol: 'OKX_FUTURE_BTC_USDT', exchange: 'OKX' };
    const ALL = [BTC_BINANCE, BTC_OKX, ETH_GATE, ETH_OKX];
    server.use(
      ...baseHandlers(),
      ...symbolHandlers(ALL), // provides /api/symbols/:symbol details
      previewHandler({ calls }),
      // Base-filtered list; ETH loads SLOWLY so the keepPreviousData window
      // (BTC rows served while ETH is in flight) is deterministically open.
      http.get('/api/symbols', async ({ request }) => {
        const base = new URL(request.url).searchParams.get('base');
        if (base === 'ETH') await new Promise((r) => setTimeout(r, 200));
        return HttpResponse.json(env(ALL.filter((r) => r.base === base)));
      }),
    );
    renderWithClient(
      <PrefillHarness
        prefills={[
          // Arm the cache with BTC rules first (one-sided: no preview fires).
          { base: 'BTC', longVenue: 'OKX', shortVenue: null, notionalUsd: 400 },
          { base: 'ETH', longVenue: 'OKX', shortVenue: 'GATE', notionalUsd: 1000 },
        ]}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'fire-0' }));
    await waitFor(() => expect(screen.getByLabelText('Size per leg (USDT)')).toHaveValue('400'));

    await userEvent.click(screen.getByRole('button', { name: 'fire-1' }));
    // The ETH pair must eventually arm with ETH symbols…
    await waitFor(() => expect(calls.at(-1)?.[0]).toMatchObject({ symbol: 'OKX_FUTURE_ETH_USDT' }), {
      timeout: 4000,
    });
    expect(calls.at(-1)?.[1]).toMatchObject({ symbol: 'GATE_FUTURE_ETH_USDT' });
    // …and no BTC symbol may ever have leaked into any preview/execution.
    const allSymbols = calls.flat().map((a) => a.symbol);
    expect(allSymbols.filter((sym) => sym.includes('BTC'))).toHaveLength(0);
  });
});

describe('notional validation', () => {
  // Reported live: someone pasted a spreadsheet-formatted "7,668.31" and the
  // ticket went silently dead — Number() gives NaN, so the actions were nulled
  // and Execute just never armed, with nothing on screen saying why.
  it('says what is wrong when a formatted number is pasted', async () => {
    renderWithClient(<PairTicket />);
    await userEvent.click(await screen.findByRole('button', { name: 'ETH' }));

    // No unit chosen, so the box is in the base coin — the comma check is the
    // same either way.
    const notional = screen.getByLabelText('Size per leg (ETH)');
    await userEvent.type(notional, '7,668.31');

    const err = await screen.findByRole('alert');
    expect(err).toHaveTextContent('Remove the commas — type 7668.31');
    expect(notional).toHaveAttribute('aria-invalid', 'true');
  });

  it('clears once the value is usable', async () => {
    renderWithClient(<PairTicket />);
    await userEvent.click(await screen.findByRole('button', { name: 'ETH' }));

    const notional = screen.getByLabelText('Size per leg (ETH)');
    await userEvent.type(notional, '7,668.31');
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    await userEvent.clear(notional);
    await userEvent.type(notional, '7668.31');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(notional).not.toHaveAttribute('aria-invalid');
  });
});
