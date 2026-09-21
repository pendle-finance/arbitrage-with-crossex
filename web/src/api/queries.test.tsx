import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env, server } from '../test/server';
import { useBorosPairContext } from './queries';

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
