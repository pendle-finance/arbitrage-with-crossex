import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { encodeSharePayload, type SharePayloadV1 } from './lib/shareCodec';
import { REPO_URL } from './lib/landing';
import { makeSharePayload } from './test/fixtures';
import { PositionApp } from './PositionApp';

/** Times relative to the real clock — the page judges "matured since sharing"
 * against Date.now(), so the fixture's fixed 2025 dates would always read as
 * matured. Everything else comes from the shared factory. */
const nowSec = Math.floor(Date.now() / 1000);
const live = (overrides: Partial<SharePayloadV1> = {}): SharePayloadV1 =>
  makeSharePayload({
    t: nowSec,
    m: nowSec + 12 * 86_400,
    cs: nowSec - 2 * 86_400,
    ...overrides,
  });

const livePayload = live();

const mount = (search: string) => render(<PositionApp search={search} />);
const mountPayload = (p: SharePayloadV1) => mount(`?d=${encodeSharePayload(p)}`);

/** base64url of an arbitrary string (for hand-crafted hostile payloads). */
const b64url = (s: string): string =>
  btoa(String.fromCharCode(...new TextEncoder().encode(s)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

describe('PositionApp — valid link', () => {
  it('titles the position like the opportunity card: strategy name + base + stacked venues', () => {
    mountPayload(livePayload);
    expect(
      screen.getByRole('heading', { level: 1, name: '4-legged Fixed-rate Funding Arbitrage' }),
    ).toBeInTheDocument();
    expect(screen.getByTitle('HYPE funding rate')).toHaveTextContent('HYPE');
    expect(screen.getByText('SHORT · Hyperliquid')).toBeInTheDocument();
    expect(screen.getByText('LONG · Bybit')).toBeInTheDocument();
  });

  it('renders the hero numbers, hedge status, and the snapshot caption', () => {
    mountPayload(livePayload);
    expect(screen.getByText('+17.81%')).toBeInTheDocument();
    expect(screen.getByText('Fixed APR on capital')).toBeInTheDocument();
    expect(screen.getAllByText('$41,320').length).toBeGreaterThan(0);
    expect(screen.getByText('Fully hedged ✓')).toBeInTheDocument();
    expect(screen.getByText('+$282')).toBeInTheDocument();
    expect(screen.getByText('Someone shared their position:')).toBeInTheDocument();
    // The snapshot date lives in the disclaimer, not a separate caption.
    expect(screen.getByText(/numbers are a snapshot from/)).toBeInTheDocument();
    expect(screen.queryByText('Matured since sharing')).not.toBeInTheDocument();
  });

  it('always shows the self-reported disclaimer beside the headline', () => {
    mountPayload(livePayload);
    expect(screen.getByText(/Self-reported by the sharer's own terminal/)).toBeInTheDocument();
    expect(screen.getByText(/not verified by this site/)).toBeInTheDocument();
  });

  it('draws the layered diagram: perps ⟷ delta-neutral on top, Boros legs boxed below', () => {
    mountPayload(livePayload);
    expect(screen.getByText('The four legs, and how they hedge')).toBeInTheDocument();
    // Layer labels: perp group + the bordered Boros group.
    expect(screen.getByText(/Perps · Gate CrossEx unified margin/)).toBeInTheDocument();
    expect(screen.getByText('On Boros — the rate legs')).toBeInTheDocument();
    // The glyph badge rides the gap; the caption carries its meaning.
    expect(screen.getByText('delta-neutral · price PnL cancels out')).toBeInTheDocument();
    // One vertical funding link per venue column, net fixed APR called out.
    expect(screen.getAllByText('floating funding cancels')).toHaveLength(2);
    expect(screen.getByText(/net receiving/)).toBeInTheDocument();
    expect(screen.getByText(/net paying/)).toBeInTheDocument();
    // The locked-spread banner inside the Boros box (the hero caption says
    // "spread locked until maturity" too — hence AllBy).
    expect(screen.getAllByText(/locked until maturity/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('HYPERLIQUID').length).toBeGreaterThan(0);
    expect(screen.getAllByText('BYBIT').length).toBeGreaterThan(0);
  });

  it('breaks PnL down as a waterfall and capital as a margin pie', () => {
    const { container } = mountPayload(livePayload);
    expect(screen.getByText('PnL, decomposed')).toBeInTheDocument();
    // Caption + hero label (hence "AllBy").
    expect(screen.getAllByText('PnL by maturity').length).toBeGreaterThanOrEqual(2);
    // The sharer's mark at share time is deliberately NOT displayed.
    expect(screen.queryByText('PnL when shared')).not.toBeInTheDocument();
    expect(container.querySelector('[data-segment="mtm"]')).toBeNull();
    // The cost steps land on the payload's own PnL by construction.
    const profit = container.querySelector('[data-segment="profit"]');
    expect(profit).not.toBeNull();
    expect(profit!.getAttribute('data-level')).toBe('282.00');
    expect(container.querySelector('[data-segment="spread"]')).not.toBeNull();
    expect(container.querySelector('[data-segment="paid-perp-fees"]')).not.toBeNull();
    expect(container.querySelector('[data-segment="future-exit-fees"]')).not.toBeNull();
    // Capital: the margin-split pie with its legend, totalling the capital.
    expect(screen.getByText('Capital, decomposed')).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: /Capital split: perp margin \$33,056 \+ Boros margin \$8,264 = \$41,320/ }),
    ).toBeInTheDocument();
    expect(screen.getByText('Perp margin (CrossEx)')).toBeInTheDocument();
    expect(screen.getByText('Boros margin')).toBeInTheDocument();
    expect(screen.getByText('$33,056')).toBeInTheDocument();
    expect(screen.getByText('$8,264')).toBeInTheDocument();
    expect(screen.getByText('80%')).toBeInTheDocument();
    expect(screen.getByText('20%')).toBeInTheDocument();
  });

  it('re-derives the whole page when either At-maturity toggle flips (and they sync)', async () => {
    const { container } = mountPayload(livePayload);
    // Two toggles — hero + PnL section — one state. Sharer's assumption
    // (cx=1) is the default, marked as shared.
    const closes = screen.getAllByRole('radio', { name: /Close perps/ });
    expect(closes).toHaveLength(2);
    for (const c of closes) expect(c).toBeChecked();
    expect(closes[0]).toHaveTextContent('(as shared)');
    await userEvent.click(screen.getAllByRole('radio', { name: 'Roll over' })[0]); // hero
    for (const r of screen.getAllByRole('radio', { name: 'Roll over' })) expect(r).toBeChecked();
    // Exit costs (80 + 49.16) hand back into the target: 282 → 411.16 …
    expect(container.querySelector('[data-segment="profit"]')!.getAttribute('data-level')).toBe(
      '411.16',
    );
    expect(container.querySelector('[data-segment="future-exit-fees"]')).toBeNull();
    expect(container.querySelector('[data-segment="future-exit-slippage"]')).toBeNull();
    // … and the hero follows: PnL and the APR scaled on the same basis.
    expect(screen.getByText('+$411')).toBeInTheDocument();
    expect(screen.getByText('+25.97%')).toBeInTheDocument();
    expect(screen.queryByText('+$282')).not.toBeInTheDocument();
  });

  it('teaches the strategy in collapsibles and links only to hardcoded places', () => {
    mountPayload(livePayload);
    expect(screen.getByText('What is a funding rate?')).toBeInTheDocument();
    expect(screen.getByText('Why the two perp legs? (delta-neutral)')).toBeInTheDocument();
    expect(screen.getByText('What are the risks?')).toBeInTheDocument();
    const hrefs = Array.from(document.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    const allowed = [
      '/',
      REPO_URL,
      'https://docs.pendle.finance/boros-academy/advanced-strategies/fixed-return-funding-arbitrage',
    ];
    for (const href of hrefs) expect(allowed).toContain(href);
  });

  it('flags a position that matured after it was shared', () => {
    mountPayload(live({ t: nowSec - 13 * 86_400, m: nowSec - 86_400 }));
    expect(screen.getByText('Matured since sharing')).toBeInTheDocument();
  });

  it("states the sharer's cost assumption in the fees explainer", () => {
    mountPayload(livePayload);
    expect(
      screen.getByText(/net of the perp entry costs and the estimated exit costs/),
    ).toBeInTheDocument();
  });

  it('lists every leg of a non-canonical book — nothing silently dropped', () => {
    mountPayload(live({ l: [...livePayload.l, { k: 'p', x: 'HYPERLIQUID', s: 'S', n: 1_000 }] }));
    expect(screen.getByText('The legs')).toBeInTheDocument();
    // 3 perp cards + 2 Boros cards = all 5 legs.
    expect(screen.getAllByText(/Perp ·/)).toHaveLength(3);
    expect(screen.getAllByText(/floating,/)).toHaveLength(2);
  });
});

describe('PositionApp — bad links', () => {
  it('shows the missing-payload state without ?d=', () => {
    mount('');
    expect(screen.getByText('No position in this link')).toBeInTheDocument();
    expect(screen.queryByText('Fixed APR on capital')).not.toBeInTheDocument();
  });

  it('shows the malformed state for garbage, and never echoes the raw param', () => {
    mount('?d=%25%25garbage%25%25');
    expect(screen.getByText('This share link looks malformed')).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain('garbage');
  });

  it('says "newer terminal" for a well-formed future schema', () => {
    mount(`?d=${b64url('{"v":2,"future":true}')}`);
    expect(screen.getByText('This link was made by a newer terminal')).toBeInTheDocument();
  });

  it('neutralizes hostile payloads via schema rejection, not sanitization', () => {
    const hostile = b64url(
      JSON.stringify({ ...livePayload, b: '<img src=x onerror=window.xss=1>' }),
    );
    mount(`?d=${hostile}`);
    expect(screen.getByText('This share link looks malformed')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
    expect((window as { xss?: unknown }).xss).toBeUndefined();
    expect(document.body.innerHTML).not.toContain('onerror');
  });
});

describe('PositionApp — no credential surface', () => {
  it('renders no API-key or secret affordance anywhere', () => {
    mountPayload(livePayload);
    expect(screen.queryByText(/API key/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/secret/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Save credentials/i)).not.toBeInTheDocument();
  });
});
