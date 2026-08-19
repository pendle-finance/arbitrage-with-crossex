/**
 * The shared-position page route: OG meta injected from a valid `?d=`, the
 * byte-identical generic fallback for every malformed shape, the XSS walls
 * (schema rejection + entity escaping + splice-not-replace), and the gating
 * facts — served in both modes, never token-gated, absent without the dep.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { encodeSharePayload, type SharePayloadV1 } from '../../src/core/share/codec';
import { requireClients } from '../../src/core/clients';
import { buildApp } from '../../src/server/app';
import { TtlCache } from '../../src/server/cache';
import { renderPositionHtml, termDays } from '../../src/server/position';

const TEMPLATE = `<!doctype html>
<html lang="en" class="dark">
  <head>
    <!-- position-meta -->
    <title>Shared 4-leg hedged position — CrossEx-Boros</title>
    <meta name="description" content="A delta-neutral, fixed-rate 4-leg funding arbitrage position." />
    <meta property="og:title" content="Shared 4-leg hedged position — CrossEx-Boros" />
    <meta property="og:description" content="A delta-neutral, fixed-rate 4-leg funding arbitrage position." />
    <meta property="og:type" content="website" />
    <meta name="twitter:card" content="summary_large_image" />
    <!-- /position-meta -->
    <link rel="canonical" href="https://crossexboros.com/position" />
    <meta property="og:url" content="https://crossexboros.com/position" />
    <meta property="og:image" content="https://crossexboros.com/position-og.png" />
  </head>
  <body><div id="root"></div></body>
</html>
`;

const payload: SharePayloadV1 = {
  v: 1,
  b: 'HYPE',
  t: 1_754_500_000,
  m: 1_758_758_400,
  cs: 1_751_500_000,
  a: 0.1781,
  c: 41_320,
  cp: 33_056,
  cb: 8_264,
  p: 282,
  sp: 0.0295,
  h: 'h',
  ce: 1,
  cx: 1,
  l: [
    { k: 'b', x: 'HYPERLIQUID', s: 'S', n: 158_800, r: 0.0936 },
    { k: 'b', x: 'BYBIT', s: 'L', n: 158_800, r: 0.0229 },
    { k: 'p', x: 'HYPERLIQUID', s: 'S', n: 160_316 },
    { k: 'p', x: 'BYBIT', s: 'L', n: 160_316 },
  ],
  f: { pp: 65.01, ps: 49.16, pb: 3.77, pl: 1.6, fp: 80, fs: 49.16, fb: 10.06 },
};
const validD = encodeSharePayload(payload);

let htmlPath: string;
beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-page-'));
  htmlPath = path.join(dir, 'position.html');
  fs.writeFileSync(htmlPath, TEMPLATE);
});

function makePublicApp(withPage = true): FastifyInstance {
  return buildApp({
    getClients: () => requireClients(null),
    cache: new TtlCache(),
    publicMode: true,
    positionPage: withPage ? { htmlPath } : undefined,
  });
}

describe('termDays — the cross-tree mirror', () => {
  it('matches web/src/lib/share.ts shareTermDays on every day boundary', () => {
    /** Kept BYTE-FOR-BYTE with TERM_DAY_VECTORS in web/src/lib/share.test.ts.
     * The OG description and the tweet quote the same term; no import can span
     * the two trees, so the vectors are the contract. */
    const vectors: Array<[cs: number | null, t: number, m: number, days: number]> = [
      [1_000_000_000, 1_000_100_000, 1_000_000_000 + 14 * 86_400, 14],
      [null, 1_000_000_000, 1_000_000_000 + 12 * 86_400, 12],
      [1_000_000_000, 1_000_000_000, 1_000_000_000 + 14 * 86_400 - 1, 13],
      [1_000_000_000, 1_000_000_000, 1_000_000_000 + 86_400, 1],
      [1_000_000_000, 1_000_000_000, 1_000_000_000 + 3_600, 1],
      [1_000_000_000, 1_000_000_000, 1_000_000_000, 1],
    ];
    for (const [cs, t, m, days] of vectors) {
      expect(termDays({ cs, t, m }), `cs=${cs} t=${t} m=${m}`).toBe(days);
    }
  });
});

describe('renderPositionHtml (pure)', () => {
  it('injects per-position title/description and keeps the block self-contained', () => {
    const html = renderPositionHtml(TEMPLATE, validD);
    expect(html).toContain('<title>HYPE — 17.81% fixed APR on $41,320 · 4-leg hedged position</title>');
    expect(html).toContain('og:title" content="HYPE — 17.81% fixed APR on $41,320');
    // Term days: clock start (cs) → maturity, floored — not time-left at share.
    expect(html).toContain('2.95% spread locked until 2025-09-25 (84-day term)');
    expect(html).toContain('Expected PnL by maturity +$282');
    expect(html).toContain('Hyperliquid / Bybit');
    expect(html).toContain('Self-reported');
    expect(html).toContain('summary_large_image');
    // The '$' in the injected text is inert — index splice, not a replacement
    // string, so there is no `$`-pattern surface at all.
    expect(html).not.toContain('$&');
  });

  it('rewrites canonical/og:url to this exact share, og:image untouched', () => {
    const html = renderPositionHtml(TEMPLATE, validD);
    expect(html).toContain(`<link rel="canonical" href="https://crossexboros.com/position?d=${validD}" />`);
    expect(html).toContain(`<meta property="og:url" content="https://crossexboros.com/position?d=${validD}" />`);
    expect(html).toContain('<meta property="og:image" content="https://crossexboros.com/position-og.png" />');
  });

  it('returns the template byte-identical for every malformed shape', () => {
    const cases: unknown[] = [
      undefined,
      null,
      '',
      ['a', 'b'], // ?d=a&d=b arrives as an array
      'not base64url!!!',
      'x'.repeat(4097),
      Buffer.from('{"v":2,"future":true}').toString('base64url'),
      Buffer.from('{"v":1,"nope":true}').toString('base64url'),
      Buffer.from(JSON.stringify({ ...payload, b: '"><script>alert(1)</script>' })).toString('base64url'),
      Buffer.from(
        JSON.stringify({ ...payload, l: [{ k: 'p', x: '$`$&<img src=x>', s: 'L', n: 1 }] }),
      ).toString('base64url'),
    ];
    for (const d of cases) expect(renderPositionHtml(TEMPLATE, d)).toBe(TEMPLATE);
  });

  it('never emits an unescaped script/quote even for hostile inputs', () => {
    // Every hostile payload is rejected by schema, but pin the outcome anyway:
    // no crafted d may introduce executable HTML.
    const hostile = Buffer.from(
      JSON.stringify({ ...payload, b: '</title><script>alert(1)</script>' }),
    ).toString('base64url');
    const html = renderPositionHtml(TEMPLATE, hostile);
    expect(html).not.toContain('<script>alert');
  });

  it('degrades to the template when the markers are missing (old dist)', () => {
    const bare = '<!doctype html><head><title>x</title></head>';
    expect(renderPositionHtml(bare, validD)).toBe(bare);
  });
});

describe('GET /position', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  it('serves injected HTML to a foreign host in public mode, uncached', async () => {
    app = makePublicApp();
    const res = await app.inject({
      method: 'GET',
      url: `/position?d=${validD}`,
      headers: { host: 'crossexboros.com' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toContain('17.81% fixed APR on $41,320');
  });

  it('serves the generic page when d is missing or invalid — same bytes', async () => {
    app = makePublicApp();
    const bare = await app.inject({ method: 'GET', url: '/position', headers: { host: 'x.com' } });
    const bad = await app.inject({
      method: 'GET',
      url: '/position?d=%25garbage',
      headers: { host: 'x.com' },
    });
    expect(bare.statusCode).toBe(200);
    expect(bare.body).toContain('Shared 4-leg hedged position');
    expect(bad.body).toBe(bare.body);
  });

  it('301s the trailing-slash variant, preserving a charset-safe d only', async () => {
    app = makePublicApp();
    const ok = await app.inject({ method: 'GET', url: `/position/?d=${validD}`, headers: { host: 'x.com' } });
    expect(ok.statusCode).toBe(301);
    expect(ok.headers.location).toBe(`/position?d=${validD}`);
    const evil = await app.inject({
      method: 'GET',
      url: '/position/?d=%22%3E%3Cscript%3E',
      headers: { host: 'x.com' },
    });
    expect(evil.statusCode).toBe(301);
    expect(evil.headers.location).toBe('/position');
    // Charset-safe but over the codec's length cap → dropped too.
    const oversized = await app.inject({
      method: 'GET',
      url: `/position/?d=${'a'.repeat(5000)}`,
      headers: { host: 'x.com' },
    });
    expect(oversized.statusCode).toBe(301);
    expect(oversized.headers.location).toBe('/position');
  });

  it('is served in terminal mode too, and is never token-gated', async () => {
    app = buildApp({
      getClients: () => requireClients(null),
      cache: new TtlCache(),
      authToken: 'a'.repeat(64),
      positionPage: { htmlPath },
    });
    // No x-arb-token header: the gate is scoped to /api/ and must stay so.
    const res = await app.inject({
      method: 'GET',
      url: `/position?d=${validD}`,
      headers: { host: 'localhost:6688' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('17.81%');
    // The terminal-mode Host guard still applies — a foreign host is refused.
    const foreign = await app.inject({
      method: 'GET',
      url: '/position',
      headers: { host: 'evil.example' },
    });
    expect(foreign.statusCode).toBe(403);
  });

  it('404s when the build has no position page (terminal dist)', async () => {
    app = makePublicApp(false);
    const res = await app.inject({ method: 'GET', url: '/position', headers: { host: 'x.com' } });
    expect(res.statusCode).toBe(404);
  });
});
