import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionInput, PreviewResponse } from '../api/types';
import { TabActiveContext } from '../components/TabBar';
import { STRATEGY_STORAGE_KEY } from '../panels/HomeControls';
import { baseHandlers, ethPosition, pairContextBodies, previewFor } from '../test/fixtures';
import { env, server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { BorosPairTicket } from './BorosPairTicket';
import { ClosePopover } from './ClosePopover';
import { useTradeFlow, type BorosOpenPrefill } from './TradeFlow';

const ADDRESS = '0x1111111111111111111111111111111111111111';
const HL = 155;
const BN = 158;
const MATURITY = 1_800_000_000;

const marketRow = (over: Record<string, unknown> = {}) => ({
  marketId: HL,
  name: 'Hyperliquid ETH 31 Aug 2026',
  venue: 'Hyperliquid',
  base: 'ETH',
  tokenId: 3,
  collateral: 'USDT',
  maturity: MATURITY,
  midApr: 0.09,
  markApr: 0.09,
  isolatedOnly: false,
  onIsolatedMargin: false,
  isolatedHasPositionOrOrders: false,
  currentSize: 0,
  collateralPriceUsd: 1,
  closeOnly: false,
  ...over,
});

const context = () => ({
  markets: [
    marketRow({ closeOnly: true }),
    marketRow({ marketId: BN, name: 'Binance ETHUSDT 31 Aug 2026', venue: 'Binance', midApr: 0.045 }),
  ],
  crossByToken: [{ tokenId: 3, available: 500_000 }],
  isolatedByMarket: [],
  defaultSlippageApr: 0.0025,
  maxSlippageApr: 0.1,
});

const simLeg = (over: Record<string, unknown> = {}) => ({
  marketId: HL,
  marketName: 'Hyperliquid ETH 31 Aug 2026',
  venue: 'Hyperliquid',
  base: 'ETH',
  direction: 'short',
  execApr: 0.09,
  worstApr: 0.0875,
  estFillSize: 100_000,
  shortfallSize: 0,
  bookStatus: 'ok',
  marginRequired: 700,
  slippageApr: 0.0025,
  sizing: {
    currentSize: 0,
    deltaSize: -100_000,
    resultingSize: -100_000,
    opposing: false,
    flips: false,
    clampedToClose: false,
    orderSide: 'short',
  },
  ...over,
});

const simulation = () => ({
  legA: simLeg(),
  legB: simLeg({
    marketId: BN,
    marketName: 'Binance ETHUSDT 31 Aug 2026',
    venue: 'Binance',
    direction: 'long',
    execApr: 0.042,
    worstApr: 0.0445,
    marginRequired: 620,
    sizing: {
      currentSize: 0,
      deltaSize: 100_000,
      resultingSize: 100_000,
      opposing: false,
      flips: false,
      clampedToClose: false,
      orderSide: 'long',
    },
  }),
  receiveLeg: 'A',
  estSpreadApr: 0.045,
  worstSpreadApr: 0.04,
  costToCrossSize: 8.2,
  feeDragApr: 0.003,
  marginRequiredTotal: 1_320,
  hedgedSize: 100_000,
  unhedgedSize: 0,
  collateral: 'USDT',
  collateralPriceUsd: 1,
  secondsToMaturity: 2_592_000,
  reasons: [],
});

const agentStatus = () => ({
  configured: true,
  root: ADDRESS,
  rootMasked: '0x1111…1111',
  accountId: 0,
  expiry: null,
  expired: false,
  canProvision: true,
});

function handlers(opts: { onExecute?: (body: Record<string, unknown>) => void } = {}) {
  return [
    http.get('/api/boros/agent', () => HttpResponse.json(env(agentStatus()))),
    http.get('/api/boros/pair/context', () => HttpResponse.json(env(context()))),
    http.post('/api/boros/pair/simulate', () =>
      HttpResponse.json(
        env({
          simulation: simulation(),
          gate: { blockers: [], warnings: [], requiresAcknowledgement: false, opposingLegs: [] },
          eligibility: { eligible: true, code: null, reason: null },
          simulatedAtMs: Date.now(),
          gasBalanceUsd: null,
        }),
      ),
    ),
    http.post('/api/boros/pair/execute', async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      opts.onExecute?.(body);
      return HttpResponse.json(
        env({
          result: {
            legA: { marketId: HL, direction: 'short', filledSize: 100_000, shortfallSize: 0, execApr: 0.09, feeSize: 4, failure: null },
            legB: { marketId: BN, direction: 'long', filledSize: 100_000, shortfallSize: 0, execApr: 0.042, feeSize: 4, failure: null },
            hedgedSize: 100_000,
            unhedgedSize: 0,
            unhedgedLeg: null,
            realisedSpreadApr: 0.045,
            partial: false,
            bothLegsSubmitted: true,
          },
          estimate: simulation(),
          warnings: [],
        }),
      );
    }),
  ];
}

async function fillTicket(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() =>
    expect((screen.getByLabelText('Leg A') as HTMLSelectElement).options.length).toBeGreaterThan(1),
  );
  await user.selectOptions(screen.getByLabelText('Leg A'), String(HL));
  await user.selectOptions(screen.getByLabelText('Leg B'), String(BN));
  await user.type(screen.getByLabelText(/^Size per leg/), '100000');
}

beforeEach(() => {
  window.localStorage.setItem(STRATEGY_STORAGE_KEY, JSON.stringify({ address: ADDRESS }));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('BorosPairTicket — close-only market', () => {
  it('a "close only" chip sits on Market A', async () => {
    server.use(...handlers());
    const user = userEvent.setup();
    renderWithClient(<BorosPairTicket />);
    await fillTicket(user);

    expect(screen.getByText('close only')).toBeInTheDocument();
  });

  it('open refused: Confirm is disabled and names the market', async () => {
    server.use(...handlers());
    const user = userEvent.setup();
    renderWithClient(<BorosPairTicket />);
    await fillTicket(user);

    const btn = await screen.findByRole('button', {
      name: 'Market A takes closes only. Switch to Close.',
    });
    expect(btn).toBeDisabled();
  });

  it('close allowed: Confirm is enabled and sends the close intent', async () => {
    const executes: Record<string, unknown>[] = [];
    server.use(...handlers({ onExecute: (b) => executes.push(b) }));
    const user = userEvent.setup();
    renderWithClient(<BorosPairTicket />);
    await fillTicket(user);
    // MERGE 2026-09-21: dev's Open/Close radio is now Hubert's "Reduce-only" checkbox (both set intent='close').
    await user.click(screen.getByRole('checkbox', { name: 'Reduce-only' }));

    const btn = await waitFor(() => {
      const b = screen.getByRole('button', { name: /Confirm/ });
      expect(b).toBeEnabled();
      return b;
    });

    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.pointerDown(btn);
    await act(() => vi.advanceTimersByTimeAsync(850));

    await waitFor(() => expect(executes.length).toBe(1));
    expect(executes[0]).toMatchObject({ intent: 'close' });
  });
});

function GuidedPrefillHarness({ prefill }: { prefill: Omit<BorosOpenPrefill, 'nonce'> }) {
  const flow = useTradeFlow();
  return (
    <>
      <button type="button" onClick={() => flow.prefillBorosOpen(prefill)}>
        fire
      </button>
      <BorosPairTicket guided />
    </>
  );
}

describe('BorosPairTicket — target mode on the closeOnlyALong fixture body', () => {
  it('a long target on market A grows past the held size and refuses', async () => {
    const [marketA, marketB] = pairContextBodies.closeOnlyALong.markets;
    server.use(
      http.get('/api/boros/agent', () => HttpResponse.json(env(agentStatus()))),
      http.get('/api/boros/pair/context', () => HttpResponse.json(env(pairContextBodies.closeOnlyALong))),
      http.post('/api/boros/pair/simulate', () =>
        HttpResponse.json(
          env({
            simulation: {
              ...simulation(),
              legA: simLeg({
                marketId: marketA.marketId,
                marketName: marketA.name,
                venue: marketA.venue,
                direction: 'long',
                sizing: {
                  currentSize: marketA.currentSize,
                  deltaSize: 3.8,
                  resultingSize: 5,
                  opposing: false,
                  flips: false,
                  clampedToClose: false,
                  orderSide: 'long',
                },
              }),
              legB: simLeg({
                marketId: marketB.marketId,
                marketName: marketB.name,
                venue: marketB.venue,
                direction: 'short',
                sizing: {
                  currentSize: marketB.currentSize,
                  deltaSize: -3.8,
                  resultingSize: -5,
                  opposing: false,
                  flips: false,
                  clampedToClose: false,
                  orderSide: 'short',
                },
              }),
            },
            gate: { blockers: [], warnings: [], requiresAcknowledgement: false, opposingLegs: [] },
            eligibility: { eligible: true, code: null, reason: null },
            simulatedAtMs: Date.now(),
            gasBalanceUsd: null,
          }),
        ),
      ),
    );
    const user = userEvent.setup();
    renderWithClient(
      <GuidedPrefillHarness
        prefill={{ base: 'ETH', longVenue: marketA.venue, shortVenue: marketB.venue, size: 5, sizeBase: 5 }}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'fire' }));

    const btn = await screen.findByRole('button', {
      name: 'Market A takes closes only. Switch to Close.',
    });
    expect(btn).toBeDisabled();
  });
});

function CloseFormHost() {
  const [active, setActive] = useState(true);
  return (
    <TabActiveContext.Provider value={active}>
      <button type="button" onClick={() => setActive(false)}>
        hide tab
      </button>
      <ClosePopover position={ethPosition} onDismiss={() => {}} />
    </TabActiveContext.Provider>
  );
}

describe('usePreviewDebounced — pauses on a hidden tab', () => {
  it('a hidden panel with an open close form sends no preview request', async () => {
    let hits = 0;
    server.use(
      ...baseHandlers(),
      http.post('/api/preview', async ({ request }) => {
        hits += 1;
        const { actions } = (await request.json()) as { actions: ActionInput[] };
        return HttpResponse.json(env<PreviewResponse>({ previews: [previewFor(actions[0])] }));
      }),
    );

    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderWithClient(<CloseFormHost />);
    await waitFor(() => expect(hits).toBeGreaterThan(0));

    hits = 0;
    fireEvent.click(screen.getByRole('button', { name: 'hide tab' }));
    await act(() => vi.advanceTimersByTimeAsync(4_000));
    expect(hits).toBe(0);
  });
});
