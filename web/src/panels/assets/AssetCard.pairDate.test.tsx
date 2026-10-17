/**
 * Split-by-size cases 4, 5 and 6 (owner 2026-10-16): the size "Open both
 * perps" arms on a spread unit, and the date a Boros open arms when the unit
 * holds no rate leg (rule A1), the same on both tabs.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AssetBorosOpen, AssetGroup, AssetPerpOpen } from '../../api/types';
import { server } from '../../test/server';
import { renderWithClient } from '../../test/utils';
import { useTradeFlowOptional } from '../../trade/TradeFlow';
import { STRATEGY_STORAGE_KEY } from '../HomeControls';
import { AssetCard } from './AssetCard';
import { deriveAsset } from './assetModel';
import { fmtDateShort } from '../../lib/fmt';

const ADDRESS = '0x1111111111111111111111111111111111111111';
const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);
const SOON = NOW + 2 * DAY;
const NOV = NOW + 42 * DAY;
const DEC = NOW + 70 * DAY;
const FEB = NOW + 133 * DAY;

const pxOf: Record<string, number> = { BTC: 80_000, ETH: 2_500, HYPE: 40 };

const perp = (base: string, venue: string, side: 'LONG' | 'SHORT', qty: number): AssetPerpOpen => ({
  symbol: `${venue}_FUTURE_${base}_USDT`,
  venue,
  side,
  qty,
  notionalUsd: qty * pxOf[base],
  entryPrice: pxOf[base],
  markPrice: pxOf[base],
  leverage: 10,
  upnlUsd: 0,
  fundingUsd: 0,
  feesUsd: 0,
  imUsd: qty * pxOf[base] * 0.1,
  openedAt: NOW - 2 * DAY,
});

let mid = 100;
const leg = (
  base: string,
  venue: string,
  side: 'LONG' | 'SHORT',
  sizeToken: number,
  maturity: number,
  spreadVenues: [string, string] | null = null,
): AssetBorosOpen => ({
  marketId: mid++,
  venue,
  spreadVenues,
  side,
  sizeToken,
  maturity,
  collateral: base === 'HYPE' ? 'USDT' : base,
  notionalUsd: sizeToken * pxOf[base],
  entryApr: 0.05,
  markApr: 0.05,
  floatingApr: 0.04,
  settleUsd: 0,
  mtmUsd: 0,
  imUsd: sizeToken * pxOf[base] * 0.01,
});

const book = (base: string, perpOpen: AssetPerpOpen[], borosOpen: AssetBorosOpen[]): AssetGroup => ({
  base,
  supported: true,
  priceUsd: pxOf[base],
  earliestSec: NOW - 10 * DAY,
  perpOpen,
  perpClosed: [],
  borosOpen,
  borosHistory: [],
});

const spreadRow = (maturity: number, over: Record<string, unknown> = {}) => ({
  marketId: 5_000 + maturity % 1_000,
  name: 'BTC Spread',
  venue: 'HL-GATE',
  base: 'BTC',
  tokenId: 1,
  collateral: 'BTC',
  maturity,
  midApr: 0.03,
  markApr: 0.03,
  maxRateDeviationApr: 0.02,
  spreadVenues: ['HYPERLIQUID', 'GATE'],
  isolatedOnly: false,
  onIsolatedMargin: false,
  isolatedHasPositionOrOrders: false,
  currentSize: 0,
  collateralPriceUsd: 80_000,
  closeOnly: false,
  ...over,
});

const listSpreads = (spreadMarkets: unknown[]) =>
  server.use(
    http.get('/api/boros/pair/context', () =>
      HttpResponse.json({
        ok: true,
        data: { markets: [], spreadMarkets, crossByToken: [], isolatedByMarket: [], defaultSlippageApr: 0.0025, maxSlippageApr: 0.1 },
      }),
    ),
  );

let flow: ReturnType<typeof useTradeFlowOptional> = null;
function Probe() {
  flow = useTradeFlowOptional();
  return null;
}

const renderCard = (group: AssetGroup) =>
  renderWithClient(
    <>
      <AssetCard
        group={group}
        derived={deriveAsset(group, {}, 0, NOW)}
        sinceSec={0}
        windowPending={false}
        storedSinceSec={undefined}
        defaultSinceSec={null}
        backfilling={false}
        supportedCoins={[group.base]}
        onChangeSince={() => {}}
        exclusions={{}}
        onExclude={() => {}}
      />
      <Probe />
    </>,
  );

beforeEach(() => {
  flow = null;
  localStorage.setItem(STRATEGY_STORAGE_KEY, JSON.stringify({ address: ADDRESS }));
  server.use(http.get('/api/positions', () => HttpResponse.json({ positions: [] })));
  listSpreads([]);
});

describe('case 4: "Open both perps" on a Boros-only unit arms the full hedge per side', () => {
  it('a $400k HYPE spread leg arms $400k per side, not $200k', async () => {
    const user = userEvent.setup();
    renderCard(book('HYPE', [], [leg('HYPE', 'HYPERLIQUID', 'SHORT', 10_000, NOV, ['HYPERLIQUID', 'GATE'])]));
    await user.click(await screen.findByRole('button', { name: 'Open both perps' }));
    await waitFor(() => expect(flow?.pairPrefill).not.toBeNull());
    expect(flow?.pairPrefill).toMatchObject({ base: 'HYPE', longVenue: 'GATE', shortVenue: 'HYPERLIQUID', notionalUsd: 400_000, sizeUnit: 'usd' });
    expect(flow?.pairPrefill?.sizeBase).toBeUndefined();
  });

  it('a $6M HYPE spread leg arms $6M per side', async () => {
    const user = userEvent.setup();
    renderCard(book('HYPE', [], [leg('HYPE', 'HYPERLIQUID', 'SHORT', 150_000, NOV, ['HYPERLIQUID', 'GATE'])]));
    await user.click(await screen.findByRole('button', { name: 'Open both perps' }));
    await waitFor(() => expect(flow?.pairPrefill).not.toBeNull());
    expect(flow?.pairPrefill?.notionalUsd).toBeCloseTo(6_000_000, 2);
  });

  it('a $50 HYPE spread leg arms $50 per side', async () => {
    const user = userEvent.setup();
    renderCard(book('HYPE', [], [leg('HYPE', 'HYPERLIQUID', 'SHORT', 1.25, NOV, ['HYPERLIQUID', 'GATE'])]));
    await user.click(await screen.findByRole('button', { name: 'Open both perps' }));
    await waitFor(() => expect(flow?.pairPrefill).not.toBeNull());
    expect(flow?.pairPrefill?.notionalUsd).toBeCloseTo(50, 9);
  });

  it('a HYPE singles unit keeps one leg per side: $400k + $400k arms $400k', async () => {
    const user = userEvent.setup();
    renderCard(book('HYPE', [], [leg('HYPE', 'GATE', 'LONG', 10_000, NOV), leg('HYPE', 'HYPERLIQUID', 'SHORT', 10_000, NOV)]));
    await user.click(await screen.findByRole('button', { name: 'Open both perps' }));
    await waitFor(() => expect(flow?.pairPrefill).not.toBeNull());
    expect(flow?.pairPrefill).toMatchObject({ notionalUsd: 400_000, sizeUnit: 'usd' });
  });

  it('an ETH spread leg arms its coin size, and the one leg as the dollar figure', async () => {
    const user = userEvent.setup();
    renderCard(book('ETH', [], [leg('ETH', 'HYPERLIQUID', 'SHORT', 2, NOV, ['HYPERLIQUID', 'GATE'])]));
    await user.click(await screen.findByRole('button', { name: 'Open both perps' }));
    await waitFor(() => expect(flow?.pairPrefill).not.toBeNull());
    expect(flow?.pairPrefill).toMatchObject({ sizeBase: 2, sizeUnit: 'base', notionalUsd: 5_000 });
  });

  it('an ETH singles unit arms its coin size and one leg in dollars', async () => {
    const user = userEvent.setup();
    renderCard(book('ETH', [], [leg('ETH', 'GATE', 'LONG', 100, NOV), leg('ETH', 'HYPERLIQUID', 'SHORT', 100, NOV)]));
    await user.click(await screen.findByRole('button', { name: 'Open both perps' }));
    await waitFor(() => expect(flow?.pairPrefill).not.toBeNull());
    expect(flow?.pairPrefill).toMatchObject({ sizeBase: 100, sizeUnit: 'base', notionalUsd: 250_000 });
  });
});

/** Binance / Lighter fully hedged at `at`, plus Gate / Hyperliquid perps with no Boros leg. */
const case6Book = (at: number[] = [DEC]) =>
  book(
    'BTC',
    [
      perp('BTC', 'GATE', 'LONG', 1),
      perp('BTC', 'HYPERLIQUID', 'SHORT', 1),
      ...(at.length > 0 ? [perp('BTC', 'BINANCE', 'LONG', at.length), perp('BTC', 'LIGHTER', 'SHORT', at.length)] : []),
    ],
    at.flatMap((m) => [leg('BTC', 'BINANCE', 'LONG', 1, m), leg('BTC', 'LIGHTER', 'SHORT', 1, m)]),
  );

const showPairs = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('tab', { name: /^Fixed Rate Pairs/ }));
};

describe('case 6: rule A1 picks the date for a perps-only unit', () => {
  it.each([
    ['the case 6 book: a spread at 27 Nov only, D = 25 Dec', [NOV], NOV],
    ['a spread at D wins over an earlier one', [NOV, DEC], DEC],
    ['the latest spread before D, not one after it', [NOV, FEB], NOV],
    ['the latest of two before D', [SOON, NOV], NOV],
    ['only after D: the soonest', [FEB, FEB + 90 * DAY], FEB],
  ])('%s', async (_label, listed, want) => {
    listSpreads(listed.map((m) => spreadRow(m)));
    const user = userEvent.setup();
    renderCard(case6Book());
    await showPairs(user);
    await user.click(await screen.findByRole('button', { name: 'Open Boros leg' }));
    await waitFor(() => expect(flow?.borosOpenPrefill).not.toBeNull());
    expect(flow?.borosOpenPrefill).toMatchObject({ base: 'BTC', longVenue: 'GATE', shortVenue: 'HYPERLIQUID', maturity: want, sizeBase: 1 });
  });

  it('a close-only spread at D counts as none: the trading one before D', async () => {
    listSpreads([spreadRow(DEC, { closeOnly: true }), spreadRow(NOV)]);
    const user = userEvent.setup();
    renderCard(case6Book());
    await showPairs(user);
    await user.click(await screen.findByRole('button', { name: 'Open Boros leg' }));
    await waitFor(() => expect(flow?.borosOpenPrefill).not.toBeNull());
    expect(flow?.borosOpenPrefill?.maturity).toBe(NOV);
  });

  it('no spread listed: two singles at D, as before', async () => {
    const user = userEvent.setup();
    renderCard(case6Book());
    await showPairs(user);
    await user.click(await screen.findByRole('button', { name: 'Open both Boros legs' }));
    await waitFor(() => expect(flow?.borosOpenPrefill).not.toBeNull());
    expect(flow?.borosOpenPrefill?.maturity).toBe(DEC);
  });

  it('no live pair (no D): the soonest spread', async () => {
    listSpreads([spreadRow(FEB), spreadRow(NOV)]);
    const user = userEvent.setup();
    renderCard(case6Book([]));
    await showPairs(user);
    await user.click(await screen.findByRole('button', { name: 'Open Boros leg' }));
    await waitFor(() => expect(flow?.borosOpenPrefill).not.toBeNull());
    expect(flow?.borosOpenPrefill?.maturity).toBe(NOV);
  });

  it("a held single keeps its own date (rule 5), even with a spread listed at D", async () => {
    listSpreads([spreadRow(DEC)]);
    const g = case6Book();
    g.borosOpen.push(leg('BTC', 'GATE', 'LONG', 1, NOV));
    const user = userEvent.setup();
    renderCard(g);
    await showPairs(user);
    expect(screen.queryByRole('button', { name: 'Open Boros leg' })).toBeNull();
    await user.click(await screen.findByRole('button', { name: 'Open leg' }));
    await waitFor(() => expect(flow?.borosOpenPrefill).not.toBeNull());
    expect(flow?.borosOpenPrefill).toMatchObject({ longVenue: null, shortVenue: 'HYPERLIQUID', maturity: NOV });
  });
});

describe('case 5: the Funding Bundles pair open uses the same date as the Fixed Rate Pairs card', () => {
  /** Gate / HL hedged at 2 days and at D; new OKX long / Lighter short perps with no Boros leg. */
  const case5Book = () =>
    book(
      'BTC',
      [
        perp('BTC', 'GATE', 'LONG', 2),
        perp('BTC', 'HYPERLIQUID', 'SHORT', 2),
        perp('BTC', 'OKX', 'LONG', 1),
        perp('BTC', 'LIGHTER', 'SHORT', 1),
      ],
      [SOON, DEC].flatMap((m) => [leg('BTC', 'GATE', 'LONG', 1, m), leg('BTC', 'HYPERLIQUID', 'SHORT', 1, m)]),
    );

  const bundlesArm = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole('tab', { name: /^Funding Bundles/ }));
    await user.click(screen.getByRole('button', { name: /^OKX/ }));
    await user.click(await screen.findByRole('button', { name: 'open both Boros legs' }));
    await waitFor(() => expect(flow?.borosOpenPrefill).not.toBeNull());
    return flow?.borosOpenPrefill;
  };
  const pairsArm = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
    await showPairs(user);
    await user.click(await screen.findByRole('button', { name }));
    await waitFor(() => expect(flow?.borosOpenPrefill).not.toBeNull());
    return flow?.borosOpenPrefill;
  };

  it('no spread: the bundles arm D (25 Dec), not the 2-day date', async () => {
    const user = userEvent.setup();
    renderCard(case5Book());
    expect(await bundlesArm(user)).toMatchObject({ longVenue: 'OKX', shortVenue: 'LIGHTER', maturity: DEC });
  });

  it('no spread: the pairs card arms the same date', async () => {
    const user = userEvent.setup();
    renderCard(case5Book());
    expect(await pairsArm(user, 'Open both Boros legs')).toMatchObject({ longVenue: 'OKX', shortVenue: 'LIGHTER', maturity: DEC });
  });

  it('a bundle leg not open yet names its gap on the badge, not a bare "missing" (owner 2026-10-17)', async () => {
    const user = userEvent.setup();
    renderCard(case5Book());
    await user.click(screen.getByRole('tab', { name: /^Funding Bundles/ }));
    await user.click(screen.getByRole('button', { name: /^OKX/ }));
    const rows = (await screen.findAllByText('not open yet')).map((el) => el.closest('tr') as HTMLElement);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(within(row).getByText('missing 1 BTC')).toBeInTheDocument();
    expect(screen.queryByText('missing')).not.toBeInTheDocument();
  });

  const okxLighter = () => listSpreads([spreadRow(NOV, { venue: 'OKX-LIGHTER', spreadVenues: ['OKX', 'LIGHTER'] })]);

  it('a spread for the two venues before D: the bundles arm its date', async () => {
    okxLighter();
    const user = userEvent.setup();
    renderCard(case5Book());
    await showPairs(user);
    await screen.findByRole('button', { name: 'Open Boros leg' });
    expect((await bundlesArm(user))?.maturity).toBe(NOV);
  });

  it('a spread for the two venues before D: the pairs card arms the same date', async () => {
    okxLighter();
    const user = userEvent.setup();
    renderCard(case5Book());
    expect((await pairsArm(user, 'Open Boros leg'))?.maturity).toBe(NOV);
  });
});

describe('an open stops at what the venue lacks (owner 2026-10-16)', () => {
  const capBook = (perps: number) =>
    book(
      'BTC',
      [perp('BTC', 'GATE', 'LONG', perps), perp('BTC', 'HYPERLIQUID', 'SHORT', perps)],
      [leg('BTC', 'GATE', 'LONG', 3, NOV), leg('BTC', 'HYPERLIQUID', 'SHORT', 3, DEC)],
    );
  const reason = `Hyperliquid already holds 3 BTC at ${fmtDateShort(DEC)}`;

  it('perps 3: the card says why, and offers no HL open', async () => {
    const user = userEvent.setup();
    renderCard(capBook(3));
    await showPairs(user);
    expect(await screen.findByText(reason)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open leg' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Open (both )?Boros leg/ })).toBeNull();
  });

  it('perps 3: a held leg reads its size, a missing one held / target', async () => {
    const user = userEvent.setup();
    renderCard(capBook(3));
    await showPairs(user);
    const row = (venue: string) => screen.getAllByRole('row').find((r) => (r.textContent ?? '').startsWith(`${venue}Boros`));
    await screen.findByText(reason);
    expect(row('Gate')?.textContent).toMatch(/3 BTC/);
    expect(row('Gate')?.textContent).not.toMatch(/\//);
    // Held elsewhere, so nothing to open here: the target still shows.
    expect(row('Hyperliquid')?.textContent).toMatch(/0 \/ 3 BTC/);
    expect(row('Hyperliquid')?.textContent).not.toMatch(/open /);
  });

  it('perps 4: HL opens the 1 BTC it lacks, at the held single date', async () => {
    const user = userEvent.setup();
    renderCard(capBook(4));
    await showPairs(user);
    expect(await screen.findByText(reason)).toBeTruthy();
    const opens = screen.getAllByRole('button', { name: 'Open leg' });
    expect(opens.map((b) => b.getAttribute('title'))).toEqual([
      'Open only the Hyperliquid SHORT Boros leg, at 1 BTC',
      'Open only the Gate LONG Boros leg, at 1 BTC',
    ]);
    // The 3 BTC card: HL needs 3 here but lacks only 1, so the row says both.
    const hl = screen.getAllByRole('row').find((r) => /^HyperliquidBoros.*0 \/ 3 BTC/.test(r.textContent ?? ''));
    expect(hl?.textContent).toMatch(/0 \/ 3 BTCopen 1 BTC/);
    await user.click(opens[0]);
    await waitFor(() => expect(flow?.borosOpenPrefill).not.toBeNull());
    expect(flow?.borosOpenPrefill).toMatchObject({ longVenue: null, shortVenue: 'HYPERLIQUID', maturity: NOV, sizeBase: 1, size: 80_000 });
  });

  // Live 16 Oct: a $0.01 cut said "already holds" and "open 0.143" under "0 / 0.143".
  it('a cut too small to read: no reason line, no open line', async () => {
    const user = userEvent.setup();
    renderCard(
      book(
        'BTC',
        [perp('BTC', 'GATE', 'LONG', 4), perp('BTC', 'HYPERLIQUID', 'SHORT', 4)],
        [leg('BTC', 'GATE', 'LONG', 3, NOV), leg('BTC', 'HYPERLIQUID', 'SHORT', 1.000001, DEC)],
      ),
    );
    await showPairs(user);
    const hl = await waitFor(() => {
      const r = screen.getAllByRole('row').find((x) => /^HyperliquidBoros.*0 \/ 3 BTC/.test(x.textContent ?? ''));
      expect(r).toBeTruthy();
      return r!;
    });
    expect(hl.textContent).not.toMatch(/open |already holds/);
    expect(screen.queryByText(/Hyperliquid already holds/)).toBeNull();
  });
});
