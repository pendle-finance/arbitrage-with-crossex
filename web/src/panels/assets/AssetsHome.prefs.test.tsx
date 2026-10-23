import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AssetBorosOpen, AssetViewPrefs, AssetViewResponse, VenueFees } from '../../api/types';
import { ToastProvider } from '../../components/Toast';
import { baseHandlers } from '../../test/fixtures';
import { env, server } from '../../test/server';
import { TradeFlowProvider } from '../../trade/TradeFlow';
import { STRATEGY_STORAGE_KEY } from '../HomeControls';
import { TrackedAddressProvider } from '../trackedAddress';
import { AssetsHome } from './AssetsHome';

const ADDRESS = '0x' + 'ab'.repeat(20);
const KEY = 'gk_****abcd';
const BOOK = `${ADDRESS}|${KEY}`;
const LEGACY_KEY = 'crossex.assetView.v1';
const HELD = 'boros:59';
const GONE = 'boros:60';
const NOW = Date.UTC(2026, 8, 18, 12) / 1000;
const JUNE = Date.UTC(2026, 5, 23, 12) / 1000;
const DEC = Date.UTC(2026, 11, 25, 8) / 1000;
const PRICE = 3_650.17;
const PART_TITLE = 'Part of this leg is excluded.';

const empty = (): AssetViewPrefs => ({ sinceByAsset: {}, exclusions: {}, legSince: {} });

let stored: Record<string, AssetViewPrefs>;
let calls: Array<{ method: string; book?: string; body?: unknown }>;
let legSize: number;
let views: number;
let patchStatus: number;
let importStatus: number;
let importGate: Promise<void> | null;

const failure = () =>
  HttpResponse.json({ ok: false, error: { category: 'unknown', message: 'boom', retryable: true } }, { status: 500 });

function viewOf(sizeToken: number): AssetViewResponse {
  const leg: AssetBorosOpen = {
    spreadVenues: null,
    marketId: 59,
    venue: 'BINANCE',
    maturity: DEC,
    collateral: 'ETH',
    side: 'LONG',
    sizeToken,
    notionalUsd: sizeToken * PRICE,
    entryApr: 0.08,
    markApr: 0.08,
    floatingApr: 0.08,
    settleUsd: 0,
    mtmUsd: 0,
    imUsd: 1,
  };
  return {
    sinceSec: JUNE,
    nowSec: NOW,
    defaultSinceSec: JUNE,
    assets: [
      {
        base: 'ETH',
        supported: true,
        priceUsd: PRICE,
        earliestSec: JUNE,
        perpOpen: [],
        perpClosed: [],
        borosOpen: [leg],
        borosHistory: [],
      },
    ],
    supportedCoins: ['ETH'],
    earliestSec: JUNE,
    coverage: { settlementsFromSec: 0, perpClosedFromSec: 0, borosTxnsComplete: true, backfilling: false },
    warnings: [],
  };
}

function mergeInto(prev: AssetViewPrefs, body: Partial<Record<keyof AssetViewPrefs, Record<string, unknown>>>) {
  const next: AssetViewPrefs = {
    sinceByAsset: { ...prev.sinceByAsset },
    exclusions: { ...prev.exclusions },
    legSince: { ...prev.legSince },
  };
  for (const section of ['sinceByAsset', 'exclusions', 'legSince'] as const) {
    const target: Record<string, unknown> = next[section];
    for (const [k, v] of Object.entries(body[section] ?? {})) {
      if (v === null) delete target[k];
      else target[k] = v;
    }
  }
  return next;
}

function handlers() {
  return [
    http.get('/api/credentials', () => HttpResponse.json(env({ configured: true, keyMasked: KEY }))),
    http.get('/api/fees', () => HttpResponse.json(env<VenueFees[]>([]))),
    http.get('/api/asset-view/:address', () => {
      views += 1;
      return HttpResponse.json(env(viewOf(legSize)));
    }),
    http.get('/api/boros/margin/:address', () => HttpResponse.json(env({ borosMargin: [] }))),
    http.get('/api/asset-prefs/:book', ({ params }) => {
      calls.push({ method: 'GET', book: String(params.book) });
      return HttpResponse.json(env(stored[String(params.book)] ?? empty()));
    }),
    http.patch('/api/asset-prefs/:book', async ({ params, request }) => {
      const book = String(params.book);
      const body = (await request.json()) as Partial<Record<keyof AssetViewPrefs, Record<string, unknown>>>;
      calls.push({ method: 'PATCH', book, body });
      if (patchStatus !== 200) return failure();
      stored[book] = mergeInto(stored[book] ?? empty(), body);
      return HttpResponse.json(env(stored[book]));
    }),
    http.post('/api/asset-prefs/import', async ({ request }) => {
      const body = (await request.json()) as Record<string, AssetViewPrefs>;
      calls.push({ method: 'POST', body });
      if (importGate) await importGate;
      if (importStatus !== 200) return failure();
      for (const [book, prefs] of Object.entries(body)) stored[book] = mergeInto(prefs, stored[book] ?? empty());
      return HttpResponse.json(env({}));
    }),
  ];
}

function renderHome() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchInterval: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <TradeFlowProvider>
          <TrackedAddressProvider>
            <AssetsHome />
          </TrackedAddressProvider>
        </TradeFlowProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

async function editButton(): Promise<HTMLElement> {
  await screen.findAllByText('ETH');
  for (let pass = 0; pass < 4; pass += 1) {
    const [edit] = screen.queryAllByRole('button', { name: /^Edit / });
    if (edit) return edit;
    const tab = screen.queryByRole('tab', { name: /^Funding Bundles/, selected: false });
    if (tab) await userEvent.click(tab);
    for (const toggle of screen.queryAllByRole('button', { expanded: false })) await userEvent.click(toggle);
  }
  const [edit] = await screen.findAllByRole('button', { name: /^Edit / });
  return edit;
}

const patches = () => calls.filter((c) => c.method === 'PATCH');

beforeEach(() => {
  stored = {};
  calls = [];
  legSize = 2;
  views = 0;
  patchStatus = 200;
  importStatus = 200;
  importGate = null;
  localStorage.setItem(STRATEGY_STORAGE_KEY, JSON.stringify({ address: ADDRESS, walletUpgraded: true }));
  server.use(...baseHandlers(), ...handlers());
});

afterEach(() => {
  localStorage.clear();
});

describe('a 1.7.7 whole-leg exclusion becomes a size', () => {
  const rungs = [50, 5_000, 100_000, 1_000_000, 6_000_000];

  it.each(rungs)('old all becomes a size on load at $%d', async (usd) => {
    const size = usd / PRICE;
    legSize = size;
    stored[BOOK] = { ...empty(), exclusions: { [HELD]: 'all', [GONE]: 'all' } };
    const first = renderHome();
    await waitFor(() => expect(stored[BOOK].exclusions).toEqual({ [HELD]: { qty: size }, [GONE]: 'all' }));
    expect(patches()).toEqual([{ method: 'PATCH', book: BOOK, body: { exclusions: { [HELD]: { qty: size } } } }]);
    first.unmount();

    legSize = size + 1;
    renderHome();
    expect(await editButton()).toHaveAttribute('title', PART_TITLE);
    expect(patches()).toHaveLength(1);
    expect(stored[BOOK].exclusions).toEqual({ [HELD]: { qty: size }, [GONE]: 'all' });
  });

  it('a failed save is not sent again in the same load', async () => {
    patchStatus = 500;
    stored[BOOK] = { ...empty(), exclusions: { [HELD]: 'all' } };
    renderHome();
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET')).toHaveLength(2));
    expect(patches()).toHaveLength(1);
    expect(stored[BOOK].exclusions).toEqual({ [HELD]: 'all' });
  });

  it('the size waits for the browser move', async () => {
    let open = () => {};
    importGate = new Promise<void>((resolve) => {
      open = resolve;
    });
    stored[BOOK] = { ...empty(), exclusions: { [HELD]: 'all' } };
    localStorage.setItem(LEGACY_KEY, JSON.stringify({ [BOOK]: empty() }));
    renderHome();
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(patches()).toEqual([]);
    open();
    await waitFor(() => expect(stored[BOOK].exclusions).toEqual({ [HELD]: { qty: 2 } }));
    expect(calls.map((c) => c.method)).toEqual(['POST', 'GET', 'PATCH']);
  });

  it('a failed move never saves a browser-only all', async () => {
    importStatus = 500;
    const browser = { ...empty(), exclusions: { [HELD]: 'all', [GONE]: 'all', 'perp:ETHUSDT': 'all' } };
    localStorage.setItem(LEGACY_KEY, JSON.stringify({ [BOOK]: browser }));
    renderHome();
    await waitFor(() => expect(views > 0 && calls.some((c) => c.method === 'GET')).toBe(true));
    await new Promise((r) => setTimeout(r, 300));
    expect(patches()).toEqual([]);
    expect(stored[BOOK]).toBeUndefined();
    expect(JSON.parse(localStorage.getItem(LEGACY_KEY) ?? 'null')[BOOK]).toEqual(browser);
  });

  it('a failed move still sizes the server all on a held leg', async () => {
    importStatus = 500;
    stored[BOOK] = { ...empty(), exclusions: { [HELD]: 'all' } };
    localStorage.setItem(
      LEGACY_KEY,
      JSON.stringify({ [BOOK]: { ...empty(), exclusions: { [HELD]: 'all', [GONE]: 'all' } } }),
    );
    renderHome();
    await waitFor(() => expect(stored[BOOK].exclusions).toEqual({ [HELD]: { qty: 2 } }));
    expect(patches()).toEqual([{ method: 'PATCH', book: BOOK, body: { exclusions: { [HELD]: { qty: 2 } } } }]);
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem(LEGACY_KEY) ?? 'null')[BOOK].exclusions).toEqual({ [GONE]: 'all' }),
    );
  });

  it('a moved browser all becomes a size once the server holds it', async () => {
    localStorage.setItem(
      LEGACY_KEY,
      JSON.stringify({ [BOOK]: { ...empty(), exclusions: { [HELD]: 'all', [GONE]: 'all' } } }),
    );
    renderHome();
    await waitFor(() => expect(stored[BOOK].exclusions).toEqual({ [HELD]: { qty: 2 }, [GONE]: 'all' }));
    expect(patches()).toEqual([{ method: 'PATCH', book: BOOK, body: { exclusions: { [HELD]: { qty: 2 } } } }]);
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
  });
});
