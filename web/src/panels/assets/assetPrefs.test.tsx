import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importAssetPrefs, qk, useAssetPrefs, usePatchAssetPrefs } from '../../api/queries';
import { fetchJson } from '../../api/client';
import type { AssetBorosOpen, AssetViewPrefs, AssetViewResponse, VenueFees } from '../../api/types';
import { ToastProvider } from '../../components/Toast';
import { baseHandlers } from '../../test/fixtures';
import { env, server } from '../../test/server';
import { TradeFlowProvider } from '../../trade/TradeFlow';
import { STRATEGY_STORAGE_KEY } from '../HomeControls';
import { TrackedAddressProvider } from '../trackedAddress';
import { AssetsHome } from './AssetsHome';
import { exclusionAfter } from './excludeLeg';

const ADDRESS = '0x' + 'ab'.repeat(20);
const KEY_A = 'gk_****abcd';
const KEY_B = 'gk_****wxyz';
const BOOK_A = `${ADDRESS}|${KEY_A}`;
const BOOK_B = `${ADDRESS}|${KEY_B}`;
const LEGACY_KEY = 'crossex.assetView.v1';
const LEG = 'boros:7';
const NOW = Date.UTC(2026, 8, 18, 12) / 1000;
const JUNE = Date.UTC(2026, 5, 23, 12) / 1000;
const DEC = Date.UTC(2026, 11, 25, 8) / 1000;

const EXCLUDED_TITLE = 'Part of this leg is excluded.';
const INCLUDED_TITLE = 'Exclude some or all of this leg from the farm';

const PART = { qty: 4 };

const empty = (): AssetViewPrefs => ({ sinceByAsset: {}, exclusions: {}, legSince: {} });

const borosLeg: AssetBorosOpen = {
  spreadVenues: null,
  marketId: 7,
  venue: 'BINANCE',
  maturity: DEC,
  collateral: 'USDT',
  side: 'LONG',
  sizeToken: 10,
  notionalUsd: 10,
  entryApr: 0.08,
  markApr: 0.08,
  floatingApr: 0.08,
  settleUsd: 0,
  mtmUsd: 0,
  imUsd: 1,
};

const view: AssetViewResponse = {
  sinceSec: JUNE,
  nowSec: NOW,
  defaultSinceSec: JUNE,
  assets: [
    {
      base: 'ETH',
      supported: true,
      priceUsd: 100,
      earliestSec: JUNE,
      perpOpen: [],
      perpClosed: [],
      borosOpen: [borosLeg],
      borosHistory: [],
    },
  ],
  supportedCoins: ['ETH'],
  earliestSec: JUNE,
  coverage: { settlementsFromSec: 0, perpClosedFromSec: 0, borosTxnsComplete: true, backfilling: false },
  warnings: [],
};

type Call = { method: string; book?: string; body?: unknown };

let stored: Record<string, AssetViewPrefs>;
let calls: Call[];
let keyMasked: string;
let getGate: Promise<void> | null;
let patchGate: Promise<void> | null;
let getStatus: number;
let patchStatus: number;
let importStatus: number;
let importGate: Promise<void> | null;

function gate(): { wait: Promise<void>; open: () => void } {
  let open = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

const failure = () =>
  HttpResponse.json({ ok: false, error: { category: 'unknown', message: 'boom', retryable: true } }, { status: 500 });

function merge(prev: AssetViewPrefs, body: Partial<Record<keyof AssetViewPrefs, Record<string, unknown>>>) {
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

function prefsHandlers() {
  return [
    http.get('/api/credentials', () => HttpResponse.json(env({ configured: true, keyMasked }))),
    http.get('/api/fees', () => HttpResponse.json(env<VenueFees[]>([]))),
    http.get('/api/asset-view/:address', () => HttpResponse.json(env(view))),
    http.get('/api/boros/margin/:address', () => HttpResponse.json(env({ borosMargin: [] }))),
    http.get('/api/asset-prefs/:book', async ({ params }) => {
      const book = String(params.book);
      calls.push({ method: 'GET', book });
      if (getGate) await getGate;
      if (getStatus !== 200) return failure();
      return HttpResponse.json(env(stored[book] ?? empty()));
    }),
    http.patch('/api/asset-prefs/:book', async ({ params, request }) => {
      const book = String(params.book);
      const body = (await request.json()) as Partial<Record<keyof AssetViewPrefs, Record<string, unknown>>>;
      calls.push({ method: 'PATCH', book, body });
      if (patchGate) await patchGate;
      if (patchStatus !== 200) return failure();
      stored[book] = merge(stored[book] ?? empty(), body);
      return HttpResponse.json(env(stored[book]));
    }),
    http.post('/api/asset-prefs/import', async ({ request }) => {
      const body = (await request.json()) as Record<string, AssetViewPrefs>;
      calls.push({ method: 'POST', body });
      if (importGate) await importGate;
      if (importStatus !== 200) return failure();
      for (const [book, prefs] of Object.entries(body)) {
        const mine = (stored[book] ??= empty());
        for (const section of ['sinceByAsset', 'exclusions', 'legSince'] as const) {
          const target: Record<string, unknown> = mine[section];
          for (const [k, v] of Object.entries(prefs[section] ?? {})) if (!(k in target)) target[k] = v;
        }
      }
      return HttpResponse.json(env({}));
    }),
  ];
}

function renderHome(ui = <AssetsHome />) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchInterval: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
  const utils = render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <TradeFlowProvider>
          <TrackedAddressProvider>{ui}</TrackedAddressProvider>
        </TradeFlowProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { qc, ...utils };
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

const noCard = () => expect(screen.queryByText('ETH')).toBeNull();
const patches = () => calls.filter((c) => c.method === 'PATCH');

async function switchBook(qc: QueryClient) {
  keyMasked = KEY_B;
  await act(() => qc.invalidateQueries({ queryKey: qk.credentials }));
}

async function excludePart() {
  await userEvent.click(await editButton());
  await userEvent.click(screen.getByRole('radio', { name: 'Exclude a portion' }));
  await userEvent.type(screen.getByLabelText(/Size to exclude/), '4');
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
}

beforeEach(() => {
  stored = {};
  calls = [];
  keyMasked = KEY_A;
  getGate = null;
  patchGate = null;
  getStatus = 200;
  patchStatus = 200;
  importStatus = 200;
  importGate = null;
  localStorage.setItem(STRATEGY_STORAGE_KEY, JSON.stringify({ address: ADDRESS, walletUpgraded: true }));
  server.use(...baseHandlers(), ...prefsHandlers());
});

afterEach(() => {
  focusManager.setFocused(undefined);
  localStorage.clear();
});

describe('the load waits for the prefs', () => {
  it('no cards until prefs load', async () => {
    const first = gate();
    getGate = first.wait;
    const { qc, container } = renderHome();
    await waitFor(() => expect(calls.some((c) => c.method === 'GET' && c.book === BOOK_A)).toBe(true));
    expect(container.querySelector('.card .divide-y')).not.toBeNull();
    noCard();
    first.open();
    expect(await editButton()).toBeInTheDocument();

    const second = gate();
    getGate = second.wait;
    await switchBook(qc);
    await waitFor(() => expect(calls.some((c) => c.method === 'GET' && c.book === BOOK_B)).toBe(true));
    noCard();
    expect(container.querySelector('.card .divide-y')).not.toBeNull();
    expect(patches()).toEqual([]);
    second.open();
    expect(await editButton()).toBeInTheDocument();
  });

  it('prefs error shows the tab error', async () => {
    getStatus = 500;
    renderHome();
    expect(await screen.findByText("Couldn't load the asset view")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Retry/ })).toBeInTheDocument();
    noCard();
  });
});

describe('the one move from the browser', () => {
  const IMPORT_FAILED = "Could not move this browser's saved exclusions to the terminal. It tries again on the next load.";
  const legacy = {
    [BOOK_A]: { sinceByAsset: {}, exclusions: {}, legSince: {} },
    [`${'0x' + 'cd'.repeat(20)}|none`]: { sinceByAsset: {}, exclusions: { 'boros:9': 'all' }, legSince: {} },
  };

  it('moves browser prefs to the server', async () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify(legacy));
    renderHome();
    await editButton();
    expect(calls[0]).toEqual({ method: 'POST', body: legacy });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(calls[1]).toMatchObject({ method: 'GET', book: BOOK_A });
  });

  it('browser key removed after the move', async () => {
    stored[BOOK_A] = { sinceByAsset: {}, exclusions: { [LEG]: PART }, legSince: {} };
    localStorage.setItem(LEGACY_KEY, JSON.stringify(legacy));
    renderHome();
    expect(await editButton()).toHaveAttribute('title', EXCLUDED_TITLE);
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  it('failed move tries again', async () => {
    importStatus = 500;
    const browserLeg = { ...borosLeg, marketId: 8, side: 'SHORT' as const };
    const twoLegs = { ...view, assets: [{ ...view.assets[0], borosOpen: [borosLeg, browserLeg] }] };
    server.use(http.get('/api/asset-view/:address', () => HttpResponse.json(env(twoLegs))));
    const withBrowserLeg = {
      ...legacy,
      [BOOK_A]: { sinceByAsset: {}, exclusions: { 'boros:8': { qty: 3 }, 'perp:ETHUSDT': 'all' }, legSince: {} },
    };
    stored[BOOK_A] = { sinceByAsset: {}, exclusions: { [LEG]: PART }, legSince: {} };
    localStorage.setItem(LEGACY_KEY, JSON.stringify(withBrowserLeg));
    const first = renderHome();
    await editButton();
    const edits = screen.getAllByRole('button', { name: /^Edit / });
    expect(edits).toHaveLength(2);
    for (const edit of edits) expect(edit).toHaveAttribute('title', EXCLUDED_TITLE);
    expect(screen.getByText(IMPORT_FAILED)).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(LEGACY_KEY) ?? 'null')).toEqual(withBrowserLeg);
    first.unmount();

    importStatus = 200;
    renderHome();
    await editButton();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2);
    await waitFor(() => expect(localStorage.getItem(LEGACY_KEY)).toBeNull());
  });

  const legacyPart = { [BOOK_A]: { sinceByAsset: {}, exclusions: { [LEG]: PART }, legSince: {} } };

  it('failed import says so and keeps its excluded legs out', async () => {
    importStatus = 500;
    localStorage.setItem(LEGACY_KEY, JSON.stringify(legacyPart));
    renderHome();
    expect(await editButton()).toHaveAttribute('title', EXCLUDED_TITLE);
    expect(screen.getByText(IMPORT_FAILED)).toBeInTheDocument();
  });

  it('hung import shows the book after 10 s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      importGate = new Promise<void>(() => {});
      localStorage.setItem(LEGACY_KEY, JSON.stringify(legacyPart));
      renderHome();
      await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
      noCard();
      await act(() => vi.advanceTimersByTimeAsync(10_000));
      expect(await editButton()).toHaveAttribute('title', EXCLUDED_TITLE);
      expect(screen.getByText(IMPORT_FAILED)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('M2 import fails, the trader excludes, the retry still imports the old map', async () => {
    const old = { [BOOK_A]: { sinceByAsset: {}, exclusions: { 'boros:9': 'all' }, legSince: {} } };
    importStatus = 500;
    localStorage.setItem(LEGACY_KEY, JSON.stringify(old));
    const first = renderHome();
    await screen.findByText(IMPORT_FAILED);
    await excludePart();
    await waitFor(() => expect(stored[BOOK_A]?.exclusions[LEG]).toEqual(PART));
    first.unmount();

    importStatus = 200;
    renderHome();
    await editButton();
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([old, old]);
    await waitFor(() => expect(stored[BOOK_A].exclusions).toEqual({ 'boros:9': 'all', [LEG]: PART }));
    await waitFor(() => expect(localStorage.getItem(LEGACY_KEY)).toBeNull());
  });

  it('a write queued behind the import goes after it', async () => {
    const held = gate();
    importGate = held.wait;
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const { result } = renderHook(() => usePatchAssetPrefs(BOOK_A), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={qc}>
          <ToastProvider>{children}</ToastProvider>
        </QueryClientProvider>
      ),
    });
    const moved = importAssetPrefs(legacyPart);
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    act(() => result.current.mutate({ exclusions: { [LEG]: 'all' } }));
    await new Promise((r) => setTimeout(r, 50));
    expect(patches()).toHaveLength(0);
    held.open();
    await moved;
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(calls.map((c) => c.method)).toEqual(['POST', 'PATCH']);
  });
});

describe('a prefs file the server could not read', () => {
  const UNREADABLE = 'Saved exclusions could not be read. They were kept as a backup file.';

  it('says so on the tab and keeps saying so after a save', async () => {
    server.use(
      http.get('/api/asset-prefs/:book', ({ params }) =>
        HttpResponse.json(env({ ...(stored[String(params.book)] ?? empty()), unreadable: true })),
      ),
    );
    renderHome();
    await editButton();
    expect(screen.getByText(UNREADABLE)).toBeInTheDocument();
    await excludePart();
    await waitFor(() => expect(stored[BOOK_A]?.exclusions[LEG]).toEqual(PART));
    expect(screen.getByText(UNREADABLE)).toBeInTheDocument();
  });

  it('a readable file shows no line', async () => {
    renderHome();
    await editButton();
    expect(screen.queryByText(UNREADABLE)).toBeNull();
  });
});

describe('saves', () => {
  it('exclude shows at once', async () => {
    const held = gate();
    patchGate = held.wait;
    renderHome();
    expect(await editButton()).toHaveAttribute('title', INCLUDED_TITLE);
    await excludePart();
    await waitFor(() => expect(patches().length).toBeGreaterThan(0));
    expect(await editButton()).toHaveAttribute('title', EXCLUDED_TITLE);
    expect(stored[BOOK_A]).toBeUndefined();
    held.open();
    await waitFor(() => expect(stored[BOOK_A]?.exclusions[LEG]).toEqual(PART));
  });

  it('exclude sends one key', async () => {
    renderHome();
    await excludePart();
    await waitFor(() => expect(patches().length).toBeGreaterThan(0));
    expect(patches()[0]).toEqual({ method: 'PATCH', book: BOOK_A, body: { exclusions: { [LEG]: PART } } });
    for (const p of patches()) expect(Object.keys(p.body as object)).toHaveLength(1);
  });

  it('failed save says so', async () => {
    patchStatus = 500;
    renderHome();
    await excludePart();
    expect(await screen.findByText('Could not save. Try again.')).toBeInTheDocument();
    expect(screen.getAllByText('Could not save. Try again.')).toHaveLength(1);
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET').length).toBeGreaterThan(1));
    await waitFor(async () => expect(await editButton()).toHaveAttribute('title', INCLUDED_TITLE));
  });

  it('edit save keeps both keys', async () => {
    const { qc } = renderHome();
    await userEvent.click(await editButton());
    await userEvent.click(screen.getByRole('radio', { name: 'Exclude a portion' }));
    await userEvent.type(screen.getByLabelText(/Size to exclude/), '4');
    fireEvent.change(screen.getByLabelText('Date this position is counted from'), { target: { value: '2026-07-01' } });
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches()).toHaveLength(2));
    await waitFor(() => expect(qc.isMutating()).toBe(0));
    const sec = Math.floor(new Date('2026-07-01T00:00').getTime() / 1000);
    const after = await fetchJson<AssetViewPrefs>(`/asset-prefs/${encodeURIComponent(BOOK_A)}`);
    expect(after.exclusions[LEG]).toMatchObject({ qty: 4 });
    expect(after.legSince[LEG]).toBe(sec);
    const cached = qc.getQueryData<AssetViewPrefs>(qk.assetPrefs(BOOK_A));
    expect(cached?.exclusions[LEG]).toMatchObject({ qty: 4 });
    expect(cached?.legSince[LEG]).toBe(sec);
  });

  it('since date saves one key', async () => {
    renderHome();
    await editButton();
    fireEvent.change(screen.getByLabelText('Count ETH PnL from'), { target: { value: '2026-07-01' } });
    await waitFor(() => expect(patches()).toHaveLength(1));
    const sec = Math.floor(new Date('2026-07-01T00:00').getTime() / 1000);
    expect(patches()[0].body).toEqual({ sinceByAsset: { ETH: sec } });
  });

  it('refetch on focus', async () => {
    renderHome();
    expect(await editButton()).toHaveAttribute('title', INCLUDED_TITLE);
    stored[BOOK_A] = { sinceByAsset: {}, exclusions: { [LEG]: PART }, legSince: {} };
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET')).toHaveLength(2));
    await waitFor(async () => expect(await editButton()).toHaveAttribute('title', EXCLUDED_TITLE));
  });
});

async function rowMenuExclude(): Promise<HTMLElement> {
  await screen.findAllByText('ETH');
  const tab = screen.queryByRole('tab', { name: /^Fixed Rate Pairs/, selected: false });
  if (tab) await userEvent.click(tab);
  const toggle = await screen.findByRole('button', { name: /Ungrouped legs/ });
  if (toggle.getAttribute('aria-expanded') === 'false') await userEvent.click(toggle);
  await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
  return screen.findByRole('menuitem', { name: /^Exclude/ });
}

describe('the row menu popup', () => {
  it('a double click on Save sends one PATCH', async () => {
    renderHome();
    await userEvent.click(await rowMenuExclude());
    const popup = await screen.findByRole('dialog');
    await userEvent.dblClick(within(popup).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(stored[BOOK_A]?.exclusions[LEG]).toEqual({ qty: 10 }));
    expect(patches()).toHaveLength(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

function PartExcluder({ book }: { book: string }) {
  const prefs = useAssetPrefs(book);
  const save = usePatchAssetPrefs(book);
  if (!prefs.data) return null;
  const prev = prefs.data.exclusions[LEG];
  return (
    <button type="button" onClick={() => save.mutate({ exclusions: { [LEG]: exclusionAfter(prev, 5, 10, null) } })}>
      Exclude 5
    </button>
  );
}

describe('quick saves', () => {
  it('two quick part excludes reach the whole leg', async () => {
    const held = gate();
    patchGate = held.wait;
    renderHome(<PartExcluder book={BOOK_A} />);
    const button = await screen.findByRole('button', { name: 'Exclude 5' });
    await userEvent.click(button);
    await waitFor(() => expect(patches()).toHaveLength(1));
    await userEvent.click(button);
    await waitFor(() => expect(patches()).toHaveLength(2));
    expect(patches().map((p) => p.body)).toEqual([{ exclusions: { [LEG]: { qty: 5 } } }, { exclusions: { [LEG]: { qty: 10 } } }]);
    held.open();
    await waitFor(() => expect(stored[BOOK_A]?.exclusions[LEG]).toEqual({ qty: 10 }));
  });

  it('a save for one book never lands in another', async () => {
    const held = gate();
    patchGate = held.wait;
    const { qc } = renderHome();
    await excludePart();
    await waitFor(() => expect(patches().length).toBeGreaterThan(0));
    await switchBook(qc);
    await waitFor(() => expect(calls.some((c) => c.method === 'GET' && c.book === BOOK_B)).toBe(true));
    expect(await editButton()).toHaveAttribute('title', INCLUDED_TITLE);
    held.open();
    await waitFor(() => expect(stored[BOOK_A]?.exclusions[LEG]).toEqual(PART));
    await waitFor(() => expect(qc.isMutating()).toBe(0));
    expect(qc.getQueryData<AssetViewPrefs>(qk.assetPrefs(BOOK_B))?.exclusions).toEqual({});
    expect(qc.getQueryData<AssetViewPrefs>(qk.assetPrefs(BOOK_A))?.exclusions[LEG]).toEqual(PART);
    expect(await editButton()).toHaveAttribute('title', INCLUDED_TITLE);
  });
});
