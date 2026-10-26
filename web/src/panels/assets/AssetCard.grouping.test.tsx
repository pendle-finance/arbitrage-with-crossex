import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionInput, AssetGroup, PreviewResponse } from '../../api/types';
import { ADDRESS, DATES, NOW, PX, PrefillProbe, cardList, cardsTitled, expand, groupOf, hedgedCards, listMarkets, prefill, showPairs, spreadRow, textOf } from '../../test/assetCardBooks';
import { previewFor } from '../../test/fixtures';
import { env, server } from '../../test/server';
import { renderWithClient } from '../../test/utils';
import { STRATEGY_STORAGE_KEY } from '../HomeControls';
import { AssetCard } from './AssetCard';
import { blockedReason, blockedReasons } from '../../test/blockedReason';
import { deriveAsset } from './assetModel';

function renderCard(group: AssetGroup) {
  return renderWithClient(
    <>
      <AssetCard
        group={group}
        derived={deriveAsset(group, {}, 0, NOW)}
        sinceSec={0}
        windowPending={false}
        storedSinceSec={undefined}
        defaultSinceSec={null}
        backfilling={false}
        supportedCoins={['ETH']}
        onChangeSince={() => {}}
        exclusions={{}}
        onExclude={() => {}}
      />
      <PrefillProbe />
    </>,
  );
}

const B15_HELD_TEN = ['G L 10', 'H S 10', 'G LONG 6 O', 'G LONG 4 N', 'H SHORT 10 O'];
const B15_CLOSED_FOUR = ['G L 10', 'H S 10', 'G LONG 6 O', 'G LONG 4 N', 'H SHORT 6 O'];
const B21 = ['G L 1', 'H S 1', 'H LONG 1 O'];
const RUNGS = [50, 5_000, 100_000, 1_000_000, 6_000_000];

function previewSpy(): ActionInput[][] {
  const seen: ActionInput[][] = [];
  server.use(
    http.post('/api/preview', async ({ request }) => {
      seen.push(((await request.clone().json()) as { actions: ActionInput[] }).actions);
      const { actions } = (await request.clone().json()) as { actions: ActionInput[] };
      return HttpResponse.json(
        env<PreviewResponse>({
          previews: actions.map((a) =>
            previewFor(a, { side: 'SELL', type: 'LIMIT', tif: 'IOC', reduceOnly: true, qty: '1', price: String(PX), estNotional: PX, closing: { positionQty: '1', upnl: '0', mark: PX } }),
          ),
        }),
      );
    }),
  );
  return seen;
}
const deadOpens = (el: HTMLElement) => within(el).queryAllByRole('button', { name: 'Open leg' }).filter((b) => b.getAttribute('aria-disabled') === 'true');
async function openLegTexts(user: ReturnType<typeof userEvent.setup>, el: HTMLElement): Promise<string[]> {
  const opens = within(el).getAllByRole('button', { name: 'Open leg' });
  const live = opens.filter((b) => b.getAttribute('aria-disabled') !== 'true').map((b) => b.title);
  return [...live, ...(await blockedReasons(user, opens.filter((b) => b.getAttribute('aria-disabled') === 'true')))];
}
const closeQtys = (actions: ActionInput[] | undefined) =>
  Object.fromEntries((actions ?? []).map((a) => [a.kind === 'close-position' ? a.symbol : a.kind, a.kind === 'close-position' ? a.qty : undefined]));

beforeEach(() => {
  prefill.current = null;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-23T00:00:00Z'));
  localStorage.setItem(STRATEGY_STORAGE_KEY, JSON.stringify({ address: ADDRESS }));
  server.use(http.get('/api/positions', () => HttpResponse.json({ positions: [] })));
  listMarkets([]);
});

describe('the card, by the grouping DoD', () => {
  it('half roll: no open while the old leg is held', async () => {
    const user = userEvent.setup();
    renderCard(groupOf(B15_HELD_TEN));
    await showPairs(user);
    const [card] = await waitFor(() => {
      const found = cardsTitled(/Boros leg missing/);
      expect(found).toHaveLength(1);
      return found;
    });
    const open = within(card).getByRole('button', { name: 'Open leg' });
    expect(open).toHaveAttribute('aria-disabled', 'true');
    expect(await blockedReason(user, open)).toBe('Hyperliquid SHORT holds 10 ETH at 30 Oct. Close 4 ETH of it to open here.');
    expect(textOf(open.closest('tr') as HTMLElement)).not.toContain(' holds ');
    expect(textOf(card)).not.toContain('to open here');
    await user.click(open);
    expect(prefill.current).toBeNull();
    expect(within(card).queryByRole('button', { name: /^Open (both )?Boros leg/ })).toBeNull();
  });

  it('half roll: open after the old leg is closed', async () => {
    const user = userEvent.setup();
    renderCard(groupOf(B15_CLOSED_FOUR));
    await showPairs(user);
    const [card] = await waitFor(() => {
      const found = cardsTitled(/Boros leg missing/);
      expect(found).toHaveLength(1);
      return found;
    });
    expect(textOf(card)).not.toContain(' holds ');
    await user.click(within(card).getByRole('button', { name: 'Open leg' }));
    await waitFor(() => expect(prefill.current).not.toBeNull());
    expect(prefill.current).toMatchObject({ base: 'ETH', longVenue: null, shortVenue: 'HYPERLIQUID', maturity: DATES.N, sizeBase: 4 });
  });

  it('offer date after a half roll', async () => {
    const user = userEvent.setup();
    listMarkets([spreadRow(DATES.O), spreadRow(DATES.N)]);
    renderCard(groupOf(['G L 2', 'H S 2', ...B15_CLOSED_FOUR]));
    await showPairs(user);
    const [card] = await waitFor(() => {
      const found = cardsTitled(/no rate leg/);
      expect(found).toHaveLength(1);
      return found;
    });
    expect(cardsTitled(/Boros leg missing/)).toHaveLength(2);
    await user.click(await within(card).findByRole('button', { name: 'Open Boros leg' }));
    await waitFor(() => expect(prefill.current).not.toBeNull());
    expect(prefill.current).toMatchObject({ longVenue: 'GATE', shortVenue: 'HYPERLIQUID', maturity: DATES.N, sizeBase: 2 });
  });

  it('a leg on another card does not cut the offer', async () => {
    const user = userEvent.setup();
    renderCard(groupOf(['G L 10', 'H S 10', 'G LONG 10 N', 'LI SHORT 10 N']));
    await showPairs(user);
    const [card] = await waitFor(() => {
      const found = cardsTitled(/Boros legs missing/);
      expect(found).toHaveLength(1);
      return found;
    });
    expect(cardsTitled(/Perp legs? missing/)).toHaveLength(1);
    expect(textOf(card)).not.toContain(' holds ');
    const texts = await openLegTexts(user, card);
    expect(texts.length).toBeGreaterThan(0);
    for (const t of texts) expect(t).not.toContain(' holds ');
    await user.click(await within(card).findByRole('button', { name: 'Open both Boros legs' }));
    await waitFor(() => expect(prefill.current).not.toBeNull());
    expect(prefill.current).toMatchObject({ longVenue: 'GATE', shortVenue: 'HYPERLIQUID', sizeBase: 10 });
  });

  it("no Boros leg anywhere: today's date rule", async () => {
    listMarkets([spreadRow(DATES.N), spreadRow(DATES.O)]);
    const user = userEvent.setup();
    renderCard(groupOf(['G L 1', 'H S 1']));
    await showPairs(user);
    await user.click(await screen.findByRole('button', { name: 'Open Boros leg' }));
    await waitFor(() => expect(prefill.current).not.toBeNull());
    expect(prefill.current).toMatchObject({ maturity: DATES.O });
  });

  it('latest date with no open market', async () => {
    const book = ['G L 2', 'H S 2', ...B15_CLOSED_FOUR];
    listMarkets([spreadRow(DATES.O), spreadRow(DATES.N, true), spreadRow(DATES.D)]);
    const user = userEvent.setup();
    const first = renderCard(groupOf(book));
    await showPairs(user);
    const [card] = await waitFor(() => {
      const found = cardsTitled(/no rate leg/);
      expect(found).toHaveLength(1);
      return found;
    });
    await user.click(await within(card).findByRole('button', { name: 'Open Boros leg' }));
    await waitFor(() => expect(prefill.current).not.toBeNull());
    expect(prefill.current).toMatchObject({ maturity: DATES.D });
    first.unmount();

    prefill.current = null;
    listMarkets([spreadRow(DATES.N, true)]);
    renderCard(groupOf(book));
    await showPairs(user);
    const [again] = await waitFor(() => {
      const found = cardsTitled(/no rate leg/);
      expect(found).toHaveLength(1);
      return found;
    });
    await user.click(await within(again).findByRole('button', { name: 'Open both Boros legs' }));
    await waitFor(() => expect(prefill.current).not.toBeNull());
    expect(prefill.current).toMatchObject({ maturity: DATES.O });
  });

  it('ED-6648 shared long closes once', async () => {
    const user = userEvent.setup();
    renderCard(groupOf(['G L 2', 'H S 1', 'LI S 1', 'G LONG 2 N', 'H SHORT 1 N', 'LI SHORT 1 N']));
    await showPairs(user);
    const card = await waitFor(() => {
      const found = hedgedCards().filter((el) => /Hyperliquid/.test(textOf(el)));
      expect(found).toHaveLength(1);
      return found[0];
    });
    await expand(user, card);
    await user.click(within(card).getByRole('button', { name: 'Close perps' }));
    const dialog = await screen.findByRole('dialog');
    const text = textOf(dialog);
    expect(text).toMatch(/PerpGate.*?pair slice1 ETH.*?PerpHyperliquid.*?whole position1 ETH/);
    expect(text).not.toMatch(/\b2 ETH/);
  });

  it('ED-6648 spread on other venues', async () => {
    const user = userEvent.setup();
    renderCard(groupOf(['G L 1', 'H S 1', 'LI-G SHORT 1 N']));
    await showPairs(user);
    await waitFor(() => expect(cardsTitled(/Boros legs missing/)).toHaveLength(1));
    const perpMissing = cardsTitled(/Perp legs? missing/);
    expect(perpMissing).toHaveLength(1);
    expect(textOf(perpMissing[0])).toMatch(/Lighter/);
    const borosMissing = cardsTitled(/Boros legs missing/)[0];
    expect(textOf(borosMissing)).not.toContain(' holds ');
    const texts = await openLegTexts(user, borosMissing);
    expect(texts.length).toBeGreaterThan(0);
    for (const t of texts) expect(t).not.toContain(' holds ');
    expect(await within(borosMissing).findByRole('button', { name: 'Open both Boros legs' })).toBeInTheDocument();
    expect(textOf(borosMissing)).toMatch(/Gate/);
    expect(textOf(borosMissing)).toMatch(/Hyperliquid/);
  });

  it('close perps sends the row size', async () => {
    const user = userEvent.setup();
    const seen = previewSpy();
    renderCard(groupOf(['G L 0.949', 'H S 0.95', 'G LONG 0.949 N', 'H SHORT 0.949 N']));
    await showPairs(user);
    const [card] = await waitFor(() => {
      const found = hedgedCards();
      expect(found).toHaveLength(1);
      return found;
    });
    await expand(user, card);
    await user.click(within(card).getByRole('button', { name: 'Close perps' }));
    const text = textOf(await screen.findByRole('dialog'));
    expect(text).toMatch(/PerpGate.*?position0\.949 ETH.*?PerpHyperliquid.*?position0\.95 ETH/);
    await waitFor(() => expect(seen.length).toBeGreaterThan(0), { timeout: 4000 });
    expect(closeQtys(seen.at(-1))).toEqual({ GATE_FUTURE_ETH_USDT: undefined, HYPERLIQUID_FUTURE_ETH_USDT: undefined });
  });

  it.each(RUNGS)('S-CLOSE-02 a row short of its venue position sends its own size at every rung ($%i)', async (usd) => {
    const hl = usd / PX;
    const gate = Number((hl * 0.9996).toPrecision(8));
    const lighter = Number((hl - gate).toPrecision(8));
    const ownCard = 2 * lighter * PX >= 50;
    const user = userEvent.setup();
    const seen = previewSpy();
    renderCard(groupOf([`H L ${hl}`, `G S ${gate}`, `LI S ${lighter}`, `H LONG ${hl} N`, `G SHORT ${gate} N`, `LI SHORT ${lighter} N`]));
    await showPairs(user);
    const card = await waitFor(() => {
      const found = cardList().filter((el) => /Gate/.test(textOf(el)) && !/Ungrouped legs/.test(textOf(el)));
      expect(found).toHaveLength(1);
      return found[0];
    });
    await expand(user, card);
    await user.click(within(card).getByRole('button', { name: 'Close perps' }));
    await waitFor(() => expect(seen.length).toBeGreaterThan(0), { timeout: 4000 });
    expect(closeQtys(seen.at(-1))).toEqual({ HYPERLIQUID_FUTURE_ETH_USDT: ownCard ? String(gate) : undefined, GATE_FUTURE_ETH_USDT: undefined });
  });

  it.each(RUNGS)('S-OPEN-01 open prefill prices the capped size at every rung ($%i)', async (usd) => {
    const size = usd / PX;
    const user = userEvent.setup();
    renderCard(groupOf([`G L ${Number((size * 1.0003).toPrecision(8))}`, `H S ${size}`]));
    await showPairs(user);
    await user.click(await screen.findByRole('button', { name: 'Open both Boros legs' }));
    await waitFor(() => expect(prefill.current).not.toBeNull());
    const armed = prefill.current as { size: number; sizeBase: number };
    expect(armed.sizeBase).toBe(size);
    expect(armed.size).toBe(size * PX);
  });

  it('blocked row says why', async () => {
    const user = userEvent.setup();
    renderCard(groupOf(B21));
    await showPairs(user);
    const [card] = await waitFor(() => {
      const found = cardsTitled(/Boros legs missing/);
      expect(found).toHaveLength(1);
      return found;
    });
    expect(await blockedReasons(user, deadOpens(card))).toContain('Close the Wrong side Hyperliquid LONG at 30 Oct to open here.');
    expect(textOf(card)).not.toContain('to open here');
  });

  it('every leg row shows its venue icon, on both tabs', async () => {
    const user = userEvent.setup();
    renderCard(groupOf(B15_HELD_TEN));
    const legRows = () =>
      [...document.querySelectorAll('tbody tr')].filter((tr) => /^(Perp|Boros)?(Gate|Hyperliquid)/.test(tr.querySelector('td')?.textContent ?? '')) as HTMLElement[];
    const iconless = () => legRows().filter((tr) => !tr.querySelector('td img')).map(textOf);
    await showPairs(user);
    const ungrouped = cardList().find((el) => /Ungrouped legs/.test(textOf(el))) as HTMLElement;
    await expand(user, ungrouped);
    expect(legRows().length).toBeGreaterThanOrEqual(6);
    expect(iconless()).toEqual([]);
    await user.click(screen.getByRole('tab', { name: /^Funding Bundles/ }));
    for (const b of screen.getAllByRole('button').filter((x) => x.getAttribute('aria-expanded') === 'false' && /Gate|Hyperliquid/.test(textOf(x)))) await user.click(b);
    await waitFor(() => expect(legRows().filter((tr) => /^(Perp|Boros)/.test(textOf(tr))).length).toBeGreaterThanOrEqual(4));
    expect(iconless()).toEqual([]);
  });

  describe('Funding Bundles never opens into a Wrong side leg', () => {
    const FLIP_O = 'Close the Wrong side Hyperliquid LONG at 30 Oct to open here.';
    const borosOpens = () => screen.queryAllByRole('button', { name: /^(open (both )?Boros legs?|Open more)$/ });
    const isDead = (b: HTMLElement) => b.getAttribute('aria-disabled') === 'true';
    async function showBundles(user: ReturnType<typeof userEvent.setup>) {
      await user.click(screen.getByRole('tab', { name: /^Funding Bundles/ }));
      for (const name of [/Gate/, /Hyperliquid/]) {
        const bundle = screen.getAllByRole('button', { name }).find((b) => b.getAttribute('aria-expanded') === 'false');
        if (bundle) await user.click(bundle);
      }
    }

    it.each(RUNGS.map((usd) => usd / PX))('Open more on the Wrong side leg is grey; Gate still opens its own leg (%s ETH)', async (q) => {
      const user = userEvent.setup();
      renderCard(groupOf([`G L ${q}`, `H S ${q}`, `H LONG ${q} O`]));
      await showBundles(user);
      const more = await screen.findByRole('button', { name: 'Open more' });
      expect(more).toHaveAttribute('aria-disabled', 'true');
      expect(await blockedReason(user, more)).toBe(FLIP_O);
      await user.click(more);
      expect(prefill.current).toBeNull();
      const live = borosOpens().filter((b) => !isDead(b));
      expect(live.map((b) => textOf(b.closest('tr') as HTMLElement))).toEqual([expect.stringMatching(/^BorosGate/)]);
      await user.click(live[0]);
      await waitFor(() => expect(prefill.current).toMatchObject({ longVenue: 'GATE', shortVenue: null }));
    });

    it('a missing row is grey when a Wrong side leg at another date would net', async () => {
      const user = userEvent.setup();
      renderCard(groupOf(['G L 1', 'H S 1', 'G LONG 1 O', 'H SHORT 0.5 O', 'H LONG 0.5 N']));
      await showBundles(user);
      const open = await screen.findByRole('button', { name: 'open Boros leg' });
      expect(open).toHaveAttribute('aria-disabled', 'true');
      expect(await blockedReason(user, open)).toBe('Close the Wrong side Hyperliquid LONG at 27 Nov to open here.');
      await user.click(open);
      expect(prefill.current).toBeNull();
    });

    it('a dust Wrong side leg does not block', async () => {
      const user = userEvent.setup();
      renderCard(groupOf(['G L 1', 'H S 1', 'H LONG 0.008 O']));
      await showBundles(user);
      const opens = await waitFor(() => {
        const found = borosOpens();
        expect(found.length).toBeGreaterThan(0);
        return found;
      });
      expect(opens.filter(isDead)).toEqual([]);
    });
  });

  it('a Wrong side row has a faint red tint, the missing rows do not', async () => {
    const user = userEvent.setup();
    renderCard(groupOf(B21));
    await showPairs(user);
    const row = (await screen.findByText('Wrong side')).closest('tr') as HTMLElement;
    expect(row).toHaveClass('bg-guava/[0.04]');
    const [card] = cardsTitled(/Boros legs missing/);
    for (const b of deadOpens(card)) expect(b.closest('tr')).not.toHaveClass('bg-guava/[0.04]');
  });

  it('blocked row says why when a spread blocks it', async () => {
    const user = userEvent.setup();
    renderCard(groupOf(['G L 1', 'H S 1', 'H-G LONG 1 N']));
    await showPairs(user);
    const [card] = await waitFor(() => {
      const found = cardsTitled(/Boros legs missing/);
      expect(found).toHaveLength(1);
      return found;
    });
    const line = 'Close the Wrong side Spread HL-GATE LONG at 27 Nov to open here.';
    expect(await blockedReasons(user, deadOpens(card))).toEqual([line, line]);
    expect(textOf(card)).not.toContain('to open here');
  });

  it('blocked row names the Wrong side leg that blocks, not a small one before it', async () => {
    const user = userEvent.setup();
    renderCard(groupOf(['G L 2', 'H S 2', 'H LONG 0.008 O', 'H LONG 2 N']));
    await showPairs(user);
    const [card] = await waitFor(() => {
      const found = cardsTitled(/Boros legs missing/);
      expect(found).toHaveLength(1);
      return found;
    });
    const titles = await blockedReasons(user, deadOpens(card));
    expect(titles).toContain('Close the Wrong side Hyperliquid LONG at 27 Nov to open here.');
    expect(titles.join(' ')).not.toContain('Close the Wrong side Hyperliquid LONG at 30 Oct');
  });

  it('the wrong-side hover names the venue the spread points against', async () => {
    const user = userEvent.setup();
    renderCard(groupOf(['G L 1', 'LI S 1', 'H-G LONG 1 N']));
    await showPairs(user);
    await user.hover(await screen.findByText('Wrong side'));
    expect(await screen.findByRole('tooltip')).toHaveTextContent("Adds to the Gate perp's funding risk.");
  });

  it('an open-only roll card carries no line about the perps on other cards', async () => {
    const user = userEvent.setup();
    renderCard(groupOf(['G L 10', 'H S 10', 'G LONG 10 O', 'H SHORT 10 O', 'G LONG 10 N', 'H SHORT 10 N']));
    await showPairs(user);
    await waitFor(() => expect(cardsTitled(/Perp legs missing/)).toHaveLength(1));
    for (const el of screen.getAllByRole('row')) {
      expect(textOf(el)).not.toContain('is on another card');
      expect(textOf(el)).not.toContain('is in Ungrouped');
    }
  });

  it('a USDC twin adds no other-card line', async () => {
    const user = userEvent.setup();
    const book = groupOf(['G L 4', 'H S 4', 'G LONG 4 O', 'H SHORT 4 O', 'G LONG 4 N', 'H SHORT 4 N']);
    book.perpOpen.unshift({ ...book.perpOpen[0], symbol: 'GATE_FUTURE_ETH_USDC', qty: 3, notionalUsd: 3 * PX, quoteTwin: true });
    renderCard(book);
    await showPairs(user);
    const [card] = await waitFor(() => {
      const found = cardsTitled(/Perp legs missing/);
      expect(found).toHaveLength(1);
      return found;
    });
    expect(textOf(card)).not.toContain('The other ');
    expect(textOf(card)).not.toContain('is in Ungrouped');
    const ungrouped = cardList().find((el) => /Ungrouped legs/.test(textOf(el))) as HTMLElement;
    await expand(user, ungrouped);
    expect(textOf(ungrouped)).toContain('USDC perp · no Boros hedge');
  });

  it('close-first hover only when it blocks', async () => {
    const user = userEvent.setup();
    const first = renderCard(groupOf(B21));
    await showPairs(user);
    const blocking = await screen.findByText('Wrong side');
    await user.hover(blocking);
    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveTextContent("Adds to the Hyperliquid perp's funding risk.");
    expect(tip).toHaveTextContent('Close it, then open the hedge.');
    first.unmount();

    renderCard(groupOf(['G L 1', 'H S 1', 'H LONG 0.008 O']));
    await showPairs(user);
    await user.hover(await screen.findByText('Wrong side'));
    const free = await screen.findByRole('tooltip');
    expect(free).toHaveTextContent("Adds to the Hyperliquid perp's funding risk.");
    expect(free).not.toHaveTextContent('Close it');
  });
});
