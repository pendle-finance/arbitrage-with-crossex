import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { makeDealView } from '../test/fixtures';
import { dealRunProps } from './DealModalBits';

function doneBox(aFilled: string, bFilled: string, unhedged: string): string {
  const view = makeDealView({ pair: { mode: 'DONE', targetQty: '1' }, projection: { aFilled, bFilled, unhedged } });
  const { container } = render(<>{dealRunProps(view, null, 0, []).firstLine}</>);
  return container.firstElementChild?.className ?? '';
}

describe('deal done box tone', () => {
  it('is green only when the whole target filled and hedged', () => {
    expect(doneBox('1', '1', '0')).toContain('alert-green');
  });

  it('is red when nothing filled', () => {
    expect(doneBox('0', '0', '0')).toContain('alert-red');
  });

  it('is amber for a part fill cut short by a stop', () => {
    expect(doneBox('0.4', '0.4', '0')).toContain('alert-amber');
  });

  it('is amber when a filled part is not hedged', () => {
    expect(doneBox('1', '0.6', '0.4')).toContain('alert-amber');
  });
});

describe('deal done headline', () => {
  const headline = (close: boolean, aFilled: string, bFilled: string) => {
    const base = makeDealView();
    const view = makeDealView({
      pair: {
        mode: 'DONE',
        targetQty: '12',
        a: { ...base.pair.a, reduceOnly: close },
        b: base.pair.b && { ...base.pair.b, reduceOnly: close },
      },
      projection: { aFilled, bFilled, unhedged: String(Number(aFilled) - Number(bFilled)) },
    });
    const { container, unmount } = render(<>{dealRunProps(view, null, 0, []).firstLine}</>);
    const text = container.querySelector('p')?.textContent ?? '';
    unmount();
    return text;
  };

  it('names each leg when the two legs closed different sizes', () => {
    const text = headline(true, '12', '11.9588');
    expect(text).toMatch(/^Closed · Gate 12\.00 ETH \(\$30,000\) \/ Closed · Binance 11\.95\d* ETH/);
    expect(text).not.toMatch(/each/);
  });

  it('says each when both legs filled the same size', () => {
    expect(headline(false, '12', '12')).toMatch(/^Opened 12\.00 ETH each/);
  });
});
