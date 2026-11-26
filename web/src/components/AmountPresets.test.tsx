import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AmountPresets } from './AmountPresets';

function renderPresets() {
  const onApply = vi.fn();
  const onPreset = vi.fn();
  render(
    <AmountPresets<'10' | '20'>
      value="1"
      onChange={() => {}}
      inputLabel="Size"
      presets={[
        { value: '10', label: '10%' },
        { value: '20', label: '20%' },
      ]}
      preset="10"
      presetsLabel="Share"
      onPreset={onPreset}
      custom={{ label: 'Custom', unit: '%', inputLabel: 'Custom %', max: 100, onApply }}
    />,
  );
  fireEvent.click(screen.getByRole('radio', { name: 'Custom' }));
  return { onApply, onPreset, input: screen.getByLabelText('Custom %') };
}

describe('AmountPresets Custom', () => {
  it('keeps the box and the text open on blur when the value is over the max', () => {
    const { onApply, input } = renderPresets();
    fireEvent.change(input, { target: { value: '150' } });
    fireEvent.blur(input);
    const still = screen.getByLabelText('Custom %');
    expect(still).toHaveValue('150');
    expect(still).toHaveAttribute('aria-invalid', 'true');
    expect(still.getAttribute('title')).toMatch(/100/);
    expect(onApply).not.toHaveBeenCalled();
  });

  it('applies a good value on blur and closes the box', () => {
    const { onApply, input } = renderPresets();
    fireEvent.change(input, { target: { value: '50' } });
    fireEvent.blur(input);
    expect(onApply).toHaveBeenCalledWith(50);
    expect(screen.queryByLabelText('Custom %')).toBeNull();
  });

  it('closes a bad Custom box when the trader picks a preset', () => {
    const { onApply, onPreset, input } = renderPresets();
    fireEvent.change(input, { target: { value: '150' } });
    fireEvent.blur(input);
    fireEvent.click(screen.getByRole('radio', { name: '20%' }));
    expect(onPreset).toHaveBeenCalledWith('20');
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Custom %')).toBeNull();
  });
});
