/**
 * The public shared-position page (`/position?d=<payload>`), with per-position
 * OG meta injected server-side.
 *
 * The `?d=` payload is untrusted input on a public origin, so the pipeline is
 * reject-don't-sanitize: the codec's strict schema (charset-limited strings,
 * range-clamped finite numbers, unknown keys rejected) either yields a payload
 * whose every string is inert, or the template ships with its generic meta
 * untouched. Injected values are entity-escaped anyway (defense in depth), and
 * the marker block is replaced by index-splicing — never by a replacement
 * STRING, whose `$`-patterns would let a payload splice arbitrary HTML (the
 * spa.ts replaceAll is safe only because its token is hex; this input is not).
 * The route does no I/O derived from the payload: og:image stays the fixed
 * build-time URL. `d` does land in access logs — acceptable: the sharer chose
 * to publish exactly these numbers, and the schema admits nothing else.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { decodeSharePayload, MAX_SHARE_PARAM_LENGTH, type SharePayloadV1 } from '../core/share/codec';

const META_START = '<!-- position-meta -->';
const META_END = '<!-- /position-meta -->';
const TITLE_MAX = 120;
const DESC_MAX = 300;

/** Entity-escape for HTML text and double-quoted attribute contexts, plus a
 * C0-control strip. Validation upstream already makes inputs inert — this is
 * the second wall. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/[\u0000-\u001f\u007f]/g, '');
}

// Tiny local formatters mirroring web/src/lib/fmt.ts semantics (fmtPct /
// fmtUsd at 0dp / fmtDateUtc / prettyVenue) — src/core/numbers.ts has no
// display formatters, and the web tree is not importable from here.
const pct = (ratio: number): string =>
  `${(ratio * 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
const usd = (n: number): string =>
  `${n < 0 ? '-' : ''}$${Math.round(Math.abs(n)).toLocaleString('en-US')}`;
const signedUsd = (n: number): string => `${n > 0 ? '+' : ''}${usd(n)}`;
const dateUtc = (unixSec: number): string => new Date(unixSec * 1000).toISOString().slice(0, 10);
const clamp = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** Strategy term in whole days (clock start → maturity; the snapshot stands in
 * when the open time is unknown), FLOORED, min 1. A MIRROR of
 * web/src/lib/share.ts `shareTermDays` — the tweet and the unfurl must not
 * disagree by a day, so both trees pin the same vectors (see the "day
 * boundaries" cases in tests/server/position-page.test.ts and
 * web/src/lib/share.test.ts). Exported for exactly that pin. */
export function termDays(p: Pick<SharePayloadV1, 'm' | 'cs' | 't'>): number {
  return Math.max(1, Math.floor((p.m - (p.cs ?? p.t)) / 86_400));
}

function metaBlock(p: SharePayloadV1): string {
  const daysText = `${termDays(p)}-day term`;
  const venues = [...new Set(p.l.map((l) => l.x))]
    .map((v) => (v.length <= 3 ? v : v.charAt(0) + v.slice(1).toLowerCase()))
    .join(' / ');
  const hedge = p.h === 'h' ? 'hedged' : p.h === 'p' ? 'partially hedged' : 'unhedged';
  const title = clamp(
    `${p.b} — ${pct(p.a)} fixed APR on ${usd(p.c)} · ${p.l.length}-leg ${hedge} position`,
    TITLE_MAX,
  );
  const desc = clamp(
    `${pct(p.sp)} spread locked until ${dateUtc(p.m)} (${daysText}). ` +
      `Expected PnL by maturity ${signedUsd(p.p)}. Boros rate legs + hedged perps on ${venues}, ` +
      `delta-neutral via Gate CrossEx. Self-reported — shared from the open-source CrossEx-Boros terminal.`,
    DESC_MAX,
  );
  const t = escapeHtml(title);
  const d = escapeHtml(desc);
  // Self-contained: the whole marker block is replaced, so everything the
  // generic block declared must be re-emitted here.
  return [
    META_START,
    `    <title>${t}</title>`,
    `    <meta name="description" content="${d}" />`,
    `    <meta property="og:title" content="${t}" />`,
    `    <meta property="og:description" content="${d}" />`,
    `    <meta property="og:type" content="website" />`,
    `    <meta name="twitter:card" content="summary_large_image" />`,
    `    ${META_END}`,
  ].join('\n');
}

/** Pure transform: position.html template + raw `?d=` → the HTML to serve.
 * Every failure path returns the template byte-identical (generic meta). */
export function renderPositionHtml(template: string, rawD: unknown): string {
  const dec = decodeSharePayload(rawD);
  if (!dec.ok) return template;
  const start = template.indexOf(META_START);
  const end = template.indexOf(META_END);
  // A dist built before the markers existed degrades to its generic meta —
  // same contract as spa.ts: an old build must degrade to "works".
  if (start === -1 || end === -1 || end < start) return template;

  let html =
    template.slice(0, start) + metaBlock(dec.payload) + template.slice(end + META_END.length);

  // The build baked absolute canonical/og:url tags (origin known only at build
  // time — the server needs no domain config); point them at THIS share. The
  // decode succeeded, so rawD is pure base64url — still escaped, still spliced
  // via a function replacement (no `$`-pattern surface).
  // Capture only up to the closing quote — the tag's tail (` />` vs `/>`) is
  // the HTML transformer's business, and pinning it here would break silently
  // the day Vite reformats its injected tags.
  const withD = (url: string): string => `${url}?d=${escapeHtml(String(rawD))}`;
  html = html.replace(
    /(<link rel="canonical" href=")([^"]*\/position)(")/,
    (_m, pre: string, url: string, post: string) => pre + withD(url) + post,
  );
  html = html.replace(
    /(<meta property="og:url" content=")([^"]*\/position)(")/,
    (_m, pre: string, url: string, post: string) => pre + withD(url) + post,
  );
  return html;
}

/** Mount `GET /position` (+ the trailing-slash 301 that the landing build's
 * relative `./assets` base makes mandatory). Registered in BOTH public and
 * terminal mode — the route reads one local file and interpolates validated
 * text; having it locally lets `curl localhost:6688/position?d=…` exercise the
 * real injection path before any deploy. */
export function registerPositionPage(app: FastifyInstance, htmlPath: string): void {
  // Read per request, no cache: the file is ~2KB behind nginx's 5r/s limit, and
  // a cached copy would keep serving a torn-down dist under `tsx watch` dev
  // (deploys restart the container, dev rebuilds don't restart the server).
  const REDIRECT_D_RE = new RegExp(`^[A-Za-z0-9_-]{1,${MAX_SHARE_PARAM_LENGTH}}$`);

  app.get('/position', async (req, reply) => {
    let template: string;
    try {
      template = fs.readFileSync(path.resolve(htmlPath), 'utf8');
    } catch {
      return reply.code(404).send({ ok: false, error: { category: 'not-found', message: 'no position page in this build' } });
    }
    const d = (req.query as Record<string, unknown> | null)?.d;
    return reply
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(renderPositionHtml(template, d));
  });

  app.get('/position/', async (req, reply) => {
    const d = (req.query as Record<string, unknown> | null)?.d;
    // Propagate only a charset-safe, length-capped d — anything else redirects
    // to the bare page, which then serves its generic meta / error card.
    const query = typeof d === 'string' && REDIRECT_D_RE.test(d) ? `?d=${d}` : '';
    return reply.redirect(`/position${query}`, 301);
  });
}
