/**
 * The asset's PnL as ONE waterfall, in the order the trader reads the trade:
 *
 *   Boros settlements → perp funding  (their sum = the spread being locked)
 *   → Boros trade PnL (small, signed) → the four costs → net PnL.
 *
 * "Perp slippage" is the price package — open uPnL + closed realized price
 * PnL — which a delta-neutral book expects near zero; drawing it as one bar
 * makes a leak visible immediately. Boros MtM is deliberately absent (info
 * only, converges to zero at maturity).
 *
 * Same primitives and colour conventions as every other waterfall in the app.
 * Gross/net note: the model's settle & trade PnL are NET of their fees, so
 * the income bars add the fees back and the fee bars subtract them — the end
 * bar lands on totals.pnlUsd exactly, by construction.
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
  const settleGross = b.borosSettleUsd + b.borosSettleFeeUsd;
  const tradeGross = b.borosTradePnlUsd + b.borosTradeFeeUsd;

  const steps: Step[] = [];
  let level = 0;
  const bar = (
    key: string,
    usd: number,
    className: string,
    title: string,
    axisLabel: string,
    dashed = false,
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
      className: dashed ? `border border-dashed ${className}` : className,
      title: `${title} ${fmtUsd(usd)}`,
      axisLabel,
    });
  };

  // 1+2 — the carry being harvested (their running level = spread locked).
  bar('settle', settleGross, 'bg-emerald-500/85', 'Boros settlement PnL (gross of settle fees)', 'Boros settle');
  bar('funding', totals.perpFundingAllUsd, 'bg-emerald-500/60', 'Perp funding, open + closed positions', 'Perp funding');
  // Small signed adjustments and the costs.
  bar('trade', tradeGross, 'bg-cyan-400/70', 'Boros trade PnL (gross of trade fees)', 'Boros trade');
  bar('trade-fee', -b.borosTradeFeeUsd, 'bg-amber-500/80', 'Boros trade fees', 'Trade fees');
  bar('settle-fee', -b.borosSettleFeeUsd, 'bg-amber-600/80', 'Boros settlement fees', 'Settle fees');
  bar('perp-fees', -totals.perpFeesAllUsd, 'bg-amber-500', 'Perp trading fees, open + closed positions', 'Perp fees');
  bar(
    'slippage',
    totals.priceResidualUsd,
    totals.priceResidualUsd >= 0 ? 'bg-cyan-400/50' : 'bg-rose-500/70',
    'Perp slippage — open uPnL + closed realized price PnL (a delta-neutral book expects ≈ 0)',
    'Perp slippage',
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
        caption="Boros settle + perp funding = the locked spread; then fees and the perp price residual"
      />
    </div>
  );
}
