/** The public `/ltp` pitch page — the "Boros LTP Pitch v2" Claude Design
 * canvas, ported from published-ltp@f824a9b, implemented against the live
 * engine: a hub that fans into three cascade-open panels (live opportunities /
 * three parts / avoid liquidation), and a fixed assumptions widget whose knobs
 * re-price everything through GET /api/opportunities-ltp. Same guarantee as
 * the page it replaces: no credential surface and no execute path, reached
 * only through main-ltp.tsx, an optional standalone entry (build:ltp).
 *
 * Where the canvas showed static sample values (card rates, waterfall bars,
 * VIP0–3 tiers), the live data wins: cards are the server's ranking, the
 * waterfall is the real cost/capital ledger (LtpOpportunityWaterfall), and
 * the tiers are the real ladder. The liquidation chart's highlighted level
 * follows the leverage knob. */
import type { CSSProperties, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LTP_TIERS, useLtpOpportunities } from './api/ltp';
import type {
  LtpOpportunitiesResult,
  LtpOpportunityGroup,
  LtpOpportunityPair,
  LtpTier,
} from './api/ltpTypes';
import type { EntryMode } from './api/types';
import { fmtNotionalShort, fmtPct, fmtUsd, fmtUsdCompact, prettyVenue } from './lib/fmt';
import { readJson, writeJson } from './lib/storage';
import { useDebounced } from './lib/useDebounced';
import {
  canChartLtpCapital,
  canChartLtpProfit,
  LtpOpportunityWaterfall,
} from './panels/LtpOpportunityWaterfall';
import './ltp-pitch.css';

const EMAIL = 'institutional@pendle.finance';
const MAILTO = `mailto:${EMAIL}`;
const MONO = "'JetBrains Mono', monospace";

const PANELS = ['live', 'system', 'risk'] as const;
type PanelId = (typeof PANELS)[number];

// ---------------------------------------------------------------------------
// Assumptions — every knob is a server param (useLtpOpportunities).
// ---------------------------------------------------------------------------

interface PitchAssumptions {
  notionalUsd: number;
  lev: number;
  borrow: number;
  ratePct: number;
  tier: LtpTier;
  entry: EntryMode;
}

const NOTIONAL_CHOICES = [10_000, 100_000, 200_000, 500_000] as const;
const BORROW_CHOICES = [1, 1.5, 1.8, 2] as const;
const TIER_CHOICES = LTP_TIERS;
const ENTRY_CHOICES: readonly { value: EntryMode; label: string }[] = [
  { value: 'both-market', label: 'both legs market' },
  { value: 'maker-hedge', label: 'limit + hedge' },
];

const DEFAULT_ASSUMPTIONS: PitchAssumptions = {
  notionalUsd: 200_000,
  lev: 15,
  borrow: 2,
  ratePct: 10.5,
  tier: 'vip2',
  entry: 'maker-hedge',
};

// Versioned so a defaults change hands every visitor the new defaults instead
// of resurrecting older stored choices. v6: back to a 15× default — the
// engine now clamps each Hyperliquid leg to HL's published per-asset cap
// (e.g. HYPE 10×), so the knob no longer models unopenable HL legs.
export const LTP_PITCH_STORAGE_KEY = 'crossex.ltpPitch.v6';

/** The last successful scan, persisted for an instant (dimmed) first paint. */
const LTP_PITCH_DATA_KEY = 'crossex.ltpPitch.data.v1';
const SEED_MAX_AGE_MS = 15 * 60_000;

interface StoredScan {
  ts: number;
  result: LtpOpportunitiesResult;
}

function validateStoredScan(parsed: unknown): StoredScan | null {
  const scan = parsed as StoredScan | null;
  if (
    !scan ||
    typeof scan.ts !== 'number' ||
    !scan.result ||
    !Array.isArray(scan.result.groups) ||
    typeof scan.result.meta !== 'object'
  ) {
    throw new Error('malformed stored scan');
  }
  return scan;
}

function validateAssumptions(parsed: unknown): PitchAssumptions {
  const p = parsed as Partial<PitchAssumptions> | null;
  const d = DEFAULT_ASSUMPTIONS;
  if (typeof p !== 'object' || p === null) return d;
  return {
    notionalUsd: NOTIONAL_CHOICES.includes(p.notionalUsd as never)
      ? (p.notionalUsd as number)
      : d.notionalUsd,
    lev:
      typeof p.lev === 'number' && Number.isFinite(p.lev)
        ? Math.min(50, Math.max(1, Math.round(p.lev)))
        : d.lev,
    borrow: BORROW_CHOICES.includes(p.borrow as never) ? (p.borrow as number) : d.borrow,
    ratePct:
      typeof p.ratePct === 'number' && Number.isFinite(p.ratePct)
        ? Math.min(15, Math.max(5, p.ratePct))
        : d.ratePct,
    tier: TIER_CHOICES.includes(p.tier as never) ? (p.tier as LtpTier) : d.tier,
    entry: ENTRY_CHOICES.some((c) => c.value === p.entry) ? (p.entry as EntryMode) : d.entry,
  };
}

function tierLabel(tier: LtpTier): string {
  return tier.toUpperCase();
}

// ---------------------------------------------------------------------------
// Small shared bits
// ---------------------------------------------------------------------------

function groupKeyOf(g: LtpOpportunityGroup): string {
  return `${g.tokenId}:${g.maturity}:${g.underlying}`;
}

function pairOf(g: LtpOpportunityGroup): LtpOpportunityPair | null {
  return g.bestPair ?? g.pairs[0] ?? null;
}

/** "28 Aug · 9d" — UTC short date + days to maturity. */
function maturityShort(unixSec: number, secondsToMaturity: number): string {
  const label = new Date(unixSec * 1000).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
  const days = Math.max(1, Math.round(secondsToMaturity / 86_400));
  return `${label} · ${days}d`;
}

function daysToMaturity(secondsToMaturity: number): number {
  return Math.max(1, Math.round(secondsToMaturity / 86_400));
}

const microLabel: CSSProperties = {
  fontFamily: MONO,
  fontSize: 10,
  letterSpacing: '.12em',
  textTransform: 'uppercase',
  color: '#5a6273',
};

/** A canvas-style segmented chip. */
function Opt({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className="lp-btn"
      onClick={onClick}
      style={{
        padding: '6px 10px',
        borderRadius: 7,
        fontFamily: MONO,
        fontSize: 10.5,
        transition: 'background .2s, border-color .2s, color .2s',
        background: active ? 'rgba(34,211,238,.1)' : '#10131a',
        border: `1px solid ${active ? 'rgba(34,211,238,.4)' : '#1c2029'}`,
        color: active ? '#67e8f9' : '#8a92a3',
      }}
    >
      {label}
    </button>
  );
}

/** RapidX vs DMA rail badge for a perp leg. */
function AccessBadge({ access }: { access: 'rapidx' | 'dma' | null }) {
  if (!access) return null;
  const rapid = access === 'rapidx';
  return (
    <span
      style={{
        marginLeft: 'auto',
        fontFamily: MONO,
        fontSize: 9,
        letterSpacing: '.1em',
        padding: '2px 7px',
        borderRadius: 999,
        whiteSpace: 'nowrap',
        color: rapid ? '#67e8f9' : '#8a92a3',
        border: `1px solid ${rapid ? 'rgba(34,211,238,.3)' : '#2a3140'}`,
        background: rapid ? 'rgba(34,211,238,.06)' : 'transparent',
      }}
    >
      {rapid ? 'RapidX' : 'DMA'}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Liquidation runway chart — the price path and the leverage tick marks are
// the canvas's static art; the highlighted liquidation level, the top-up
// event and the restored runway all follow the leverage knob.
// ---------------------------------------------------------------------------

/** The canvas's mark-price polyline (x, y) — y grows downward, 8px per 1%. */
const RUNWAY_POLY: readonly (readonly [number, number])[] = [
  [40, 48],
  [70, 44],
  [95, 56],
  [120, 50],
  [150, 62],
  [175, 58],
  [205, 74],
  [230, 68],
  [255, 86],
  [280, 96],
  [300, 104],
  [325, 100],
  [350, 110],
  [365, 112],
  [400, 122],
  [430, 118],
  [460, 128],
  [490, 124],
  [520, 134],
  [560, 142],
];

function polyYAt(x: number): number {
  const pts = RUNWAY_POLY;
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i - 1];
    const [x2, y2] = pts[i];
    if (x <= x2) return y1 + ((y2 - y1) * (x - x1)) / (x2 - x1);
  }
  return pts[pts.length - 1][1];
}

/** First x where the price path comes within `margin` of the liq level. */
function firstApproachX(liqY: number, margin: number): number | null {
  const step = 5;
  for (let x = RUNWAY_POLY[0][0]; x <= 560; x += step) {
    if (polyYAt(x) >= liqY - margin) return Math.min(520, Math.max(80, x));
  }
  return null;
}

/** ~1% keeps the dynamic line EXACTLY on the chart's static tick marks
 * (−4%·20×, −9%·10×, −19%·5×) — the runway is approximate either way (the
 * amber footnote says so). */
const MAINTENANCE_MARGIN_PCT = 1;
const RUNWAY_POLY_MAX_Y = Math.max(...RUNWAY_POLY.map(([, y]) => y));

function RunwayChart({ lev }: { lev: number }) {
  const runwayPct = Math.max(0.5, 100 / lev - MAINTENANCE_MARGIN_PCT);
  const liqY = Math.min(200, Math.max(46, 40 + runwayPct * 8));
  const eventX = firstApproachX(liqY, 8);
  // Deep enough that the price path never dips below the restored line —
  // otherwise the chart would show a liquidation the story says was avoided.
  const restoredY = Math.min(232, Math.max(liqY + 64, RUNWAY_POLY_MAX_Y + 12));
  // A late event leaves no room for labels on the right — flip them left.
  const labelsLeft = eventX !== null && eventX > 380;
  const points = RUNWAY_POLY.map(([x, y]) => `${x},${y}`).join(' ');

  return (
    <svg
      viewBox="0 0 620 250"
      style={{ display: 'block', width: '100%', minWidth: 520, fontFamily: MONO }}
      role="img"
      aria-label={
        eventX === null
          ? `Runway to liquidation at ${lev}x leverage: about ${runwayPct.toFixed(1)}% adverse move — ample at this leverage, no top-up needed in this window.`
          : `Runway to liquidation at ${lev}x leverage: about ${runwayPct.toFixed(1)}% adverse move; the rebalancer tops up in roughly 60 to 100 seconds, restoring the runway.`
      }
    >
      <line x1="40" y1="120" x2="560" y2="120" stroke="#151922" />
      <line x1="40" y1="200" x2="560" y2="200" stroke="#151922" />
      <line x1="40" y1="40" x2="560" y2="40" stroke="#3a4150" />
      <text x="44" y="30" fill="#5a6273" fontSize="10">
        entry price
      </text>
      {/* Decorative caption — dropped when the liq line climbs into its spot. */}
      {liqY >= 96 && (
        <text x="100" y="74" fill="#8a92a3" fontSize="10">
          mark price
        </text>
      )}
      {(
        [
          [48, '−1% · 50×'],
          [72, '−4% · 20×'],
          [112, '−9% · 10×'],
          [192, '−19% · 5×'],
        ] as const
      ).map(([y, label]) => (
        <g key={label}>
          <line x1="560" y1={y} x2="566" y2={y} stroke="rgba(251,113,133,.4)" />
          <text x="570" y={y + 3} fill="rgba(251,113,133,.55)" fontSize="9.5">
            {label}
          </text>
        </g>
      ))}

      {eventX === null ? (
        <>
          <line
            x1="40"
            y1={liqY}
            x2="560"
            y2={liqY}
            stroke="#fb7185"
            strokeWidth="1.2"
            strokeDasharray="5 4"
          />
          <text x="44" y={liqY - 8} fill="#fb7185" fontSize="10">
            liquidation level @ {lev}×
          </text>
          <text x="308" y={liqY - 8} fill="#67e8f9" fontSize="10">
            runway ample at {lev}× — no top-up needed in this window
          </text>
        </>
      ) : (
        <>
          <line
            x1="40"
            y1={liqY}
            x2={eventX}
            y2={liqY}
            stroke="#fb7185"
            strokeWidth="1.2"
            strokeDasharray="5 4"
          />
          <line
            x1={eventX}
            y1={liqY}
            x2="560"
            y2={liqY}
            stroke="rgba(251,113,133,.22)"
            strokeDasharray="5 4"
          />
          {/* When the line sits high the price path owns the left region — the
           * label moves to the right end, where the path is far below it. */}
          {liqY < 96 ? (
            <text x="552" y={Math.max(14, liqY - 8)} fill="#fb7185" fontSize="10" textAnchor="end">
              liquidation level @ {lev}×
            </text>
          ) : (
            <text x="44" y={liqY - 8} fill="#fb7185" fontSize="10">
              liquidation level @ {lev}×
            </text>
          )}
          <line
            x1={eventX}
            y1={liqY}
            x2={eventX}
            y2={restoredY - 7}
            stroke="#22d3ee"
            strokeWidth="1.5"
          />
          <polygon
            points={`${eventX - 5},${restoredY - 9} ${eventX + 5},${restoredY - 9} ${eventX},${restoredY - 1}`}
            fill="#22d3ee"
          />
          <line
            x1={eventX}
            y1={restoredY}
            x2="560"
            y2={restoredY}
            stroke="#fb7185"
            strokeWidth="1.2"
            strokeDasharray="5 4"
          />
          <circle cx={eventX} cy={polyYAt(eventX)} r="3.5" fill="#22d3ee" />
          <text
            x={labelsLeft ? eventX - 8 : eventX + 8}
            y={(liqY + restoredY) / 2 + 4}
            fill="#67e8f9"
            fontSize="10"
            textAnchor={labelsLeft ? 'end' : 'start'}
          >
            rebalancer top-up (~60–100s)
          </text>
          {/* Cramped when the event sits far left, or when the liq label is
           * right-anchored on the same line — hide rather than overprint. */}
          {eventX >= 200 && !labelsLeft && liqY >= 96 && (
            <text x={Math.min(400, eventX + 72)} y={liqY - 6} fill="rgba(251,113,133,.6)" fontSize="9.5">
              would have liquidated
            </text>
          )}
          <text
            x={labelsLeft ? eventX - 8 : eventX + 8}
            y={Math.min(246, restoredY + 20)}
            fill="#fb7185"
            fontSize="10"
            textAnchor={labelsLeft ? 'end' : 'start'}
          >
            liq after top-up — runway restored
          </text>
        </>
      )}

      <polyline
        points={points}
        fill="none"
        stroke="#e9ebf0"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Live opportunity card
// ---------------------------------------------------------------------------

function OppCard({
  group,
  selected,
  onSelect,
}: {
  group: LtpOpportunityGroup;
  selected: boolean;
  onSelect: () => void;
}) {
  const pair = pairOf(group);
  if (!pair) return null;
  const apr = pair.netFixedAprOnCapital;
  // Per-leg: the engine clamps a Hyperliquid leg to HL's published cap.
  const levChip =
    pair.capital.shortLegLeverage === pair.capital.longLegLeverage
      ? `${pair.capital.shortLegLeverage}× perp leverage`
      : `${pair.capital.shortLegLeverage}× / ${pair.capital.longLegLeverage}× perp leverage`;
  const reasons = [...new Set(pair.reasons)].join('\n');
  const sideRow = (side: 'short' | 'long') => {
    const leg = side === 'short' ? pair.shortLeg : pair.longLeg;
    const color = side === 'short' ? '#fb7185' : '#34d399';
    const rate = leg.execApr ?? leg.midApr;
    return (
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: 10,
          background: side === 'short' ? 'rgba(251,113,133,.06)' : 'rgba(52,211,153,.06)',
          border: `1px solid ${side === 'short' ? 'rgba(251,113,133,.2)' : 'rgba(52,211,153,.2)'}`,
          borderRadius: 8,
          padding: '9px 12px',
          fontFamily: MONO,
          fontSize: 12.5,
        }}
      >
        <span>
          <span style={{ color, fontWeight: 600 }}>{side.toUpperCase()}</span>
          <span style={{ color: '#5a6273' }}> · </span>
          <span style={{ color: '#e9ebf0' }}>{prettyVenue(leg.venue)}</span>
        </span>
        <span style={{ color }}>@ {rate === null ? '—' : fmtPct(rate)}</span>
      </div>
    );
  };

  return (
    <button
      type="button"
      className="lp-btn lp-opp-card"
      onClick={onSelect}
      title={reasons || undefined}
      aria-label={`Select the ${group.underlying} opportunity maturing ${maturityShort(group.maturity, group.secondsToMaturity)}`}
      style={{
        background: '#0d0f13',
        border: `1px solid ${selected ? 'rgba(34,211,238,.5)' : '#1c2029'}`,
        borderRadius: 12,
        padding: 20,
        transition: 'border-color .25s',
        display: 'block',
        width: '100%',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span
          style={{
            fontFamily: MONO,
            fontSize: 12,
            fontWeight: 600,
            color: '#e9ebf0',
            background: '#151922',
            border: '1px solid #1c2029',
            borderRadius: 8,
            padding: '5px 9px',
          }}
        >
          {group.underlying}
        </span>
        <span style={{ fontFamily: MONO, fontSize: 11.5, color: '#5a6273' }}>
          {maturityShort(group.maturity, group.secondsToMaturity)}
        </span>
        <span
          style={{
            marginLeft: 'auto',
            fontFamily: MONO,
            fontSize: 10,
            letterSpacing: '.12em',
            padding: '4px 10px',
            borderRadius: 999,
            transition: 'color .25s, border-color .25s, background .25s',
            color: selected ? '#67e8f9' : '#5a6273',
            border: `1px solid ${selected ? 'rgba(34,211,238,.35)' : '#1c2029'}`,
            background: selected ? 'rgba(34,211,238,.08)' : 'transparent',
          }}
        >
          {selected ? '● SELECTED' : 'SELECT'}
        </span>
      </div>
      <div
        style={{ marginTop: 16, display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: '8px 10px' }}
      >
        <span
          style={{
            fontFamily: MONO,
            fontSize: 34,
            fontWeight: 600,
            letterSpacing: '-.02em',
            color: '#34d399',
          }}
        >
          {apr === null ? '—' : `${(apr * 100).toFixed(1)}%`}
        </span>
        <span style={{ fontSize: 15, fontWeight: 600, color: '#e9ebf0' }}>Fixed APR</span>
        <span
          style={{
            marginLeft: 'auto',
            fontFamily: MONO,
            fontSize: 11,
            color: '#67e8f9',
            background: 'rgba(34,211,238,.08)',
            border: '1px solid rgba(34,211,238,.25)',
            borderRadius: 6,
            padding: '4px 8px',
          }}
        >
          {levChip}
        </span>
      </div>
      <div style={{ marginTop: 5, fontSize: 12, color: '#8a92a3' }}>
        on{' '}
        <span style={{ fontFamily: MONO, color: '#e9ebf0' }}>
          {pair.capitalUsd === null ? '—' : fmtUsdCompact(pair.capitalUsd)}
        </span>{' '}
        capital
      </div>
      <div style={{ marginTop: 16, display: 'grid', gap: 8 }}>
        {sideRow('short')}
        {sideRow('long')}
      </div>
      <div
        style={{
          marginTop: 14,
          borderTop: '1px solid #1c2029',
          paddingTop: 12,
          fontFamily: MONO,
          fontSize: 11.5,
          lineHeight: 1.9,
          color: '#5a6273',
        }}
      >
        Locked spread:{' '}
        <span style={{ color: '#e9ebf0' }}>
          {pair.execSpreadApr === null ? '—' : fmtPct(pair.execSpreadApr)}
        </span>{' '}
        · Profit:{' '}
        <span style={{ color: '#34d399' }}>
          {pair.estProfitUsd === null ? '—' : fmtUsd(pair.estProfitUsd, 0)}
        </span>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Collapse — grid-template-rows 0fr→1fr with a delayed fade. `inert` (toggled
// as a raw attribute — React 18 has no typed prop for it) keeps a closed
// region's buttons/links out of the tab order; aria-hidden alone would leave
// focusable controls inside a hidden region.
// ---------------------------------------------------------------------------

function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  const innerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    innerRef.current?.toggleAttribute('inert', !open);
  }, [open]);
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateRows: open ? '1fr' : '0fr',
        transition: 'grid-template-rows .55s cubic-bezier(.4,0,.2,1)',
      }}
    >
      <div style={{ overflow: 'hidden', minHeight: 0 }}>
        <div
          ref={innerRef}
          aria-hidden={!open}
          style={{ opacity: open ? 1 : 0, transition: 'opacity .4s ease .1s' }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

/** A section's accordion body. The `sent-*` scroll sentinel lives in the
 * section wrapper (above the mind-map header slot), not here. */
function CascadePanel({ id, open, children }: { id: PanelId; open: boolean; children: ReactNode }) {
  return (
    <div id={`panel-${id}`}>
      <Collapse open={open}>
        <div style={{ padding: '10px 0 44px' }}>{children}</div>
      </Collapse>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export function LtpLandingApp() {
  // A #live/#system/#risk hash deep-links straight to that section, opened.
  const [opened, setOpened] = useState<Record<PanelId, boolean>>(() => {
    const hash = window.location.hash.replace('#', '') as PanelId;
    const upTo = PANELS.indexOf(hash);
    return {
      live: upTo >= 0,
      system: upTo >= 1,
      risk: upTo >= 2,
    };
  });
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [asmOpen, setAsmOpen] = useState(false);
  const [asm, setAsm] = useState<PitchAssumptions>(() =>
    readJson(LTP_PITCH_STORAGE_KEY, DEFAULT_ASSUMPTIONS, validateAssumptions),
  );
  const [navVisible, setNavVisible] = useState(false);

  useEffect(() => {
    writeJson(LTP_PITCH_STORAGE_KEY, asm);
  }, [asm]);

  // Same inert treatment as the panels: the closed popover's knobs must not
  // be tabbable behind aria-hidden.
  const asmPanelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    asmPanelRef.current?.toggleAttribute('inert', !asmOpen);
  }, [asmOpen]);

  // Sliders re-price on settle, not on every tick.
  const levDeb = useDebounced(asm.lev, 400);
  const rateDeb = useDebounced(asm.ratePct, 400);

  // Instant first paint: the previous visit's scan (when its knobs match the
  // current assumptions) renders dimmed as placeholder data while the live
  // fetch lands. Initial-mount snapshot only — knob changes fetch live.
  const [seed] = useState<LtpOpportunitiesResult | undefined>(() => {
    const stored = readJson<StoredScan | null>(LTP_PITCH_DATA_KEY, null, validateStoredScan);
    if (!stored || Date.now() - stored.ts > SEED_MAX_AGE_MS) return undefined;
    const m = stored.result.meta;
    const matches =
      m.notionalUsd === asm.notionalUsd &&
      m.perpLeverage === asm.lev &&
      m.borrowLeverage === asm.borrow &&
      Math.abs(m.loanRateApr - asm.ratePct / 100) < 1e-9 &&
      m.entryMode === asm.entry &&
      m.ltpTier === asm.tier;
    return matches ? stored.result : undefined;
  });

  const query = useLtpOpportunities(
    {
      notionalUsd: asm.notionalUsd,
      borosEntry: 'market',
      entryMode: asm.entry,
      exitMode: 'close',
      ltpTier: asm.tier,
      perpLeverage: levDeb,
      borrowLeverage: asm.borrow,
      loanRatePct: rateDeb,
    },
    { placeholder: seed },
  );

  useEffect(() => {
    if (query.data && !query.isPlaceholderData) {
      writeJson(LTP_PITCH_DATA_KEY, { ts: Date.now(), result: query.data } satisfies StoredScan);
    }
  }, [query.data, query.isPlaceholderData]);
  const data = query.data;
  // isPlaceholderData covers knob changes (key change + keepPreviousData); the
  // debounce terms cover a mid-drag slider. Deliberately NOT isFetching — the
  // 12s background poll must not pulse the page.
  const recomputing = query.isPlaceholderData || levDeb !== asm.lev || rateDeb !== asm.ratePct;

  // The server's ranking, filtered to priced cards — same viability rule as
  // the terminal's LTP tab; never re-sorted here.
  const visible = useMemo(() => {
    const groups = (data?.groups ?? []).filter((g) => {
      const apr = pairOf(g)?.netFixedAprOnCapital ?? null;
      return apr !== null && Number.isFinite(apr) && apr >= 0;
    });
    return groups.slice(0, 4);
  }, [data]);

  const selected = visible.find((g) => groupKeyOf(g) === selectedKey) ?? visible[0] ?? null;
  const selectedPair = selected ? pairOf(selected) : null;
  const selectedHasDma =
    selectedPair !== null &&
    (selectedPair.shortLeg.venueAccess === 'dma' || selectedPair.longLeg.venueAccess === 'dma');
  const bestPairVisible = visible[0] ? pairOf(visible[0]) : null;
  const notionalShown = data?.meta.notionalUsd ?? asm.notionalUsd;

  // -- cascade / auto-open ---------------------------------------------------
  const openedRef = useRef(opened);
  openedRef.current = opened;
  // Panels a cascade has SCHEDULED but not yet opened (cleared when they fire),
  // vs panels that have EVER been revealed — the scroll auto-open is a
  // first-reveal mechanism and must never reopen something the user closed.
  const pendingRef = useRef<Set<PanelId>>(new Set());
  const revealedRef = useRef<Set<PanelId>>(new Set());
  const timersRef = useRef<number[]>([]);
  // Scroll-triggered auto-open holds off until this timestamp. goPanel's own
  // smooth scroll extends it so a programmatic scroll (especially while the
  // first section is still short, mid-load) can't cascade the NEXT panel open.
  const coolRef = useRef(0);

  const cascade = useCallback((ids: readonly PanelId[]) => {
    let delay = 0;
    for (const id of ids) {
      if (openedRef.current[id] || pendingRef.current.has(id)) continue;
      pendingRef.current.add(id);
      timersRef.current.push(
        window.setTimeout(() => {
          pendingRef.current.delete(id);
          revealedRef.current.add(id);
          setOpened((s) => ({ ...s, [id]: true }));
        }, delay),
      );
      delay += 340;
    }
  }, []);

  // Every box heads its own section — navigation just opens it and scrolls.
  const goPanel = useCallback((id: PanelId) => {
    coolRef.current = Date.now() + 2200;
    revealedRef.current.add(id);
    if (!openedRef.current[id]) setOpened((s) => ({ ...s, [id]: true }));
    timersRef.current.push(
      window.setTimeout(() => {
        const el = document.getElementById(`sent-${id}`);
        if (el) {
          window.scrollTo({
            top: el.getBoundingClientRect().top + window.scrollY - 72,
            behavior: 'smooth',
          });
        }
      }, 150),
    );
  }, []);

  // Big screens may never scroll past section 1 — the arrow under it opens
  // the remaining two sections and lands on section 2.
  const expandRest = useCallback(() => {
    coolRef.current = Date.now() + 2200;
    cascade(['system', 'risk']);
    timersRef.current.push(
      window.setTimeout(() => {
        const el = document.getElementById('sent-system');
        if (el) {
          window.scrollTo({
            top: el.getBoundingClientRect().top + window.scrollY - 72,
            behavior: 'smooth',
          });
        }
      }, 700),
    );
  }, [cascade]);

  // A box click toggles its own section — the boxes below just slide down/up.
  const boxClick = useCallback((id: PanelId) => {
    coolRef.current = Date.now() + 1200;
    const next = { ...openedRef.current, [id]: !openedRef.current[id] };
    if (next[id]) revealedRef.current.add(id);
    setOpened(next);
  }, []);

  useEffect(() => () => timersRef.current.forEach((t) => window.clearTimeout(t)), []);

  useEffect(() => {
    let ticking = false;
    const detach = () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
    const check = () => {
      if (Date.now() < coolRef.current) return;
      const zone = window.innerHeight * 0.68;
      const hit = PANELS.find((id) => {
        if (openedRef.current[id] || pendingRef.current.has(id) || revealedRef.current.has(id))
          return false;
        const el = document.getElementById(`sent-${id}`);
        return el !== null && el.getBoundingClientRect().top < zone;
      });
      if (hit) {
        coolRef.current = Date.now() + 750;
        cascade([hit]);
      }
      if (PANELS.every((id) => pendingRef.current.has(id) || revealedRef.current.has(id))) detach();
    };
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        check();
      });
    };
    const attach = window.setTimeout(() => {
      window.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('resize', onScroll, { passive: true });
      check();
    }, 800);
    return () => {
      window.clearTimeout(attach);
      detach();
    };
  }, [cascade]);

  useEffect(() => {
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        const hub = document.getElementById('hub-zone');
        if (hub) setNavVisible(hub.getBoundingClientRect().bottom < 64);
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // A hash deep-link should LAND on its section, not just open it.
  useEffect(() => {
    const hash = window.location.hash.replace('#', '') as PanelId;
    if (!PANELS.includes(hash)) return;
    const t = window.setTimeout(() => {
      const el = document.getElementById(`sent-${hash}`);
      if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 72 });
    }, 60);
    return () => window.clearTimeout(t);
  }, []);

  // -- derived copy ----------------------------------------------------------
  const assumptionsLine = `priced at ${fmtNotionalShort(asm.notionalUsd)} per leg · up to ${asm.lev}× perp leverage · ${asm.borrow}× MarginX borrow @ ${asm.ratePct}% · ${tierLabel(asm.tier)} fees · ${
    ENTRY_CHOICES.find((c) => c.value === asm.entry)?.label ?? asm.entry
  }`;
  const asmCompact = `${fmtNotionalShort(asm.notionalUsd)} · ${asm.lev}× · ${asm.borrow}× @ ${asm.ratePct}%`;

  const seg = (id: PanelId) => ({
    stroke: opened[id] ? '#22d3ee' : '#2a3140',
    border: opened[id] ? 'rgba(34,211,238,.5)' : '#1c2029',
    nav: opened[id] ? '#67e8f9' : '#8a92a3',
  });
  const segLive = seg('live');
  const segSystem = seg('system');
  const segRisk = seg('risk');

  const bestApr = bestPairVisible?.netFixedAprOnCapital ?? null;
  const bestAprText =
    bestApr !== null ? `${(bestApr * 100).toFixed(1)}%` : query.isPending ? '…' : '—';
  const bestTermText = visible[0]
    ? `${daysToMaturity(visible[0].secondsToMaturity)} days`
    : query.isPending
      ? '…'
      : 'none now';

  // One renderer for a mind-map box, used in the hub row AND as a section
  // header — only one instance is visible (non-aria-hidden) per mode.
  const boxContent = (id: PanelId) =>
    id === 'live' && opened.live ? (
      // Expanded: the cards below carry the numbers — the box is just a title.
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 17, fontWeight: 600, lineHeight: 1.4 }}>
        <span className="lp-dot" />
        Live opportunities
      </div>
    ) : id === 'live' ? (
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          flexWrap: 'wrap',
          gap: '6px 10px',
          opacity: recomputing ? 0.55 : 1,
          transition: 'opacity .2s',
        }}
      >
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 9,
            fontSize: 17,
            fontWeight: 500,
            color: '#8a92a3',
          }}
        >
          <span className="lp-dot" />
          Live opportunities:
        </span>
        <span
          style={{
            fontFamily: MONO,
            fontSize: 24,
            fontWeight: 600,
            letterSpacing: '-.02em',
            color: '#34d399',
          }}
        >
          {bestAprText} Fixed
        </span>
        <span style={{ fontFamily: MONO, fontSize: 13, color: '#5a6273', whiteSpace: 'nowrap' }}>
          ({bestTermText})
        </span>
      </div>
    ) : id === 'system' ? (
      <div style={{ fontSize: 17, fontWeight: 600, lineHeight: 1.4, textWrap: 'balance' }}>
        Three parts of the strategy
      </div>
    ) : (
      <div style={{ fontSize: 17, fontWeight: 600, lineHeight: 1.4, textWrap: 'balance' }}>
        <span style={{ color: '#8a92a3', fontWeight: 500 }}>Most important key:</span> avoid
        liquidation
      </div>
    );

  const boxButton = (id: PanelId) => (
    <button
      type="button"
      className="lp-btn lp-hub-card"
      onClick={() => boxClick(id)}
      aria-expanded={opened[id]}
      aria-label={id === 'live' ? 'Open live opportunities' : undefined}
      style={{
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        minHeight: 92,
        background: '#0d0f13',
        border: `1px solid ${seg(id).border}`,
        borderRadius: 12,
        padding: '20px 22px',
        transition: 'border-color .3s, transform .25s, box-shadow .25s',
        width: 'min(380px, 100%)',
        textAlign: 'left' as const,
      }}
    >
      {boxContent(id)}
    </button>
  );

  const navPill = (label: ReactNode, id: PanelId, color: string) => (
    <button
      type="button"
      className="lp-btn lp-nav-pill"
      onClick={() => goPanel(id)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        padding: '6px 12px',
        borderRadius: 999,
        fontSize: 12.5,
        fontWeight: 500,
        whiteSpace: 'nowrap',
        transition: 'color .25s, background .25s',
        color,
      }}
    >
      {label}
    </button>
  );

  return (
    <div
      className="lp-root"
      style={{ position: 'relative', minHeight: '100vh', background: '#08090b', overflow: 'clip' }}
    >
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 860,
          pointerEvents: 'none',
          background:
            'radial-gradient(1000px 560px at 50% -120px, rgba(34,211,238,.06), rgba(34,211,238,0) 65%), radial-gradient(820px 460px at 88% -80px, rgba(16,185,129,.04), rgba(16,185,129,0) 65%)',
        }}
      />

      {/* Sticky nav */}
      <div
        id="sticky-nav"
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          zIndex: 55,
          transform: navVisible ? 'translateY(0)' : 'translateY(-110%)',
          transition: 'transform .35s ease',
          background: 'rgba(8,9,11,.88)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          borderBottom: '1px solid #1c2029',
        }}
      >
        <div
          style={{
            maxWidth: 1200,
            margin: '0 auto',
            padding: '10px 24px',
            display: 'flex',
            alignItems: 'center',
            gap: 18,
          }}
        >
          <button
            type="button"
            className="lp-btn"
            onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
            style={{
              fontFamily: MONO,
              fontSize: 10.5,
              letterSpacing: '.18em',
              color: '#5a6273',
              fontWeight: 600,
              whiteSpace: 'nowrap',
            }}
          >
            BOROS × LTP
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, overflowX: 'auto' }}>
            {navPill(
              <>
                <span className="lp-dot lp-dot-sm" />
                Live opportunities
              </>,
              'live',
              segLive.nav,
            )}
            {navPill('Three parts', 'system', segSystem.nav)}
            {navPill('Avoid liquidation', 'risk', segRisk.nav)}
          </div>
          <a
            href={MAILTO}
            className="lp-cta"
            style={{
              marginLeft: 'auto',
              display: 'inline-block',
              background: '#22d3ee',
              color: '#062a33',
              fontSize: 12,
              fontWeight: 600,
              padding: '7px 14px',
              borderRadius: 999,
              whiteSpace: 'nowrap',
            }}
          >
            Talk to the Pendle team
          </a>
        </div>
      </div>

      <div style={{ position: 'relative', maxWidth: 1200, margin: '0 auto', padding: '0 24px 110px' }}>
        {/* Hub */}
        <div id="hub-zone" style={{ paddingTop: 36 }}>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
            }}
          >
            <div
              style={{
                fontFamily: MONO,
                fontSize: 11,
                letterSpacing: '.22em',
                textTransform: 'uppercase',
                color: '#5a6273',
                fontWeight: 600,
              }}
            >
              Boros × LTP
            </div>
            <a
              href={MAILTO}
              className="lp-cta"
              style={{
                display: 'inline-block',
                background: '#22d3ee',
                color: '#062a33',
                fontSize: 13,
                fontWeight: 600,
                padding: '9px 18px',
                borderRadius: 999,
              }}
            >
              Talk to the Pendle team
            </a>
          </div>
          <h1
            className="lp-fade-up"
            style={{
              margin: '72px auto 0',
              maxWidth: 900,
              textAlign: 'center',
              fontSize: 'clamp(32px, 4.4vw, 54px)',
              lineHeight: 1.1,
              letterSpacing: '-.025em',
              fontWeight: 600,
              textWrap: 'balance',
            }}
          >
            Fixed Return Funding Rate Arbitrage
            <br />
            <span style={{ color: '#5a6273', fontWeight: 500 }}>with</span> Boros{' '}
            <span style={{ color: '#5a6273', fontWeight: 500 }}>and</span> LTP
          </h1>
          <div className="lp-fade-up" style={{ marginTop: 4, animationDelay: '.15s' }}>
            <svg
              className="lp-hub-fan"
              width="100%"
              height="84"
              viewBox="0 0 1200 84"
              preserveAspectRatio="none"
              style={{ display: 'block' }}
              aria-hidden
            >
              <circle cx="600" cy="6" r="3.5" fill="#22d3ee" />
              {/* From the title's dot down into the left trunk the boxes hang on. */}
              <path
                d="M600 6 C 600 46, 11 30, 11 84"
                fill="none"
                stroke="#2a3140"
                strokeWidth="1.5"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
          </div>
        </div>

        <div className="lp-secs lp-rail" style={{ marginTop: 28, position: 'relative' }}>

          {/* ---- Live opportunities ------------------------------------------ */}
          <section className="lp-sec">
            <div id="sent-live" style={{ height: 2 }} />
            <div
              className="lp-sec-stub"
              style={{ borderTopColor: opened.live ? 'rgba(34,211,238,.55)' : '#2a3140' }}
            />
            <div className="lp-sec-head">{boxButton('live')}</div>
            <CascadePanel id="live" open={opened.live}>
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                justifyContent: 'flex-end',
                gap: '10px 20px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                {recomputing && (
                  <span style={{ fontFamily: MONO, fontSize: 10.5, color: '#5a6273' }}>recomputing…</span>
                )}
                <button
                  type="button"
                  className="lp-btn lp-asm-line"
                  onClick={() => setAsmOpen((v) => !v)}
                  style={{
                    border: '1px solid #1c2029',
                    background: '#0d0f13',
                    borderRadius: 999,
                    padding: '7px 15px',
                    fontFamily: MONO,
                    fontSize: 11,
                    lineHeight: 1.6,
                    color: '#5a6273',
                  }}
                >
                  {assumptionsLine}
                </button>
              </div>
            </div>
            <div style={{ marginTop: 12, fontSize: 12.5, color: '#8a92a3' }}>
              <span style={{ color: '#67e8f9' }}>▸</span> Select an opportunity — the rates, PnL
              breakdown and liquidation chart across this page follow the{' '}
              <span style={{ color: '#e9ebf0' }}>selected</span> one.
            </div>

            {query.isError && data === undefined ? (
              <div
                style={{
                  marginTop: 16,
                  background: '#0d0f13',
                  border: '1px solid rgba(251,113,133,.35)',
                  borderRadius: 12,
                  padding: 20,
                  fontSize: 13,
                  color: '#8a92a3',
                }}
              >
                Couldn&apos;t load the live opportunities.{' '}
                <button
                  type="button"
                  className="lp-btn"
                  onClick={() => void query.refetch()}
                  style={{ color: '#67e8f9' }}
                >
                  Retry
                </button>
              </div>
            ) : (
              <div
                style={{
                  marginTop: 16,
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
                  gap: 16,
                  opacity: recomputing ? 0.55 : 1,
                  transition: 'opacity .2s',
                }}
              >
                {visible.map((g) => (
                  <OppCard
                    key={groupKeyOf(g)}
                    group={g}
                    selected={selected !== null && groupKeyOf(g) === groupKeyOf(selected)}
                    onSelect={() => setSelectedKey(groupKeyOf(g))}
                  />
                ))}
                {visible.length === 0 && (
                  <div
                    style={{
                      background: '#0d0f13',
                      border: '1px solid #1c2029',
                      borderRadius: 12,
                      padding: 20,
                      fontSize: 13,
                      lineHeight: 1.6,
                      color: '#5a6273',
                    }}
                  >
                    {query.isPending
                      ? 'Pricing the live opportunities…'
                      : `No Boros arb group prices out at ${fmtNotionalShort(asm.notionalUsd)} per leg at ${asm.lev}× leverage with a ${asm.borrow}× MarginX borrow at ${asm.ratePct}%. Try another notional or another assumption.`}
                  </div>
                )}
              </div>
            )}

            <div style={{ marginTop: 16, maxWidth: 840, fontSize: 12.5, lineHeight: 1.6, color: '#5a6273' }}>
              Every cost is modelled — Boros book impact, taker + settlement fees, perp fees + VWAP
              slippage, loan interest — or the card says why it can&apos;t be.
            </div>
            {/* The public box runs without LTP keys by design — the engine's
             * "LTP is not configured" note is operator guidance, not pitch
             * content; perp availability is assumed. */}
            {(data?.warnings ?? [])
              .filter((w) => !w.startsWith('LTP is not configured on this server'))
              .map((w) => (
              <div
                key={w}
                style={{ marginTop: 6, maxWidth: 840, fontSize: 11.5, lineHeight: 1.6, color: 'rgba(251,191,36,.75)' }}
              >
                {w}
              </div>
            ))}
          </CascadePanel>
          {/* Big screens may never scroll past this section — offer the rest. */}
          <Collapse open={opened.live && !opened.system && !opened.risk}>
            <div style={{ display: 'flex', justifyContent: 'center', padding: '2px 0 30px' }}>
              <button
                type="button"
                className="lp-btn lp-expand-all"
                onClick={expandRest}
                aria-label="Expand the rest of the strategy"
              >
                See more
                <span className="lp-expand-arrow" aria-hidden>
                  ↓
                </span>
              </button>
            </div>
          </Collapse>
          </section>

          {/* ---- The system -------------------------------------------------- */}
          <section className="lp-sec">
            <div id="sent-system" style={{ height: 2 }} />
            <div
              className="lp-sec-stub"
              style={{ borderTopColor: opened.system ? 'rgba(34,211,238,.55)' : '#2a3140' }}
            />
            <div className="lp-sec-head">{boxButton('system')}</div>
            <CascadePanel id="system" open={opened.system}>
            <div className="lp-scroll-x" style={{ marginTop: 18, paddingBottom: 6 }}>
              <div className="lp-sys-inner">
                <div
                  id="part-01"
                  className="lp-sys-part1"
                  style={{ background: '#0d0f13', border: '1px solid #1c2029', borderRadius: 12, padding: 22 }}
                >
                  <div
                    style={{
                      fontFamily: MONO,
                      fontSize: 11.5,
                      letterSpacing: '.14em',
                      display: 'flex',
                      alignItems: 'baseline',
                      gap: 8,
                    }}
                  >
                    <span style={{ color: '#22d3ee', fontWeight: 700 }}>PART 01</span>
                    <span style={{ color: '#5a6273' }}>·</span>
                    <span style={{ color: '#8a92a3' }}>LTP</span>
                    <span style={{ marginLeft: 'auto', letterSpacing: 0, whiteSpace: 'nowrap' }}>
                      <span style={{ color: '#e9ebf0', fontWeight: 600 }}>
                        {fmtNotionalShort(notionalShown)}
                      </span>
                      <span style={{ color: '#5a6273' }}> / leg</span>
                    </span>
                  </div>
                  <div
                    style={{
                      marginTop: 16,
                      border: '1.5px dashed rgba(34,211,238,.38)',
                      borderRadius: 12,
                      background: 'rgba(34,211,238,.03)',
                      padding: '14px 16px 16px',
                    }}
                  >
                    <div
                      style={{
                        fontFamily: MONO,
                        fontSize: 10.5,
                        letterSpacing: '.06em',
                        color: '#67e8f9',
                        marginBottom: 12,
                      }}
                    >
                      MarginX group — one unified margin, borrow up to 2× at ~9.5% APR
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                      <div
                        style={{
                          background: 'rgba(251,113,133,.06)',
                          border: '1px solid rgba(251,113,133,.22)',
                          borderRadius: 10,
                          padding: '13px 14px',
                          fontFamily: MONO,
                          fontSize: 12.5,
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                        }}
                      >
                        <span style={{ whiteSpace: 'nowrap' }}>
                          <span style={{ color: '#fb7185', fontWeight: 600 }}>SHORT perp</span>
                          <span style={{ color: '#5a6273' }}> · </span>
                          <span style={{ color: '#e9ebf0' }}>
                            {selectedPair ? prettyVenue(selectedPair.shortLeg.venue) : '…'}
                          </span>
                        </span>
                        <AccessBadge access={selectedPair?.shortLeg.venueAccess ?? null} />
                      </div>
                      <div
                        style={{
                          background: 'rgba(52,211,153,.06)',
                          border: '1px solid rgba(52,211,153,.22)',
                          borderRadius: 10,
                          padding: '13px 14px',
                          fontFamily: MONO,
                          fontSize: 12.5,
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                        }}
                      >
                        <span style={{ whiteSpace: 'nowrap' }}>
                          <span style={{ color: '#34d399', fontWeight: 600 }}>LONG perp</span>
                          <span style={{ color: '#5a6273' }}> · </span>
                          <span style={{ color: '#e9ebf0' }}>
                            {selectedPair ? prettyVenue(selectedPair.longLeg.venue) : '…'}
                          </span>
                        </span>
                        <AccessBadge access={selectedPair?.longLeg.venueAccess ?? null} />
                      </div>
                    </div>
                  </div>
                  <div style={{ marginTop: 14, fontFamily: MONO, fontSize: 11.5, color: '#5a6273' }}>
                    two trading accounts under LTP <span style={{ color: '#22d3ee' }}>→</span> add
                    to one MarginX group <span style={{ color: '#22d3ee' }}>→</span> borrow against
                    it
                  </div>
                  <div style={{ marginTop: 9, fontSize: 12, color: '#5a6273' }}>
                    Native RapidX on Binance &amp; OKX; other venues via DMA sub-accounts.
                  </div>
                </div>

                <div
                  className="lp-sys-conn-col"
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'center',
                    gap: 9,
                    padding: '0 8px',
                  }}
                >
                  <div style={{ borderTop: '1px dashed #3a4150' }} />
                  <div
                    style={{
                      fontFamily: MONO,
                      fontSize: 10,
                      lineHeight: 1.55,
                      color: '#5a6273',
                      textAlign: 'center',
                    }}
                  >
                    floating funding cancels per venue
                  </div>
                  <div style={{ borderTop: '1px dashed #3a4150' }} />
                </div>
                <div className="lp-sys-divider">— floating funding cancels per venue —</div>

                <div
                  id="part-02"
                  className="lp-sys-part2"
                  style={{
                    background: '#0d0f13',
                    border: '1px solid #1c2029',
                    borderRadius: 12,
                    padding: 22,
                    display: 'flex',
                    flexDirection: 'column',
                  }}
                >
                  <div
                    style={{
                      fontFamily: MONO,
                      fontSize: 11.5,
                      letterSpacing: '.14em',
                      display: 'flex',
                      alignItems: 'baseline',
                      gap: 8,
                    }}
                  >
                    <span style={{ color: '#22d3ee', fontWeight: 700 }}>PART 02</span>
                    <span style={{ color: '#5a6273' }}>·</span>
                    <span style={{ color: '#8a92a3' }}>BOROS</span>
                    <span style={{ marginLeft: 'auto', letterSpacing: 0, whiteSpace: 'nowrap' }}>
                      <span style={{ color: '#e9ebf0', fontWeight: 600 }}>
                        {fmtNotionalShort(notionalShown)}
                      </span>
                      <span style={{ color: '#5a6273' }}> / leg</span>
                    </span>
                  </div>
                  <div style={{ marginTop: 16, display: 'grid', gap: 10 }}>
                    <div
                      style={{
                        background: 'rgba(251,113,133,.07)',
                        border: '1px solid rgba(251,113,133,.22)',
                        borderRadius: 8,
                        padding: '12px 14px',
                        fontFamily: MONO,
                        fontSize: 12.5,
                        color: '#fb7185',
                      }}
                    >
                      <span
                        className="lp-dot lp-dot-sm"
                        style={{ display: 'inline-block', marginRight: 8, verticalAlign: 'middle' }}
                      />
                      SHORT fixed — receive{' '}
                      <span style={{ fontWeight: 700 }}>
                        {(() => {
                          const r = selectedPair?.shortLeg.execApr ?? selectedPair?.shortLeg.midApr;
                          return r == null ? '…' : fmtPct(r);
                        })()}
                      </span>
                      {selectedPair?.shortLeg.execApr != null && (
                        <span style={{ fontSize: 11, color: 'rgba(251,113,133,.65)' }}>
                          {' '}
                          ({fmtPct(Math.abs(selectedPair.shortLeg.execApr - selectedPair.shortLeg.midApr))}{' '}
                          price impact)
                        </span>
                      )}
                    </div>
                    <div
                      style={{
                        background: 'rgba(52,211,153,.07)',
                        border: '1px solid rgba(52,211,153,.22)',
                        borderRadius: 8,
                        padding: '12px 14px',
                        fontFamily: MONO,
                        fontSize: 12.5,
                        color: '#34d399',
                      }}
                    >
                      <span
                        className="lp-dot lp-dot-sm"
                        style={{ display: 'inline-block', marginRight: 8, verticalAlign: 'middle' }}
                      />
                      LONG fixed — pay{' '}
                      <span style={{ fontWeight: 700 }}>
                        {(() => {
                          const r = selectedPair?.longLeg.execApr ?? selectedPair?.longLeg.midApr;
                          return r == null ? '…' : fmtPct(r);
                        })()}
                      </span>
                      {selectedPair?.longLeg.execApr != null && (
                        <span style={{ fontSize: 11, color: 'rgba(52,211,153,.65)' }}>
                          {' '}
                          ({fmtPct(Math.abs(selectedPair.longLeg.execApr - selectedPair.longLeg.midApr))}{' '}
                          price impact)
                        </span>
                      )}
                    </div>
                  </div>
                  <div style={{ marginTop: 'auto', paddingTop: 14, fontFamily: MONO, fontSize: 11.5, color: '#5a6273' }}>
                    locks the spread to maturity
                  </div>
                </div>

                <div className="lp-sys-conn-row" style={{ position: 'relative', margin: '0 24px' }}>
                  <div style={{ position: 'absolute', left: '24%', top: 0, bottom: 0, display: 'flex', gap: 9 }}>
                    <div style={{ borderLeft: '1px dashed #3a4150' }} />
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                      <div
                        style={{
                          width: 0,
                          height: 0,
                          borderLeft: '4px solid transparent',
                          borderRight: '4px solid transparent',
                          borderBottom: '6px solid #22d3ee',
                        }}
                      />
                      <div style={{ flex: 1, width: 2, background: '#22d3ee' }} />
                    </div>
                  </div>
                  <div style={{ position: 'absolute', left: '71%', top: 0, bottom: 0, display: 'flex', gap: 9 }}>
                    <div style={{ borderLeft: '1px dashed #3a4150' }} />
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                      <div
                        style={{
                          width: 0,
                          height: 0,
                          borderLeft: '4px solid transparent',
                          borderRight: '4px solid transparent',
                          borderBottom: '6px solid #22d3ee',
                        }}
                      />
                      <div style={{ flex: 1, width: 2, background: '#22d3ee' }} />
                    </div>
                  </div>
                  <div
                    style={{
                      position: 'absolute',
                      left: '47.5%',
                      top: '50%',
                      transform: 'translate(-50%,-50%)',
                      background: '#08090b',
                      padding: '3px 10px',
                      fontFamily: MONO,
                      fontSize: 10,
                      color: '#5a6273',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    ↓ mark price + margin, 24/7 &nbsp;·&nbsp;{' '}
                    <span style={{ color: '#67e8f9' }}>↑ top-ups</span>
                  </div>
                </div>
                <div className="lp-sys-divider">↓ mark price + margin, 24/7 · ↑ top-ups</div>

                <div
                  id="part-03"
                  className="lp-sys-part3"
                  style={{
                    background: '#0d0f13',
                    border: '1px solid rgba(34,211,238,.28)',
                    borderRadius: 12,
                    padding: '20px 22px',
                  }}
                >
                  <div style={{ fontFamily: MONO, fontSize: 11.5, letterSpacing: '.14em' }}>
                    <span style={{ color: '#22d3ee', fontWeight: 700 }}>PART 03</span>
                    <span style={{ color: '#5a6273' }}> · THE REBALANCER · </span>
                    <span style={{ color: '#8a92a3' }}>BOT</span>
                  </div>
                  <div
                    style={{
                      marginTop: 14,
                      display: 'flex',
                      flexWrap: 'wrap',
                      alignItems: 'baseline',
                      gap: '8px 14px',
                      fontFamily: MONO,
                      fontSize: 12.5,
                      lineHeight: 1.7,
                      color: '#8a92a3',
                    }}
                  >
                    <span>
                      <span style={{ color: '#e9ebf0', fontWeight: 600 }}>watches</span> both perp
                      accounts around the clock
                    </span>
                    <span style={{ color: '#3a4150' }}>·</span>
                    <span>
                      <span style={{ color: '#e9ebf0', fontWeight: 600 }}>alerts</span> the desk
                    </span>
                    <span style={{ color: '#3a4150' }}>·</span>
                    <span>
                      <span style={{ color: '#e9ebf0', fontWeight: 600 }}>tops up</span> the pressured
                      venue — MarginX borrow there, repay at the flush one{' '}
                      <span style={{ color: '#67e8f9' }}>(~100s)</span>, or Rapid Transfer{' '}
                      <span style={{ color: '#67e8f9' }}>(~60s)</span>, or normal transfer{' '}
                      <span style={{ color: '#67e8f9' }}>(~3–20min)</span>
                    </span>
                  </div>
                  <div style={{ marginTop: 10, fontSize: 11.5, color: '#5a6273' }}>
                    Timings are estimates and can vary with venue and network conditions — verify
                    against your own accounts.
                  </div>
                </div>
              </div>
            </div>

            {/* PnL & capital — the real ledger for the selected opportunity */}
            <div
              style={{
                marginTop: 16,
                background: '#0d0f13',
                border: '1px solid #1c2029',
                borderRadius: 12,
                padding: '20px 24px',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  justifyContent: 'space-between',
                  gap: '6px 24px',
                  ...microLabel,
                  fontSize: 10.5,
                }}
              >
                <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                  PnL &amp; capital breakdown — selected opportunity
                  <span className="lp-dot lp-dot-sm" />
                </div>
                {data && selected && selectedPair && (
                  <div>
                    {fmtNotionalShort(data.meta.notionalUsd)} notional ·{' '}
                    {selectedPair.capital.shortLegLeverage === selectedPair.capital.longLegLeverage
                      ? `${selectedPair.capital.shortLegLeverage}× perp`
                      : `${selectedPair.capital.shortLegLeverage}×/${selectedPair.capital.longLegLeverage}× perp`}{' '}
                    · {data.meta.borrowLeverage}× MarginX borrow @ {fmtPct(data.meta.loanRateApr, 1)} ·{' '}
                    {daysToMaturity(selected.secondsToMaturity)} days
                  </div>
                )}
              </div>
              <div style={{ marginTop: 14, opacity: recomputing ? 0.55 : 1, transition: 'opacity .2s' }}>
                {selectedPair && data && (canChartLtpProfit(selectedPair) || canChartLtpCapital(selectedPair)) ? (
                  <LtpOpportunityWaterfall
                    pair={selectedPair}
                    notionalUsd={data.meta.notionalUsd}
                    showEffectiveLeverage={false}
                  />
                ) : (
                  <div style={{ fontSize: 12.5, lineHeight: 1.6, color: '#5a6273' }}>
                    {selectedPair
                      ? [...new Set(selectedPair.reasons)].join(' ') ||
                        'The breakdown can’t be modelled for this pair.'
                      : 'Select an opportunity above to see its PnL and capital breakdown.'}
                  </div>
                )}
              </div>
            </div>
          </CascadePanel>
          </section>

          {/* ---- Risk -------------------------------------------------------- */}
          <section className="lp-sec">
            <div id="sent-risk" style={{ height: 2 }} />
            <div
              className="lp-sec-stub"
              style={{ borderTopColor: opened.risk ? 'rgba(34,211,238,.55)' : '#2a3140' }}
            />
            <div className="lp-sec-head">{boxButton('risk')}</div>
            <CascadePanel id="risk" open={opened.risk}>
            <p style={{ margin: '12px 0 0', maxWidth: 820, fontSize: 14, lineHeight: 1.6, color: '#8a92a3' }}>
              Delta-neutral means one perp leg is always winning — the risk is the losing leg reaching
              liquidation before its margin is topped up.{' '}
              <button
                type="button"
                className="lp-btn"
                onClick={() => goPanel('system')}
                style={{ color: '#67e8f9', display: 'inline' }}
              >
                Part 03
              </button>{' '}
              exists to close that gap.
            </p>
            <div
              style={{
                marginTop: 22,
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(330px, 1fr))',
                gap: 16,
              }}
            >
              <div style={{ background: '#0d0f13', border: '1px solid #1c2029', borderRadius: 12, padding: 22 }}>
                <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: '.14em', color: '#8a92a3', fontWeight: 600 }}>
                  RUNWAY TO LIQUIDATION
                </div>
                <div className="lp-scroll-x" style={{ marginTop: 14 }}>
                  {/* The knob IS the binding leg: pairs are cross-venue and only
                   * Hyperliquid legs clamp DOWN, so the unclamped leg always
                   * carries the knob — the shortest runway on the pair. */}
                  <RunwayChart lev={asm.lev} />
                </div>
              </div>
              <div style={{ background: '#0d0f13', border: '1px solid #1c2029', borderRadius: 12, padding: 22 }}>
                <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: '.14em', color: '#8a92a3', fontWeight: 600 }}>
                  PART 03 · THE TOP-UP LOOP
                </div>
                <div className="lp-loop-grid" style={{ marginTop: 16 }}>
                  <div
                    className="lp-loop-s1"
                    style={{ background: '#10131a', border: '1px solid #1c2029', borderRadius: 10, padding: '13px 14px' }}
                  >
                    <div style={{ fontFamily: MONO, fontSize: 10.5, letterSpacing: '.1em', color: '#67e8f9', fontWeight: 600 }}>
                      01 · WATCH
                    </div>
                    <div style={{ marginTop: 6, fontSize: 11.5, lineHeight: 1.55, color: '#8a92a3' }}>
                      mark price + margin on both venues
                    </div>
                  </div>
                  <div className="lp-loop-a1" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#3a4150', fontSize: 17 }}>
                    →
                  </div>
                  <div className="lp-loop-marrow lp-loop-m1">↓</div>
                  <div
                    className="lp-loop-s2"
                    style={{ background: '#10131a', border: '1px solid #1c2029', borderRadius: 10, padding: '13px 14px' }}
                  >
                    <div style={{ fontFamily: MONO, fontSize: 10.5, letterSpacing: '.1em', color: '#67e8f9', fontWeight: 600 }}>
                      02 · BREACH
                    </div>
                    <div style={{ marginTop: 6, fontSize: 11.5, lineHeight: 1.55, color: '#8a92a3' }}>
                      the losing venue&apos;s margin hits its threshold
                    </div>
                  </div>
                  <div className="lp-loop-a4" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#3a4150', fontSize: 17 }}>
                    ↑
                  </div>
                  <div className="lp-loop-cycle" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#22d3ee', fontSize: 16 }}>
                    ↺
                  </div>
                  <div className="lp-loop-a2" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#3a4150', fontSize: 17 }}>
                    ↓
                  </div>
                  <div className="lp-loop-marrow lp-loop-m2">↓</div>
                  <div
                    className="lp-loop-s4"
                    style={{ background: '#10131a', border: '1px solid #1c2029', borderRadius: 10, padding: '13px 14px' }}
                  >
                    <div style={{ fontFamily: MONO, fontSize: 10.5, letterSpacing: '.1em', color: '#67e8f9', fontWeight: 600 }}>
                      04 · LEVEL
                    </div>
                    <div style={{ marginTop: 6, fontSize: 11.5, lineHeight: 1.55, color: '#8a92a3' }}>
                      margins even out, the loop continues
                    </div>
                  </div>
                  <div className="lp-loop-a3" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#3a4150', fontSize: 17 }}>
                    ←
                  </div>
                  <div className="lp-loop-marrow lp-loop-m3">↓</div>
                  <div
                    className="lp-loop-s3"
                    style={{ background: '#10131a', border: '1px solid #1c2029', borderRadius: 10, padding: '13px 14px' }}
                  >
                    <div style={{ fontFamily: MONO, fontSize: 10.5, letterSpacing: '.1em', color: '#67e8f9', fontWeight: 600 }}>
                      03 · MOVE
                    </div>
                    <div style={{ marginTop: 6, fontSize: 11.5, lineHeight: 1.55, color: '#8a92a3' }}>
                      MarginX borrow at the losing venue, repay at the winning one{' '}
                      <span style={{ color: '#67e8f9' }}>(~100s)</span>, or Rapid Transfer{' '}
                      <span style={{ color: '#67e8f9' }}>(~60s</span>, USDT between Binance / Bybit /
                      OKX / Coinbase / Gate pools<span style={{ color: '#67e8f9' }}>)</span>
                    </div>
                  </div>
                  <div className="lp-loop-marrow lp-loop-m4">↺ the loop repeats</div>
                </div>
              </div>
            </div>
            <div
              style={{
                marginTop: 16,
                background: 'rgba(34,211,238,.05)',
                border: '1px solid rgba(34,211,238,.22)',
                borderRadius: 12,
                padding: '20px 24px',
              }}
            >
              <div style={{ fontSize: 15, fontWeight: 500, color: '#e9ebf0' }}>
                The bottleneck is the speed of collateral transfer across the venues.
              </div>
              <div style={{ marginTop: 6, fontSize: 13.5, lineHeight: 1.6, color: '#8a92a3' }}>
                <a href={MAILTO} style={{ color: '#67e8f9' }}>
                  Talk to us
                </a>{' '}
                and/or the LTP team for more info on the speed of collateral transfers. The numbers
                estimated here are anecdotal examples.
              </div>
            </div>
            <div style={{ marginTop: 14, maxWidth: 900, fontSize: 12, lineHeight: 1.6, color: 'rgba(251,191,36,.78)' }}>
              Runway is approximate — the exact number depends on venue and size.
            </div>
          </CascadePanel>
          </section>
        </div>

        {/* Footer */}
        <div style={{ marginTop: 64, borderTop: '1px solid #1c2029', padding: '26px 0 48px' }}>
          <div style={{ fontSize: 12, lineHeight: 1.6, color: '#5a6273' }}>
            Illustrative economics, not investment advice. Live figures are estimates from public order
            books; execution not guaranteed.
          </div>
          <div style={{ marginTop: 10, fontSize: 12, lineHeight: 1.7, color: '#5a6273' }}>
            Boros — funding rates, fixed. A Pendle product. · LTP (LiquidityTech) — independent prime
            broker.
          </div>
          <div style={{ marginTop: 18, display: 'flex', flexWrap: 'wrap', gap: 22, fontFamily: MONO, fontSize: 12 }}>
            <a href="https://boros.pendle.finance" target="_blank" rel="noopener noreferrer" style={{ color: '#67e8f9' }}>
              Boros
            </a>
            <a href="https://www.pendle.finance" target="_blank" rel="noopener noreferrer" style={{ color: '#67e8f9' }}>
              Pendle
            </a>
          </div>
        </div>
      </div>

      {/* Assumptions widget */}
      <div style={{ position: 'fixed', left: 20, bottom: 20, zIndex: 60 }}>
        <div
          ref={asmPanelRef}
          style={{
            position: 'absolute',
            bottom: 62,
            left: 0,
            width: 'min(320px, calc(100vw - 40px))',
            maxHeight: 'min(560px, calc(100vh - 110px))',
            overflowY: 'auto',
            background: '#0d0f13',
            border: '1px solid #1c2029',
            borderRadius: 12,
            padding: '16px 18px',
            boxShadow: '0 16px 40px rgba(0,0,0,.5)',
            transformOrigin: 'bottom left',
            opacity: asmOpen ? 1 : 0,
            transform: asmOpen ? 'translateY(0) scale(1)' : 'translateY(8px) scale(.98)',
            pointerEvents: asmOpen ? 'auto' : 'none',
            transition: 'opacity .25s ease, transform .25s ease',
          }}
          aria-hidden={!asmOpen}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
            <span style={{ fontFamily: MONO, fontSize: 10.5, letterSpacing: '.14em', color: '#8a92a3', fontWeight: 600 }}>
              ASSUMPTIONS
            </span>
            <span style={{ fontFamily: MONO, fontSize: 10, color: '#5a6273' }}>re-prices every live card</span>
          </div>
          <div style={{ marginTop: 14 }}>
            <div style={{ ...microLabel, marginBottom: 7 }}>Notional per leg</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {NOTIONAL_CHOICES.map((n) => (
                <Opt
                  key={n}
                  label={fmtNotionalShort(n)}
                  active={asm.notionalUsd === n}
                  onClick={() => setAsm((a) => ({ ...a, notionalUsd: n }))}
                />
              ))}
            </div>
          </div>
          <div style={{ marginTop: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span style={microLabel}>Perp leverage</span>
              <span style={{ fontFamily: MONO, fontSize: 11.5, color: '#67e8f9' }}>{asm.lev}×</span>
            </div>
            <input
              type="range"
              min={1}
              max={50}
              step={1}
              value={asm.lev}
              aria-label="Perp leverage"
              onChange={(e) => setAsm((a) => ({ ...a, lev: +e.target.value }))}
              className="lp-range"
            />
          </div>
          <div style={{ marginTop: 14 }}>
            <div style={{ ...microLabel, marginBottom: 7 }}>MarginX borrow</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {BORROW_CHOICES.map((b) => (
                <Opt
                  key={b}
                  label={`${b}×`}
                  active={asm.borrow === b}
                  onClick={() => setAsm((a) => ({ ...a, borrow: b }))}
                />
              ))}
            </div>
          </div>
          <div style={{ marginTop: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span style={microLabel}>MarginX loan rate</span>
              <span style={{ fontFamily: MONO, fontSize: 11.5, color: '#67e8f9' }}>{asm.ratePct}%</span>
            </div>
            <input
              type="range"
              min={5}
              max={15}
              step={0.5}
              value={asm.ratePct}
              aria-label="MarginX loan rate"
              onChange={(e) => setAsm((a) => ({ ...a, ratePct: +e.target.value }))}
              className="lp-range"
            />
          </div>
          <div style={{ marginTop: 14 }}>
            <div style={{ ...microLabel, marginBottom: 7 }}>LTP VIP tier</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {TIER_CHOICES.map((t) => (
                <Opt
                  key={t}
                  label={tierLabel(t)}
                  active={asm.tier === t}
                  onClick={() => setAsm((a) => ({ ...a, tier: t }))}
                />
              ))}
            </div>
            <div style={{ marginTop: 7, fontSize: 10.5, lineHeight: 1.6, color: '#5a6273' }}>
              VIP tier fees are for reference and may differ — check with LTP for exact details.
            </div>
          </div>
          <div style={{ marginTop: 14 }}>
            <div style={{ ...microLabel, marginBottom: 7 }}>Perp entry</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {ENTRY_CHOICES.map((c) => (
                <Opt
                  key={c.value}
                  label={c.label}
                  active={asm.entry === c.value}
                  onClick={() => setAsm((a) => ({ ...a, entry: c.value }))}
                />
              ))}
            </div>
          </div>
          {selectedHasDma && (
            <div style={{ marginTop: 14, fontSize: 10.5, lineHeight: 1.6, color: 'rgba(251,191,36,.75)' }}>
              Excludes the cost of maintaining a DMA account (min $2,000 / month) — a perp leg of
              the selected opportunity runs on a DMA account.
            </div>
          )}
        </div>
        <button
          type="button"
          className="lp-btn lp-asm-pill"
          onClick={() => setAsmOpen((v) => !v)}
          style={{
            display: 'inline-flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: '8px 12px',
            maxWidth: 'calc(100vw - 40px)',
            background: 'linear-gradient(180deg, rgba(34,211,238,.1), rgba(13,15,19,.97))',
            border: '1px solid rgba(34,211,238,.45)',
            borderRadius: 999,
            padding: '13px 20px',
            transition: 'border-color .25s, transform .25s',
            boxShadow: '0 12px 36px rgba(0,0,0,.55), 0 0 26px rgba(34,211,238,.14)',
          }}
        >
          <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 3 }}>
            <span style={{ width: 14, height: 2, background: '#67e8f9' }} />
            <span style={{ width: 9, height: 2, background: '#67e8f9' }} />
            <span style={{ width: 12, height: 2, background: '#67e8f9' }} />
          </span>
          <span style={{ fontFamily: MONO, fontSize: 11.5, letterSpacing: '.14em', color: '#67e8f9', fontWeight: 700 }}>
            ASSUMPTIONS
          </span>
          <span style={{ fontFamily: MONO, fontSize: 12.5, color: '#e9ebf0', fontWeight: 600 }}>{asmCompact}</span>
          <span
            style={{
              fontFamily: MONO,
              fontSize: 11,
              color: '#062a33',
              background: '#22d3ee',
              borderRadius: 999,
              padding: '4px 11px',
              fontWeight: 700,
            }}
          >
            {asmOpen ? '− close' : '+ edit'}
          </span>
        </button>
      </div>
    </div>
  );
}
