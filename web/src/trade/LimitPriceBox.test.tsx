import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LimitPriceBox } from './LimitPriceBox';
import { MakerSettings, takerAfterSec, type TakerAfter } from './MakerSettings';
import { FoldRow } from './FoldRow';
import { EstimateHeadline } from './EstimateHeadline';

function Harness({ bookPrice = '1730' }: { bookPrice?: string | null }) {
  const [price, setPrice] = useState<string | null>(null);
  const [repeg, setRepeg] = useState<number | null>(5);
  const [taker, setTaker] = useState<TakerAfter>({ kind: '5m', sec: 300 });
  return (
    <>
      <LimitPriceBox bookPrice={bookPrice} value={price} onChange={setPrice} tick="0.01" />
      <MakerSettings
        legs={[
          { name: 'Gate', side: 'LONG' },
          { name: 'Hyperliquid', side: 'SHORT' },
        ]}
        makerLeg="auto"
        autoPick={{ auto: 'a', why: 'fees' }}
        onMakerLeg={() => {}}
        takerAfter={taker}
        onTakerAfter={setTaker}
        intervalSec={null}
        repegBehindBp={repeg}
        repegLocked={price !== null}
        onRepeg={setRepeg}
      />
    </>
  );
}

const priceInput = () => screen.getByLabelText('Limit price') as HTMLInputElement;
const foldRow = () => screen.getByRole('button', { name: /Maker settings/ });

describe('LimitPriceBox', () => {
  it('follows the book', () => {
    render(<Harness />);
    expect(priceInput()).toHaveValue('1,730.00');
    expect(priceInput().className).toContain('text-ink-400');
    expect(screen.getByText('Auto')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use the book price again' })).toBeNull();
    expect(foldRow()).toHaveTextContent('Gate maker · taker 5m · re-peg 0.05%');
  });

  it('typed price holds', async () => {
    render(<Harness />);
    await userEvent.clear(priceInput());
    await userEvent.type(priceInput(), '1725.00');
    expect(priceInput()).toHaveValue('1725.00');
    expect(priceInput().className).toContain('text-ink-50');
    expect(screen.getByRole('button', { name: 'Use the book price again' })).toHaveTextContent('Auto');
    expect(foldRow()).toHaveTextContent('re-peg off');
  });

  it('auto restores book and re-peg', async () => {
    render(<Harness />);
    fireEvent.change(priceInput(), { target: { value: '1,725.00' } });
    expect(priceInput()).toHaveValue('1725.00');
    await userEvent.click(screen.getByRole('button', { name: 'Use the book price again' }));
    expect(priceInput()).toHaveValue('1,730.00');
    expect(foldRow()).toHaveTextContent('re-peg 0.05%');
  });

  it('shows an empty box while the book is not read yet', () => {
    render(<Harness bookPrice={null} />);
    expect(priceInput()).toHaveValue('');
  });

  it('shows To best only when the caller gives it', async () => {
    const toBest = vi.fn();
    const { rerender } = render(<LimitPriceBox bookPrice="1730" value={null} onChange={() => {}} tick="0.01" />);
    expect(screen.queryByRole('button', { name: 'To best' })).toBeNull();
    rerender(<LimitPriceBox bookPrice="1730" value={null} onChange={() => {}} tick="0.01" toBest={toBest} />);
    await userEvent.click(screen.getByRole('button', { name: 'To best' }));
    expect(toBest).toHaveBeenCalledOnce();
  });
});

describe('MakerSettings', () => {
  function Settings(props: { intervalSec: number | null; start: TakerAfter; makerLeg?: 'auto' | 'a' | 'b'; onMakerLeg?: (v: 'auto' | 'a' | 'b') => void }) {
    const [taker, setTaker] = useState<TakerAfter>(props.start);
    return (
      <MakerSettings
        legs={[
          { name: 'Gate', side: 'LONG' },
          { name: 'Hyperliquid', side: 'SHORT' },
        ]}
        makerLeg={props.makerLeg ?? 'auto'}
        autoPick={{ auto: 'a', why: 'book' }}
        onMakerLeg={props.onMakerLeg ?? (() => {})}
        takerAfter={taker}
        onTakerAfter={setTaker}
        intervalSec={props.intervalSec}
        repegBehindBp={5}
        repegLocked={false}
        onRepeg={() => {}}
        marketSlippage={{ value: 0.5, onChange: () => {} }}
      />
    );
  }

  it('greys taker choices over 80% of the interval', async () => {
    render(<Settings intervalSec={300} start={{ kind: 'custom', sec: 240 }} />);
    expect(foldRow()).toHaveTextContent('Gate maker · taker 4m · re-peg 0.05%');
    await userEvent.click(foldRow());
    const group = screen.getByRole('radiogroup', { name: 'Taker after' });
    expect(within(group).getByRole('radio', { name: '5m' })).toBeDisabled();
    expect(within(group).getByRole('radio', { name: '5m' })).toHaveAttribute('title', 'Must be 80% of the interval or less (4m)');
    expect(within(group).getByRole('radio', { name: '10m' })).toBeDisabled();
    expect(within(group).getByRole('radio', { name: 'Never' })).toBeEnabled();
    expect(screen.getByLabelText('Taker after, custom time')).toHaveValue('4m');
  });

  it('12m interval enables 5m only', async () => {
    render(<Settings intervalSec={720} start={{ kind: '5m', sec: 300 }} />);
    await userEvent.click(foldRow());
    const group = screen.getByRole('radiogroup', { name: 'Taker after' });
    expect(within(group).getByRole('radio', { name: '5m' })).toBeEnabled();
    expect(within(group).getByRole('radio', { name: '10m' })).toBeDisabled();
  });

  it('custom box shows only after Custom and flags a time over the cap', async () => {
    render(<Settings intervalSec={300} start={{ kind: 'never', sec: null }} />);
    await userEvent.click(foldRow());
    expect(screen.queryByLabelText('Taker after, custom time')).toBeNull();
    await userEvent.click(screen.getByRole('radio', { name: 'Custom' }));
    const box = screen.getByLabelText('Taker after, custom time');
    await userEvent.type(box, '6m');
    expect(screen.getByText('Must be 80% of the interval or less (4m)')).toBeInTheDocument();
    await userEvent.clear(box);
    await userEvent.type(box, '10s');
    expect(screen.getByText('30s to 24h')).toBeInTheDocument();
  });

  it('a manual maker leg shows Reset, which goes back to Auto', async () => {
    const onMakerLeg = vi.fn();
    render(<Settings intervalSec={null} start={{ kind: '5m', sec: 300 }} makerLeg="b" onMakerLeg={onMakerLeg} />);
    expect(foldRow()).toHaveTextContent('Hyperliquid maker');
    await userEvent.click(foldRow());
    expect(screen.getByRole('radio', { name: 'Hyperliquid Short' })).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(onMakerLeg).toHaveBeenCalledWith('auto');
  });

  it('market slippage renders inside the fold', async () => {
    render(<Settings intervalSec={null} start={{ kind: '5m', sec: 300 }} />);
    await userEvent.click(foldRow());
    const group = screen.getByRole('radiogroup', { name: 'Market slippage' });
    expect(within(group).getByRole('radio', { name: '0.5%' })).toHaveAttribute('aria-checked', 'true');
  });

  it('takerAfterSec maps each choice', () => {
    expect(takerAfterSec({ kind: '5m', sec: null })).toBe(300);
    expect(takerAfterSec({ kind: '10m', sec: null })).toBe(600);
    expect(takerAfterSec({ kind: 'never', sec: null })).toBeNull();
    expect(takerAfterSec({ kind: 'custom', sec: 576 })).toBe(576);
  });
});

describe('FoldRow and EstimateHeadline', () => {
  it('fold row hides its body until opened', async () => {
    function Fold() {
      const [open, setOpen] = useState(false);
      return (
        <FoldRow label="Orders" summary="6" open={open} onToggle={() => setOpen((v) => !v)}>
          <span>body</span>
        </FoldRow>
      );
    }
    render(<Fold />);
    expect(screen.queryByText('body')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Orders/ }));
    expect(screen.getByText('body')).toBeInTheDocument();
  });

  it('headline aligns on the first baseline', () => {
    const { container } = render(<EstimateHeadline label="uPnL to realize" sub="Before fees" value="$12" />);
    expect(container.firstElementChild?.className).toContain('items-baseline');
  });
});
