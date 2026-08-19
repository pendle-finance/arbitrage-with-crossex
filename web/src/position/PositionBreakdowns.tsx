/** The share page's two breakdowns, in the terminal's own idioms.
 *
 *  PnL      — a waterfall (components/Waterfall, the primitives behind the
 *             position box's ProfitBars): the reconstructed spread return
 *             stepped down through every cost the displayed numbers charged
 *             (ce/cx-gated, mirroring the terminal's applyCostFlags gates) to
 *             the PnL target. The running level lands on the payload's own
 *             total BY CONSTRUCTION — the spread return is derived as
 *             target + charged costs, never carried in the wire format where
 *             the two could disagree.
 *  Capital  — a pie (the house Donut primitive from MarginDonut): perp margin
 *             on Gate CrossEx + Boros margin = the capital posted, the same
 *             split the server sums into capitalUsd. */
import { ExitModeToggle } from './ExitModeToggle';
import { Donut } from '../components/MarginDonut';
import {
  applyValueLabels,
  buildCostWaterfallSteps,
  computeWaterfallScale,
  dashedAmber as dashed,
  WaterfallPlot as Plot,
  type CostRow,
  type WaterfallStep as Step,
} from '../components/Waterfall';
import { fmtPct, fmtUsd } from '../lib/fmt';
import type { SharePayloadV1 } from '../lib/shareCodec';
import type { ExitMode } from './derive';

function buildPnlSteps(p: SharePayloadV1): Step[] {
  // Only the costs the sharer's displayed numbers actually charged, in the
  // card's decrement order. ce=0 leaves the entry rows out entirely (their
  // raw figures ride along for the label captions, but the headline never
  // subtracted them); same for cx and the exit rows.
  const costRows: CostRow[] = [
    ['paid-perp-fees', p.ce === 1 ? p.f.pp : null, 'bg-amber-500', 'Perp entry fees'],
    ['paid-entry-slippage', p.ce === 1 ? p.f.ps : null, 'bg-amber-500/75', 'Entry slip'],
    ['paid-boros-trade', p.f.pb, 'bg-amber-500/55', 'Boros trade fees'],
    ['paid-boros-settle', p.f.pl, 'bg-amber-500/40', 'Settlement fees paid'],
    ['future-boros-settle', p.f.fb, dashed, 'Settlement fees →mat'],
    [
      'future-exit-fees',
      p.cx === 1 && p.f.fp !== null && p.f.fp > 0 ? p.f.fp : null,
      dashed,
      'Perp exit',
    ],
    ['future-exit-slippage', p.cx === 1 ? p.f.fs : null, dashed, 'Exit slip'],
  ];
  // The wire format carries only the target, so the gross return is
  // reconstructed from it — the identity holds by construction, no drift warn.
  const charged = costRows.reduce((sum, [, usd]) => sum + (usd ?? 0), 0);
  return buildCostWaterfallSteps({
    spreadReturnUsd: p.p + charged,
    profitUsd: p.p,
    costRows,
    profitTitleSuffix: ' (as shared)',
  });
}

/** One row of the capital pie's legend — value at display precision, share of
 * the capital beside it. */
function CapitalLegendRow({
  swatch,
  label,
  usd,
  total,
}: {
  swatch: string;
  label: string;
  usd: number;
  total: number;
}) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-sm ${swatch}`} />
      <span className="text-ink-300">{label}</span>
      <span className="num ml-auto font-medium text-ink-100">{fmtUsd(usd, 0)}</span>
      <span className="num w-10 text-right text-xs text-ink-400">
        {total > 0 ? fmtPct(usd / total, 0) : '—'}
      </span>
    </div>
  );
}

export function PositionBreakdowns({
  p,
  exitMode,
  sharedMode,
  onExitModeChange,
}: {
  /** Already adjusted for the chosen exit mode (applyExitMode). */
  p: SharePayloadV1;
  exitMode: ExitMode;
  /** The sharer's own assumption — marked "(as shared)" on its option. */
  sharedMode: ExitMode;
  onExitModeChange: (next: ExitMode) => void;
}) {
  const pnlSteps = buildPnlSteps(p);
  const pnl = computeWaterfallScale([pnlSteps]);
  applyValueLabels(pnlSteps);
  const hasCapitalSplit = p.cp !== null && p.cb !== null;

  return (
    <>
      <section className="card p-3 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <h2 className="text-sm font-semibold text-ink-100">PnL, decomposed</h2>
          <ExitModeToggle
            exitMode={exitMode}
            sharedMode={sharedMode}
            onChange={onExitModeChange}
            hideLabelOnPhone
          />
        </div>
        <p className="mt-1 text-xs leading-relaxed text-ink-400">
          Solid = already happened. Dashed = future items.
        </p>
        {pnl.span > 0 && (
          <div
            data-waterfall
            role="img"
            aria-label={`Waterfall: spread return minus costs → PnL ${fmtUsd(p.p, 0)}`}
            className="mt-3"
          >
            <Plot
              steps={pnlSteps}
              y={pnl.y}
              span={pnl.span}
              domainMin={pnl.domainMin}
              caption="PnL by maturity"
            />
          </div>
        )}
      </section>

      <section className="card p-3 sm:p-5">
        <h2 className="text-sm font-semibold text-ink-100">Capital, decomposed</h2>
        {hasCapitalSplit ? (
          <div className="mt-4 flex flex-col items-center gap-5 sm:flex-row sm:gap-8">
            <Donut
              size={132}
              thickness={20}
              segments={[
                {
                  value: p.cp!,
                  className: 'stroke-cyan-400',
                  title: `Perp margin on Gate CrossEx ${fmtUsd(p.cp!, 0)}`,
                },
                {
                  value: p.cb!,
                  className: 'stroke-cyan-700',
                  title: `Boros margin ${fmtUsd(p.cb!, 0)}`,
                },
              ]}
              ariaLabel={`Capital split: perp margin ${fmtUsd(p.cp!, 0)} + Boros margin ${fmtUsd(p.cb!, 0)} = ${fmtUsd(p.c, 0)}`}
            >
              <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-400">
                Capital
              </div>
              <div className="num mt-0.5 text-base font-semibold text-ink-100">
                {fmtUsd(p.c, 0)}
              </div>
            </Donut>
            <div className="flex w-full flex-1 flex-col gap-2.5">
              <CapitalLegendRow
                swatch="bg-cyan-400"
                label="Perp margin (CrossEx)"
                usd={p.cp!}
                total={p.c}
              />
              <CapitalLegendRow swatch="bg-cyan-700" label="Boros margin" usd={p.cb!} total={p.c} />
            </div>
          </div>
        ) : (
          <div className="num mt-3 text-base font-semibold text-ink-100">{fmtUsd(p.c, 0)}</div>
        )}
      </section>
    </>
  );
}
