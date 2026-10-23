import { beforeEach, describe, expect, it } from 'vitest';
import { clearLegacyPrefs, dropLegacyKeys, legacyExclusionsFor, legSinceParam, readLegacyPrefs } from './assetPrefsStore';

const KEY = 'crossex.assetView.v1';

describe('assetPrefsStore', () => {
  beforeEach(() => localStorage.clear());

  it('reads the browser map as stored, every book in it', () => {
    const map = {
      '0xaa|none': { sinceByAsset: {}, exclusions: { 'boros:1': { qty: 500, at: -0.03 } }, legSince: {} },
      '0xbb|none': { sinceByAsset: { ETH: 1_700_000_000 }, exclusions: {}, legSince: {} },
    };
    localStorage.setItem(KEY, JSON.stringify(map));
    expect(readLegacyPrefs()).toEqual(map);
  });

  it('reads null when the browser holds no map', () => {
    expect(readLegacyPrefs()).toBeNull();
  });

  it('reads null when the stored map is not JSON', () => {
    localStorage.setItem(KEY, '{not json');
    expect(readLegacyPrefs()).toBeNull();
  });

  it('clear removes the browser map', () => {
    localStorage.setItem(KEY, JSON.stringify({}));
    clearLegacyPrefs();
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(readLegacyPrefs()).toBeNull();
  });

  it('legSinceParam lists market and date pairs in market order', () => {
    expect(legSinceParam({ 'boros:9': 200, 'boros:3': 100, 'boros:4': 0 })).toBe('3:100,9:200');
  });

  it('legacyExclusionsFor reads one book and skips null entries', () => {
    const map = {
      '0xaa|none': { exclusions: { 'boros:1': 'all', 'boros:2': null, 'boros:3': { qty: 5 } } },
      '0xbb|none': { exclusions: { 'boros:4': 'all' } },
    };
    localStorage.setItem(KEY, JSON.stringify(map));
    expect(legacyExclusionsFor('0xaa|none')).toEqual({ 'boros:1': 'all', 'boros:3': { qty: 5 } });
    expect(legacyExclusionsFor('0xcc|none')).toEqual({});
  });

  it('legacyExclusionsFor drops perp keys as the server does', () => {
    const map = { '0xaa|none': { exclusions: { 'perp:ETHUSDT': 'all', 'perp:BTCUSDT': { qty: 2 }, 'boros:1': 'all' } } };
    localStorage.setItem(KEY, JSON.stringify(map));
    expect(legacyExclusionsFor('0xaa|none')).toEqual({ 'boros:1': 'all' });
  });

  it('legacyExclusionsFor reads nothing when the map is not an object', () => {
    localStorage.setItem(KEY, JSON.stringify(['x']));
    expect(legacyExclusionsFor('0xaa|none')).toEqual({});
  });

  it('dropLegacyKeys removes the written keys of one book only', () => {
    const map = {
      '0xaa|none': { sinceByAsset: { ETH: 1 }, exclusions: { 'boros:1': 'all', 'boros:2': 'all' }, legSince: {} },
      '0xbb|none': { sinceByAsset: {}, exclusions: { 'boros:1': 'all' }, legSince: {} },
    };
    localStorage.setItem(KEY, JSON.stringify(map));
    dropLegacyKeys('0xaa|none', { exclusions: { 'boros:1': null }, sinceByAsset: { ETH: 5 } });
    expect(readLegacyPrefs()).toEqual({
      '0xaa|none': { sinceByAsset: {}, exclusions: { 'boros:2': 'all' }, legSince: {} },
      '0xbb|none': { sinceByAsset: {}, exclusions: { 'boros:1': 'all' }, legSince: {} },
    });
  });

  it('dropLegacyKeys leaves storage alone when the map is gone', () => {
    dropLegacyKeys('0xaa|none', { exclusions: { 'boros:1': null } });
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});
