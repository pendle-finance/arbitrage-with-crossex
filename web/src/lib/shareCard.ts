/** The share-card PNG renderer — a hand-rolled canvas 2D drawing (house
 * precedent: no chart/image lib) of the "I'm getting X% fixed APR" brag card.
 *
 * Split in two so the words are testable where the pixels aren't:
 *   - `shareCardLines(p)` — pure text assembly, runs in jsdom.
 *   - `renderShareCard(p)` — draws those lines on a canvas; needs a real 2D
 *     context, so it is exercised by eye in the browser, not in CI.
 *
 * The canvas never draws an external image, so it can't be tainted —
 * `toDataURL`/`toBlob` stay available regardless of the Google-Fonts CDN. */
import { fmtDateUtc, fmtPct, fmtTokenQty, fmtUsd, fmtUsdCompact, prettyVenue } from './fmt';
import { hedgeLabel, shareDaysText } from './share';
import type { SharePayloadV1 } from './shareCodec';

/** 16:9 at X's summary_large_image ratio; drawn at `scale`× for crispness. */
export const SHARE_CARD_W = 1200;
export const SHARE_CARD_H = 675;

const MONO = '"JetBrains Mono", ui-monospace, SFMono-Regular, monospace';
const SANS = 'Inter, ui-sans-serif, system-ui, sans-serif';

// The ink palette + accents (web/tailwind.config.cjs / styles.css).
const BG = '#0d0f13'; // ink-900
const SEPARATOR = '#1c2029'; // ink-700
const TEXT_HI = '#e9ebf0'; // ink-100
const TEXT_MID = '#c8ccd6'; // ink-200
const TEXT_LOW = '#8a92a3'; // ink-300
const TEXT_FAINT = '#5a6273'; // ink-400
const CYAN = '#22d3ee';
const EMERALD = '#34d399';
const ROSE = '#fb7185';

export interface ShareCardLeg {
  side: 'LONG' | 'SHORT';
  kind: 'Boros' | 'Perp';
  venue: string;
  /** Boros: "8.12% fixed"; perp: "funding hedge". */
  detail: string;
  notional: string;
}

export interface ShareCardLines {
  headline: string;
  aprText: string;
  headlineTail: string;
  capitalLine: string;
  contextLine: string;
  hedgeLabel: string;
  legs: ShareCardLeg[];
  legOverflow: string | null;
  footerLeft: string;
  footerRightPrefix: string;
  footerRightBrand: string;
}

const MAX_LEG_ROWS = 6;

/** Everything the card says — pure, deterministic, pinned by tests. */
export function shareCardLines(p: SharePayloadV1): ShareCardLines {
  const hedge = hedgeLabel(p.h);
  return {
    headline: "I'm getting",
    aprText: fmtPct(p.a),
    headlineTail: 'fixed APR',
    capitalLine: `on ${fmtUsd(p.c, 0)} capital (${shareDaysText(p)})`,
    contextLine: `${p.b} · ${fmtPct(p.sp)} locked spread · matures ${fmtDateUtc(p.m)} · ${hedge}`,
    hedgeLabel: hedge,
    legs: p.l.slice(0, MAX_LEG_ROWS).map((l) => ({
      side: l.s === 'S' ? 'SHORT' : 'LONG',
      kind: l.k === 'b' ? 'Boros' : 'Perp',
      venue: prettyVenue(l.x),
      detail: l.k === 'b' ? (l.r !== undefined ? `${fmtPct(l.r)} fixed` : 'rate leg') : 'funding hedge',
      notional:
        l.tn !== undefined && l.ts !== undefined
          ? `${fmtUsdCompact(l.n)} (${fmtTokenQty(l.tn, l.ts)})`
          : fmtUsdCompact(l.n),
    })),
    legOverflow: p.l.length > MAX_LEG_ROWS ? `+${p.l.length - MAX_LEG_ROWS} more legs` : null,
    footerLeft: 'Powered by Boros × Gate CrossEx',
    footerRightPrefix: 'Executed with the open-source tool at ',
    footerRightBrand: 'boros.pendle.finance/arbitrage-crossex',
  };
}

/** Wait for the two webfonts, but never block the share on a slow CDN — after
 * 3s the fallback stacks draw instead. jsdom has no document.fonts: skipped. */
async function ensureFonts(): Promise<void> {
  const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
  if (!fonts?.load) return;
  const wanted = [
    `600 86px ${MONO}`,
    `500 15px ${MONO}`,
    `500 30px ${SANS}`,
    `600 34px ${SANS}`,
    `500 21px ${SANS}`,
  ];
  await Promise.race([
    Promise.all(wanted.map((f) => fonts.load(f))).then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 3000)),
  ]);
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Small bordered pill with centered text; returns its width. When `right` is
 * given the pill is laid out ending at that x (right-aligned). */
function pill(
  ctx: CanvasRenderingContext2D,
  opts: { text: string; centerY: number; left?: number; right?: number; color: string; bg: string; border: string },
): number {
  ctx.font = `600 12px ${MONO}`;
  const w = Math.ceil(ctx.measureText(opts.text).width) + 24;
  const h = 26;
  const x = opts.right !== undefined ? opts.right - w : (opts.left ?? 0);
  const y = opts.centerY - h / 2;
  roundedRect(ctx, x, y, w, h, h / 2);
  ctx.fillStyle = opts.bg;
  ctx.fill();
  ctx.strokeStyle = opts.border;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = opts.color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(opts.text, x + w / 2, opts.centerY + 0.5);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  return w;
}

/** Draw the card. `scale` 2 → a 2400×1350 PNG (crisp when X downscales). */
export async function renderShareCard(p: SharePayloadV1, scale = 2): Promise<HTMLCanvasElement> {
  await ensureFonts();
  const lines = shareCardLines(p);
  const canvas = document.createElement('canvas');
  canvas.width = SHARE_CARD_W * scale;
  canvas.height = SHARE_CARD_H * scale;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');
  ctx.scale(scale, scale);

  // --- background: ink-900 + the app's signature cyan/emerald radial glows.
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, SHARE_CARD_W, SHARE_CARD_H);
  const glow = (cx: number, cy: number, r: number, rgba: string) => {
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, rgba);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, SHARE_CARD_W, SHARE_CARD_H);
  };
  glow(200, 80, 540, 'rgba(34,211,238,0.10)');
  glow(1030, 610, 500, 'rgba(52,211,153,0.07)');
  roundedRect(ctx, 10, 10, SHARE_CARD_W - 20, SHARE_CARD_H - 20, 20);
  ctx.strokeStyle = 'rgba(34,211,238,0.22)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  const left = 64;
  const right = SHARE_CARD_W - 64;

  // --- header: wordmark left, base + hedge pills right.
  // Two-tone wordmark, mirroring components/BrandMark.tsx: cyan "Arbitrage",
  // neutral "with CrossEx". Keep the two in step.
  ctx.font = `600 26px ${SANS}`;
  ctx.fillStyle = CYAN;
  ctx.fillText('Arbitrage', left, 76);
  const arbW = ctx.measureText('Arbitrage').width;
  ctx.fillStyle = TEXT_HI;
  ctx.fillText(' with CrossEx', left + arbW, 76);
  const hedgeTone =
    p.h === 'h'
      ? { color: EMERALD, bg: 'rgba(52,211,153,0.12)', border: 'rgba(52,211,153,0.35)' }
      : { color: '#fbbf24', bg: 'rgba(251,191,36,0.12)', border: 'rgba(251,191,36,0.35)' };
  const hedgeText = p.h === 'h' ? 'hedged ✓' : lines.hedgeLabel;
  const hedgeW = pill(ctx, { text: hedgeText, centerY: 68, right, ...hedgeTone });
  pill(ctx, {
    text: p.b,
    centerY: 68,
    right: right - hedgeW - 10,
    color: TEXT_MID,
    bg: 'rgba(28,32,41,0.8)',
    border: '#262b37',
  });

  // --- headline block.
  ctx.fillStyle = TEXT_LOW;
  ctx.font = `500 30px ${SANS}`;
  ctx.fillText(lines.headline, left, 186);
  ctx.fillStyle = CYAN;
  ctx.font = `600 86px ${MONO}`;
  ctx.fillText(lines.aprText, left, 272);
  const aprW = ctx.measureText(lines.aprText).width;
  ctx.fillStyle = TEXT_HI;
  ctx.font = `600 34px ${SANS}`;
  ctx.fillText(lines.headlineTail, left + aprW + 18, 272);
  ctx.fillStyle = TEXT_MID;
  ctx.font = `500 28px ${SANS}`;
  ctx.fillText(lines.capitalLine, left, 320);
  ctx.fillStyle = TEXT_FAINT;
  ctx.font = `500 15px ${MONO}`;
  ctx.fillText(lines.contextLine, left, 356);

  // --- leg rows on separator lines.
  const legsTop = 388;
  const legsBottom = 604;
  const pitch = Math.min(54, Math.floor((legsBottom - legsTop) / Math.max(1, lines.legs.length)));
  lines.legs.forEach((leg, i) => {
    const rowTop = legsTop + i * pitch;
    const centerY = rowTop + pitch / 2;
    if (i > 0) {
      ctx.strokeStyle = SEPARATOR;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(left, rowTop);
      ctx.lineTo(right, rowTop);
      ctx.stroke();
    }
    const long = leg.side === 'LONG';
    pill(ctx, {
      text: leg.side,
      centerY,
      left,
      color: long ? EMERALD : ROSE,
      bg: long ? 'rgba(52,211,153,0.12)' : 'rgba(251,113,133,0.12)',
      border: long ? 'rgba(52,211,153,0.35)' : 'rgba(251,113,133,0.35)',
    });
    ctx.textBaseline = 'middle';
    ctx.fillStyle = TEXT_FAINT;
    ctx.font = `500 12px ${MONO}`;
    ctx.fillText(leg.kind.toUpperCase(), left + 96, centerY + 0.5);
    ctx.fillStyle = TEXT_HI;
    ctx.font = `500 21px ${SANS}`;
    ctx.fillText(leg.venue, left + 176, centerY + 0.5);
    ctx.fillStyle = TEXT_LOW;
    ctx.font = `500 17px ${MONO}`;
    ctx.fillText(leg.detail, 620, centerY + 0.5);
    ctx.fillStyle = TEXT_MID;
    ctx.font = `500 21px ${MONO}`;
    ctx.textAlign = 'right';
    ctx.fillText(leg.notional, right, centerY + 0.5);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  });
  if (lines.legOverflow) {
    ctx.fillStyle = TEXT_FAINT;
    ctx.font = `500 13px ${MONO}`;
    ctx.fillText(lines.legOverflow, left, legsTop + lines.legs.length * pitch + 18);
  }

  // --- footer.
  ctx.fillStyle = TEXT_FAINT;
  ctx.font = `400 15px ${SANS}`;
  ctx.fillText(lines.footerLeft, left, 638);
  ctx.font = `600 15px ${MONO}`;
  const brandW = ctx.measureText(lines.footerRightBrand).width;
  ctx.fillStyle = CYAN;
  ctx.fillText(lines.footerRightBrand, right - brandW, 638);
  ctx.fillStyle = TEXT_FAINT;
  ctx.font = `400 15px ${SANS}`;
  const prefixW = ctx.measureText(lines.footerRightPrefix).width;
  ctx.fillText(lines.footerRightPrefix, right - brandW - prefixW - 4, 638);

  return canvas;
}
