/**
 * The roll-over as two batches: exit the legs held now, then re-open the same
 * sides at the new maturity, sized to what the exit actually closed. These pin
 * the order of the two sends, the sizing between them, the four distinct order
 * ids, and the two ways it stops — an exit that filled nothing sends no entry;
 * an entry that failed after a good exit says the rate side is short and
 * retries only the entry.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AssetBorosOpen, AssetGroup, AssetPerpOpen } from '../../api/types';
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
  isolatedOnly: false,
  onIsolatedMargin: false,
  isolatedHasPositionOrOrders: false,
  currentSize: 0,
  collateralPriceUsd: 2500,
});
const context = () => ({
  markets: [
    marketRow(GATE_OLD, 'Gate', OLD),
    marketRow(HL_OLD, 'Hyperliquid', OLD),
    marketRow(GATE_NEW, 'Gate', NEW),
    marketRow(HL_NEW, 'Hyperliquid', NEW),
  ],
  crossByToken: [{ tokenId: 3, available: 1_000 }],
  isolatedByMarket: [],
  defaultSlippageApr: 0.0025,
  maxSlippageApr: 0.1,
});
const venueOf = (marketId: number) => (marketId === GATE_OLD || marketId === GATE_NEW ? 'Gate' : 'Hyperliquid');
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
const simulation = (body: { legA: { marketId: number; direction: 'long' | 'short' }; legB: { marketId: number; direction: 'long' | 'short' }; size: number; intent: string }) => ({
  legA: simLeg(body.legA.marketId, body.legA.direction, body.size, body.intent),
  legB: simLeg(body.legB.marketId, body.legB.direction, body.size, body.intent),
  receiveLeg: 'B',
  estSpreadApr: 0.04,
  worstSpreadApr: 0.035,
  costToCrossSize: 0.02,
  feeDragApr: 0.003,
  marginRequiredTotal: 8,
  hedgedSize: body.size,
  unhedgedSize: 0,
  collateral: 'ETH',
  collateralPriceUsd: 2500,
  secondsToMaturity: 45 * DAY,
  reasons: [],
});
const fill = (marketId: number, direction: string, filledSize: number, shortfallSize = 0) => ({
  marketId,
  direction,
  filledSize,
  shortfallSize,
  execApr: 0.06,
  feeSize: 0.01,
  failure: null,
});
/** A full fill of whatever was asked. */
const filledResult = (body: { legA: { marketId: number; direction: string }; legB: { marketId: number; direction: string }; size: number }) => ({
  legA: fill(body.legA.marketId, body.legA.direction, body.size),
  legB: fill(body.legB.marketId, body.legB.direction, body.size),
  hedgedSize: body.size,
  unhedgedSize: 0,
  unhedgedLeg: null,
  realisedSpreadApr: 0.04,
  partial: false,
  filledNothing: false,
  bothLegsSubmitted: true,
});

type SimBody = Body & { opposingAcknowledged?: boolean; legA: Body['legA'] & { slippageApr: number }; legB: Body['legB'] & { slippageApr: number } };
type Body = { intent: string; size: number; legA: { marketId: number; direction: 'long' | 'short' }; legB: { marketId: number; direction: 'long' | 'short' }; clientOrderIdA: string; clientOrderIdB: string };

function install(
  onExecute: (body: Body, n: number) => Response | Promise<Response>,
  opts: { onSimulate?: (body: SimBody) => void; requiresAck?: boolean } = {},
) {
  let n = 0;
  server.use(
    http.get('/api/boros/agent', () =>
      HttpResponse.json(env({ configured: true, root: ADDRESS, rootMasked: '0x1111…1111', accountId: 0, expiry: null, expired: false, canProvision: true })),
    ),
    http.get('/api/boros/pair/context', () => HttpResponse.json(env(context()))),
    http.post('/api/boros/pair/simulate', async ({ request }) => {
      const body = (await request.json()) as SimBody;
      opts.onSimulate?.(body);
      // A close that has not been acknowledged is blocked, as the server does it.
      const wantsAck = Boolean(opts.requiresAck) && body.intent === 'close';
      const blocked = wantsAck && !body.opposingAcknowledged;
      return HttpResponse.json(
        env({
          simulation: simulation(body),
          gate: {
            blockers: blocked ? [{ code: 'flip-unacknowledged', message: 'Tick the acknowledgement to confirm what happens to your existing position.' }] : [],
            warnings: [],
            requiresAcknowledgement: wantsAck,
            opposingLegs: wantsAck ? ['A', 'B'] : [],
          },
          eligibility: { eligible: true, code: null, reason: null },
          simulatedAtMs: Date.now(),
          gasBalanceUsd: 5,
        }),
      );
    }),
    http.post('/api/boros/pair/execute', async ({ request }) => {
      n += 1;
      return onExecute((await request.json()) as Body, n);
    }),
  );
}

const ok = (body: Body) => HttpResponse.json(env({ result: filledResult(body), estimate: simulation(body), warnings: [] }));

async function armAndHold(user: ReturnType<typeof userEvent.setup>) {
  renderWithClient(<RollOverModal pair={pair} base="ETH" nowSec={NOW} onClose={() => {}} />);
  const dialog = await screen.findByRole('dialog');
  // PICK: the one target maturity is auto-selected; "Roll over →" opens the
  // review once the venue context is in.
  const next = await within(dialog).findByRole('button', { name: 'Roll over →' });
  await waitFor(() => expect(next).not.toBeDisabled(), { timeout: 4_000 });
  await user.click(next);
  // REVIEW: the hold unlocks once both batches are quoted and the agent is live.
  const confirm = await within(dialog).findByRole('button', { name: 'Roll over' });
  await waitFor(() => expect(confirm).not.toBeDisabled(), { timeout: 4_000 });
  await user.pointer({ keys: '[MouseLeft>]', target: confirm });
  return dialog;
}

beforeEach(() => {
  localStorage.setItem(STRATEGY_STORAGE_KEY, JSON.stringify({ address: ADDRESS }));
});

describe('RollOverModal — the roll as two batches', () => {
  it('sends the exit, then the entry sized to what the exit filled, with four distinct ids', async () => {
    const user = userEvent.setup();
    const sent: Body[] = [];
    install((body) => {
      sent.push(body);
      // The exit fills 60 of the 100 asked; the entry must then ask for 60.
      if (body.intent === 'close') {
        const r = filledResult(body);
        r.legA = fill(body.legA.marketId, body.legA.direction, 60, 40);
        r.legB = fill(body.legB.marketId, body.legB.direction, 60, 40);
        r.partial = true;
        r.hedgedSize = 60;
        return HttpResponse.json(env({ result: r, estimate: simulation(body), warnings: [] }));
      }
      return ok(body);
    });
    const dialog = await armAndHold(user);
    await waitFor(() => expect(sent).toHaveLength(2), { timeout: 4_000 });

    const [exit, entry] = sent;
    expect(exit.intent).toBe('close');
    expect(exit.size).toBe(100);
    // Closing reverses the held sides: Gate LONG is sold, Hyperliquid SHORT is bought.
    expect(exit.legA).toMatchObject({ marketId: GATE_OLD, direction: 'short' });
    expect(exit.legB).toMatchObject({ marketId: HL_OLD, direction: 'long' });

    expect(entry.intent).toBe('open');
    expect(entry.size).toBe(60);
    expect(entry.legA).toMatchObject({ marketId: GATE_NEW, direction: 'long' });
    expect(entry.legB).toMatchObject({ marketId: HL_NEW, direction: 'short' });

    const ids = [exit.clientOrderIdA, exit.clientOrderIdB, entry.clientOrderIdA, entry.clientOrderIdB];
    expect(new Set(ids).size).toBe(4);
    expect(ids.every(Boolean)).toBe(true);

    // Both steps reported; the partial exit's remainder is named as still open.
    expect(await within(dialog).findByText(/Rolled 60 ETH/)).toBeInTheDocument();
    expect(within(dialog).getByText(/40 ETH of the old legs stayed open/)).toBeInTheDocument();
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('an exit that fills nothing sends no entry and offers to retry the exit', async () => {
    const user = userEvent.setup();
    const sent: Body[] = [];
    install((body) => {
      sent.push(body);
      const r = filledResult(body);
      r.legA = fill(body.legA.marketId, body.legA.direction, 0, body.size);
      r.legB = fill(body.legB.marketId, body.legB.direction, 0, body.size);
      r.partial = true;
      r.filledNothing = true;
      r.hedgedSize = 0;
      return HttpResponse.json(env({ result: r, estimate: simulation(body), warnings: [] }));
    });
    const dialog = await armAndHold(user);
    expect(await within(dialog).findByText('nothing filled')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Retry exit' })).toBeInTheDocument();
    // Give a straggling second send every chance to show up — there is none.
    await new Promise((r) => setTimeout(r, 300));
    expect(sent).toHaveLength(1);
    expect(sent[0].intent).toBe('close');
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('an entry that fails after a good exit says the rate side is short and retries only the entry', async () => {
    const user = userEvent.setup();
    const sent: Body[] = [];
    install((body, n) => {
      sent.push(body);
      if (n === 2) {
        return HttpResponse.json(
          { ok: false, error: { category: 'validation', message: 'the book moved', retryable: true } },
          { status: 409 },
        );
      }
      return ok(body);
    });
    const dialog = await armAndHold(user);
    await waitFor(() => expect(sent).toHaveLength(2), { timeout: 4_000 });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/rate side is short by 100 ETH/);
    expect(within(dialog).getByText(/Re-entry — not sent/)).toBeInTheDocument();
    expect(within(dialog).getByText(/the book moved/)).toBeInTheDocument();

    const retry = within(dialog).getByRole('button', { name: 'Retry re-entry' });
    await user.pointer({ keys: '[MouseLeft>]', target: retry });
    await waitFor(() => expect(sent).toHaveLength(3), { timeout: 4_000 });
    // The third send is the entry again — never the exit — with fresh ids.
    expect(sent[2].intent).toBe('open');
    expect(sent[2].size).toBe(100);
    expect(sent[2].clientOrderIdA).not.toBe(sent[1].clientOrderIdA);
    expect(sent[2].clientOrderIdB).not.toBe(sent[1].clientOrderIdB);
    expect(await within(dialog).findByText(/Rolled 100 ETH/)).toBeInTheDocument();
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('RollOverModal — the review page', () => {
  it('each batch has its own tolerance, and a close that asks for acknowledgement gets it up front', async () => {
    const user = userEvent.setup();
    const sims: SimBody[] = [];
    const sent: Body[] = [];
    install((body) => { sent.push(body); return ok(body); }, { onSimulate: (b) => sims.push(b), requiresAck: true });
    renderWithClient(<RollOverModal pair={pair} base="ETH" nowSec={NOW} onClose={() => {}} />);
    const dialog = await screen.findByRole('dialog');
    const next = await within(dialog).findByRole('button', { name: 'Roll over →' });
    await waitFor(() => expect(next).not.toBeDisabled(), { timeout: 4_000 });
    await user.click(next);

    // A roll IS a close of these legs: no box to tick, no "Exit: Tick the
    // acknowledgement" blocker — the exit is quoted acknowledged from the
    // first request and the confirm arms as soon as both quotes land.
    const confirm = await within(dialog).findByRole('button', { name: 'Roll over' });
    await waitFor(() => expect(confirm).not.toBeDisabled(), { timeout: 4_000 });
    expect(within(dialog).queryByText(/Tick the acknowledgement/)).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(sims.filter((s) => s.intent === 'close').at(-1)?.opposingAcknowledged).toBe(true);

    // Two tolerances, one per batch: widening the EXIT re-quotes only the
    // close with it; the re-entry keeps the default until its own box moves.
    const [exitMax, entryMax] = within(dialog).getAllByTitle(/Change the tolerance/);
    await user.click(exitMax);
    const exitSlip = within(dialog).getByLabelText('Exit max slippage, % APR');
    await user.clear(exitSlip);
    await user.type(exitSlip, '1');
    await waitFor(() => {
      const close = sims.filter((s) => s.intent === 'close').at(-1)!;
      expect(close.legA.slippageApr).toBeCloseTo(0.01, 9);
      expect(close.legB.slippageApr).toBeCloseTo(0.01, 9);
    }, { timeout: 4_000 });
    /**
     * Untouched, so still on its SEED — which comes from the markets' own
     * max rate deviation, exactly as the ticket and the close form seed
     * theirs. These fixture markets report no cap, so the seed is the 1%
     * fallback; the point is that widening the exit did not move it.
     */
    expect(sims.filter((s) => s.intent === 'open').at(-1)!.legA.slippageApr).toBeCloseTo(0.01, 9);

    await user.click(entryMax);
    const entrySlip = within(dialog).getByLabelText('Re-entry max slippage, % APR');
    await user.clear(entrySlip);
    await user.type(entrySlip, '2');
    await waitFor(() => {
      const open = sims.filter((s) => s.intent === 'open').at(-1)!;
      expect(open.legA.slippageApr).toBeCloseTo(0.02, 9);
      expect(open.legB.slippageApr).toBeCloseTo(0.02, 9);
    }, { timeout: 4_000 });

    // The hold sends the exit acknowledged, each batch at its own tolerance.
    await waitFor(() => expect(confirm).not.toBeDisabled(), { timeout: 4_000 });
    await user.pointer({ keys: '[MouseLeft>]', target: confirm });
    await waitFor(() => expect(sent).toHaveLength(2), { timeout: 4_000 });
    const [exit, entry] = sent as SimBody[];
    expect(exit.opposingAcknowledged).toBe(true);
    expect(exit.legA.slippageApr).toBeCloseTo(0.01, 9);
    expect(entry.legB.slippageApr).toBeCloseTo(0.02, 9);
  });

  it('shows the margin the re-entry needs against what is available, and warns when short', async () => {
    const user = userEvent.setup();
    // The context says 1,000 ETH is available; the sim asks for 8 → fine.
    install((body) => ok(body));
    renderWithClient(<RollOverModal pair={pair} base="ETH" nowSec={NOW} onClose={() => {}} />);
    const dialog = await screen.findByRole('dialog');
    const next = await within(dialog).findByRole('button', { name: 'Roll over →' });
    await waitFor(() => expect(next).not.toBeDisabled(), { timeout: 4_000 });
    await user.click(next);
    // Two figures: what the new legs need, and what will be there after the
    // exit (1,000 ETH now plus what the exit frees, less its worst case and a
    // 5% haircut) — comfortably above 8, so no shortfall line.
    const required = await within(dialog).findByText('Required margin');
    // The row: label span → its wrapper → the flex row that also holds the value.
    const row = required.parentElement!.parentElement as HTMLElement;
    /**
     * The margin the roll ADDS, not the netted total.
     *
     * Each re-entry leg opens onto a position of the same size, so it needs
     * 5 ETH on a resulting position of double the size ⇒ it adds half, 2.5
     * per leg, 5 for the pair. Charging the netted `marginRequiredTotal` (8)
     * is what made a 13% roll read nearly the same capital as a 100% one.
     */
    expect(within(row).getByText('5 ETH')).toBeInTheDocument();
    expect(within(dialog).getByText('Available margin after exit')).toBeInTheDocument();
    expect(within(dialog).queryByText(/short\. Top up/)).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('the exit shows the PnL of closing, not a spread: (locked − exec) × size × years, per leg', async () => {
    const user = userEvent.setup();
    install((body) => ok(body));
    renderWithClient(<RollOverModal pair={pair} base="ETH" nowSec={NOW} onClose={() => {}} />);
    const dialog = await screen.findByRole('dialog');
    const next = await within(dialog).findByRole('button', { name: 'Roll over →' });
    await waitFor(() => expect(next).not.toBeDisabled(), { timeout: 4_000 });
    await user.click(next);
    // Gate LONG locked 4%, closed at 6% → gains 2% × 100 ETH × 8/365y; the
    // Hyperliquid SHORT locked 8%, closed at 6% → gains the same. 0.0877 ETH
    // at $2,500 = $219.18, before the fees PairCosts lists.
    const label = await within(dialog).findByText(/Est\. total trade PnL/);
    expect(within(dialog).getByText('+$219.18')).toBeInTheDocument();
    /**
     * The per-leg split is HOVER TEXT now, not rows: the total is the figure
     * a roll is judged on (his call 2026-09-18). Each leg contributes half
     * of the $219.18, with the rate move that produced it.
     */
    const title = label.getAttribute('title') ?? '';
    expect(title).toMatch(/Gate \$109\.59 · locked 4\.00% → 6\.00%/);
    expect(title).toMatch(/Hyperliquid \$109\.59 · locked 8\.00% → 6\.00%/);
  });
});
