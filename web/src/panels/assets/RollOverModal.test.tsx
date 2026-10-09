/**
 * The roll-over as ONE atomic batch: close both rate legs at the old maturity
 * and open both at the new one, all-or-nothing. These pin the single execute
 * call and the four distinct ids it carries, the three verdicts read back
 * (rolled / refused / unconfirmed), that a retry re-sends the SAME ids, the
 * replay note, and that the server's gate — blockers, warnings and margin —
 * drives the review. The pick page still prices its options over
 * /boros/pair/simulate, so those mocks stay.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AssetBorosOpen, AssetGroup, AssetPerpOpen, BorosRollGate } from '../../api/types';
import { server } from '../../test/server';
import { renderWithClient } from '../../test/utils';
import { STRATEGY_STORAGE_KEY } from '../HomeControls';
import { RollOverModal } from './AssetCard';
import { deriveAsset } from './assetModel';

const ADDRESS = '0x1111111111111111111111111111111111111111';
const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);
const OLD = NOW + 8 * DAY;
const NEW = NOW + 45 * DAY;
const GATE_OLD = 1;
const HL_OLD = 2;
const GATE_NEW = 11;
const HL_NEW = 12;

const env = <T,>(data: T) => ({ ok: true, data, meta: { ts: Date.now() } });

const perp = (venue: string, side: 'LONG' | 'SHORT'): AssetPerpOpen => ({
  symbol: `${venue}_FUTURE_ETH_USDT`,
  venue,
  side,
  qty: 100,
  notionalUsd: 250_000,
  entryPrice: 2500,
  markPrice: 2500,
  leverage: 10,
  upnlUsd: 0,
  fundingUsd: 0,
  feesUsd: 0,
  imUsd: 25_000,
  openedAt: NOW - 10 * DAY,
});
const yu = (marketId: number, venue: string, side: 'LONG' | 'SHORT'): AssetBorosOpen => ({
  spreadVenues: null,
  marketId,
  venue,
  side,
  sizeToken: 100,
  collateral: 'ETH',
  notionalUsd: 250_000,
  entryApr: side === 'LONG' ? 0.04 : 0.08,
  markApr: 0.06,
  floatingApr: 0.07,
  settleUsd: 0,
  mtmUsd: 0,
  imUsd: 10_000,
  maturity: OLD,
});
const group: AssetGroup = {
  base: 'ETH',
  supported: true,
  priceUsd: 2500,
  earliestSec: NOW - 10 * DAY,
  perpOpen: [perp('GATE', 'LONG'), perp('HYPERLIQUID', 'SHORT')],
  perpClosed: [],
  borosOpen: [yu(GATE_OLD, 'GATE', 'LONG'), yu(HL_OLD, 'HYPERLIQUID', 'SHORT')],
  borosHistory: [],
};
const pair = deriveAsset(group, {}, 0, NOW).pairs[0];

const marketRow = (marketId: number, venue: string, maturity: number) => ({
  marketId,
  name: `${venue} ETH`,
  venue,
  base: 'ETH',
  tokenId: 3,
  collateral: 'ETH',
  maturity,
  midApr: 0.06,
  markApr: 0.06,
  spreadVenues: null as [string, string] | null,
  isolatedOnly: false,
  onIsolatedMargin: false,
  isolatedHasPositionOrOrders: false,
  currentSize: 0,
  collateralPriceUsd: 2500,
});
const SPREAD_NEW = 59;
let spreadListed = false;
let spreadCloseOnly = false;
const context = () => ({
  markets: [
    marketRow(GATE_OLD, 'Gate', OLD),
    marketRow(HL_OLD, 'Hyperliquid', OLD),
    marketRow(GATE_NEW, 'Gate', NEW),
    marketRow(HL_NEW, 'Hyperliquid', NEW),
  ],
  spreadMarkets: spreadListed ? [{ ...marketRow(SPREAD_NEW, 'HL-Gate', NEW), spreadVenues: ['HYPERLIQUID', 'GATE'] as [string, string], closeOnly: spreadCloseOnly }] : [],
  crossByToken: [{ tokenId: 3, available: 1_000 }],
  isolatedByMarket: [],
  defaultSlippageApr: 0.0025,
  maxSlippageApr: 0.1,
});
const venueOf = (marketId: number) => (marketId === GATE_OLD || marketId === GATE_NEW ? 'Gate' : 'Hyperliquid');
/**
 * Each leg's book, as the depth ladder the server quotes: `fitSize` sits 0.1%
 * from mid (inside the 1% seed), `deepSize` more sits 1.3% out — reachable
 * only by widening. Unset (an older server) quotes no ladder and leaves the
 * modal on the whole position. `bandApr` is the venue's rate band, as the
 * widest tolerance it allows; unset = no cap reported.
 */
let fitSize: number | undefined;
let deepSize = 60;
let bandApr: number | undefined;
const simLeg = (marketId: number, direction: 'long' | 'short', size: number, intent: string) => ({
  marketId,
  marketName: `${venueOf(marketId)} ETH ${marketId >= GATE_NEW ? '30 Oct' : '25 Sep'} 2026`,
  venue: venueOf(marketId),
  base: 'ETH',
  direction,
  execApr: 0.06,
  worstApr: 0.06,
  estFillSize: size,
  shortfallSize: 0,
  bookStatus: 'ok',
  marginRequired: 5,
  slippageApr: 0.0025,
  depth: fitSize === undefined ? undefined : [[0.001, fitSize], [0.013, fitSize + deepSize]],
  maxToleranceApr: bandApr ?? null,
  /**
   * A CLOSE ends flat (the exit); an OPEN adds to what the new markets
   * already hold (the re-entry). The open case matters: Boros nets to one
   * position per market, so `marginRequired` is quoted on the RESULTING
   * size, and the roll must only be charged the share it opens.
   */
  sizing:
    intent === 'close'
      ? { currentSize: direction === 'short' ? 100 : -100, deltaSize: size, resultingSize: 0, opposing: true, flips: false, clampedToClose: false, orderSide: direction }
      : {
          currentSize: direction === 'short' ? -size : size,
          deltaSize: direction === 'short' ? -size : size,
          resultingSize: direction === 'short' ? -size * 2 : size * 2,
          opposing: false,
          flips: false,
          clampedToClose: false,
          orderSide: direction,
        },
});
type StepInput = { legs: Leg[] };
const simulation = (body: StepInput & { intent: string }) => ({
  legs: body.legs.map((l) => simLeg(l.marketId, l.direction, l.size, body.intent)),
  receiveLeg: body.legs.length === 2 ? 1 : 0,
  estSpreadApr: 0.04,
  worstSpreadApr: 0.035,
  costToCrossSize: 0.02,
  feeDragApr: 0.003,
  marginRequiredTotal: 8,
  hedgedSize: body.legs[0].size,
  unhedgedSize: 0,
  collateral: 'ETH',
  collateralPriceUsd: 2500,
  secondsToMaturity: 45 * DAY,
  reasons: [],
});
/** A clean pair gate — the exit/entry gates the server nests under each roll
 * step. The roll's own gate is the one that matters, so these stay empty. */
const pairGate = () => ({ blockers: [], warnings: [], requiresAcknowledgement: false, opposingLegs: [] });
/** The roll gate: the whole margin/eligibility verdict. `margin` is comfortably
 * funded by default (1,000 ETH available, 5 needed). */
const rollGate = (o: Partial<ReturnType<typeof rollGateBase>> = {}) => ({ ...rollGateBase(), ...o });
const rollGateBase = () => ({
  blockers: [] as Array<{ code: string; message: string; step?: string; leg?: string; marketId?: number }>,
  warnings: [] as string[],
  margin: { need: 5, availableBefore: 895, availableAfter: 900, shortfall: 0 } as BorosRollGate['margin'],
});

type Leg = { marketId: number; direction: 'long' | 'short'; slippageApr: number; size: number; clientOrderId?: string };
type Step = { legs: Leg[] };
type RollBody = {
  address: string;
  exit: Step;
  entry: Step;
  opposingAcknowledged?: boolean;
  clientOrderIds: Record<string, string>;
};
type LegFailure = { code: string; message: string; cause?: 'this-leg' | 'batch' } | null;
const legFill = (marketId: number, direction: string, filledSize: number, shortfallSize = 0, failure: LegFailure = null) => ({
  marketId,
  direction,
  filledSize,
  shortfallSize,
  execApr: filledSize > 0 ? 0.06 : null,
  feeSize: filledSize > 0 ? 0.01 : null,
  failure,
});
type RollLegKey = string;
const legsOf = (body: RollBody, make: (key: RollLegKey, leg: Leg, size: number) => ReturnType<typeof legFill>) =>
  Object.fromEntries(
    (['exit', 'entry'] as const).flatMap((step) =>
      body[step].legs.map((l) => [`${step}:${l.marketId}`, make(`${step}:${l.marketId}`, l, l.size)]),
    ),
  );
const rolledResult = (body: RollBody) => ({
  status: 'rolled',
  legs: legsOf(body, (_k, leg, size) => legFill(leg.marketId, leg.direction, size)),
  reason: null,
  rolledSize: body.exit.legs[0].size,
});
const refusedResult = (body: RollBody, named: RollLegKey, code: string, message: string) => ({
  status: 'refused',
  legs: legsOf(body, (k, leg, size) => legFill(leg.marketId, leg.direction, 0, size, { code, message, cause: k === named ? 'this-leg' : 'batch' })),
  reason: { code, message, leg: named },
  rolledSize: 0,
});
const unknownResult = (body: RollBody) => {
  const message = 'the venue never answered';
  return {
    status: 'unknown',
    legs: legsOf(body, (_k, leg, size) => legFill(leg.marketId, leg.direction, 0, size, { code: 'unknown', message })),
    reason: { code: 'unknown', message, leg: null },
    rolledSize: 0,
  };
};
const executeBody = (body: RollBody, result: unknown, replayed = false) =>
  env({
    result,
    exit: { simulation: simulation({ ...body.exit, intent: 'close' }), gate: pairGate() },
    entry: { simulation: simulation({ ...body.entry, intent: 'open' }), gate: pairGate() },
    gate: rollGate(),
    replayed,
  });
const okRoll = (body: RollBody) => HttpResponse.json(executeBody(body, rolledResult(body)));

type PairSimBody = { intent: string; legs: Leg[] };

function install(
  opts: {
    onRollExecute?: (body: RollBody, n: number) => Response | Promise<Response>;
    onRollSimulate?: (body: RollBody) => void;
    onPairSimulate?: (body: PairSimBody) => void;
    /** Override the roll gate the review reads (blockers, warnings, margin). */
    gate?: () => ReturnType<typeof rollGate>;
    /** Held roll simulations wait on this before answering — for the
     * "confirm stays disabled until a fresh quote lands" case. */
    rollSimGate?: Promise<void>;
    gasBalanceUsd?: number;
  } = {},
) {
  let n = 0;
  const onRollExecute = opts.onRollExecute ?? ((body) => okRoll(body));
  server.use(
    http.get('/api/boros/agent', () =>
      HttpResponse.json(env({ configured: true, root: ADDRESS, rootMasked: '0x1111…1111', accountId: 0, expiry: null, expired: false, canProvision: true })),
    ),
    http.get('/api/boros/pair/context', () => HttpResponse.json(env(context()))),
    http.post('/api/boros/pair/simulate', async ({ request }) => {
      const body = (await request.json()) as PairSimBody;
      opts.onPairSimulate?.(body);
      return HttpResponse.json(
        env({
          simulation: simulation(body),
          gate: pairGate(),
          eligibility: { eligible: true, code: null, reason: null },
          simulatedAtMs: Date.now(),
          gasBalanceUsd: opts.gasBalanceUsd ?? 5,
        }),
      );
    }),
    http.post('/api/boros/roll/simulate', async ({ request }) => {
      const body = (await request.json()) as RollBody;
      opts.onRollSimulate?.(body);
      if (opts.rollSimGate) await opts.rollSimGate;
      return HttpResponse.json(
        env({
          exit: { simulation: simulation({ ...body.exit, intent: 'close' }), gate: pairGate() },
          entry: { simulation: simulation({ ...body.entry, intent: 'open' }), gate: pairGate() },
          gate: opts.gate ? opts.gate() : rollGate(),
          simulatedAtMs: Date.now(),
          gasBalanceUsd: opts.gasBalanceUsd ?? 5,
        }),
      );
    }),
    http.post('/api/boros/roll/execute', async ({ request }) => {
      n += 1;
      return onRollExecute((await request.json()) as RollBody, n);
    }),
  );
}

async function armAndHold(user: ReturnType<typeof userEvent.setup>) {
  renderWithClient(<RollOverModal pair={pair} base="ETH" nowSec={NOW} onClose={() => {}} />);
  const dialog = await screen.findByRole('dialog');
  // PICK: the one target maturity is auto-selected; "Roll over →" opens the
  // review once the venue context is in.
  const next = await within(dialog).findByRole('button', { name: 'Roll over' });
  await waitFor(() => expect(next).not.toBeDisabled(), { timeout: 4_000 });
  await user.click(next);
  // REVIEW: the hold unlocks once the roll is quoted and the agent is live.
  const confirm = await within(dialog).findByRole('button', { name: 'Roll over' });
  await waitFor(() => expect(confirm).not.toBeDisabled(), { timeout: 4_000 });
  await user.pointer({ keys: '[MouseLeft>]', target: confirm });
  return dialog;
}

beforeEach(() => {
  localStorage.setItem(STRATEGY_STORAGE_KEY, JSON.stringify({ address: ADDRESS }));
  fitSize = undefined;
  deepSize = 60;
  bandApr = undefined;
  spreadListed = false;
  spreadCloseOnly = false;
});

describe('RollOverModal — the pick page', () => {
  it('defaults the size to what fills at the WIDEST tolerance the roll may carry, LESS a 5% buffer; the shortcuts override it', async () => {
    const user = userEvent.setup();
    fitSize = 40;
    deepSize = 50; // the whole side holds 90
    install();
    renderWithClient(<RollOverModal pair={pair} base="ETH" nowSec={NOW} onClose={() => {}} />);
    const dialog = await screen.findByRole('dialog');
    const box = within(dialog).getByLabelText('Size to roll (ETH)');
    // Whole position until the quotes land, then the books' own limit. Only
    // 40 fills inside the 1% seed, but the modal widens the tolerance for any
    // size the band reaches, so the level 1.3% out counts too: 90. A size ON
    // the limit is one cancelled lot from a refused batch, so 5% is kept
    // back: 85.5. Sizing at the seed defaulted a live 870 ETH pair to 0.0095
    // ETH off one stray level (his catch 2026-09-23).
    await waitFor(() => expect(box).toHaveValue('85.5'), { timeout: 4_000 });
    expect(within(dialog).getByText('86%')).toBeInTheDocument();
    // The size speaks for itself: no sentence explaining it (his call 2026-09-20).
    expect(within(dialog).queryByRole('note')).not.toBeInTheDocument();

    // The four grips: each sets the share and counts as the trader's choice,
    // so the default's note goes and no later quote moves the size back.
    const shortcuts = within(dialog).getByRole('group', { name: 'Share shortcuts' });
    expect(within(shortcuts).getAllByRole('button').map((b) => b.textContent)).toEqual(['25%', '50%', '75%', '100%']);
    await user.click(within(shortcuts).getByRole('button', { name: '75%' }));
    expect(box).toHaveValue('75');
    await user.click(within(shortcuts).getByRole('button', { name: '25%' }));
    expect(box).toHaveValue('25');
    await user.click(within(shortcuts).getByRole('button', { name: '100%' }));
    expect(box).toHaveValue('100');
  });

  it('the buffer never shaves a position the books hold with room to spare', async () => {
    // 106 inside the seed: 106 × 0.95 = 100.7 still covers the 100 held.
    fitSize = 106;
    install();
    renderWithClient(<RollOverModal pair={pair} base="ETH" nowSec={NOW} onClose={() => {}} />);
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('Locked spread', undefined, { timeout: 4_000 });
    await new Promise((r) => setTimeout(r, 300));
    expect(within(dialog).getByLabelText('Size to roll (ETH)')).toHaveValue('100');
  });

  it('sizing up past the seed WIDENS the tolerance silently, and the review opens on it', async () => {
    const user = userEvent.setup();
    const pairSims: PairSimBody[] = [];
    const rollSims: RollBody[] = [];
    fitSize = 40;
    install({ onPairSimulate: (b) => pairSims.push(b), onRollSimulate: (b) => rollSims.push(b) });
    renderWithClient(<RollOverModal pair={pair} base="ETH" nowSec={NOW} onClose={() => {}} />);
    const dialog = await screen.findByRole('dialog');
    const box = within(dialog).getByLabelText('Size to roll (ETH)');
    // The whole 100 sits inside the band (40 + 60), so it is the default.
    await waitFor(() => expect(box).toHaveValue('95'), { timeout: 4_000 });

    // 75 needs the level 1.3% out: 1.3% × 1.1 headroom = 1.43%, on BOTH
    // batches (both books are this ladder). No warning — it is just done.
    await user.click(within(dialog).getByRole('button', { name: '75%' }));
    await waitFor(() => {
      const last = pairSims.at(-1)!;
      expect(last.legs[0].size).toBe(75);
      expect(last.legs[0].slippageApr).toBeCloseTo(0.0143, 9);
      expect(last.legs[1].slippageApr).toBeCloseTo(0.0143, 9);
    }, { timeout: 4_000 });
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();

    // The review inherits it rather than falling back to the 1% seed.
    await user.click(within(dialog).getByRole('button', { name: 'Roll over' }));
    await waitFor(() => {
      const last = rollSims.at(-1)!;
      expect(last.exit.legs[0].slippageApr).toBeCloseTo(0.0143, 9);
      expect(last.entry.legs[1].slippageApr).toBeCloseTo(0.0143, 9);
    }, { timeout: 4_000 });
  });

  it('warns when the book does not hold the size, and offers the most that rolls', async () => {
    const user = userEvent.setup();
    fitSize = 40;
    deepSize = 30; // the whole side holds 70
    install();
    renderWithClient(<RollOverModal pair={pair} base="ETH" nowSec={NOW} onClose={() => {}} />);
    const dialog = await screen.findByRole('dialog');
    const box = within(dialog).getByLabelText('Size to roll (ETH)');
    // The default already sits inside what the book holds: no warning.
    await waitFor(() => expect(box).toHaveValue('66.5'), { timeout: 4_000 });
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: '75%' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent(/Size too big: .+ does not hold this much liquidity\. The most that rolls now is 70 ETH\./);
    // One click takes the most that rolls, less the buffer: 70 × 0.95.
    await user.click(within(alert).getByRole('button', { name: /Roll 66\.5 ETH instead/ }));
    expect(box).toHaveValue('66.5');
    await waitFor(() => expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument());
  });

  it("warns when the size only fills past the venue's rate limit", async () => {
    const user = userEvent.setup();
    fitSize = 40;
    bandApr = 0.012; // the level 1.3% out is past the band
    install();
    renderWithClient(<RollOverModal pair={pair} base="ETH" nowSec={NOW} onClose={() => {}} />);
    const dialog = await screen.findByRole('dialog');
    const box = within(dialog).getByLabelText('Size to roll (ETH)');
    // Past the band nothing more counts: the default is what fills inside
    // it, 40, less the buffer.
    await waitFor(() => expect(box).toHaveValue('38'), { timeout: 4_000 });
    await user.click(within(dialog).getByRole('button', { name: '75%' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      /Size too big: .+ only fills it past the venue's rate limit\. The most that rolls now is 40 ETH\./,
    );
  });

  it('with no ladder reported, or one that holds the position many times over, the whole position is the default', async () => {
    fitSize = 500;
    install();
    renderWithClient(<RollOverModal pair={pair} base="ETH" nowSec={NOW} onClose={() => {}} />);
    const dialog = await screen.findByRole('dialog');
    // Wait for the option to be priced (its Locked spread line), then a beat.
    await within(dialog).findByText('Locked spread', undefined, { timeout: 4_000 });
    await new Promise((r) => setTimeout(r, 300));
    expect(within(dialog).getByLabelText('Size to roll (ETH)')).toHaveValue('100');
  });

  it('prices the options at each batch\'s own seeded tolerance, not the server\'s flat default', async () => {
    const sims: PairSimBody[] = [];
    install({ onPairSimulate: (b) => sims.push(b) });
    renderWithClient(<RollOverModal pair={pair} base="ETH" nowSec={NOW} onClose={() => {}} />);
    await screen.findByRole('dialog');
    await waitFor(() => expect(sims.filter((s) => s.intent === 'open').length).toBeGreaterThan(0), { timeout: 4_000 });
    // These fixture markets report no deviation cap, so the seed is the 1%
    // fallback — which is NOT the context's 0.25% default.
    for (const s of sims) {
      expect(s.legs[0].slippageApr).toBeCloseTo(0.01, 9);
      expect(s.legs[1].slippageApr).toBeCloseTo(0.01, 9);
    }
  });
});

describe('RollOverModal — spread target', () => {
  it('spread target: the next maturity with a spread rolls into the one spread market', async () => {
    spreadListed = true;
    const user = userEvent.setup();
    const entries: PairSimBody[] = [];
    const sent: RollBody[] = [];
    install({
      onPairSimulate: (b) => {
        if (b.intent === 'open') entries.push(b);
      },
      onRollExecute: (body) => {
        sent.push(body);
        return okRoll(body);
      },
    });
    renderWithClient(<RollOverModal pair={pair} base="ETH" nowSec={NOW} onClose={() => {}} />);
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(entries.length).toBeGreaterThan(0), { timeout: 4_000 });
    expect(entries.at(-1)!.legs).toEqual([expect.objectContaining({ marketId: SPREAD_NEW, direction: 'short' })]);
    expect((await within(dialog).findAllByText(/4\.00%/)).length).toBeGreaterThan(0);
    const next = await within(dialog).findByRole('button', { name: 'Roll over' });
    await waitFor(() => expect(next).not.toBeDisabled(), { timeout: 4_000 });
    await user.click(next);
    const confirm = await within(dialog).findByRole('button', { name: 'Roll over' });
    await waitFor(() => expect(confirm).not.toBeDisabled(), { timeout: 4_000 });
    await user.pointer({ keys: '[MouseLeft>]', target: confirm });
    await waitFor(() => expect(sent).toHaveLength(1), { timeout: 4_000 });
    expect(sent[0].entry.legs).toEqual([expect.objectContaining({ marketId: SPREAD_NEW, direction: 'short', size: 100 })]);
    expect(sent[0].exit.legs).toHaveLength(2);
    expect(Object.keys(sent[0].clientOrderIds)).toContain(`entry:${SPREAD_NEW}`);
  });

  it('a close-only spread at the target maturity blocks the roll there, with no fall back to singles', async () => {
    spreadListed = true;
    spreadCloseOnly = true;
    const entries: PairSimBody[] = [];
    install({
      onPairSimulate: (b) => {
        if (b.intent === 'open') entries.push(b);
      },
    });
    renderWithClient(<RollOverModal pair={pair} base="ETH" nowSec={NOW} onClose={() => {}} />);
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/there is nothing to roll into yet/, undefined, { timeout: 4_000 })).toBeInTheDocument();
    expect(entries).toHaveLength(0);
  });
});

describe('RollOverModal, gas top-up on a spread target', () => {
  const lowGas = () => {
    spreadListed = true;
    const bodies: Record<string, unknown>[] = [];
    install({ gasBalanceUsd: 0.05 });
    server.use(
      http.post('/api/boros/pair/top-up-gas', async ({ request }) => {
        bodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json(env({ balanceUsd: 5.05, sentUsd: 5 }));
      }),
    );
    return bodies;
  };

  const holdTopUp = async (user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement, bodies: Record<string, unknown>[]) => {
    await within(dialog).findByLabelText(/Top up gas by hand \(USD\)/i, undefined, { timeout: 4_000 });
    await user.pointer({ keys: '[MouseLeft>]', target: within(dialog).getByRole('button', { name: /Top up gas/i }) });
    await waitFor(() => expect(bodies).toHaveLength(1), { timeout: 3_000 });
    expect(bodies[0]).toMatchObject({ marketId: SPREAD_NEW, address: ADDRESS });
  };

  it('the roll review tops up gas on the spread market', async () => {
    const bodies = lowGas();
    const user = userEvent.setup();
    renderWithClient(<RollOverModal pair={pair} base="ETH" nowSec={NOW} onClose={() => {}} />);
    const dialog = await screen.findByRole('dialog');
    const next = await within(dialog).findByRole('button', { name: 'Roll over' });
    await waitFor(() => expect(next).not.toBeDisabled(), { timeout: 4_000 });
    await user.click(next);
    await holdTopUp(user, dialog, bodies);
  });

  it('the open-only review tops up gas on the spread market', async () => {
    const bodies = lowGas();
    const user = userEvent.setup();
    renderWithClient(<RollOverModal pair={pair} base="ETH" nowSec={NOW} onClose={() => {}} />);
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Open only (keep old legs)' }));
    const next = await within(dialog).findByRole('button', { name: 'Open new maturity' });
    await waitFor(() => expect(next).not.toBeDisabled(), { timeout: 4_000 });
    await user.click(next);
    await holdTopUp(user, dialog, bodies);
  });
});

describe('RollOverModal — the atomic roll', () => {
  it('sends ONE roll carrying both steps, the size and four distinct ids, then shows the rolled line', async () => {
    const user = userEvent.setup();
    const sent: RollBody[] = [];
    install({ onRollExecute: (body) => { sent.push(body); return okRoll(body); } });
    const dialog = await armAndHold(user);
    await waitFor(() => expect(sent).toHaveLength(1), { timeout: 4_000 });

    const [body] = sent;
    // Closing reverses the held sides: Gate LONG is sold, Hyperliquid SHORT bought.
    expect(body.exit.legs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ marketId: GATE_OLD, direction: 'short', size: 100 }),
        expect.objectContaining({ marketId: HL_OLD, direction: 'long', size: 100 }),
      ]),
    );
    expect(body.entry.legs[0]).toMatchObject({ marketId: GATE_NEW, direction: 'long', size: 100 });
    expect(body.entry.legs[1]).toMatchObject({ marketId: HL_NEW, direction: 'short', size: 100 });

    expect(Object.keys(body.clientOrderIds).sort()).toEqual(
      [`entry:${GATE_NEW}`, `entry:${HL_NEW}`, `exit:${GATE_OLD}`, `exit:${HL_OLD}`].sort(),
    );
    expect(new Set(Object.values(body.clientOrderIds)).size).toBe(4);
    expect(Object.values(body.clientOrderIds).every(Boolean)).toBe(true);

    expect(await within(dialog).findByText(/Rolled 100 ETH/)).toBeInTheDocument();
    // No second send, and no alert on a clean roll.
    await new Promise((r) => setTimeout(r, 250));
    expect(sent).toHaveLength(1);
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a refused roll trades nothing: it names the leg and Retry re-sends the SAME four ids', async () => {
    const user = userEvent.setup();
    const sent: RollBody[] = [];
    install({
      onRollExecute: (body, n) => {
        sent.push(body);
        if (n === 1) return HttpResponse.json(executeBody(body, refusedResult(body, `entry:${GATE_NEW}`, 'insufficient-margin', 'not enough margin')));
        return okRoll(body);
      },
    });
    const dialog = await armAndHold(user);
    await waitFor(() => expect(sent).toHaveLength(1), { timeout: 4_000 });

    // Nothing traded, and the reason is prefixed with the named leg's market.
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent(/Nothing was traded/);
    expect(alert).toHaveTextContent(/Gate ETH 30 Oct 2026: not enough margin/);
    // Both sides are reported, grouped Exit / Re-entry.
    expect(within(dialog).getByText('Exit')).toBeInTheDocument();
    expect(within(dialog).getByText('Re-entry')).toBeInTheDocument();

    const retry = within(dialog).getByRole('button', { name: 'Retry' });
    await user.pointer({ keys: '[MouseLeft>]', target: retry });
    await waitFor(() => expect(sent).toHaveLength(2), { timeout: 4_000 });
    // The whole point of the memo: the same four ids, never re-minted.
    expect(sent[1].clientOrderIds).toEqual(sent[0].clientOrderIds);
    expect(await within(dialog).findByText(/Rolled 100 ETH/)).toBeInTheDocument();
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('an unconfirmed roll shows a rose warning and offers no retry', async () => {
    const user = userEvent.setup();
    const sent: RollBody[] = [];
    install({ onRollExecute: (body) => { sent.push(body); return HttpResponse.json(executeBody(body, unknownResult(body))); } });
    const dialog = await armAndHold(user);
    await waitFor(() => expect(sent).toHaveLength(1), { timeout: 4_000 });

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/did not confirm this roll/);
    expect(within(dialog).queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeInTheDocument();
    // No straggling resend from the unknown verdict.
    await new Promise((r) => setTimeout(r, 250));
    expect(sent).toHaveLength(1);
  });

  it('a 409 from execute is "not sent", and Retry re-sends the same ids', async () => {
    const user = userEvent.setup();
    const sent: RollBody[] = [];
    install({
      onRollExecute: (body, n) => {
        sent.push(body);
        if (n === 1) {
          return HttpResponse.json(
            { ok: false, error: { category: 'validation', message: 'the book moved', retryable: false }, data: { blockers: [] } },
            { status: 409 },
          );
        }
        return okRoll(body);
      },
    });
    const dialog = await armAndHold(user);
    await waitFor(() => expect(sent).toHaveLength(1), { timeout: 4_000 });

    expect(await within(dialog).findByText(/Roll — not sent/)).toBeInTheDocument();
    expect(within(dialog).getByText(/the book moved/)).toBeInTheDocument();

    const retry = within(dialog).getByRole('button', { name: 'Retry' });
    await user.pointer({ keys: '[MouseLeft>]', target: retry });
    await waitFor(() => expect(sent).toHaveLength(2), { timeout: 4_000 });
    // A thrown request must reuse the ids too: a lost response is answered
    // from the memo, a 409 or refusal executes again.
    expect(sent[1].clientOrderIds).toEqual(sent[0].clientOrderIds);
    expect(await within(dialog).findByText(/Rolled 100 ETH/)).toBeInTheDocument();
  });

  it('a replayed response notes that nothing was sent twice', async () => {
    const user = userEvent.setup();
    install({ onRollExecute: (body) => HttpResponse.json(executeBody(body, rolledResult(body), true)) });
    const dialog = await armAndHold(user);
    expect(await within(dialog).findByText(/Rolled 100 ETH/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Answered from the earlier submission/)).toBeInTheDocument();
  });
});

describe('RollOverModal — the review page', () => {
  it('carries a per-batch tolerance into the one roll request and its execute body, with no acknowledgement box', async () => {
    const user = userEvent.setup();
    const sims: RollBody[] = [];
    const sent: RollBody[] = [];
    install({ onRollExecute: (body) => { sent.push(body); return okRoll(body); }, onRollSimulate: (b) => sims.push(b) });
    renderWithClient(<RollOverModal pair={pair} base="ETH" nowSec={NOW} onClose={() => {}} />);
    const dialog = await screen.findByRole('dialog');
    const next = await within(dialog).findByRole('button', { name: 'Roll over' });
    await waitFor(() => expect(next).not.toBeDisabled(), { timeout: 4_000 });
    await user.click(next);

    // A roll IS a close of these legs: no box to tick, no acknowledgement blocker.
    const confirm = await within(dialog).findByRole('button', { name: 'Roll over' });
    await waitFor(() => expect(confirm).not.toBeDisabled(), { timeout: 4_000 });
    expect(within(dialog).queryByText(/Tick the acknowledgement/)).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument();

    // Two tolerances, one per batch: widening the EXIT re-quotes only the
    // close side of the roll; the re-entry keeps its seed.
    const [exitMax, entryMax] = within(dialog).getAllByTitle(/Change the tolerance/);
    await user.click(exitMax);
    const exitSlip = within(dialog).getByLabelText('Exit max slippage, % APR');
    await user.clear(exitSlip);
    await user.type(exitSlip, '1');
    await waitFor(() => {
      const last = sims.at(-1)!;
      expect(last.exit.legs[0].slippageApr).toBeCloseTo(0.01, 9);
      expect(last.exit.legs[1].slippageApr).toBeCloseTo(0.01, 9);
      // Untouched, so still on its seed (the 1% fallback for these markets).
      expect(last.entry.legs[0].slippageApr).toBeCloseTo(0.01, 9);
    }, { timeout: 4_000 });

    await user.click(entryMax);
    const entrySlip = within(dialog).getByLabelText('Re-entry max slippage, % APR');
    await user.clear(entrySlip);
    await user.type(entrySlip, '2');
    await waitFor(() => {
      const last = sims.at(-1)!;
      expect(last.entry.legs[0].slippageApr).toBeCloseTo(0.02, 9);
      expect(last.entry.legs[1].slippageApr).toBeCloseTo(0.02, 9);
    }, { timeout: 4_000 });

    // The hold sends ONE roll, each batch at its own tolerance.
    await waitFor(() => expect(confirm).not.toBeDisabled(), { timeout: 4_000 });
    await user.pointer({ keys: '[MouseLeft>]', target: confirm });
    await waitFor(() => expect(sent).toHaveLength(1), { timeout: 4_000 });
    expect(sent[0].exit.legs[0].slippageApr).toBeCloseTo(0.01, 9);
    expect(sent[0].entry.legs[1].slippageApr).toBeCloseTo(0.02, 9);
  });

  it('reads the margin, the warnings and the blockers straight from the roll gate', async () => {
    const user = userEvent.setup();
    install({
      gate: () =>
        rollGate({
          blockers: [{ code: 'venue-refused', message: 'The venue refuses this roll — Re-entry Gate ETH 30 Oct 2026: Insufficient liquidity. Widen the tolerance or reduce the size.' }],
          warnings: ['Rolling will auto-top-up gas by about $2 — it is billed to your prepaid gas pot.'],
          margin: { need: 5, availableBefore: 4, availableAfter: -2, shortfall: 2 },
        }),
    });
    renderWithClient(<RollOverModal pair={pair} base="ETH" nowSec={NOW} onClose={() => {}} />);
    const dialog = await screen.findByRole('dialog');
    const next = await within(dialog).findByRole('button', { name: 'Roll over' });
    await waitFor(() => expect(next).not.toBeDisabled(), { timeout: 4_000 });
    await user.click(next);

    // The blocker is listed and holds the confirm shut.
    expect(await within(dialog).findByText(/Re-entry Gate ETH 30 Oct 2026: Insufficient liquidity/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Roll over' })).toBeDisabled();
    // The gate warning renders (the two-batch flow dropped these).
    expect(within(dialog).getByText(/auto-top-up gas by about \$2/)).toBeInTheDocument();
    // The margin figures and the shortfall line come straight from gate.margin.
    const required = within(dialog).getByText('Required margin');
    const row = required.parentElement!.parentElement as HTMLElement;
    expect(within(row).getByText('5 ETH')).toBeInTheDocument();
    // Before → after, as the venue simulated it.
    expect(within(dialog).getByText(/4 ETH → -2 ETH/)).toBeInTheDocument();
    expect(within(dialog).getByText(/About 2 ETH short — the venue refuses the roll/)).toBeInTheDocument();
  });

  it('a batch the venue refused for margin shows the account once the old legs are closed, and the shortfall from it', async () => {
    const user = userEvent.setup();
    install({
      gate: () =>
        rollGate({
          blockers: [{ code: 'venue-refused', message: 'The venue refuses this roll:\nRe-entry · Hyperliquid ETH 30 Oct 2026 — Not enough margin. Add margin or roll a smaller size.' }],
          // The batch reverted: no after — but the venue reports the state between the closes and the opens.
          margin: { need: 0.113, availableBefore: 0.0525, availableAfter: null, availableAfterExit: 0.084, shortfall: 0.029 },
        }),
    });
    renderWithClient(<RollOverModal pair={pair} base="ETH" nowSec={NOW} onClose={() => {}} />);
    const dialog = await screen.findByRole('dialog');
    const next = await within(dialog).findByRole('button', { name: 'Roll over' });
    await waitFor(() => expect(next).not.toBeDisabled(), { timeout: 4_000 });
    await user.click(next);
    expect(await within(dialog).findByText(/Not enough margin/)).toBeInTheDocument();
    expect(within(dialog).getByText(/0\.0525 ETH → 0\.084 ETH/)).toBeInTheDocument();
    expect(within(dialog).getByText(/once the old legs are closed/)).toBeInTheDocument();
    expect(within(dialog).getByText(/About 0\.029 ETH short — the venue refuses the roll/)).toBeInTheDocument();
    expect(within(dialog).queryByText('Simulation failed')).not.toBeInTheDocument();
  });

  it('a comfortably funded roll shows the required and available margin with no shortfall', async () => {
    const user = userEvent.setup();
    install();
    renderWithClient(<RollOverModal pair={pair} base="ETH" nowSec={NOW} onClose={() => {}} />);
    const dialog = await screen.findByRole('dialog');
    const next = await within(dialog).findByRole('button', { name: 'Roll over' });
    await waitFor(() => expect(next).not.toBeDisabled(), { timeout: 4_000 });
    await user.click(next);
    const required = await within(dialog).findByText('Required margin');
    const row = required.parentElement!.parentElement as HTMLElement;
    expect(within(row).getByText('5 ETH')).toBeInTheDocument();
    expect(within(dialog).getByText(/895 ETH → 900 ETH/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/short — the venue refuses/)).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('the confirm stays disabled until a fresh quote lands', async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    install({ rollSimGate: gate });
    renderWithClient(<RollOverModal pair={pair} base="ETH" nowSec={NOW} onClose={() => {}} />);
    const dialog = await screen.findByRole('dialog');
    const next = await within(dialog).findByRole('button', { name: 'Roll over' });
    await waitFor(() => expect(next).not.toBeDisabled(), { timeout: 4_000 });
    await user.click(next);
    const confirm = await within(dialog).findByRole('button', { name: 'Roll over' });
    // No quote yet → the "Waiting for a quote" blocker holds it shut.
    expect(confirm).toBeDisabled();
    expect(within(dialog).getByText('Waiting for a quote.')).toBeInTheDocument();
    release();
    await waitFor(() => expect(confirm).not.toBeDisabled(), { timeout: 4_000 });
  });

  it('the exit shows the PnL of closing, not a spread: (locked − exec) × size × years, per leg', async () => {
    const user = userEvent.setup();
    install();
    renderWithClient(<RollOverModal pair={pair} base="ETH" nowSec={NOW} onClose={() => {}} />);
    const dialog = await screen.findByRole('dialog');
    const next = await within(dialog).findByRole('button', { name: 'Roll over' });
    await waitFor(() => expect(next).not.toBeDisabled(), { timeout: 4_000 });
    await user.click(next);
    // Gate LONG locked 4%, closed at 6% → gains 2% × 100 ETH × 8/365y; the
    // Hyperliquid SHORT locked 8%, closed at 6% → gains the same. 0.0877 ETH
    // at $2,500 = $219.18, before the fees PairCosts lists.
    const label = await within(dialog).findByText(/Est\. total trade PnL/);
    expect(within(dialog).getByText('$219.18')).toBeInTheDocument();
    const title = label.getAttribute('title') ?? '';
    // One row per leg: "venue · locked → exec" on the left, its PnL on the right.
    expect(title).toMatch(/Gate · 4\.00% → 6\.00%\t\$109\.59/);
    expect(title).toMatch(/Hyperliquid · 8\.00% → 6\.00%\t\$109\.59/);
  });
});

/**
 * Open-only: open the new maturity and LEAVE the old legs running. No close,
 * so it is an ordinary pair OPEN over /boros/pair/execute — never the atomic
 * /boros/roll/execute — and the review has no exit batch.
 */
describe('RollOverModal — open only (keep old legs)', () => {
  type PairExecBody = {
    address: string;
    intent: string;
    legs: Leg[];
  };
  const pairExecuteBody = (body: PairExecBody) =>
    env({
      result: {
        legs: body.legs.map((l) => legFill(l.marketId, l.direction, l.size)),
        allLegsSubmitted: true,
        hedgedSize: body.legs[0].size,
        unhedgedSize: 0,
        unhedgedLeg: null,
        realisedSpreadApr: 0.04,
        partial: false,
        filledNothing: false,
      },
      estimate: simulation({ ...body, intent: 'open' }),
      warnings: [],
      replayed: false,
    });

  it('sends a pair OPEN at the target market ids and size, not a roll, and shows no exit', async () => {
    const user = userEvent.setup();
    const opened: PairExecBody[] = [];
    let rolls = 0;
    install();
    server.use(
      http.post('/api/boros/pair/execute', async ({ request }) => {
        const body = (await request.json()) as PairExecBody;
        opened.push(body);
        return HttpResponse.json(pairExecuteBody(body));
      }),
      http.post('/api/boros/roll/execute', () => {
        rolls += 1;
        return HttpResponse.json({ ok: false, error: { category: 'validation', message: 'should not roll', retryable: false } }, { status: 409 });
      }),
    );
    renderWithClient(<RollOverModal pair={pair} base="ETH" nowSec={NOW} onClose={() => {}} />);
    const dialog = await screen.findByRole('dialog');

    // Switch to open-only; the primary button renames accordingly.
    await user.click(within(dialog).getByRole('button', { name: 'Open only (keep old legs)' }));
    const next = await within(dialog).findByRole('button', { name: 'Open new maturity' });
    await waitFor(() => expect(next).not.toBeDisabled(), { timeout: 4_000 });
    await user.click(next);

    // The review has NO exit batch — just the new legs.
    expect(within(dialog).queryByText('Exit')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Re-entry')).not.toBeInTheDocument();
    expect(within(dialog).getByText(/half your Boros floating side is unhedged/)).toBeInTheDocument();

    const confirm = await within(dialog).findByRole('button', { name: 'Open new maturity' });
    await waitFor(() => expect(confirm).not.toBeDisabled(), { timeout: 4_000 });
    await user.pointer({ keys: '[MouseLeft>]', target: confirm });
    await waitFor(() => expect(opened).toHaveLength(1), { timeout: 4_000 });

    const [body] = opened;
    expect(body.intent).toBe('open');
    // The new maturity's two markets, each taking the pair's own side.
    expect(body.legs[0]).toMatchObject({ marketId: GATE_NEW, direction: 'long', size: 100 });
    expect(body.legs[1]).toMatchObject({ marketId: HL_NEW, direction: 'short', size: 100 });
    // Two distinct ids, kept for replay.
    expect(body.legs[0].clientOrderId).toBeTruthy();
    expect(body.legs[1].clientOrderId).toBeTruthy();
    expect(body.legs[0].clientOrderId).not.toBe(body.legs[1].clientOrderId);
    // Nothing was ever rolled.
    expect(rolls).toBe(0);

    expect(await within(dialog).findByText(/Opened 100 ETH/)).toBeInTheDocument();
  });

  it('prices the options without an exit: the cost is the opening fee alone', async () => {
    // The old legs stay open, so no exit fee is paid and no exit PnL realised.
    const user = userEvent.setup();
    install();
    renderWithClient(<RollOverModal pair={pair} base="ETH" nowSec={NOW} onClose={() => {}} />);
    const dialog = await screen.findByRole('dialog');
    const costRow = async (label: string) => (await within(dialog).findByText(label)).parentElement as HTMLElement;

    // Close & reopen: the round trip, both fees and the exit PnL behind the ⓘ.
    const roundTrip = await costRow('Rollover Cost');
    await waitFor(() => expect(roundTrip.querySelector('[title]')?.getAttribute('title')).toMatch(/Exit PnL/));

    await user.click(within(dialog).getByRole('button', { name: 'Open only (keep old legs)' }));
    const opening = await costRow('Opening cost');
    // 0.02 ETH to cross the entry books at $2,500: the opening fee, nothing else.
    await waitFor(() => expect(opening).toHaveTextContent(/50\.00/));
    const split = opening.querySelector('[title]')?.getAttribute('title') ?? '';
    expect(split).toMatch(/^Opening fee\t.\$50\.00/);
    expect(split).not.toMatch(/Exit fee|Exit PnL\t/);
  });

  it('offers no Retry after a partial fill — the same ids would only replay it', async () => {
    const user = userEvent.setup();
    let sends = 0;
    install();
    server.use(
      http.post('/api/boros/pair/execute', async ({ request }) => {
        sends += 1;
        const body = (await request.json()) as PairExecBody;
        const full = pairExecuteBody(body) as { data: { result: Record<string, unknown> } };
        Object.assign(full.data.result, {
          legs: [legFill(body.legs[0].marketId, body.legs[0].direction, 100), legFill(body.legs[1].marketId, body.legs[1].direction, 60)],
          hedgedSize: 60,
          unhedgedSize: 40,
          unhedgedLeg: 0,
          partial: true,
        });
        return HttpResponse.json(full);
      }),
    );
    renderWithClient(<RollOverModal pair={pair} base="ETH" nowSec={NOW} onClose={() => {}} />);
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Open only (keep old legs)' }));
    const next = await within(dialog).findByRole('button', { name: 'Open new maturity' });
    await waitFor(() => expect(next).not.toBeDisabled(), { timeout: 4_000 });
    await user.click(next);
    const confirm = await within(dialog).findByRole('button', { name: 'Open new maturity' });
    await waitFor(() => expect(confirm).not.toBeDisabled(), { timeout: 4_000 });
    await user.pointer({ keys: '[MouseLeft>]', target: confirm });

    expect(await within(dialog).findByText(/the rest did not fill\. Open the remainder from the position view\./)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /Retry/ })).not.toBeInTheDocument();
    expect(sends).toBe(1);
  });
});

describe('RollOverModal — per-venue exposure', () => {
  const SPREAD_OLD = 58;
  const bookOf = (single: { gate: number; hl: number }, spread: number) => {
    const sized = (l: AssetBorosOpen, size: number): AssetBorosOpen => ({ ...l, sizeToken: size, notionalUsd: size * 2500 });
    const g: AssetGroup = {
      ...group,
      perpOpen: [
        { ...perp('GATE', 'LONG'), qty: single.gate + spread, notionalUsd: (single.gate + spread) * 2500 },
        { ...perp('HYPERLIQUID', 'SHORT'), qty: single.hl + spread, notionalUsd: (single.hl + spread) * 2500 },
      ],
      borosOpen: [
        sized(yu(GATE_OLD, 'GATE', 'LONG'), single.gate),
        sized(yu(HL_OLD, 'HYPERLIQUID', 'SHORT'), single.hl),
        ...(spread > 0
          ? [{ ...sized(yu(SPREAD_OLD, 'HYPERLIQUID', 'SHORT'), spread), spreadVenues: ['HYPERLIQUID', 'GATE'] as [string, string] }]
          : []),
      ],
    };
    return deriveAsset(g, {}, 0, NOW).pairs[0];
  };
  const exposureOf = (legs: { marketId: number; size: number }[], sign: 1 | -1) => {
    let gate = 0;
    let hl = 0;
    for (const l of legs) {
      if (l.marketId === GATE_OLD || l.marketId === GATE_NEW) gate += sign * l.size;
      else if (l.marketId === HL_OLD || l.marketId === HL_NEW) hl += sign * l.size;
      else {
        gate += sign * l.size;
        hl += sign * l.size;
      }
    }
    return { gate, hl };
  };
  const quoted = async (p: ReturnType<typeof bookOf>, share?: '50%') => {
    const user = userEvent.setup();
    const closes: PairSimBody[] = [];
    const opens: PairSimBody[] = [];
    install({ onPairSimulate: (b) => (b.intent === 'open' ? opens : closes).push(b) });
    renderWithClient(<RollOverModal pair={p} base="ETH" nowSec={NOW} onClose={() => {}} />);
    const dialog = await screen.findByRole('dialog');
    if (share) {
      await waitFor(() => expect(opens.length).toBeGreaterThan(0), { timeout: 4_000 });
      await user.click(within(within(dialog).getByRole('group', { name: 'Share shortcuts' })).getByRole('button', { name: share }));
    }
    const size = Number((within(dialog).getByLabelText('Size to roll (ETH)') as HTMLInputElement).value);
    await waitFor(
      () => {
        expect(closes.at(-1)?.legs[0].size).toBeLessThanOrEqual(size);
        expect(opens.length).toBeGreaterThan(0);
      },
      { timeout: 4_000 },
    );
    await waitFor(() => expect(Math.max(...opens.at(-1)!.legs.map((l) => l.size))).toBe(size), { timeout: 4_000 });
    return { exit: closes.at(-1)!.legs, entry: opens.at(-1)!.legs, size };
  };
  const held = (p: ReturnType<typeof bookOf>) =>
    exposureOf(p.legs.filter((l) => l.kind === 'yu').map((l) => ({ marketId: l.marketId!, size: l.sizeToken })), 1);

  for (const [label, single, spread] of [
    ['$50', 0.01, 0.01],
    ['$6M', 1261.25, 1071.75],
  ] as const) {
    it(`mixed book at ${label}: the whole roll closes each leg in full and opens one spread at the venue exposure`, async () => {
      spreadListed = true;
      const p = bookOf({ gate: single, hl: single }, spread);
      expect(p.legs.filter((l) => l.kind === 'yu')).toHaveLength(3);
      const { exit, entry } = await quoted(p);
      expect(exit.map((l) => [l.marketId, l.size])).toEqual([
        [GATE_OLD, single],
        [HL_OLD, single],
        [SPREAD_OLD, spread],
      ].sort((a, b) => p.legs.findIndex((l) => l.marketId === a[0]) - p.legs.findIndex((l) => l.marketId === b[0])));
      expect(entry).toEqual([expect.objectContaining({ marketId: SPREAD_NEW, direction: 'short', size: single + spread })]);
      const before = held(p);
      const out = exposureOf(exit, -1);
      const add = exposureOf(entry, 1);
      expect(before.gate + out.gate + add.gate).toBe(before.gate);
      expect(before.hl + out.hl + add.hl).toBe(before.hl);
    });

    it(`mixed book at ${label}: half a roll keeps each venue's exposure`, async () => {
      spreadListed = true;
      const p = bookOf({ gate: single, hl: single }, spread);
      const { exit, entry, size } = await quoted(p, '50%');
      expect(entry).toEqual([expect.objectContaining({ marketId: SPREAD_NEW, size })]);
      const before = held(p);
      const out = exposureOf(exit, -1);
      const add = exposureOf(entry, 1);
      expect(Math.abs(before.gate + out.gate + add.gate - before.gate)).toBeLessThan(before.gate * 1e-12);
      expect(Math.abs(before.hl + out.hl + add.hl - before.hl)).toBeLessThan(before.hl * 1e-12);
    });

    for (const share of [undefined, '50%'] as const) {
      it(`plain pair at ${label}, ${share ?? 'whole'}: sends the same size on all four legs, as before`, async () => {
        const eth = single + spread;
        const { exit, entry, size } = await quoted(bookOf({ gate: eth, hl: eth }, 0), share);
        expect(exit.map((l) => l.size)).toEqual([size, size]);
        expect(entry.map((l) => [l.marketId, l.size])).toEqual([
          [GATE_NEW, size],
          [HL_NEW, size],
        ]);
      });
    }
  }
});
