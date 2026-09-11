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
import { fmtDateLocal, fmtPct, fmtTokenQty, fmtUsd, fmtUsdCompact, prettyVenue } from './fmt';
import { hedgeLabel, shareDaysText } from './share';
import type { SharePayloadV1 } from './shareCodec';

/** 16:9 at X's summary_large_image ratio; drawn at `scale`× for crispness. */
export const SHARE_CARD_W = 1200;
export const SHARE_CARD_H = 675;

/* Inter carries the numerals too — the app dropped its mono face, and a share
 * card in a typeface the app no longer uses would read as a different product.
 * Canvas has no `font-variant-numeric`, so digits here are not tabular; the
 * card is a brag image, not a table, so nothing needs to align in a column. */
const SANS = 'Inter, ui-sans-serif, system-ui, sans-serif';

/* Boros design-system tokens, mirroring web/tailwind.config.cjs. Restated as
 * literals because canvas cannot read a CSS variable — keep the two in step. */
const BG = '#0F1421'; // ink-900
const SEPARATOR = '#2B3B55'; // ink-700
const TEXT_HI = '#FFFFFF'; // ink-50
const TEXT_MID = '#BFCBDF'; // ink-100
const TEXT_LOW = '#9DAFCD'; // ink-200
const TEXT_FAINT = '#5B749D'; // ink-400
const GRASS = '#1BE3C2'; // long / positive / APR
const GUAVA = '#FF9393'; // short / negative
const GOLD = '#F0CE74'; // fixed rate, warnings
/* The accent aliases the drawing code below still spells the old way. */
const CYAN = GRASS;
const EMERALD = GRASS;
const ROSE = GUAVA;

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

/**
 * The Boros mark, drawn with paths rather than rasterised from the app's
 * inline SVG: this canvas renders synchronously into a data URL, and an
 * Image() decode is async — a share taken before it resolved would silently
 * ship an unbranded card. Geometry mirrors components/BorosLogo.tsx (its
 * 25.49 x 31.86 bounding box), so the two can't drift.
 *
 * `size` is the mark's drawn HEIGHT; the glyph is taller than it is wide.
 */
function borosMark(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): number {
  const k = size / 31.86; // the SVG's own height, so `size` lands exactly
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(k, k);
  // Upper disc at half opacity, then the stem-mask cutout, then the solid
  // lower disc — the same three shapes, in the same order, as the SVG.
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.beginPath();
  ctx.arc(12.7496, 12.8751, 12.7459, 0, Math.PI * 2);
  ctx.fill();
  // The masked wedge: the full disc clipped to the 6.24→7.81 vertical band,
  // which is what lends the mark its bright stem.
  ctx.save();
  ctx.beginPath();
  ctx.rect(6.24487, 0.852173, 7.80798 - 6.24487, 19.6444 - 0.852173);
  ctx.clip();
  ctx.fillStyle = '#FFFFFF';
  ctx.beginPath();
  ctx.arc(12.7496, 12.8754, 12.7459, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = '#FFFFFF';
  ctx.beginPath();
  ctx.arc(7.01565, 24.9812, 7.01198, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  return 25.4955 * k; // drawn width, for laying out what follows
}

/** Everything the card says — pure, deterministic, pinned by tests. */
export function shareCardLines(p: SharePayloadV1): ShareCardLines {
  const hedge = hedgeLabel(p.h);
  return {
    headline: "I'm getting",
    aprText: fmtPct(p.a),
    headlineTail: 'fixed APR',
    capitalLine: `on ${fmtUsd(p.c, 0)} capital (${shareDaysText(p)})`,
    contextLine: `${p.b} · ${fmtPct(p.sp)} locked spread · matures ${fmtDateLocal(p.m)} · ${hedge}`,
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
    `600 86px ${SANS}`,
    `500 15px ${SANS}`,
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
  ctx.font = `600 12px ${SANS}`;
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
  glow(200, 80, 540, 'rgba(27,227,194,0.10)');
  glow(1030, 610, 500, 'rgba(27,227,194,0.07)');
  roundedRect(ctx, 10, 10, SHARE_CARD_W - 20, SHARE_CARD_H - 20, 20);
  ctx.strokeStyle = 'rgba(27,227,194,0.22)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  const left = 64;
  const right = SHARE_CARD_W - 64;

  // --- header: brand left, base + hedge pills right.
  // Mark -> divider -> two-tone wordmark, the same order and parts as
  // components/BrandMark.tsx: cyan "Arbitrage", neutral "with CrossEx".
  // Keep the two in step.
  // The wordmark's cap-height box (ascent 21 / descent 6 at this size), so
  // the mark and divider centre on the TEXT rather than on its baseline —
  // the app centres the same three parts with flex `items-center`.
  const WORD_TOP = 76 - 21;
  const WORD_BOTTOM = 76 + 6;
  const MARK_H = WORD_BOTTOM - WORD_TOP;
  const markW = borosMark(ctx, left, WORD_TOP, MARK_H);
  const dividerX = left + markW + 16;
  ctx.strokeStyle = '#374B6D'; // ink-600, as the app's divider
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(dividerX, WORD_TOP);
  ctx.lineTo(dividerX, WORD_BOTTOM);
  ctx.stroke();
  const wordX = dividerX + 16;
  ctx.font = `600 26px ${SANS}`;
  ctx.fillStyle = CYAN;
  ctx.fillText('Arbitrage', wordX, 76);
  const arbW = ctx.measureText('Arbitrage').width;
  ctx.fillStyle = TEXT_HI;
  ctx.fillText(' with CrossEx', wordX + arbW, 76);
  const hedgeTone =
    p.h === 'h'
      ? { color: GRASS, bg: 'rgba(27,227,194,0.12)', border: 'rgba(27,227,194,0.35)' }
      : { color: GOLD, bg: 'rgba(240,206,116,0.12)', border: 'rgba(240,206,116,0.35)' };
  const hedgeText = p.h === 'h' ? 'hedged ✓' : lines.hedgeLabel;
  const hedgeW = pill(ctx, { text: hedgeText, centerY: 68, right, ...hedgeTone });
  pill(ctx, {
    text: p.b,
    centerY: 68,
    right: right - hedgeW - 10,
    color: TEXT_MID,
    bg: 'rgba(28,39,64,0.8)',
    border: '#374B6D',
  });

  // --- headline block.
  ctx.fillStyle = TEXT_LOW;
  ctx.font = `500 30px ${SANS}`;
  ctx.fillText(lines.headline, left, 186);
  ctx.fillStyle = CYAN;
  ctx.font = `600 86px ${SANS}`;
  ctx.fillText(lines.aprText, left, 272);
  const aprW = ctx.measureText(lines.aprText).width;
  ctx.fillStyle = TEXT_HI;
  ctx.font = `600 34px ${SANS}`;
  ctx.fillText(lines.headlineTail, left + aprW + 18, 272);
  ctx.fillStyle = TEXT_MID;
  ctx.font = `500 28px ${SANS}`;
  ctx.fillText(lines.capitalLine, left, 320);
  ctx.fillStyle = TEXT_FAINT;
  ctx.font = `500 15px ${SANS}`;
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
      bg: long ? 'rgba(27,227,194,0.12)' : 'rgba(255,147,147,0.12)',
      border: long ? 'rgba(27,227,194,0.35)' : 'rgba(255,147,147,0.35)',
    });
    ctx.textBaseline = 'middle';
    ctx.fillStyle = TEXT_FAINT;
    ctx.font = `500 12px ${SANS}`;
    ctx.fillText(leg.kind.toUpperCase(), left + 96, centerY + 0.5);
    ctx.fillStyle = TEXT_HI;
    ctx.font = `500 21px ${SANS}`;
    ctx.fillText(leg.venue, left + 176, centerY + 0.5);
    ctx.fillStyle = TEXT_LOW;
    ctx.font = `500 17px ${SANS}`;
    ctx.fillText(leg.detail, 620, centerY + 0.5);
    ctx.fillStyle = TEXT_MID;
    ctx.font = `500 21px ${SANS}`;
    ctx.textAlign = 'right';
    ctx.fillText(leg.notional, right, centerY + 0.5);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  });
  if (lines.legOverflow) {
    ctx.fillStyle = TEXT_FAINT;
    ctx.font = `500 13px ${SANS}`;
    ctx.fillText(lines.legOverflow, left, legsTop + lines.legs.length * pitch + 18);
  }

  // --- footer.
  ctx.fillStyle = TEXT_FAINT;
  ctx.font = `400 15px ${SANS}`;
  ctx.fillText(lines.footerLeft, left, 638);
  ctx.font = `600 15px ${SANS}`;
  const brandW = ctx.measureText(lines.footerRightBrand).width;
  ctx.fillStyle = CYAN;
  ctx.fillText(lines.footerRightBrand, right - brandW, 638);
  ctx.fillStyle = TEXT_FAINT;
  ctx.font = `400 15px ${SANS}`;
  const prefixW = ctx.measureText(lines.footerRightPrefix).width;
  ctx.fillText(lines.footerRightPrefix, right - brandW - prefixW - 4, 638);

  return canvas;
}
