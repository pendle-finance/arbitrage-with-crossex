/**
 * The preview card's waterfalls — CLASSIC PRESENTATION, LEDGER NUMBERS.
 *
 *  LEFT  — PnL by maturity: the spread locked over each tranche's actual
 *          enrollment→maturity window, stepped down through the fees charged
 *          in-window to the projection. Same shape, titles and colours as the
 *          classic card (shared via buildCostWaterfallSteps), but every input
 *          is windowed to the strategy's own life — which is exactly what the
 *          classic chart gets wrong on a reused or DCA'd leg.
 *  RIGHT — current PnL (now): costs first, then perp funding, Boros funding
 *          (gross), Boros rate MtM + trade PnL, and banked contributions,
 *          building to the card's number with the dashed "now" line landing
 *          on it. Components come from StrategyView.flows, whose windowed
 *          decomposition sums to the total by construction.
 */
import {
  applyValueLabels,
  buildCostWaterfallSteps,
  computeWaterfallScale,
  dashedAmber,
  dashedCyan,
  WaterfallPlot as Plot,
  type CostRow,
  type WaterfallStep as Step,
} from '../../components/Waterfall';
import { fmtUsd } from '../../lib/fmt';
import type { StrategyView } from './model';

export function LedgerBars({ view }: { view: StrategyView }) {
  const f = view.flows;

  // --- LEFT: spread locked → fees → PnL by maturity -----------------------
  const costRows: CostRow[] = [
    ['paid-perp-fees', f.perpFeesUsd || null, 'bg-amber-500', 'Perp fees'],
    // A recorded venue-switch gap REPLACES the simultaneous-entry gap — one
    // slippage charge either way (price MtM is excluded from the nets).
    [
      'paid-entry-slippage',
      f.slippageUsd || null,
      'bg-amber-500/90',
      f.slippageKind === 'switch' ? 'Switch cost' : 'Entry slippage',
    ],
    ['paid-boros-trade', f.borosTradeFeesUsd || null, 'bg-amber-500/80', 'Boros trade fees'],
    ['paid-boros-settle', f.settleFeesPaidUsd || null, 'bg-amber-600/80', 'Settle fees paid'],
    ['future-boros-settle', f.futureSettleFeesUsd || null, dashedAmber, 'Settle fees →mat'],
  ];
  const projected = view.projectedPnlUsd;
  const left: Step[] =
    projected !== null
      ? buildCostWaterfallSteps({
          spreadReturnUsd: f.spreadLockedUsd,
          profitUsd: projected,
          costRows,
        })
      : [];

  // --- RIGHT: costs → funding components → now ----------------------------
  const right: Step[] = [];
  let level = 0;
  const component = (
    key: string,
    usd: number,
    className: string,
    title: string,
    axisLabel: string,
  ) => {
    if (usd === 0) return;
    const from = level;
    level += usd;
    right.push({
      key,
      kind: 'income',
      dir: usd >= 0 ? 'up' : 'down',
      from,
      to: level,
      className,
      title: `${title} ${fmtUsd(usd)}`,
      axisLabel,
    });
  };
  component('r-perp-fees', -f.perpFeesUsd, 'bg-amber-500', 'Perp trading fees paid', 'Perp fees');
  component(
    'r-slip',
    -f.slippageUsd,
    'bg-amber-500/90',
    f.slippageKind === 'switch' ? 'Venue-switch slippage recorded' : 'Perp entry slippage (est.)',
    f.slippageKind === 'switch' ? 'Switch cost' : 'Entry slip',
  );
  component('r-boros-fees', -f.borosTradeFeesUsd, 'bg-amber-500/80', 'Boros trading fees paid', 'Boros fees');
  component('r-settle-fees', -f.settleFeesPaidUsd, 'bg-amber-600/80', 'Settlement fees paid', 'Settle fees');
  component('r-perp-fr', f.perpFundingUsd, 'bg-cyan-400/80', 'Perp funding since enrollment', 'Perp FR');
  component('r-boros-fr', f.borosFundingGrossUsd, 'bg-teal-500/80', 'Boros settlements since enrollment (gross)', 'Boros FR');
  component('r-boros-mtm', f.borosMtmTradeUsd, dashedCyan, 'Boros rate MtM + trade PnL', 'Boros MtM');
  component('r-banked', view.bankedPnlUsd, 'bg-cyan-400/60', 'Banked from retired/closed legs', 'Banked');
  right.push({
    key: 'now',
    kind: 'total',
    dir: view.pnlUsd >= 0 ? 'up' : 'down',
    from: 0,
    to: view.pnlUsd,
    className: view.pnlUsd >= 0 ? 'bg-cyan-400' : 'bg-rose-500',
    title: `Current PnL ${fmtUsd(view.pnlUsd)}`,
    axisLabel: 'Now',
  });

  if (left.length < 2 && right.length < 2) return null;
  applyValueLabels(left);
  applyValueLabels(right);
  const { y, span, domainMin } = computeWaterfallScale([left, right], [view.pnlUsd]);
  if (!(span > 0)) return null;

  return (
    <div className="mt-3 flex gap-6">
      {left.length >= 2 && (
        <Plot
          steps={left}
          y={y}
          span={span}
          domainMin={domainMin}
          caption="PnL by maturity — spread locked over each tranche's window, less fees"
        />
      )}
      <Plot
        steps={right}
        y={y}
        span={span}
        domainMin={domainMin}
        caption="Current PnL (now)"
        mtmUsd={view.pnlUsd}
        mtmChip
      />
    </div>
  );
}
