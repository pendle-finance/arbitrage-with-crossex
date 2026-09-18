import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, renderHook, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import {
  useAssetView,
  useAssetViewWindows,
  useDisconnectTelegram,
  useStartTelegramLink,
  useTelegram,
  useTelegramLink,
  useTelegramSettings,
} from './api/queries';
import type { OpenOrder, TelegramLinkStatus, TradesResponse, VenueFees } from './api/types';
import { ACTIVE_TAB_KEY, TAB_IDS, type TabId } from './components/TabBar';
import { STRATEGY_STORAGE_KEY } from './panels/HomeControls';
import { assetView, baseHandlers, makeOpportunitiesResult, opportunitiesHandler, telegramInfo } from './test/fixtures';
import { env, server } from './test/server';
import { renderWithClient } from './test/utils';

const ADDRESS = '0x' + 'cd'.repeat(20);
const ASSET_VIEW_PATH = `/api/asset-view/${ADDRESS}`;

const TAB_POLLS: Record<TabId, readonly string[]> = {
  opportunities: ['/api/opportunities'],
  positions: [ASSET_VIEW_PATH],
  balances: ['/api/transfer'],
  orders: [],
  trades: ['/api/trades'],
  fees: [],
};

const HEADER_POLLS = ['/api/account', '/api/positions', '/api/orders/open', '/api/rebalance', '/api/alerts'];

const telegramOff = telegramInfo();

let hits: string[] = [];

function recordRequests() {
  hits = [];
  server.events.on('request:start', ({ request }) => {
    hits.push(new URL(request.url).pathname);
  });
}

const count = (path: string) => hits.filter((p) => p === path).length;

function mockApp() {
  server.use(
    http.get('/api/credentials', () => HttpResponse.json(env({ configured: true, keyMasked: 'gk_****abcd' }))),
    ...baseHandlers(),
    opportunitiesHandler(makeOpportunitiesResult()),
    http.get('/api/orders/open', () => HttpResponse.json(env<OpenOrder[]>([]))),
    http.get('/api/trades', () =>
      HttpResponse.json(env<TradesResponse>({ trades: [], page: 1, limit: 100, hasMore: false })),
    ),
    http.get('/api/fees', () => HttpResponse.json(env<VenueFees[]>([]))),
    http.get('/api/baskets', () => HttpResponse.json(env([]))),
    http.get('/api/asset-view/:address', () => HttpResponse.json(env(assetView))),
  );
}

const SWITCHES: [TabId, TabId][] = TAB_IDS.map((id, i) => [id, TAB_IDS[(i + 1) % TAB_IDS.length]]);

function expectOnlyShownTabPolls(shown: TabId) {
  TAB_IDS.filter((id) => id !== shown).forEach((hidden) =>
    TAB_POLLS[hidden].forEach((path) => expect(count(path), `${hidden} ${path}`).toBe(0)),
  );
  TAB_POLLS[shown].forEach((path) => expect(count(path), path).toBeGreaterThan(0));
  HEADER_POLLS.forEach((path) => expect(count(path), path).toBeGreaterThan(0));
}

function selectTab(id: TabId) {
  fireEvent.click(document.getElementById(`tab-${id}`)!);
}

afterEach(() => {
  server.events.removeAllListeners();
  vi.useRealTimers();
});

describe('hidden tabs do not poll', () => {
  it.each(SWITCHES)(
    'hidden tabs do not poll: %s polls while shown, then stops for 60 s behind %s',
    async (shown, next) => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      localStorage.setItem(STRATEGY_STORAGE_KEY, JSON.stringify({ address: ADDRESS }));
      localStorage.setItem(ACTIVE_TAB_KEY, JSON.stringify(shown));
      mockApp();
      recordRequests();
      renderWithClient(<App />);
      await screen.findByRole('tablist', { name: 'Sections' });
      const everyTabPoll = TAB_IDS.flatMap((id) => TAB_POLLS[id]);
      await waitFor(() => everyTabPoll.forEach((path) => expect(count(path)).toBeGreaterThan(0)));

      hits = [];
      await act(() => vi.advanceTimersByTimeAsync(60_000));
      expectOnlyShownTabPolls(shown);

      selectTab(next);
      hits = [];
      await act(() => vi.advanceTimersByTimeAsync(60_000));
      expectOnlyShownTabPolls(next);
    },
    30_000,
  );

  it('a tab shown again reads once at once, without waiting for its interval', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    localStorage.setItem(STRATEGY_STORAGE_KEY, JSON.stringify({ address: ADDRESS }));
    localStorage.setItem(ACTIVE_TAB_KEY, JSON.stringify('positions'));
    mockApp();
    recordRequests();
    renderWithClient(<App />);
    await screen.findByRole('tablist', { name: 'Sections' });
    await waitFor(() => expect(count(ASSET_VIEW_PATH)).toBeGreaterThan(0));

    selectTab('trades');
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    hits = [];
    selectTab('positions');
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(count(ASSET_VIEW_PATH)).toBe(1);
  }, 30_000);
});

function hookWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

describe('asset view since', () => {
  it('no date sends no since, and 0 still sends since=0', async () => {
    const searches: string[] = [];
    server.use(
      http.get('/api/asset-view/:address', ({ request }) => {
        searches.push(new URL(request.url).search);
        return HttpResponse.json(env(assetView));
      }),
    );
    const { client, wrapper } = hookWrapper();
    const byDefault = renderHook(() => useAssetView(ADDRESS), { wrapper });
    const allTime = renderHook(() => useAssetView(ADDRESS, 0), { wrapper });
    await waitFor(() => expect(byDefault.result.current.isSuccess && allTime.result.current.isSuccess).toBe(true));
    expect(searches.sort()).toEqual(['', '?since=0']);
    expect(client.getQueryCache().findAll({ queryKey: ['assetView'] })).toHaveLength(2);
  });

  it('windows keep the default date apart from all time', async () => {
    const searches: string[] = [];
    server.use(
      http.get('/api/asset-view/:address', ({ request }) => {
        const search = new URL(request.url).search;
        searches.push(search);
        return HttpResponse.json(env({ ...assetView, sinceSec: search === '' ? 1_750_000_000 : 0 }));
      }),
    );
    const { wrapper } = hookWrapper();
    const { result } = renderHook(() => useAssetViewWindows(ADDRESS, [0, undefined, 1_760_000_000, undefined]), {
      wrapper,
    });
    await waitFor(() => expect(result.current.bySince.size).toBe(3));
    expect(searches.sort()).toEqual(['', '?since=0', '?since=1760000000']);
    expect(result.current.bySince.get(undefined)?.sinceSec).toBe(1_750_000_000);
    expect(result.current.bySince.get(0)?.sinceSec).toBe(0);
  });
});

describe('telegram hooks', () => {
  it('reads the connection and refreshes it after a link starts', async () => {
    let reads = 0;
    server.use(
      http.get('/api/telegram', () => {
        reads += 1;
        return HttpResponse.json(env(telegramOff));
      }),
      http.post('/api/telegram/link', () =>
        HttpResponse.json(env({ url: 'https://example.test/alerts?crossex=abc', expiresAt: 1_760_000_600_000 })),
      ),
    );
    const { wrapper } = hookWrapper();
    const { result } = renderHook(() => ({ info: useTelegram(), start: useStartTelegramLink() }), { wrapper });
    await waitFor(() => expect(result.current.info.data).toEqual(telegramOff));
    const link = await act(() => result.current.start.mutateAsync());
    expect(link.url).toBe('https://example.test/alerts?crossex=abc');
    await waitFor(() => expect(reads).toBe(2));
  });

  it('a bot that does not answer surfaces the server sentence', async () => {
    server.use(
      http.post('/api/telegram/link', () =>
        HttpResponse.json(
          {
            ok: false,
            error: { category: 'unknown', message: 'Telegram alerts are not available yet. Try again later.', retryable: true },
          },
          { status: 503 },
        ),
      ),
    );
    const { wrapper } = hookWrapper();
    const { result } = renderHook(() => useStartTelegramLink(), { wrapper });
    await act(() => result.current.mutateAsync().catch(() => undefined));
    await waitFor(() => expect(result.current.error?.message).toBe('Telegram alerts are not available yet. Try again later.'));
  });

  it('the link status reads only while enabled', async () => {
    let reads = 0;
    const pending: TelegramLinkStatus = { status: 'pending', url: 'https://example.test/x', expiresAt: 1 };
    server.use(
      http.get('/api/telegram/link', () => {
        reads += 1;
        return HttpResponse.json(env(pending));
      }),
    );
    const { wrapper } = hookWrapper();
    const { result, rerender } = renderHook(({ on }) => useTelegramLink(on), { wrapper, initialProps: { on: false } });
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(reads).toBe(0);
    rerender({ on: true });
    await waitFor(() => expect(result.current.data).toEqual(pending));
  });

  it('settings send a PATCH and disconnect sends a DELETE, each refreshing the connection', async () => {
    const calls: string[] = [];
    let reads = 0;
    server.use(
      http.get('/api/telegram', () => {
        reads += 1;
        return HttpResponse.json(env(telegramOff));
      }),
      http.patch('/api/telegram/settings', async ({ request }) => {
        calls.push(`PATCH ${JSON.stringify(await request.json())}`);
        return HttpResponse.json(env(telegramOff));
      }),
      http.delete('/api/telegram', () => {
        calls.push('DELETE');
        return HttpResponse.json(env(telegramOff));
      }),
    );
    const { wrapper } = hookWrapper();
    const { result } = renderHook(
      () => ({ info: useTelegram(), settings: useTelegramSettings(), disconnect: useDisconnectTelegram() }),
      { wrapper },
    );
    await waitFor(() => expect(reads).toBe(1));
    await act(() => result.current.settings.mutateAsync({ interest: false }));
    await waitFor(() => expect(reads).toBe(2));
    await act(() => result.current.disconnect.mutateAsync());
    await waitFor(() => expect(reads).toBe(3));
    expect(calls).toEqual(['PATCH {"interest":false}', 'DELETE']);
  });
});
