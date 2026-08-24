/** PositionsHome: the 4-leg box home. Ports the old StrategyPanel cases
 * (address entry → persistence → live card; degraded states; clock control)
 * and adds the box-taxonomy behaviors: perp-only boxes with cues, zero
 * strategy calls without an address, and the legacy-flag migration. */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import type { ActionInput, PositionsResponse, StrategyReturns, StrategyRollup } from '../api/types';
import {
  makeCrossexPosition,
  makeExposureGroup,
  makeStrategyLeg,
  makeStrategyReturns,
  makeStrategyRollup,
  previewFor,
  versionHandler,
} from '../test/fixtures';
import { env, server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { bookIdOf } from './bookId';
import { STRATEGY_STORAGE_KEY } from './HomeControls';
import { PositionsHome } from './PositionsHome';
import { StrategyWizard } from '../trade/StrategyWizard';
import { SettingsDrawer } from './SettingsDrawer';
import { TrackedAddressProvider } from './trackedAddress';
import { TradeFlowProvider, useTradeFlow } from '../trade/TradeFlow';

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

/** Open a leg's assign dialog. The trigger is the "Belongs to" cell; its
 * accessible name is the size it shows, so match on the title instead. */
const openAssign = (venue = 'HYPERLIQUID', index = 0) =>
  fireEvent.click(screen.getAllByTitle(new RegExp(`open on ${venue}`))[index]);

/** Pick a destination inside the open dialog, then confirm. */
const chooseAndConfirm = (name: RegExp | string) => {
  fireEvent.click(screen.getByRole('button', { name }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
};

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
      capitalBasis: 'im',
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
  it('without an address: a pair renders as a full card, a stray as a box, and ZERO strategy calls', async () => {
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
    // The PAIR gets the same card a tracked position gets — a position must
    // not change visual language because of an input not supplied yet.
    expect(screen.getByText(/Track a Boros address to see whether these perps/)).toBeInTheDocument();
    // ⚠ And it must claim NOTHING about Boros legs it never looked for.
    expect(screen.queryByText(/No Boros legs yet/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Open the Boros legs/ })).not.toBeInTheDocument();
    expect(screen.queryByText('missing')).not.toBeInTheDocument();
    // The stray keeps the simpler box: one leg, so there is no pair to show.
    expect(screen.getByText('unpaired leg')).toBeInTheDocument();
    // The one action that can change what we know.
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

  it('with a settled feed that skipped a live coin: reports the disagreement, offers no trade', async () => {
    // A successful feed returning NOTHING for a coin holding live perps — not
    // even the `BASE#perps` rollup the solver emits for exactly this shape. So
    // the two feeds disagree, and this box says so.
    //
    // It deliberately does NOT offer a way to open Boros legs here. It used to
    // link out to boros.finance; when the feed is healthy this pair renders as
    // a StrategyCard which already has the in-app CTA, so a second entry point
    // on the degraded path would arm a trade off a book we just said we cannot
    // read.
    localStorage.setItem(STRATEGY_STORAGE_KEY, JSON.stringify({ address: ADDR }));
    mockPositions({ exposure: [makeExposureGroup({ base: 'ETH' })] });
    mockStrategy(makeStrategyReturns()); // HYPE strategy — ETH stays perp-only
    renderWithClient(<PositionsHome />);

    expect(await screen.findByText('hedged ✓')).toBeInTheDocument();
    expect(screen.getByText(/No Boros position found for ETH/)).toBeInTheDocument();
    expect(screen.getByText(/the strategy feed and the positions feed disagree/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Boros/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Execute the fixed legs/)).not.toBeInTheDocument();
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

  it('heads the degraded box in StrategyCard grammar: asset badge, venue pair, Close both', async () => {
    // A FAILED feed (not merely untracked) is what keeps the box: an untracked
    // pair now renders as a full card, so this fixture tracks an address and
    // fails the strategy call.
    localStorage.setItem(STRATEGY_STORAGE_KEY, JSON.stringify({ address: ADDR }));
    server.use(
      http.get('/api/strategy/:address', () =>
        HttpResponse.json(
          { ok: false, error: { category: 'unknown', message: 'down', retryable: true } },
          { status: 503 },
        ),
      ),
    );
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

    // The header now reads like a StrategyCard's: asset badge, then the venue
    // pair as ONE unit (long side first), not a row of signed value chips.
    // The per-leg values live in the table below, where the card keeps them.
    expect(await screen.findByTitle('BTC perp legs')).toHaveTextContent('BTC');
    const header = screen.getByTitle('BTC perp legs').parentElement!;
    expect(header).toHaveTextContent('Kraken');
    expect(header).toHaveTextContent('Hyperliquid');
    // The defining fact of this box, in the slot a card gives maturity.
    expect(header).toHaveTextContent('no rate locked');
    expect(screen.getByText('neutral ✓')).toBeInTheDocument();
    expect(screen.getByText(/net.*gross/)).toBeInTheDocument();
    // renderWithClient mounts TradeFlowProvider → the hold-button renders.
    expect(screen.getByRole('button', { name: 'Close both' })).toBeInTheDocument();
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

  it('sends the basis explicitly — the server still defaults to posted balance', async () => {
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
    // The UI default is now "margin used" while the SERVER default is still
    // posted balance, so the param has to be sent — omitting it would silently
    // price every position on the other basis.
    expect(urls[0]).toContain('capital=im');
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
          attribution: { source: 'unhedged', confidence: 'measured', pinned: false, unclaimed: true },
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

    // Destinations are option buttons inside the assign dialog now. Open the
    // first leg's dialog and read what it offers.
    fireEvent.click(screen.getAllByTitle(/click to assign|click to change/)[0]);
    const fixed = /^(This position|Nothing — leave it unassigned|Automatic)/;
    const options = screen
      .getAllByRole('button')
      .map((b) => b.textContent ?? '')
      .filter((t) => /^(long|short) /.test(t));
    expect(options.length).toBeGreaterThan(0);
    for (const label of options) {
      expect(label, `destination shown as a raw id: ${label}`).not.toMatch(/#|^[0-9a-f]{8}$/);
      expect(label).toMatch(/^(long|short) /);
      expect(label).not.toMatch(fixed);
    }
    // The two same-shaped positions are told apart by size, not left identical.
    expect(new Set(options).size, `ambiguous options: ${options}`).toBe(options.length);
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

    // The unhedged card renders after the two strategies, so its assign
    // trigger for the shared HYPERLIQUID leg is the last one.
    const triggers = screen.getAllByTitle(/click to assign|click to change/);
    fireEvent.click(triggers[triggers.length - 1]);
    fireEvent.click(screen.getByRole('button', { name: /Automatic/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem('crossex.partition.v1') ?? '{}');
      expect(stored[BOOK]).toBeUndefined();
    });
  });

  /** Every positionId currently written for this book. */
  const storedIds = (): string[] => [
    ...new Set(
      ((JSON.parse(localStorage.getItem('crossex.partition.v1') ?? '{}')[BOOK]?.rows ??
        []) as Array<{ positionId?: string }>)
        .map((r) => r.positionId)
        .filter((x): x is string => typeof x === 'string'),
    ),
  ];

  it('mints ONE id when a single Confirm carries both an entry and a size', async () => {
    /**
     * ⚠ ONE CONFIRM IS ONE CHANGE, however many facts it carries.
     *
     * `commit()` emits `entry` and then `assign` as two `applyAssertion`
     * calls. Each one froze the card by re-reading `attribution.pinned` off
     * the SAME rollup prop — still false, because no server response has
     * landed in between — so the second minted a second id and wrote a second
     * full row set. Every leg was then claimed by two ids at once, which the
     * server duly split down the middle into two phantom positions, with the
     * asserted entry hanging off whichever half went first.
     */
    track();
    mockPositions();
    mockStrategy(splitReturns());
    renderWithClient(<PositionsHome />);
    await screen.findByText('split unconfirmed');

    // Stay on this card (so the entry question is asked) and change BOTH.
    openAssign();
    fireEvent.change(screen.getByLabelText(/size for this position/), { target: { value: '175' } });
    fireEvent.change(screen.getByLabelText(/entry price for this position/), {
      target: { value: '2461' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(storedIds().length).toBeGreaterThan(0));
    // One card, one id — not two halves of one card.
    expect(new Set(storedIds()).size).toBe(1);
    // …and the entry belongs to the id that actually holds the legs.
    const overrides = JSON.parse(localStorage.getItem('crossex.entryOverride.v1') ?? '{}')[BOOK]
      ?.rows as Array<{ positionId: string }> | undefined;
    expect(overrides?.[0]?.positionId).toBe(storedIds()[0]);
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

    // The assign dialog opens from the leg's "Belongs to" cell; the amount is
    // the second question, under the destination.
    openAssign();
    fireEvent.change(screen.getByLabelText(/size for this position/), {
      target: { value: '175' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

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
              attribution: { source: 'unhedged', confidence: 'measured', pinned: false, unclaimed: true },
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
    openAssign();
    chooseAndConfirm(/Nothing — leave it unassigned/);
    await waitFor(() => expect(stored().length).toBeGreaterThan(0));
    const orphan = stored().find((r) => r.positionId === undefined);
    expect(orphan?.leg).toEqual({ kind: 'perp', symbol: HL });
    expectWireSafe();
  });

  it('MOVES a leg: the destination card is offered, and both ends get frozen', async () => {
    await start();
    // The BYBIT leg is the second row, so its trigger is the second one.
    openAssign('BYBIT');
    const sibling = screen
      .getAllByRole('button')
      .find((b) => /^(long|short) /.test(b.textContent ?? ''));
    expect(sibling, 'the sibling card is not offered as a destination').toBeDefined();
    fireEvent.click(sibling!);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
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
    openAssign();
    fireEvent.change(screen.getByLabelText(/size for this position/), {
      target: { value: '123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(stored().length).toBeGreaterThan(0));
    expect(stored().find((r) => r.leg.symbol === HL)?.qty).toBe(123);
    expectWireSafe();
  });

  it('TAKES THE WHOLE LEG: pressing All releases the sibling instead of no-opping', async () => {
    // A blanket claim means "all that no other position claims", so on a leg a
    // sibling already holds part of, All + Confirm drew only the leftover and
    // the assignment silently did nothing. Taking all of it must displace the
    // other claim.
    await start();
    openAssign();
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(stored().length).toBeGreaterThan(0));

    const claims = stored().filter((r) => r.leg.kind === 'perp' && r.leg.symbol === HL);
    // Exactly one card claims this leg now — the sibling's row is gone, not
    // left behind to be drawn first and clamp the new claim.
    expect(claims).toHaveLength(1);
    // And it is a STATED size, which outranks a blanket row at the solver.
    // Without the release this was a blanket row (`qty` undefined) that drew
    // only the leftover, which is why the assignment appeared to do nothing.
    expect(claims[0].qty).toBeGreaterThan(0);
    // Both cards were frozen — proof the sibling was actually touched, not
    // merely absent because nothing had been written yet.
    expect(new Set(stored().map((r) => r.positionId)).size).toBe(2);
    expectWireSafe();
  });

  it('UNDOES: "automatic" clears the leg and the entry', async () => {
    await start();
    openAssign();
    chooseAndConfirm(/Nothing — leave it unassigned/);
    await waitFor(() => expect(stored().some((r) => r.positionId === undefined)).toBe(true));

    // The server drops the orphaned leg from every card and returns it as a
    // one-leg position — whose own picker is the undo. Expand its row (fresh
    // toggles: the response replaced the cards) and choose the solver.
    await waitFor(() =>
      expect(
        screen.getAllByRole('button', { name: 'toggle details' }).length,
      ).toBeGreaterThan(0),
    );
    const triggers = await screen.findAllByTitle(/open on HYPERLIQUID/);
    fireEvent.click(triggers[triggers.length - 1]);
    chooseAndConfirm(/Automatic/);
    await waitFor(() => expect(stored().some((r) => r.leg.symbol === HL)).toBe(false));
    expectWireSafe();
  });

  it('sends every assertion to the server as ?partition=', async () => {
    const urls = await start();
    const before = urls.length;
    openAssign();
    chooseAndConfirm(/Nothing — leave it unassigned/);
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

    // Two Boros triggers — the hedged card's and the Boros-only card's. The
    // Boros-only one is the second; its dialog offers the hedged card.
    const triggers = screen.getAllByTitle(/open on BINANCE/);
    expect(triggers).toHaveLength(2);
    fireEvent.click(triggers[triggers.length - 1]);
    const dest = screen
      .getAllByRole('button')
      .find((b) => /^(long|short) /.test(b.textContent ?? ''));
    expect(dest, 'the hedged card is not offered as a destination').toBeDefined();
    fireEvent.click(dest!);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
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
          strategyId: 'ETH#BINANCE-HYPERLIQUID#0',
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
    const close = await screen.findByRole('button', { name: 'Close perp pair' });

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
    expect(screen.queryByRole('button', { name: 'Close perp pair' })).not.toBeInTheDocument();
  });
});


describe('PositionsHome → Boros prefill', () => {
  it('sends the card\'s MATURITY with the venues', async () => {
    /**
     * Regression: this path armed the Boros ticket with venue + base only.
     * A venue lists the same base at several expiries, so the two legs could
     * resolve to DIFFERENT maturities — and because each leg filters the other
     * by maturity, both then vanished from their own dropdowns and the ticket
     * rendered empty while state still held two real market ids.
     *
     * The sibling path (OpportunitiesPanel) was fixed first; this one was not,
     * which is the drift this test exists to pin.
     */
    const seen: Array<Record<string, unknown>> = [];
    function Probe() {
      const flow = useTradeFlow();
      const p = flow.borosOpenPrefill;
      if (p && !seen.some((x) => x.nonce === p.nonce)) seen.push({ ...p });
      return null;
    }

    // Comfortably in the future: the CTA is hidden once a card has matured.
    const MATURITY = Math.floor(Date.now() / 1000) + 30 * 86_400;
    const rollup = makeStrategyReturns({
      strategies: [
        {
          ...makeStrategyRollup(),
          maturity: MATURITY,
          legs: [
            makeStrategyLeg({ kind: 'perp', venue: 'GATE', side: 'LONG', notionalUsd: 1_000 }),
            makeStrategyLeg({ kind: 'perp', venue: 'OKX', side: 'SHORT', notionalUsd: 1_000 }),
          ],
          hedgeChecks: {
            borosMatchRatio: 0,
            perpMatchRatio: 1,
            borosVsPerpRatio: 0,
            fullyHedged: false,
          },
        },
      ],
    });
    localStorage.setItem(STRATEGY_STORAGE_KEY, JSON.stringify({ address: ADDR }));
    mockPositions();
    mockStrategy(rollup);

    renderWithClient(
      <TradeFlowProvider>
        <PositionsHome />
        <Probe />
      </TradeFlowProvider>,
    );

    const cta = await screen.findByRole('button', { name: /Open the Boros legs/ }, { timeout: 4000 });
    fireEvent.click(cta);

    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0].maturity).toBe(MATURITY);
  });
});

/**
 * A row names a LEG, so it does not go quiet when its position ends — it lies
 * in wait for the next position to use that symbol. `applyMembership` ignores
 * dangling rows per response and its comment says the client deletes them;
 * the client never did, so closing a hand-grouped position and re-opening the
 * same market reconstituted the dead one — its id, its grouping, its asserted
 * entries — with the solver locked out of legs the user never spoke about.
 */
describe('PositionsHome — assertions are forgotten when their legs close', () => {
  const track = () =>
    localStorage.setItem(STRATEGY_STORAGE_KEY, JSON.stringify({ address: ADDR, since: null }));

  const SAVED_AT = 1_700_000_000;

  /** One card holding Boros market 190 and its Hyperliquid perp. Nothing else
   * in this book is open — every other leg a row can name has closed. */
  const liveBook = () =>
    makeStrategyReturns({
      strategies: [
        makeStrategyRollup({
          legs: [
            makeStrategyLeg({ marketId: 190 }),
            makeStrategyLeg({
              kind: 'perp',
              side: 'SHORT',
              symbol: 'HYPERLIQUID_FUTURE_HYPE_USDC',
              notionalToken: 900,
              collateral: undefined,
              entryApr: undefined,
              markApr: undefined,
              floatingApr: undefined,
              maturity: undefined,
            }),
          ],
        }),
      ],
    });

  type StoredRow = { positionId?: string; leg: { kind: string; symbol?: string; marketId?: number } };
  const seed = (rows: StoredRow[], overrides: unknown[] = []) => {
    localStorage.setItem(
      'crossex.partition.v1',
      JSON.stringify({ [BOOK]: { rows, savedAtSec: SAVED_AT } }),
    );
    if (overrides.length) {
      localStorage.setItem(
        'crossex.entryOverride.v1',
        JSON.stringify({ [BOOK]: { rows: overrides, savedAtSec: SAVED_AT } }),
      );
    }
  };
  const storedRows = (): StoredRow[] =>
    JSON.parse(localStorage.getItem('crossex.partition.v1') ?? '{}')[BOOK]?.rows ?? [];
  const storedOverrides = (): Array<{ positionId: string }> =>
    JSON.parse(localStorage.getItem('crossex.entryOverride.v1') ?? '{}')[BOOK]?.rows ?? [];

  /** The strategy feed's own refetch control — the only way to give that feed
   * a second look inside a test without waiting out its 30s poll. */
  const lookAgain = () => fireEvent.click(screen.getByTitle('Refetch strategy data'));

  it('keeps a leg that is OPEN but on no card — an unpriced collateral zone', async () => {
    // ⚠ THE CARDS ARE NOT A CENSUS. `buildBorosLegs` drops a whole collateral
    // zone whose USD price cannot be resolved, warns, and still answers 200.
    // Reading "no card holds it" as "the position closed" deleted pins the
    // user cannot get back — so the prune counts positions, not cards.
    track();
    seed([
      { positionId: 'a3f1c8d2', leg: { kind: 'boros', marketId: 190 } },
      // Open, but on no card — its collateral zone could not be priced.
      { positionId: 'a3f1c8d2', leg: { kind: 'boros', marketId: 777 } },
      // Genuinely closed: on no card AND not a live position. Its disappearance
      // is what proves the prune actually ran, so 777 surviving means something.
      { positionId: 'a3f1c8d2', leg: { kind: 'boros', marketId: 999 } },
    ]);
    mockPositions();
    mockStrategy({ ...liveBook(), liveBorosMarketIds: [190, 777] });
    renderWithClient(<PositionsHome />);
    await screen.findByText('hedged ✓');

    lookAgain();
    await waitFor(() => expect(storedRows().map((r) => r.leg.marketId)).toEqual([190, 777]));
  });

  it('drops the rows of a closed Boros market, and keeps the open one', async () => {
    track();
    seed([
      { positionId: 'dead1234', leg: { kind: 'boros', marketId: 777 } },
      { positionId: 'a3f1c8d2', leg: { kind: 'boros', marketId: 190 } },
    ]);
    mockPositions();
    mockStrategy(liveBook());
    renderWithClient(<PositionsHome />);
    await screen.findByText('hedged ✓');

    // ⚠ ONE settled response is not evidence. Venues do answer 200 with an
    // empty list during an incident, and a prune has no undo — so the first
    // look only starts the count.
    expect(storedRows().map((r) => r.leg.marketId)).toEqual([777, 190]);

    lookAgain();
    await waitFor(() => expect(storedRows().map((r) => r.leg.marketId)).toEqual([190]));
  });

  it('will not let one feed delete the other feed\'s rows', async () => {
    // The perp feed polls at 4s and the strategy feed at 30s, so they
    // practically never settle on the same tick. A strategy refetch says
    // nothing about a perp symbol and must leave it alone — judging both
    // against whichever response happened to arrive would delete assertions
    // about legs nobody looked at.
    track();
    seed([
      { positionId: 'dead1234', leg: { kind: 'perp', symbol: 'GATE_FUTURE_ETH_USDT' } },
      { positionId: 'dead1234', leg: { kind: 'boros', marketId: 777 } },
    ]);
    mockPositions(); // the account holds no perps at all
    mockStrategy(liveBook());
    renderWithClient(<PositionsHome />);
    await screen.findByText('hedged ✓');

    lookAgain();
    await waitFor(() => expect(storedRows()).toHaveLength(1));
    expect(storedRows()[0].leg.symbol).toBe('GATE_FUTURE_ETH_USDT');
  });

  it('takes the asserted entry down with the claim that made it', async () => {
    // The worse half of the bug: a stale grouping shows on the card, a stale
    // entry is just a wrong number — re-armed the moment that position id and
    // leg coexist again, and conserved onto every other claim on the leg.
    track();
    seed(
      [{ positionId: 'dead1234', leg: { kind: 'boros', marketId: 777 } }],
      [{ positionId: 'dead1234', leg: { kind: 'boros', marketId: 777 }, value: 0.081 }],
    );
    mockPositions();
    mockStrategy(liveBook());
    renderWithClient(<PositionsHome />);
    await screen.findByText('hedged ✓');
    expect(storedOverrides()).toHaveLength(1);

    lookAgain();
    await waitFor(() => expect(storedRows()).toEqual([]));
    expect(storedOverrides()).toEqual([]);
  });

  it('stops sending a closed leg in ?partition=, so re-opening it starts clean', async () => {
    // What the user actually feels: the pins the server is asked to honour no
    // longer name the dead position, so the same market opening again is the
    // solver's to group, not the ghost's to reclaim.
    track();
    seed([{ positionId: 'dead1234', leg: { kind: 'boros', marketId: 777 } }]);
    mockPositions();
    const urls: string[] = [];
    server.use(
      http.get('/api/strategy/:address', ({ request }) => {
        urls.push(request.url);
        return HttpResponse.json(env(liveBook()));
      }),
    );
    renderWithClient(<PositionsHome />);
    await screen.findByText('hedged ✓');
    expect(urls.every((u) => u.includes('partition='))).toBe(true);

    lookAgain();
    await waitFor(() => expect(urls[urls.length - 1]).not.toContain('partition='));
  });
});

/**
 * A pinned claim is an ABSOLUTE number, and a venue position NETS.
 *
 * Closing a card's own share of a shared leg shrank the venue leg while the
 * row went on claiming the same size out of what was left — silently taken
 * from the cards sharing it. From the card it looked as though nothing had
 * happened: the size held still and only the denominator beside it moved.
 */
describe('PositionsHome — a close shrinks the claim it came from', () => {
  const SYMBOL = 'GATE_FUTURE_ETH_USDT';
  const PINNED = 'dead1234';
  /** The venue holds 0.058; this card states 0.01 of it. */
  const VENUE_QTY = 0.058;
  const MINE = 0.01;

  const track = () =>
    localStorage.setItem(STRATEGY_STORAGE_KEY, JSON.stringify({ address: ADDR, since: null }));

  const seedClaim = (qty: number = MINE) =>
    localStorage.setItem(
      'crossex.partition.v1',
      JSON.stringify({
        [BOOK]: {
          rows: [{ positionId: PINNED, leg: { kind: 'perp', symbol: SYMBOL }, qty }],
          savedAtSec: 1_700_000_000,
        },
      }),
    );

  const pinnedBook = () =>
    makeStrategyReturns({
      strategies: [
        makeStrategyRollup({
          strategyId: PINNED,
          attribution: { source: 'user', confidence: 'measured', pinned: true },
          legs: [
            makeStrategyLeg({ marketId: 190 }),
            makeStrategyLeg({
              kind: 'perp',
              venue: 'GATE',
              side: 'LONG',
              symbol: SYMBOL,
              notionalToken: MINE,
              share: MINE / VENUE_QTY, // a SHARE of the venue leg, not all of it
              collateral: undefined,
              entryApr: undefined,
              markApr: undefined,
              floatingApr: undefined,
              maturity: undefined,
            }),
          ],
        }),
      ],
    });

  const closeHandlers = () => [
    http.post('/api/preview', async ({ request }) => {
      const { actions } = (await request.json()) as { actions: ActionInput[] };
      const a = actions[0];
      return HttpResponse.json(
        env({
          previews: [
            previewFor(a, {
              side: 'SELL',
              qty: a.kind === 'close-position' && a.qty ? a.qty : String(VENUE_QTY),
              price: '2497.45',
              closing: { positionQty: String(VENUE_QTY), upnl: '3', mark: 2510 },
            }),
          ],
        }),
      );
    }),
    http.post('/api/deals', async ({ request }) =>
      HttpResponse.json(env({ id: ((await request.json()) as { id: string }).id }), { status: 202 }),
    ),
  ];

  const claims = (): Array<{ qty?: number }> =>
    JSON.parse(localStorage.getItem('crossex.partition.v1') ?? '{}')[BOOK]?.rows ?? [];

  /** Open the leg's close dialog and hold the confirm through. */
  const closeLeg = async () => {
    fireEvent.click(await screen.findByTitle(`Close ${SYMBOL}`));
    const confirm = await screen.findByRole('button', { name: 'Close now ▸' });
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.pointerDown(confirm);
  };

  const renderBook = async () => {
    track();
    mockPositions({
      positions: [makeCrossexPosition({ symbol: SYMBOL, positionQty: String(VENUE_QTY) })],
    });
    server.use(
      http.get('/api/strategy/:address', () => HttpResponse.json(env(pinnedBook()))),
      ...closeHandlers(),
    );
    renderWithClient(<PositionsHome />);
    await screen.findByTitle(`Close ${SYMBOL}`);
  };

  it('drops the claim when the card closes the whole of its own share', async () => {
    // The dialog opens pre-filled with this card's 0.01 — the reported case.
    // Afterwards the card holds none of that leg, and cannot drift back onto
    // it: the solver proposes nothing into a card that has rows of its own.
    seedClaim();
    await renderBook();
    await closeLeg();
    await waitFor(() => expect(claims()).toEqual([]));
  });

  it('reduces it by the amount closed when only part of the share goes', async () => {
    seedClaim();
    await renderBook();
    fireEvent.click(await screen.findByTitle(`Close ${SYMBOL}`));
    fireEvent.change(await screen.findByLabelText('Close qty'), { target: { value: '0.004' } });
    const confirm = await screen.findByRole('button', { name: 'Close now ▸' });
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.pointerDown(confirm);

    // The row survives — this card still holds the rest — carrying what is
    // left rather than the number it walked in with.
    await waitFor(() => expect(claims()[0]?.qty).toBeCloseTo(MINE - 0.004, 9));
    expect(claims()).toHaveLength(1);
  });

  it('leaves a blanket claim alone — "all of it" already follows the venue', async () => {
    // There is no number to decrement. Writing one would turn a claim that
    // re-derives itself into a constant that goes stale on the next close.
    localStorage.setItem(
      'crossex.partition.v1',
      JSON.stringify({
        [BOOK]: {
          rows: [{ positionId: PINNED, leg: { kind: 'perp', symbol: SYMBOL } }],
          savedAtSec: 1_700_000_000,
        },
      }),
    );
    await renderBook();
    await closeLeg();
    await waitFor(() => expect(claims()).toHaveLength(1));
    expect(claims()[0].qty).toBeUndefined();
  });
});

/**
 * "Automatic" is scoped to the card it was pressed on.
 *
 * A shared venue leg is on more than one card. Choosing Automatic on the
 * unclaimed remainder used to delete EVERY row naming that leg — including
 * the pin a hand-grouped card held on it, a card the user never touched — and
 * the solver, now seeing the whole venue leg free, swept all of it into one
 * position. The pinned card silently lost its leg.
 */
describe('PositionsHome — Automatic forgets only this card', () => {
  const PINNED = 'a1b2c3d4';
  const MARKET = 190;
  const MINE = 0.01;
  const REST = 0.04;

  const track = () =>
    localStorage.setItem(STRATEGY_STORAGE_KEY, JSON.stringify({ address: ADDR, since: null }));

  const borosLeg = (notionalToken: number, share: number) =>
    makeStrategyLeg({
      marketId: MARKET,
      venue: 'HYPERLIQUID',
      side: 'SHORT' as const,
      notionalToken,
      share,
    });

  /** One venue leg of 0.05, split: 0.01 pinned to a hand-grouped card, 0.04
   * left over as its own unhedged card. */
  const sharedBook = () =>
    makeStrategyReturns({
      strategies: [
        makeStrategyRollup({
          strategyId: PINNED,
          attribution: { source: 'user', confidence: 'measured', pinned: true },
          legs: [
            makeStrategyLeg({
              kind: 'perp',
              venue: 'BINANCE',
              side: 'LONG',
              symbol: 'BINANCE_FUTURE_HYPE_USDT',
              notionalToken: 0.05,
              collateral: undefined,
              entryApr: undefined,
              markApr: undefined,
              floatingApr: undefined,
              maturity: undefined,
            }),
            borosLeg(MINE, MINE / (MINE + REST)),
          ],
        }),
        makeStrategyRollup({
          strategyId: 'HYPE#unhedged:190',
          attribution: { source: 'unhedged', confidence: 'measured', pinned: false, unclaimed: true },
          hedge: 'unhedged',
          legs: [borosLeg(REST, REST / (MINE + REST))],
        }),
      ],
    });

  const seed = (rows: unknown[]) =>
    localStorage.setItem(
      'crossex.partition.v1',
      JSON.stringify({ [BOOK]: { rows, savedAtSec: 1_700_000_000 } }),
    );
  const rowsNow = (): Array<{ positionId?: string; qty?: number }> =>
    JSON.parse(localStorage.getItem('crossex.partition.v1') ?? '{}')[BOOK]?.rows ?? [];

  /** Automatic on the LAST assign trigger — the unhedged card renders after
   * the pinned one, and holds only the Boros leg. */
  const automaticOnRemainder = async () => {
    for (const t of screen.getAllByRole('button', { name: 'toggle details' })) fireEvent.click(t);
    const triggers = screen.getAllByTitle(/click to assign|click to change/);
    fireEvent.click(triggers[triggers.length - 1]);
    fireEvent.click(screen.getByRole('button', { name: /Automatic/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  };

  it('hands the remainder back without stripping the pin on the same leg', async () => {
    track();
    seed([
      { positionId: PINNED, leg: { kind: 'boros', marketId: MARKET }, qty: MINE },
      { leg: { kind: 'boros', marketId: MARKET }, qty: REST },
    ]);
    mockPositions();
    mockStrategy(sharedBook());
    renderWithClient(<PositionsHome />);
    await screen.findByText('grouped by you');

    await automaticOnRemainder();

    // The orphan row goes — that is what Automatic was asked for…
    await waitFor(() => expect(rowsNow().filter((r) => r.positionId === undefined)).toEqual([]));
    // …and the hand-grouped card keeps its 0.01. It was never in the question.
    expect(rowsNow()).toEqual([
      { positionId: PINNED, leg: { kind: 'boros', marketId: MARKET }, qty: MINE },
    ]);
  });

  /**
   * ⚠ `unclaimed`, NOT `source === 'unhedged'`.
   *
   * `source` answers how a grouping was arrived at, and reusing it here
   * collided both ways: a solver tranche on a coin with no Boros ALSO reports
   * 'unhedged' (the chip means "no rate is locked against this"), while the
   * Boros remainder card reports 'boros-only'/'merged'.
   */
  it('leaves a neighbour\'s detachment alone when pressed on a solver tranche', async () => {
    // `ETH#BINANCE-HYPERLIQUID#0` is what the solver emits for a coin with no
    // Boros cohort — reported 'unhedged' because nothing locks a rate against
    // it, but it asserted nothing and owns no rows. Automatic there is a
    // statement about a card that never claimed the leg.
    track();
    seed([{ leg: { kind: 'boros', marketId: MARKET }, qty: REST }]);
    mockPositions();
    mockStrategy(
      makeStrategyReturns({
        strategies: [
          makeStrategyRollup({
            strategyId: 'HYPE#BINANCE-HYPERLIQUID#0',
            attribution: { source: 'unhedged', confidence: 'measured', pinned: false },
            hedge: 'unhedged',
            legs: [borosLeg(MINE, MINE / (MINE + REST))],
          }),
        ],
        liveBorosMarketIds: [MARKET],
      }),
    );
    renderWithClient(<PositionsHome />);
    await screen.findAllByTitle(/click to assign|click to change/);
    await automaticOnRemainder();

    // The orphan row is somebody else's detachment and must survive.
    await waitFor(() => expect(rowsNow()).toHaveLength(1));
    expect(rowsNow()[0].positionId).toBeUndefined();
  });

  it('un-detaches from a Boros remainder card, which reports neither pinned nor unhedged', async () => {
    // The unowned Boros card carries source 'boros-only' / 'merged'. Keying
    // off 'unhedged' made Automatic a silent no-op here — the one card family
    // where it genuinely means "forget my detachment".
    track();
    seed([{ leg: { kind: 'boros', marketId: MARKET }, qty: REST }]);
    mockPositions();
    mockStrategy(
      makeStrategyReturns({
        strategies: [
          makeStrategyRollup({
            strategyId: 'HYPE@boros-remainder',
            attribution: {
              source: 'merged',
              confidence: 'measured',
              pinned: false,
              unclaimed: true,
            },
            hedge: 'unhedged',
            legs: [borosLeg(REST, 1)],
          }),
        ],
        liveBorosMarketIds: [MARKET],
      }),
    );
    renderWithClient(<PositionsHome />);
    await screen.findAllByTitle(/click to assign|click to change/);
    await automaticOnRemainder();

    await waitFor(() => expect(rowsNow()).toEqual([]));
  });

  it('still sends the pin to the server, so the card does not lose the leg', async () => {
    track();
    seed([
      { positionId: PINNED, leg: { kind: 'boros', marketId: MARKET }, qty: MINE },
      { leg: { kind: 'boros', marketId: MARKET }, qty: REST },
    ]);
    mockPositions();
    const urls: string[] = [];
    server.use(
      http.get('/api/strategy/:address', ({ request }) => {
        urls.push(request.url);
        return HttpResponse.json(env(sharedBook()));
      }),
    );
    renderWithClient(<PositionsHome />);
    await screen.findByText('grouped by you');

    await automaticOnRemainder();

    // Every request after the change still carries a partition — an empty one
    // would mean the whole leg went back to the solver, which is the bug.
    await waitFor(() => expect(urls.length).toBeGreaterThan(1));
    expect(urls[urls.length - 1]).toContain('partition=');
  });
});

// ---------------------------------------------------------------------------
// "Open the perp legs" → the wizard, at the hedge step
// ---------------------------------------------------------------------------

describe('PositionsHome — resuming a half-open position', () => {
  /** A rate-locked position with NO perp legs — what the resume cue fires on. */
  const borosOnly = (over: Partial<StrategyRollup> = {}) =>
    makeStrategyRollup({
      strategyId: 'HYPE@boros-only',
      legs: makeStrategyRollup().legs.filter((l) => l.kind === 'boros'),
      hedgeChecks: { borosMatchRatio: 1, perpMatchRatio: 0, borosVsPerpRatio: 0, fullyHedged: false },
      ...over,
    });

  /** App mounts the wizard beside the panel; these tests need the same pair. */
  const mountHome = () =>
    renderWithClient(
      <>
        <PositionsHome />
        <StrategyWizard />
      </>,
    );

  const openCue = async () => {
    const cta = await screen.findByRole('button', { name: /Open the perp legs/ });
    await userEvent.click(cta);
  };

  it('opens the WIZARD at step 2 — not the bare ticket', async () => {
    localStorage.setItem(STRATEGY_STORAGE_KEY, JSON.stringify({ address: ADDR }));
    mockPositions();
    mockStrategy(makeStrategyReturns({ strategies: [borosOnly()] }));
    mountHome();
    await openCue();

    // The wizard's own framing: it is FINISHING, not opening, and step 1 is
    // already checked off.
    expect(await screen.findByText('Finish this strategy')).toBeInTheDocument();
    expect(screen.getByText('Lock the rate')).toBeInTheDocument();
    expect(screen.getByText('Hedge the perps')).toBeInTheDocument();
    // The Boros ticket is NOT mounted — those legs already exist.
    expect(screen.queryByRole('radiogroup', { name: 'Boros ticket mode' })).not.toBeInTheDocument();
  });

  it('leaving without hedging warns — the rate is on and naked', async () => {
    /**
     * The guard used to test only whether THIS wizard had locked a rate, so a
     * resume (which arrives with one already locked) closed silently — the one
     * case where the exposure is guaranteed to exist.
     */
    localStorage.setItem(STRATEGY_STORAGE_KEY, JSON.stringify({ address: ADDR }));
    mockPositions();
    mockStrategy(makeStrategyReturns({ strategies: [borosOnly()] }));
    mountHome();
    await openCue();
    await screen.findByText('Finish this strategy');

    await userEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(await screen.findByText(/until the perp legs open you hold directional exposure/)).toBeInTheDocument();
  });

  it('an UNEVEN book sizes the hedge off the larger Boros side, never the sum', async () => {
    /**
     * ⚠ The mis-hedge this guards: summing the two sides would arm the perps
     * at double the exposure. A lopsided book must still hedge the side that
     * actually carries risk.
     */
    localStorage.setItem(STRATEGY_STORAGE_KEY, JSON.stringify({ address: ADDR }));
    mockPositions();
    const legs = makeStrategyRollup().legs.filter((l) => l.kind === 'boros');
    const uneven = legs.map((l, i) =>
      i === 0 ? { ...l, notionalUsd: 40_000, notionalToken: 400 } : { ...l, notionalUsd: 10_000, notionalToken: 100 },
    );
    mockStrategy(makeStrategyReturns({ strategies: [borosOnly({ legs: uneven })] }));
    mountHome();
    await openCue();

    // The perp box lands on the LARGER side (40,000), not 50,000.
    const size = (await screen.findByLabelText(/Size per leg/)) as HTMLInputElement;
    expect(size.value).toBe('40000');
  });

  it('a PARTIAL top-up stays on the bare ticket — no wizard', async () => {
    /**
     * "Complete the hedge" evens up one leg inside a position that already
     * exists. Wrapping that in "step 2 of 2" would narrate a strategy the user
     * is not opening — and the wizard would re-arm at the FULL size, not the
     * gap.
     */
    localStorage.setItem(STRATEGY_STORAGE_KEY, JSON.stringify({ address: ADDR }));
    mockPositions();
    // A partially hedged book: both kinds present, sizes mismatched.
    const all = makeStrategyRollup().legs;
    const partial = all.map((l) =>
      l.kind === 'perp' ? { ...l, notionalUsd: l.notionalUsd / 4, notionalToken: (l.notionalToken ?? 0) / 4 } : l,
    );
    mockStrategy(
      makeStrategyReturns({
        strategies: [
          makeStrategyRollup({
            legs: partial,
            hedgeChecks: { borosMatchRatio: 1, perpMatchRatio: 0.25, borosVsPerpRatio: 0.25, fullyHedged: false },
          }),
        ],
      }),
    );
    mountHome();

    const cta = await screen.findByRole('button', { name: /Complete the hedge/ });
    await userEvent.click(cta);
    // No wizard framing anywhere.
    expect(screen.queryByText('Finish this strategy')).not.toBeInTheDocument();
    expect(screen.queryByText('Open this strategy')).not.toBeInTheDocument();
  });
});
