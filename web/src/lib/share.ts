/** Share-position link, tweet, and X-intent builders. The share URL targets
 * the PUBLIC deployment (hardcoded origin, REPO_URL-style) — never the local
 * terminal, which is loopback-only and useless to anyone else. The payload
 * travels IN the URL (`?d=`): the public box is stateless by design, so the
 * link is the data. */
import { encodeSharePayload, type SharePayloadV1 } from './shareCodec';
import { fmtDateUtc, fmtPct, fmtUsd } from './fmt';

// The DE FACTO public link. The site is HOSTED at
// arbitrage.pendle.finance/crossex, but boros.pendle.finance is the
// user-facing domain we publish, so every shared link uses this form.
// The page itself lives in the arbitrage-landing repo.
export const SHARE_BASE_URL = 'https://boros.pendle.finance/arbitrage-crossex';
export const SHARE_PATH = '/position';

/** Whole days of the strategy's term — clock start to maturity — the
 * "(Z-day term)" on the card. When the open time is unknown (cs null) the
 * snapshot stands in, leaving the days-remaining reading. FLOORED (like the
 * card's own fmtAge), min 1, and derived rather than stored: two fields could
 * disagree. MIRRORED server-side by `termDays` in src/server/position.ts (no
 * cross-tree imports); both trees pin the same day-boundary vectors so the
 * tweet and the link's unfurl can't disagree by a day. */
export function shareTermDays(p: Pick<SharePayloadV1, 'm' | 'cs' | 't'>): number {
  return Math.max(1, Math.floor((p.m - (p.cs ?? p.t)) / 86_400));
}

/** "37-day term" / "1-day term" — labeled, so it can't be misread as days
 * LEFT next to the maturity date (the OG description says the same). */
export function shareDaysText(p: SharePayloadV1): string {
  return `${shareTermDays(p)}-day term`;
}

/** The hedge verdict in words, lowercase for prose; `Sentence` casing for a
 * label. One mapping so the share card and the page can't describe the same
 * `h` differently. (The server's OG description keeps its own copy — no
 * cross-tree imports — and the terminal's HedgeChip is a denser register.) */
export function hedgeLabel(h: SharePayloadV1['h'], sentenceCase = false): string {
  const label = h === 'h' ? 'fully hedged' : h === 'p' ? 'partially hedged' : 'unhedged';
  return sentenceCase ? label[0].toUpperCase() + label.slice(1) : label;
}

export function buildShareUrl(p: SharePayloadV1): string {
  return `${SHARE_BASE_URL}${SHARE_PATH}?d=${encodeSharePayload(p)}`;
}

/** The short form of the same link, from the code the backend minted for this
 * payload (POST /api/share-link). Same page, same data — the code resolves
 * server-side on the public box. The long `?d=` URL stays the fallback: it
 * needs no backend and never expires. */
export function buildShortShareUrl(code: string): string {
  return `${SHARE_BASE_URL}${SHARE_PATH}?s=${code}`;
}

/** Tweet body — kept under 200 chars so the t.co link X appends always fits. */
export function buildTweetText(p: SharePayloadV1): string {
  return (
    `I'm getting ${fmtPct(p.a)} fixed APR on ${fmtUsd(p.c, 0)} capital ` +
    `(${shareDaysText(p)}) — a fully hedged ${p.l.length}-leg ${p.b} position on Boros × Gate CrossEx.`
  );
}

/** Web intents cannot attach an image — the modal says so and offers the PNG
 * for a manual attach in the compose window. `shareUrl` lets the modal pass
 * whichever link it is currently showing (short when minted, long otherwise). */
export function buildXIntentUrl(p: SharePayloadV1, shareUrl?: string): string {
  const text = encodeURIComponent(buildTweetText(p));
  const url = encodeURIComponent(shareUrl ?? buildShareUrl(p));
  return `https://x.com/intent/post?text=${text}&url=${url}`;
}

export function shareFileName(p: SharePayloadV1): string {
  return `crossex-boros-${p.b.toLowerCase()}-${fmtDateUtc(p.m)}.png`;
}
