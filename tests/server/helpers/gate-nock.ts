/**
 * nock helpers for the Gate HTTP seam + a test app factory.
 * Fixtures are RAW snake_case bodies (see tests/fixtures/gate/README.md) — the
 * SDK deserializes them to camelCase, so route tests assert camelCase fields.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { makeClients } from '../../../src/core/clients';
import { buildApp, type AppDeps } from '../../../src/server/app';
import { TtlCache } from '../../../src/server/cache';
import { Store } from '../../../src/engine/db';
import { gateVenue } from '../../../src/engine/venueGate';

const GATE_BASE = 'https://api.gateio.ws';
const API = '/api/v4';
const FIXTURES = path.resolve(__dirname, '../../fixtures/gate');

export const gate = (): nock.Scope => nock(GATE_BASE);

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8')) as T;
}

/** A raw snake_case order payload derived from the filled fixture. */
export function orderBody(over: Record<string, unknown>): Record<string, unknown> {
  return { ...fixture<Record<string, unknown>>('order.filled.json'), ...over };
}

export interface MockOpts {
  /** Query matcher; defaults to `true` (match any query — the SDK signs/serializes its own). */
  query?: Record<string, string | number> | boolean;
  status?: number;
  /** Inline body wins over `fixture`. */
  body?: unknown;
  fixture?: string;
  times?: number;
  /** Request-body matcher for writes. */
  requestBody?: Record<string, unknown>;
}

function mock(method: 'get' | 'post' | 'put' | 'delete', crossexPath: string, opts: MockOpts = {}): nock.Scope {
  const scope = gate();
  const interceptor =
    method === 'get' || method === 'delete'
      ? scope[method](`${API}/crossex${crossexPath}`)
      : scope[method](`${API}/crossex${crossexPath}`, opts.requestBody as nock.RequestBodyMatcher);
  interceptor.query(opts.query ?? true);
  if (opts.times) interceptor.times(opts.times);
  const body = opts.body !== undefined ? opts.body : opts.fixture ? fixture(opts.fixture) : undefined;
  interceptor.reply(opts.status ?? 200, body as nock.Body);
  return scope;
}

export const mockGateGet = (crossexPath: string, opts?: MockOpts): nock.Scope => mock('get', crossexPath, opts);
export const mockGatePost = (crossexPath: string, opts?: MockOpts): nock.Scope => mock('post', crossexPath, opts);
export const mockGateDelete = (crossexPath: string, opts?: MockOpts): nock.Scope => mock('delete', crossexPath, opts);

/**
 * Match an order create by its CLIENT TEXT (the maker-hedge engine's adoption
 * key) and reply with `order_id`; when `snap` is given, also mock the follow-up
 * GET /orders/:id with an orderBody built from it. Collapses the raw
 * `.post('/api/v4/crossex/orders', (b) => …text…)` + snapshot pair the
 * maker-hedge tests repeat everywhere.
 */
export function mockGateCreateByText(
  match: (text: string) => boolean,
  orderId: string,
  snap?: Record<string, unknown>,
): void {
  gate()
    .post(`${API}/crossex/orders`, (b) => match(String((b as Record<string, unknown>).text ?? '')))
    .reply(200, { order_id: orderId });
  if (snap) mockGateGet(`/orders/${orderId}`, { body: orderBody({ order_id: orderId, ...snap }) });
}


export const TEST_TOKEN = 'test-api-token';

/** app.inject() defaults Host to localhost:80, which the origin guard rejects,
 * and carries no API token, which the auth gate rejects — every test request
 * needs both. */
export const HOST = { host: 'localhost:6688', 'x-arb-token': TEST_TOKEN };

export const TEST_KEY = 'testkey12345678';
export const TEST_SECRET = 'testsecret';

export function makeTestApp(overrides?: Partial<AppDeps>): FastifyInstance {
  // Deterministic env for the /api/credentials route (overrides any real .env values).
  process.env.GATE_API_KEY = TEST_KEY;
  process.env.GATE_API_SECRET = TEST_SECRET;
  const getClients = overrides?.getClients ?? (() => makeClients({ key: TEST_KEY, secret: TEST_SECRET }));
  return buildApp({
    getClients,
    cache: new TtlCache(),
    dataDir: overrides?.dataDir ?? mkdtempSync(path.join(tmpdir(), 'app-')),
    authToken: TEST_TOKEN,
    // In-memory engine store per app; the loop is never started here — deal tests
    // drive tickPair() themselves for deterministic engine behavior.
    engine: {
      store: new Store(':memory:'),
      venue: gateVenue(getClients),
      clock: { now: () => Date.now() },
    },
    ...overrides,
  });
}
