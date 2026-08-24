/** The opportunities panel drives one query from five persisted controls and
 * renders the server's ranking as collapsible cards. The canonical ETH/USDT
 * cohort lives in test/fixtures; degraded variants are spelled per case. */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import type {
  ActionInput,
  OpportunityLeg,
  OpportunityPair,
  PreviewResponse,
  PreviewResult,
  SymbolRule,
} from '../api/types';
import {
  baseHandlers,
  ETH_GATE,
  makeOpportunitiesResult,
  makeOpportunityGroup,
  makeOpportunityLeg,
  makeOpportunityMarketRow,
  makeOpportunityPair,
  opportunitiesHandler,
  OPP_MATURITY,
  OPP_NT,
  previewFor,
  symbolHandlers,
} from '../test/fixtures';
import { env, server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { PairTicket } from '../trade/PairTicket';
import { TradeFlowProvider, useTradeFlow } from '../trade/TradeFlow';
import { OPPORTUNITIES_STORAGE_KEY, OpportunitiesPanel } from './OpportunitiesPanel';
import { OPPORTUNITY_FILTERS_STORAGE_KEY } from './opportunityFilters';

/** The blob v2 supersedes — seeded by hand in the migration tests. */
const LEGACY_KEY = 'crossex.opportunities.v1';

const paramsOf = (url: string) => Object.fromEntries(new URL(url).searchParams);

/** The card's collapse toggle, one per group. */
const toggles = () => screen.getAllByRole('button', { name: /^(Show|Hide) details for/ });

/** The hedge action. Its accessible name is the aria-label, which carries the
 * card's identity — many cards per cohort differ only by their legs. */
const executeButtons = () => screen.getAllByRole('button', { name: /^Hedge the perps / });

/** Every knob lives inside the collapsed assumptions strip — open it first. */
const openAssumptions = () =>
  userEvent.click(screen.getByRole('button', { name: /with these assumptions/ }));

/** The canonical pair with a cost overridden, keeping the server's identity
 * exact: netFixedApr = execSpreadApr − totalUsd/NT and estProfit = net × NT. */
function pairWithCosts(over: Partial<OpportunityPair['costs']>): OpportunityPair {
  const base = makeOpportunityPair();
  const costs = { ...base.costs, ...over };
  const totalUsd =
    costs.borosTakerFeeUsd +
    costs.borosSettleFeeUsd +
    (costs.perpEntryFeesUsd ?? 0) +
    (costs.perpEntrySlippageUsd ?? 0) +
    (costs.perpExitFeesUsd ?? 0) +
    (costs.perpExitSlippageUsd ?? 0);
  const netFixedApr = (base.execSpreadApr as number) - totalUsd / OPP_NT;
  return {
    ...base,
    costs: { ...costs, totalUsd, annualizedApr: totalUsd / OPP_NT },
    netFixedApr,
    estProfitUsd: netFixedApr * OPP_NT,
  };
}

/** Rolling: the perp legs are never closed, so both exit costs are ZERO. */
const rollPair = () => pairWithCosts({ perpExitFeesUsd: 0, perpExitSlippageUsd: 0 });
const rollGroup = () => makeOpportunityGroup({ pairs: [rollPair()] });
const ROLL_PROFIT = rollPair().estProfitUsd as number;

/** A BTC group whose every nullable field is null — the null-tolerance case. */
function nullBtcGroup() {
  const legs = {
    shortLeg: makeOpportunityLeg({
      marketId: 201,
      venue: 'BYBIT',
      crossexVenue: 'BYBIT',
      crossexSymbol: 'BYBIT_FUTURE_BTC_USDT',
      base: 'BTC',
      midApr: 0.06,
      execApr: null,
    }),
    longLeg: makeOpportunityLeg({
      marketId: 202,
      venue: 'GATE',
      crossexVenue: 'GATE',
      crossexSymbol: 'GATE_FUTURE_BTC_USDT',
      base: 'BTC',
      midApr: 0.03,
      execApr: null,
    }),
  };
  return makeOpportunityGroup({
    tokenId: 4,
    underlying: 'BTC',
    markets: [
      makeOpportunityMarketRow({
        marketId: 201,
        name: 'Bybit BTC',
        venue: 'BYBIT',
        crossexVenue: 'BYBIT',
        crossexSymbol: 'BYBIT_FUTURE_BTC_USDT',
        base: 'BTC',
        midApr: 0.06,
        oiUsd: null,
        execShortApr: null,
        execLongApr: null,
        bookStatus: 'insufficient-depth',
      }),
      makeOpportunityMarketRow({
        marketId: 202,
        name: 'Gate BTC',
        venue: 'GATE',
        crossexVenue: 'GATE',
        crossexSymbol: 'GATE_FUTURE_BTC_USDT',
        base: 'BTC',
        midApr: 0.03,
        oiUsd: null,
        execShortApr: null,
        execLongApr: null,
        bookStatus: 'unavailable',
      }),
    ],
    pairs: [
      makeOpportunityPair({
        base: 'BTC',
        ...legs,
        grossSpreadApr: 0.03,
        execSpreadApr: null,
        borosImpactApr: null,
        costs: {
          borosTakerFeeUsd: 0.82,
          borosSettleFeeUsd: 1.64,
          perpEntryFeesUsd: null,
          perpEntrySlippageUsd: null,
          perpExitFeesUsd: null,
          perpExitSlippageUsd: null,
          totalUsd: null,
          annualizedApr: null,
        },
        capital: {
          borosShortImUsd: 6,
          borosLongImUsd: 3,
          perpShortImUsd: null,
          perpLongImUsd: null,
          shortLeverageMax: null,
          longLeverageMax: null,
        },
        capitalUsd: null,
        netFixedApr: null,
        netFixedAprOnCapital: null,
        effectiveLeverage: null,
        estProfitUsd: null,
        reasons: [
          "The Bybit book fills only $4,120 of the $10,000 — the rate beyond it isn't lockable",
          "Bybit's max leverage for BTC couldn't be read — this pair's capital isn't modelled",
        ],
      }),
    ],
    // The route emits prose sentences, not codes — mirror it exactly.
    warnings: [
      'Kucoin BTC trades against Kucoin, which has no CrossEx perp venue — it can\'t carry a hedge leg here.',
    ],
  });
}

describe('OpportunitiesPanel — ranking and null tolerance', () => {
  it('hides undefined-APR groups, keeps the server order for the rest, never prints "NaN"', async () => {
    server.use(
      opportunitiesHandler(
        makeOpportunitiesResult({ groups: [makeOpportunityGroup(), nullBtcGroup()] }),
      ),
    );
    renderWithClient(<OpportunitiesPanel />);

    // The degraded BTC group prices no net APR — it must not render at all,
    // chips and dashed hero included.
    await waitFor(() => expect(toggles()).toHaveLength(1));
    expect(toggles()[0]).toHaveAccessibleName(/ETH/);
    expect(screen.getByText('7.0% APR')).toBeInTheDocument();
    expect(screen.queryByText('—% APR')).not.toBeInTheDocument();
    expect(screen.queryByText('thin book')).not.toBeInTheDocument();
    expect(screen.queryByText('costs incomplete')).not.toBeInTheDocument();

    await userEvent.click(toggles()[0]);
    expect(document.body.textContent).not.toContain('NaN');
  });

  it('links each Boros leg to its market page with the side prefilled', async () => {
    server.use(opportunitiesHandler(makeOpportunitiesResult()));
    renderWithClient(<OpportunitiesPanel />);
    await waitFor(() => expect(toggles()).toHaveLength(1));
    await userEvent.click(toggles()[0]);

    // Fixture legs: short marketId 101, long 102. The direction lands the
    // visitor on the exact side this leg needs.
    expect(screen.getByRole('link', { name: /Short ETH funding/ })).toHaveAttribute(
      'href',
      'https://boros.pendle.finance/markets/101?form=market&direction=short',
    );
    expect(screen.getByRole('link', { name: /Long ETH funding/ })).toHaveAttribute(
      'href',
      'https://boros.pendle.finance/markets/102?form=market&direction=long',
    );
    // The CrossEx perp legs stay plain text — there is nowhere external to go.
    expect(screen.queryByRole('link', { name: /^Short ETH$/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /^Long ETH$/ })).toBeNull();
  });

  it('disables Execute only when NEITHER leg has a CrossEx symbol', async () => {
    const oneMissing = makeOpportunityGroup({
      pairs: [
        makeOpportunityPair({
          shortLeg: makeOpportunityLeg({ crossexSymbol: '' }),
        }),
      ],
    });
    const bothMissing = makeOpportunityGroup({
      tokenId: 9,
      underlying: 'GOLD',
      pairs: [
        makeOpportunityPair({
          base: 'GOLD',
          shortLeg: makeOpportunityLeg({
            venue: 'BYBIT',
            crossexVenue: 'BYBIT',
            crossexSymbol: '',
          }),
          longLeg: makeOpportunityLeg({
            marketId: 102,
            venue: 'BINANCE',
            crossexVenue: 'BINANCE',
            crossexSymbol: '',
          }),
        }),
      ],
    });
    server.use(
      opportunitiesHandler(makeOpportunitiesResult({ groups: [oneMissing, bothMissing] })),
    );
    renderWithClient(<OpportunitiesPanel />);

    await waitFor(() => expect(executeButtons()).toHaveLength(2));
    expect(executeButtons()[0]).toBeEnabled();
    expect(screen.getByText('no CX symbol · HYPERLIQUID')).toBeInTheDocument();
    expect(executeButtons()[1]).toBeDisabled();
    expect(executeButtons()[1]).toHaveAttribute(
      'title',
      expect.stringContaining('lists a CrossEx perp'),
    );
  });

  it('unconfigured keeps Execute enabled as a nudge to the setup guide', async () => {
    // First-run: no Gate keys, so NO leg maps to a CrossEx symbol — the exact
    // shape that disables Execute above must instead nudge the setup guide.
    // (The pair still prices via the simulated VIP tier — an unpriced group
    // would be hidden with the rest of the undefined-APR noise.)
    const bothMissing = makeOpportunityGroup({
      pairs: [
        makeOpportunityPair({
          shortLeg: makeOpportunityLeg({ crossexSymbol: '' }),
          longLeg: makeOpportunityLeg({
            marketId: 102,
            venue: 'BINANCE',
            crossexVenue: 'BINANCE',
            crossexSymbol: '',
            midApr: 0.045,
            execApr: 0.0455,
          }),
        }),
      ],
    });
    server.use(opportunitiesHandler(makeOpportunitiesResult({ groups: [bothMissing] })));
    renderWithClient(<OpportunitiesPanel unconfigured />);

    await waitFor(() => expect(executeButtons()).toHaveLength(1));
    expect(executeButtons()[0]).toBeEnabled();
    expect(executeButtons()[0]).toHaveAttribute(
      'title',
      expect.stringContaining('setup guide'),
    );
  });

  it('unconfigured sends the simulated VIP tier and re-queries when it changes', async () => {
    const urls: string[] = [];
    server.use(opportunitiesHandler(makeOpportunitiesResult(), { urls }));
    renderWithClient(<OpportunitiesPanel unconfigured />);

    await waitFor(() => expect(urls).toHaveLength(1));
    expect(paramsOf(urls.at(-1)!)).toMatchObject({ feeTier: 'vip0' });

    await openAssumptions();
    await userEvent.selectOptions(screen.getByLabelText('Gate VIP tier'), 'vip3');
    await waitFor(() => expect(paramsOf(urls.at(-1)!)).toMatchObject({ feeTier: 'vip3' }));
  });

  it('configured never sends a feeTier and never shows the simulator', async () => {
    const urls: string[] = [];
    server.use(opportunitiesHandler(makeOpportunitiesResult(), { urls }));
    renderWithClient(<OpportunitiesPanel />);

    await waitFor(() => expect(urls).toHaveLength(1));
    expect(paramsOf(urls.at(-1)!)).not.toHaveProperty('feeTier');
    await openAssumptions();
    expect(screen.queryByLabelText('Gate VIP tier')).not.toBeInTheDocument();
  });
});

describe('OpportunitiesPanel — capital basis', () => {
  // Capital $1,512 (Boros $8 + $4, perp $1,000 @ 10x + $500 @ 20x) carrying the
  // $8.70 profit over 30 days ⇒ 7.0% on capital (vs 1.06% on notional).
  it('leads with the capital APR over the capital / return / notional line', async () => {
    server.use(opportunitiesHandler(makeOpportunitiesResult()));
    renderWithClient(<OpportunitiesPanel />);

    await waitFor(() => expect(toggles()).toHaveLength(1));
    expect(screen.getByTitle(/Locked fixed spread annualized/)).toHaveTextContent('7.0% APR');
    expect(screen.getByText('(30 days)')).toBeInTheDocument();
    expect(screen.getByText('~$1,512')).toBeInTheDocument();
    expect(screen.getByTitle('Estimated profit by maturity on $10,000 per leg')).toHaveTextContent(
      '$9',
    );
    expect(screen.getByTitle('$10,000 per leg')).toHaveTextContent('$10k');
    // The asset line names the underlying (via its badge) and both venue legs
    // by side.
    expect(screen.getByText('ETH')).toBeInTheDocument();
    expect(screen.getByText('SHORT · HYPERLIQUID')).toBeInTheDocument();
    expect(screen.getByText('LONG · BINANCE')).toBeInTheDocument();
  });

  it('hides a loss-making group — costs can swallow the whole spread', async () => {
    // The server ranks a negative net last but still serves it; a loss is not
    // an opportunity, so the panel drops it while the healthy card stays.
    const losing = { ...pairWithCosts({ perpEntryFeesUsd: 60 }), netFixedAprOnCapital: -0.042 };
    server.use(
      opportunitiesHandler(
        makeOpportunitiesResult({
          groups: [
            makeOpportunityGroup(),
            makeOpportunityGroup({ tokenId: 9, underlying: 'GOLD', pairs: [losing] }),
          ],
        }),
      ),
    );
    renderWithClient(<OpportunitiesPanel />);

    await waitFor(() => expect(toggles()).toHaveLength(1));
    expect(toggles()[0]).toHaveAccessibleName(/ETH/);
    expect(screen.queryByText('-4.2% APR')).not.toBeInTheDocument();
  });

  it('builds the capital waterfall per leg with the leverage each perp was sized at', async () => {
    server.use(opportunitiesHandler(makeOpportunitiesResult()));
    const { container } = renderWithClient(<OpportunitiesPanel />);

    await waitFor(() => expect(toggles()).toHaveLength(1));
    await userEvent.click(toggles()[0]);

    // 8 → 12 → 1012 → 1512, each step stacking onto the running level.
    const level = (key: string) =>
      container.querySelector(`[data-segment="${key}"]`)!.getAttribute('data-level');
    expect(level('cap-boros-short')).toBe('8.00');
    expect(level('cap-boros-long')).toBe('12.00');
    expect(level('cap-perp-short')).toBe('1012.00');
    expect(level('cap-perp-long')).toBe('1512.00');
    // The stack lands ON the authoritative total by construction.
    expect(level('cap-total')).toBe('1512.00');

    const total = container.querySelector('[data-segment="cap-total"]')!;
    expect(total.className).toContain('cyan');
    expect(total.getAttribute('data-tone')).toBe('pos');

    // The leverage each perp margin was sized at rides on its axis label.
    expect(screen.getByText('Perp short IM @ 10x')).toBeInTheDocument();
    expect(screen.getByText('Perp long IM @ 20x')).toBeInTheDocument();
    // Component value labels are signed deltas; the total prints its level.
    expect(screen.getByText('+$8.00')).toBeInTheDocument();
    expect(screen.getByText('+$1,000')).toBeInTheDocument();
    // The two footnotes the text ledger used to carry survive under the chart.
    expect(screen.getByText(/6\.6x/)).toBeInTheDocument();
    expect(screen.getByText(/over-collateralized reads a lower APR/)).toBeInTheDocument();
  });

  it('shows the empty state when every group is unpriced', async () => {
    server.use(opportunitiesHandler(makeOpportunitiesResult({ groups: [nullBtcGroup()] })));
    renderWithClient(<OpportunitiesPanel />);

    // An unmodellable group is dropped, and with nothing left the panel says so
    // instead of parading dashes.
    expect(await screen.findByText('No fixed-return opportunities')).toBeInTheDocument();
    expect(screen.queryByText('—% APR')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('NaN');
  });
});

describe('OpportunitiesPanel — collateral bracket', () => {
  it('brackets the notional in the collateral token on non-USDT groups', async () => {
    // $10k at $1,900/ETH ⇒ 5.2632 ETH exact in the tooltip, 5.26 in the badge.
    server.use(
      opportunitiesHandler(
        makeOpportunitiesResult({
          groups: [
            makeOpportunityGroup({ tokenId: 2, collateral: 'ETH', collateralPriceUsd: 1900 }),
          ],
        }),
      ),
    );
    renderWithClient(<OpportunitiesPanel />);

    await waitFor(() => expect(toggles()).toHaveLength(1));
    expect(screen.getByTitle('$10,000 per leg ≈ 5.2632 ETH')).toHaveTextContent('$10k (5.26 ETH)');

    // Expanded: all four legs carry the bracket — the Boros rate legs and the
    // CrossEx perp legs alike (the same notional, in the collateral token).
    await userEvent.click(toggles()[0]);
    const borosBox = screen.getByText('On Boros').parentElement!;
    expect(within(borosBox).getAllByText('$10k (5.26 ETH)')).toHaveLength(2);
    const perpBox = screen.getByText('On CrossEx').parentElement!;
    expect(within(perpBox).getAllByText('$10k (5.26 ETH)')).toHaveLength(2);
  });

  it('keeps USDT groups and unpriceable collateral pure-dollar', async () => {
    server.use(
      opportunitiesHandler(
        makeOpportunitiesResult({
          groups: [
            makeOpportunityGroup(),
            makeOpportunityGroup({
              tokenId: 4,
              collateral: 'BNB',
              collateralPriceUsd: null,
              underlying: 'GOLD',
            }),
          ],
        }),
      ),
    );
    renderWithClient(<OpportunitiesPanel />);

    await waitFor(() => expect(toggles()).toHaveLength(2));
    // Both cards: the plain dollar figure, the unchanged tooltip, no token text.
    expect(screen.getAllByTitle('$10,000 per leg')).toHaveLength(2);
    for (const el of screen.getAllByTitle('$10,000 per leg')) {
      expect(el).toHaveTextContent(/^\$10k$/);
    }
  });
});

describe('OpportunitiesPanel — collapse', () => {
  it('collapsed shows the hero and the buttons but no breakdown; expanding reveals it', async () => {
    server.use(opportunitiesHandler(makeOpportunitiesResult()));
    const { container } = renderWithClient(<OpportunitiesPanel />);

    await waitFor(() => expect(toggles()).toHaveLength(1));
    expect(screen.getByText('7.0% APR')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /^Hedge the perps for ETH short Hyperliquid/ }),
    ).toBeInTheDocument();
    expect(toggles()[0]).toHaveTextContent('Details');
    expect(toggles()[0]).toHaveAttribute('aria-expanded', 'false');
    expect(container.querySelector('[data-waterfall]')).toBeNull();
    expect(screen.queryByText('Boros taker fee')).not.toBeInTheDocument();
    expect(screen.queryByText('How it works — you open 4 legs')).not.toBeInTheDocument();

    await userEvent.click(toggles()[0]);
    expect(toggles()[0]).toHaveTextContent('Hide details');
    expect(toggles()[0]).toHaveAttribute('aria-expanded', 'true');

    // The body is the 4-leg explainer, the net-effect sentence and the charts.
    expect(screen.getByText('How it works — you open 4 legs')).toBeInTheDocument();
    expect(screen.getByText('Short ETH')).toBeInTheDocument();
    expect(screen.getByText('Long ETH funding')).toBeInTheDocument();
    const netEffect = screen.getByText('Net effect').parentElement as HTMLElement;
    expect(netEffect.textContent).toMatch(/Locks a 4\.4% funding spread/);
    expect(netEffect.textContent).toMatch(/After leverage: 7\.0% APR on \$1\.5k capital/);

    // The waterfalls ARE the breakdown; the cost names live on their axes.
    expect(container.querySelector('[data-waterfall]')).not.toBeNull();
    expect(screen.getByText('Boros taker fee')).toBeInTheDocument();
    expect(screen.getByText('Perp exit fees')).toBeInTheDocument();
    // The text ledgers, the per-market matrix and the runner-up list are gone
    // for good — the explainer, the banner and the charts carry the body now.
    expect(screen.queryByText('Cost ledger')).not.toBeInTheDocument();
    expect(screen.queryByText('Capital (modelled minimum)')).not.toBeInTheDocument();
    expect(screen.queryByText('Markets in this group')).not.toBeInTheDocument();
    expect(screen.queryByText('Other pairs in this group')).not.toBeInTheDocument();
  });

  it('drops the exit bars and notes the roll under "Roll over"', async () => {
    // The server's roll shape: exit costs ZERO (not null), totals recomputed.
    // The chart is value-driven, so those columns disappear on their own.
    server.use(opportunitiesHandler(makeOpportunitiesResult({ groups: [rollGroup()] })));
    const { container } = renderWithClient(<OpportunitiesPanel />);

    await waitFor(() => expect(toggles()).toHaveLength(1));
    await openAssumptions();
    await userEvent.click(screen.getByRole('radio', { name: /Roll over/ }));
    await userEvent.click(toggles()[0]);

    expect(screen.getByText('rolling — no exit cost')).toBeInTheDocument();
    expect(screen.queryByText('Perp exit fees')).not.toBeInTheDocument();
    expect(container.querySelector('[data-segment="opp-exit-fees"]')).toBeNull();
    expect(container.querySelector('[data-segment="opp-exit-slip"]')).toBeNull();
    // Keeping the $12.50 of exit cost lifts the profit from 8.70 to 21.20.
    expect(
      container.querySelector('[data-segment="profit"]')!.getAttribute('data-level'),
    ).toBe(ROLL_PROFIT.toFixed(2));
  });
});

describe('OpportunitiesPanel — breakdown waterfalls', () => {
  /** Expand the single card and hand back the container. */
  async function expandOne(data = makeOpportunitiesResult()) {
    server.use(opportunitiesHandler(data));
    const rendered = renderWithClient(<OpportunitiesPanel />);
    await waitFor(() => expect(toggles()).toHaveLength(1));
    await userEvent.click(toggles()[0]);
    return rendered.container;
  }

  const seg = (c: HTMLElement, key: string) => c.querySelector(`[data-segment="${key}"]`);

  it('steps the gross spread down through every cost and lands ON the profit', async () => {
    const container = await expandOne();

    // Gross return = 4.5% × NT; the opening total carries no tone (like the
    // strategy card's spread bar), the closing one does.
    const spread = seg(container, 'spread')!;
    expect(spread.getAttribute('data-level')).toBe((0.045 * OPP_NT).toFixed(2));
    expect(spread.getAttribute('data-tone')).toBeNull();

    // Every cost column is present and steps DOWN.
    for (const key of [
      'opp-boros-impact',
      'opp-boros-taker',
      'opp-boros-settle',
      'opp-perp-entry-fees',
      'opp-entry-slip',
      'opp-exit-fees',
      'opp-exit-slip',
    ]) {
      expect(seg(container, key)!.getAttribute('data-dir')).toBe('down');
    }

    // The identity: the last cost's running level IS the profit total.
    const costs = [...container.querySelectorAll('[data-kind^="cost"]')];
    const profit = seg(container, 'profit')!;
    expect(costs.at(-1)!.getAttribute('data-level')).toBe(profit.getAttribute('data-level'));
    expect(profit.getAttribute('data-level')).toBe(
      (makeOpportunityPair().estProfitUsd as number).toFixed(2),
    );
    expect(profit.getAttribute('data-tone')).toBe('pos');
    expect(profit.className).toContain('emerald');
  });

  it('scales the two plots independently — capital dwarfs profit but both fill', async () => {
    const container = await expandOne();
    // On ONE shared scale the $37 spread bar would be ~2% of a $1,512 domain.
    // Each plot owning its scale means both extremes render full height.
    expect((seg(container, 'spread') as HTMLElement).style.height).toContain('100%');
    expect((seg(container, 'cap-total') as HTMLElement).style.height).toContain('100%');
  });

  // ('charts profit alone when the capital cannot be modelled' is gone: a pair
  // with no APR on capital is filtered out of the panel entirely now.)

  it('charts capital alone when the profit cannot be priced', async () => {
    const pair = makeOpportunityPair();
    const container = await expandOne(
      makeOpportunitiesResult({
        groups: [
          makeOpportunityGroup({
            pairs: [
              {
                ...pair,
                execSpreadApr: null,
                borosImpactApr: null,
                netFixedApr: null,
                estProfitUsd: null,
                costs: { ...pair.costs, totalUsd: null, annualizedApr: null },
              },
            ],
          }),
        ],
      }),
    );

    expect(seg(container, 'cap-total')).not.toBeNull();
    expect(seg(container, 'profit')).toBeNull();
    // The profit chart's axis labels go with it — nothing replaces them.
    expect(screen.queryByText('Boros taker fee')).not.toBeInTheDocument();
    expect(screen.queryByText('Cost ledger')).not.toBeInTheDocument();
    expect(container.textContent).not.toContain('NaN');
  });

  it('turns the profit total rose and draws a zero axis when the costs win', async () => {
    // Fees that swallow the whole spread — the waterfall must cross zero.
    const container = await expandOne(
      makeOpportunitiesResult({
        groups: [makeOpportunityGroup({ pairs: [pairWithCosts({ perpEntryFeesUsd: 60 })] })],
      }),
    );

    const profit = seg(container, 'profit')!;
    expect(Number(profit.getAttribute('data-level'))).toBeLessThan(0);
    expect(profit.getAttribute('data-tone')).toBe('neg');
    expect(profit.className).toContain('rose');
    expect(container.querySelector('[data-axis="zero"]')).not.toBeNull();
  });

  it('shows a NEGATIVE gross spread in rose, not as an upward emerald gain', async () => {
    // Under borosEntry 'mark' the server orders pairs by markApr while the gross
    // spread stays mid-based, so the two can disagree in sign.
    const base = makeOpportunityPair();
    const gross = 0.045 - 0.0453; // mid-based: negative
    const exec = 0.047 - 0.0461; // mark-based: positive
    const netFixedApr = exec - (base.costs.totalUsd as number) / OPP_NT;
    const container = await expandOne(
      makeOpportunitiesResult({
        groups: [
          makeOpportunityGroup({
            pairs: [
              {
                ...base,
                grossSpreadApr: gross,
                execSpreadApr: exec,
                borosImpactApr: gross - exec,
                netFixedApr,
                estProfitUsd: netFixedApr * OPP_NT,
              },
            ],
          }),
        ],
      }),
    );

    const spread = seg(container, 'spread')!;
    expect(Number(spread.getAttribute('data-level'))).toBeLessThan(0);
    expect(spread.className).toContain('rose');
    expect(spread.getAttribute('data-dir')).toBe('down');
    // A favorable (negative) impact steps back UP in emerald.
    const impact = seg(container, 'opp-boros-impact')!;
    expect(impact.getAttribute('data-dir')).toBe('up');
    expect(impact.className).toContain('emerald');
  });

  it('describes both plots in one aria-label', async () => {
    await expandOne();
    expect(
      screen.getByRole('img', {
        name: /gross spread return .* modelled minimum capital/i,
      }),
    ).toBeInTheDocument();
  });
});

describe('OpportunitiesPanel — the assumptions strip', () => {
  it('keeps the knobs behind the strip and defaults to $10k at market', async () => {
    const urls: string[] = [];
    server.use(opportunitiesHandler(makeOpportunitiesResult(), { urls }));
    renderWithClient(<OpportunitiesPanel />);

    await waitFor(() => expect(urls).toHaveLength(1));
    expect(paramsOf(urls.at(-1)!)).toMatchObject({
      borosEntry: 'market',
      notionalUsd: '10000',
      entryMode: 'both-market',
      exitMode: 'roll',
    });
    // Collapsed: the summary is on the button, the radios are not rendered.
    expect(screen.queryByRole('radiogroup', { name: 'Notional' })).not.toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'Boros entry' })).not.toBeInTheDocument();

    await openAssumptions();
    expect(screen.getByRole('radiogroup', { name: 'Notional' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '$10k' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Market at size' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.queryByLabelText('Custom notional (USD)')).not.toBeInTheDocument();
  });

  it('re-prices on the notional presets without touching the Boros entry', async () => {
    const urls: string[] = [];
    server.use(opportunitiesHandler(makeOpportunitiesResult(), { urls }));
    renderWithClient(<OpportunitiesPanel />);

    await waitFor(() => expect(urls).toHaveLength(1));
    await openAssumptions();

    await userEvent.click(screen.getByRole('radio', { name: '$100k' }));
    await waitFor(() =>
      expect(paramsOf(urls.at(-1)!)).toMatchObject({ borosEntry: 'market', notionalUsd: '100000' }),
    );
    await userEvent.click(screen.getByRole('radio', { name: '$500k' }));
    await waitFor(() =>
      expect(paramsOf(urls.at(-1)!)).toMatchObject({ borosEntry: 'market', notionalUsd: '500000' }),
    );
  });

  it('switches the Boros entry without touching the notional', async () => {
    const urls: string[] = [];
    server.use(opportunitiesHandler(makeOpportunitiesResult(), { urls }));
    renderWithClient(<OpportunitiesPanel />);

    await waitFor(() => expect(urls).toHaveLength(1));
    await openAssumptions();

    await userEvent.click(screen.getByRole('radio', { name: 'At mark rate' }));
    await waitFor(() =>
      expect(paramsOf(urls.at(-1)!)).toMatchObject({ borosEntry: 'mark', notionalUsd: '10000' }),
    );
    expect(screen.getByRole('radio', { name: '$10k' })).toHaveAttribute('aria-checked', 'true');
  });

  it('combines the two knobs freely — $100k AT MARK RATE sends both', async () => {
    // The point of splitting v1's coupled control: any size, either entry.
    const urls: string[] = [];
    server.use(opportunitiesHandler(makeOpportunitiesResult(), { urls }));
    renderWithClient(<OpportunitiesPanel />);

    await waitFor(() => expect(urls).toHaveLength(1));
    await openAssumptions();

    await userEvent.click(screen.getByRole('radio', { name: '$100k' }));
    await userEvent.click(screen.getByRole('radio', { name: 'At mark rate' }));
    await waitFor(() =>
      expect(paramsOf(urls.at(-1)!)).toMatchObject({ borosEntry: 'mark', notionalUsd: '100000' }),
    );
    expect(screen.getByRole('radio', { name: '$100k' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'At mark rate' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('labels the perp entry modes as "2 market orders" and "Limit + hedge"', async () => {
    const urls: string[] = [];
    server.use(opportunitiesHandler(makeOpportunitiesResult(), { urls }));
    renderWithClient(<OpportunitiesPanel />);

    await waitFor(() => expect(urls).toHaveLength(1));
    await openAssumptions();

    // Names the two ways the perp legs get opened; "2 market orders" says how
    // many orders go out, which "Both market" left the reader to infer.
    const entry = screen.getByRole('radiogroup', { name: 'Perp entry mode' });
    expect(within(entry).getByRole('radio', { name: '2 market orders' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(within(entry).getByRole('radio', { name: 'Limit + hedge' })).toBeInTheDocument();
    // Both old labels named the mechanism; the new ones name the orders sent.
    expect(within(entry).queryByRole('radio', { name: /Both market|Maker \+ hedge/ })).toBeNull();
  });

  it('reveals the custom size input and debounces it into the query', async () => {
    const urls: string[] = [];
    server.use(opportunitiesHandler(makeOpportunitiesResult(), { urls }));
    renderWithClient(<OpportunitiesPanel />);

    await waitFor(() => expect(urls).toHaveLength(1));
    await openAssumptions();
    await userEvent.click(screen.getByRole('radio', { name: /^Custom/ }));

    const size = screen.getByLabelText('Custom notional (USD)');
    expect(size).toHaveValue('10000');
    await userEvent.clear(size);
    await userEvent.type(size, '25000');
    await waitFor(
      () =>
        expect(paramsOf(urls.at(-1)!)).toMatchObject({ borosEntry: 'market', notionalUsd: '25000' }),
      { timeout: 4000 },
    );
  });

  it('keeps the last valid size while the input is unusable', async () => {
    const urls: string[] = [];
    server.use(opportunitiesHandler(makeOpportunitiesResult(), { urls }));
    renderWithClient(<OpportunitiesPanel />);

    await waitFor(() => expect(toggles()).toHaveLength(1));
    await openAssumptions();
    await userEvent.click(screen.getByRole('radio', { name: /^Custom/ }));
    await userEvent.clear(screen.getByLabelText('Custom notional (USD)'));

    // Well past the debounce: no request carries the empty (or a 0) size, and
    // the cards still render off the last good one.
    await new Promise((r) => setTimeout(r, 600));
    expect(urls.every((u) => paramsOf(u).notionalUsd === '10000')).toBe(true);
    expect(toggles()).toHaveLength(1);
  });

  it('persists every control across a remount', async () => {
    server.use(opportunitiesHandler(makeOpportunitiesResult()));
    const first = renderWithClient(<OpportunitiesPanel />);

    await waitFor(() => expect(toggles()).toHaveLength(1));
    await openAssumptions();
    await userEvent.click(screen.getByRole('radio', { name: '$100k' }));
    await userEvent.click(screen.getByRole('radio', { name: 'At mark rate' }));
    await userEvent.click(screen.getByRole('radio', { name: /Limit \+ hedge/ }));
    await userEvent.click(screen.getByRole('radio', { name: /Roll over/ }));
    first.unmount();

    renderWithClient(<OpportunitiesPanel />);
    await waitFor(() => expect(toggles()).toHaveLength(1));
    // The strip itself is deliberately NOT persisted — it folds away again.
    expect(screen.getByRole('button', { name: /with these assumptions/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await openAssumptions();
    for (const name of ['$100k', 'At mark rate', /Limit \+ hedge/, /Roll over/] as const) {
      expect(screen.getByRole('radio', { name })).toHaveAttribute('aria-checked', 'true');
    }
  });

  it('migrates a v1 blob into the two independent knobs and drops the old key', async () => {
    localStorage.setItem(
      LEGACY_KEY,
      JSON.stringify({
        choice: 'market-100k',
        customSize: 10_000,
        entryMode: 'maker-hedge',
        exitMode: 'roll',
        feeTier: 'vip3',
      }),
    );
    const urls: string[] = [];
    server.use(opportunitiesHandler(makeOpportunitiesResult(), { urls }));
    renderWithClient(<OpportunitiesPanel unconfigured />);

    await waitFor(() => expect(urls).toHaveLength(1));
    expect(paramsOf(urls.at(-1)!)).toMatchObject({
      notionalUsd: '100000',
      borosEntry: 'market',
      entryMode: 'maker-hedge',
      exitMode: 'roll',
      feeTier: 'vip3',
    });

    await openAssumptions();
    expect(screen.getByRole('radio', { name: '$100k' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Market at size' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('radio', { name: /Limit \+ hedge/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('radio', { name: /Roll over/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText('Gate VIP tier')).toHaveValue('vip3');

    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    expect(JSON.parse(localStorage.getItem(OPPORTUNITIES_STORAGE_KEY)!)).toEqual({
      notionalChoice: '100k',
      customNotionalUsd: 10_000,
      borosEntry: 'market',
      entryMode: 'maker-hedge',
      exitMode: 'roll',
      feeTier: 'vip3',
    });
  });

  it('migrates a v1 "mark" blob into a mark entry at its own custom size', async () => {
    // v1's 'mark' carried its size in customSize — a non-preset one lands on
    // "Custom…" with the size intact, and the entry knob on "At mark rate".
    localStorage.setItem(LEGACY_KEY, JSON.stringify({ choice: 'mark', customSize: 25_000 }));
    const urls: string[] = [];
    server.use(opportunitiesHandler(makeOpportunitiesResult(), { urls }));
    renderWithClient(<OpportunitiesPanel />);

    await waitFor(() => expect(urls).toHaveLength(1));
    expect(paramsOf(urls.at(-1)!)).toMatchObject({
      notionalUsd: '25000',
      borosEntry: 'mark',
      entryMode: 'both-market',
      exitMode: 'roll',
    });

    await openAssumptions();
    expect(screen.getByRole('radio', { name: /^Custom/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'At mark rate' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByLabelText('Custom notional (USD)')).toHaveValue('25000');

    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    expect(JSON.parse(localStorage.getItem(OPPORTUNITIES_STORAGE_KEY)!)).toMatchObject({
      notionalChoice: 'custom',
      customNotionalUsd: 25_000,
      borosEntry: 'mark',
      feeTier: 'vip0',
    });
  });
});

describe('OpportunitiesPanel — empty and error states', () => {
  it('names the current size and modes when nothing prices out', async () => {
    server.use(opportunitiesHandler(makeOpportunitiesResult({ groups: [] })));
    renderWithClient(<OpportunitiesPanel />);

    expect(await screen.findByText('No fixed-return opportunities')).toBeInTheDocument();
    expect(
      screen.getByText(
        /\$10,000 notional with a Boros entry at market size, both legs market perp entry and roll over/,
      ),
    ).toBeInTheDocument();
  });

  it('offers a working retry after a failed load', async () => {
    server.use(opportunitiesHandler(new Error('boros upstream down')));
    renderWithClient(<OpportunitiesPanel />);

    expect(await screen.findByText("Couldn't load opportunities")).toBeInTheDocument();
    expect(screen.getByText(/boros upstream down/)).toBeInTheDocument();

    server.use(opportunitiesHandler(makeOpportunitiesResult()));
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(toggles()).toHaveLength(1));
  });
});

// ---------------------------------------------------------------------------
// End-to-end: the card's button prefills the pair ticket (and stops there —
// submission stays behind the ticket's hold-to-confirm).
// ---------------------------------------------------------------------------

const ETH_HYPERLIQUID: SymbolRule = {
  ...ETH_GATE,
  symbol: 'HYPERLIQUID_FUTURE_ETH_USDC',
  exchange: 'HYPERLIQUID',
  quote: 'USDC',
};
const ETH_BINANCE: SymbolRule = { ...ETH_GATE, symbol: 'BINANCE_FUTURE_ETH_USDT', exchange: 'BINANCE' };

const TOUCH = { bestBid: 2499, bestAsk: 2501, mid: 2500 };

/** POST /api/preview echoing taker/maker fees + a touch, as PairTicket.test does. */
function previewHandler(calls: ActionInput[][]) {
  return http.post('/api/preview', async ({ request }) => {
    const { actions } = (await request.json()) as { actions: ActionInput[] };
    calls.push(actions);
    const previews = actions.map((a, i): PreviewResult => {
      const fees = { makerRate: 0.0002, takerRate: 0.0005, specialOverride: false, quote: 'USDT' };
      if (a.kind === 'open-limit') {
        return previewFor(a, {
          index: i,
          type: 'LIMIT',
          tif: 'POC',
          price: a.price || String(TOUCH.mid),
          qty: '4',
          estNotional: 10_000,
          restEstimate: TOUCH,
          fees: { ...fees, est: { maker: 2 } },
        });
      }
      return previewFor(a, {
        index: i,
        qty: '4',
        estNotional: 10_000,
        fillEstimate: {
          qty: '4',
          avgPrice: 2500.5,
          worstPrice: 2501,
          midPrice: TOUCH.mid,
          slippagePct: 0.02,
          source: 'venue-orderbook',
          confidence: 'high',
          venue: a.symbol.split('_')[0],
        },
        fees: { ...fees, est: { taker: 5 } },
      });
    });
    return HttpResponse.json(env<PreviewResponse>({ previews }));
  });
}

describe('OpportunitiesPanel → Boros prefill', () => {
  it('arms the Boros ticket with BOTH legs at the card\'s own maturity', async () => {
    // Regression, twice over:
    //  1. the maturity did not travel, so a venue+base match took whichever
    //     expiry came first — the two legs landed on DIFFERENT maturities, and
    //     since each leg filters the other by maturity, BOTH then vanished
    //     from their own dropdowns and the ticket rendered empty;
    //  2. an unresolved market left the PREVIOUS prefill's leg in place, which
    //     filtered the other leg down to whatever could pair with the stale one.
    server.use(
      ...baseHandlers(),
      ...symbolHandlers([ETH_HYPERLIQUID, ETH_BINANCE]),
      opportunitiesHandler(makeOpportunitiesResult()),
    );
    const seen: Array<Record<string, unknown>> = [];
    function Probe() {
      const flow = useTradeFlow();
      const p = flow.borosOpenPrefill;
      if (p && !seen.some((x) => x.nonce === p.nonce)) seen.push({ ...p });
      return null;
    }
    renderWithClient(
      <TradeFlowProvider>
        <OpportunitiesPanel />
        <Probe />
      </TradeFlowProvider>,
    );

    await waitFor(() => expect(toggles()).toHaveLength(1));
    await userEvent.click(screen.getByRole('button', { name: /^Lock the rate for / }));

    await waitFor(() => expect(seen).toHaveLength(1));
    const sent = seen[0];
    // Both venues travel — this opens the PAIR, not one leg.
    expect(sent.longVenue).toBeTruthy();
    expect(sent.shortVenue).toBeTruthy();
    expect(sent.base).toBe('ETH');
    // The pin: the cohort's maturity rides along, so the ticket cannot resolve
    // the two legs to different expiries.
    expect(typeof sent.maturity).toBe('number');
    expect(sent.maturity).toBeGreaterThan(0);
  });
});

describe('OpportunitiesPanel → PairTicket prefill', () => {
  it('arms the ticket with the size, the maker mode and the server-supplied legs', async () => {
    const calls: ActionInput[][] = [];
    server.use(
      ...baseHandlers(),
      ...symbolHandlers([ETH_HYPERLIQUID, ETH_BINANCE]),
      previewHandler(calls),
      opportunitiesHandler(makeOpportunitiesResult()),
    );
    renderWithClient(
      <>
        <OpportunitiesPanel />
        <PairTicket />
      </>,
    );

    await waitFor(() => expect(toggles()).toHaveLength(1));
    // The panel's entry mode is what the ticket gets armed with.
    await openAssumptions();
    const panelModes = screen.getByRole('radiogroup', { name: 'Perp entry mode' });
    await userEvent.click(within(panelModes).getByRole('radio', { name: /Limit \+ hedge/ }));
    await userEvent.click(
      screen.getByRole('button', { name: /^Hedge the perps for ETH short Hyperliquid/ }),
    );

    await waitFor(() =>
      expect(screen.getByLabelText('Size per leg (USDT)')).toHaveValue('10000'),
    );
    const ticketModes = screen.getByRole('radiogroup', { name: 'Pair execution mode' });
    expect(within(ticketModes).getByRole('radio', { name: /Limit \+ hedge/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    // Boros SHORT on Hyperliquid ⇒ perp SELL there; Boros LONG on Binance ⇒ BUY.
    await waitFor(() => expect(calls.at(-1)).toHaveLength(2), { timeout: 4000 });
    const legs = calls.at(-1)!;
    expect(legs[0]).toMatchObject({ symbol: 'BINANCE_FUTURE_ETH_USDT', side: 'BUY' });
    expect(legs[1]).toMatchObject({ symbol: 'HYPERLIQUID_FUTURE_ETH_USDC', side: 'SELL' });
    expect(legs.some((a) => a.kind === 'open-limit' && a.pairRole === 'maker')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Every viable pair, and the facet bar that narrows them
// ---------------------------------------------------------------------------

/** Distinct id per (side, venue, base). Deriving ids from the venue NAME's
 * length silently collapsed two venues of equal length onto one id — and the
 * two market ids are the whole discriminator in a row's React key. */
const marketIds = new Map<string, number>();
const marketIdFor = (side: 'short' | 'long', venue: string, base: string): number => {
  const k = `${side}:${venue}:${base}`;
  if (!marketIds.has(k)) marketIds.set(k, 900 + marketIds.size);
  return marketIds.get(k) as number;
};

/** Hyperliquid quotes USDC on CrossEx; the USDT venues quote USDT. */
const quoteOf = (venue: string) => (venue === 'HYPERLIQUID' ? 'USDC' : 'USDT');

/** A leg the server could actually emit: the Boros venue, its CrossEx mapping
 * and the symbol all name the same exchange and the same coin. Renaming only
 * `venue` decouples the field the venue facet keys on from the one Execute
 * keys on, which hides exactly the regressions these fixtures exist to catch. */
function venueLeg(side: 'short' | 'long', venue: string, base: string): OpportunityLeg {
  return {
    ...makeOpportunityLeg(),
    marketId: marketIdFor(side, venue, base),
    venue,
    crossexVenue: venue,
    crossexSymbol: `${venue}_FUTURE_${base}_${quoteOf(venue)}`,
    base,
  };
}

/** One pair pinned to an APR and a pair of Boros venues. */
function venuePair(
  apr: number | null,
  shortVenue: string,
  longVenue: string,
  base = 'ETH',
  over: Partial<OpportunityPair> = {},
): OpportunityPair {
  return {
    ...makeOpportunityPair(),
    base,
    shortLeg: venueLeg('short', shortVenue, base),
    longLeg: venueLeg('long', longVenue, base),
    netFixedAprOnCapital: apr,
    ...over,
  };
}

/** ETH offers two venue combinations; BTC, in a later cohort, offers one. */
const multiPairResult = () =>
  makeOpportunitiesResult({
    groups: [
      makeOpportunityGroup({
        tokenId: 3,
        underlying: 'ETH',
        pairs: [
          venuePair(0.12, 'HYPERLIQUID', 'BINANCE'),
          venuePair(0.04, 'HYPERLIQUID', 'GATE'),
        ],
      }),
      makeOpportunityGroup({
        tokenId: 4,
        underlying: 'BTC',
        maturity: OPP_MATURITY + 60 * 86_400,
        secondsToMaturity: 90 * 86_400,
        pairs: [
          venuePair(0.08, 'BYBIT', 'GATE', 'BTC', { secondsToMaturity: 90 * 86_400 }),
        ],
      }),
    ],
  });

const chip = (name: RegExp) => screen.getByRole('button', { name });

/** Venue, Matures and Min APR fold behind the filter icon — only Asset rides
 * the bar's own line. */
const openMoreFilters = () => userEvent.click(screen.getByRole('button', { name: /^Filters/ }));

/** The Execute control of one card, named by its legs (every card's used to be
 * the bare "Execute it", which named none of them). */
const executeFor = (name: RegExp) => screen.getByRole('button', { name });

describe('OpportunitiesPanel — every viable pair', () => {
  it('shows every pair in a group, not only its best, ranked across groups', async () => {
    server.use(opportunitiesHandler(multiPairResult()));
    renderWithClient(<OpportunitiesPanel />);

    await waitFor(() => expect(toggles()).toHaveLength(3));
    // Best APR first, regardless of which cohort it came from.
    expect(screen.getAllByText(/^\d+\.\d% APR$/).map((el) => el.textContent)).toEqual([
      '12.0% APR',
      '8.0% APR',
      '4.0% APR',
    ]);
    // The two ETH cards are told apart by their legs, in the toggle's name too.
    expect(toggles()[0]).toHaveAccessibleName(/ETH short Hyperliquid \/ long Binance/);
    expect(toggles()[2]).toHaveAccessibleName(/ETH short Hyperliquid \/ long Gate/);
  });

  it('still drops the pairs that price no APR or a loss', async () => {
    server.use(
      opportunitiesHandler(
        makeOpportunitiesResult({
          groups: [
            makeOpportunityGroup({
              pairs: [
                venuePair(0.12, 'HYPERLIQUID', 'BINANCE'),
                venuePair(null, 'HYPERLIQUID', 'GATE'),
                venuePair(-0.03, 'BYBIT', 'GATE'),
              ],
            }),
          ],
        }),
      ),
    );
    renderWithClient(<OpportunitiesPanel />);

    await waitFor(() => expect(toggles()).toHaveLength(1));
    expect(screen.getByText('12.0% APR')).toBeInTheDocument();
  });
});

describe('OpportunitiesPanel → PairTicket prefill, runner-up pairs', () => {
  it('arms the ticket with the legs of the card that was CLICKED, not the group best', async () => {
    const calls: ActionInput[][] = [];
    server.use(
      ...baseHandlers(),
      ...symbolHandlers([ETH_HYPERLIQUID, ETH_BINANCE, ETH_GATE]),
      previewHandler(calls),
      // One ETH cohort, two venue combinations: Binance at 12%, Gate at 4%.
      opportunitiesHandler(
        makeOpportunitiesResult({
          groups: [
            makeOpportunityGroup({
              pairs: [
                venuePair(0.12, 'HYPERLIQUID', 'BINANCE'),
                venuePair(0.04, 'HYPERLIQUID', 'GATE'),
              ],
            }),
          ],
        }),
      ),
    );
    renderWithClient(
      <>
        <OpportunitiesPanel />
        <PairTicket />
      </>,
    );

    await waitFor(() => expect(toggles()).toHaveLength(2));
    // The RUNNER-UP — the card the old one-per-group list could not even show.
    await userEvent.click(executeFor(/^Hedge the perps for ETH short Hyperliquid \/ long Gate/));

    await waitFor(() => expect(calls.at(-1)).toHaveLength(2), { timeout: 4000 });
    const legs = calls.at(-1) as ActionInput[];
    // Gate's legs, not the 12% Binance pair's.
    expect(legs.map((a) => a.symbol).sort()).toEqual([
      'GATE_FUTURE_ETH_USDT',
      'HYPERLIQUID_FUTURE_ETH_USDC',
    ]);
    expect(legs.find((a) => a.symbol === 'GATE_FUTURE_ETH_USDT')).toMatchObject({ side: 'BUY' });
    expect(legs.find((a) => a.symbol === 'HYPERLIQUID_FUTURE_ETH_USDC')).toMatchObject({
      side: 'SELL',
    });
    expect(legs.some((a) => a.symbol === 'BINANCE_FUTURE_ETH_USDT')).toBe(false);
  });
});

describe('OpportunitiesPanel — filters', () => {
  it('releases an asset chip by clicking it again — no Clear needed on the bar', async () => {
    server.use(opportunitiesHandler(multiPairResult()));
    renderWithClient(<OpportunitiesPanel />);

    await waitFor(() => expect(toggles()).toHaveLength(3));
    expect(screen.getByText('showing 3 of 3')).toBeInTheDocument();

    await userEvent.click(chip(/^BTC 1$/));
    await waitFor(() => expect(toggles()).toHaveLength(1));
    expect(screen.getByText('8.0% APR')).toBeInTheDocument();
    expect(screen.getByText('showing 1 of 3')).toBeInTheDocument();
    expect(chip(/^BTC 1$/)).toHaveAttribute('aria-pressed', 'true');
    // The bar's own line carries no Clear: every chip on it is its own undo.
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();

    await userEvent.click(chip(/^BTC 1$/));
    await waitFor(() => expect(toggles()).toHaveLength(3));
  });

  it('offers the blanket Clear inside the popover, where the folded filters are', async () => {
    server.use(opportunitiesHandler(multiPairResult()));
    renderWithClient(<OpportunitiesPanel />);

    await waitFor(() => expect(toggles()).toHaveLength(3));
    // Nothing armed: no Clear to offer, inside or out.
    await openMoreFilters();
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();

    await userEvent.click(chip(/^Gate 2$/));
    await waitFor(() => expect(toggles()).toHaveLength(2));

    const popover = screen.getByRole('dialog');
    await userEvent.click(within(popover).getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(toggles()).toHaveLength(3));
    // Clearing does not close the popover the reader is still working in.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('matches a venue on either leg, and ORs two chips in one dimension', async () => {
    server.use(opportunitiesHandler(multiPairResult()));
    renderWithClient(<OpportunitiesPanel />);

    await waitFor(() => expect(toggles()).toHaveLength(3));
    await openMoreFilters();
    // Gate is the LONG leg of one ETH pair and of the BTC pair.
    await userEvent.click(chip(/^Gate 2$/));
    await waitFor(() => expect(toggles()).toHaveLength(2));

    await userEvent.click(chip(/^Binance 1$/));
    await waitFor(() => expect(toggles()).toHaveLength(3));
  });

  it('counts each chip against the other filters, and deadens one that adds nothing', async () => {
    server.use(opportunitiesHandler(multiPairResult()));
    renderWithClient(<OpportunitiesPanel />);

    await waitFor(() => expect(toggles()).toHaveLength(3));
    // Asset stays on the bar's line; the venue chips it re-counts do not.
    await userEvent.click(chip(/^ETH 2$/));
    await openMoreFilters();

    // Venue counts fall to what ETH leaves; Bybit trades no ETH, so its chip
    // would add nothing and reads as a dead end. It stays in the tab order and
    // keeps its tooltip — `aria-disabled`, not the native `disabled` that would
    // hide the explanation from the people who need it.
    await waitFor(() => expect(chip(/^Bybit 0$/)).toHaveAttribute('aria-disabled', 'true'));
    expect(chip(/^Bybit 0$/)).toBeEnabled();
    expect(chip(/^Bybit 0$/)).toHaveAttribute('title');
    // Clicking it is inert rather than blocked by the browser.
    await userEvent.click(chip(/^Bybit 0$/));
    expect(toggles()).toHaveLength(2);
    expect(chip(/^Hyperliquid 2$/)).toHaveAttribute('aria-disabled', 'false');
    // The asset chips keep counting over every row — BTC still offers its 1.
    expect(chip(/^BTC 1$/)).toHaveAttribute('aria-disabled', 'false');
  });

  it('caps the tenor in days, keeping the card that prints exactly that number', async () => {
    server.use(opportunitiesHandler(multiPairResult()));
    renderWithClient(<OpportunitiesPanel />);

    // Two 30-day ETH cards and one 90-day BTC card.
    await waitFor(() => expect(toggles()).toHaveLength(3));
    await openMoreFilters();
    await userEvent.type(screen.getByLabelText('Matures within'), '30');

    // The 90-day cohort goes; "(30 days)" is inside a 30-day cap, not outside.
    await waitFor(() => expect(toggles()).toHaveLength(2));
    expect(screen.queryByText('8.0% APR')).not.toBeInTheDocument();
  });

  it('offers no filter row for a dimension that cannot exclude anything', async () => {
    server.use(opportunitiesHandler(makeOpportunitiesResult()));
    renderWithClient(<OpportunitiesPanel />);

    await waitFor(() => expect(toggles()).toHaveLength(1));
    // A single card: its one asset is obviously no choice.
    expect(screen.queryByText('Asset')).not.toBeInTheDocument();
    // Nor, once unfolded, its one maturity — nor its TWO venue chips, since the
    // card carries both legs, so picking either leaves what is already there.
    await openMoreFilters();
    expect(screen.queryByText('Matures')).not.toBeInTheDocument();
    expect(screen.queryByText('Venue')).not.toBeInTheDocument();
  });

  it('opens the refinements in a popover, dismissed by Escape, ✕ or a click outside', async () => {
    server.use(opportunitiesHandler(multiPairResult()));
    renderWithClient(<OpportunitiesPanel />);

    await waitFor(() => expect(toggles()).toHaveLength(3));
    const trigger = screen.getByRole('button', { name: 'Filters' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await openMoreFilters();
    const popover = screen.getByRole('dialog', { name: /venue, maturity and APR/i });
    expect(trigger).toHaveAttribute('aria-controls', popover.id);
    expect(within(popover).getByText('Venue')).toBeInTheDocument();
    expect(within(popover).getByLabelText('Matures within')).toBeInTheDocument();
    // The APR floor is gone — the hero APR is what the list is already sorted
    // by, so a second way to say "at least this much" earned nothing.
    expect(within(popover).queryByLabelText('Min APR')).not.toBeInTheDocument();

    // Escape hands the caret back to the icon that opened it.
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();

    await openMoreFilters();
    await userEvent.click(screen.getByRole('button', { name: 'dismiss' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    // The scrim behind it closes on a click anywhere outside.
    await openMoreFilters();
    await userEvent.click(document.querySelector('[role="presentation"]') as HTMLElement);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('restores last session\u2019s selection, and keeps it visible while it narrows', async () => {
    localStorage.setItem(
      OPPORTUNITY_FILTERS_STORAGE_KEY,
      JSON.stringify({ assets: ['BTC'], venues: ['GATE'], maxDaysText: '' }),
    );
    server.use(opportunitiesHandler(multiPairResult()));
    renderWithClient(<OpportunitiesPanel />);

    // Applied on the first render, not after a click.
    await waitFor(() => expect(toggles()).toHaveLength(1));
    expect(screen.getByText('showing 1 of 3')).toBeInTheDocument();
    // And ANNOUNCED: the asset chip is pressed, and the folded venue filter is
    // a count on the icon. A restored filter the reader cannot see reads as an
    // empty market, which is the whole risk of persisting one.
    expect(chip(/^BTC 1$/)).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Filters, 1 active' })).toBeInTheDocument();
  });

  it('keeps a restored selection releasable when today\u2019s data no longer has it', async () => {
    // SOL priced yesterday; today it does not.
    localStorage.setItem(
      OPPORTUNITY_FILTERS_STORAGE_KEY,
      JSON.stringify({ assets: ['SOL'], venues: [], maxDaysText: '' }),
    );
    server.use(opportunitiesHandler(multiPairResult()));
    renderWithClient(<OpportunitiesPanel />);

    await waitFor(() =>
      expect(screen.getByText('No opportunity matches these filters')).toBeInTheDocument(),
    );
    // The chip survives at count 0 so the reader can see WHAT is hiding the
    // list, and release it without the blanket Clear.
    expect(chip(/^SOL 0$/)).toHaveAttribute('aria-pressed', 'true');
    expect(chip(/^SOL 0$/)).toHaveAttribute('aria-disabled', 'false');

    await userEvent.click(chip(/^SOL 0$/));
    await waitFor(() => expect(toggles()).toHaveLength(3));
  });

  it('persists a change so the next mount opens with it', async () => {
    server.use(opportunitiesHandler(multiPairResult()));
    const { unmount } = renderWithClient(<OpportunitiesPanel />);

    await waitFor(() => expect(toggles()).toHaveLength(3));
    await userEvent.click(chip(/^BTC 1$/));
    await waitFor(() => expect(toggles()).toHaveLength(1));
    unmount();

    renderWithClient(<OpportunitiesPanel />);
    await waitFor(() => expect(toggles()).toHaveLength(1));
    expect(chip(/^BTC 1$/)).toHaveAttribute('aria-pressed', 'true');
  });

  it('badges the icon when a folded refinement is armed, and unbadges on Clear', async () => {
    server.use(opportunitiesHandler(multiPairResult()));
    renderWithClient(<OpportunitiesPanel />);

    await waitFor(() => expect(toggles()).toHaveLength(3));
    // Nothing armed behind the fold: the icon carries no count.
    expect(screen.getByRole('button', { name: 'Filters' })).toBeInTheDocument();

    await openMoreFilters();
    await userEvent.click(chip(/^Gate 2$/));
    await waitFor(() => expect(toggles()).toHaveLength(2));

    // Toggling a chip must not close the popover — a reader refining by venue
    // is usually picking more than one.
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    // Folded away, the armed venue filter must still be visible AS a count —
    // otherwise the list is narrowed for no reason the reader can see.
    await userEvent.click(screen.getByRole('button', { name: 'dismiss' }));
    expect(screen.queryByText('Venue')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Filters, 1 active' })).toBeInTheDocument();

    await openMoreFilters();
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Clear filters' }),
    );
    await waitFor(() => expect(toggles()).toHaveLength(3));
    expect(screen.getByRole('button', { name: 'Filters' })).toBeInTheDocument();
  });

  it('keeps a selected chip listed and releasable after its rows leave the data', async () => {
    server.use(opportunitiesHandler(multiPairResult()));
    renderWithClient(<OpportunitiesPanel />);

    await waitFor(() => expect(toggles()).toHaveLength(3));
    await userEvent.click(chip(/^BTC 1$/));
    await waitFor(() => expect(toggles()).toHaveLength(1));

    // The next response prices no BTC at all. The filter is still armed, so its
    // chip has to survive at count 0 — otherwise the list stays narrowed with
    // nothing on screen to explain it, and nothing to click to undo it.
    server.use(
      opportunitiesHandler(
        makeOpportunitiesResult({
          groups: [
            makeOpportunityGroup({ pairs: [venuePair(0.12, 'HYPERLIQUID', 'BINANCE')] }),
          ],
        }),
      ),
    );
    await userEvent.click(screen.getByTitle('Refetch strategy data'));

    await waitFor(() => expect(chip(/^BTC 0$/)).toBeInTheDocument());
    expect(chip(/^BTC 0$/)).toHaveAttribute('aria-pressed', 'true');
    // Still releasable at count 0 — never deadened while selected.
    expect(chip(/^BTC 0$/)).toHaveAttribute('aria-disabled', 'false');
    await userEvent.click(chip(/^BTC 0$/));
    await waitFor(() => expect(toggles()).toHaveLength(1));
  });

  it('filtered down to nothing blames the filters, not the assumptions', async () => {
    server.use(opportunitiesHandler(multiPairResult()));
    renderWithClient(<OpportunitiesPanel />);

    await waitFor(() => expect(toggles()).toHaveLength(3));
    await openMoreFilters();
    await userEvent.type(screen.getByLabelText('Matures within'), '1');

    await waitFor(() =>
      expect(screen.getByText('No opportunity matches these filters')).toBeInTheDocument(),
    );
    expect(screen.queryByText('No fixed-return opportunities')).not.toBeInTheDocument();
    // The bar survives, so the way out is still in reach.
    expect(screen.getByText('showing 0 of 3')).toBeInTheDocument();

    await userEvent.click(
      within(screen.getByText('No opportunity matches these filters').parentElement as HTMLElement)
        .getByRole('button', { name: 'Clear filters' }),
    );
    await waitFor(() => expect(toggles()).toHaveLength(3));
  });

  it('hides the bar entirely when the assumptions price nothing', async () => {
    server.use(opportunitiesHandler(makeOpportunitiesResult({ groups: [] })));
    renderWithClient(<OpportunitiesPanel />);

    await waitFor(() =>
      expect(screen.getByText('No fixed-return opportunities')).toBeInTheDocument(),
    );
    expect(screen.queryByRole('group', { name: 'Filter opportunities' })).not.toBeInTheDocument();
  });
});
