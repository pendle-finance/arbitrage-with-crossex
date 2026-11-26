import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import type { AssetViewResponse } from '../../api/types';
import { assetViewBodies, makeSpreadWhaleBook } from '../../test/fixtures';
import { RebalanceOpenerProvider, useRebalanceOpenState, useRebalanceOpener } from '../rebalanceOpener';
import { deriveAsset } from './assetModel';
import { openPairKey, openPairsOf, pairKey } from './pairs';

const books: [string, AssetViewResponse][] = [
  ['whale', assetViewBodies.whale],
  ['spread whale', makeSpreadWhaleBook()],
];

const viewOf = (av: AssetViewResponse) => ({ exclusions: {}, sinceSec: av.sinceSec, nowSec: av.nowSec });

describe('openPairsOf on a matured Boros leg', () => {
  it('drops the pair once its only Boros leg has matured, as the asset card does', () => {
    const av = assetViewBodies.maturedLeg;
    const pairs = openPairsOf(av.assets, viewOf(av));
    expect(pairs).toEqual([]);
  });
});

describe('openPairsOf', () => {
  it.each(books)('keeps the Fixed Rate Pairs order and keys on the %s book', (_name, av) => {
    const expected = av.assets.flatMap((g) =>
      deriveAsset(g, {}, av.sinceSec, av.nowSec).pairs.map((p) => `${g.base}:${pairKey(p)}`),
    );
    const pairs = openPairsOf(av.assets, viewOf(av));
    expect(expected.length).toBeGreaterThan(0);
    expect(pairs.map((p) => p.key)).toEqual(expected);
    expect(new Set(expected).size).toBe(expected.length);
  });

  it.each(books)('carries each pair leg and its initial margin on the %s book', (_name, av) => {
    for (const g of av.assets) {
      const derived = deriveAsset(g, {}, av.sinceSec, av.nowSec).pairs;
      const pairs = openPairsOf([g], viewOf(av));
      derived.forEach((p, i) => {
        const open = pairs[i]!;
        expect(open.base).toBe(g.base);
        expect(open.maturitySec).toBe(p.soonestMaturitySec);
        expect(open.unit).toBe(p.unit);
        expect(open.size).toBe(p.size);
        expect(open.imUsd).toBeCloseTo(p.legs.reduce((s, l) => s + l.imUsd, 0), 6);
        expect(open.perps).toHaveLength(p.legs.filter((l) => l.kind === 'perp').length);
        expect(open.boros).toHaveLength(p.legs.filter((l) => l.kind === 'yu').length);
        for (const perp of open.perps) expect(perp.symbol.startsWith(`${perp.exchange}_`)).toBe(true);
      });
    }
  });

  it('keys the same venues and date apart per coin', () => {
    const parts = { longVenue: 'HYPERLIQUID', shortVenue: 'GATE', soonestMaturitySec: 1_800_000_000, kind: 'spread' as const };
    expect(openPairKey('ETH', parts)).not.toBe(openPairKey('BTC', parts));
  });
});

describe('rebalance opener', () => {
  const useBoth = () => ({ open: useRebalanceOpener(), state: useRebalanceOpenState() });

  it('is a no-op and closed with no provider', () => {
    const { result } = renderHook(useBoth);
    act(() => result.current.open({ tab: 'delever', pairKey: 'ETH:x' }));
    expect(result.current.state).toMatchObject({ open: false, tab: null, pairKey: null });
  });

  it('opens on the tab and pair given over the current tab, and switches to Balances only without a pair', () => {
    const wrapper = ({ children }: { children: ReactNode }) => createElement(RebalanceOpenerProvider, null, children);
    const { result } = renderHook(useBoth, { wrapper });
    const tabs: unknown[] = [];
    const onTab = (e: Event) => tabs.push((e as CustomEvent<unknown>).detail);
    window.addEventListener('crossex:open-tab', onTab);
    act(() => result.current.open({ tab: 'delever', pairKey: 'ETH:x' }));
    expect(result.current.state).toMatchObject({ open: true, tab: 'delever', pairKey: 'ETH:x' });
    expect(tabs).toEqual([]);
    act(() => result.current.state.close());
    expect(result.current.state).toMatchObject({ open: false, tab: null, pairKey: null });
    act(() => result.current.open());
    expect(result.current.state).toMatchObject({ open: true, tab: null, pairKey: null });
    expect(tabs).toEqual(['balances']);
    window.removeEventListener('crossex:open-tab', onTab);
  });
});
