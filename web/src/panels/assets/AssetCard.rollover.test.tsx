/**
 * The roll-over path through the asset card: a pair whose rate legs mature
 * inside the 14-day window is counted once in the banner, flagged on its
 * card in the 4 Leg Pairs tab, and offered a Roll over button that opens
 * the popup. A pair outside the window gets none of it.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AssetBorosOpen, AssetGroup, AssetPerpOpen } from '../../api/types';
import { server } from '../../test/server';
import { renderWithClient } from '../../test/utils';
import { AssetCard } from './AssetCard';
import { deriveAsset } from './assetModel';

const DAY = 86_400;

const perp = (o: Partial<AssetPerpOpen> & { venue: string; side: 'LONG' | 'SHORT'; qty: number }): AssetPerpOpen => ({
  symbol: `${o.venue}_FUTURE_ETH_USDT`,
  notionalUsd: o.qty * 2500,
  entryPrice: 2500,
  markPrice: 2500,
  leverage: 10,
  upnlUsd: 0,
  fundingUsd: 0,
  feesUsd: 0,
  imUsd: o.qty * 250,
  openedAt: Math.floor(Date.now() / 1000) - 10 * DAY,
  ...o,
});

const yu = (o: Partial<AssetBorosOpen> & { marketId: number; venue: string; side: 'LONG' | 'SHORT'; sizeToken: number; maturity: number }): AssetBorosOpen => ({
  collateral: 'ETH',
  notionalUsd: o.sizeToken * 2500,
  entryApr: 0.08,
  markApr: 0.08,
  floatingApr: 0.09,
  settleUsd: 0,
  mtmUsd: 0,
  imUsd: o.sizeToken * 100,
  ...o,
});

/** One Gate/Hyperliquid pair of 100 ETH, maturing `days` from now. */
const book = (days: number): AssetGroup => {
  const now = Math.floor(Date.now() / 1000);
  return {
    base: 'ETH',
    priceUsd: 2500,
    earliestSec: now - 10 * DAY,
    perpOpen: [perp({ venue: 'GATE', side: 'LONG', qty: 100 }), perp({ venue: 'HYPERLIQUID', side: 'SHORT', qty: 100 })],
    perpClosed: [],
    borosOpen: [
      yu({ marketId: 1, venue: 'GATE', side: 'LONG', sizeToken: 100, maturity: now + days * DAY, entryApr: 0.04 }),
      yu({ marketId: 2, venue: 'HYPERLIQUID', side: 'SHORT', sizeToken: 100, maturity: now + days * DAY }),
    ],
    borosHistory: [],
  };
};

const renderCard = (group: AssetGroup) =>
  renderWithClient(
    <AssetCard
      group={group}
      derived={deriveAsset(group, {}, 0, Math.floor(Date.now() / 1000))}
      sinceSec={0}
      windowPending={false}
      onChangeSince={() => {}}
      exclusions={{}}
      onExclude={() => {}}
    />,
  );

beforeEach(() => {
  // The card polls the live positions for its close tickets; nothing here closes.
  server.use(
    http.get('/api/positions', () => HttpResponse.json({ positions: [] })),
    // The popup gates its confirm on the agent key's status.
    http.get('/api/boros/agent', () =>
      HttpResponse.json({ ok: true, data: { configured: true, root: null, rootMasked: null, accountId: 0, expiry: null, expired: false, canProvision: true }, meta: { ts: Date.now() } }),
    ),
    // Roll targets come from the pairable universe, not this book's own
    // legs: an empty list is what "nothing to roll into" looks like.
    http.get('/api/boros/pair/context', () =>
      HttpResponse.json({ ok: true, data: { markets: [], crossByToken: [], isolatedByMarket: [], defaultSlippageApr: 0.005, maxSlippageApr: 0.05 } }),
    ),
  );
});

describe('AssetCard — roll over', () => {
  it('"Show me" re-opens a rollable pair the user had folded, and scrolls it into view', async () => {
    const scrolled: Element[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    renderCard(book(10));
    await userEvent.click(screen.getByRole('button', { name: /pair can roll over/ }));
    const panel = screen.getByRole('tabpanel', { name: /4 Leg Pairs/ });
    // The pair's card is what lands at the top of the viewport.
    expect(scrolled).toHaveLength(1);
    expect(scrolled[0]).toContainElement(within(panel).getByRole('button', { name: /Gate \/ S Hyperliquid/ }));
    // Opened by default (it can roll) — fold it by hand.
    expect(within(panel).getByRole('button', { name: 'Roll over' })).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('button', { name: /Gate \/ S Hyperliquid/ }));
    expect(within(panel).queryByRole('button', { name: 'Roll over' })).not.toBeInTheDocument();
    // The banner must show it again, not leave the fold as the user left it.
    await userEvent.click(screen.getByRole('button', { name: /pair can roll over/ }));
    expect(within(panel).getByRole('button', { name: 'Roll over' })).toBeInTheDocument();
  });

  it('a pair maturing in 10 days: one banner, a flag and a button on its card, a placeholder popup', async () => {
    renderCard(book(10));
    // The banner counts pairs and sends the trader to the pairs tab — which
    // is the tab a card opens on (his call 2026-09-20), so leave it first.
    const banner = screen.getByRole('button', { name: /^1 pair can roll over/ });
    expect(screen.getByRole('tab', { name: /4 Leg Pairs/ })).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(screen.getByRole('tab', { name: /Funding Bundles/ }));
    expect(screen.getByRole('tab', { name: /Funding Bundles/ })).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(banner);
    expect(screen.getByRole('tab', { name: /4 Leg Pairs/ })).toHaveAttribute('aria-selected', 'true');

    // The summary row carries the FLAG; the action lives in the expansion —
    // and a rollable pair opens EXPANDED, so the action is already on
    // screen (his call 2026-09-18). No click on the row: that would fold it.
    const panel = screen.getByRole('tabpanel', { name: /4 Leg Pairs/ });
    expect(within(panel).getByText('ready to roll')).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('button', { name: 'Roll over' }));

    // The popup names the pair; with nothing to roll into there is no target,
    // so the pick page's "Roll over →" stays disabled.
    const dialog = screen.getByRole('dialog');
    // Venues only — the maturity heads the Exit card inside (his call 2026-09-18).
    expect(within(dialog).getByRole('heading', { name: 'Roll over — Gate / Hyperliquid' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Roll over →' })).toBeDisabled();
    // No maturity lists a market at BOTH venues, so there is nothing to roll
    // into -- the table says so rather than inventing a target.
    expect(await within(dialog).findByText(/No later maturity lists a market at BOTH venues/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('the banner is quiet between 14 and 7 days out, loud a week from settlement', () => {
    renderCard(book(10));
    const quiet = screen.getByRole('button', { name: /pair can roll over/ });
    expect(quiet).toHaveAttribute('data-tone', 'quiet');
    expect(within(quiet).queryByText(/matures in/)).not.toBeInTheDocument();
    cleanup();

    // Loud says what to do and why, nothing else — no count, no "you have".
    renderCard(book(5));
    const loud = screen.getByRole('button', { name: /Roll over now/ });
    expect(loud).toHaveAttribute('data-tone', 'loud');
    expect(within(loud).getByText('Gate / Hyperliquid matures in 5d')).toBeInTheDocument();
    expect(within(loud).queryByText(/can roll over/)).not.toBeInTheDocument();
  });

  it('a fifth of the pair rolling at a better rate makes the banner loud and flags the card', async () => {
    const now = Math.floor(Date.now() / 1000);
    const LATER = now + 45 * DAY;
    const row = (marketId: number, venue: string, maturity: number) => ({
      marketId,
      name: `${venue} ETH`,
      venue,
      base: 'ETH',
      tokenId: 3,
      collateral: 'ETH',
      maturity,
      midApr: 0.06,
      markApr: 0.06,
      maxRateDeviationApr: 0.02,
      isolatedOnly: false,
      onIsolatedMargin: false,
      isolatedHasPositionOrOrders: false,
      currentSize: 0,
      collateralPriceUsd: 2500,
    });
    const sims: Array<{ size: number; intent: string; legA: { slippageApr: number } }> = [];
    server.use(
      http.get('/api/boros/pair/context', () =>
        HttpResponse.json({
          ok: true,
          data: {
            markets: [row(1, 'Gate', now + 10 * DAY), row(2, 'Hyperliquid', now + 10 * DAY), row(11, 'Gate', LATER), row(12, 'Hyperliquid', LATER)],
            crossByToken: [],
            isolatedByMarket: [],
            defaultSlippageApr: 0.0025,
            maxSlippageApr: 0.1,
          },
        }),
      ),
      http.post('/api/boros/pair/simulate', async ({ request }) => {
        const body = (await request.json()) as { size: number; intent: string; legA: { marketId: number; direction: 'long' | 'short'; slippageApr: number }; legB: { marketId: number; direction: 'long' | 'short' } };
        sims.push(body);
        // A leg that opens from flat: the roll is charged its whole margin.
        const leg = (marketId: number, direction: 'long' | 'short') => ({
          marketId,
          marketName: `m${marketId}`,
          venue: marketId % 10 === 1 ? 'Gate' : 'Hyperliquid',
          base: 'ETH',
          direction,
          execApr: 0.06,
          worstApr: 0.06,
          estFillSize: body.size,
          shortfallSize: 0,
          bookStatus: 'ok',
          slippageExceeded: false,
          marginRequired: 1,
          slippageApr: 0.01,
          sizing: { currentSize: 0, deltaSize: body.size, resultingSize: body.size, opposing: false, flips: false, clampedToClose: false, orderSide: direction },
        });
        return HttpResponse.json({
          ok: true,
          data: {
            simulation: {
              legA: leg(body.legA.marketId, body.legA.direction),
              legB: leg(body.legB.marketId, body.legB.direction),
              receiveLeg: 'B',
              // 50% on notional: 20 ETH × $2,500 × 0.5 = $25k a year over
              // $10k of perp margin (a fifth of $50k) + 2 ETH of new Boros
              // margin ($5k) — 166.67% on capital, far above the row's rate.
              estSpreadApr: 0.5,
              worstSpreadApr: 0.45,
              costToCrossSize: 0.01,
              feeDragApr: 0.002,
              marginRequiredTotal: 2,
              hedgedSize: body.size,
              unhedgedSize: 0,
              collateral: 'ETH',
              collateralPriceUsd: 2500,
              secondsToMaturity: 45 * DAY,
              reasons: [],
            },
            gate: { blockers: [], warnings: [], requiresAcknowledgement: false, opposingLegs: [] },
            eligibility: { eligible: true, code: null, reason: null },
            simulatedAtMs: Date.now(),
            gasBalanceUsd: 5,
          },
        });
      }),
    );
    localStorage.setItem('crossex.strategy.v1', JSON.stringify({ address: '0x1111111111111111111111111111111111111111' }));
    renderCard(book(10));

    const panel = screen.getByRole('tabpanel', { name: /4 Leg Pairs/ });
    // A generous wait: the context and the probe are two round trips, and the
    // full suite runs this file under load.
    expect(await within(panel).findByText('roll opportunity', undefined, { timeout: 10_000 })).toBeInTheDocument();
    expect(within(panel).queryByText('ready to roll')).not.toBeInTheDocument();
    const banner = screen.getByRole('button', { name: /Roll over now/ });
    expect(banner).toHaveAttribute('data-tone', 'loud');
    // The new rate is the bold figure; the current one sits dimmed beside it.
    const promised = within(banner).getByText(/^\+?\d+\.\d+%$/);
    expect(promised).toHaveClass('font-semibold');
    expect(within(banner).getByText('vs 14.29% now')).toBeInTheDocument();
    expect(within(banner).getByText(/^Gate \/ Hyperliquid →/)).toBeInTheDocument();
    // The probe first priced a FIFTH of the 100 ETH held at the markets' own
    // seeded tolerance (half of 2%, floored to 1 s.f.) …
    const first = sims.find((b) => b.intent === 'open');
    expect(first?.size).toBe(20);
    expect(first?.legA.slippageApr).toBeCloseTo(0.01, 9);
    // … then the size the modal opens on (no fit reported → the whole
    // position), both batches, so the promise IS the modal's headline.
    await waitFor(() => expect(sims.some((b) => b.intent === 'close' && b.size === 100)).toBe(true), { timeout: 10_000 });
    await userEvent.click(within(panel).getByRole('button', { name: 'Roll over' }));
    const dialog = screen.getByRole('dialog');
    // The first option's headline: the 20px figure with "fixed" beside it.
    const headline = await within(dialog).findByText(
      (_, el) => el?.classList.contains('text-[20px]') === true && /^\+?\d+\.\d+%fixed$/.test(el.textContent ?? ''),
      undefined,
      { timeout: 10_000 },
    );
    expect(headline.textContent).toBe(`${promised.textContent}fixed`);
  }, 20_000);

  it('a pair maturing in 40 days: no banner, no flag, no button', () => {
    renderCard(book(40));
    expect(screen.queryByText(/can roll over|Roll over now/)).not.toBeInTheDocument();
    expect(screen.queryByText('ready to roll')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Roll over' })).not.toBeInTheDocument();
  });
});
