/** Waterfall primitives shared by the strategy card's returns charts
 * (panels/ProfitBars), the opportunity card's profit/capital charts
 * (panels/OpportunityWaterfall), and the shared-position page
 * (position/PositionBreakdowns).
 *
 * Hand-rolled divs (house precedent — no chart lib). A plot is a row of
 * columns; each column draws one bar between its `from` and `to` running
 * levels, a connector to the next column, and a value label. Totals rise from
 * 0 rather than step-chaining, so a builder's running level lands on its
 * authoritative total by construction.
 *
 * Colour conventions the builders follow: solid amber = costs already locked
 * in, low-alpha dashed amber = future costs (pattern, not colour alone),
 * emerald = favorable/profit, rose = a negative total, cyan = informational
 * (settled income, current net, modelled capital).
 */
import type { ReactNode } from 'react';

import { fmtUsd } from '../lib/fmt';

export interface WaterfallStep {
  key: string;
  kind: 'total' | 'cost-paid' | 'cost-future' | 'income' | 'capital';
  dir: 'up' | 'down';
  /** Running level before/after this step (totals rise from 0). */
  from: number;
  to: number;
  className: string;
  title: string;
  axisLabel: string;
  /** Value label text shown on the component. */
  valueText?: string;
}

export const dashedAmber = 'border border-dashed border-amber-500/60 bg-amber-500/20';
export const dashedEmerald = 'border border-dashed border-emerald-500/60 bg-emerald-500/20';
export const dashedCyan = 'border border-dashed border-cyan-400/60 bg-cyan-400/20';

/** A cost in a tooltip: "−$65.00", or "+$0.50 (favorable)" for a negative. */
export function costText(usd: number, approx = false): string {
  const prefix = approx ? '≈' : '';
  return usd >= 0
    ? `${prefix}−${fmtUsd(usd)}`
    : `${prefix}+${fmtUsd(Math.abs(usd))} (favorable)`;
}

/** The tooltip names of the cost rows in a spread-return → PnL waterfall.
 * Internal to buildCostWaterfallSteps — shared through it, so the terminal
 * card and the public share page can't drift apart. */
const COST_TITLES: Record<string, string> = {
  'paid-perp-fees': 'Perp trading fees paid',
  'paid-entry-slippage': 'Perp entry slippage paid',
  'paid-boros-trade': 'Boros trading fees paid',
  'paid-boros-settle': 'Boros settlement fees paid (est.)',
  'future-boros-settle': 'Boros settlement fees to maturity (est.)',
  'future-exit-fees': 'Perp exit fees (maker+hedge, est.)',
  'future-exit-slippage': 'Perp exit slippage (assumed = entry, est.)',
};

/** One decrement of a cost waterfall: `usd` is SIGNED (a favorable cost steps
 * UP) and null/0 drops the row entirely; `className` styles the positive case. */
export type CostRow = [key: string, usd: number | null, className: string, axisLabel: string];

/**
 * Spread return → costs → PnL, the shape both the strategy card's left chart
 * (panels/ProfitBars) and the shared-position page (position/PositionBreakdowns)
 * draw. Callers own only WHICH rows are charged — the gates differ (the card
 * reads its cost toggles, the page reads the flags frozen into the payload) —
 * while the bar semantics live here: paid vs future by key prefix, a favorable
 * (negative) cost stepping up in emerald, and both totals rising from 0 so the
 * end bar sits on the authoritative number rather than on a running sum.
 */
export function buildCostWaterfallSteps({
  spreadReturnUsd,
  profitUsd,
  costRows,
  profitTitleSuffix = '',
  devWarnLabel,
}: {
  spreadReturnUsd: number;
  profitUsd: number;
  costRows: CostRow[];
  /** Appended to the end bar's tooltip (the share page marks it "(as shared)"). */
  profitTitleSuffix?: string;
  /** Enables the DEV identity-drift warning. Omit where the identity holds by
   * construction (the share page derives its spread return FROM the target). */
  devWarnLabel?: string;
}): WaterfallStep[] {
  const steps: WaterfallStep[] = [
    {
      key: 'spread',
      kind: 'total',
      dir: 'up',
      from: 0,
      to: spreadReturnUsd,
      className: 'bg-emerald-500',
      title: `Spread return (locked) ${fmtUsd(spreadReturnUsd)}`,
      axisLabel: 'Spread locked',
    },
  ];
  let level = spreadReturnUsd;
  for (const [key, usd, cls, axisLabel] of costRows) {
    if (usd === null || usd === 0) continue;
    const from = level;
    level -= usd; // signed: a favorable (negative) cost raises the level
    const isFuture = key.startsWith('future');
    steps.push({
      key,
      kind: isFuture ? 'cost-future' : 'cost-paid',
      dir: usd > 0 ? 'down' : 'up',
      from,
      to: level,
      className: usd > 0 ? cls : isFuture ? dashedEmerald : 'bg-emerald-500/80',
      title: `${COST_TITLES[key]} ${costText(usd, isFuture || key === 'paid-boros-settle')}`,
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
    title: `Net PnL by maturity ${fmtUsd(profitUsd)}${profitTitleSuffix}`,
    axisLabel: 'PnL',
  });
  // The end total is drawn at the authoritative profit; the running level must
  // land there by construction — warn (dev only) on any drift.
  if (devWarnLabel && import.meta.env.DEV && Math.abs(level - profitUsd) > 0.01) {
    // eslint-disable-next-line no-console
    console.warn(`waterfall identity drift (${devWarnLabel})`, { level, profitUsd });
  }
  return steps;
}

/**
 * The y scale over one or more step groups. Plots that belong on ONE axis pass
 * their groups together (the strategy card's two charts); plots on independent
 * axes each call this with their own group (the opportunity card's profit and
 * capital charts, whose magnitudes differ by 10-100x). `extraLevels` pins
 * anything drawn outside the steps, e.g. the "now" reference line.
 */
export function computeWaterfallScale(
  stepGroups: WaterfallStep[][],
  extraLevels: number[] = [],
): { y: (v: number) => number; span: number; domainMin: number } {
  const levels = stepGroups.flat().flatMap((s) => [s.from, s.to]);
  const domainMax = Math.max(0, ...extraLevels, ...levels);
  const domainMin = Math.min(0, ...extraLevels, ...levels);
  const span = domainMax - domainMin;
  return { y: (v: number) => ((domainMax - v) / span) * 100, span, domainMin };
}

/**
 * Value labels on EVERY component (tooltips carry the full-precision text).
 * Totals print their absolute level; components print their signed delta, with
 * precision following magnitude. Mutates in place.
 */
export function applyValueLabels(steps: WaterfallStep[]): void {
  for (const s of steps) {
    const delta = s.to - s.from;
    // Cents below $10; `fmtUsd` independently refuses to round any non-zero
    // amount away to "$0", so a small total keeps its value at either setting.
    const dp = (v: number) => (Math.abs(v) < 10 ? 2 : 0);
    s.valueText =
      s.kind === 'total'
        ? fmtUsd(s.to, dp(s.to))
        : `${delta >= 0 ? '+' : '−'}${fmtUsd(Math.abs(delta), dp(delta))}`;
  }
}

/** One waterfall plot + its axis labels + caption, on the given y scale. */
export function WaterfallPlot({
  steps,
  y,
  span,
  domainMin,
  caption,
  legend,
  mtmUsd = 0,
  mtmChip = false,
}: {
  steps: WaterfallStep[];
  y: (v: number) => number;
  span: number;
  domainMin: number;
  caption: string;
  /** Optional swatch key beside the caption, for plots whose colour convention
   * needs spelling out (the opportunity card's solid-vs-dashed amber costs). */
  legend?: ReactNode;
  /** Only meaningful with `mtmChip`; the reference line's level. */
  mtmUsd?: number;
  /** Only the strategy card's now plot draws the labeled "now" reference line. */
  mtmChip?: boolean;
}) {
  const mtmTop = y(mtmUsd);
  return (
    <div className="min-w-0" style={{ flexGrow: steps.length, flexBasis: 0 }}>
      <div className="relative h-36 border-b border-ink-700">
        {domainMin < 0 && (
          <div
            aria-hidden
            data-axis="zero"
            className="absolute inset-x-0 h-px bg-ink-600"
            style={{ top: `${y(0)}%` }}
          />
        )}

        {steps.map((s, i) => (
          <div
            key={s.key}
            className="absolute inset-y-0"
            title={s.title}
            style={{ left: `${(i / steps.length) * 100}%`, width: `${100 / steps.length}%` }}
          >
            {/* connector from this bar's landing level to the next bar's edge */}
            {i < steps.length - 1 && (
              <div
                aria-hidden
                className="absolute h-px bg-ink-500"
                style={{ top: `${y(s.to)}%`, left: '85%', right: '-15%' }}
              />
            )}
            <div
              data-segment={s.key}
              data-kind={s.kind}
              data-dir={s.dir}
              data-level={s.to.toFixed(2)}
              {...(s.kind === 'total' && s.key !== 'spread'
                ? { 'data-tone': s.to >= 0 ? 'pos' : 'neg' }
                : {})}
              className={`absolute inset-x-[15%] ${s.className}`}
              style={{
                top: `${y(Math.max(s.from, s.to))}%`,
                height: `max(${(Math.abs(s.to - s.from) / span) * 100}%, 3px)`,
              }}
            />
            {s.valueText && (
              <div
                className={`num pointer-events-none absolute inset-x-0 text-center text-[9px] leading-none ${
                  s.kind === 'total' ? 'font-medium text-ink-200' : 'text-ink-300'
                }`}
                style={
                  s.kind === 'total' && s.from === 0 && s.to < 0
                    ? // Clamped inside the plot: at/near the domain minimum the
                      // below-the-bar slot would spill onto the axis captions.
                      { top: `min(calc(${y(s.to)}% + 5px), calc(100% - 10px))` }
                    : { top: `calc(${y(Math.max(s.from, s.to))}% - 11px)` }
                }
              >
                {s.valueText}
              </div>
            )}
          </div>
        ))}

        {/* "now" reference line — the now plot only. */}
        {mtmChip && (
          <div
            data-segment="mtm"
            data-sign={mtmUsd < 0 ? 'neg' : 'pos'}
            title={`Current PnL ${fmtUsd(mtmUsd)} — funding + Boros settlements & rate MtM − fees − entry slippage`}
            className="absolute inset-x-0 border-t border-dashed border-cyan-400/70"
            style={{ top: `${mtmTop}%` }}
          >
            <span
              className={`num absolute right-0 rounded-sm bg-ink-900/80 px-1 text-[9px] leading-none text-cyan-300 ${
                mtmTop < 10 ? 'top-0.5' : '-top-3'
              }`}
            >
              {/* Cents below $10, same rule as the bar labels — a live PnL
                  of $0.07 must not read as "now $0". */}
              now {fmtUsd(mtmUsd, Math.abs(mtmUsd) < 10 ? 2 : 0)}
            </span>
          </div>
        )}
      </div>

      {/* x-axis category labels — mirrored columns; full text, sentence case,
          wrapping to a second line when needed */}
      <div className="flex items-start">
        {steps.map((s) => (
          <div
            key={s.key}
            title={s.title}
            className="min-w-0 flex-1 break-words px-0.5 pt-0.5 text-center text-[9px] leading-tight text-ink-400"
          >
            {s.axisLabel}
          </div>
        ))}
      </div>
      <div className="flex items-center justify-center gap-3 pt-0.5">
        <span className="text-[9px] uppercase tracking-wider text-ink-400">{caption}</span>
        {legend}
      </div>
    </div>
  );
}
