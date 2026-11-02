import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
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
import { blockedReason, blockedReasons } from '../../test/blockedReason';
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
const EXCLUDED_NOTE = 'Not part of the farm: out of the hedge, PnL and capital.';

type User = ReturnType<typeof userEvent.setup>;

const RUNGS = [50, 5_000, 100_000, 1_000_000, 6_000_000];
const NET_HL_30 = 'Hyperliquid Long at 30 Oct is excluded. Opening here would offset it: Boros keeps one position per market. Pick another date or restore it.';
const isDead = (b: HTMLElement) => b.getAttribute('aria-disabled') === 'true';
const opensIn = (el: HTMLElement, name: string | RegExp) => within(el).queryAllByRole('button', { name });
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
const closeSize = async () => Number((await screen.findByLabelText(/Close size, applied to all positions/) as HTMLInputElement).value);

async function openUngrouped(user: User) {
  const toggle = await screen.findByRole('button', { name: /Ungrouped positions/ });
  if (toggle.getAttribute('aria-expanded') === 'false') await user.click(toggle);
}

const closeRow = (name: string) => screen.getByRole('button', { name }).closest('tr') as HTMLElement;
const menuButton = (within_: HTMLElement) => within(within_).getByRole('button', { name: 'More actions' });
const excludedBlock = () => screen.getByText('Excluded').parentElement?.parentElement as HTMLElement;

async function openExclude(user: User, row: HTMLElement) {
  await user.click(menuButton(row));
  await user.click(await screen.findByRole('menuitem', { name: 'Exclude' }));
  return screen.findByRole('dialog');
}

async function clickExclude(user: User, row: HTMLElement) {
  const popup = await openExclude(user, row);
  await user.click(within(popup).getByRole('button', { name: 'Save' }));
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
    const row = closeRow('Close Hyperliquid Short YU');
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
    await clickExclude(user, closeRow('Close Hyperliquid Short YU'));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(KEY_104, { qty: 1 });
  });

  it('part row excludes its part', async () => {
    const spy = vi.fn();
    const user = userEvent.setup();
    renderCard(groupOf(PART_FILL), {}, spy);
    await showPairs(user);
    await clickExclude(user, await pickBorosCard(/Boros position missing/));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]).toEqual([KEY_101, { qty: 4 }]);
  });

  it('Exclude opens the leg popup with the row size, and saves nothing until Save', async () => {
    const spy = vi.fn();
    const user = userEvent.setup();
    renderCard(groupOf(PART_FILL), {}, spy);
    await showPairs(user);
    const popup = await openExclude(user, await pickBorosCard(/Boros position missing/));
    expect(within(popup).getByText(/^Edit position — Gate Long YU · /)).toBeInTheDocument();
    expect(within(popup).getByRole('radio', { name: 'Exclude a portion' })).toBeChecked();
    expect(within(popup).getByLabelText('Size to exclude (ETH)')).toHaveValue('4');
    expect(within(popup).getByText(/Farm keeps/)).toHaveTextContent('Farm keeps 6 ETH');
    expect(spy).not.toHaveBeenCalled();
    await user.click(within(popup).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('part exclude keeps the hedged card', async () => {
    const user = userEvent.setup();
    renderCard(groupOf(PART_FILL));
    await showPairs(user);
    await clickExclude(user, await pickBorosCard(/Boros position missing/));
    await waitFor(() => expect(cardsTitled(/Boros position missing/)).toHaveLength(0));
    const [hedged] = hedgedCards();
    expect(hedgedCards()).toHaveLength(1);
    await expand(user, hedged);
    expect(textOf(hedged)).toMatch(/GateBorosLONG6 ETH/);
    const missing = await pickBorosCard(/Boros positions missing/);
    expect(textOf(missing)).toContain('No Boros position');
    expect(textOf(missing)).toContain('4 ETH');
  });

  it('menu on Perp legs missing', async () => {
    const user = userEvent.setup();
    renderCard(groupOf(['G L 10', 'H S 10', 'LI S 1', 'G LONG 10 O', 'H SHORT 10 O', 'G LONG 1 N', 'LI SHORT 1 N']));
    await showPairs(user);
    const card = await pickBorosCard(/Perp legs? missing/);
    expect(within(card).getAllByRole('button', { name: 'More actions' })).toHaveLength(2);
  });

  it('menu on Boros positions missing', async () => {
    const user = userEvent.setup();
    const single = renderCard(groupOf(B13));
    await showPairs(user);
    const held = await pickBorosCard(/Boros position missing/);
    expect(within(held).getAllByRole('button', { name: 'More actions' })).toHaveLength(1);
    single.unmount();

    renderCard(groupOf(B21));
    await showPairs(user);
    const flipped = await pickBorosCard(/Boros positions? missing/);
    expect(textOf(flipped)).toContain('Wrong side');
    expect(within(flipped).getAllByRole('button', { name: 'More actions' })).toHaveLength(1);
  });

  it('no Exclude on perps', async () => {
    const user = userEvent.setup();
    renderCard(groupOf(['G L 10', 'H S 1', 'G LONG 1 N', 'H SHORT 1 N']));
    await showPairs(user);
    await openUngrouped(user);
    const card = await pickBorosCard(/Ungrouped positions/);
    expect(textOf(card)).toMatch(/1 perp/);
    expect(within(card).queryAllByRole('button', { name: 'More actions' })).toHaveLength(0);
  });

  it('a hedged card offers Exclude on its Boros row only, sized to the card', async () => {
    const spy = vi.fn();
    const user = userEvent.setup();
    renderCard(groupOf(['G L 1', 'H S 1', 'G LONG 1 N', 'H SHORT 1 N']), {}, spy);
    await showPairs(user);
    const [card] = await waitFor(() => {
      const found = hedgedCards();
      expect(found).toHaveLength(1);
      return found;
    });
    await expand(user, card);
    expect(within(card).getAllByRole('button', { name: 'More actions' })).toHaveLength(2);
    const popup = await openExclude(user, within(card).getAllByRole('button', { name: 'More actions' })[0].closest('tr') as HTMLElement);
    expect(within(popup).getByLabelText('Size to exclude (ETH)')).toHaveValue('1');
    await user.click(within(popup).getByRole('button', { name: 'Save' }));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toEqual({ qty: 1 });
  });

  const legTables = () => screen.getAllByRole('table').filter((t) => within(t).queryByRole('columnheader', { name: 'Initial margin' }));
  const expectLegTable = (table: HTMLElement, menuColumn: boolean) => {
    const heads = within(table).getAllByRole('columnheader');
    expect(heads).toHaveLength(menuColumn ? 5 : 4);
    if (menuColumn) expect(heads[4].textContent).toBe('');
    for (const row of within(table).getAllByRole('row').slice(1)) {
      const cells = row.querySelectorAll('td');
      expect(cells).toHaveLength(heads.length);
      expect(cells[3].querySelector('[aria-label="More actions"]')).toBeNull();
    }
  };

  it('a leg table with a menu gives it its own column, clear of the margin', async () => {
    const user = userEvent.setup();
    renderCard(groupOf(PART_FILL));
    await showPairs(user);
    await waitFor(() => expect(hedgedCards()).toHaveLength(1));
    await expand(user, hedgedCards()[0]);
    await pickBorosCard(/Boros position missing/);
    const tables = legTables();
    expect(tables).toHaveLength(2);
    for (const table of tables) expectLegTable(table, true);
  });

  it('a leg table with no menu has no empty menu column', async () => {
    const user = userEvent.setup();
    renderCard(groupOf(['G L 1', 'H S 1']));
    await showPairs(user);
    const [table] = await waitFor(() => {
      const found = legTables();
      expect(found).toHaveLength(1);
      return found;
    });
    expect(within(table).queryByRole('button', { name: 'More actions' })).toBeNull();
    expectLegTable(table, false);
  });

  it('excluded single leaves the grouping', async () => {
    const user = userEvent.setup();
    renderCard(groupOf(B13), { [KEY_101]: 'all' });
    await showPairs(user);
    const card = await pickBorosCard(/Boros positions missing/);
    expect(textOf(card)).toContain('4.03 ETH');
    expect(cardsTitled(/missing/)).toHaveLength(1);
    expect(cardsTitled(/Ungrouped positions/)).toHaveLength(0);
  });

  it('offer after exclude, spread listed', async () => {
    listMarkets([spreadRow(DATES.O)]);
    const user = userEvent.setup();
    renderCard(groupOf(B13), { [KEY_101]: 'all' });
    await showPairs(user);
    const card = await pickBorosCard(/Boros position missing/);
    expect(await within(card).findByRole('button', { name: 'Open Boros position' })).toBeInTheDocument();
  });

  it('offer after exclude, no spread', async () => {
    const user = userEvent.setup();
    renderCard(groupOf(B13), { [KEY_101]: 'all' });
    await showPairs(user);
    const card = await pickBorosCard(/Boros positions missing/);
    expect(await within(card).findByRole('button', { name: 'Open both Boros positions' })).toBeInTheDocument();
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
    expect(onPairs).toContain('whole position');
    await user.click(screen.getByRole('tab', { name: /^Funding Bundles/ }));
    expect(textOf(excludedBlock())).toBe(onPairs);
  });

  it('an Excluded row has the card row format: Boros pill, side tag, the card columns, the venue icon', async () => {
    const user = userEvent.setup();
    renderCard(groupOf(B13), { [KEY_101]: 'all' });
    await showPairs(user);
    const block = excludedBlock();
    expect(within(block).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Position', 'Size', 'Locked', 'Initial margin', '']);
    const row = within(block).getByRole('button', { name: 'Restore' }).closest('tr') as HTMLElement;
    expect(row.querySelector('img[aria-hidden="true"]')).not.toBeNull();
    expect(within(row).getByText('Boros')).toHaveClass('bg-info/[0.16]');
    const cardRow = screen.getAllByRole('row').find((r) => !block.contains(r) && /^GateBorosLONG/.test(r.textContent ?? '')) as HTMLElement;
    const cardSide = within(cardRow).getByText('LONG');
    expect(within(row).getByText('LONG').className).toBe(cardSide.className);
    expect(within(row).getByText('LONG')).toHaveClass('text-grass');
    expect(row.textContent).toMatch(/^GateBorosLONG0\.36 ETH/);
  });

  it('menu holds one item', async () => {
    const user = userEvent.setup();
    renderCard(groupOf(B9));
    await showPairs(user);
    await openUngrouped(user);
    await user.click(menuButton(closeRow('Close Hyperliquid Short YU')));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(1);
    expect(within(menu).getByRole('menuitem')).toHaveTextContent(/^Exclude$/);
    expect(within(menu).queryAllByRole('button')).toHaveLength(0);
    expect(menu.textContent).toBe('Exclude');
  });

  it('Restore brings it back', async () => {
    const spy = vi.fn();
    const user = userEvent.setup();
    renderCard(groupOf(B13), { [KEY_101]: 'all' }, spy);
    await showPairs(user);
    await user.click(within(excludedBlock()).getByRole('button', { name: 'Restore' }));
    expect(spy).toHaveBeenCalledWith(KEY_101, undefined);
    const card = await pickBorosCard(/Boros position missing/);
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
    await user.click(menuButton(closeRow('Close Hyperliquid Short YU')));
    await screen.findByRole('menu');
    await user.click(document.body);
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(spy).not.toHaveBeenCalled();
  });

  it('adding to a part exclude', async () => {
    const book = ['G L 10', 'H S 10', 'G LONG 12 N', 'H SHORT 6 N'];
    const patch = { 101: { entryApr: 400 } };
    const spy = vi.fn();
    const user = userEvent.setup();
    const first = renderCard(groupOf(book, patch), { [KEY_101]: { qty: 2, at: 100 } }, spy);
    await showPairs(user);
    await clickExclude(user, await pickBorosCard(/Boros position missing/));
    expect(spy).toHaveBeenLastCalledWith(KEY_101, { qty: 6, at: 300 });
    first.unmount();

    const legacy = vi.fn();
    renderCard(groupOf(book, patch), { [KEY_101]: 2 }, legacy);
    await showPairs(user);
    await clickExclude(user, await pickBorosCard(/Boros position missing/));
    expect(legacy).toHaveBeenLastCalledWith(KEY_101, { qty: 6 });
  });

  it('part reaching the leg is all (#74)', async () => {
    const spy = vi.fn();
    const user = userEvent.setup();
    renderCard(groupOf(['G L 4', 'H S 4', 'G LONG 10 N']), { [KEY_101]: { qty: 6 } }, spy);
    await showPairs(user);
    await clickExclude(user, await pickBorosCard(/Boros position missing/));
    expect(spy).toHaveBeenLastCalledWith(KEY_101, { qty: 10 });
  });

  it("part exclude in the market's unit", async () => {
    const spy = vi.fn();
    const user = userEvent.setup();
    renderCard(groupOf(PART_FILL, { 101: { collateral: 'USDT', sizeToken: 25_000, notionalUsd: 25_000 } }), {}, spy);
    await showPairs(user);
    await clickExclude(user, await pickBorosCard(/Boros position missing/));
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
    expect(textOf(excludedBlock())).toMatch(/2 ETH\s*whole position/);
    expect(screen.getByRole('button', { name: /1 excluded/ })).toBeInTheDocument();
  });

  it('excluded flipped leg stops blocking', async () => {
    const net = 'Hyperliquid Long at 30 Oct is excluded. Opening here would offset it: Boros keeps one position per market. Pick another date or restore it.';
    listSingles([singleRow('Gate', DATES.O), singleRow('Gate', DATES.N), singleRow('Hyperliquid', DATES.O), singleRow('Hyperliquid', DATES.N)]);
    const user = userEvent.setup();
    const first = renderCard(groupOf(B21), { [KEY_101]: 'all' });
    await showPairs(user);
    const blocked = await pickBorosCard(/Boros positions missing/);
    expect(textOf(blocked)).not.toContain('Wrong side');
    await waitFor(() => expect(opensIn(blocked, 'Open position').filter(isDead)).toHaveLength(1));
    expect(await blockedReasons(user, opensIn(blocked, 'Open position').filter(isDead))).toEqual([net]);
    expect(textOf(blocked)).not.toContain(net);
    expect(within(blocked).queryByRole('button', { name: 'Open both Boros positions' })).toBeNull();
    expect(opensIn(blocked, 'Open position').filter((b) => !isDead(b))).toHaveLength(1);
    first.unmount();

    const markets = listSingles([singleRow('Gate', DATES.N), singleRow('Hyperliquid', DATES.O), singleRow('Hyperliquid', DATES.N)]);
    renderCard(groupOf(B21), { [KEY_101]: 'all' });
    await showPairs(user);
    const card = await pickBorosCard(/Boros positions missing/);
    await user.click(await within(card).findByRole('button', { name: 'Open both Boros positions' }));
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
    const card = await pickBorosCard(/Boros position missing/);
    expect(textOf(card)).not.toContain('would offset it');
    const open = within(card).getByRole('button', { name: 'Open position' });
    expect(open).toHaveAttribute('aria-disabled', 'true');
    expect(await blockedReason(user, open)).toBe(NET_HL_30);
    await user.click(open);
    expect(prefill.current).toBeNull();
    expect(within(card).getAllByRole('button', { name: /^Open/ })).toEqual([open]);
  });

  it('#75 another date still offers the open', async () => {
    listSingles([singleRow('Hyperliquid', DATES.O), singleRow('Hyperliquid', DATES.N)]);
    const user = userEvent.setup();
    renderCard(groupOf(['G L 1', 'H S 1', 'G LONG 1 N', 'H LONG 1 O']), { 'boros:102': 'all' });
    await showPairs(user);
    const card = await pickBorosCard(/Boros position missing/);
    expect(textOf(card)).not.toContain('would offset it');
    await user.click(within(card).getByRole('button', { name: 'Open position' }));
    await waitFor(() => expect(prefill.current).not.toBeNull());
    expect(prefill.current).toMatchObject({ longVenue: null, shortVenue: 'HYPERLIQUID', maturity: DATES.N, sizeBase: 1 });
  });

  it.each(RUNGS.map((usd) => usd / PX))('#75 bundle open skips the excluded leg date (%s ETH)', async (q) => {
    const markets = listSingles([singleRow('Hyperliquid', DATES.O), singleRow('Hyperliquid', DATES.N)]);
    const user = userEvent.setup();
    renderCard(groupOf([`G L ${q}`, `H S ${q}`, `G LONG ${q} N`, `H LONG ${q} O`]), { 'boros:102': 'all' });
    await openBundle(user, /Hyperliquid/);
    const row = await waitFor(() => screen.getByText(/Not open yet/).closest('tr') as HTMLElement);
    await waitFor(() => expect(within(row).getByRole('button', { name: /Open Boros position/ })).toBeEnabled());
    await user.click(within(row).getByRole('button', { name: /Open Boros position/ }));
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
    const row = await waitFor(() => screen.getByText(/Not open yet/).closest('tr') as HTMLElement);
    await waitFor(() => expect(within(row).getByRole('button', { name: /Open Boros position/ })).toHaveAttribute('aria-disabled', 'true'));
    const open = within(row).getByRole('button', { name: /Open Boros position/ });
    expect(await blockedReason(user, open)).toBe(NET_HL_30);
    expect(textOf(row)).not.toContain('would offset it');
    await user.click(open);
    expect(prefill.current).toBeNull();
  });

  it.each(RUNGS.map((usd) => usd / PX))('#75 bundle open with no known date is blocked (%s ETH)', async (q) => {
    server.use(http.get('/api/boros/pair/context', () => new Promise<never>(() => {})));
    const user = userEvent.setup();
    renderCard(groupOf([`G L ${q}`, `H S ${q}`, `H LONG ${q} O`]), { 'boros:101': 'all' });
    await openBundle(user, /Hyperliquid/);
    await waitFor(() => expect(screen.getAllByRole('button', { name: /Open (both )?Boros (positions?|on both venues)/ }).every(isDead)).toBe(true));
    expect(await blockedReasons(user, screen.getAllByRole('button', { name: /Open (both )?Boros (positions?|on both venues)/ }))).toContain(NET_HL_30);
    expect(screen.queryByText(NET_HL_30)).toBeNull();
  });

  const bundleGapRows = async (user: User) => {
    await openBundle(user, /Gate/);
    await openBundle(user, /Hyperliquid/);
    return waitFor(() => {
      const rows = screen.getAllByText(/Not open yet/).map((el) => el.closest('tr') as HTMLElement);
      const gate = rows.find((r) => /Gate/.test(textOf(r)));
      const hl = rows.find((r) => /Hyperliquid/.test(textOf(r)));
      expect(gate && hl).toBeTruthy();
      return { gate: gate as HTMLElement, hl: hl as HTMLElement };
    });
  };

  it.each(RUNGS.map((usd) => usd / PX))('#75 bundle Gate row opens its own leg when the pair nets on Hyperliquid (%s ETH)', async (q) => {
    const net = 'Hyperliquid Long at 30 Oct is excluded. Opening here would offset it: Boros keeps one position per market. Pick another date or restore it.';
    const markets = listSingles([singleRow('Gate', DATES.O), singleRow('Hyperliquid', DATES.O)]);
    const book = [`G L ${q}`, `H S ${q}`, `H LONG ${q} O`];
    const user = userEvent.setup();
    const pairs = renderCard(groupOf(book), { [KEY_101]: 'all' });
    await showPairs(user);
    const card = await pickBorosCard(/Boros positions missing/);
    await waitFor(() => expect(opensIn(card, 'Open position').filter(isDead)).toHaveLength(1));
    expect(await blockedReasons(user, opensIn(card, 'Open position').filter(isDead))).toEqual([net]);
    expect(textOf(card)).not.toContain(net);
    const [hlOpen] = opensIn(card, 'Open position').filter(isDead);
    expect(hlOpen.closest('tr')?.textContent).toMatch(/^HyperliquidBorosSHORT/);
    await user.click(hlOpen);
    expect(prefill.current).toBeNull();
    const live = opensIn(card, 'Open position').filter((b) => !isDead(b));
    expect(live.map((b) => b.closest('tr')?.textContent)).toEqual([expect.stringMatching(/^GateBorosLONG/)]);
    await user.click(live[0]);
    await waitFor(() => expect(prefill.current).not.toBeNull());
    const fromPairs = prefill.current as BorosOpenPrefill;
    pairs.unmount();
    prefill.current = null;

    renderCard(groupOf(book), { [KEY_101]: 'all' });
    const { gate, hl } = await bundleGapRows(user);
    await waitFor(() => expect(opensIn(hl, /^Open (both|Boros|perp)/)).toHaveLength(1));
    const [hlBundleOpen] = opensIn(hl, /^Open (both|Boros|perp)/);
    expect(hlBundleOpen).toHaveAttribute('aria-disabled', 'true');
    expect(await blockedReason(user, hlBundleOpen)).toBe(net);
    expect(textOf(hl)).not.toContain('would offset it');
    await user.click(hlBundleOpen);
    expect(prefill.current).toBeNull();
    expect(textOf(gate)).not.toContain('would offset it');
    expect(within(gate).getByRole('button', { name: /Open Boros position/ })).not.toHaveAttribute('aria-disabled', 'true');
    await waitFor(() => expect(within(gate).getByRole('button', { name: /Open Boros position/ })).toBeEnabled());
    await user.click(within(gate).getByRole('button', { name: /Open Boros position/ }));
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
    for (const row of [hl, gate]) {
      await waitFor(() => expect(opensIn(row, /^Open (both|Boros|perp)/).every(isDead)).toBe(true));
      expect((await blockedReasons(user, opensIn(row, /^Open (both|Boros|perp)/))).join(' ')).toContain('would offset it');
      for (const b of opensIn(row, /^Open (both|Boros|perp)/)) await user.click(b);
    }
    expect(prefill.current).toBeNull();
  });

  it.each(RUNGS.map((usd) => usd / PX))('#75 bundle pair stays when the excluded leg is on another date (%s ETH)', async (q) => {
    const markets = listSingles([singleRow('Gate', DATES.N), singleRow('Hyperliquid', DATES.N)]);
    const user = userEvent.setup();
    renderCard(groupOf([`G L ${q}`, `H S ${q}`, `H LONG ${q} O`]), { [KEY_101]: 'all' });
    const { gate, hl } = await bundleGapRows(user);
    await waitFor(() => expect(within(hl).getByRole('button', { name: /Open Boros on both venues/ })).toBeEnabled());
    expect(within(gate).getByRole('button', { name: /Open Boros on both venues/ })).toBeEnabled();
    await user.click(within(hl).getByRole('button', { name: /Open Boros on both venues/ }));
    await waitFor(() => expect(prefill.current).not.toBeNull());
    const sent = prefill.current as BorosOpenPrefill;
    expect(sent).toMatchObject({ longVenue: 'GATE', shortVenue: 'HYPERLIQUID', sizeBase: q });
    const lands = pickOpenMarkets(markets, [], sent);
    expect([lands.long?.maturity, lands.short?.maturity]).toEqual([DATES.N, DATES.N]);
  });

  it.each([50 / PX, 6_000_000 / PX])('#82 a blocked bundle button stays hoverable and focusable (%s ETH)', async (q) => {
    listSingles([singleRow('Hyperliquid', DATES.O)]);
    const user = userEvent.setup();
    renderCard(groupOf([`G L ${q}`, `H S ${q}`, `G LONG ${q} N`, `H LONG ${q} O`]), { 'boros:102': 'all' });
    await openBundle(user, /Hyperliquid/);
    const row = await waitFor(() => screen.getByText(/Not open yet/).closest('tr') as HTMLElement);
    await waitFor(() => expect(within(row).getByRole('button', { name: /Open Boros position/ })).toHaveAttribute('aria-disabled', 'true'));
    const open = within(row).getByRole('button', { name: /Open Boros position/ });
    expect(open).not.toBeDisabled();
    expect(open.className).not.toMatch(/grass|gold/);
    open.focus();
    expect(open).toHaveFocus();
    expect(await blockedReason(user, open)).toBe(NET_HL_30);
    await user.click(open);
    expect(prefill.current).toBeNull();
  });

  it.each([50 / PX, 6_000_000 / PX])('#82 a blocked open-both bundle button is not natively disabled (%s ETH)', async (q) => {
    server.use(http.get('/api/boros/pair/context', () => new Promise<never>(() => {})));
    const user = userEvent.setup();
    renderCard(groupOf([`G L ${q}`, `H S ${q}`, `H LONG ${q} O`]), { [KEY_101]: 'all' });
    await openBundle(user, /Hyperliquid/);
    const opens = await waitFor(() => {
      const found = screen.getAllByRole('button', { name: /Open (both )?Boros (positions?|on both venues)/ });
      expect(found.length).toBeGreaterThan(0);
      expect(found.every(isDead)).toBe(true);
      return found;
    });
    for (const b of opens) expect(b).not.toBeDisabled();
    expect(await blockedReasons(user, opens)).toContain(NET_HL_30);
    for (const b of opens) await user.click(b);
    expect(prefill.current).toBeNull();
  });

  it.each([50 / PX, 6_000_000 / PX])('#75 the netting spread row names the excluded spread (%s ETH)', async (q) => {
    const spreadId = 900 + DATES.O;
    listMarkets([spreadRow(DATES.O)]);
    const user = userEvent.setup();
    renderCard(groupOf([`G L ${q}`, `H S ${q}`, `H-G LONG ${q} O`], { 101: { marketId: spreadId } }), { [`boros:${spreadId}`]: 'all' });
    await showPairs(user);
    const card = await pickBorosCard(/No Boros position/);
    const open = await waitFor(() => {
      const dead = opensIn(card, 'Open position').filter(isDead);
      expect(dead).toHaveLength(1);
      return dead[0];
    });
    expect(await blockedReason(user, open)).toBe('Spread HL-GATE Long at 30 Oct is excluded. Opening here would offset it: Boros keeps one position per market. Pick another date or restore it.');
    expect(open.className).not.toMatch(/grass|gold/);
    expect(textOf(card)).not.toContain('would offset it');
    expect(within(card).queryByRole('button', { name: /^Open (both )?Boros (positions?|on both venues)$/ })).toBeNull();
    await user.click(open);
    expect(prefill.current).toBeNull();
  });

  it.each([50 / PX, 6_000_000 / PX])('#75 a netting spread with singles listed shows its reason once (%s ETH)', async (q) => {
    const spreadId = 900 + DATES.O;
    const singles = [singleRow('Gate', DATES.O), singleRow('Hyperliquid', DATES.O)];
    server.use(
      http.get('/api/boros/pair/context', () =>
        HttpResponse.json(env({ markets: singles, spreadMarkets: [spreadRow(DATES.O)], crossByToken: [], isolatedByMarket: [], defaultSlippageApr: 0.0025, maxSlippageApr: 0.1 })),
      ),
    );
    const user = userEvent.setup();
    renderCard(groupOf([`G L ${q}`, `H S ${q}`, `H-G LONG ${q} O`], { 101: { marketId: spreadId } }), { [`boros:${spreadId}`]: 'all' });
    await showPairs(user);
    const card = await pickBorosCard(/No Boros position/);
    const open = await waitFor(() => {
      const dead = opensIn(card, 'Open position').filter(isDead);
      expect(dead).toHaveLength(1);
      return dead[0];
    });
    expect(await blockedReason(user, open)).toBe('Spread HL-GATE Long at 30 Oct is excluded. Opening here would offset it: Boros keeps one position per market. Pick another date or restore it.');
    expect(within(card).queryByRole('button', { name: /^Open (both )?Boros (positions?|on both venues)$/ })).toBeNull();
    await user.click(open);
    expect(prefill.current).toBeNull();
  });

  it.each([50 / PX, 6_000_000 / PX])('#75 a live Open position does not carry the pair net sentence (%s ETH)', async (q) => {
    listSingles([singleRow('Gate', DATES.N), singleRow('Hyperliquid', DATES.O)]);
    const user = userEvent.setup();
    renderCard(groupOf([`G L ${q}`, `H S ${q}`, `G SHORT ${q} O`]), { [KEY_101]: 'all' });
    await showPairs(user);
    const card = await pickBorosCard(/Boros positions missing/);
    const live = await waitFor(() => {
      const found = opensIn(card, 'Open position').filter((b) => !isDead(b));
      expect(found).toHaveLength(2);
      return found;
    });
    const pairOpen = within(card).getByRole('button', { name: 'Open both Boros positions' });
    expect(isDead(pairOpen)).toBe(true);
    expect(pairOpen.className).not.toMatch(/grass|gold/);
    expect(pairOpen).not.toBeDisabled();
    expect(await blockedReason(user, pairOpen)).toMatch(/^Gate Short at 30 Oct is excluded\. Opening here would offset it: Boros keeps one position per market\. Pick another date or restore it\.$/);
    await user.click(pairOpen);
    expect(prefill.current).toBeNull();
    expect(live.map((b) => b.title)).toEqual([
      expect.stringMatching(/^Open only the Gate Long Boros position, at \S+ ETH$/),
      expect.stringMatching(/^Open only the Hyperliquid Short Boros position, at \S+ ETH$/),
    ]);
  });

  it.each([...RUNGS.map((usd) => usd / PX), 1_200])('close a slice of a part-excluded leg sends the slice (%s ETH)', async (row) => {
    const user = userEvent.setup();
    renderCard(groupOf([`G LONG ${row * 3} N`]), { [KEY_101]: { qty: row * 2 } });
    await showPairs(user);
    await openUngrouped(user);
    await user.click(screen.getByRole('button', { name: 'Close Gate Long YU' }));
    expect(await closeSize()).toBe(row);
  });

  it.each([50 / PX, 6_000_000 / PX])('bundle close of a part-excluded leg sends the kept part (%s ETH)', async (row) => {
    const user = userEvent.setup();
    renderCard(groupOf([`G LONG ${row * 3} N`]), { [KEY_101]: { qty: row * 2 } });
    await user.click(screen.getByRole('tab', { name: /^Funding Bundles/ }));
    const bundle = await waitFor(() => screen.getAllByRole('button', { name: /Gate/ }).find((b) => b.hasAttribute('aria-expanded')) as HTMLElement);
    if (bundle.getAttribute('aria-expanded') === 'false') await user.click(bundle);
    await user.click(await screen.findByRole('button', { name: 'Close Gate Long YU' }));
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
    await clickExclude(user, closeRow('Close Hyperliquid Short YU'));
    await waitFor(() => expect(patches).toHaveLength(1));
  }

  it('the row popup saves one PATCH, and Restore takes it back', async () => {
    const user = userEvent.setup();
    renderHome();
    await excludeHyperliquidShort(user);
    expect(patches[0]).toEqual({ exclusions: { [KEY_104]: { qty: 1 } } });
    expect(screen.queryByRole('alert')).toBeNull();
    await user.click(within(await waitFor(() => excludedBlock())).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(patches).toHaveLength(2));
    expect(patches[1]).toEqual({ exclusions: { [KEY_104]: null } });
    await openUngrouped(user);
    expect(closeRow('Close Hyperliquid Short YU')).toBeInTheDocument();
  });

  it('a failed save from the row popup says so and keeps the leg', async () => {
    patchStatus = 500;
    const user = userEvent.setup();
    renderHome();
    await excludeHyperliquidShort(user);
    expect(await screen.findByText('Could not save. Try again.')).toBeInTheDocument();
    await openUngrouped(user);
    expect(closeRow('Close Hyperliquid Short YU')).toBeInTheDocument();
    expect(stored.exclusions[KEY_104]).toBeUndefined();
  });

});
