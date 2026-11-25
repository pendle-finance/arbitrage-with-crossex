import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { assembleImpactMarks, PriceImpactGraph, type LegImpact } from './PriceImpactGraph';

/** A HYPE-scale pair: OKX long ~59.0, Hyperliquid short ~59.0, small basis. */
const longLeg = (o: Partial<LegImpact> = {}): LegImpact => ({
  venue: 'OKX',
  side: 'LONG',
  bestBid: 59.0,
  bestAsk: 59.02,
  mid: 59.01,
  avgFill: 59.06, // BUY lifts the ask → fill above ask
  worst: 59.09,
  partialDepth: false,
  limitPx: null,
  ...o,
});
const shortLeg = (o: Partial<LegImpact> = {}): LegImpact => ({
  venue: 'HYPERLIQUID',
  side: 'SHORT',
  bestBid: 58.98,
  bestAsk: 59.0,
  mid: 58.99,
  avgFill: 58.93, // SELL hits the bid → fill below bid
  worst: 58.9,
  partialDepth: false,
  limitPx: null,
  ...o,
});

describe('assembleImpactMarks', () => {
  it('spans every finite price and puts higher prices nearer the top', () => {
    const s = assembleImpactMarks(longLeg(), shortLeg())!;
    expect(s).not.toBeNull();
    // Higher price → smaller yPct (nearer the top).
    expect(s.long.fill!.yPct).toBeLessThan(s.long.ask!.yPct);
    expect(s.long.ask!.yPct).toBeLessThan(s.long.bid!.yPct);
    // The domain top tick is >= the highest marked price (padded).
    expect(s.ticks[0].price).toBeGreaterThanOrEqual(59.09);
    expect(s.ticks[2].price).toBeLessThanOrEqual(58.9);
  });

  it('pushes the long fill ABOVE its ask and the short fill BELOW its bid', () => {
    const s = assembleImpactMarks(longLeg(), shortLeg())!;
    // LONG: fill & worst sit above the ask → strictly smaller yPct.
    expect(s.long.fill!.yPct).toBeLessThan(s.long.ask!.yPct);
    expect(s.long.worst!.yPct).toBeLessThan(s.long.ask!.yPct);
    // SHORT: fill & worst sit below the bid → strictly larger yPct.
    expect(s.short.fill!.yPct).toBeGreaterThan(s.short.bid!.yPct);
    expect(s.short.worst!.yPct).toBeGreaterThan(s.short.bid!.yPct);
  });

  it('signs impact as adverse-positive for both sides', () => {
    const s = assembleImpactMarks(longLeg(), shortLeg())!;
    // Long paid above mid, short sold below mid — both are adverse (> 0).
    expect(s.long.impactPct!).toBeGreaterThan(0);
    expect(s.short.impactPct!).toBeGreaterThan(0);
    // ~ (59.06 − 59.01)/59.01 × 100 ≈ 0.085%.
    expect(s.long.impactPct!).toBeCloseTo(((59.06 - 59.01) / 59.01) * 100, 4);
  });

  it('omits touch marks when the book is missing but still places the fill', () => {
    const s = assembleImpactMarks(
      longLeg({ bestBid: null, bestAsk: null, mid: null }),
      shortLeg(),
    )!;
    expect(s.long.bid).toBeNull();
    expect(s.long.ask).toBeNull();
    expect(s.long.fill).not.toBeNull(); // avgFill still on the scale
    expect(s.long.impactPct).toBeNull(); // no mid → no impact number
  });

  it('keeps a positive span when the basis is ~0 (all prices equal)', () => {
    const flat: LegImpact = {
      venue: 'OKX', side: 'LONG', bestBid: 100, bestAsk: 100, mid: 100,
      avgFill: 100, worst: 100, partialDepth: false, limitPx: null,
    };
    const s = assembleImpactMarks(flat, { ...flat, venue: 'BYBIT', side: 'SHORT' })!;
    // Distinct top/bottom ticks despite the flat domain — no divide-by-zero.
    expect(s.ticks[0].price).toBeGreaterThan(s.ticks[2].price);
    expect(Number.isFinite(s.long.mid!.yPct)).toBe(true);
  });

  it('returns null when nothing is finite', () => {
    const empty: LegImpact = {
      venue: 'OKX', side: 'LONG', bestBid: null, bestAsk: null, mid: null,
      avgFill: null, worst: null, partialDepth: false, limitPx: null,
    };
    expect(assembleImpactMarks(empty, { ...empty, side: 'SHORT' })).toBeNull();
  });
});

describe('PriceImpactGraph', () => {
  const noop = () => {};
  const priceOf = (leg: string, mark: string) =>
    Number(
      document
        .querySelector(`[data-leg="${leg}"] [data-mark="${mark}"]`)
        ?.getAttribute('data-price'),
    );

  it('renders both legs bid/ask/mid/fill with their prices', () => {
    render(<PriceImpactGraph long={longLeg()} short={shortLeg()} updatedAt={1} staleError={false} onRefetch={noop} />);
    expect(priceOf('long', 'ask')).toBe(59.02);
    expect(priceOf('long', 'fill')).toBe(59.06);
    expect(priceOf('short', 'bid')).toBe(58.98);
    expect(priceOf('short', 'fill')).toBe(58.93);
    // The redundant per-leg footer rows are gone — exact numbers live on the
    // axis gutter and the marks' hover titles.
    expect(screen.queryByText('59 / 59.02')).toBeNull();
    expect(screen.queryByText('58.98 / 59')).toBeNull();
  });

  it('draws the cyan limit line only on the maker leg', () => {
    render(
      <PriceImpactGraph
        long={longLeg({ limitPx: 59.0 })}
        short={shortLeg()}
        updatedAt={1}
        staleError={false}
        onRefetch={noop}
      />,
    );
    expect(document.querySelector('[data-leg="long"] [data-mark="limit"]')).not.toBeNull();
    expect(document.querySelector('[data-leg="short"] [data-mark="limit"]')).toBeNull();
  });

  it('colors the fill line and impact arrow rose when slippage is large', () => {
    // A ~1% adverse fill → rose tone on the fill line and the impact arrow.
    render(
      <PriceImpactGraph long={longLeg({ avgFill: 59.6, worst: 59.7 })} short={shortLeg()} updatedAt={1} staleError={false} onRefetch={noop} />,
    );
    const fillLine = document.querySelector('[data-leg="long"] [data-mark="fill"] div')!;
    expect(fillLine.className).toContain('rose');
    // The impact arrow spans touch → avg fill; its shaft carries the tone.
    const arrow = document.querySelector('[data-leg="long"] [data-mark="impact"]')!;
    expect(arrow).not.toBeNull();
    expect(arrow.querySelector('.bg-rose-400')).not.toBeNull();
  });

  it('points the impact arrow up on a long (buy) and down on a short (sell)', () => {
    const { container } = render(
      <PriceImpactGraph long={longLeg()} short={shortLeg()} updatedAt={1} staleError={false} onRefetch={noop} />,
    );
    // Long BUY fill (59.06) is ABOVE its ask (59.02) → the arrow tops out above
    // the ask, i.e. its container starts higher (smaller top%) than the ask.
    const askTop = (container.querySelector('[data-leg="long"] [data-mark="ask"]') as HTMLElement).style.top;
    const arrowLong = container.querySelector('[data-leg="long"] [data-mark="impact"]') as HTMLElement;
    expect(arrowLong.querySelector('.border-b-rose-400, .border-b-amber-400, .border-b-cyan-400')).not.toBeNull(); // up head
    expect(parseFloat(arrowLong.style.top)).toBeLessThanOrEqual(parseFloat(askTop));
    // Short SELL fill (58.93) is BELOW its bid → a down head.
    const arrowShort = container.querySelector('[data-leg="short"] [data-mark="impact"]') as HTMLElement;
    expect(arrowShort.querySelector('.border-t-rose-400, .border-t-amber-400, .border-t-cyan-400')).not.toBeNull(); // down head
  });

  it('captions each column with its venue and shows the limit direction arrow', () => {
    render(
      <PriceImpactGraph long={longLeg({ limitPx: 59.0 })} short={shortLeg()} updatedAt={1} staleError={false} onRefetch={noop} />,
    );
    // Venue captions under the columns (long OKX, short Hyperliquid).
    expect(screen.getByTitle('OKX (long)')).toHaveTextContent('OKX');
    expect(screen.getByTitle('HYPERLIQUID (short)')).toHaveTextContent('Hyperliquid');
    // The limit (long/BUY) carries an up arrow.
    const limit = document.querySelector('[data-leg="long"] [data-mark="limit"]')!;
    expect(limit.textContent).toContain('↑');
  });

  it('flags partial depth in the fill title; a missing touch drops the quote marks', () => {
    render(
      <PriceImpactGraph
        long={longLeg({ partialDepth: true })}
        short={shortLeg({ bestBid: null, bestAsk: null, mid: null })}
        updatedAt={1}
        staleError={false}
        onRefetch={noop}
      />,
    );
    const fill = document.querySelector('[data-leg="long"] [data-mark="fill"]')!;
    expect(fill.getAttribute('title')).toContain('partial depth');
    expect(document.querySelector('[data-leg="short"] [data-mark="bid"]')).toBeNull();
    expect(document.querySelector('[data-leg="short"] [data-mark="ask"]')).toBeNull();
  });

  it('one-leg mode', () => {
    render(<PriceImpactGraph long={longLeg()} short={shortLeg()} oneLeg="short" updatedAt={1} staleError={false} onRefetch={noop} />);
    expect(document.querySelectorAll('[data-leg]')).toHaveLength(1);
    expect(document.querySelector('[data-leg="short"]')).not.toBeNull();
  });

  it('one tag per column', () => {
    render(
      <PriceImpactGraph long={longLeg({ limitPx: 59.0, avgFill: null, worst: null })} short={shortLeg()} updatedAt={1} staleError={false} onRefetch={noop} />,
    );
    const tags = (leg: string, mark: string) => document.querySelector(`[data-leg="${leg}"] [data-mark="${mark}"] span`);
    expect(tags('long', 'bid')?.textContent).toBe('Bid');
    expect(tags('long', 'ask')).toBeNull();
    expect(tags('short', 'bid')?.textContent).toBe('Bid');
    expect(tags('short', 'ask')).toBeNull();
  });

  it('new captions', () => {
    render(
      <PriceImpactGraph long={longLeg({ limitPx: 59.0, avgFill: null, worst: null })} short={shortLeg()} updatedAt={1} staleError={false} onRefetch={noop} />,
    );
    expect(screen.getByText('Limit order')).toBeInTheDocument();
    expect(screen.getByText('Market hedge')).toBeInTheDocument();
  });

  it('tags at 10.5 px', () => {
    render(
      <PriceImpactGraph long={longLeg({ limitPx: 59.0 })} short={shortLeg()} updatedAt={1} staleError={false} onRefetch={noop} />,
    );
    expect(document.querySelector('[data-leg="long"] [data-mark="bid"] span')!.className).toContain('text-[10.5px]');
    expect(screen.getByText('Limit order').className).toContain('text-[10.5px]');
  });

  it('mkt line blue under 0.05%', () => {
    render(
      <PriceImpactGraph long={longLeg({ avgFill: 59.03 })} short={shortLeg()} updatedAt={1} staleError={false} onRefetch={noop} />,
    );
    expect(document.querySelector('[data-leg="long"] [data-mark="fill"] div')!.className).toContain('border-cyan-400');
    expect(document.querySelector('[data-leg="long"] [data-mark="impact"] .bg-cyan-400')).not.toBeNull();
  });
});
