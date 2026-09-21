import { describe, expect, it } from 'vitest';
import { fetchBorosCollaterals, fetchBorosMarkets, type FetchLike } from '../../src/core/boros/client';

type Row = Record<string, unknown>;
interface Call {
  path: string;
  method: string;
  body: { marketAccs: string[] } | undefined;
}

const ROOT = '0x' + 'cd'.repeat(20);
const CROSS_USDT = ROOT + '00' + '0003' + 'ffffff';
const DUST_CROSS_HYPE = ROOT + '00' + '0005' + 'ffffff';
const isolatedUsdt = (marketId: number) => ROOT + '00' + '0003' + marketId.toString(16).padStart(6, '0');
const e18 = (n: number) => (BigInt(n) * 10n ** 18n).toString();
const nowSec = () => Math.floor(Date.now() / 1000);

function account(reads: { byRoot: Row[]; actives: Row[]; infos?: Row[] }, calls: Call[] = []): FetchLike {
  return async (url, init) => {
    const u = new URL(url);
    const body = init?.body ? (JSON.parse(init.body) as { marketAccs: string[] }) : undefined;
    calls.push({ path: u.pathname, method: init?.method ?? 'GET', body });
    const results = u.pathname.endsWith('/market-acc-infos-by-root')
      ? reads.byRoot
      : u.pathname.endsWith('/active-positions')
        ? reads.actives
        : (reads.infos ?? []).filter((r) => body?.marketAccs.includes(String(r.marketAcc)));
    return { ok: true, status: 200, json: async () => ({ results }) };
  };
}

function markets(results: Row[]): FetchLike {
  return async () => ({ ok: true, status: 200, json: async () => ({ results }) });
}

const crossRow = (signedSize: string): Row => ({
  marketAcc: CROSS_USDT,
  netBalance: e18(1_000),
  positions: [{ marketId: 155, signedSize, initialMargin: e18(1), orders: [] }],
});

const dustRow = (marketAcc: string, marketId: number): Row => ({
  marketAcc,
  totalCash: '1000000',
  netBalance: '1000000',
  positions: [{ marketId, signedSize: e18(-5), initialMargin: e18(2), orders: [] }],
});

describe('C1 dust accounts the by-root read drops', () => {
  it('C1 backfills a dust account', async () => {
    const calls: Call[] = [];
    const zones = await fetchBorosCollaterals(
      account(
        {
          byRoot: [crossRow(e18(10))],
          actives: [
            { marketAcc: CROSS_USDT, marketId: 155, side: 0, fixedApr: 0.05, signedSize: e18(10) },
            { marketAcc: DUST_CROSS_HYPE, marketId: 201, side: 1, fixedApr: 0.09, signedSize: e18(-5) },
          ],
          infos: [dustRow(DUST_CROSS_HYPE, 201)],
        },
        calls,
      ),
      ROOT,
      [],
    );
    expect(calls.filter((c) => c.method === 'POST')).toEqual([
      { path: '/apis/v1/accounts/market-acc-infos', method: 'POST', body: { marketAccs: [DUST_CROSS_HYPE] } },
    ]);
    const hype = zones.find((z) => z.tokenId === 5);
    expect(hype?.cross?.marketAcc).toBe(DUST_CROSS_HYPE);
    expect(hype?.cross?.marketPositions).toMatchObject([
      { marketId: 201, notionalSize: e18(-5), side: 1, fixedApr: 0.09 },
    ]);
  });

  it('C1 keeps the margin account', async () => {
    const dustIso = isolatedUsdt(201);
    const zones = await fetchBorosCollaterals(
      account({
        byRoot: [crossRow(e18(10))],
        actives: [
          { marketAcc: CROSS_USDT, marketId: 155, side: 0, fixedApr: 0.05, signedSize: e18(10) },
          { marketAcc: dustIso, marketId: 201, side: 1, fixedApr: 0.09, signedSize: e18(-5) },
        ],
        infos: [dustRow(dustIso, 201)],
      }),
      ROOT,
      [],
    );
    expect(zones).toHaveLength(1);
    expect(zones[0]!.cross?.marketPositions.map((p) => p.marketId)).toEqual([155]);
    expect(zones[0]!.isolated).toHaveLength(1);
    expect(zones[0]!.isolated[0]).toMatchObject({ isCross: false, marketAcc: dustIso });
    expect(zones[0]!.isolated[0]!.marketPositions).toMatchObject([{ marketId: 201, notionalSize: e18(-5) }]);
  });

  it('C1 reads nothing more when the by-root read holds every account', async () => {
    const calls: Call[] = [];
    await fetchBorosCollaterals(
      account(
        {
          byRoot: [crossRow(e18(10))],
          actives: [
            { marketAcc: CROSS_USDT, marketId: 155, side: 0, fixedApr: 0.05, signedSize: e18(10) },
            { marketAcc: ROOT + '01' + '0003' + 'ffffff', marketId: 155, side: 0, fixedApr: 0.05, signedSize: e18(1) },
          ],
        },
        calls,
      ),
      ROOT,
      [],
    );
    expect(calls.map((c) => c.method)).toEqual(['GET', 'GET']);
  });

  it('C1 asks for at most 100 accounts a call', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => 300 + i);
    const calls: Call[] = [];
    const zones = await fetchBorosCollaterals(
      account(
        {
          byRoot: [crossRow(e18(10))],
          actives: ids.map((id) => ({ marketAcc: isolatedUsdt(id), marketId: id, side: 1, fixedApr: 0.09 })),
          infos: ids.map((id) => dustRow(isolatedUsdt(id), id)),
        },
        calls,
      ),
      ROOT,
      [],
    );
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.body?.marketAccs.length)).toEqual([100, 1]);
    expect(zones[0]!.isolated).toHaveLength(101);
  });
});

describe('market lifecycle and margin mode', () => {
  it('M1 matured by time', async () => {
    const list = await fetchBorosMarkets(
      markets([
        { marketId: 1, tokenId: 3, config: { status: 2 }, imData: { maturity: nowSec() - 60 } },
        { marketId: 2, tokenId: 3, config: { status: 2 }, imData: { maturity: nowSec() + 86_400 } },
        { marketId: 3, tokenId: 3, config: { status: 1 }, imData: { maturity: nowSec() - 60 } },
      ]),
    );
    expect(list.map((m) => m.state)).toEqual(['Matured', 'Normal', 'Matured']);
  });

  it('L3 reads imData.isIsolatedOnly', async () => {
    const list = await fetchBorosMarkets(
      markets([
        { marketId: 189, tokenId: 3, imData: { isIsolatedOnly: true } },
        { marketId: 190, tokenId: 3, imData: {} },
      ]),
    );
    expect(list.map((m) => m.isolatedOnly)).toEqual([true, false]);
  });
});

describe('M2 position side', () => {
  it('M2 side from signedSize', async () => {
    for (const size of [-5, -6_000_000]) {
      const zones = await fetchBorosCollaterals(account({ byRoot: [crossRow(e18(size))], actives: [] }), ROOT, []);
      expect(zones[0]!.cross?.marketPositions[0]).toMatchObject({
        side: 1,
        fixedApr: null,
        notionalSize: e18(size),
      });
    }
  });

  it('M2 size wins', async () => {
    const zones = await fetchBorosCollaterals(
      account({
        byRoot: [crossRow(e18(-5))],
        actives: [{ marketAcc: CROSS_USDT, marketId: 155, side: 0, fixedApr: 0.07, signedSize: e18(5) }],
      }),
      ROOT,
      [],
    );
    expect(zones[0]!.cross?.marketPositions[0]).toMatchObject({ side: 1, fixedApr: null });
  });
});
