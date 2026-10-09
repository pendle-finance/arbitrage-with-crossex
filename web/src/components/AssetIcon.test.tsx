import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SpreadIcon } from './AssetIcon';

const rectangleSources = (container: HTMLElement): string[] =>
  [...(container.firstElementChild?.querySelectorAll('img') ?? [])].map((img) => decodeURIComponent(img.src));

describe('SpreadIcon', () => {
  it('draws the Boros Hyperliquid-Gate icon at twice the height in width', () => {
    const { container } = render(<SpreadIcon venues={['HYPERLIQUID', 'GATE']} size={16} />);
    const img = container.firstElementChild as HTMLImageElement;
    expect(img.tagName).toBe('IMG');
    expect(decodeURIComponent(img.src)).toBe('https://storage.googleapis.com/boros-prod/platform-icons/hyperliquid-gate.svg');
    expect(img.getAttribute('width')).toBe('32');
    expect(img.getAttribute('height')).toBe('16');
    expect(img.style.width).toBe('32px');
    expect(img.style.height).toBe('16px');
  });

  it('falls back to the two venue logos for a pair with no Boros icon', () => {
    const { container } = render(<SpreadIcon venues={['BINANCE', 'GATE']} />);
    const sources = rectangleSources(container);
    expect(sources).toHaveLength(2);
    expect(sources[0]).toContain('binance_icon.svg');
    expect(sources[1]).toContain('Frame 1000005731.svg');
  });

  it('falls back to the two venue logos when the Boros icon fails to load', () => {
    const { container } = render(<SpreadIcon venues={['HYPERLIQUID', 'GATE']} />);
    fireEvent.error(container.firstElementChild!);
    const sources = rectangleSources(container);
    expect(sources).toHaveLength(2);
    expect(sources[0]).toContain('hyperliquid_icon.svg');
    expect(sources[1]).toContain('Frame 1000005731.svg');
  });
});
