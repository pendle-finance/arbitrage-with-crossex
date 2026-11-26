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
