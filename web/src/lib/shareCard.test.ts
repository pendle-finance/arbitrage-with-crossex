/** `shareCardLines` only — the canvas half needs a real 2D context, which
 * jsdom doesn't implement; the pixels are verified by eye in the browser. */
import { describe, expect, it } from 'vitest';
import { makeSharePayload } from '../test/fixtures';
import { shareCardLines } from './shareCard';

const payload = makeSharePayload();

describe('shareCardLines', () => {
  it('says the requested headline: APR, capital, days', () => {
    const lines = shareCardLines(payload);
    expect(lines.headline).toBe("I'm getting");
    expect(lines.aprText).toBe('17.81%');
    expect(lines.headlineTail).toBe('fixed APR');
    // Term days: clock start (t − 2d) → maturity (t + 12d) = 14, labeled as a
    // term so it can't be misread as days-left next to the maturity date.
    expect(lines.capitalLine).toBe('on $41,320 capital (14-day term)');
    expect(lines.contextLine).toContain('HYPE');
    expect(lines.contextLine).toContain('7.07% locked spread');
    expect(lines.contextLine).toContain('fully hedged');
  });

  it('renders the 4 legs concisely', () => {
    const { legs, legOverflow } = shareCardLines(payload);
    expect(legOverflow).toBeNull();
    expect(legs).toEqual([
      { side: 'SHORT', kind: 'Boros', venue: 'Hyperliquid', detail: '9.36% fixed', notional: '$158.8k' },
      { side: 'LONG', kind: 'Boros', venue: 'Bybit', detail: '2.29% fixed', notional: '$158.8k' },
      { side: 'SHORT', kind: 'Perp', venue: 'Hyperliquid', detail: 'funding hedge', notional: '$160.3k' },
      { side: 'LONG', kind: 'Perp', venue: 'Bybit', detail: 'funding hedge', notional: '$160.3k' },
    ]);
  });

  it('brackets a leg notional with its token size when the wire carries one', () => {
    const tokenized = makeSharePayload({
      l: [{ ...payload.l[0], tn: 42.5, ts: 'HYPE' }, ...payload.l.slice(1)],
    });
    const { legs } = shareCardLines(tokenized);
    expect(legs[0].notional).toBe('$158.8k (42.5 HYPE)');
    expect(legs[1].notional).toBe('$158.8k');
  });

  it('falls back to days-remaining when the open time is unknown', () => {
    // cs null → the snapshot stands in: share time → maturity (t + 12d) = 12.
    expect(shareCardLines(makeSharePayload({ cs: null })).capitalLine).toBe(
      'on $41,320 capital (12-day term)',
    );
  });

  it('caps at 6 rows and reports the overflow', () => {
    const eight = makeSharePayload({
      l: Array.from({ length: 8 }, () => ({ k: 'p' as const, x: 'GATE', s: 'L' as const, n: 1000 })),
    });
    const { legs, legOverflow } = shareCardLines(eight);
    expect(legs).toHaveLength(6);
    expect(legOverflow).toBe('+2 more legs');
  });

  it('credits Boros, Gate CrossEx, and the tool', () => {
    const lines = shareCardLines(payload);
    expect(lines.footerLeft).toBe('Powered by Boros × Gate CrossEx');
    expect(lines.footerRightPrefix + lines.footerRightBrand).toBe(
      'Executed with the open-source tool at CrossexBoros.com',
    );
  });
});
