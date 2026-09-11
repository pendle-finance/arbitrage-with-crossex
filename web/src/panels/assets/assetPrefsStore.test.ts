/**
 * assetPrefsStore — what survives a round trip through localStorage. The
 * validator rebuilds every entry, so a shape it does not recognise is a
 * preference silently lost.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { loadPrefs, savePrefs } from './assetPrefsStore';

describe('assetPrefsStore', () => {
  beforeEach(() => localStorage.clear());

  it('keeps a NEGATIVE carve rate — a Boros fixed APR is negative in a negative-funding regime', () => {
    savePrefs(null, { sinceByAsset: {}, legSince: {}, exclusions: { 'boros:1': { qty: 500, at: -0.03 } } });
    // Before: `at >= 0` dropped the price and the slice fell back to
    // pro-rata, leaving the kept remainder anchored at the wrong rate.
    expect(loadPrefs(null).exclusions['boros:1']).toEqual({ qty: 500, at: -0.03 });
  });

  it('still drops a non-numeric price and keeps the quantity', () => {
    savePrefs(null, {
      sinceByAsset: {},
      legSince: {},
      exclusions: { 'boros:1': { qty: 500, at: 'abc' as unknown as number }, 'boros:2': 'all' },
    });
    expect(loadPrefs(null).exclusions).toEqual({ 'boros:1': { qty: 500 }, 'boros:2': 'all' });
  });
});
