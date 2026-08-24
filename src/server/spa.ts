/**
 * Register the public SPA shell without injecting install credentials.
 *
 * GET / and /index.html must remain unauthenticated so the browser can load.
 * The installed launcher transfers the API token in a URL fragment instead;
 * fragments are not sent in HTTP requests.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export function registerSpaShell(app: FastifyInstance, webDist: string): void {
  const html = fs.readFileSync(path.join(webDist, 'index.html'), 'utf8');
  const serveIndex = async (_request: FastifyRequest, reply: FastifyReply) =>
    reply
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(html);

  // @fastify/static registers only a wildcard, so these explicit routes win.
  app.get('/', serveIndex);
  app.get('/index.html', serveIndex);
}
