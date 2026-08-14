import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import type { PluginOption } from 'vite';
import { defineConfig } from 'vitest/config';

// Vite + Vitest config in one file. The /api proxy targets the Fastify backend
// (built in parallel — see the API contract mirrored in src/api/types.ts).
//
// `vite build --mode landing` builds the public landing site: it swaps in the
// main-landing.tsx entry (whose module graph contains no credentials/trading
// UI), uses a relative base so the bundle is mount-point agnostic, and injects
// the public page metadata. Vitest runs in mode `test`, so tests always see the
// terminal app.

const LANDING_TITLE = 'CrossEx-Boros Terminal — live fixed-rate arbitrage on Boros × Gate CrossEx';
const LANDING_DESCRIPTION =
  'Live delta-neutral funding-rate opportunities between Boros fixed rates and Gate CrossEx perps. ' +
  'A free, open-source terminal by Pendle that runs on your own machine — your keys never leave it.';
// Public canonical URL for the deployed site — supplied at build time
// (`LANDING_URL=https://your-domain yarn build:landing`); no domain is baked in,
// and the canonical/og:url tags are omitted when it is unset.
const LANDING_URL = process.env.LANDING_URL ?? '';
// GA4 measurement id for the PUBLIC site only, supplied at build time
// (`GA_MEASUREMENT_ID=G-XXXXXXXXXX yarn build:landing`). Deliberately scoped to
// the landing plugin: the terminal build runs on the visitor's own machine
// beside their exchange keys and must never phone a third party. Shape-checked
// because it is interpolated straight into a <script> tag.
const GA_ID = /^G-[A-Z0-9]+$/i.test(process.env.GA_MEASUREMENT_ID ?? '')
  ? (process.env.GA_MEASUREMENT_ID as string)
  : '';

function landingHtml(): PluginOption {
  return {
    name: 'landing-html',
    transformIndexHtml: {
      // 'pre' so the entry swap happens before Vite discovers the module graph.
      order: 'pre',
      handler(html: string, ctx: { path: string }) {
        const analytics = GA_ID
          ? [
              `    <script async src="https://www.googletagmanager.com/gtag/js?id=${GA_ID}"></script>`,
              `    <script>`,
              `      window.dataLayer = window.dataLayer || [];`,
              `      function gtag(){dataLayer.push(arguments);}`,
              `      gtag('js', new Date());`,
              `      gtag('config', '${GA_ID}');`,
              `    </script>`,
            ]
          : [];
        // The position entry keeps its title/description/OG in source (between
        // the server's replaceable position-meta markers — see position.html);
        // the build adds only what needs the deployed origin (canonical, og:url,
        // og:image — kept OUTSIDE the marker block so the server's per-request
        // replacement can never destroy them) plus the GA tag. Share-link
        // traffic lands exactly here, so it is measured like the landing.
        if (ctx.path.endsWith('position.html')) {
          const extras = [
            ...(LANDING_URL
              ? [
                  `    <link rel="canonical" href="${LANDING_URL}/position" />`,
                  `    <meta property="og:url" content="${LANDING_URL}/position" />`,
                  `    <meta property="og:image" content="${LANDING_URL}/position-og.png" />`,
                ]
              : []),
            ...analytics,
          ];
          return extras.length ? html.replace('  </head>', [...extras, '  </head>'].join('\n')) : html;
        }
        const canonical = LANDING_URL
          ? [
              `    <link rel="canonical" href="${LANDING_URL}" />`,
              `    <meta property="og:url" content="${LANDING_URL}" />`,
            ]
          : [];
        return html
          .replace('/src/main.tsx', '/src/main-landing.tsx')
          .replace(/<title>.*<\/title>/, `<title>${LANDING_TITLE}</title>`)
          .replace(
            '  </head>',
            [
              `    <meta name="description" content="${LANDING_DESCRIPTION}" />`,
              `    <meta property="og:title" content="${LANDING_TITLE}" />`,
              `    <meta property="og:description" content="${LANDING_DESCRIPTION}" />`,
              `    <meta property="og:type" content="website" />`,
              ...canonical,
              `    <meta name="twitter:card" content="summary" />`,
              ...analytics,
              '  </head>',
            ].join('\n'),
          );
      },
    },
  };
}

// Dev only: the backend requires x-arb-token on /api. The proxy attaches it
// from the same file the backend wrote, so the token never enters the dev
// bundle or the dev page. Read per request: `yarn dev` starts both processes
// at once, so the file may not exist for the first moment — and this way a
// rotated token needs no Vite restart.
const devTokenFile = path.join(
  process.env.DOTENV_CONFIG_PATH
    ? path.dirname(path.resolve(process.env.DOTENV_CONFIG_PATH))
    : fileURLToPath(new URL('..', import.meta.url)),
  'api-token',
);
const readDevToken = (): string | null => {
  try {
    return fs.readFileSync(devTokenFile, 'utf8').trim() || null;
  } catch {
    return null;
  }
};

export default defineConfig(({ mode }) => ({
  base: mode === 'landing' ? './' : '/',
  plugins: [react(), ...(mode === 'landing' ? [landingHtml()] : [])],
  define: mode === 'landing' ? { 'import.meta.env.VITE_LANDING': JSON.stringify('1') } : {},
  // public/ holds landing-only assets (the position OG card) — keep them out
  // of the terminal (money-app) dist entirely.
  publicDir: mode === 'landing' ? 'public' : false,
  // The landing build carries a second HTML entry: the shared-position page.
  // Landing-only — the terminal generates links TO the public deployment, so
  // its own dist has no consumer for the page (and its single-input config
  // stays untouched). Object form so a later entry is a one-line addition.
  build:
    mode === 'landing'
      ? {
          rollupOptions: {
            input: {
              index: fileURLToPath(new URL('./index.html', import.meta.url)),
              position: fileURLToPath(new URL('./position.html', import.meta.url)),
            },
          },
        }
      : {},
  server: {
    // Both overridable so a dev stack can run BESIDE the installed app instead
    // of fighting it for 6688. PORT drives the proxy target too: with a
    // hardcoded target, `PORT=7777 yarn dev` would start a dev API on 7777
    // while this UI kept driving the INSTALLED app on 6688 — i.e. your real
    // money, from a dev build. One variable keeps the two ends together.
    port: Number(process.env.WEB_PORT ?? 8711),
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.PORT ?? 6688}`,
        changeOrigin: false,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            const t = readDevToken();
            if (t) proxyReq.setHeader('x-arb-token', t);
          });
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
}));
