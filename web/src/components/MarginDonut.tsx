import type { ReactNode } from 'react';
import type { CrossexAccount } from '../api/types';
import { fmtPct, fmtUsd } from '../lib/fmt';

// ---------------------------------------------------------------------------
// Margin math
// ---------------------------------------------------------------------------

interface MarginParts {
  balance: number;
  /** Locked by open positions. */
  initial: number;
  /** Free = balance − initial (derived so the pie always closes). */
  available: number;
  /** The liquidation floor. */
  maintenance: number;
  /** Initial margin as a fraction of balance (0..1). */
  imPct: number;
  /** Maintenance margin as a fraction of balance (0..1). */
  mmPct: number;
  hasFunds: boolean;
}

/**
 * Utilization computed as margin ÷ balance — NOT Gate's `*MarginRate` fields,
 * which are coverage ratios (balance ÷ requirement) and read as "reversed"
 * (maintenance's ratio is larger than initial's because its requirement is
 * smaller). "How much of my balance is locked" is the intuitive number.
 */
export function marginParts(acc: CrossexAccount): MarginParts {
  const balance = Number(acc.marginBalance) || 0;
  const initial = Math.max(0, Number(acc.initialMargin) || 0);
  const maintenance = Math.max(0, Number(acc.maintenanceMargin) || 0);
  const hasFunds = balance > 0;
  // Derive free from balance so used + free always equals the whole ring; fall
  // back to the reported available only when balance is unavailable.
  const available = Math.max(0, hasFunds ? balance - initial : Number(acc.availableMargin) || 0);
  return {
    balance,
    initial,
    available,
    maintenance,
    imPct: hasFunds ? initial / balance : 0,
    mmPct: hasFunds ? maintenance / balance : 0,
    hasFunds,
  };
}

/** Utilization risk color: green < 50%, amber < 75%, red ≥ 75%. */
function utilStroke(pct: number): string {
  return pct < 0.5 ? 'stroke-emerald-500' : pct < 0.75 ? 'stroke-amber-500' : 'stroke-rose-500';
}
function utilText(pct: number): string {
  return pct < 0.5 ? 'text-emerald-400' : pct < 0.75 ? 'text-amber-400' : 'text-rose-400';
}
/** Same risk bands as `utilStroke`, as a bar fill for the header meters. */
function utilBar(pct: number): string {
  return pct < 0.5 ? 'bg-grass' : pct < 0.75 ? 'bg-gold' : 'bg-guava';
}

// ---------------------------------------------------------------------------
// Donut primitive (self-contained SVG — no chart library)
// ---------------------------------------------------------------------------

export interface DonutSegment {
  value: number;
  /** Full Tailwind `stroke-*` class (must be a literal so JIT keeps it). */
  className: string;
  title?: string;
}

/**
 * Segments render clockwise from 12 o'clock. Pass `total` to size segments
 * against a whole larger than their sum (the remainder shows as the track) —
 * used for the "one highlighted slice vs balance" mini pie. Shared: the
 * account margin card here and the position page's capital pie.
 */
export function Donut({
  size,
  thickness,
  segments,
  total,
  trackClass = 'stroke-ink-700',
  children,
  ariaLabel,
}: {
  size: number;
  thickness: number;
  segments: DonutSegment[];
  total?: number;
  trackClass?: string;
  children?: ReactNode;
  ariaLabel?: string;
}) {
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const sum = segments.reduce((s, x) => s + Math.max(0, x.value), 0);
  const denom = total ?? sum;
  let offset = 0;
  return (
    <div
      className="relative inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: size }}
      role="img"
      aria-label={ariaLabel}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={thickness} className={trackClass} />
        {denom > 0 &&
          segments.map((seg, i) => {
            // Clamp to the ring: a segment larger than `denom` (e.g. maintenance
            // margin > balance on a near-liquidation account) would otherwise
            // overshoot the circumference and make `c - dash` a negative gap.
            const frac = Math.min(1, Math.max(0, seg.value) / denom);
            const dash = frac * c;
            const el = (
              <circle
                key={i}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                strokeWidth={thickness}
                className={seg.className}
                strokeDasharray={`${dash} ${c - dash}`}
                strokeDashoffset={-offset}
              >
                {seg.title ? <title>{seg.title}</title> : null}
              </circle>
            );
            offset += dash;
            return el;
          })}
      </svg>
      {children ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center leading-none">
          {children}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Margin breakdown (full card + compact header variant)
// ---------------------------------------------------------------------------

function Swatch({ className }: { className: string }) {
  return <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-sm ${className}`} />;
}

function LegendRow({
  swatch,
  label,
  usd,
  pct,
  pctClass,
}: {
  swatch: string;
  label: string;
  usd: number;
  pct: number;
  pctClass?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <Swatch className={swatch} />
      <span className="text-ink-300">{label}</span>
      <span className="num ml-auto font-medium text-ink-100">{fmtUsd(usd)}</span>
      <span className={`num w-12 text-right text-xs ${pctClass ?? 'text-ink-400'}`}>{fmtPct(pct, 0)}</span>
    </div>
  );
}

/**
 * `full` — a card for the Balances panel: main pie (initial vs available out of
 * margin balance) + a mini pie for maintenance margin vs balance.
 * `compact` — two small pies for the header strip.
 */
export function MarginBreakdown({ acc, variant = 'full' }: { acc: CrossexAccount; variant?: 'full' | 'compact' }) {
  const p = marginParts(acc);
  // Initial margin is always green (it's expected to be the bulk of the balance);
  // maintenance margin is the risk signal — color it by how close it is to the
  // balance (green < 50%, amber < 75%, red ≥ 75% — approaching the liquidation floor).
  const mmStroke = p.hasFunds ? utilStroke(p.mmPct) : 'stroke-ink-500';
  const mmText = p.hasFunds ? utilText(p.mmPct) : 'text-ink-300';
  const usedSeg: DonutSegment = {
    value: p.initial,
    className: 'stroke-emerald-500',
    title: `Initial margin ${fmtUsd(p.initial)} (${fmtPct(p.imPct, 1)} of balance)`,
  };
  const freeSeg: DonutSegment = {
    value: p.available,
    className: 'stroke-ink-500',
    title: `Available ${fmtUsd(p.available)}`,
  };
  const mmSeg: DonutSegment = {
    value: p.maintenance,
    className: mmStroke,
    title: `Maintenance margin ${fmtUsd(p.maintenance)} (${fmtPct(p.mmPct, 1)} of balance)`,
  };

  if (variant === 'compact') {
    // Flat 44x4 meters, not pies: in a 52px bar a donut is read as decoration,
    // while a bar's fill length is legible at a glance and lines the two
    // ratios up against each other. The full card below keeps the donuts.
    const meter = (label: string, pct: number, barClass: string, textClass: string) => (
      <span className="flex items-center gap-1.5">
        <span className="text-[11px] text-ink-400">{label}</span>
        <span className="block h-1 w-11 overflow-hidden rounded-full bg-ink-850">
          <span
            className={`block h-full ${barClass}`}
            style={{ width: `${Math.max(0, Math.min(100, pct * 100))}%` }}
          />
        </span>
        <span className={`num text-[11px] ${textClass}`}>
          {p.hasFunds ? fmtPct(pct, 0) : '—'}
        </span>
      </span>
    );
    return (
      <div
        className="flex items-center gap-2.5"
        title={`Initial margin ${fmtUsd(p.initial)} · Available ${fmtUsd(p.available)} · Maintenance ${fmtUsd(
          p.maintenance,
        )} — shown as a share of the ${fmtUsd(p.balance)} margin balance`}
      >
        {meter('IM', p.imPct, p.hasFunds ? 'bg-grass' : 'bg-ink-600', 'text-ink-100')}
        {meter(
          'MM',
          p.mmPct,
          p.hasFunds ? utilBar(p.mmPct) : 'bg-ink-600',
          p.hasFunds ? 'text-ink-100' : 'text-ink-300',
        )}
      </div>
    );
  }

  return (
    <div className="card flex flex-col items-center gap-6 p-5 sm:flex-row sm:gap-8">
      <Donut size={132} thickness={20} segments={[usedSeg, freeSeg]} ariaLabel="Margin usage">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-400">Balance</div>
        {/* Whole dollars at 13px: the ring's inner diameter is 92px and the
            cents version at 16px ran ~100px wide, straight through the ring.
            The exact figure stays one hover away. */}
        <div className="num mt-0.5 text-[13px] font-semibold text-ink-100" title={fmtUsd(p.balance)}>
          {fmtUsd(p.balance, 0)}
        </div>
      </Donut>

      <div className="flex w-full flex-1 flex-col gap-2.5 text-sm">
        <LegendRow
          swatch="bg-emerald-500"
          label="Initial margin (used)"
          usd={p.initial}
          pct={p.imPct}
          pctClass="text-emerald-400"
        />
        <LegendRow swatch="bg-ink-500" label="Available" usd={p.available} pct={p.hasFunds ? p.available / p.balance : 0} />
        <div className="mt-1 border-t border-ink-700 pt-1 text-[11px] text-ink-500">
          Utilization = margin ÷ balance
        </div>
      </div>

      <div className="flex items-center gap-3 sm:flex-col sm:border-l sm:border-ink-700 sm:pl-6">
        <Donut
          size={68}
          thickness={11}
          total={p.balance}
          segments={[mmSeg]}
          ariaLabel="Maintenance margin vs balance"
        >
          <div className={`num text-xs font-semibold ${mmText}`}>{p.hasFunds ? fmtPct(p.mmPct, 0) : '—'}</div>
        </Donut>
        <div className="text-center leading-tight">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-400">Maintenance</div>
          <div className="num text-sm text-ink-200">{fmtUsd(p.maintenance)}</div>
          <div className="text-[10px] text-ink-500">of balance</div>
        </div>
      </div>
    </div>
  );
}
