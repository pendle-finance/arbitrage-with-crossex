/** PositionsHome: the 4-leg box home. Ports the old StrategyPanel cases
 * (address entry → persistence → live card; degraded states; clock control)
 * and adds the box-taxonomy behaviors: perp-only boxes with cues, zero
 * strategy calls without an address, and the legacy-flag migration. */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import type { PositionsResponse, StrategyReturns } from '../api/types';
import {
  makeExposureGroup,
  makeStrategyLeg,
  makeStrategyReturns,
  makeStrategyRollup,
  versionHandler,
} from '../test/fixtures';
import { env, server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { bookIdOf } from './bookId';
import { STRATEGY_STORAGE_KEY } from './HomeControls';
import { PositionsHome } from './PositionsHome';
import { SettingsDrawer } from './SettingsDrawer';
import { TrackedAddressProvider } from './trackedAddress';

const ADDR = '0xB2684Cd15b0CF17050531C51d581A9dDc365f1ef';
/** Annotations are stored per (wallet, Gate account). No /api/credentials
 * handler is registered by default, so the Gate half reads as absent. */
const BOOK = bookIdOf(ADDR, null);

const mockPositions = (body: Partial<PositionsResponse> = {}) =>
  server.use(
    http.get('/api/positions', () =>
      HttpResponse.json(env<PositionsResponse>({ positions: [], exposure: [], ...body })),
    ),
  );

const mockStrategy = (body: StrategyReturns, requested?: string[]) =>
  server.use(
    http.get('/api/strategy/:address', ({ params }) => {
      requested?.push(String(params.address));
      return HttpResponse.json(env(body));
    }),
  );

describe('PositionsHome — address tracking (ported from StrategyPanel)', () => {
  it('starts with the tracking empty state and rejects a malformed address inline', async () => {
    mockPositions();
    renderWithClient(<PositionsHome />);
    expect(await screen.findByText('Track your 4-leg strategy')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('EVM address'), 'not-an-address');
    await userEvent.click(screen.getByRole('button', { name: 'Track' }));
    expect(screen.getByText(/doesn't look like an EVM address/)).toBeInTheDocument();
    expect(localStorage.getItem(STRATEGY_STORAGE_KEY)).toBeNull();
  });

  it('tracks a valid address: fetches, renders the box, and persists the new shape', async () => {
    const requested: string[] = [];
    mockPositions();
    mockStrategy(makeStrategyReturns(), requested);
    renderWithClient(<PositionsHome />);

    await userEvent.type(await screen.findByLabelText('EVM address'), ADDR);
    await userEvent.click(screen.getByRole('button', { name: 'Track' }));

    expect(await screen.findByText('hedged ✓')).toBeInTheDocument();
    expect(requested).toEqual([ADDR]);
    expect(JSON.parse(localStorage.getItem(STRATEGY_STORAGE_KEY)!)).toEqual({
      address: ADDR,
      sinceByAddress: {},
      capitalBasis: 'balance',
    });
    // The input collapsed into the watch header.
    expect(screen.getByRole('button', { name: /0xB268…f1ef/ })).toBeInTheDocument();
    expect(screen.queryByLabelText('EVM address')).not.toBeInTheDocument();
  });

  it('auto-fetches on mount from the persisted address', async () => {
    localStorage.setItem(STRATEGY_STORAGE_KEY, JSON.stringify({ address: ADDR }));
    mockPositions();
    mockStrategy(makeStrategyReturns());
    renderWithClient(<PositionsHome />);
    expect(await screen.findByText('hedged ✓')).toBeInTheDocument();
  });

  it('the address chip opens Settings — there is no inline editor any more', async () => {
    localStorage.setItem(STRATEGY_STORAGE_KEY, JSON.stringify({ address: ADDR }));
    mockPositions();
    mockStrategy(makeStrategyReturns());
    const onOpenSettings = vi.fn();
    renderWithClient(
      <TrackedAddressProvider onOpenSettings={onOpenSettings}>
        <PositionsHome />
      </TrackedAddressProvider>,
    );
    await screen.findByText('hedged ✓');

    await userEvent.click(screen.getByRole('button', { name: /0xB268…f1ef/ }));

    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    // The chip no longer swaps the boxes out for a form.
    expect(screen.queryByLabelText('EVM address')).not.toBeInTheDocument();
    expect(screen.getByText('hedged ✓')).toBeInTheDocument();
  });

  it('never shows the previous address’s data after switching to a new address', async () => {
    localStorage.setItem(STRATEGY_STORAGE_KEY, JSON.stringify({ address: ADDR }));
    const OTHER = '0x' + 'cd'.repeat(20);
    mockPositions();
    server.use(
      http.get('/api/credentials', () =>
        HttpResponse.json(env({ configured: true, keyMasked: 'gk_****abcd' })),
      ),
      versionHandler(), // the drawer's About section reads /api/version
      http.get('/api/strategy/:address', async ({ params }) => {
        if (String(params.address) === ADDR)
          return HttpResponse.json(env(makeStrategyReturns()));
        await new Promise((r) => setTimeout(r, 150));
        return HttpResponse.json(env(makeStrategyReturns({ strategies: [] })));
      }),
    );
    // Switching the address is a Settings action now — drive the real surface,
    // sharing one tracked-address store with the boxes.
    renderWithClient(
      <>
        <SettingsDrawer open onClose={() => {}} />
        <PositionsHome />
      </>,
    );
    expect(await screen.findByText('hedged ✓')).toBeInTheDocument();

    const input = screen.getByLabelText('EVM address');
    await userEvent.clear(input);
    await userEvent.type(input, OTHER);
    await userEvent.click(screen.getByRole('button', { name: 'Update' }));

    // While the new address loads, the OLD box must NOT be attributed to it.
    expect(screen.queryByText('hedged ✓')).not.toBeInTheDocument();
    expect(await screen.findByText('No positions')).toBeInTheDocument();
  });
});

describe('PositionsHome — degraded states', () => {
  it('shows the no-positions empty state and surfaces global warnings', async () => {
    localStorage.setItem(STRATEGY_STORAGE_KEY, JSON.stringify({ address: ADDR }));
    mockPositions();
    mockStrategy(
      makeStrategyReturns({
        strategies: [],
        warnings: ['Gate credentials are not configured — showing the Boros legs only (connect Gate keys to overlay perp legs 1–2).'],
      }),
    );
    renderWithClient(<PositionsHome />);
    expect(await screen.findByText('No positions')).toBeInTheDocument();
    expect(screen.getByText(/Gate credentials are not configured/)).toBeInTheDocument();
  });

  it('surfaces a strategy load error with retry; perp boxes still render, never the Boros cue', async () => {
    localStorage.setItem(STRATEGY_STORAGE_KEY, JSON.stringify({ address: ADDR }));
    mockPositions({ exposure: [makeExposureGroup({ base: 'ETH' })] });
    let fail = true;
    server.use(
      http.get('/api/strategy/:address', () => {
        if (fail) {
          return HttpResponse.json(
            { ok: false, error: { category: 'network', message: 'Boros API unreachable', retryable: true } },
            { status: 502 },
          );
        }
        return HttpResponse.json(env(makeStrategyReturns()));
      }),
    );
    renderWithClient(<PositionsHome />);
    expect(await screen.findByText("Couldn't load Boros strategy data")).toBeInTheDocument();
    // The ETH pair still shows as a box — with a neutral note, NOT the
    // "execute the fixed legs on Boros" claim (the feed never settled).
    expect(screen.getByText('ETH')).toBeInTheDocument();
    expect(screen.getByText(/matching Boros legs…/)).toBeInTheDocument();
    expect(screen.queryByText(/Execute the fixed legs on Boros/)).not.toBeInTheDocument();

    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText('hedged ✓')).toBeInTheDocument());
  });

  it('keeps showing the last good box when a background poll fails (stale, not blanked)', async () => {
    localStorage.setItem(STRATEGY_STORAGE_KEY, JSON.stringify({ address: ADDR }));
    mockPositions();
    let fail = false;
    server.use(
      http.get('/api/strategy/:address', () =>
        fail
          ? HttpResponse.json(
              { ok: false, error: { category: 'network', message: 'blip', retryable: true } },
              { status: 502 },
            )
          : HttpResponse.json(env(makeStrategyReturns())),
      ),
    );
    renderWithClient(<PositionsHome />);
    expect(await screen.findByText('hedged ✓')).toBeInTheDocument();

    fail = true;
    await userEvent.click(screen.getByRole('button', { name: /⟳/ })); // manual refetch
    await waitFor(() => expect(screen.getByText(/stale .* retrying/)).toBeInTheDocument());
    expect(screen.getByText('hedged ✓')).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load Boros strategy data")).not.toBeInTheDocument();
  });
});

describe('PositionsHome — box taxonomy & cues', () => {
  it('without an address: perp pairs render as boxes with the add-address cue and ZERO strategy calls', async () => {
    const requested: string[] = [];
    mockPositions({
      exposure: [
        makeExposureGroup({ base: 'ETH' }),
        makeExposureGroup({
          base: 'SOL',
          singleLeg: true,
          neutral: false,
          legs: [{ symbol: 'BINANCE_FUTURE_SOL_USDT', exchange: 'BINANCE', quote: 'USDT', side: 'LONG', qty: 2, value: 300 }],
        }),
      ],
    });
    mockStrategy(makeStrategyReturns(), requested);
    renderWithClient(<PositionsHome />);

    expect(await screen.findByText('ETH')).toBeInTheDocument();
    // Pair box: neutral badge + add-address cue; stray box: unpaired-leg chip.
    expect(screen.getByText('neutral ✓')).toBeInTheDocument();
    expect(screen.getByText('unpaired leg')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Add Boros address' }).length).toBeGreaterThan(0);
    expect(requested).toHaveLength(0);
  });

  it('the add-address cue opens the form lazily and tracking from it stores the address', async () => {
    mockPositions({ exposure: [makeExposureGroup({ base: 'ETH' })] });
    mockStrategy(makeStrategyReturns({ strategies: [] }));
    renderWithClient(<PositionsHome />);
    await screen.findByText('ETH');

    expect(screen.queryByLabelText('EVM address')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add Boros address' }));
    await userEvent.type(screen.getByLabelText('EVM address'), ADDR);
    await userEvent.click(screen.getByRole('button', { name: 'Track' }));
    expect(JSON.parse(localStorage.getItem(STRATEGY_STORAGE_KEY)!).address).toBe(ADDR);
  });

  it('with a settled feed: a perp-only box carries the execute-on-Boros link-out', async () => {
    localStorage.setItem(STRATEGY_STORAGE_KEY, JSON.stringify({ address: ADDR }));
    mockPositions({ exposure: [makeExposureGroup({ base: 'ETH' })] });
    mockStrategy(makeStrategyReturns()); // HYPE strategy — ETH stays perp-only
    renderWithClient(<PositionsHome />);

    expect(await screen.findByText('hedged ✓')).toBeInTheDocument();
    expect(screen.getByText(/No Boros position found for ETH/)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /Execute the fixed legs on Boros/ });
    expect(link).toHaveAttribute('href', 'https://boros.finance');
  });

  it('a rollup base consumes its exposure group (no duplicate perp-only box)', async () => {
    localStorage.setItem(STRATEGY_STORAGE_KEY, JSON.stringify({ address: ADDR }));
    mockPositions({
      exposure: [
        makeExposureGroup({
          base: 'HYPE',
          legs: [
            { symbol: 'BYBIT_FUTURE_HYPE_USDT', exchange: 'BYBIT', quote: 'USDT', side: 'LONG', qty: 1, value: 100 },
            { symbol: 'HYPERLIQUID_FUTURE_HYPE_USDC', exchange: 'HYPERLIQUID', quote: 'USDC', side: 'SHORT', qty: 1, value: 100 },
          ],
        }),
      ],
    });
    mockStrategy(makeStrategyReturns());
    renderWithClient(<PositionsHome />);
    expect(await screen.findByText('hedged ✓')).toBeInTheDocument();
    // No perp-only cue for HYPE — it lives inside the strategy box.
    expect(screen.queryByText(/No Boros position found for HYPE/)).not.toBeInTheDocument();
  });

  it('ports the exposure chips: signed venue chips with quote sub-labels + Close both', async () => {
    mockPositions({
      exposure: [
        makeExposureGroup({
          base: 'BTC',
          legs: [
            { symbol: 'KRAKEN_FUTURE_BTC_USD', exchange: 'KRAKEN', quote: 'USD', side: 'LONG', qty: 0.1, value: 9387 },
            { symbol: 'HYPERLIQUID_FUTURE_BTC_USDC', exchange: 'HYPERLIQUID', quote: 'USDC', side: 'SHORT', qty: 0.1, value: 9389 },
          ],
          longValue: 9387,
          shortValue: 9389,
          netValue: -2,
          grossValue: 18776,
        }),
      ],
    });
    renderWithClient(<PositionsHome />);
    expect(await screen.findByText(/\+KRAKEN \$9,387/)).toBeInTheDocument();
    expect(screen.getByText(/−HYPERLIQUID \$9,389/)).toBeInTheDocument();
    expect(screen.getByText('neutral ✓')).toBeInTheDocument();
    // renderWithClient mounts TradeFlowProvider → the hold-button renders.
    expect(screen.getByRole('button', { name: 'Close both' })).toBeInTheDocument();
  });
});

describe('PositionsHome — clock & exit flags', () => {
  it('lets the user edit the strategy start from the timeline (sent as ?since=) and reset it', async () => {
    localStorage.setItem(STRATEGY_STORAGE_KEY, JSON.stringify({ address: ADDR }));
    mockPositions();
    const sinceSeen: Array<string | null> = [];
    server.use(
      http.get('/api/strategy/:address', ({ request }) => {
        sinceSeen.push(new URL(request.url).searchParams.get('since'));
        return HttpResponse.json(env(makeStrategyReturns()));
      }),
    );
    renderWithClient(<PositionsHome />);
    await screen.findByText('hedged ✓');
    expect(sinceSeen).toEqual([null]); // default: no override

    // The timeline labels the start as the Boros open, with an edit affordance.
    expect(screen.getByText('Boros position open')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Edit the strategy start' }));
    const dt = screen.getByLabelText('APR clock start');
    fireEvent.change(dt, { target: { value: '2026-07-01T10:30' } });
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));

    const expected = String(Math.floor(new Date('2026-07-01T10:30').getTime() / 1000));
    await waitFor(() => expect(sinceSeen.at(-1)).toBe(expected));
    // Stored against the WALLET it was set on, so switching books cannot
    // measure the next one's return from this date.
    expect(JSON.parse(localStorage.getItem(STRATEGY_STORAGE_KEY)!)).toEqual({
      address: ADDR,
      sinceByAddress: { [ADDR.toLowerCase()]: Number(expected) },
      capitalBasis: 'balance',
    });
    // With an override the timeline label flips to "custom start".
    expect(await screen.findByText('custom start')).toBeInTheDocument();

    // Default restores the Boros-open anchor.
    await userEvent.click(screen.getByRole('button', { name: 'Edit the strategy start' }));
    await userEvent.click(screen.getByRole('button', { name: 'Default' }));
    await waitFor(() => expect(sinceSeen.at(-1)).toBeNull());
  });



  it('shows the totals strip only when more than one strategy is running', async () => {
    localStorage.setItem(STRATEGY_STORAGE_KEY, JSON.stringify({ address: ADDR }));
    mockPositions();
    mockStrategy(
      makeStrategyReturns({
        strategies: [makeStrategyRollup(), makeStrategyRollup({ base: 'BTC' })],
      }),
    );
    renderWithClient(<PositionsHome />);
    expect(await screen.findByText(/Boros-tracked totals/)).toBeInTheDocument();
  });
});

describe('PositionsHome — capital basis', () => {
  it('sends the stored basis, and nothing when it is the default', async () => {
    localStorage.setItem(
      STRATEGY_STORAGE_KEY,
      JSON.stringify({ address: ADDR, since: null, capitalBasis: 'im' }),
    );
    mockPositions();
    const urls: string[] = [];
    server.use(
      http.get('/api/strategy/:address', ({ request }) => {
        urls.push(request.url);
        return HttpResponse.json(env(makeStrategyReturns()));
      }),
    );
    renderWithClient(<PositionsHome />);
    await waitFor(() => expect(urls.length).toBeGreaterThan(0));
    expect(urls[0]).toContain('capital=im');
  });

  it('leaves the URL clean on the default basis', async () => {
    localStorage.setItem(STRATEGY_STORAGE_KEY, JSON.stringify({ address: ADDR, since: null }));
    mockPositions();
    const urls: string[] = [];
    server.use(
      http.get('/api/strategy/:address', ({ request }) => {
        urls.push(request.url);
        return HttpResponse.json(env(makeStrategyReturns()));
      }),
    );
    renderWithClient(<PositionsHome />);
    await waitFor(() => expect(urls.length).toBeGreaterThan(0));
    expect(urls[0]).not.toContain('capital=');
  });
});

describe('PositionsHome — a book split across strategies', () => {
  /** Two strategies sharing one HYPERLIQUID leg, plus 40 HYPE of it that
   * nothing hedges. */
  /** The shared HYPERLIQUID short carries only part of its venue position. */
  const sharedLegs = () =>
    makeStrategyRollup().legs.map((l) =>
      l.kind === 'perp' && l.venue === 'HYPERLIQUID' ? { ...l, share: 0.6 } : { ...l, share: 1 },
    );

  const splitReturns = () =>
    makeStrategyReturns({
      strategies: [
        makeStrategyRollup({
          strategyId: 'HYPE#BYBIT-HYPERLIQUID#1750000000',
          attribution: { source: 'fill-history', confidence: 'measured', pinned: false },
          legs: sharedLegs(),
        }),
        makeStrategyRollup({
          strategyId: 'HYPE#BYBIT-HYPERLIQUID#1749900000',
          attribution: { source: 'proximity', confidence: 'unconfirmed', pinned: false },
          legs: sharedLegs(),
          // Two tranches of the SAME pair at the same size: what tells them
          // apart is the day each was opened, which is what the id encodes.
          clockStartSec: 1_749_900_000,
        }),
        // Size on the shared leg neither pair claimed. It is a POSITION of one
        // leg, not a footnote beside them — same card, same controls.
        makeStrategyRollup({
          strategyId: 'HYPE#unhedged:HYPERLIQUID_FUTURE_HYPE_USDC',
          attribution: { source: 'unhedged', confidence: 'measured', pinned: false },
          hedge: 'unhedged',
          maturity: 0,
          legs: sharedLegs()
            .filter((l) => l.kind === 'perp' && l.venue === 'HYPERLIQUID')
            .map((l) => ({ ...l, share: 0.25, notionalToken: 40 })),
        }),
      ],
    });

  const track = () =>
    localStorage.setItem(STRATEGY_STORAGE_KEY, JSON.stringify({ address: ADDR, since: null }));

  it('renders one box per strategy and flags the one that was only proposed', async () => {
    track();
    mockPositions();
    mockStrategy(splitReturns());
    renderWithClient(<PositionsHome />);
    expect(await screen.findByText('split unconfirmed')).toBeInTheDocument();
    expect(screen.getByText('split measured')).toBeInTheDocument();
  });

  it('names every destination by its venues — never a raw id, never a duplicate', async () => {
    // A position holding one perp and its Boros legs has no long/short PERP
    // pair. The picker used to demand one and fall back to the strategyId, so
    // the only way to move a leg there was to recognise "7e1d80b8".
    track();
    mockPositions();
    mockStrategy(splitReturns());
    renderWithClient(<PositionsHome />);
    await screen.findByText('split unconfirmed');
    for (const t of screen.getAllByRole('button', { name: 'toggle details' })) fireEvent.click(t);

    const options = screen
      .getAllByLabelText(/perp leg belongs$/)
      .flatMap((sel) => [...sel.querySelectorAll('option')])
      .map((o) => o.textContent ?? '')
      .filter((t) => !/^(this position|nothing — report as unhedged|automatic)$/.test(t));
    expect(options.length).toBeGreaterThan(0);
    for (const label of options) {
      expect(label, `destination shown as a raw id: ${label}`).not.toMatch(/#|^[0-9a-f]{8}$/);
      expect(label).toMatch(/^(long|short) /);
    }
    // The two same-shaped positions are told apart by size, not left identical.
    const perCard = screen
      .getAllByLabelText(/perp leg belongs$/)
      .map((sel) =>
        [...sel.querySelectorAll('option')]
          .map((o) => o.textContent ?? '')
          .filter((t) => !/^(this position|nothing — report as unhedged|automatic)$/.test(t)),
      );
    for (const labels of perCard) {
      expect(new Set(labels).size, `ambiguous options: ${labels}`).toBe(labels.length);
    }
  });

  it('shows leftover exposure as a card of its own instead of letting it disappear', async () => {
    track();
    mockPositions();
    mockStrategy(splitReturns());
    renderWithClient(<PositionsHome />);
    await screen.findByText('split unconfirmed');
    // Three cards, and the third says plainly that nothing is locked against
    // it — the amber strip this replaced could not show its funding or fees.
    expect(screen.getAllByText('unhedged')).toHaveLength(1);
    expect(screen.getAllByText('no maturity')).toHaveLength(1);
  });

  it('loads the pins of the address actually being tracked, not the previous one', async () => {
    // Pins belong to a book. Address A's assertions must not ride along into a
    // request for address B — nor be written into B's storage entry later.
    const OTHER = '0x' + 'ab'.repeat(20);
    localStorage.setItem(
      'crossex.partition.v1',
      JSON.stringify({
        [bookIdOf(OTHER, null)]: {
          pins: [{ base: 'HYPE', longVenue: 'BYBIT', shortVenue: 'HYPERLIQUID', qty: 999 }],
          savedAtSec: 1_700_000_000,
        },
      }),
    );
    mockPositions();
    const urls: string[] = [];
    server.use(
      http.get('/api/strategy/:address', ({ request }) => {
        urls.push(request.url);
        return HttpResponse.json(env(splitReturns()));
      }),
    );
    renderWithClient(<PositionsHome />);
    await screen.findByText('Track your 4-leg strategy');

    // Track a DIFFERENT address than the one holding pins: its request must go
    // out clean.
    await userEvent.type(screen.getByLabelText('EVM address'), ADDR);
    await userEvent.click(screen.getByRole('button', { name: 'Track' }));
    await waitFor(() => expect(urls.length).toBeGreaterThan(0));
    expect(urls.every((u) => !u.includes('partition='))).toBe(true);
  });

  it('lets an orphaned leg be handed back from its own card', async () => {
    // Orphaned size is a one-leg position, so the undo is that card's own
    // "belongs to" picker — the assertion must never be escapable only by
    // clearing storage.
    track();
    localStorage.setItem(
      'crossex.partition.v1',
      JSON.stringify({
        [BOOK]: {
          rows: [{ leg: { kind: 'perp', symbol: 'HYPERLIQUID_FUTURE_HYPE_USDC' } }],
          savedAtSec: 1_700_000_000,
        },
      }),
    );
    mockPositions();
    mockStrategy(splitReturns());
    renderWithClient(<PositionsHome />);
    await screen.findByText('split unconfirmed');
    for (const t of screen.getAllByRole('button', { name: 'toggle details' })) fireEvent.click(t);

    // The unhedged card renders after the two strategies, so its picker for
    // the shared HYPERLIQUID leg is the last one.
    const pickers = screen.getAllByLabelText('Where the HYPERLIQUID perp leg belongs');
    fireEvent.change(pickers[pickers.length - 1], { target: { value: '<auto>' } });
    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem('crossex.partition.v1') ?? '{}');
      expect(stored[BOOK]).toBeUndefined();
    });
  });

  it('freezes what the solver proposed, then applies the correction', async () => {
    // The first assertion on a proposed card mints an id and writes a row for
    // every leg it already had — otherwise correcting one leg would hand the
    // whole card back to the solver, which would just propose it again.
    track();
    mockPositions();
    const urls: string[] = [];
    server.use(
      http.get('/api/strategy/:address', ({ request }) => {
        urls.push(request.url);
        return HttpResponse.json(env(splitReturns()));
      }),
    );
    renderWithClient(<PositionsHome />);
    await screen.findByText('split unconfirmed');

    // The membership control lives in the leg's own expanded row.
    for (const t of screen.getAllByRole('button', { name: 'toggle details' })) fireEvent.click(t);
    fireEvent.click(
      screen.getAllByRole('button', {
        name: /Set how much of the HYPERLIQUID perp leg this position holds/,
      })[0],
    );
    fireEvent.change(screen.getAllByLabelText(/size for this position/)[0], {
      target: { value: '175' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Set size' })[0]);

    await waitFor(() => expect(urls.some((u) => u.includes('partition='))).toBe(true));
    const stored = JSON.parse(localStorage.getItem('crossex.partition.v1') ?? '{}');
    const rows = stored[BOOK].rows as Array<{
      positionId?: string;
      leg: { kind: string; symbol?: string };
      qty?: number;
    }>;
    // Every leg of that card is now stated, under one minted id…
    const ids = new Set(rows.map((r) => r.positionId));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toMatch(/^[0-9a-f]{8}$/);
    // …and the corrected leg carries the size that was typed.
    const hl = rows.find((r) => r.leg.symbol === 'HYPERLIQUID_FUTURE_HYPE_USDC')!;
    expect(hl.qty).toBe(175);
    expect(rows.length).toBeGreaterThan(1);
  });
});

/**
 * The membership journeys as a USER performs them: expand a leg, use its
 * picker, and check the rows that get written and sent.
 *
 * These exist because the per-component tests only ever proved that a control
 * fires an event. They never proved a task could be completed — which is how
 * "move a leg" shipped with no second half, and how a whole class of
 * assertion was silently dropped at the wire.
 */
describe('PositionsHome — membership journeys', () => {
  const HL = 'HYPERLIQUID_FUTURE_HYPE_USDC';
  const BYBIT = 'BYBIT_FUTURE_HYPE_USDT';

  const twoCards = () =>
    makeStrategyReturns({
      strategies: [
        makeStrategyRollup({
          strategyId: 'HYPE#BYBIT-HYPERLIQUID#a',
          attribution: { source: 'fill-history', confidence: 'measured', pinned: false },
          legs: makeStrategyRollup().legs.map((l) =>
            l.venue === 'HYPERLIQUID' && l.kind === 'perp' ? { ...l, share: 0.6 } : { ...l, share: 1 },
          ),
        }),
        makeStrategyRollup({
          strategyId: 'HYPE#BYBIT-HYPERLIQUID#b',
          attribution: { source: 'proximity', confidence: 'unconfirmed', pinned: false },
          legs: makeStrategyRollup().legs.map((l) =>
            l.venue === 'HYPERLIQUID' && l.kind === 'perp' ? { ...l, share: 0.4 } : { ...l, share: 1 },
          ),
        }),
      ],
    });

  const start = async () => {
    localStorage.setItem(STRATEGY_STORAGE_KEY, JSON.stringify({ address: ADDR, since: null }));
    mockPositions();
    const urls: string[] = [];
    server.use(
      http.get('/api/strategy/:address', ({ request }) => {
        urls.push(request.url);
        // Answer the assertion the way the server does: an ORPHANED leg is
        // dropped from every card. Ignoring the payload would let the undo
        // test drive a control that could not exist in the real app.
        const p = new URL(request.url).searchParams.get('partition') ?? '';
        const rows = p ? (JSON.parse(atob(p.replace(/-/g, '+').replace(/_/g, '/'))).r ?? []) : [];
        const orphaned = new Set(
          rows.filter((r: { p?: string }) => r.p === undefined).map((r: { r: string }) => r.r),
        );
        const body = twoCards();
        // …and reappears on a position of its own. Dropping it without that
        // would make the leg vanish, which the real solver never does — and
        // the undo rides on that card's own leg row.
        const loose = body.strategies
          .flatMap((s) => s.legs)
          .filter((l) => l.kind === 'perp' && orphaned.has(l.symbol ?? ''));
        for (const s of body.strategies) s.legs = s.legs.filter((l) => !orphaned.has(l.symbol ?? ''));
        body.strategies = [
          ...body.strategies,
          ...loose.map((l) =>
            makeStrategyRollup({
              strategyId: `${l.base}#unhedged:${l.symbol}`,
              attribution: { source: 'unhedged', confidence: 'measured', pinned: false },
              hedge: 'unhedged',
              maturity: 0,
              legs: [l],
            }),
          ),
        ];
        return HttpResponse.json(env(body));
      }),
    );
    renderWithClient(<PositionsHome />);
    await screen.findByText('split unconfirmed');
    for (const t of screen.getAllByRole('button', { name: 'toggle details' })) fireEvent.click(t);
    return urls;
  };

  const stored = () =>
    (JSON.parse(localStorage.getItem('crossex.partition.v1') ?? '{}')[BOOK]?.rows ??
      []) as Array<{ positionId?: string; leg: { kind: string; symbol?: string }; qty?: number }>;

  /** Every row the UI writes must survive the wire — a position id it minted
   * that the decoder rejects would make the whole assertion a no-op. */
  const expectWireSafe = () => {
    for (const r of stored()) {
      if (r.positionId !== undefined) expect(r.positionId).toMatch(/^[0-9a-f]{1,32}$/);
      expect(['perp', 'boros']).toContain(r.leg.kind);
    }
  };

  it('ORPHANS a leg: "nothing" is written as a row with no position', async () => {
    await start();
    fireEvent.change(screen.getAllByLabelText('Where the HYPERLIQUID perp leg belongs')[0], {
      target: { value: '<nowhere>' },
    });
    await waitFor(() => expect(stored().length).toBeGreaterThan(0));
    const orphan = stored().find((r) => r.positionId === undefined);
    expect(orphan?.leg).toEqual({ kind: 'perp', symbol: HL });
    expectWireSafe();
  });

  it('MOVES a leg: the destination card is offered, and both ends get frozen', async () => {
    await start();
    const picker = screen.getAllByLabelText('Where the BYBIT perp leg belongs')[0];
    const other = [...picker.querySelectorAll('option')].find((o) =>
      /HYPE#BYBIT-HYPERLIQUID#b/.test(o.value),
    );
    expect(other, 'the sibling card is not offered as a destination').toBeDefined();

    fireEvent.change(picker, { target: { value: 'HYPE#BYBIT-HYPERLIQUID#b' } });
    await waitFor(() => expect(stored().length).toBeGreaterThan(0));

    const rows = stored();
    const ids = new Set(rows.map((r) => r.positionId));
    // Source and destination both frozen — two ids, not one.
    expect(ids.size, `expected both ends frozen, got ${[...ids]}`).toBe(2);
    // The moved leg is on exactly one of them.
    const claims = rows.filter((r) => r.leg.symbol === BYBIT);
    expect(claims).toHaveLength(1);
    expectWireSafe();
  });

  it('SETS A SIZE: the typed number is what gets stored', async () => {
    await start();
    fireEvent.click(
      screen.getAllByRole('button', {
        name: 'Set how much of the HYPERLIQUID perp leg this position holds',
      })[0],
    );
    fireEvent.change(screen.getAllByLabelText(/size for this position/)[0], {
      target: { value: '123' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Set size' })[0]);
    await waitFor(() => expect(stored().length).toBeGreaterThan(0));
    expect(stored().find((r) => r.leg.symbol === HL)?.qty).toBe(123);
    expectWireSafe();
  });

  it('UNDOES: "automatic" clears the leg and the entry', async () => {
    await start();
    fireEvent.change(screen.getAllByLabelText('Where the HYPERLIQUID perp leg belongs')[0], {
      target: { value: '<nowhere>' },
    });
    await waitFor(() => expect(stored().some((r) => r.positionId === undefined)).toBe(true));

    // The server drops the orphaned leg from every card and returns it as a
    // one-leg position — whose own picker is the undo. Expand its row (fresh
    // toggles: the response replaced the cards) and choose the solver.
    await waitFor(() =>
      expect(
        screen.getAllByRole('button', { name: 'toggle details' }).length,
      ).toBeGreaterThan(0),
    );
    for (const t of screen.getAllByRole('button', { name: 'toggle details' })) fireEvent.click(t);
    const pickers = await screen.findAllByLabelText('Where the HYPERLIQUID perp leg belongs');
    fireEvent.change(pickers[pickers.length - 1], { target: { value: '<auto>' } });
    await waitFor(() => expect(stored().some((r) => r.leg.symbol === HL)).toBe(false));
    expectWireSafe();
  });

  it('sends every assertion to the server as ?partition=', async () => {
    const urls = await start();
    const before = urls.length;
    fireEvent.change(screen.getAllByLabelText('Where the HYPERLIQUID perp leg belongs')[0], {
      target: { value: '<nowhere>' },
    });
    await waitFor(() => expect(urls.length).toBeGreaterThan(before));
    expect(urls[urls.length - 1]).toMatch(/partition=/);
  });
});

describe('PositionsHome — moving a leg off a Boros-only card', () => {
  /**
   * The shape on screen: a hedged card, plus a card with NO perp legs holding
   * the rest of a shared Boros leg. Every other journey moves legs between
   * hedged positions; this is the one where the SOURCE has no perp pair, so
   * freezing it produces a position that can never build a card.
   */
  const withBorosOnly = () =>
    makeStrategyReturns({
      strategies: [
        makeStrategyRollup({
          strategyId: 'HYPE#BYBIT-HYPERLIQUID#a',
          attribution: { source: 'fill-history', confidence: 'measured', pinned: false },
          legs: [
            ...makeStrategyRollup().legs,
            makeStrategyLeg({
              kind: 'boros',
              venue: 'BINANCE',
              side: 'LONG',
              notionalToken: 0.0065,
              share: 0.5,
              marketId: 129,
            }),
          ],
        }),
        makeStrategyRollup({
          strategyId: 'HYPE@1798156800#unmatched',
          attribution: { source: 'boros-only', confidence: 'measured', pinned: false },
          legs: [
            makeStrategyLeg({
              kind: 'boros',
              venue: 'BINANCE',
              side: 'LONG',
              notionalToken: 0.0065,
              share: 0.5,
              marketId: 129,
            }),
          ],
        }),
      ],
    });

  it('offers the hedged card as a destination, and writes the move', async () => {
    localStorage.setItem(STRATEGY_STORAGE_KEY, JSON.stringify({ address: ADDR, since: null }));
    mockPositions();
    mockStrategy(withBorosOnly());
    renderWithClient(<PositionsHome />);
    for (const t of await screen.findAllByRole('button', { name: 'toggle details' })) {
      fireEvent.click(t);
    }

    // Two Boros pickers — the hedged card's and the Boros-only card's.
    const pickers = screen.getAllByLabelText('Where the BINANCE boros leg belongs');
    expect(pickers).toHaveLength(2);
    // The one on the Boros-only card can send it to the hedged card.
    const target = pickers.find((p) =>
      [...p.querySelectorAll('option')].some((o) => o.value === 'HYPE#BYBIT-HYPERLIQUID#a'),
    );
    expect(target, 'the hedged card is not offered as a destination').toBeDefined();

    fireEvent.change(target as HTMLElement, { target: { value: 'HYPE#BYBIT-HYPERLIQUID#a' } });
    await waitFor(() => {
      const rows = (JSON.parse(localStorage.getItem('crossex.partition.v1') ?? '{}')[BOOK]?.rows ??
        []) as Array<{ positionId?: string; leg: { kind: string; marketId?: number }; qty?: number }>;
      const claim = rows.filter((r) => r.leg.kind === 'boros' && r.leg.marketId === 129);
      // Exactly one position claims it — a move, not a share — and it takes
      // the whole leg rather than the half it happened to hold.
      expect(claim).toHaveLength(1);
      expect(claim[0].qty).toBeUndefined();
      expect(claim[0].positionId).toMatch(/^[0-9a-f]{1,32}$/);
    });
  });
});

describe('PositionsHome — a Boros-less pair rendered as a card', () => {
  const track = () =>
    localStorage.setItem(STRATEGY_STORAGE_KEY, JSON.stringify({ address: ADDR }));

  /** What the solver emits for a coin with no Boros cohort: one card, two
   * whole perp legs, no maturity. */
  const perpsOnly = () =>
    makeStrategyReturns({
      strategies: [
        makeStrategyRollup({
          strategyId: 'ETH#perps',
          attribution: { source: 'unhedged', confidence: 'measured', pinned: false },
          hedge: 'unhedged',
          maturity: 0,
          base: 'ETH',
          legs: [
            makeStrategyLeg({ kind: 'perp', venue: 'BINANCE', side: 'LONG', base: 'ETH', notionalToken: 5.25, share: 1, symbol: 'BINANCE_FUTURE_ETH_USDT' }),
            makeStrategyLeg({ kind: 'perp', venue: 'HYPERLIQUID', side: 'SHORT', base: 'ETH', notionalToken: 5.25, share: 1, symbol: 'HYPERLIQUID_FUTURE_ETH_USDC' }),
          ],
        }),
      ],
    });

  it('keeps Close both BELOW the legs it acts on, not up in the cue stack', async () => {
    track();
    mockPositions();
    mockStrategy(perpsOnly());
    const { container } = renderWithClient(<PositionsHome />);
    // The bar now carries a plain trigger that OPENS the close form; the
    // hold-to-confirm itself lives inside that dialog, off the card face.
    const close = await screen.findByRole('button', { name: 'Close position' });

    // It acts on the rows above it. Carried over from the perp-only box it
    // replaced, it landed among the "what's wrong with this position" notes,
    // where it read as another thing to fix rather than the card's action.
    const table = container.querySelector('table') as HTMLElement;
    expect(table).not.toBeNull();
    expect(
      table.compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING,
      'The close trigger must come after the leg table',
    ).toBeTruthy();
  });

  it('offers it only on a pair this card owns outright', async () => {
    // The venue closes the WHOLE position, so a card holding a slice of a
    // shared leg must not offer to close it.
    const shared = perpsOnly();
    shared.strategies[0].legs[1] = { ...shared.strategies[0].legs[1], share: 0.5 };
    track();
    mockPositions();
    mockStrategy(shared);
    renderWithClient(<PositionsHome />);
    await screen.findByText('unhedged');
    expect(screen.queryByRole('button', { name: 'Close both' })).not.toBeInTheDocument();
  });
});
