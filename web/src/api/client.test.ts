/**
 * The local terminal learns its bearer only from an installed-launcher
 * fragment, validates it, then uses origin-scoped storage on later reloads.
 * Public/dev pages and foreign origins must never send a token.
 */
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrapApiToken, fetchJson } from './client';
import { env, server } from '../test/server';

const TOKEN = 'a'.repeat(64);
const OLD_TOKEN = 'b'.repeat(64);

function memoryStorage(initial?: string) {
  const values = new Map<string, string>();
  if (initial) values.set('arb-api-token', initial);
  return {
    values,
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    },
  };
}

async function tokenSent(request = fetchJson): Promise<string | null> {
  let seen: string | null = null;
  server.use(
    http.get('/api/health', ({ request: apiRequest }) => {
      seen = apiRequest.headers.get('x-arb-token');
      return HttpResponse.json(env({ status: 'ok' }));
    }),
  );
  await request('/health');
  return seen;
}

afterEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, '', '/');
  vi.restoreAllMocks();
});

describe('launcher token bootstrap', () => {
  it('scrubs, validates, and persists an exact local fragment before using it', async () => {
    const events: string[] = [];
    const { storage, values } = memoryStorage();

    const result = await bootstrapApiToken({
      hostname: 'localhost',
      hash: `#token=${TOKEN}`,
      storage,
      clearFragment: () => events.push('cleared'),
      validate: async (candidate) => {
        events.push(`validated:${candidate}`);
        return true;
      },
    });

    expect(events).toEqual(['cleared', `validated:${TOKEN}`]);
    expect(result).toBe(TOKEN);
    expect(values.get('arb-api-token')).toBe(TOKEN);
  });

  it.each([
    ['too short', '#token=abc'],
    ['uppercase', `#token=${'A'.repeat(64)}`],
    ['extra fields', `#token=${TOKEN}&next=/`],
    ['encoded text', `#token=${'%61'.repeat(64)}`],
  ])('rejects a %s token fragment without validating it', async (_label, hash) => {
    const validate = vi.fn(async () => true);
    const clearFragment = vi.fn();
    const { storage, values } = memoryStorage();

    expect(await bootstrapApiToken({
      hostname: '127.0.0.1',
      hash,
      storage,
      clearFragment,
      validate,
    })).toBeNull();

    expect(clearFragment).toHaveBeenCalledOnce();
    expect(validate).not.toHaveBeenCalled();
    expect(values.size).toBe(0);
  });

  it('preserves a previously validated token when a new candidate fails', async () => {
    const { storage, values } = memoryStorage(OLD_TOKEN);

    expect(await bootstrapApiToken({
      hostname: 'localhost',
      hash: `#token=${TOKEN}`,
      storage,
      clearFragment: vi.fn(),
      validate: async () => false,
    })).toBe(OLD_TOKEN);

    expect(values.get('arb-api-token')).toBe(OLD_TOKEN);
  });

  it('scrubs but never validates, stores, or returns a bearer on a foreign origin', async () => {
    const validate = vi.fn(async () => true);
    const clearFragment = vi.fn();
    const { storage, values } = memoryStorage(OLD_TOKEN);

    expect(await bootstrapApiToken({
      hostname: 'terminal.example.com',
      hash: `#token=${TOKEN}`,
      storage,
      clearFragment,
      validate,
    })).toBeNull();

    expect(clearFragment).toHaveBeenCalledOnce();
    expect(validate).not.toHaveBeenCalled();
    expect(values.get('arb-api-token')).toBe(OLD_TOKEN);
  });

  it('validates against protected GET /api/credentials before sending the bearer', async () => {
    let validationMethod: string | null = null;
    let validationToken: string | null = null;
    let validationCredentials: RequestCredentials | null = null;
    server.use(
      http.get('/api/credentials', ({ request }) => {
        validationMethod = request.method;
        validationToken = request.headers.get('x-arb-token');
        validationCredentials = request.credentials;
        return HttpResponse.json(env({ configured: false, keyMasked: null }));
      }),
    );
    window.history.replaceState({}, '', `/#token=${TOKEN}`);

    // This test intentionally reloads the known module: fragment consumption is
    // a module-start boundary and cannot be exercised through the static import.
    vi.resetModules();
    const freshClient = await import('./client');
    expect(window.location.hash).toBe('');
    expect(await tokenSent(freshClient.fetchJson)).toBe(TOKEN);
    expect(validationMethod).toBe('GET');
    expect(validationToken).toBe(TOKEN);
    expect(validationCredentials).toBe('omit');
    expect(window.localStorage.getItem('arb-api-token')).toBe(TOKEN);
  });
});

describe('fetchJson auth header', () => {
  it('uses validated origin-and-port storage on an ordinary reload', async () => {
    window.localStorage.setItem('arb-api-token', TOKEN);
    expect(await tokenSent()).toBe(TOKEN);
  });

  it('sends nothing when the page has no validated local token', async () => {
    expect(await tokenSent()).toBeNull();
  });

  it('never enables ambient cookie credentials, even when a caller requests them', async () => {
    let credentials: RequestCredentials | null = null;
    server.use(
      http.get('/api/health', ({ request }) => {
        credentials = request.credentials;
        return HttpResponse.json(env({ status: 'ok' }));
      }),
    );

    await fetchJson('/health', { credentials: 'include' });
    expect(credentials).toBe('omit');
  });
});
