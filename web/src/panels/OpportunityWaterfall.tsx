/** The opportunity card's Tier-2 visual: TWO waterfalls, on INDEPENDENT axes.
 *
 *  LEFT  — profit by maturity: the gross spread return stepped down through the
 *          Boros book impact and every cost to the estimated profit.
 *  RIGHT — capital (modelled min): the four initial-margin components stacked
 *          up to the capital the trade must post.
 *
 * The two carry unrelated magnitudes (capital is routinely 10-100x the profit),
 * so each gets its own scale — unlike the strategy card's pair, which share one
 * axis because the "now" line is heading for the profit target.
 *
 * Both identities close by construction. Profit, with
 * NT = notional x secondsToMaturity/(365 x 86400) matching the server's
 * `notionalYears`: gross x NT − impact x NT − Σcosts = estProfitUsd. Capital:
 * the four margins sum to capitalUsd. A dev-only warning fires on any drift.
 */
import { useTranslation } from 'react-i18next';
import type { OpportunityPair } from '../api/types';
import { t } from '../i18n';
import {
  applyValueLabels,
  computeWaterfallScale,
  costText,
  dashedAmber,
  dashedEmerald,
  WaterfallPlot,
  type WaterfallStep,
} from '../components/Waterfall';
import { fmtPct, fmtUsd, prettyVenue } from '../lib/fmt';
import { spreadName } from '../lib/spread';

const SECONDS_IN_YEAR = 365 * 86_400;

/** The profit chart needs the whole chain from the locked spread to the
 * profit; any missing link leaves the text ledger to explain itself. */
export function canChartProfit(pair: OpportunityPair): boolean {
  return (
    pair.estProfitUsd !== null && pair.execSpreadApr !== null && pair.costs.totalUsd !== null
  );
}

/** `> 0` doubles as the span guard: every capital level sits in [0, capitalUsd]. */
export function canChartCapital(pair: OpportunityPair): boolean {
  return pair.capitalUsd !== null && pair.capitalUsd > 0;
}

/** [key, usd, className, axisLabel, title] — the profit chart's decrements, in
 * the order they are incurred. At-entry costs are solid amber; costs paid over
 * the life or at maturity are dashed amber (pattern, not colour alone). */
function costRows(pair: OpportunityPair): Array<[string, number | null, string, string, string]> {
  const c = pair.costs;
  return [
    [
      'opp-boros-taker',
      c.borosTakerFeeUsd,
      'bg-amber-500/75',
      t('opportunities.waterfall.borosTaker'),
      t(pair.borosLegs.length > 1 ? 'opportunities.waterfall.borosTakerTitleBoth' : 'opportunities.waterfall.borosTakerTitle', {
        cost: costText(c.borosTakerFeeUsd),
      }),
    ],
    [
      'opp-boros-settle',
      c.borosSettleFeeUsd,
      dashedAmber,
      t('opportunities.waterfall.borosSettle'),
      t('opportunities.waterfall.borosSettleTitle', { cost: costText(c.borosSettleFeeUsd, true) }),
    ],
    // A favorable (negative) cost right after the settlement fee it rebates —
    // present only when `applyRebate` credited it (toggle on). A dashedAmber
    // marker draws as dashed emerald because the amount is negative.
    ...((c.borosSettleRebateUsd ?? 0) > 0
      ? ([
          [
            'opp-boros-settle-rebate',
            -(c.borosSettleRebateUsd as number),
            dashedAmber,
            t('opportunities.waterfall.settleRebate'),
            t('opportunities.waterfall.settleRebateTitle', {
              cost: costText(-(c.borosSettleRebateUsd as number), true),
            }),
          ] as [string, number | null, string, string, string],
        ])
      : []),
    [
      'opp-perp-entry-fees',
      c.perpEntryFeesUsd,
      'bg-amber-500/55',
      t('opportunities.waterfall.perpEntryFees'),
      t('opportunities.waterfall.perpEntryFeesTitle', { cost: costText(c.perpEntryFeesUsd ?? 0) }),
    ],
    [
      'opp-entry-slip',
      c.perpEntrySlippageUsd,
      'bg-amber-500/40',
      t('opportunities.waterfall.entrySlip'),
      t('opportunities.waterfall.entrySlipTitle', { cost: costText(c.perpEntrySlippageUsd ?? 0) }),
    ],
    [
      'opp-exit-fees',
      c.perpExitFeesUsd,
      dashedAmber,
      t('opportunities.waterfall.perpExitFees'),
      (c.perpExitFeesUsd ?? 0) === 0
        ? t('opportunities.waterfall.noExitFee')
        : t('opportunities.waterfall.perpExitFeesTitle', { cost: costText(c.perpExitFeesUsd ?? 0, true) }),
    ],
    [
      'opp-exit-slip',
      c.perpExitSlippageUsd,
      dashedAmber,
      t('opportunities.waterfall.exitSlip'),
      // NOT "assumed = entry" — that is the strategy view's estimate. Here the
      // server crosses back out of today's books to price it.
      (c.perpExitSlippageUsd ?? 0) === 0
        ? t('opportunities.waterfall.noExitSlip')
        : t('opportunities.waterfall.exitSlipTitle', { cost: costText(c.perpExitSlippageUsd ?? 0, true) }),
    ],
  ];
}

function buildProfitSteps(pair: OpportunityPair, notionalUsd: number): WaterfallStep[] {
  const nt = (notionalUsd * pair.secondsToMaturity) / SECONDS_IN_YEAR;
  /**
   * The chart OPENS on the spread the pair actually locks — post price
   * impact, the same rates the leg cards above it quote ("at 8.1% after
   * impact"). It used to open on the MID spread and step down a "Boros
   * impact" bar to get here: a cost for a number shown nowhere else on the
   * card, since every rate on it is already after impact (his call
   * 2026-09-20). The mid spread rides on the bar's hover.
   */
  const grossUsd = (pair.execSpreadApr as number) * nt;
  const profitUsd = pair.estProfitUsd as number;

  const steps: WaterfallStep[] = [
    {
      // Keyed `spread` so the plot withholds data-tone from the opening total,
      // exactly as it does on the strategy card.
      key: 'spread',
      kind: 'total',
      // A negative locked spread must not read as an upward emerald gain.
      dir: grossUsd >= 0 ? 'up' : 'down',
      from: 0,
      to: grossUsd,
      className: grossUsd >= 0 ? 'bg-emerald-500' : 'bg-rose-500',
      title: t('opportunities.waterfall.spreadTitle', {
        usd: fmtUsd(grossUsd),
        apr: fmtPct(pair.execSpreadApr as number),
        mid: fmtPct(pair.grossSpreadApr),
      }),
      axisLabel: t('opportunities.waterfall.lockedSpread'),
    },
  ];

  let level = grossUsd;
  for (const [key, usd, cls, axisLabel, title] of costRows(pair)) {
    // Zero is skipped, not drawn: under `roll` the server sends 0 exit costs,
    // which is what removes those columns (never the exitMode prop — data and
    // mode disagree mid-refetch, and the identity must always close).
    if (usd === null || usd === 0) continue;
    const from = level;
    level -= usd; // signed: a favorable (negative) cost raises the level
    const isFuture = cls === dashedAmber;
    steps.push({
      key,
      kind: isFuture ? 'cost-future' : 'cost-paid',
      dir: usd > 0 ? 'down' : 'up',
      from,
      to: level,
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
    title: t('opportunities.waterfall.profitTitle', { usd: fmtUsd(profitUsd) }),
    axisLabel: t('opportunities.waterfall.estProfit'),
  });
  if (import.meta.env.DEV && Math.abs(level - profitUsd) > 0.01) {
    // eslint-disable-next-line no-console
    console.warn('waterfall identity drift (opportunity profit)', { level, profitUsd });
  }
  return steps;
}

function buildCapitalSteps(pair: OpportunityPair): WaterfallStep[] {
  const cap = pair.capital;
  const total = pair.capitalUsd as number;
  const lev = (max: number | null) =>
    max === null || !Number.isFinite(max) ? '' : ` @ ${max}x`;

  // Capital is neither income nor cost, so it is drawn in `info` blue rather
  // than the green/gold the profit chart uses for gains and costs — the
  // register, on an alpha ramp in stacking order.
  const borosRows = pair.borosLegs.map((leg): [string, number | null, string, string, string] => {
    const imUsd = cap.borosIms.find((im) => im.marketId === leg.marketId)?.imUsd ?? null;
    const side = leg.side === 'SHORT' ? 'short' : 'long';
    const margin = `+${fmtUsd(imUsd ?? 0)}`;
    return leg.spreadVenues
      ? [
          `cap-boros-${leg.marketId}`,
          imUsd,
          'bg-info/45',
          t('opportunities.waterfall.borosSpreadIm'),
          t(side === 'short' ? 'opportunities.waterfall.borosImTitleShort' : 'opportunities.waterfall.borosImTitleLong', {
            name: spreadName(pair.base, leg.spreadVenues),
            margin,
          }),
        ]
      : [
          `cap-boros-${side}`,
          imUsd,
          'bg-info/45',
          t(side === 'short' ? 'opportunities.waterfall.borosShortIm' : 'opportunities.waterfall.borosLongIm'),
          t(side === 'short' ? 'opportunities.waterfall.borosImTitleShort' : 'opportunities.waterfall.borosImTitleLong', {
            name: prettyVenue(leg.venue),
            margin,
          }),
        ];
  });
  const rows: Array<[string, number | null, string, string, string]> = [
    ...borosRows,
    [
      'cap-perp-short',
      cap.perpShortImUsd,
      'bg-ink-300/30',
      t('opportunities.waterfall.perpShortIm', { lev: lev(cap.shortLeverageMax) }),
      t('opportunities.waterfall.perpImTitleShort', {
        venue: prettyVenue(pair.shortLeg.venue),
        lev: lev(cap.shortLeverageMax),
        usd: fmtUsd(cap.perpShortImUsd ?? 0),
      }),
    ],
    [
      'cap-perp-long',
      cap.perpLongImUsd,
      'bg-ink-300/30',
      t('opportunities.waterfall.perpLongIm', { lev: lev(cap.longLeverageMax) }),
      t('opportunities.waterfall.perpImTitleLong', {
        venue: prettyVenue(pair.longLeg.venue),
        lev: lev(cap.longLeverageMax),
        usd: fmtUsd(cap.perpLongImUsd ?? 0),
      }),
    ],
  ];

  const steps: WaterfallStep[] = [];
  let level = 0;
  for (const [key, usd, className, axisLabel, title] of rows) {
    if (usd === null || usd === 0) continue;
    const from = level;
    level += usd;
    steps.push({ key, kind: 'capital', dir: 'up', from, to: level, className, axisLabel, title });
  }
  steps.push({
    key: 'cap-total',
    kind: 'total',
    dir: 'up',
    from: 0,
    to: total,
    className: 'bg-info',
    title: t(pair.borosLegs.length === 1 ? 'opportunities.waterfall.capitalTitleThree' : 'opportunities.waterfall.capitalTitleFour', {
      usd: fmtUsd(total),
    }),
    axisLabel: t('opportunities.waterfall.totalCapital'),
  });
  if (import.meta.env.DEV && Math.abs(level - total) > 0.01) {
    // eslint-disable-next-line no-console
    console.warn('waterfall identity drift (opportunity capital)', { level, total });
  }
  return steps;
}

/** Spells out the profit chart's amber convention: solid = cost already locked
 * in, dashed = cost still to be incurred (pattern, not colour alone). */
function ProfitLegend() {
  const { t } = useTranslation();
  return (
    <>
      <span aria-hidden className="flex cursor-help items-center gap-1.5 text-[9.5px] text-ink-400" title={t('opportunities.waterfall.lockedInTitle')}>
        <span className="h-2 w-2.5 shrink-0 rounded-sm bg-amber-500/85" />
        {t('opportunities.waterfall.lockedIn')}
      </span>
      <span aria-hidden className="flex cursor-help items-center gap-1.5 text-[9.5px] text-ink-400" title={t('opportunities.waterfall.futureTitle')}>
        <span className="box-border h-2 w-2.5 shrink-0 rounded-sm border border-dashed border-amber-500/70 bg-amber-500/10" />
        {t('opportunities.waterfall.future')}
      </span>
    </>
  );
}

export function OpportunityWaterfall({
  pair,
  notionalUsd,
}: {
  pair: OpportunityPair;
  /** The notional the pair was priced at — pair.notionalUsd, not the live
   * control, so the USD conversion matches the costs it is charted against. */
  notionalUsd: number;
}) {
  const { t } = useTranslation();
  // The roll is read off the DATA, not the live exitMode control (which moves
  // before the refetch lands): a zero exit cost IS the rolled-over case, and
  // the two exit segments' own titles say so where the reader meets them.
  const profitSteps = canChartProfit(pair) ? buildProfitSteps(pair, notionalUsd) : null;
  const capitalSteps = canChartCapital(pair) ? buildCapitalSteps(pair) : null;

  const left = computeWaterfallScale(profitSteps ? [profitSteps] : []);
  const right = computeWaterfallScale(capitalSteps ? [capitalSteps] : []);
  const showProfit = profitSteps !== null && left.span > 0;
  const showCapital = capitalSteps !== null && right.span > 0;
  if (!showProfit && !showCapital) return null;
  if (profitSteps) applyValueLabels(profitSteps);
  if (capitalSteps) applyValueLabels(capitalSteps);

  const label = [
    showProfit
      ? t('opportunities.waterfall.ariaProfit', {
          spread: fmtUsd(profitSteps![0].to, 0),
          profit: fmtUsd(pair.estProfitUsd ?? 0, 0),
        })
      : null,
    showCapital
      ? t('opportunities.waterfall.ariaCapital', { capital: fmtUsd(pair.capitalUsd ?? 0, 0) })
      : null,
  ]
    .filter(Boolean)
    .join('; ');

  return (
    <div>
      <div data-waterfall role="img" aria-label={t('opportunities.waterfall.aria', { label })} className="relative pt-3">
        {/* Side by side the two plots split a phone's width into ~20px columns,
            narrower than the value labels themselves, so adjacent labels
            overlapped into a smear and spilled out of the card. */}
        {/* Each plot sits in its own bordered pane with a titled header and a
            summary row that names the number the bars build to — the mock's
            shape. Auto-fit rather than a plain row: on a phone the two plots
            would split into ~20px columns, narrower than the value labels,
            which smeared them into each other. */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[repeat(auto-fit,minmax(280px,1fr))]">
          {showProfit && (
            <div className="flex min-w-0 flex-col gap-3 rounded border border-wash/10 px-4 py-3.5">
              <span className="text-[14px] font-semibold text-ink-50">{t('opportunities.waterfall.profitByMaturity')}</span>
              <WaterfallPlot
                steps={profitSteps!}
                y={left.y}
                span={left.span}
                domainMin={left.domainMin}
                caption={t('opportunities.waterfall.profitCaption')}
                showCaption={false}
                legend={<ProfitLegend />}
              />
              <span className="flex items-baseline justify-between gap-3 border-t border-ink-700 pt-[9px]">
                <span className="text-[11.5px] text-ink-200">{t('opportunities.waterfall.estProfit')}</span>
                <span
                  className={`num whitespace-nowrap text-sm font-semibold ${
                    (pair.estProfitUsd ?? 0) < 0 ? 'text-guava' : 'text-grass'
                  }`}
                >
                  {fmtUsd(pair.estProfitUsd ?? 0, 0)}
                </span>
              </span>
            </div>
          )}
          {showCapital && (
            <div className="flex min-w-0 flex-col gap-3 rounded border border-wash/10 px-4 py-3.5">
              <span className="tip-label self-start text-[14px] font-semibold text-ink-50" title={t('opportunities.waterfall.capitalModelledTitle')}>
                {t('opportunities.waterfall.capitalModelled')}
              </span>
              <WaterfallPlot
                steps={capitalSteps!}
                y={right.y}
                span={right.span}
                domainMin={right.domainMin}
                caption={t('opportunities.waterfall.capitalCaption')}
                showCaption={false}
              />
              <span className="flex items-baseline justify-between gap-3 border-t border-ink-700 pt-[9px]">
                <span className="text-[11.5px] text-ink-200">{t('opportunities.waterfall.totalCapital')}</span>
                <span className="num whitespace-nowrap text-sm font-semibold text-ink-50">
                  {fmtUsd(pair.capitalUsd ?? 0, 0)}
                </span>
              </span>
            </div>
          )}
        </div>
      </div>

      {/* No prose under the charts. The mock carries none, and each line here
          either repeated a number the panes already state or explained a
          convention the axis labels carry. The maker-leg and rolling facts
          survive as titles on the segments they qualify. */}
    </div>
  );
}
