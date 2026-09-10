/**
 * The asset's PnL as ONE waterfall, in the order the trader reads the trade:
 *
 *   Fixed funding (Boros settlements + perp funding — the spread being
 *   locked, as ONE bar: the rows in the Funding Legs table sum to it)
 *   → Boros trade PnL (small, signed) → the three costs → net PnL.
 *
 * "Perp basis" is the price package — open uPnL + closed realized price
 * PnL — which a delta-neutral book expects near zero; drawing it as one bar
 * makes a leak visible immediately. Boros MtM is deliberately absent (info
 * only, converges to zero at maturity).
 *
 * Same primitives and colour conventions as every other waterfall in the app.
 * Gross/net note: settlements are drawn NET of their settlement fee — that
 * fee is unavoidable and already inside the locked rate, so it is never
 * listed as a cost (the header's `carryGrossUsd` is built the same way, and
 * the two must agree). Trade PnL is drawn gross and its fee subtracted as a
 * bar, because a different entry could have paid less. The end bar lands on
 * totals.pnlUsd exactly, by construction.
 */
import {
  applyValueLabels,
  computeWaterfallScale,
  WaterfallPlot as Plot,
  type WaterfallStep as Step,
} from '../../components/Waterfall';
import { fmtUsd } from '../../lib/fmt';
import type { AssetTotals } from './assetModel';

export function AssetBars({ totals }: { totals: AssetTotals }) {
  const b = totals.breakdown;
  const tradeGross = b.borosTradePnlUsd + b.borosTradeFeeUsd;

  const steps: Step[] = [];
  let level = 0;
  /**
   * `className` is the colour for a POSITIVE step; `negClassName` for a
   * negative one. A signed income (negative funding, a settlement that went
   * against the position) must not wear the gain colour — the colour is the
   * first thing read, before the label.
   */
  const bar = (
    key: string,
    usd: number,
    className: string,
    title: string,
    axisLabel: string,
    negClassName = 'bg-rose-500/70',
  ) => {
    if (usd === 0) return;
    const from = level;
    level += usd;
    steps.push({
      key,
      kind: 'income',
      dir: usd >= 0 ? 'up' : 'down',
      from,
      to: level,
      className: usd >= 0 ? className : negClassName,
      title: `${title} ${fmtUsd(usd)}`,
      axisLabel,
    });
  };

  // 1 — the carry being harvested, Boros and perp sides together: the one
  // number every funding/settled row on the card adds up to.
  bar(
    'fixed-funding',
    b.borosSettleUsd + totals.perpFundingAllUsd,
    'bg-emerald-500/85',
    `Fixed funding — Boros settlements ${fmtUsd(b.borosSettleUsd)} (net of settle fees) + perp funding ${fmtUsd(totals.perpFundingAllUsd)}, open and completed legs`,
    'Fixed funding',
  );
  // Small signed adjustments and the costs. Fees are always a cost, so they
  // keep one colour whichever way the arithmetic signs them.
  bar('trade', tradeGross, 'bg-cyan-400/70', 'Boros trade PnL (gross of trade fees)', 'Boros trade');
  bar('trade-fee', -b.borosTradeFeeUsd, 'bg-amber-500/80', 'Boros trade fees', 'Trade fees', 'bg-amber-500/80');
  bar('perp-fees', -totals.perpFeesAllUsd, 'bg-amber-500', 'Perp trading fees, open + closed positions', 'Perp fees', 'bg-amber-500');
  bar(
    'slippage',
    totals.priceResidualUsd,
    'bg-cyan-400/50',
    'Perp price basis — open uPnL + closed realized price PnL (a delta-neutral book expects ≈ 0)',
    'Perp basis',
  );
  steps.push({
    key: 'pnl',
    kind: 'total',
    dir: totals.pnlUsd >= 0 ? 'up' : 'down',
    from: 0,
    to: totals.pnlUsd,
    className: totals.pnlUsd >= 0 ? 'bg-emerald-500' : 'bg-rose-500',
    title: `Net PnL ${fmtUsd(totals.pnlUsd)}`,
    axisLabel: 'PnL',
  });

  if (steps.length < 2) return null;
  applyValueLabels(steps);
  const { y, span, domainMin } = computeWaterfallScale([steps]);
  if (!(span > 0)) return null;

  return (
    <div className="mt-2 flex">
      <Plot
        steps={steps}
        y={y}
        span={span}
        domainMin={domainMin}
        caption="Fixed funding (Boros settlements + perp funding) = the locked spread; then Boros trade PnL, trade fees, perp fees and the perp price residual"
        showCaption={false}
      />
    </div>
  );
}
