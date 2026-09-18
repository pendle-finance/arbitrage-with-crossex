import { describe, expect, it } from 'vitest';
import {
  agentBodies,
  agentStatus,
  assetView,
  assetViewBodies,
  credentialsBodies,
  credentialsRefused,
  pairContextBodies,
  telegramBodies,
  telegramInfo,
  telegramLinkBodies,
  telegramLinkStart,
  whaleBook,
} from './fixtures';

const units = (x: number | string): number => Math.round(Number(x) * 10_000);
const sum = (xs: Array<number | string>): number => xs.reduce<number>((a, x) => a + units(x), 0);
const keys = (o: object): string[] => Object.keys(o).sort();

describe('fixture state bodies', () => {
  it('every named state keeps its type shape, and the whale book adds up', () => {
    const records: Array<[Record<string, object>, object]> = [
      [telegramBodies, telegramInfo()],
      [telegramLinkBodies, telegramLinkBodies.none],
      [credentialsBodies, credentialsBodies.unset],
      [agentBodies, agentStatus()],
      [assetViewBodies, { ...assetView, interest: null }],
      [pairContextBodies, pairContextBodies.closeOnlyA],
    ];
    for (const [bodies, shape] of records) {
      for (const body of Object.values(bodies)) {
        expect(JSON.parse(JSON.stringify(body))).toStrictEqual(body);
        expect(keys(body)).toEqual(keys(shape));
      }
    }
    const groupKeys = keys(assetViewBodies.default.assets[0]);
    const perpKeys = keys(assetViewBodies.default.assets[0].perpOpen[0]);
    for (const body of Object.values(assetViewBodies)) {
      for (const group of body.assets) {
        expect(keys(group)).toEqual(groupKeys);
        for (const perp of group.perpOpen) expect(keys(perp)).toEqual(perpKeys);
      }
    }
    const rowKeys = keys(pairContextBodies.closeOnlyA.markets[0]);
    for (const body of Object.values(pairContextBodies)) {
      for (const row of body.markets) expect(keys(row)).toEqual(rowKeys);
      for (const row of body.markets.filter((m) => m.closeOnly)) expect(row.currentSize).not.toBe(0);
    }

    expect(telegramBodies.syncFailed.lastSyncError?.at).toBeGreaterThan(1e12);
    expect(telegramBodies.connectedBothOff.settings).toEqual({ liquidation: false, interest: false });
    expect(telegramBodies.liquidationOnly.settings).toEqual({ liquidation: true, interest: false });
    expect(telegramBodies.interestOnly.settings).toEqual({ liquidation: false, interest: true });
    expect(telegramBodies.bootFailed.settings).toBeNull();
    expect(telegramBodies.bootFailed.lastSyncAt).toBeNull();
    expect(telegramBodies.bootFailed.lastSyncError?.at).toBeGreaterThan(1e12);
    expect(telegramLinkBodies.pending.url).toBe(telegramLinkStart.url);
    expect(credentialsRefused.error).toMatchObject({ category: 'auth', label: 'INVALID_KEY' });
    expect(agentBodies.expired.expired).toBe(true);
    expect(assetViewBodies.backfilling.coverage.backfilling).toBe(true);
    expect(assetViewBodies.backfillingAllTime.sinceSec).toBe(0);
    expect(assetViewBodies.backfillingAllTime.coverage.backfilling).toBe(true);
    expect(assetViewBodies.noDefault.defaultSinceSec).toBeNull();
    const sol = assetViewBodies.unsupported.assets.find((a) => a.base === 'SOL');
    expect(sol?.supported).toBe(false);
    expect(sol?.perpOpen.length).toBeGreaterThan(0);
    const pendingLeg = assetViewBodies.entryPending.assets.find((a) => a.base === 'ETH')?.borosOpen[0];
    expect(pendingLeg?.entryApr).toBeNull();
    const whaleSol = assetViewBodies.whaleUnsupported.assets.find((a) => a.base === 'SOL');
    expect(whaleSol?.supported).toBe(false);
    expect(whaleSol?.perpOpen[0]?.upnlUsd).toBe(6_000_000.37);
    expect(pairContextBodies.closeOnlyA.markets.map((m) => m.closeOnly)).toEqual([true, false]);
    expect(pairContextBodies.closeOnlyB.markets.map((m) => m.closeOnly)).toEqual([false, true]);

    const { account: acct, positions: book, assetView: av } = whaleBook;
    const { positions, exposure } = book;
    expect(acct.marginBalance).toBe('6000000');
    expect(sum(acct.assets.map((a) => a.equity))).toBe(units(acct.marginBalance));
    for (const a of acct.assets) {
      expect(units(a.balance) + units(a.upnl)).toBe(units(a.equity));
      expect(units(a.liability)).toBe(Math.max(0, -units(a.balance)));
    }
    expect(sum(acct.assets.map((a) => a.upnl))).toBe(sum(positions.map((p) => p.upnl)));
    expect(sum([...positions.map((p) => p.initialMargin), ...acct.assets.map((a) => a.borrowingInitialMargin)])).toBe(
      units(acct.initialMargin),
    );
    expect(
      sum([...positions.map((p) => p.maintenanceMargin), ...acct.assets.map((a) => a.borrowingMaintenanceMargin)]),
    ).toBe(units(acct.maintenanceMargin));
    expect(units(acct.marginBalance) - units(acct.initialMargin)).toBe(units(acct.availableMargin));
    expect(Number(acct.initialMarginRate)).toBeCloseTo(Number(acct.initialMargin) / Number(acct.marginBalance), 4);
    expect(Number(acct.maintenanceMarginRate)).toBeCloseTo(
      Number(acct.maintenanceMargin) / Number(acct.marginBalance),
      4,
    );

    for (const p of positions) {
      const qty = Math.abs(Number(p.positionQty));
      const sign = p.positionSide === 'LONG' ? 1 : -1;
      expect(units(qty * Number(p.markPrice))).toBe(units(p.positionValue));
      expect(units(sign * (Number(p.markPrice) - Number(p.entryPrice)) * qty)).toBe(units(p.upnl));
      expect(units(Number(p.positionValue) / Number(p.leverage))).toBe(units(p.initialMargin));
      expect(units(-Number(p.positionValue) * 0.0005)).toBe(units(p.fee));
    }
    for (const g of exposure) {
      const long = g.legs.filter((l) => l.side === 'LONG').map((l) => l.value);
      const short = g.legs.filter((l) => l.side === 'SHORT').map((l) => l.value);
      expect(sum(long)).toBe(units(g.longValue));
      expect(sum(short)).toBe(units(g.shortValue));
      expect(units(g.longValue) - units(g.shortValue)).toBe(units(g.netValue));
      expect(units(g.longValue) + units(g.shortValue)).toBe(units(g.grossValue));
      for (const leg of g.legs) {
        expect(positions.find((p) => p.symbol === leg.symbol)?.positionValue).toBe(String(leg.value));
      }
    }

    const perps = av.assets.flatMap((g) => g.perpOpen);
    expect(perps.map((p) => p.symbol).sort()).toEqual(positions.map((p) => p.symbol).sort());
    expect(sum(perps.map((p) => p.notionalUsd))).toBe(sum(positions.map((p) => p.positionValue)));
    expect(sum(perps.map((p) => p.upnlUsd))).toBe(sum(positions.map((p) => p.upnl)));
    expect(sum(perps.map((p) => p.imUsd))).toBe(sum(positions.map((p) => p.initialMargin)));
    expect(sum(perps.map((p) => p.fundingUsd))).toBe(sum(positions.map((p) => p.fundingFee)));
    expect(sum(perps.map((p) => p.feesUsd))).toBe(-sum(positions.map((p) => p.fee)));
    for (const g of av.assets) {
      for (const b of g.borosOpen) expect(units(b.sizeToken * g.priceUsd)).toBe(units(b.notionalUsd));
    }
    expect(av.interest).toMatchObject({ paidUsd: 11_834.21, byCoin: { USDT: 11_834.21 } });

    expect(JSON.stringify(whaleBook)).toContain('999999.995');
    expect(positions.some((p) => /^\d{8}(\.|$)/.test(p.positionValue))).toBe(true);
  });
});
