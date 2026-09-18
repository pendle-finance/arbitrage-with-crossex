/**
 * Live book + market-impact graph for the pair ticket's two perp legs, on ONE
 * shared VERTICAL price axis. Price runs up the y-axis; the two venues are
 * side-by-side columns, so the cross-venue basis reads as the vertical offset
 * between the two mids, and each spread / market-order impact is a vertical
 * extent. Per leg it shows: the two-sided quote (best bid / best ask), the
 * market-order avg fill + a band out to the worst level (tinted by slippage),
 * and — on the maker leg in maker mode — our resting limit price.
 *
 * Direction: the LONG leg BUYs (lifts the ask) so its market fill sits ABOVE
 * the ask; the SHORT leg SELLs (hits the bid) so its fill sits BELOW the bid.
 *
 * Data is entirely client-reachable — book touch (useVenueBook, 2.5s) + a
 * market-impact preview (POST /api/preview, 3s). No full depth ladder, no
 * backend change. Hand-rolled divs with top:${y}% positioning (the WaterfallPlot
 * idiom), but its scale is 0-anchored so this computes its own price domain.
 */
import type { ReactNode } from 'react';
import { useVenueBook } from '../api/queries';
import type { ActionInput, BookTouch, PreviewResult } from '../api/types';
import { FreshnessButton } from '../components/FreshnessIndicator';
import { parseSymbol, prettyVenue, sig } from '../lib/fmt';
import { usePreviewDebounced } from './usePreview';

const isNum = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/** The price axis is at least this fraction of the price wide — a stable, wide
 * scale so a one-tick book move pans smoothly instead of rescaling (flicker). */
const MIN_SPAN_FRAC = 0.0018;

export interface LegImpact {
  venue: string;
  side: 'LONG' | 'SHORT';
  bestBid: number | null;
  bestAsk: number | null;
  mid: number | null;
  avgFill: number | null;
  worst: number | null;
  partialDepth: boolean;
  /** The maker's resting price — only on the maker leg in maker mode. */
  limitPx: number | null;
  /** Resting size (base qty). When set, the limit tag reads "limit <px> × <qty>"
   * instead of the bare "limit" — the deal view has no ticket around it to
   * carry those numbers. */
  limitQty?: string | null;
  /** Optional role line under the venue caption (the deal view names its legs). */
  subLabel?: string;
}

interface Mark {
  price: number;
  yPct: number;
}
interface LegMarks {
  bid: Mark | null;
  ask: Mark | null;
  mid: Mark | null;
  fill: Mark | null;
  worst: Mark | null;
  limit: Mark | null;
  /** Signed against you: positive = adverse (the fill is worse than mid). */
  impactPct: number | null;
  partialDepth: boolean;
}
export interface ImpactScale {
  ticks: { price: number; yPct: number }[];
  long: LegMarks;
  short: LegMarks;
}

/**
 * Build the shared price scale + per-leg marks. Pure — every price across both
 * legs sets the domain, padded so a ~0 basis still renders; `y(price)` is a
 * top-% (higher price → smaller top → higher on screen). Returns null when no
 * finite price exists at all (caller shows a placeholder).
 */
export function assembleImpactMarks(long: LegImpact, short: LegImpact): ImpactScale | null {
  const pricesOf = (l: LegImpact) =>
    [l.bestBid, l.bestAsk, l.mid, l.avgFill, l.worst, l.limitPx].filter(isNum);
  const all = [...pricesOf(long), ...pricesOf(short)];
  if (all.length === 0) return null;

  const rawMin = Math.min(...all);
  const rawMax = Math.max(...all);
  const midPrice = (rawMin + rawMax) / 2;
  // Floor the domain span at a fraction of the price. A liquid pair's marks span
  // ~a tick, so without a floor the axis is so zoomed in that every book tick
  // rescales the whole thing — the flicker. A wide, roughly constant span turns
  // a book move into a small, smooth pan instead. `*1.5` gives headroom when the
  // real span (big basis / high impact) is what dominates.
  const span = Math.max((rawMax - rawMin) * 1.5, Math.abs(midPrice) * MIN_SPAN_FRAC, 1e-9);
  const domainMax = midPrice + span / 2;
  const domainMin = midPrice - span / 2;
  const y = (price: number) => ((domainMax - price) / span) * 100;
  const mark = (price: number | null): Mark | null =>
    isNum(price) ? { price, yPct: y(price) } : null;

  const marksFor = (l: LegImpact): LegMarks => {
    const impactPct =
      isNum(l.avgFill) && isNum(l.mid) && l.mid > 0
        ? ((l.side === 'LONG' ? l.avgFill - l.mid : l.mid - l.avgFill) / l.mid) * 100
        : null;
    return {
      bid: mark(l.bestBid),
      ask: mark(l.bestAsk),
      mid: mark(l.mid),
      fill: mark(l.avgFill),
      worst: mark(l.worst),
      limit: mark(l.limitPx),
      impactPct,
      partialDepth: l.partialDepth,
    };
  };

  return {
    ticks: [
      { price: domainMax, yPct: 0 },
      { price: (domainMax + domainMin) / 2, yPct: 50 },
      { price: domainMin, yPct: 100 },
    ],
    long: marksFor(long),
    short: marksFor(short),
  };
}

/** Slippage-magnitude tone → literal Tailwind classes (dynamic names don't
 * survive Tailwind's scan, so map to constants). Mirrors previewBits'
 * slippageClass thresholds. */
function toneOf(impactPct: number | null): 'emerald' | 'amber' | 'rose' {
  const a = Math.abs(impactPct ?? 0);
  return a < 0.05 ? 'emerald' : a < 0.3 ? 'amber' : 'rose';
}
const TONE: Record<'emerald' | 'amber' | 'rose', { line: string; text: string; shaft: string; headUp: string; headDown: string }> = {
  emerald: { line: 'border-emerald-400', text: 'text-emerald-400', shaft: 'bg-emerald-400', headUp: 'border-b-emerald-400', headDown: 'border-t-emerald-400' },
  amber: { line: 'border-amber-400', text: 'text-amber-400', shaft: 'bg-amber-400', headUp: 'border-b-amber-400', headDown: 'border-t-amber-400' },
  rose: { line: 'border-rose-400', text: 'text-rose-400', shaft: 'bg-rose-400', headUp: 'border-b-rose-400', headDown: 'border-t-rose-400' },
};

/** One horizontal price line across a leg column, with a SHORT tag (no price —
 * the axis gutter and hover titles carry exact numbers). Quote tags (bid/ask) sit on the right,
 * action tags (mkt/limit) on the left: bid≠ask never share a row, and mkt/limit
 * live on different columns, so no two tags ever overprint even when the fill
 * lands on the touch (0 bps) or the limit joins the bid. */
function PriceLine({
  mark,
  tag,
  arrow,
  side,
  dataMark,
  lineClass,
  textClass,
  dim,
  title,
}: {
  mark: Mark;
  tag: string;
  /** A small glyph after the tag — the limit's trade-direction indicator. */
  arrow?: ReactNode;
  side: 'left' | 'right';
  dataMark: string;
  lineClass: string;
  textClass: string;
  dim?: boolean;
  title?: string;
}) {
  const label = (
    <span
      className={`num flex items-center gap-0.5 whitespace-nowrap rounded-sm bg-ink-950/70 px-0.5 text-[9px] leading-none ${textClass} ${dim ? 'opacity-60' : ''}`}
    >
      {tag}
      {arrow}
    </span>
  );
  return (
    <div
      className="absolute inset-x-1 flex -translate-y-1/2 items-center gap-1"
      style={{ top: `${mark.yPct}%` }}
      data-mark={dataMark}
      data-price={mark.price}
      title={title ?? `${tag} ${sig(mark.price)}`}
    >
      {side === 'left' && label}
      <div className={`flex-1 border-t ${lineClass} ${dim ? 'opacity-60' : ''}`} />
      {side === 'right' && label}
    </div>
  );
}

/** The market-order impact, drawn as a vertical arrow from the touch you cross
 * (best bid for a SELL, best ask for a BUY) to the estimated average fill — so
 * its length is the slippage and its head points the way the fill moves (down
 * for a sell, up for a buy). */
function ImpactArrow({
  from,
  to,
  tone,
  dim,
  title,
}: {
  from: Mark;
  to: Mark;
  tone: (typeof TONE)['emerald'];
  dim?: boolean;
  title?: string;
}) {
  const top = Math.min(from.yPct, to.yPct);
  const height = Math.max(Math.abs(from.yPct - to.yPct), 1);
  const down = to.yPct >= from.yPct; // the fill is below the touch → a SELL
  const head = `h-0 w-0 border-x-[3px] border-x-transparent ${dim ? 'opacity-60' : ''}`;
  return (
    <div
      data-mark="impact"
      title={title}
      className="absolute left-[34%] flex w-0 -translate-x-1/2 flex-col items-center"
      style={{ top: `${top}%`, height: `${height}%` }}
    >
      {!down && <div className={`${head} border-b-[5px] ${tone.headUp}`} />}
      <div className={`w-px flex-1 ${tone.shaft} ${dim ? 'opacity-60' : ''}`} />
      {down && <div className={`${head} border-t-[5px] ${tone.headDown}`} />}
    </div>
  );
}

/** One venue column: labeled horizontal price lines on the shared scale —
 * best ask, best bid, and then EITHER the market avg fill (crossing legs, with
 * an impact arrow from the touch to it) OR our resting limit (the maker leg,
 * with a trade-direction arrow). */
function LegColumn({ leg, marks, dim }: { leg: LegImpact; marks: LegMarks; dim: boolean }) {
  const legKey = leg.side === 'LONG' ? 'long' : 'short';
  const tone = TONE[toneOf(marks.impactPct)];
  const isLong = leg.side === 'LONG';
  // The touch a market order crosses: the ask for a BUY, the bid for a SELL.
  const crossTouch = isLong ? marks.ask : marks.bid;
  const spread =
    marks.ask && marks.bid
      ? { top: marks.ask.yPct, height: Math.max(marks.bid.yPct - marks.ask.yPct, 0.4) }
      : null;
  const impactBps = marks.impactPct === null ? '' : `${marks.impactPct >= 0 ? '+' : ''}${Math.round(marks.impactPct * 100)} bps`;
  const fillTitle = `market ${isLong ? 'buy' : 'sell'} avg fill ${marks.fill ? sig(marks.fill.price) : '—'}${
    impactBps ? ` · impact ${impactBps}` : ''
  }${marks.partialDepth ? ' · partial depth (extrapolated)' : ''}`;
  // Trade-direction glyph for the resting limit: BUY (long) is up, SELL down.
  const dirArrow = (
    <span className={isLong ? 'text-emerald-400' : 'text-rose-400'}>{isLong ? '↑' : '↓'}</span>
  );

  return (
    // h-full so the wrapper's h-40 gives the column its height — the marks
    // position by top:% against it (flex-1 would collapse in a block parent).
    <div className="relative h-full" data-leg={legKey}>
      {/* faint shading across the bid–ask spread */}
      {spread && (
        <div
          aria-hidden
          className="absolute inset-x-1 rounded-sm bg-ink-700/25"
          style={{ top: `${spread.top}%`, height: `${spread.height}%` }}
        />
      )}
      {/* market impact: an arrow from the crossed touch to the avg fill */}
      {marks.fill && crossTouch && (
        <ImpactArrow
          from={crossTouch}
          to={marks.fill}
          tone={tone}
          dim={dim}
          title={`${fillTitle} (from ${isLong ? 'ask' : 'bid'} ${sig(crossTouch.price)})`}
        />
      )}

      {/* the two-sided quote — tags on the right */}
      {marks.ask && (
        <PriceLine mark={marks.ask} tag="ask" side="right" dataMark="ask" lineClass="border-ink-300" textClass="text-ink-300" />
      )}
      {marks.bid && (
        <PriceLine mark={marks.bid} tag="bid" side="right" dataMark="bid" lineClass="border-ink-300" textClass="text-ink-300" />
      )}
      {/* the market avg fill (crossing legs) — its impact colors the line */}
      {marks.fill && (
        <PriceLine mark={marks.fill} tag="mkt" side="left" dataMark="fill" lineClass={tone.line} textClass={tone.text} dim={dim} title={fillTitle} />
      )}
      {/* our resting limit (maker leg) — with a trade-direction arrow */}
      {marks.limit && (
        <PriceLine
          mark={marks.limit}
          tag={
            leg.limitQty
              ? `limit ${sig(marks.limit.price)} × ${sig(leg.limitQty)}`
              : 'limit'
          }
          arrow={dirArrow}
          side="left"
          dataMark="limit"
          lineClass="border-cyan-400"
          textClass="text-cyan-300"
          title={
            leg.limitQty
              ? `our resting limit — ${sig(leg.limitQty)} @ ${sig(marks.limit.price)}`
              : undefined
          }
        />
      )}
    </div>
  );
}

/** Presentational — prop-driven, no fetching. */
export function PriceImpactGraph({
  long,
  short,
  updatedAt,
  staleError,
  onRefetch,
  dim = false,
  embedded = false,
}: {
  long: LegImpact;
  short: LegImpact;
  updatedAt: number;
  staleError: boolean;
  onRefetch: () => void;
  /** Dim the impact marks while the preview describes a stale input. */
  dim?: boolean;
  /** Render inside a caller's card: no border, heading or freshness chip of
   * its own — the estimate card around it carries those. */
  embedded?: boolean;
}) {
  const scale = assembleImpactMarks(long, short);

  return (
    <div
      className={
        embedded
          ? 'flex flex-col gap-2'
          : 'flex flex-col gap-2 rounded-lg border border-ink-800 bg-ink-950/60 px-3 py-2'
      }
    >
      {!embedded && (
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-500">
            Book &amp; market impact
          </span>
          <FreshnessButton
            dataUpdatedAt={updatedAt}
            staleError={staleError}
            title="Live venue books — refetch"
            onRefetch={onRefetch}
            dense
          />
        </div>
      )}

      {scale === null ? (
        <div className="py-6 text-center text-[11px] text-ink-500">book &amp; impact unavailable</div>
      ) : (
        <div className="flex gap-1" data-price-graph>
          {/* price axis gutter */}
          <div className="relative w-10 shrink-0">
            <div className="relative h-40">
              {scale.ticks.map((t) => (
                <div
                  key={t.yPct}
                  className="num absolute right-1 -translate-y-1/2 text-[9px] text-ink-400"
                  style={{ top: `${t.yPct}%` }}
                >
                  {sig(t.price)}
                </div>
              ))}
            </div>
          </div>
          {/* the two venue columns on the shared scale, each captioned below */}
          <div className="flex flex-1 gap-2">
            <div className="flex flex-1 flex-col">
              <div className="relative h-40 border-l border-ink-800">
                <LegColumn leg={long} marks={scale.long} dim={dim} />
              </div>
              <div className="truncate pt-0.5 text-center text-[10px] font-medium text-emerald-300" title={`${long.venue} (long)`}>
                {prettyVenue(long.venue)}
              </div>
              {long.subLabel && (
                <div className="truncate text-center text-[9px] text-ink-500">{long.subLabel}</div>
              )}
            </div>
            <div className="flex flex-1 flex-col">
              <div className="relative h-40 border-l border-ink-800">
                <LegColumn leg={short} marks={scale.short} dim={dim} />
              </div>
              <div className="truncate pt-0.5 text-center text-[10px] font-medium text-rose-300" title={`${short.venue} (short)`}>
                {prettyVenue(short.venue)}
              </div>
              {short.subLabel && (
                <div className="truncate text-center text-[9px] text-ink-500">{short.subLabel}</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Container: the live two-sided touch comes from useVenueBook (2.5s); the
 * market-order impact is lifted from the TICKET's own leg previews (positional
 * [long, short]) — so the graph mirrors exactly what the ticket will do (a POC
 * maker leg has no fillEstimate → it shows its resting limit, not a market
 * dot) and adds no extra preview poll. Rendered by PairTicket. */
export function PairBookImpact({
  longSym,
  shortSym,
  notional,
  legLong,
  legShort,
  estimating,
  mode,
  makerLegPick,
  makerPriceStr,
  embedded,
}: {
  longSym: string | null;
  shortSym: string | null;
  notional: string;
  legLong: PreviewResult | undefined;
  legShort: PreviewResult | undefined;
  estimating: boolean;
  mode: 'market' | 'maker';
  makerLegPick: 'long' | 'short';
  makerPriceStr: string;
  /** See PriceImpactGraph.embedded — the pair ticket's estimate card hosts it. */
  embedded?: boolean;
}) {
  const notionalNum = Number(notional);
  const enabled = Boolean(longSym && shortSym && Number.isFinite(notionalNum) && notionalNum > 0);

  const longBook = useVenueBook(longSym, enabled);
  const shortBook = useVenueBook(shortSym, enabled);

  if (!enabled || !longSym || !shortSym) return null;

  const limitOf = (leg: 'long' | 'short'): number | null => {
    if (mode !== 'maker' || makerLegPick !== leg) return null;
    const n = Number(makerPriceStr);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const longFill = legLong?.fillEstimate;
  const shortFill = legShort?.fillEstimate;

  const long: LegImpact = {
    venue: parseSymbol(longSym).exchange,
    side: 'LONG',
    bestBid: longBook.data?.bestBid ?? null,
    bestAsk: longBook.data?.bestAsk ?? null,
    mid: longBook.data?.mid ?? longFill?.midPrice ?? null,
    avgFill: longFill?.avgPrice ?? null,
    worst: longFill?.worstPrice ?? null,
    partialDepth: Boolean(longFill?.partialDepth),
    limitPx: limitOf('long'),
  };
  const short: LegImpact = {
    venue: parseSymbol(shortSym).exchange,
    side: 'SHORT',
    bestBid: shortBook.data?.bestBid ?? null,
    bestAsk: shortBook.data?.bestAsk ?? null,
    mid: shortBook.data?.mid ?? shortFill?.midPrice ?? null,
    avgFill: shortFill?.avgPrice ?? null,
    worst: shortFill?.worstPrice ?? null,
    partialDepth: Boolean(shortFill?.partialDepth),
    limitPx: limitOf('short'),
  };

  const stamps = [longBook.dataUpdatedAt, shortBook.dataUpdatedAt].filter((t) => t > 0);
  const updatedAt = stamps.length ? Math.min(...stamps) : 0;
  const staleError =
    (longBook.isError && longBook.data !== undefined) ||
    (shortBook.isError && shortBook.data !== undefined);

  return (
    <PriceImpactGraph
      long={long}
      short={short}
      updatedAt={updatedAt}
      staleError={staleError}
      dim={estimating}
      embedded={embedded}
      onRefetch={() => {
        void longBook.refetch();
        void shortBook.refetch();
      }}
    />
  );
}

/** Container for the LIVE DEAL view: the maker leg's real-time book with OUR
 * resting limit drawn on it, and the hedge leg's book alongside on the same
 * scale. The hedge column also carries a TENTATIVE market fill — the market
 * order Leg B fires to cover everything Leg A acquires, a live qty-sized
 * preview, the same impact line the pair ticket draws before the deal starts.
 * The maker column deliberately shows NO market estimate: the deal's whole
 * point is resting at the limit. Rendered by DealModal while OPENING. */
export function DealBookImpact({
  makerContract,
  makerSide,
  hedgeContract,
  limitPrice,
  limitQty,
  hedgeQty,
}: {
  makerContract: string;
  makerSide: 'BUY' | 'SELL';
  hedgeContract: string | null;
  /** Our maker price — the LIVE resting order's when open, else the intent. */
  limitPrice: string | null;
  /** The resting order's size (base qty) — labels the limit line. */
  limitQty: string | null;
  /** Everything no hedge order covers yet (target − reserved, base qty) — the
   * market order Leg B fires; sizes the hedge estimate. */
  hedgeQty: string | null;
}) {
  const makerBook = useVenueBook(makerContract, true);
  const hedgeBook = useVenueBook(hedgeContract, hedgeContract !== null);

  // Tentative hedge fill: preview the market order for everything still owed.
  // The fill comes back BY SYMBOL, not by position — around a qty change the
  // debounced query briefly serves the previous response (keepPreviousData).
  const hedgeNum = Number(hedgeQty);
  const actions: ActionInput[] =
    hedgeContract !== null && hedgeQty !== null && Number.isFinite(hedgeNum) && hedgeNum > 0
      ? [
          {
            kind: 'open-market',
            symbol: hedgeContract,
            side: makerSide === 'BUY' ? 'SELL' : 'BUY',
            qty: hedgeQty,
          },
        ]
      : [];
  const preview = usePreviewDebounced('deal-residual', actions, { refetchInterval: 3_000 });
  const hedgeFill =
    actions.length > 0
      ? preview.previews?.find((p) => p.symbol === hedgeContract)?.fillEstimate
      : undefined;

  const limitNum = Number(limitPrice);
  const limitPx = limitPrice !== null && Number.isFinite(limitNum) && limitNum > 0 ? limitNum : null;
  const makerIsLong = makerSide === 'BUY';

  const legFrom = (
    contract: string | null,
    data: BookTouch | undefined,
    side: 'LONG' | 'SHORT',
  ): LegImpact => ({
    venue: contract ? parseSymbol(contract).exchange : '—',
    side,
    bestBid: data?.bestBid ?? null,
    bestAsk: data?.bestAsk ?? null,
    mid: data?.mid ?? null,
    avgFill: null,
    worst: null,
    partialDepth: false,
    limitPx: null,
  });

  const makerLeg: LegImpact = {
    ...legFrom(makerContract, makerBook.data, makerIsLong ? 'LONG' : 'SHORT'),
    limitPx,
    limitQty: limitPx !== null ? limitQty : null,
    subLabel: 'Leg A — limit order',
  };
  // The hedge mid falls back to the preview's reference price (as
  // PairBookImpact does): without it a book outage would draw the fill line
  // with impactPct null — toned the reassuring emerald no matter how hard the
  // fill actually hits.
  const hedgeLeg: LegImpact = {
    ...legFrom(hedgeContract, hedgeBook.data, makerIsLong ? 'SHORT' : 'LONG'),
    mid: hedgeBook.data?.mid ?? hedgeFill?.midPrice ?? null,
    avgFill: hedgeFill?.avgPrice ?? null,
    worst: hedgeFill?.worstPrice ?? null,
    partialDepth: Boolean(hedgeFill?.partialDepth),
    subLabel: 'Leg B — market hedge after every fill',
  };

  const stamps = [makerBook.dataUpdatedAt, hedgeBook.dataUpdatedAt].filter((t) => t > 0);
  const updatedAt = stamps.length ? Math.min(...stamps) : 0;
  const staleError =
    (makerBook.isError && makerBook.data !== undefined) ||
    (hedgeBook.isError && hedgeBook.data !== undefined);

  return (
    <PriceImpactGraph
      long={makerIsLong ? makerLeg : hedgeLeg}
      short={makerIsLong ? hedgeLeg : makerLeg}
      updatedAt={updatedAt}
      staleError={staleError}
      dim={preview.estimating}
      onRefetch={() => {
        void makerBook.refetch();
        void hedgeBook.refetch();
      }}
    />
  );
}
