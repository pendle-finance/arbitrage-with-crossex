import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { useMemo, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetGroup, AssetViewPrefs, AssetViewResponse, VenueFees } from '../../api/types';
import { ToastProvider } from '../../components/Toast';
import { ADDRESS, DATES, NOW, PX, PrefillProbe, cardsTitled, expand, groupOf, hedgedCards, listMarkets, prefill, showPairs, spreadRow, textOf } from '../../test/assetCardBooks';
import { baseHandlers } from '../../test/fixtures';
import { env, server } from '../../test/server';
import { renderWithClient } from '../../test/utils';
import { pickOpenMarkets } from '../../trade/BorosPairTicket';
import { TradeFlowProvider, type BorosOpenPrefill } from '../../trade/TradeFlow';
import { STRATEGY_STORAGE_KEY } from '../HomeControls';
import { TrackedAddressProvider } from '../trackedAddress';
import { AssetsHome } from './AssetsHome';
import { AssetCard } from './AssetCard';
import { deriveAsset, type ExclusionEntry, type Exclusions } from './assetModel';

type ExcludeSpy = (key: string, value: ExclusionEntry | undefined) => void;

function Harness({ group, initial, spy, frozen = false }: { group: AssetGroup; initial: Exclusions; spy: ExcludeSpy; frozen?: boolean }) {
  const [exclusions, setExclusions] = useState<Exclusions>(initial);
  const derived = useMemo(() => deriveAsset(group, exclusions, 0, NOW), [group, exclusions]);
  const onExclude: ExcludeSpy = (key, value) => {
    spy(key, value);
    if (frozen) return;
    setExclusions((prev) => {
      const next = { ...prev };
      if (value === undefined) delete next[key];
      else next[key] = value;
      return next;
    });
  };
  return (
    <>
      <AssetCard
        group={group}
        derived={derived}
        sinceSec={0}
        windowPending={false}
        storedSinceSec={undefined}
        defaultSinceSec={null}
        backfilling={false}
        supportedCoins={['ETH']}
        onChangeSince={() => {}}
        exclusions={exclusions}
        onExclude={onExclude}
      />
      <PrefillProbe />
    </>
  );
}

function renderCard(group: AssetGroup, initial: Exclusions = {}, spy: ExcludeSpy = vi.fn(), frozen = false) {
  return renderWithClient(<Harness group={group} initial={initial} spy={spy} frozen={frozen} />);
}

const B9 = ['G L 2', 'H S 1', 'LI S 1', 'G LONG 1 O', 'H SHORT 1 O', 'G LONG 1 N', 'H SHORT 1 N', 'LI SHORT 1 N'];
const B13 = ['G L 4.03', 'H S 4.03', 'G LONG 0.36 O'];
const B21 = ['G L 1', 'H S 1', 'H LONG 1 O'];
const PART_FILL = ['G L 10', 'H S 10', 'G LONG 10 N', 'H SHORT 6 N'];
const KEY_104 = 'boros:104';
const KEY_101 = 'boros:101';
const EXCLUDED_NOTE = 'Not part of the arb: out of the hedge, PnL and capital.';

type User = ReturnType<typeof userEvent.setup>;

const RUNGS = [50, 5_000, 100_000, 1_000_000, 6_000_000];
const singleRow = (venue: string, maturity: number) => ({
  ...spreadRow(maturity),
  marketId: (venue === 'Gate' ? 300 : 400) + (maturity % 97),
  name: `${venue} ETH`,
  venue,
  spreadVenues: null,
});
function listSingles(markets: ReturnType<typeof singleRow>[]) {
  server.use(
    http.get('/api/boros/pair/context', () =>
      HttpResponse.json(
        env({ markets, spreadMarkets: [], crossByToken: [], isolatedByMarket: [], defaultSlippageApr: 0.0025, maxSlippageApr: 0.1 }),
      ),
    ),
  );
  return markets;
}
const closeSize = async () => Number((await screen.findByLabelText(/Close size, applied to all legs/) as HTMLInputElement).value);

async function openUngrouped(user: User) {
  const toggle = await screen.findByRole('button', { name: /Ungrouped legs/ });
  if (toggle.getAttribute('aria-expanded') === 'false') await user.click(toggle);
}

const closeRow = (name: string) => screen.getByRole('button', { name }).closest('tr') as HTMLElement;
const menuButton = (within_: HTMLElement) => within(within_).getByRole('button', { name: 'More actions' });
const excludedBlock = () => screen.getByText('Excluded').parentElement?.parentElement as HTMLElement;

async function clickExclude(user: User, row: HTMLElement) {
  await user.click(menuButton(row));
  await user.click(await screen.findByRole('button', { name: /^Exclude/ }));
}

async function openBundle(user: User, name: RegExp) {
  await user.click(screen.getByRole('tab', { name: /^Funding Bundles/ }));
  const bundle = await waitFor(() => screen.getAllByRole('button', { name }).find((b) => b.hasAttribute('aria-expanded')) as HTMLElement);
  if (bundle.getAttribute('aria-expanded') === 'false') await user.click(bundle);
}

async function pickBorosCard(title: RegExp) {
  return waitFor(() => {
    const found = cardsTitled(title);
    expect(found).toHaveLength(1);
    return found[0];
  });
}

beforeEach(() => {
  prefill.current = null;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-23T00:00:00Z'));
  localStorage.setItem(STRATEGY_STORAGE_KEY, JSON.stringify({ address: ADDRESS }));
  server.use(http.get('/api/positions', () => HttpResponse.json({ positions: [] })));
  listMarkets([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Exclude from the card, by the DoD', () => {
  it('Exclude in the row menu', async () => {
    const user = userEvent.setup();
    renderCard(groupOf(B9));
    await showPairs(user);
    await openUngrouped(user);
    const row = closeRow('Close Hyperliquid SHORT YU');
    const more = menuButton(row);
    expect(more.querySelector('svg.lucide-ellipsis, svg.lucide-more-horizontal')).not.toBeNull();
    expect(within(row).queryByRole('button', { name: /Exclude/ })).toBeNull();
  });

  it('whole leg excludes all (#74)', async () => {
    const spy = vi.fn();
    const user = userEvent.setup();
    renderCard(groupOf(B9), {}, spy);
    await showPairs(user);
    await openUngrouped(user);
    await clickExclude(user, closeRow('Close Hyperliquid SHORT YU'));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(KEY_104, { qty: 1 });
  });

  it('part row excludes its part', async () => {
    const spy = vi.fn();
    const user = userEvent.setup();
    renderCard(groupOf(PART_FILL), {}, spy);
    await showPairs(user);
    const card = await pickBorosCard(/Boros leg missing/);
    await user.click(menuButton(card));
    await user.click(await screen.findByRole('button', { name: 'Exclude 4 ETH' }));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]).toEqual([KEY_101, { qty: 4 }]);
  });

  it('part exclude keeps the hedged card', async () => {
    const user = userEvent.setup();
    renderCard(groupOf(PART_FILL));
    await showPairs(user);
    await clickExclude(user, await pickBorosCard(/Boros leg missing/));
    await waitFor(() => expect(cardsTitled(/Boros leg missing/)).toHaveLength(0));
    const [hedged] = hedgedCards();
    expect(hedgedCards()).toHaveLength(1);
    await expand(user, hedged);
    expect(textOf(hedged)).toMatch(/GateBorosLONG6 ETH/);
    const missing = await pickBorosCard(/Boros legs missing/);
    expect(textOf(missing)).toContain('no rate leg');
    expect(textOf(missing)).toContain('4 ETH');
  });

  it('menu on Perp legs missing', async () => {
    const user = userEvent.setup();
    renderCard(groupOf(['G L 10', 'H S 10', 'LI S 1', 'G LONG 10 O', 'H SHORT 10 O', 'G LONG 1 N', 'LI SHORT 1 N']));
    await showPairs(user);
    const card = await pickBorosCard(/Perp legs? missing/);
    expect(within(card).getAllByRole('button', { name: 'More actions' })).toHaveLength(2);
  });

  it('menu on Boros legs missing', async () => {
    const user = userEvent.setup();
    const single = renderCard(groupOf(B13));
    await showPairs(user);
    const held = await pickBorosCard(/Boros leg missing/);
    expect(within(held).getAllByRole('button', { name: 'More actions' })).toHaveLength(1);
    single.unmount();

    renderCard(groupOf(B21));
    await showPairs(user);
    const flipped = await pickBorosCard(/Boros legs? missing/);
    expect(textOf(flipped)).toContain('Wrong side');
    expect(within(flipped).getAllByRole('button', { name: 'More actions' })).toHaveLength(1);
  });

  it('no Exclude on perps', async () => {
    const user = userEvent.setup();
    renderCard(groupOf(['G L 10', 'H S 1', 'G LONG 1 N', 'H SHORT 1 N']));
    await showPairs(user);
    await openUngrouped(user);
    const card = await pickBorosCard(/Ungrouped legs/);
    expect(textOf(card)).toMatch(/1 perp/);
    expect(within(card).queryAllByRole('button', { name: 'More actions' })).toHaveLength(0);
  });

  it('no Exclude on Hedged', async () => {
    const user = userEvent.setup();
    renderCard(groupOf(['G L 1', 'H S 1', 'G LONG 1 N', 'H SHORT 1 N']));
    await showPairs(user);
    const [card] = await waitFor(() => {
      const found = hedgedCards();
      expect(found).toHaveLength(1);
      return found;
    });
    await expand(user, card);
    expect(within(card).queryAllByRole('button', { name: 'More actions' })).toHaveLength(0);
  });

  it('excluded single leaves the grouping', async () => {
    const user = userEvent.setup();
    renderCard(groupOf(B13), { [KEY_101]: 'all' });
    await showPairs(user);
    const card = await pickBorosCard(/Boros legs missing/);
    expect(textOf(card)).toContain('4.03 ETH');
    expect(cardsTitled(/missing/)).toHaveLength(1);
    expect(cardsTitled(/Ungrouped legs/)).toHaveLength(0);
  });

  it('offer after exclude, spread listed', async () => {
    listMarkets([spreadRow(DATES.O)]);
    const user = userEvent.setup();
    renderCard(groupOf(B13), { [KEY_101]: 'all' });
    await showPairs(user);
    const card = await pickBorosCard(/Boros leg missing/);
    expect(await within(card).findByRole('button', { name: 'Open Boros leg' })).toBeInTheDocument();
  });

  it('offer after exclude, no spread', async () => {
    const user = userEvent.setup();
    renderCard(groupOf(B13), { [KEY_101]: 'all' });
    await showPairs(user);
    const card = await pickBorosCard(/Boros legs missing/);
    expect(await within(card).findByRole('button', { name: 'Open both Boros legs' })).toBeInTheDocument();
  });

  it('exclude toast offers Undo', async () => {
    const user = userEvent.setup();
    renderCard(groupOf(B9));
    await showPairs(user);
    await openUngrouped(user);
    await clickExclude(user, closeRow('Close Hyperliquid SHORT YU'));
    const toast = await screen.findByRole('alert');
    expect(toast).toHaveTextContent('Hyperliquid SHORT 1 ETH · 27 Nov excluded.');
    expect(within(toast).getByRole('button', { name: 'Undo' })).toBeInTheDocument();
  });

  it('tab bar shows the excluded count', async () => {
    const user = userEvent.setup();
    renderCard(groupOf(B9), { [KEY_104]: 'all', 'boros:105': 'all' });
    await showPairs(user);
    const link = screen.getByRole('button', { name: /2 excluded/ });
    expect(link.querySelector('svg.lucide-arrow-down')).not.toBeNull();
  });

  it('no link with nothing excluded', async () => {
    const user = userEvent.setup();
    renderCard(groupOf(B9));
    await showPairs(user);
    expect(screen.queryByRole('button', { name: /excluded/ })).toBeNull();
    expect(screen.queryByText('Excluded')).toBeNull();
  });

  it('Excluded list on both tabs', async () => {
    const user = userEvent.setup();
    renderCard(groupOf(B13), { [KEY_101]: 'all' });
    await showPairs(user);
    const onPairs = textOf(excludedBlock());
    expect(onPairs).toContain(EXCLUDED_NOTE);
    expect(onPairs).toMatch(/Gate.*LONG/);
    expect(onPairs).toContain('0.36 ETH');
    expect(onPairs).toContain('whole leg');
    await user.click(screen.getByRole('tab', { name: /^Funding Bundles/ }));
    expect(textOf(excludedBlock())).toBe(onPairs);
  });

  it('menu holds one item', async () => {
    const user = userEvent.setup();
    renderCard(groupOf(B9));
    await showPairs(user);
    await openUngrouped(user);
    await user.click(menuButton(closeRow('Close Hyperliquid SHORT YU')));
    const menu = await screen.findByRole('tooltip');
    expect(within(menu).getAllByRole('button')).toHaveLength(1);
    expect(within(menu).getByRole('button')).toHaveTextContent(/^Exclude$/);
    expect(menu).not.toHaveTextContent('Not part of the arb');
  });

  it('Restore brings it back', async () => {
    const spy = vi.fn();
    const user = userEvent.setup();
    renderCard(groupOf(B13), { [KEY_101]: 'all' }, spy);
    await showPairs(user);
    await user.click(within(excludedBlock()).getByRole('button', { name: 'Restore' }));
    expect(spy).toHaveBeenCalledWith(KEY_101, undefined);
    const card = await pickBorosCard(/Boros leg missing/);
    expect(textOf(card)).toContain('0.36 ETH');
    expect(screen.queryByText('Excluded')).toBeNull();
  });

  it('count link scrolls to the list', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const user = userEvent.setup();
    renderCard(groupOf(B13), { [KEY_101]: 'all' });
    await showPairs(user);
    await user.click(screen.getByRole('button', { name: /1 excluded/ }));
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.contexts[0]).toBe(excludedBlock());
  });

  it('outside click closes the menu', async () => {
    const spy = vi.fn();
    const user = userEvent.setup();
    renderCard(groupOf(B9), {}, spy);
    await showPairs(user);
    await openUngrouped(user);
    await user.click(menuButton(closeRow('Close Hyperliquid SHORT YU')));
    await screen.findByRole('tooltip');
    await user.click(document.body);
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
    expect(spy).not.toHaveBeenCalled();
  });

  it('undo toast closes after 5 s', async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-10-23T00:00:00Z'));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderCard(groupOf(B9));
    await showPairs(user);
    await openUngrouped(user);
    await clickExclude(user, closeRow('Close Hyperliquid SHORT YU'));
    await screen.findByRole('alert');
    act(() => vi.advanceTimersByTime(4_000));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a newer exclude on the key closes the older toast', async () => {
    const spy = vi.fn();
    const user = userEvent.setup();
    renderCard(groupOf(['H S 1', 'LI S 1', 'G LONG 2 N', 'H SHORT 1 N', 'LI SHORT 1 N']), {}, spy, true);
    await showPairs(user);
    await waitFor(() => expect(cardsTitled(/Perp leg missing/)).toHaveLength(2));
    const gateRows = () => screen.getAllByRole('row').filter((r) => /GateBorosLONG/.test(textOf(r)) && r.querySelector('[aria-label="More actions"]'));
    expect(gateRows()).toHaveLength(2);
    await clickExclude(user, gateRows()[0]);
    expect(await screen.findAllByRole('alert')).toHaveLength(1);
    await clickExclude(user, gateRows()[1]);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1][0]).toBe(KEY_101);
    await user.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Undo' }));
    expect(spy).toHaveBeenLastCalledWith(KEY_101, spy.mock.calls[0][1]);
  });

  it('adding to a part exclude', async () => {
    const book = ['G L 10', 'H S 10', 'G LONG 12 N', 'H SHORT 6 N'];
    const patch = { 101: { entryApr: 400 } };
    const spy = vi.fn();
    const user = userEvent.setup();
    const first = renderCard(groupOf(book, patch), { [KEY_101]: { qty: 2, at: 100 } }, spy);
    await showPairs(user);
    await user.click(menuButton(await pickBorosCard(/Boros leg missing/)));
    await user.click(await screen.findByRole('button', { name: 'Exclude 4 ETH' }));
    expect(spy).toHaveBeenLastCalledWith(KEY_101, { qty: 6, at: 300 });
    first.unmount();

    const legacy = vi.fn();
    renderCard(groupOf(book, patch), { [KEY_101]: 2 }, legacy);
    await showPairs(user);
    await user.click(menuButton(await pickBorosCard(/Boros leg missing/)));
    await user.click(await screen.findByRole('button', { name: 'Exclude 4 ETH' }));
    expect(legacy).toHaveBeenLastCalledWith(KEY_101, { qty: 6 });
  });

  it('part reaching the leg is all (#74)', async () => {
    const spy = vi.fn();
    const user = userEvent.setup();
    renderCard(groupOf(['G L 4', 'H S 4', 'G LONG 10 N']), { [KEY_101]: { qty: 6 } }, spy);
    await showPairs(user);
    await clickExclude(user, await pickBorosCard(/Boros leg missing/));
    expect(spy).toHaveBeenLastCalledWith(KEY_101, { qty: 10 });
  });

  it("part exclude in the market's unit", async () => {
    const spy = vi.fn();
    const user = userEvent.setup();
    renderCard(groupOf(PART_FILL, { 101: { collateral: 'USDT', sizeToken: 25_000, notionalUsd: 25_000 } }), {}, spy);
    await showPairs(user);
    await clickExclude(user, await pickBorosCard(/Boros leg missing/));
    expect(spy).toHaveBeenLastCalledWith(KEY_101, { qty: 10_000 });
  });

  it('part exclude qty is exact at every rung', () => {
    for (const [part, leg, hedged, legToken] of [
      [50, 0.05, 0.03, 125],
      [5_000, 5, 3, 12_500],
      [100_000, 100, 60, 250_000],
      [1_000_000, 1_000, 600, 2_500_000],
      [6_000_000, 6_000, 3_600, 15_000_000],
    ]) {
      const group = groupOf([`G L ${leg}`, `H S ${leg}`, `G LONG ${leg} N`, `H SHORT ${hedged} N`], {
        101: { collateral: 'USDT', sizeToken: legToken, notionalUsd: legToken },
      });
      const d = deriveAsset(group, {}, 0, NOW);
      expect(d.perpOnly.map((c) => c.longYu?.rowSizeToken)).toEqual([part]);
    }
  });

  it('part above the leg after a close', async () => {
    const user = userEvent.setup();
    renderCard(groupOf(['G L 2', 'H S 2', 'G LONG 2 N']), { [KEY_101]: { qty: 4 } });
    await showPairs(user);
    expect(textOf(excludedBlock())).toMatch(/2 ETH\s*whole leg/);
    expect(screen.getByRole('button', { name: /1 excluded/ })).toBeInTheDocument();
  });

  it('excluded flipped leg stops blocking', async () => {
    const net = 'Hyperliquid LONG at 30 Oct is excluded and would net. Pick another date or restore it.';
    listSingles([singleRow('Gate', DATES.O), singleRow('Gate', DATES.N), singleRow('Hyperliquid', DATES.O), singleRow('Hyperliquid', DATES.N)]);
    const user = userEvent.setup();
    const first = renderCard(groupOf(B21), { [KEY_101]: 'all' });
    await showPairs(user);
    const blocked = await pickBorosCard(/Boros legs missing/);
    expect(textOf(blocked)).not.toContain('Wrong side');
    await waitFor(() => expect(textOf(blocked)).toContain(net));
    expect(within(blocked).queryByRole('button', { name: 'Open both Boros legs' })).toBeNull();
    expect(within(blocked).getAllByRole('button', { name: 'Open leg' })).toHaveLength(1);
    first.unmount();

    const markets = listSingles([singleRow('Gate', DATES.N), singleRow('Hyperliquid', DATES.O), singleRow('Hyperliquid', DATES.N)]);
    renderCard(groupOf(B21), { [KEY_101]: 'all' });
    await showPairs(user);
    const card = await pickBorosCard(/Boros legs missing/);
    await user.click(await within(card).findByRole('button', { name: 'Open both Boros legs' }));
    await waitFor(() => expect(prefill.current).not.toBeNull());
    const sent = prefill.current as BorosOpenPrefill;
    expect(sent).toMatchObject({ longVenue: 'GATE', shortVenue: 'HYPERLIQUID', sizeBase: 1 });
    const lands = pickOpenMarkets(markets, [], sent);
    expect([lands.long?.maturity, lands.short?.maturity]).toEqual([DATES.N, DATES.N]);
  });
  it('#75 the blocked row says the excluded leg would net', async () => {
    const user = userEvent.setup();
    renderCard(groupOf(['G L 1', 'H S 1', 'G LONG 1 O', 'H LONG 1 O']), { 'boros:102': 'all' });
    await showPairs(user);
    const card = await pickBorosCard(/Boros leg missing/);
    expect(textOf(card)).toContain('Hyperliquid LONG at 30 Oct is excluded and would net. Pick another date or restore it.');
    expect(within(card).queryByRole('button', { name: 'Open leg' })).toBeNull();
    expect(within(card).queryByRole('button', { name: /^Open/ })).toBeNull();
  });

  it('#75 another date still offers the open', async () => {
    listSingles([singleRow('Hyperliquid', DATES.O), singleRow('Hyperliquid', DATES.N)]);
    const user = userEvent.setup();
    renderCard(groupOf(['G L 1', 'H S 1', 'G LONG 1 N', 'H LONG 1 O']), { 'boros:102': 'all' });
    await showPairs(user);
    const card = await pickBorosCard(/Boros leg missing/);
    expect(textOf(card)).not.toContain('would net');
    await user.click(within(card).getByRole('button', { name: 'Open leg' }));
    await waitFor(() => expect(prefill.current).not.toBeNull());
    expect(prefill.current).toMatchObject({ longVenue: null, shortVenue: 'HYPERLIQUID', maturity: DATES.N, sizeBase: 1 });
  });

  it.each(RUNGS.map((usd) => usd / PX))('#75 bundle open skips the excluded leg date (%s ETH)', async (q) => {
    const markets = listSingles([singleRow('Hyperliquid', DATES.O), singleRow('Hyperliquid', DATES.N)]);
    const user = userEvent.setup();
    renderCard(groupOf([`G L ${q}`, `H S ${q}`, `G LONG ${q} N`, `H LONG ${q} O`]), { 'boros:102': 'all' });
    await openBundle(user, /Hyperliquid/);
    const row = await waitFor(() => screen.getByText(/not open yet/).closest('tr') as HTMLElement);
    await waitFor(() => expect(within(row).getByRole('button', { name: /open Boros leg/ })).toBeEnabled());
    await user.click(within(row).getByRole('button', { name: /open Boros leg/ }));
    await waitFor(() => expect(prefill.current).not.toBeNull());
    const sent = prefill.current as BorosOpenPrefill;
    expect(sent).toMatchObject({ longVenue: null, shortVenue: 'HYPERLIQUID', maturity: DATES.N, sizeBase: q });
    expect(pickOpenMarkets(markets, [], sent).short?.maturity).toBe(DATES.N);
  });

  it.each(RUNGS.map((usd) => usd / PX))('#75 bundle open that nets the excluded leg is blocked (%s ETH)', async (q) => {
    listSingles([singleRow('Hyperliquid', DATES.O)]);
    const user = userEvent.setup();
    renderCard(groupOf([`G L ${q}`, `H S ${q}`, `G LONG ${q} N`, `H LONG ${q} O`]), { 'boros:102': 'all' });
    await openBundle(user, /Hyperliquid/);
    const row = await waitFor(() => screen.getByText(/not open yet/).closest('tr') as HTMLElement);
    await waitFor(() => expect(textOf(row)).toContain('Hyperliquid LONG at 30 Oct is excluded and would net. Pick another date or restore it.'));
    expect(within(row).queryByRole('button', { name: /open Boros leg/ })).toBeNull();
    expect(prefill.current).toBeNull();
  });

  it.each(RUNGS.map((usd) => usd / PX))('#75 bundle open with no known date is blocked (%s ETH)', async (q) => {
    server.use(http.get('/api/boros/pair/context', () => new Promise<never>(() => {})));
    const user = userEvent.setup();
    renderCard(groupOf([`G L ${q}`, `H S ${q}`, `H LONG ${q} O`]), { 'boros:101': 'all' });
    await openBundle(user, /Hyperliquid/);
    expect(await screen.findAllByText('Hyperliquid LONG at 30 Oct is excluded and would net. Pick another date or restore it.')).not.toHaveLength(0);
    expect(screen.queryByRole('button', { name: /open (both )?Boros legs?/ })).toBeNull();
  });

  const bundleGapRows = async (user: User) => {
    await openBundle(user, /Gate/);
    await openBundle(user, /Hyperliquid/);
    return waitFor(() => {
      const rows = screen.getAllByText(/not open yet/).map((el) => el.closest('tr') as HTMLElement);
      const gate = rows.find((r) => /Gate/.test(textOf(r)));
      const hl = rows.find((r) => /Hyperliquid/.test(textOf(r)));
      expect(gate && hl).toBeTruthy();
      return { gate: gate as HTMLElement, hl: hl as HTMLElement };
    });
  };

  it.each(RUNGS.map((usd) => usd / PX))('#75 bundle Gate row opens its own leg when the pair nets on Hyperliquid (%s ETH)', async (q) => {
    const net = 'Hyperliquid LONG at 30 Oct is excluded and would net. Pick another date or restore it.';
    const markets = listSingles([singleRow('Gate', DATES.O), singleRow('Hyperliquid', DATES.O)]);
    const book = [`G L ${q}`, `H S ${q}`, `H LONG ${q} O`];
    const user = userEvent.setup();
    const pairs = renderCard(groupOf(book), { [KEY_101]: 'all' });
    await showPairs(user);
    const card = await pickBorosCard(/Boros legs missing/);
    await waitFor(() => expect(textOf(card)).toContain(net));
    await user.click(within(card).getByRole('button', { name: 'Open leg' }));
    await waitFor(() => expect(prefill.current).not.toBeNull());
    const fromPairs = prefill.current as BorosOpenPrefill;
    pairs.unmount();
    prefill.current = null;

    renderCard(groupOf(book), { [KEY_101]: 'all' });
    const { gate, hl } = await bundleGapRows(user);
    await waitFor(() => expect(textOf(hl)).toContain(net));
    expect(within(hl).queryByRole('button', { name: /open/ })).toBeNull();
    expect(textOf(gate)).not.toContain('would net');
    await waitFor(() => expect(within(gate).getByRole('button', { name: /open Boros leg/ })).toBeEnabled());
    await user.click(within(gate).getByRole('button', { name: /open Boros leg/ }));
    await waitFor(() => expect(prefill.current).not.toBeNull());
    const sent = prefill.current as BorosOpenPrefill;
    expect(sent).toMatchObject({ longVenue: 'GATE', shortVenue: null, sizeBase: q });
    expect({ size: sent.size, sizeBase: sent.sizeBase }).toEqual({ size: fromPairs.size, sizeBase: fromPairs.sizeBase });
    expect(pickOpenMarkets(markets, [], sent).long?.marketId).toBe(pickOpenMarkets(markets, [], fromPairs).long?.marketId);
  });

  it.each(RUNGS.map((usd) => usd / PX))('#75 bundle rows both stay blocked when each venue nets (%s ETH)', async (q) => {
    listSingles([singleRow('Gate', DATES.O), singleRow('Hyperliquid', DATES.O)]);
    const user = userEvent.setup();
    renderCard(groupOf([`G L ${q}`, `H S ${q}`, `H LONG ${q} O`, `G SHORT ${q} O`]), { [KEY_101]: 'all', 'boros:102': 'all' });
    const { gate, hl } = await bundleGapRows(user);
    await waitFor(() => expect(textOf(hl)).toContain('would net'));
    await waitFor(() => expect(textOf(gate)).toContain('would net'));
    expect(within(gate).queryByRole('button', { name: /open/ })).toBeNull();
    expect(within(hl).queryByRole('button', { name: /open/ })).toBeNull();
    expect(prefill.current).toBeNull();
  });

  it.each(RUNGS.map((usd) => usd / PX))('#75 bundle pair stays when the excluded leg is on another date (%s ETH)', async (q) => {
    const markets = listSingles([singleRow('Gate', DATES.N), singleRow('Hyperliquid', DATES.N)]);
    const user = userEvent.setup();
    renderCard(groupOf([`G L ${q}`, `H S ${q}`, `H LONG ${q} O`]), { [KEY_101]: 'all' });
    const { gate, hl } = await bundleGapRows(user);
    await waitFor(() => expect(within(hl).getByRole('button', { name: /open both Boros legs/ })).toBeEnabled());
    expect(within(gate).getByRole('button', { name: /open both Boros legs/ })).toBeEnabled();
    await user.click(within(hl).getByRole('button', { name: /open both Boros legs/ }));
    await waitFor(() => expect(prefill.current).not.toBeNull());
    const sent = prefill.current as BorosOpenPrefill;
    expect(sent).toMatchObject({ longVenue: 'GATE', shortVenue: 'HYPERLIQUID', sizeBase: q });
    const lands = pickOpenMarkets(markets, [], sent);
    expect([lands.long?.maturity, lands.short?.maturity]).toEqual([DATES.N, DATES.N]);
  });

  it.each([...RUNGS.map((usd) => usd / PX), 1_200])('close a slice of a part-excluded leg sends the slice (%s ETH)', async (row) => {
    const user = userEvent.setup();
    renderCard(groupOf([`G LONG ${row * 3} N`]), { [KEY_101]: { qty: row * 2 } });
    await showPairs(user);
    await openUngrouped(user);
    await user.click(screen.getByRole('button', { name: 'Close Gate LONG YU' }));
    expect(await closeSize()).toBe(row);
  });

  it.each([50 / PX, 6_000_000 / PX])('bundle close of a part-excluded leg sends the kept part (%s ETH)', async (row) => {
    const user = userEvent.setup();
    renderCard(groupOf([`G LONG ${row * 3} N`]), { [KEY_101]: { qty: row * 2 } });
    await user.click(screen.getByRole('tab', { name: /^Funding Bundles/ }));
    const bundle = await waitFor(() => screen.getAllByRole('button', { name: /Gate/ }).find((b) => b.hasAttribute('aria-expanded')) as HTMLElement);
    if (bundle.getAttribute('aria-expanded') === 'false') await user.click(bundle);
    await user.click(await screen.findByRole('button', { name: 'Close Gate LONG YU' }));
    expect(await closeSize()).toBe(row);
  });
});

const HOME_ADDRESS = '0x' + 'ab'.repeat(20);
const HOME_BOOK = `${HOME_ADDRESS}|gk_****abcd`;

describe('Exclude through the saved prefs', () => {
  let stored: AssetViewPrefs;
  let patches: Array<{ exclusions: Record<string, unknown> }>;
  let patchStatus: number;

  const homeView = (): AssetViewResponse => ({
    sinceSec: NOW - 864_000,
    nowSec: NOW,
    defaultSinceSec: NOW - 864_000,
    assets: [groupOf(B9)],
    supportedCoins: ['ETH'],
    earliestSec: NOW - 864_000,
    coverage: { settlementsFromSec: 0, perpClosedFromSec: 0, borosTxnsComplete: true, backfilling: false },
    warnings: [],
  });

  function renderHome() {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchInterval: false, refetchOnWindowFocus: false }, mutations: { retry: false } },
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

  beforeEach(() => {
    stored = { sinceByAsset: {}, exclusions: {}, legSince: {} };
    patches = [];
    patchStatus = 200;
    localStorage.setItem(STRATEGY_STORAGE_KEY, JSON.stringify({ address: HOME_ADDRESS, walletUpgraded: true }));
    server.use(
      ...baseHandlers(),
      http.get('/api/credentials', () => HttpResponse.json(env({ configured: true, keyMasked: 'gk_****abcd' }))),
      http.get('/api/fees', () => HttpResponse.json(env<VenueFees[]>([]))),
      http.get('/api/asset-view/:address', () => HttpResponse.json(env(homeView()))),
      http.get('/api/boros/margin/:address', () => HttpResponse.json(env({ borosMargin: [] }))),
      http.get('/api/asset-prefs/:book', () => HttpResponse.json(env(stored))),
      http.patch('/api/asset-prefs/:book', async ({ params, request }) => {
        expect(params.book).toBe(HOME_BOOK);
        const body = (await request.json()) as { exclusions: Record<string, unknown> };
        patches.push(body);
        if (patchStatus !== 200) {
          return HttpResponse.json({ ok: false, error: { category: 'unknown', message: 'boom', retryable: true } }, { status: 500 });
        }
        for (const [key, value] of Object.entries(body.exclusions)) {
          if (value === null) delete stored.exclusions[key];
          else stored.exclusions[key] = value as ExclusionEntry;
        }
        return HttpResponse.json(env(stored));
      }),
    );
  });

  async function excludeHyperliquidShort(user: User) {
    await user.click(await screen.findByRole('tab', { name: /^Fixed Rate Pairs/ }));
    await openUngrouped(user);
    await clickExclude(user, closeRow('Close Hyperliquid SHORT YU'));
    await waitFor(() => expect(patches).toHaveLength(1));
  }

  it('Undo restores the old value (#74)', async () => {
    const user = userEvent.setup();
    renderHome();
    await excludeHyperliquidShort(user);
    expect(patches[0]).toEqual({ exclusions: { [KEY_104]: { qty: 1 } } });
    await waitFor(() => expect(screen.queryByRole('button', { name: /Ungrouped legs/ })).toBeNull());
    await user.click(within(await screen.findByRole('alert')).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(patches).toHaveLength(2));
    expect(patches[1]).toEqual({ exclusions: { [KEY_104]: null } });
    await openUngrouped(user);
    expect(closeRow('Close Hyperliquid SHORT YU')).toBeInTheDocument();
  });

  it('failed undo says so (#74)', async () => {
    const user = userEvent.setup();
    renderHome();
    await excludeHyperliquidShort(user);
    patchStatus = 500;
    await user.click(within(await screen.findByRole('alert')).getByRole('button', { name: 'Undo' }));
    expect(await screen.findByText('Could not save. Try again.')).toBeInTheDocument();
    await waitFor(() => expect(textOf(excludedBlock())).toContain('whole leg'));
    expect(stored.exclusions[KEY_104]).toEqual({ qty: 1 });
  });
});
