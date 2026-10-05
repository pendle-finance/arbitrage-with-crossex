/** The LTP opportunity card's Tier-2 visual — same two-waterfall layout as
 * OpportunityWaterfall, with the two structural differences the MarginX model
 * introduces:
 *
 *  LEFT  — profit by maturity gains ONE row: the MarginX loan interest, a
 *          future cost (dashed), accrued over the life, so it sits before the
 *          at-maturity exit costs.
 *  RIGHT — capital: Boros IMs step UP, the perp collateral REQUIRED steps up —
 *          then the MarginX borrow steps DOWN (financed, not posted), closing
 *          on capitalUsd = IMs + posted. The peak (IMs + required) sits ABOVE
 *          the closing total, which the shared scale handles (it spans every
 *          level, not [0, total]).
 *
 * Identity checks mirror the CrossEx file: profit closes on estProfitUsd,
 * capital on capitalUsd, DEV warning on drift.
 */
import type { LtpOpportunityPair } from '../api/ltpTypes';
import {
  applyValueLabels,
  computeWaterfallScale,
  costText,
  dashedAmber,
  dashedEmerald,
  WaterfallPlot,
  type WaterfallStep,
} from '../components/Waterfall';
import { fmtPct, fmtUsd } from '../lib/fmt';

function costRows(
  pair: Pick<LtpOpportunityPair, 'costs' | 'execSpreadApr' | 'grossSpreadApr'>,
  impactUsd: number,
): Array<[string, number | null, string, string, string]> {
  const c = pair.costs;
  return [
    [
      'opp-boros-impact',
      impactUsd,
      'bg-amber-500',
      'Boros impact',
      // Mode-agnostic: under `market` this is the book walk, under `mark` it is
      // mark-vs-mid. Either way it is the gap between the mid spread and what
      // the pair actually locks.
      `Boros price impact ${costText(impactUsd)} — the pair locks ${fmtPct(pair.execSpreadApr ?? 0)} rather than the ${fmtPct(pair.grossSpreadApr)} mid spread`,
    ],
    [
      'opp-boros-taker',
      c.borosTakerFeeUsd,
      'bg-amber-500/75',
      'Boros taker fee',
      `Boros taker fees, both legs ${costText(c.borosTakerFeeUsd)}`,
    ],
    [
      'opp-boros-settle',
      c.borosSettleFeeUsd,
      dashedAmber,
      'Boros settlement',
      `Boros settlement fees accrued to maturity ${costText(c.borosSettleFeeUsd, true)}`,
    ],
    [
      'opp-perp-entry-fees',
      c.perpEntryFeesUsd,
      'bg-amber-500/55',
      'Perp entry fees',
      `Perp entry fees, both legs ${costText(c.perpEntryFeesUsd ?? 0)}`,
    ],
    [
      'opp-entry-slip',
      c.perpEntrySlippageUsd,
      'bg-amber-500/40',
      'Entry slip',
      `Perp entry slippage ${costText(c.perpEntrySlippageUsd ?? 0)}`,
    ],
    [
      'opp-exit-fees',
      c.perpExitFeesUsd,
      dashedAmber,
      'Perp exit fees',
      `Perp exit fees at maturity ${costText(c.perpExitFeesUsd ?? 0, true)}`,
    ],
    [
      'opp-exit-slip',
      c.perpExitSlippageUsd,
      dashedAmber,
      'Exit slip',
      // NOT "assumed = entry" — that is the strategy view's estimate. Here the
      // server crosses back out of today's books to price it.
      `Perp exit slippage, crossing back out of both books at maturity ${costText(c.perpExitSlippageUsd ?? 0, true)}`,
    ],
  ];
}

const profitLegend = (
  <>
    <span aria-hidden className="flex items-center gap-1.5 text-[9.5px] text-ink-400">
      <span className="h-2 w-2.5 shrink-0 rounded-sm bg-amber-500/85" />
      locked in
    </span>
    <span aria-hidden className="flex items-center gap-1.5 text-[9.5px] text-ink-400">
      <span className="box-border h-2 w-2.5 shrink-0 rounded-sm border border-dashed border-amber-500/70 bg-amber-500/10" />
      future
    </span>
  </>
);

const dashedCyan = 'box-border border border-dashed border-cyan-400/70 bg-cyan-400/10';

const SECONDS_IN_YEAR = 365 * 86_400;

export function canChartLtpProfit(pair: LtpOpportunityPair): boolean {
  return (
    pair.estProfitUsd !== null && pair.borosImpactApr !== null && pair.costs.totalUsd !== null
  );
}

/** The down-step keeps every level in [0, peak], so `> 0` still guards the span. */
export function canChartLtpCapital(pair: LtpOpportunityPair): boolean {
  return pair.capitalUsd !== null && pair.capitalUsd > 0;
}

function buildProfitSteps(pair: LtpOpportunityPair, notionalUsd: number): WaterfallStep[] {
  const nt = (notionalUsd * pair.secondsToMaturity) / SECONDS_IN_YEAR;
  const grossUsd = pair.grossSpreadApr * nt;
  const impactUsd = (pair.borosImpactApr ?? 0) * nt;
  const profitUsd = pair.estProfitUsd as number;

  // The shared CrossEx rows, with the loan-interest row spliced in before the
  // at-maturity exit costs (interest accrues over the LIFE of the borrow).
  const rows = costRows(pair, impactUsd);
  const exitIdx = rows.findIndex(([key]) => key === 'opp-exit-fees');
  rows.splice(exitIdx === -1 ? rows.length : exitIdx, 0, [
    'ltp-loan-interest',
    pair.costs.loanInterestUsd,
    dashedAmber,
    'MarginX interest',
    `MarginX loan interest on ${fmtUsd(pair.capital.borrowedUsd)} borrowed, accrued to maturity ${costText(pair.costs.loanInterestUsd, true)}`,
  ]);

  const steps: WaterfallStep[] = [
    {
      key: 'spread',
      kind: 'total',
      dir: grossUsd >= 0 ? 'up' : 'down',
      from: 0,
      to: grossUsd,
      className: grossUsd >= 0 ? 'bg-emerald-500' : 'bg-rose-500',
      title: `Gross spread return ${fmtUsd(grossUsd)} — ${fmtPct(pair.grossSpreadApr)} on the notional to maturity`,
      axisLabel: 'Gross spread',
    },
  ];

  let level = grossUsd;
  for (const [key, usd, cls, axisLabel, title] of rows) {
    if (usd === null || usd === 0) continue;
    const from = level;
    level -= usd;
    const isFuture = cls === dashedAmber;
    steps.push({
      key,
      kind: isFuture ? 'cost-future' : 'cost-paid',
      dir: usd > 0 ? 'down' : 'up',
      from,
      to: level,
      // A negative cost (a VIP4+ maker REBATE) raises the level and wears the
      // gain colour, exactly like the CrossEx chart's favorable rows.
      className: usd > 0 ? cls : isFuture ? dashedEmerald : 'bg-emerald-500/80',
      title,
      axisLabel,
    });
  }

  steps.push({
    key: 'profit',
    kind: 'total',
    dir: profitUsd >= 0 ? 'up' : 'down',
    from: 0,
    to: profitUsd,
    className: profitUsd >= 0 ? 'bg-emerald-500' : 'bg-rose-500',
    title: `Estimated profit by maturity ${fmtUsd(profitUsd)} — the locked spread minus every cost, including the MarginX loan interest`,
    axisLabel: 'Est. profit',
  });
  if (import.meta.env.DEV && Math.abs(level - profitUsd) > 0.01) {
    // eslint-disable-next-line no-console
    console.warn('waterfall identity drift (LTP opportunity profit)', { level, profitUsd });
  }
  return steps;
}

function buildCapitalSteps(pair: LtpOpportunityPair): WaterfallStep[] {
  const cap = pair.capital;
  const total = pair.capitalUsd as number;

  const steps: WaterfallStep[] = [];
  let level = 0;
  const up = (key: string, usd: number | null, className: string, axisLabel: string, title: string) => {
    if (usd === null || usd === 0) return;
    const from = level;
    level += usd;
    steps.push({ key, kind: 'capital', dir: 'up', from, to: level, className, axisLabel, title });
  };

  up(
    'cap-boros-short',
    cap.borosShortImUsd,
    'bg-cyan-400/80',
    'Boros short IM',
    `Boros initial margin · ${pair.shortLeg.venue} (short) +${fmtUsd(cap.borosShortImUsd ?? 0)}`,
  );
  up(
    'cap-boros-long',
    cap.borosLongImUsd,
    'bg-cyan-400/60',
    'Boros long IM',
    `Boros initial margin · ${pair.longLeg.venue} (long) +${fmtUsd(cap.borosLongImUsd ?? 0)}`,
  );
  const levLabel =
    cap.shortLegLeverage === cap.longLegLeverage
      ? `${cap.shortLegLeverage}x`
      : `${cap.shortLegLeverage}x/${cap.longLegLeverage}x`;
  up(
    'cap-perp-required',
    cap.perpCollateralRequiredUsd,
    'bg-cyan-400/45',
    `Perp collateral @ ${levLabel}`,
    `Perp collateral required · both venues, one MarginX group — each leg's notional over its own leverage (short ${cap.shortLegLeverage}×, long ${cap.longLegLeverage}×) +${fmtUsd(cap.perpCollateralRequiredUsd)}`,
  );
  if (cap.borrowedUsd > 0) {
    const from = level;
    level -= cap.borrowedUsd;
    steps.push({
      key: 'cap-borrowed',
      kind: 'capital',
      dir: 'down',
      from,
      to: level,
      className: dashedCyan,
      axisLabel: 'MarginX borrow',
      title: `MarginX borrow −${fmtUsd(cap.borrowedUsd)} — financed at ${cap.borrowLeverage}× borrow leverage, not posted; you post ${fmtUsd(cap.postedPerpCollateralUsd)} of the perp collateral`,
    });
  }
  steps.push({
    key: 'cap-total',
    kind: 'total',
    dir: 'up',
    from: 0,
    to: total,
    className: 'bg-cyan-400',
    title: `Capital you post ${fmtUsd(total)} — Boros margins plus the posted share of the perp collateral`,
    axisLabel: 'You post',
  });
  if (import.meta.env.DEV && Math.abs(level - total) > 0.01) {
    // eslint-disable-next-line no-console
    console.warn('waterfall identity drift (LTP opportunity capital)', { level, total });
  }
  return steps;
}

export function LtpOpportunityWaterfall({
  pair,
  notionalUsd,
  showEffectiveLeverage = true,
}: {
  pair: LtpOpportunityPair;
  /** The notional the RESPONSE priced — meta.notionalUsd, not the live control. */
  notionalUsd: number;
  /** The /ltp pitch page hides this footnote; the terminal tab keeps it. */
  showEffectiveLeverage?: boolean;
}) {
  const rolling = pair.costs.perpExitFeesUsd === 0 && pair.costs.perpExitSlippageUsd === 0;
  const profitSteps = canChartLtpProfit(pair) ? buildProfitSteps(pair, notionalUsd) : null;
  const capitalSteps = canChartLtpCapital(pair) ? buildCapitalSteps(pair) : null;

  const left = computeWaterfallScale(profitSteps ? [profitSteps] : []);
  const right = computeWaterfallScale(capitalSteps ? [capitalSteps] : []);
  const showProfit = profitSteps !== null && left.span > 0;
  const showCapital = capitalSteps !== null && right.span > 0;
  if (!showProfit && !showCapital) return null;
  if (profitSteps) applyValueLabels(profitSteps);
  if (capitalSteps) applyValueLabels(capitalSteps);

  const label = [
    showProfit
      ? `gross spread return ${fmtUsd(profitSteps![0].to, 0)} minus Boros impact, costs and MarginX loan interest to an estimated profit of ${fmtUsd(pair.estProfitUsd ?? 0, 0)}`
      : null,
    showCapital
      ? `capital you post ${fmtUsd(pair.capitalUsd ?? 0, 0)}: Boros margins plus the perp collateral net of the MarginX borrow`
      : null,
  ]
    .filter(Boolean)
    .join('; ');

  return (
    <div>
      <div data-waterfall role="img" aria-label={`Waterfalls: ${label}`} className="relative pt-3">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-stretch">
          {showProfit && (
            <WaterfallPlot
              steps={profitSteps!}
              y={left.y}
              span={left.span}
              domainMin={left.domainMin}
              caption="profit by maturity"
              legend={profitLegend}
            />
          )}
          {showCapital && (
            <WaterfallPlot
              steps={capitalSteps!}
              y={right.y}
              span={right.span}
              domainMin={right.domainMin}
              caption="capital you post"
            />
          )}
        </div>
      </div>

      <div className="mt-2 flex flex-col gap-0.5 leading-relaxed text-ink-500">
        {showProfit && rolling && <div>rolling — no exit cost</div>}
        {showProfit && pair.makerLeg && (
          <div>
            Maker leg <span className="text-ink-200">{pair.makerLeg}</span>
          </div>
        )}
        {showCapital &&
          showEffectiveLeverage &&
          pair.effectiveLeverage !== null &&
          Number.isFinite(pair.effectiveLeverage) && (
            <div>
              <span className="num">{pair.effectiveLeverage.toFixed(1)}x</span> effective leverage —
              the notional over the capital you post
            </div>
          )}
        {showCapital && pair.capital.borrowedUsd > 0 && (
          <div>
            The MarginX borrow carries its own 5% maintenance margin and liquidation dynamics on
            top of the position&apos;s.
          </div>
        )}
      </div>
    </div>
  );
}
