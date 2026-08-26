/** StrategyCard is prop-driven — no msw/QueryClient needed. The canonical
 * hedged HYPE book lives in test/fixtures (mirrors the live strategy). */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { CrossexPosition } from '../api/types';
import { ToastProvider } from '../components/Toast';
import { decodeSharePayload } from '../lib/shareCodec';
import {
  STRATEGY_MATURITY,
  makeCrossexPosition,
  makeStrategyLeg,
  makeStrategyRollup,
} from '../test/fixtures';
import { StrategyCard } from './StrategyCard';

/** Charts default collapsed — open them via the See-more tab below the box. */
const openDetails = () => fireEvent.click(screen.getByRole('button', { name: /see more/ }));

/** Cost assumptions are settings now — behind a dialog, so they cannot push the
 * card around when opened. Every helper below opens it first if it is shut. */
const openCosts = () => {
  const btn = screen.queryByRole('button', { name: /^Costs/ });
  if (btn) fireEvent.click(btn);
};

/** The exit toggle defaults to 'Include' — flip a rendered card to
 * Omit (rolling over) (no exit costs charged). */
const rollOver = () => {
  openCosts();
  fireEvent.click(screen.getByRole('radio', { name: 'Omit (rolling over)' }));
};

/** The exit assumption defaults to Omit now — opt in to the charged case. */
const includeExit = () => {
  openCosts();
  fireEvent.click(within(exitGroup()).getByRole('radio', { name: 'Include' }));
};

/** Both cost toggles carry an 'Include' radio — scope by the exit radiogroup. */
const exitGroup = () => {
  openCosts();
  return screen.getByRole('radiogroup', { name: 'Perp exit cost' });
};

/** The entry toggle defaults to 'Include' — flip a rendered card to Omit, i.e.
 * the perps were rolled into this maturity and paid their entry beforehand. */
const omitEntry = () => {
  openCosts();
  fireEvent.click(screen.getByRole('radio', { name: 'Omit (rolled over)' }));
};

const card = (
  over: Parameters<typeof makeStrategyRollup>[0] = {},
  props: Partial<React.ComponentProps<typeof StrategyCard>> = {},
) => (
  <StrategyCard
    strategy={makeStrategyRollup(over)}
    perpSource="connected-gate-account"
    {...props}
  />
);

describe('StrategyCard — a leg shared with another strategy', () => {
  it('scales the live uPnL by the leg\'s share instead of showing the whole position', () => {
    const legs = makeStrategyRollup().legs.map((l) =>
      l.kind === 'perp' && l.venue === 'HYPERLIQUID' ? { ...l, share: 0.6, mtmUsd: -600 } : l,
    );
    const live = new Map([
      [
        'HYPERLIQUID_FUTURE_HYPE_USDC',
        makeCrossexPosition({ symbol: 'HYPERLIQUID_FUTURE_HYPE_USDC', upnl: '-1000' }),
      ],
    ]);
    render(card({ legs }, { livePositions: live }));
    // The live uPnL now lives in the perp row's expanded detail rather than in
    // a table column, so open the row that carries it.
    // Row order follows the fixture's legs: [0] Bybit perp, [1] Hyperliquid
    // perp — the shared leg whose uPnL must be scaled.
    fireEvent.click(screen.getAllByRole('button', { name: 'toggle details' })[1]);
    // The venue's -1000 covers the whole leg; this card owns 60% of it, so
    // rendering -1000 here would double-count it against the sibling card.
    expect(screen.getByText('-600.00')).toBeInTheDocument();
    expect(screen.queryByText('-1,000.00')).not.toBeInTheDocument();
  });
});

describe('StrategyCard — hero tiers', () => {
  it('renders Fixed APR on Capital as the hero, with Capital and Profit by maturity', () => {
    render(card());
    rollOver();
    expect(screen.getByText('Fixed APY')).toBeInTheDocument();
    // Net PnL by maturity 282.21 over capital 41,320, annualized across the
    // 14-day life (start → maturity): 282.22 / (41,320 × 14/365) = 17.81%.
    expect(screen.getByText('+17.81%')).toBeInTheDocument();
    // Capital is a MAIN number; spread and ROI are captions under Fixed APY.
    expect(screen.getByText('Capital')).toBeInTheDocument();
    expect(screen.getByText('$41,320')).toBeInTheDocument();
    expect(screen.getByText(/7\.07% spread/)).toBeInTheDocument();
    // The projection is a MAIN number now, beside what the position has made
    // so far — the figure the whole trade is for, not small type under it.
    expect(screen.getByText('PnL at maturity')).toBeInTheDocument();
    expect(screen.getAllByText(/\+?\$282/).length).toBeGreaterThan(0);
    // PnL now is AFTER costs — what the account actually reflects. It carries
    // no subtitle: the before-cost step is a working, and the Costs dialog and
    // the waterfalls below already itemise it.
    expect(screen.getByText('PnL now')).toBeInTheDocument();
    expect(screen.getByText('-$115')).toBeInTheDocument();
    expect(screen.queryByText(/− \$114 costs/)).toBeNull();
    expect(screen.getByText('hedged ✓')).toBeInTheDocument();
  });

  it('hides PnL at maturity until every leg is placed', () => {
    render(
      card({
        hedgeChecks: { borosMatchRatio: 0.4, perpMatchRatio: 1, borosVsPerpRatio: 0.857, fullyHedged: false },
      }),
    );
    // On a half-built book there is no locked spread to project from, so the
    // projection would be an extrapolation from a hedge that does not exist.
    expect(screen.queryByText('PnL at maturity')).toBeNull();
    // What the position has actually made is still real, and still shown.
    expect(screen.getByText('PnL now')).toBeInTheDocument();
  });

  it('titles the card with the asset, both venues and the maturity', () => {
    render(card());
    // "HYPE · Bybit ⇄ Hyperliquid · matures <date> · <n> left". The old title
    // said "long Bybit short Hyperliquid", which named the PERP sides only —
    // on a card whose Boros legs can both be long, that contradicted the leg
    // table underneath it.
    expect(screen.getByText('HYPE')).toBeInTheDocument();
    expect(screen.getByText(/Bybit/)).toBeInTheDocument();
    expect(screen.getByText(/Hyperliquid/)).toBeInTheDocument();
    // The timeline's axis label also says 'matures', so assert on the count
    // rather than uniqueness: the point is that the TITLE now carries it.
    expect(screen.getAllByText(/matures/).length).toBeGreaterThan(0);
    // The locked spread is a caption under Fixed APY now, not a
    // parenthetical in the title.
    expect(screen.queryByText('(7.07% spread)')).not.toBeInTheDocument();
    expect(screen.getByText(/7\.07% spread/)).toBeInTheDocument();
    // The spread-lock assumption still lives in that number's tooltip.
    expect(
      screen.getByTitle(/Assumes 7\.07% locked on \$158\.8k since the strategy start/),
    ).toBeInTheDocument();
  });

  it('folds the checked exit parts into the hero numbers when included', () => {
    render(card());
    // The exit assumption now DEFAULTS to Omit — most positions are held to
    // maturity — so this test opts in to the charged case it is about.
    includeExit();
    // Profit: 282.21 − (80 + 49.16) = 153.05 → "+$153" (hero + target annotation).
    expect(screen.getAllByText(/\+?\$153/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/\+?\$282/)).not.toBeInTheDocument();
    // The APR follows that same net PnL: 153.06 / (41,320 × 14/365) = 9.66%,
    // below the 17.81% Roll figure (which never nets the exit cost).
    expect(screen.getByText('+9.66%')).toBeInTheDocument();
    expect(screen.queryByText('+17.81%')).not.toBeInTheDocument();
  });

  it('the "now" total is the CURRENT NET — the exit mode never moves it', () => {
    // Same raw realized net (−$114.91) on Roll over AND Close; only the
    // target (profit by maturity) reacts to the exit mode.
    const off = render(card());
    rollOver();
    openDetails();
    const level = (c: HTMLElement) =>
      Number(c.querySelector('[data-segment="now-total"]')?.getAttribute('data-level'));
    expect(level(off.container)).toBeCloseTo(-114.91, 2);
    off.unmount();
    const on = render(card());
    openDetails();
    expect(level(on.container)).toBeCloseTo(-114.91, 2);
    expect(screen.getAllByTitle(/Current PnL/).length).toBeGreaterThan(0);
  });

  it('the per-position exit-cost Include / Omit toggle moves the hero profit', async () => {
    render(card()); // defaults to Omit → the raw projection +$282
    expect(within(exitGroup()).getByRole('radio', { name: 'Omit (rolling over)' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await userEvent.click(within(exitGroup()).getByRole('radio', { name: 'Include' }));
    expect(screen.getAllByText(/\+?\$153/).length).toBeGreaterThan(0);
    // Omit (rolling over) → no exit costs charged: back to the raw projection +$282.
    await userEvent.click(screen.getByRole('radio', { name: 'Omit (rolling over)' }));
    expect(screen.getAllByText(/\+?\$282/).length).toBeGreaterThan(0);
    // The assumptions live in the toggle's tooltip.
    expect(
      screen.getByTitle(/maker\+hedge close .* exit slippage equal to the entry slippage/),
    ).toBeInTheDocument();
    // Back to Include = both exit parts folded in at once:
    // 282.21 − 80 − 49.16 = 153.05 → "+$153".
    await userEvent.click(within(exitGroup()).getByRole('radio', { name: 'Include' }));
    expect(screen.getAllByText(/\+?\$153/).length).toBeGreaterThan(0);
  });

  it('shows the strategy timeline bar (start → now → maturity) above the hero box', () => {
    const { container } = render(card());
    const bar = container.querySelector('[data-progress="maturity"]') as HTMLElement;
    expect(bar).not.toBeNull();
    // 2d elapsed of a 14d life ≈ 14.3% filled.
    const fill = [...bar.querySelectorAll('div')].find((d) => (d as HTMLElement).style.width) as HTMLElement;
    expect(parseFloat(fill.style.width)).toBeCloseTo((2 / 14) * 100, 0);
    // Start date + now marker + maturity land on the bar…
    expect(within(bar).getByText('now')).toBeInTheDocument();
    expect(within(bar).getByText(/matures \d{4}-\d{2}-\d{2} · \d+d left/)).toBeInTheDocument();
    expect(within(bar).getByTitle('Strategy start (the clock basis)')).toBeInTheDocument();
    // …and the old placements are gone (header text, "Xd in", mini bar).
    expect(screen.queryByText(/\d+d in/)).not.toBeInTheDocument();
    expect(container.querySelectorAll('[data-progress="maturity"]')).toHaveLength(1);
  });

  it('the waterfalls default collapsed; the hero stats and the see-more strip both toggle them, inside one border', async () => {
    const { container } = render(card());
    expect(container.querySelector('[data-waterfall]')).toBeNull();
    // The strip is its own button at the box's bottom edge…
    const strip = screen.getByRole('button', { name: /see more/ });
    expect(strip).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(strip);
    const waterfall = container.querySelector('[data-waterfall]');
    expect(waterfall).not.toBeNull();
    // …and the open waterfalls sit INSIDE the bordered box, ABOVE the strip.
    const open = screen.getByRole('button', { name: /see less/ });
    expect(open).toHaveAttribute('aria-expanded', 'true');
    const box = open.parentElement as HTMLElement;
    expect(box.contains(waterfall)).toBe(true);
    expect(waterfall!.compareDocumentPosition(open) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // …while the stats surface stays a click target of its own.
    const stats = screen.getByRole('button', { name: /Fixed APY/ });
    expect(stats).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(stats);
    expect(container.querySelector('[data-waterfall]')).toBeNull();
  });
});

describe('StrategyCard — profit waterfall + legend', () => {
  it('draws the waterfall bars; exit columns appear only when checked', () => {
    const { container, unmount } = render(card());
    rollOver();
    openDetails();
    const segs = [...container.querySelectorAll('[data-segment]')].map((el) =>
      el.getAttribute('data-segment'),
    );
    expect(segs).toContain('spread');
    expect(segs).toContain('profit');
    expect(segs).toContain('paid-perp-fees');
    expect(segs).toContain('paid-entry-slippage');
    expect(segs).toContain('paid-boros-trade');
    expect(segs).toContain('paid-boros-settle');
    expect(segs).toContain('future-boros-settle');
    expect(segs).toContain('mtm');
    expect(segs).not.toContain('future-exit-fees');
    expect(segs).not.toContain('future-exit-slippage');
    unmount();

    const { container: c2 } = render(card());
    includeExit(); // the exit assumption defaults to Omit now
    openDetails();
    const segs2 = [...c2.querySelectorAll('[data-segment]')].map((el) =>
      el.getAttribute('data-segment'),
    );
    expect(segs2).toContain('future-exit-fees');
    expect(segs2).toContain('future-exit-slippage');
  });

  it('the waterfall identity holds: the last cost lands exactly on the profit total', () => {
    const { container } = render(card()); // Roll over → profit 282.21
    rollOver();
    openDetails();
    const levels = [
      ...container.querySelectorAll('[data-kind^="cost"]:not([data-segment^="now-"])'),
    ].map((el) => Number(el.getAttribute('data-level')));
    expect(levels.at(-1)).toBeCloseTo(282.21, 2);
    const profit = container.querySelector('[data-segment="profit"]');
    expect(Number(profit?.getAttribute('data-level'))).toBeCloseTo(282.21, 2);
    expect(profit?.getAttribute('data-tone')).toBe('pos');
    expect(profit?.className).toContain('emerald');
  });

  it('the NOW waterfall decomposes the current net and lands exactly on it', () => {
    const { container } = render(card());
    rollOver();
    openDetails();
    // All components render from the fixture legs (perp FR, gross Boros FR,
    // settle paid, Boros MTM, perp entry, entry slip, boros entry).
    for (const key of [
      'now-perp-fr',
      'now-boros-fr',
      'now-settle-paid',
      'now-boros-mtm',
      'now-perp-entry',
      'now-entry-slip',
      'now-boros-entry',
      'now-total',
    ]) {
      expect(container.querySelector(`[data-segment="${key}"]`), key).not.toBeNull();
    }
    // Identity: the last component (Boros MtM — costs come first) lands on
    // the current net, and the end bar is the same number, drawn cyan.
    const last = container.querySelector('[data-segment="now-boros-mtm"]');
    expect(Number(last?.getAttribute('data-level'))).toBeCloseTo(-114.91, 2);
    const total = container.querySelector('[data-segment="now-total"]');
    expect(Number(total?.getAttribute('data-level'))).toBeCloseTo(-114.91, 2);
    expect(total?.getAttribute('data-tone')).toBe('neg');
    expect(total?.className).toContain('cyan');
    // Gross-settlements + settle-fee pair: gross = net + fees paid (no double count).
    // Levels after: costs (−65.01 −49.16 −3.77 −1.6 = −119.54) + perp FR 47.78
    // + gross Boros FR (−9.91 + 1.6 = −8.31) → −80.07.
    const grossFr = container.querySelector('[data-segment="now-boros-fr"]');
    expect(Number(grossFr?.getAttribute('data-level'))).toBeCloseTo(-119.54 + 47.78 - 8.31, 2);
  });

  it('a negative profit total renders rose with data-tone neg', () => {
    // Consistent fixture: 50 − paid 119.53 − future settle 10.06 = −79.59.
    const { container } = render(
      card({ spreadReturnUsd: 50, expectedPnlToMaturityUsd: 50 - 119.53 - 10.06 }),
    );
    rollOver();
    openDetails();
    const profit = container.querySelector('[data-segment="profit"]');
    expect(profit?.getAttribute('data-tone')).toBe('neg');
    expect(profit?.className).toContain('rose');
  });

  it('draws the MtM line below the zero axis for a negative current P&L', () => {
    const { container } = render(card()); // realizedPnlUsd −114.91
    rollOver();
    openDetails();
    const mtm = container.querySelector('[data-segment="mtm"]') as HTMLElement;
    expect(mtm.getAttribute('data-sign')).toBe('neg');
    const zero = container.querySelector('[data-axis="zero"]') as HTMLElement;
    expect(zero).not.toBeNull();
    expect(parseFloat(mtm.style.top)).toBeGreaterThan(parseFloat(zero.style.top));
  });

  it('omits the interior zero axis when nothing is negative (left chart alone)', () => {
    // Costs-first ordering means the now chart always dips below zero, so an
    // all-positive plot only exists without legs — which also pins that the
    // left waterfall carries NO now line of its own.
    const { container } = render(card({ legs: [], realizedPnlUsd: 50 }));
    rollOver();
    openDetails();
    expect(container.querySelector('[data-waterfall]')).not.toBeNull();
    expect(container.querySelector('[data-axis="zero"]')).toBeNull();
    expect(container.querySelector('[data-segment="mtm"]')).toBeNull();
    expect(container.querySelector('[data-segment="now-total"]')).toBeNull();
  });

  it('favorable (negative) entry slippage renders as an emerald UP step', () => {
    // Keep the fixture consistent: slippage 49.16 → −12.5 shifts paid.totalUsd
    // and the profit by the 61.66 difference.
    const base = makeStrategyRollup();
    const { container } = render(
      card({
        realizedPnlUsd: -65.75 + 12.5, // keep the now-waterfall identity exact
        expectedPnlToMaturityUsd: base.expectedPnlToMaturityUsd! + (49.16 - -12.5),
        feesUsd: {
          ...base.feesUsd,
          paid: {
            ...base.feesUsd.paid,
            perpEntrySlippageUsd: -12.5,
            totalUsd: base.feesUsd.paid.totalUsd - (49.16 - -12.5),
          },
        },
        // The parts decompose paid.* — they have to move with it, or the
        // card's own drift guard (rightly) complains.
        perpEntryCostParts: base.perpEntryCostParts.map((p) =>
          p.kind === 'slippage' ? { ...p, usd: p.id.endsWith('deal-a') ? -12.5 : 0 } : p,
        ),
      }),
    );
    rollOver();
    openDetails();
    const step = container.querySelector('[data-segment="paid-entry-slippage"]');
    // Every component carries its amount as a label (up-steps show +; ≥$10 at 0dp).
    expect(screen.getAllByText('+$13').length).toBeGreaterThan(0);
    expect(step).not.toBeNull();
    expect(step?.getAttribute('data-dir')).toBe('up');
    expect(step?.className).toContain('emerald');
  });

  it('null exit fees never render an exit column, even with the flag on (never a guess)', () => {
    const { container } = render(
      card({
        feesUsd: {
          ...makeStrategyRollup().feesUsd,
          future: { ...makeStrategyRollup().feesUsd.future, perpExitFeesUsd: null, totalUsd: null },
        },
      }),
    );
    includeExit(); // the test is about the flag being ON
    openDetails();
    expect(container.querySelector('[data-segment="future-exit-fees"]')).toBeNull();
    // Exit slippage is known — its column still renders.
    expect(container.querySelector('[data-segment="future-exit-slippage"]')).not.toBeNull();
  });
});

describe('StrategyCard — legs', () => {
  it('marks CrossEx perp legs with the ·CX violet chip; Boros legs stay unmarked', () => {
    render(card());
    expect(screen.getAllByTitle('via CrossEx (connected Gate account)')).toHaveLength(2);
    expect(screen.getAllByText('·CX')).toHaveLength(2);
    expect(screen.getAllByText('Boros')).toHaveLength(2);
  });

  it('a collapsed perp row expands to live Entry/Mark/Lev with actions (disabled without TradeFlow)', async () => {
    const live = new Map<string, CrossexPosition>([
      [
        'BYBIT_FUTURE_HYPE_USDT',
        makeCrossexPosition({
          symbol: 'BYBIT_FUTURE_HYPE_USDT',
          entryPrice: '60.4442',
          markPrice: '61.06',
          leverage: '20',
          maxLeverage: '50',
          upnl: '1497.24',
        }),
      ],
    ]);
    render(card({}, { livePositions: live }));
    // Legs order: BYBIT perp first (fixture order) — expand it.
    await userEvent.click(screen.getAllByLabelText('toggle details')[0]);
    expect(screen.getByText('60.4442')).toBeInTheDocument(); // entry
    expect(screen.getByText('61.06')).toBeInTheDocument(); // mark
    expect(screen.getByText('20x')).toBeInTheDocument();
    // Provider-less render → actions disabled, not hidden.
    // Close is on the row itself now (and still in the expanded detail), so
    // both are present — assert they are all disabled without TradeFlow.
    for (const b of screen.getAllByRole('button', { name: 'Close' })) {
      expect(b).toBeDisabled();
    }
    for (const b of screen.getAllByRole('button', { name: 'Lev' })) {
      expect(b).toBeDisabled();
    }
  });

  it('a perp row whose live position vanished explains itself instead of guessing', async () => {
    render(card({}, { livePositions: new Map() }));
    await userEvent.click(screen.getAllByLabelText('toggle details')[0]);
    expect(screen.getByText(/Live position not found/)).toBeInTheDocument();
  });
});

describe('StrategyCard — states', () => {
  it('matured: chip + relabeled profit + close-the-perps cue', () => {
    render(card({ secondsToMaturity: 0 }));
    expect(screen.getByText('matured')).toBeInTheDocument();
    // The matured projection is a caption under Net now: "→ $x realized".
    expect(screen.getAllByText(/realized/).length).toBeGreaterThan(0);
    expect(screen.getByText(/close the perp legs/)).toBeInTheDocument();
  });

  it('boros-only (unhedged): the Open-the-perp-legs CTA fires the prefill handler', async () => {
    const onOpenPerpLegs = vi.fn();
    const borosOnly = makeStrategyRollup({
      hedge: 'unhedged',
      legs: makeStrategyRollup().legs.filter((l) => l.kind === 'boros'),
      realizedPnlUsd: -48.52 - 49.16, // boros legs only — keep the identity exact
    });
    render(
      <StrategyCard
        strategy={borosOnly}
        perpSource="connected-gate-account"
        onOpenPerpLegs={onOpenPerpLegs}
      />,
    );
    expect(screen.getByText('unhedged')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Open the perp legs →' }));
    expect(onOpenPerpLegs).toHaveBeenCalledWith(borosOnly);
  });

  it('Boros-only mode (no Gate keys): caption invites connecting Gate keys', () => {
    render(
      <StrategyCard
        strategy={makeStrategyRollup({
          hedge: 'partial',
          legs: makeStrategyRollup().legs.filter((l) => l.kind === 'boros'),
          realizedPnlUsd: -48.52 - 49.16, // boros legs only — keep the identity exact
        })}
        perpSource={null}
      />,
    );
    expect(screen.getByText(/connect Gate keys to overlay perp legs/)).toBeInTheDocument();
  });

  it('never renders NaN for a missing mark APR and compacts sub-$1M notionals', () => {
    render(
      card({
        legs: [makeStrategyLeg({ notionalUsd: 250_000, entryApr: 0.08, markApr: undefined })],
        realizedPnlUsd: -39.24 - 49.16, // single-leg book — keep the identity exact
      }),
    );
    expect(screen.getByText('$250.0k')).toBeInTheDocument();
    // USDT-margined Boros legs stay pure-dollar — no token bracket, bare title.
    expect(screen.getByTitle('$250,000')).toHaveTextContent(/^\$250\.0k$/);
    // The column shows the LOCKED rate only — the live mark used to sit
    // beside it behind an arrow, which read as a rate that had moved, when the
    // whole point of the leg is that its rate cannot. A missing mark can no
    // longer produce NaN here because the mark is not rendered at all.
    const rate = screen.getByTitle(/The fixed APR this leg locked at entry/);
    expect(rate.textContent).toBe('8.00%');
    expect(rate.textContent).not.toMatch(/NaN/);
  });

  it('token-margined strategies bracket every leg — Boros in collateral, perps in base coin', () => {
    render(
      card({
        legs: [
          makeStrategyLeg({ notionalUsd: 250_000, collateral: 'ETH', notionalToken: 131.58 }),
          makeStrategyLeg({
            kind: 'perp',
            venue: 'BYBIT',
            side: 'LONG',
            notionalUsd: 250_000,
            collateral: undefined,
            notionalToken: 100,
            entryApr: undefined,
            markApr: undefined,
            floatingApr: undefined,
            maturity: undefined,
            symbol: 'BYBIT_FUTURE_HYPE_USDT',
          }),
        ],
        realizedPnlUsd: -39.24 * 2 - 49.16, // two default-netUsd legs — keep the identity exact
      }),
    );
    // Exact size in the tooltip, compact bracket in the cell.
    expect(screen.getByTitle('$250,000 = 131.58 ETH')).toHaveTextContent('$250.0k (131.6 ETH)');
    // The perp rides along in its base coin (the leg's HYPE default).
    expect(screen.getByTitle('$250,000 = 100 HYPE')).toHaveTextContent('$250.0k (100 HYPE)');
  });

  it('a USDT-margined book still sizes its PERPS in the base coin', () => {
    render(card());
    // Default book: 2 perps at $160,316 and 2 USDT-collateral Boros legs at
    // $158,800. Only the Boros rows stay pure-dollar — Boros notional is
    // denominated in the collateral, so "(158,800 USDT)" would restate the
    // dollars. A perp's coin size restates nothing, and used to be suppressed
    // purely because the Boros leg beside it was quoted in USDT.
    const perps = screen.getAllByTitle(/^\$160,316 = /);
    expect(perps).toHaveLength(2);
    for (const cell of perps) expect(cell).toHaveTextContent(/^\$160\.3k \([\d.,]+ HYPE\)$/);

    for (const cell of screen.getAllByTitle('$158,800')) {
      expect(cell).toHaveTextContent(/^\$158\.8k$/);
    }
    expect(screen.getAllByTitle('$158,800')).toHaveLength(2);
  });

  it('a position with NO Boros legs shows its perp sizes, whatever the collateral', () => {
    // The pure-dollar rule is about comparability with a USDT-quoted Boros leg.
    // With no Boros leg there is nothing to be incomparable with, and the coin
    // size is the whole point — a leg used to lose it on being detached.
    render(
      card({
        maturity: 0,
        hedge: 'unhedged',
        attribution: { source: 'unhedged', confidence: 'measured', pinned: false },
        legs: [
          makeStrategyLeg({
            kind: 'perp',
            venue: 'GATE',
            side: 'LONG',
            notionalUsd: 54,
            collateral: undefined,
            notionalToken: 0.023,
            entryApr: undefined,
            markApr: undefined,
            floatingApr: undefined,
            maturity: undefined,
            base: 'ETH',
            symbol: 'GATE_FUTURE_ETH_USDT',
          }),
        ],
      }),
    );
    expect(screen.getByTitle('$54 = 0.023 ETH')).toHaveTextContent('(0.023 ETH)');
  });

  it('unknown clock: no projection, no assumption caption, hero shows —', () => {
    render(
      card({
        spreadReturnUsd: null,
        expectedPnlToMaturityUsd: null,
        clockStartSec: null,
        elapsedSeconds: null,
        clockBasis: null,
      }),
    );
    expect(screen.getByTitle(/strategy start is unknown/)).toHaveTextContent('—');
    expect(screen.queryByTitle(/Assumes .* locked on/)).not.toBeInTheDocument();
  });
});

describe('StrategyCard — sizing gate', () => {
  // While the 4-leg book is being built, the headline numbers are hidden and
  // replaced by completion cues; Current PnL (real cash + MtM) stays visible.
  const buildingLegs = () => [
    makeStrategyLeg({ kind: 'perp', venue: 'BYBIT', side: 'LONG', notionalUsd: 300_000 }),
    makeStrategyLeg({ kind: 'perp', venue: 'HYPERLIQUID', side: 'SHORT', notionalUsd: 300_000 }),
    makeStrategyLeg({ kind: 'boros', venue: 'HYPERLIQUID', side: 'LONG', notionalUsd: 200_000 }),
    makeStrategyLeg({ kind: 'boros', venue: 'BYBIT', side: 'SHORT', notionalUsd: 500_000 }),
  ];

  it('hides APR / Capital / PNL and cues the Boros gap while the book is being built', () => {
    render(
      card({
        legs: buildingLegs(),
        hedgeChecks: {
          borosMatchRatio: 0.4,
          perpMatchRatio: 1,
          borosVsPerpRatio: 0.857,
          fullyHedged: false,
        },
      }),
    );
    expect(screen.queryByText(/on \$41,320/)).toBeNull(); // capital hidden
    // Fixed APY is the one hero that hides; Net always renders, and the
    // workings caption is replaced by the "appears once…" line.
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(1);
    // All four sides are present here (Boros LONG 200k vs SHORT 500k), so this
    // is a SIZE mismatch, not a book with legs missing — the copy says so, and
    // the cue below still names the exact side and amount to add.
    expect(screen.getByText(/Sizes don’t match/)).toBeInTheDocument();
    // The gap is stated ON the undersized leg's row, in its own unit, rather
    // than as a percentage in a paragraph under the table.
    expect(screen.getAllByText(/short/).length).toBeGreaterThan(0);
    expect(screen.getByText('PnL now')).toBeInTheDocument();
  });

  it('calls a size mismatch what it is, and marks the offending legs', () => {
    // All four sides present in the right directions — this is NOT a book with
    // legs missing, so the copy must not send the user looking for one. The
    // SHORT perp is half the Boros leg it offsets; the marker names the gap in
    // the leg's own unit rather than a match percentage.
    render(
      card({
        legs: [
          makeStrategyLeg({ kind: 'perp', venue: 'OKX', side: 'LONG', notionalUsd: 500_000 }),
          makeStrategyLeg({
            kind: 'perp',
            venue: 'HYPERLIQUID',
            side: 'SHORT',
            notionalUsd: 250_000,
          }),
          makeStrategyLeg({ kind: 'boros', venue: 'OKX', side: 'LONG', notionalUsd: 500_000 }),
          makeStrategyLeg({
            kind: 'boros',
            venue: 'HYPERLIQUID',
            side: 'SHORT',
            notionalUsd: 500_000,
          }),
        ],
        hedgeChecks: {
          borosMatchRatio: 1,
          perpMatchRatio: 0.5,
          borosVsPerpRatio: 0.75,
          fullyHedged: false,
        },
      }),
    );
    expect(screen.getByText(/Sizes don’t match/)).toBeInTheDocument();
    expect(screen.queryByText(/Incomplete position/)).toBeNull();
    // The undersized leg is flagged on its own row.
    expect(screen.getAllByText(/short/).length).toBeGreaterThan(0);
  });

  it('drops the hedge-shape warnings the rows now carry, and keeps every other one', () => {
    // The server describes the book's shape in prose AND the card now shows it
    // structurally (missing rows, short/over-by chips, the banner). Rendering
    // both puts the table back on screen as a paragraph — the amber block this
    // redesign removed. Everything that ISN'T shape, though, qualifies numbers
    // the card otherwise shows as exact, and must survive.
    const shape = [
      'BINANCE legs are imbalanced by $1,850,152 of notional — the locked rate only covers the matched part.',
      'No BINANCE perp found for ETH in the connected Gate account — that side’s floating rate is unhedged.',
      'No matching perp legs for ETH in the connected Gate account — the floating side is unhedged (or hedged elsewhere).',
      'No Boros legs in this ETH position — the funding spread is floating, not locked.',
    ];
    const kept = [
      'Entry slippage for ETH is unknown (not a simple 1-long/1-short perp pair with known entries) — it is excluded from the cost totals.',
      'The HYPERLIQUID ETH perp predates the strategy start — its funding number includes pre-lock accrual (the CrossEx funding ledger doesn’t cover that window).',
      'No trade history found for Hyperliquid ETH 25 Sep 2026 — trade fees may be understated and the open time is unknown.',
      'Couldn’t read your CrossEx fill history right now (auth) — positions sharing a venue leg are split by price and open-time proximity until it returns.',
    ];
    render(card({ warnings: [...shape, ...kept] }));
    for (const w of shape) expect(screen.queryByText(w)).toBeNull();
    for (const w of kept) expect(screen.getByText(w)).toBeInTheDocument();
  });

  it('treats a lone leg as an orphan — no completion cues, no missing-leg arithmetic', () => {
    render(
      card({
        legs: [
          makeStrategyLeg({ kind: 'perp', venue: 'HYPERLIQUID', side: 'SHORT', notionalUsd: 104_743 }),
        ],
        hedgeChecks: { borosMatchRatio: 0, perpMatchRatio: 0, borosVsPerpRatio: 0, fullyHedged: false },
      }),
    );
    expect(screen.getByText('Orphan leg')).toBeInTheDocument();
    expect(screen.getByText(/Not part of any position/)).toBeInTheDocument();
    // An orphan is not a half-built strategy: it must not be told to complete
    // a hedge it was never part of.
    expect(screen.queryByText(/Incomplete position/)).toBeNull();
    expect(screen.queryByText(/matched/)).toBeNull();
    expect(screen.queryByText(/lock the rate on both sides/)).toBeNull();
  });

  it('cues a missing perp leg with its venue and size', () => {
    render(
      card({
        legs: [
          makeStrategyLeg({ kind: 'perp', venue: 'BYBIT', side: 'LONG', notionalUsd: 160_000 }),
          makeStrategyLeg({ kind: 'boros', venue: 'HYPERLIQUID', side: 'SHORT', notionalUsd: 160_000 }),
          makeStrategyLeg({ kind: 'boros', venue: 'BYBIT', side: 'LONG', notionalUsd: 160_000 }),
        ],
        hedgeChecks: { borosMatchRatio: 1, perpMatchRatio: 0, borosVsPerpRatio: 0.5, fullyHedged: false },
      }),
    );
    // The absent leg gets its own dimmed row, in the grid position it would
    // occupy, carrying the size it would need and the way to open it.
    expect(screen.getByText('missing')).toBeInTheDocument();
    expect(screen.getByText('≈$160.0k')).toBeInTheDocument();
    // No onOpenPerpLegs wired in this render, so the row states the fact
    // rather than offering an action it cannot perform.
    expect(screen.getByText('not open')).toBeInTheDocument();
  });

  it('an undersized perp pair cues the exact top-up for EACH leg', () => {
    // Both perp legs exist but small: every cue must say how much more to open
    // per venue+side, never one aggregate "add $X of perp notional".
    render(
      card({
        legs: [
          makeStrategyLeg({ kind: 'perp', venue: 'HYPERLIQUID', side: 'SHORT', notionalUsd: 200_000 }),
          makeStrategyLeg({ kind: 'perp', venue: 'OKX', side: 'LONG', notionalUsd: 300_000 }),
          makeStrategyLeg({ kind: 'boros', venue: 'HYPERLIQUID', side: 'SHORT', notionalUsd: 500_000 }),
          makeStrategyLeg({ kind: 'boros', venue: 'OKX', side: 'LONG', notionalUsd: 500_000 }),
        ],
        hedgeChecks: {
          borosMatchRatio: 1,
          perpMatchRatio: 200_000 / 300_000,
          borosVsPerpRatio: 0.5,
          fullyHedged: false,
        },
      }),
    );
    // Both undersized legs are marked on their own rows.
    expect(screen.getAllByText(/short/).length).toBeGreaterThanOrEqual(2);
    // The lagging leg is marked on its own row, in its own unit.
    expect(screen.getAllByText(/short/).length).toBeGreaterThan(0);
  });

  it('offers a pair CTA sized to the safe top-up when BOTH perp legs lag', () => {
    const onOpen = vi.fn();
    render(
      card(
        {
          legs: [
            makeStrategyLeg({ kind: 'perp', venue: 'HYPERLIQUID', side: 'SHORT', notionalUsd: 200_000 }),
            makeStrategyLeg({ kind: 'perp', venue: 'OKX', side: 'LONG', notionalUsd: 300_000 }),
            makeStrategyLeg({ kind: 'boros', venue: 'HYPERLIQUID', side: 'SHORT', notionalUsd: 500_000 }),
            makeStrategyLeg({ kind: 'boros', venue: 'OKX', side: 'LONG', notionalUsd: 500_000 }),
          ],
          hedgeChecks: {
            borosMatchRatio: 1,
            perpMatchRatio: 200_000 / 300_000,
            borosVsPerpRatio: 0.5,
            fullyHedged: false,
          },
        },
        { onOpenPerpLegs: onOpen },
      ),
    );
    const cta = screen.getByRole('button', { name: /Complete the hedge/ });
    fireEvent.click(cta);
    // min(HL 300k, OKX 200k) — the largest pair that overshoots neither leg.
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0][1]).toBe(200_000);
    expect(onOpen.mock.calls[0][0].base).toBe('HYPE');
  });

  it('no pair CTA when only one leg lags — a single order fixes that, not a pair', () => {
    render(
      card(
        {
          legs: [
            makeStrategyLeg({ kind: 'perp', venue: 'HYPERLIQUID', side: 'SHORT', notionalUsd: 500_000 }),
            makeStrategyLeg({ kind: 'perp', venue: 'OKX', side: 'LONG', notionalUsd: 200_000 }),
            makeStrategyLeg({ kind: 'boros', venue: 'HYPERLIQUID', side: 'SHORT', notionalUsd: 500_000 }),
            makeStrategyLeg({ kind: 'boros', venue: 'OKX', side: 'LONG', notionalUsd: 500_000 }),
          ],
          hedgeChecks: {
            borosMatchRatio: 1,
            perpMatchRatio: 0.4,
            borosVsPerpRatio: 0.7,
            fullyHedged: false,
          },
        },
        { onOpenPerpLegs: vi.fn() },
      ),
    );
    expect(screen.queryByRole('button', { name: /Execute a pair/ })).toBeNull();
  });

  it('a missing PERP row opens ONE perp leg, not the pair', () => {
    const onOpenPerpLeg = vi.fn();
    const onOpenPerpLegs = vi.fn();
    render(
      card(
        {
          // Both Boros legs on, only the OKX perp present: exactly one perp
          // leg is missing, on the HYPERLIQUID side.
          legs: [
            makeStrategyLeg({ kind: 'boros', venue: 'HYPERLIQUID', side: 'SHORT', notionalUsd: 400_000 }),
            makeStrategyLeg({ kind: 'boros', venue: 'OKX', side: 'LONG', notionalUsd: 400_000 }),
            makeStrategyLeg({ kind: 'perp', venue: 'OKX', side: 'LONG', notionalUsd: 400_000 }),
          ],
          hedgeChecks: {
            borosMatchRatio: 1,
            perpMatchRatio: 0,
            borosVsPerpRatio: 0.5,
            fullyHedged: false,
          },
        },
        { onOpenPerpLeg, onOpenPerpLegs },
      ),
    );
    const opens = screen.getAllByRole('button', { name: /^Open$/ });
    const perpOpen = opens.find((b) => /single perp ticket/.test(b.getAttribute('title') ?? ''));
    expect(perpOpen).toBeDefined();
    fireEvent.click(perpOpen!);

    // The PAIR callback must not fire: this position is short ONE leg, and
    // opening two would overshoot the hedge it is trying to complete.
    expect(onOpenPerpLegs).not.toHaveBeenCalled();
    expect(onOpenPerpLeg).toHaveBeenCalledTimes(1);
    const row = onOpenPerpLeg.mock.calls[0][1];
    expect(row.venue).toBe('HYPERLIQUID');
    expect(row.side).toBe('SHORT');
    expect(row.targetUsd).toBe(400_000);
  });

  it('offers NO perp Open on a venue with no CrossEx listing', () => {
    // LIGHTER is a live Boros venue with no CrossEx perp behind it. Offering
    // "Open" there armed a ticket that could never resolve a symbol — the rail
    // switched to Single and the picker sat blank with nothing said. A row that
    // cannot be acted on must not pretend otherwise.
    const onOpenPerpLeg = vi.fn();
    render(
      card(
        {
          base: 'ETH',
          legs: [
            makeStrategyLeg({ kind: 'boros', venue: 'LIGHTER', side: 'SHORT', notionalUsd: 500 }),
            makeStrategyLeg({ kind: 'boros', venue: 'GATE', side: 'LONG', notionalUsd: 500 }),
            makeStrategyLeg({ kind: 'perp', venue: 'GATE', side: 'LONG', notionalUsd: 500 }),
          ],
          hedgeChecks: {
            borosMatchRatio: 1,
            perpMatchRatio: 0,
            borosVsPerpRatio: 0.5,
            fullyHedged: false,
          },
        },
        { onOpenPerpLeg },
      ),
    );
    const opens = screen.queryAllByRole('button', { name: /^Open$/ });
    const perpOpens = opens.filter((b) => /single perp ticket/.test(b.getAttribute('title') ?? ''));
    // The only missing perp is the LIGHTER one, and it cannot be opened here.
    expect(perpOpens).toHaveLength(0);
  });

  it('a missing PERP row carries the BOROS leg\'s token size, not just USD', () => {
    // Hubert's card: both Boros legs on a BTC-collateral market, NO perps yet.
    // The token size has to come from the Boros leg at the SAME venue — the
    // leg that actually sets this perp's size. Requiring a same-KIND twin
    // found nothing here (there are no perps at all), so the row carried no
    // token size and the ticket fell back to sizing in USDT.
    const onOpenPerpLeg = vi.fn();
    render(
      card(
        {
          base: 'BTC',
          legs: [
            makeStrategyLeg({
              kind: 'boros',
              venue: 'GATE',
              side: 'LONG',
              notionalUsd: 771,
              notionalToken: 0.01,
              collateral: 'BTC',
            }),
            makeStrategyLeg({
              kind: 'boros',
              venue: 'HYPERLIQUID',
              side: 'SHORT',
              notionalUsd: 771,
              notionalToken: 0.01,
              collateral: 'BTC',
            }),
          ],
          hedgeChecks: {
            borosMatchRatio: 1,
            perpMatchRatio: 0,
            borosVsPerpRatio: 0,
            fullyHedged: false,
          },
        },
        { onOpenPerpLeg },
      ),
    );
    const opens = screen.getAllByRole('button', { name: /^Open$/ });
    const perpOpen = opens.find((b) => /single perp ticket/.test(b.getAttribute('title') ?? ''));
    expect(perpOpen).toBeDefined();
    fireEvent.click(perpOpen!);

    const row = onOpenPerpLeg.mock.calls[0][1];
    // The pin: WITHOUT these two the prefill has no base quantity to offer and
    // silently sizes the order in USDT.
    expect(row.targetToken).toBe(0.01);
    expect(row.targetUnit).toBe('BTC');
  });

  it('a missing BOROS row opens that one leg, at that row\'s size', () => {
    const onOpenBoros = vi.fn();
    render(
      card(
        {
          // Both perps on, and only the OKX Boros leg is present: the card is
          // missing exactly one Boros leg, on the HYPERLIQUID side.
          legs: [
            makeStrategyLeg({ kind: 'perp', venue: 'HYPERLIQUID', side: 'SHORT', notionalUsd: 400_000 }),
            makeStrategyLeg({ kind: 'perp', venue: 'OKX', side: 'LONG', notionalUsd: 400_000 }),
            makeStrategyLeg({ kind: 'boros', venue: 'OKX', side: 'LONG', notionalUsd: 400_000 }),
          ],
          hedgeChecks: {
            borosMatchRatio: 0,
            perpMatchRatio: 1,
            borosVsPerpRatio: 0.5,
            fullyHedged: false,
          },
        },
        { onOpenBorosLegs: onOpenBoros },
      ),
    );
    const opens = screen.getAllByRole('button', { name: /^Open$/ });
    // Every missing row offers one, and the Boros row's is among them.
    const borosOpen = opens.find((b) => /Boros ticket/.test(b.getAttribute('title') ?? ''));
    expect(borosOpen).toBeDefined();
    fireEvent.click(borosOpen!);

    expect(onOpenBoros).toHaveBeenCalledTimes(1);
    const only = onOpenBoros.mock.calls[0][1];
    // The narrowing argument is the whole point: without it the ticket opens a
    // PAIR and creates the OKX leg this card already holds.
    expect(only).toBeDefined();
    expect(only.side).toBe('SHORT');
    expect(only.sizeUsd).toBe(400_000);
  });

  it('no pair CTA when the book is fully hedged', () => {
    render(card({}, { onOpenPerpLegs: vi.fn() }));
    expect(screen.queryByRole('button', { name: /Execute a pair/ })).toBeNull();
  });

  it('cues connecting Gate when the perp side is invisible', () => {
    render(
      card(
        { hedgeChecks: { borosMatchRatio: 1, perpMatchRatio: 0, borosVsPerpRatio: 0, fullyHedged: false } },
        { perpSource: null },
      ),
    );
    // Said on the perp rows themselves — "cannot see it" is a property of
    // those legs, not of the position as a whole.
    expect(
      screen.getAllByTitle(/Connect the Gate account to verify the perp side/).length,
    ).toBeGreaterThan(0);
  });

  it('hides the title spread too — a half-built Boros book does not price one', () => {
    // A lone Boros leg is the worst case: returns.ts divides by gross/2 for the
    // canonical two-leg book, so one leg reports DOUBLE its own rate as the
    // "spread". Never print that number.
    render(
      card({
        spread: 0.1283,
        legs: [makeStrategyLeg({ kind: 'boros', venue: 'BYBIT', side: 'SHORT', notionalUsd: 160_000 })],
        hedgeChecks: { borosMatchRatio: 0, perpMatchRatio: 0, borosVsPerpRatio: 0, fullyHedged: false },
      }),
    );
    expect(screen.queryByText(/12\.83%/)).toBeNull();
    expect(screen.queryByTitle(/Assumes .* locked on/)).toBeNull();
    expect(screen.queryByText(/7\.07% spread/)).toBeNull();
    // A lone leg is an ORPHAN, so the Fixed APY block is absent entirely rather
    // than showing "—" and promising a number once the legs arrive: this leg
    // has no legs to wait for. Net is the only figure it can honestly show.
    expect(screen.queryByText('Fixed APY')).toBeNull();
    expect(screen.queryByText(/appears once every leg is in place/)).toBeNull();
    expect(screen.getByText('PnL now')).toBeInTheDocument();
  });

  it('shows the numbers and no note when fully hedged (the fixture default)', () => {
    render(card());
    expect(screen.getByText('$41,320')).toBeInTheDocument();
    // A complete book shows its workings instead of the placeholder line.
    expect(screen.queryByText(/appears once every leg is in place/)).toBeNull();
    expect(screen.getByText(/7\.07% spread/)).toBeInTheDocument();
    expect(screen.queryByText(/Incomplete position/)).toBeNull();
    expect(screen.queryByText(/Sizes don’t match/)).toBeNull();
  });
});

/** A perp rolled into this maturity paid its fees and crossed its spread in a
 * previous life — Gate still reports both against the position, so the card
 * would otherwise bill this strategy for money it never spent. */
describe('StrategyCard — perp entry cost', () => {
  it('hands back exactly the entry cost the strategy was charged', () => {
    render(card());
    rollOver(); // isolate the entry toggle from the exit one
    expect(screen.getAllByText(/\+?\$282/).length).toBeGreaterThan(0);
    // PnL now is AFTER costs, so it carries the entry charge: −$115.
    expect(screen.getByText('-$115')).toBeInTheDocument();

    omitEntry();
    // Add-back = perp trading fees 65.01 + entry slippage 49.16 = 114.17.
    // Projection 282.21 + 114.17 = 396.38 → "+$396"; APR 396.38 / (41,320 × 14/365).
    expect(screen.getAllByText(/\+?\$396/).length).toBeGreaterThan(0);
    expect(screen.getByText('+25.01%')).toBeInTheDocument();
    // Handing back the entry cost moves PnL now too: −114.91 + 114.17 = −0.74.
    expect(screen.getByText('-$1')).toBeInTheDocument();
    expect(screen.queryByText('-$115')).not.toBeInTheDocument();
  });

  it('moves the "now" line — the deliberate contrast with the exit toggle', () => {
    const { container } = render(card());
    rollOver();
    openDetails();
    const level = () =>
      Number(container.querySelector('[data-segment="now-total"]')?.getAttribute('data-level'));
    expect(level()).toBeCloseTo(-114.91, 2);
    omitEntry();
    expect(level()).toBeCloseTo(-0.74, 2);
  });

  it('composes with the exit toggle — the two assumptions stay independent', () => {
    render(card());
    includeExit(); // exit now defaults to Omit — this test is about BOTH on
    omitEntry();
    // 282.21 + 114.17 − (80 + 49.16) = 267.22. The exit slippage still folds in
    // at its FULL magnitude even though the server seeds it from the very entry
    // slippage just handed back — you still have to cross back out.
    expect(screen.getAllByText(/\+?\$267/).length).toBeGreaterThan(0);
    expect(screen.getByText('+16.86%')).toBeInTheDocument();
  });

  it('drops the entry bars from BOTH waterfalls, and both identities still land', () => {
    const { container } = render(card());
    rollOver();
    omitEntry();
    openDetails();
    const segs = [...container.querySelectorAll('[data-segment]')].map((el) =>
      el.getAttribute('data-segment'),
    );
    for (const gone of [
      'paid-perp-fees',
      'paid-entry-slippage',
      'now-perp-entry',
      'now-entry-slip',
    ]) {
      expect(segs).not.toContain(gone);
    }
    // Costs this strategy really did pay are untouched.
    expect(segs).toContain('paid-boros-trade');
    expect(segs).toContain('now-boros-entry');
    // Both running levels still land on their authoritative totals (the same
    // invariant ProfitBars' dev-only drift warning guards).
    const lastCost = [
      ...container.querySelectorAll('[data-kind^="cost"]:not([data-segment^="now-"])'),
    ].at(-1);
    expect(Number(lastCost?.getAttribute('data-level'))).toBeCloseTo(396.38, 2);
    expect(
      Number(container.querySelector('[data-segment="profit"]')?.getAttribute('data-level')),
    ).toBeCloseTo(396.38, 2);
    expect(
      Number(container.querySelector('[data-segment="now-total"]')?.getAttribute('data-level')),
    ).toBeCloseTo(-0.74, 2);
  });
});

/** The itemised entry cost. The fixture is a book built across TWO executions
 * (deal-a $30.00, deal-b $19.16) plus one fee row per live leg ($20.55 Bybit,
 * $44.46 Hyperliquid) — 4 parts totalling the 65.01 + 49.16 aggregates. */
describe('StrategyCard — itemised entry cost', () => {
  const itemise = () => fireEvent.click(itemiseBtn());
  const entryGroup = () => (openCosts(), screen.getByRole('radiogroup', { name: 'Perp entry cost' }));
  const includeRadio = () => within(entryGroup()).getByRole('radio', { name: 'Include' });
  /** The disclosure — its label carries the "n of N charged" count. */
  const itemiseBtn = () => {
    openCosts();
    return screen.getByRole('button', { name: 'Itemise the perp entry cost' });
  };

  /** Two executions can carry identical prose, so address a row by its part id
   * — the same identity the ticks are persisted under. */
  // The itemiser lives in the cost-settings dialog, which is PORTALED to
  // <body> — scoping this to the render container would miss it.
  const rowFor = (_container: HTMLElement, partId: string) =>
    document.body.querySelector(`[data-part="${partId}"] input`) as HTMLInputElement;

  it('counts what is charged, and lists every execution with its date', () => {
    render(card());
    expect(itemiseBtn()).toHaveTextContent('4 of 4');
    itemise();
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(4);
    expect(boxes.every((b) => (b as HTMLInputElement).checked)).toBe(true);
    // Slippage rows are per execution; fee rows say they are not.
    expect(screen.getAllByText('Entry slip')).toHaveLength(2);
    expect(screen.getAllByText('position life')).toHaveLength(2);
  });

  it('un-ticking one execution hands back exactly that part', () => {
    const { container } = render(card());
    rollOver(); // isolate from the exit assumption
    expect(screen.getAllByText(/\+?\$282/).length).toBeGreaterThan(0);
    itemise();
    fireEvent.click(rowFor(container, 'slip:deal:deal-a'));
    // deal-a cost $30.00 → 282.21 + 30 = 312.21.
    expect(screen.getAllByText(/\+?\$312/).length).toBeGreaterThan(0);
    expect(itemiseBtn()).toHaveTextContent('3 of 4');
    // PnL now moves with it: −114.91 + 30 = −84.91.
    expect(screen.getByText('-$85')).toBeInTheDocument();
  });

  it('shrinks the waterfall bars rather than dropping them, and still lands', () => {
    const { container } = render(card());
    rollOver();
    itemise();
    fireEvent.click(rowFor(container, 'slip:deal:deal-a'));
    openDetails();
    const segs = [...container.querySelectorAll('[data-segment]')].map((el) =>
      el.getAttribute('data-segment'),
    );
    // Still charged 19.16 of slippage, so the bar stays — it just got smaller.
    expect(segs).toContain('paid-entry-slippage');
    expect(segs).toContain('paid-perp-fees');
    expect(
      Number(container.querySelector('[data-segment="profit"]')?.getAttribute('data-level')),
    ).toBeCloseTo(312.21, 2);
    expect(
      Number(container.querySelector('[data-segment="now-total"]')?.getAttribute('data-level')),
    ).toBeCloseTo(-84.91, 2);
  });

  it('remembers the ticks across a remount — it records a fact, not a preference', () => {
    const first = render(card());
    itemise();
    fireEvent.click(rowFor(first.container, 'slip:deal:deal-a'));
    expect(itemiseBtn()).toHaveTextContent('3 of 4');
    first.unmount();

    render(card());
    expect(itemiseBtn()).toHaveTextContent('3 of 4');
    itemise();
    expect(screen.getAllByRole('checkbox').filter((b) => (b as HTMLInputElement).checked)).toHaveLength(3);
  });

  it('does not carry one account\'s ticks onto another\'s identical position', () => {
    // A strategyId is `HYPE#BYBIT-HYPERLIQUID#a` — coin, venues, evidence
    // tier, and nothing about whose account it is. Two accounts running the
    // same pair share it, so without the book in the key one account's
    // un-ticked fills quietly reduced the other's cost basis.
    const first = render(card({}, { bookId: '0xaaa|gate-a' }));
    itemise();
    fireEvent.click(rowFor(first.container, 'slip:deal:deal-a'));
    expect(itemiseBtn()).toHaveTextContent('3 of 4');
    first.unmount();

    render(card({}, { bookId: '0xaaa|gate-b' }));
    expect(itemiseBtn()).toHaveTextContent('4 of 4');
  });

  it('clicking the Include segment itself opens and closes the itemisation', () => {
    render(card());
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    // Already the selected option, so the click cannot be a "change" — it is
    // the disclosure header.
    fireEvent.click(includeRadio());
    expect(screen.getAllByRole('checkbox')).toHaveLength(4);
    expect(itemiseBtn()).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(includeRadio());
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('coming back from Omit opens it — you just chose to charge the entry cost', () => {
    render(card());
    omitEntry();
    fireEvent.click(includeRadio());
    expect(screen.getAllByRole('checkbox')).toHaveLength(4);
  });

  it('hides the itemisation under Omit — there is nothing left to pick', () => {
    render(card());
    itemise();
    expect(screen.getAllByRole('checkbox')).toHaveLength(4);
    omitEntry();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(
      screen.queryByRole('button', { name: 'Itemise the perp entry cost' }),
    ).not.toBeInTheDocument();
  });

  it('says so plainly when a position could not be itemised', () => {
    render(card({ perpEntryCostParts: [] }));
    expect(itemiseBtn()).toHaveTextContent('itemise'); // no count to show
    itemise();
    expect(screen.getByText(/couldn't be itemised/)).toBeInTheDocument();
  });
});

describe('StrategyCard — share', () => {
  const shareBtn = () => screen.queryByRole('button', { name: 'Share ↗' });

  it('offers Share on a fully hedged, unmatured book', () => {
    render(card());
    expect(shareBtn()).toBeInTheDocument();
  });

  it('hides Share while the book is partial, unhedged, or matured', () => {
    render(
      card({
        hedge: 'partial',
        hedgeChecks: {
          borosMatchRatio: 1,
          perpMatchRatio: 0.5,
          borosVsPerpRatio: 0.5,
          fullyHedged: false,
        },
      }),
    );
    expect(shareBtn()).not.toBeInTheDocument();
    cleanup();
    render(card({ secondsToMaturity: 0 }));
    expect(shareBtn()).not.toBeInTheDocument();
  });

  it('hides Share when the sizing checks fail even while hedge reads hedged', () => {
    // hedge === 'hedged' with fullyHedged === false exercises the SECOND gate
    // condition on its own — the partial-hedge case above short-circuits on the
    // first and would mask a dropped fullyHedged check.
    render(
      card({
        hedge: 'hedged',
        hedgeChecks: {
          borosMatchRatio: 1,
          perpMatchRatio: 1,
          borosVsPerpRatio: 0.5,
          fullyHedged: false,
        },
      }),
    );
    expect(shareBtn()).not.toBeInTheDocument();
  });

  it('opens the share modal with the frozen snapshot on click', async () => {
    render(<ToastProvider>{card()}</ToastProvider>);
    await userEvent.click(screen.getByRole('button', { name: 'Share ↗' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Share your position')).toBeInTheDocument();
    // The link is the payload: it must decode, carry the displayed capital,
    // and contain no address (whitelist-copy contract).
    const input = screen.getByLabelText('Position share link') as HTMLInputElement;
    const d = new URL(input.value).searchParams.get('d') ?? '';
    const dec = decodeSharePayload(d);
    expect(dec.ok).toBe(true);
    if (dec.ok) {
      expect(dec.payload.b).toBe('HYPE');
      expect(dec.payload.c).toBe(41_320);
      expect(dec.payload.l).toHaveLength(4);
    }
    expect(input.value).not.toMatch(/0x[a-fA-F0-9]{40}/);
  });
});

describe('StrategyCard — the fixed-APY window', () => {
  const DAY = 86_400;

  /** The canonical book with its two Boros legs given equal notional and the
   * opens the case needs. The strategy clock stays where the server puts it,
   * on the earliest leg — 60 days before maturity. */
  const splitOpens = (openedAt: (i: number) => number | null) =>
    card({
      capitalUsd: 40_000,
      expectedPnlToMaturityUsd: 1_000,
      clockStartSec: STRATEGY_MATURITY - 60 * DAY,
      legs: makeStrategyRollup().legs.map((l, i) =>
        l.kind === 'boros' ? { ...l, notionalUsd: 100_000, openedAt: openedAt(i) } : l,
      ),
    });

  /** Legs 2 and 3 of the fixture are the Boros pair: opens 60 and 30 days out,
   * so the notional-weighted mean is 45. */
  const staggered = () => splitOpens((i) => STRATEGY_MATURITY - (i === 2 ? 60 : 30) * DAY);

  it('annualizes over the weighted mean open, not over the earliest leg', () => {
    render(staggered());
    rollOver();
    // 1,000 / (40,000 × 45/365) = 20.28%. Anchored on the earliest leg the same
    // PnL would be spread over 60 days and read 15.21%.
    expect(screen.getByText('+20.28%')).toBeInTheDocument();
    expect(screen.queryByText('+15.21%')).toBeNull();
  });

  it('prints the same window in the ROI tooltip', () => {
    render(staggered());
    rollOver();
    expect(screen.getByTitle(/over this position's life \(45d\)/)).toBeInTheDocument();
  });

  it('falls back to the strategy clock when no Boros leg carries an open', () => {
    render(splitOpens(() => null));
    rollOver();
    expect(screen.getByText('+15.21%')).toBeInTheDocument();
    expect(screen.getByTitle(/over this position's life \(60d\)/)).toBeInTheDocument();
  });
});
