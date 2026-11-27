import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ListPicker, type ListPickerRow } from './ListPicker';

const rows = (keys: string[]): ListPickerRow<string>[] => keys.map((key) => ({ key, name: `Wallet ${key}` }));

describe('ListPicker', () => {
  it('Enter picks the last row after the list shrinks under the highlighted row', () => {
    const onChange = vi.fn();
    const { rerender } = render(<ListPicker rows={rows(['a', 'b', 'c'])} value="a" onChange={onChange} label="Wallet" />);
    fireEvent.click(screen.getByRole('button', { name: 'Wallet' }));
    const list = screen.getByRole('listbox');
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(list).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: 'Wallet c' }).id);
    rerender(<ListPicker rows={rows(['a', 'b'])} value="a" onChange={onChange} label="Wallet" />);
    const shrunk = screen.getByRole('listbox');
    expect(shrunk).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: 'Wallet b' }).id);
    expect(screen.getByRole('option', { name: 'Wallet b' })).toHaveClass('bg-info/15');
    expect(() => fireEvent.keyDown(shrunk, { key: 'Enter' })).not.toThrow();
    expect(onChange).toHaveBeenCalledWith('b');
  });
});

describe('ListPicker type-ahead', () => {
  const markets: ListPickerRow<string>[] = [
    { key: '1', name: 'ETH Binance' },
    { key: '2', name: 'BTC Binance' },
    { key: '3', name: 'BTC Hyperliquid', disabled: true },
    { key: '4', name: 'BTC OKX' },
    { key: '5', name: 'SOL Gate' },
  ];
  const active = () => screen.getByRole('listbox').getAttribute('aria-activedescendant');
  const option = (name: string) => screen.getByRole('option', { name }).id;

  it('a letter moves the highlight to the next enabled row that starts with it, and wraps', () => {
    const onChange = vi.fn();
    render(<ListPicker rows={markets} value="1" onChange={onChange} label="Market" />);
    fireEvent.click(screen.getByRole('button', { name: 'Market' }));
    const list = screen.getByRole('listbox');
    fireEvent.keyDown(list, { key: 'b' });
    expect(active()).toBe(option('BTC Binance'));
    fireEvent.keyDown(list, { key: 'B' });
    expect(active()).toBe(option('BTC OKX'));
    fireEvent.keyDown(list, { key: 'b' });
    expect(active()).toBe(option('BTC Binance'));
    fireEvent.keyDown(list, { key: 'x' });
    expect(active()).toBe(option('BTC Binance'));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('2');
  });

  it('a letter on the closed picker opens it at the match without picking', () => {
    const onChange = vi.fn();
    render(<ListPicker rows={markets} value="" onChange={onChange} label="Market" />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Market' }), { key: 's' });
    expect(active()).toBe(option('SOL Gate'));
    expect(onChange).not.toHaveBeenCalled();
  });
});
