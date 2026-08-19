import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Vite + Vitest config in one file. The /api proxy targets the Fastify backend
// (built in parallel — see the API contract mirrored in src/api/types.ts).
//
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

export default defineConfig(() => ({
  base: '/',
  plugins: [react()],
  // No publicDir: the terminal ships no static marketing assets. The public
  // site and its OG cards live in the arbitrage-landing repo.
  publicDir: false,
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
