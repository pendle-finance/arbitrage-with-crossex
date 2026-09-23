import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env, server } from '../test/server';
import { qk, refreshTelegramFresh, useBorosPairContext } from './queries';
import { telegramInfo } from '../test/fixtures';

const ADDRESS = '0x' + 'ab'.repeat(20);

const context = () => ({
  markets: [],
  crossByToken: [],
  isolatedByMarket: [],
  defaultSlippageApr: 0.0025,
  maxSlippageApr: 0.1,
});

function hookWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return wrapper;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('useBorosPairContext', () => {
  it('stops its 15s poll once the ticket is no longer the shown one, and resumes when shown again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let reads = 0;
    server.use(
      http.get('/api/boros/pair/context', () => {
        reads += 1;
        return HttpResponse.json(env(context()));
      }),
    );
    const wrapper = hookWrapper();
    const { result, rerender } = renderHook(({ active }: { active: boolean }) => useBorosPairContext(ADDRESS, active), {
      wrapper,
      initialProps: { active: true },
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(reads).toBe(1);

    rerender({ active: false });
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(reads).toBe(1);

    rerender({ active: true });
    await waitFor(() => expect(reads).toBeGreaterThan(1));
  });
});

describe('refreshTelegramFresh', () => {
  const heldFresh = () => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get('/api/telegram', async ({ request }) => {
        if (new URL(request.url).searchParams.get('fresh') === '1') await held;
        return HttpResponse.json(env(telegramInfo({ connected: true, state: 'connected', unlinkedWallet: '0xabc' })));
      }),
    );
    return () => release();
  };

  it('writes the bot answer when the cache did not change meanwhile', async () => {
    const qc = new QueryClient();
    qc.setQueryData(qk.telegram, telegramInfo({ connected: true, state: 'connected' }));
    const release = heldFresh();
    const done = refreshTelegramFresh(qc);
    release();
    await done;
    expect(qc.getQueryData(qk.telegram)).toMatchObject({ unlinkedWallet: '0xabc' });
  });

  it('drops the bot answer when a newer write landed while it was asked', async () => {
    const qc = new QueryClient();
    qc.setQueryData(qk.telegram, telegramInfo({ connected: true, state: 'connected' }), { updatedAt: 1 });
    const release = heldFresh();
    const done = refreshTelegramFresh(qc);
    const saved = telegramInfo({ connected: true, state: 'connected', lastSyncAt: 42 });
    qc.setQueryData(qk.telegram, saved, { updatedAt: 2 });
    release();
    await done;
    expect(qc.getQueryData(qk.telegram)).toEqual(saved);
  });
});
