import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SetupRowFrame } from './SetupRowFrame';
import type { SetupRowProps } from './setupState';

function baseRow(open: boolean, variant: SetupRowProps['variant'] = 'settings'): SetupRowProps {
  return { open, onOpen: vi.fn(), onClose: vi.fn(), onDone: vi.fn(), variant };
}

describe('SetupRowFrame', () => {
  it('keeps the amber "!" on a warn row while it is open', () => {
    render(
      <SetupRowFrame n={3} title="Telegram alerts" row={baseRow(true)} isDone={false} state="not set up" isWarn>
        content
      </SetupRowFrame>,
    );

    const row = screen.getByRole('region', { name: 'Telegram alerts' });
    expect(row).toHaveTextContent('!');
    expect(row).not.toHaveTextContent('3');
  });

  it('keeps the cyan step number on a fresh row that is open and not warn', () => {
    render(
      <SetupRowFrame n={1} title="Gate API key" row={baseRow(true, 'setup')} isDone={false} state={null}>
        content
      </SetupRowFrame>,
    );

    const row = screen.getByRole('region', { name: 'Gate API key' });
    expect(row).toHaveTextContent('1');
  });

  it('gives a not set up row the amber border, and a sync failed or done row none', () => {
    const { rerender } = render(
      <SetupRowFrame n={3} title="Telegram alerts" row={baseRow(false)} isDone={false} state={null}>
        content
      </SetupRowFrame>,
    );
    expect(screen.getByRole('region', { name: 'Telegram alerts' })).toHaveClass('border-gold/45');

    rerender(
      <SetupRowFrame n={3} title="Telegram alerts" row={baseRow(false)} isDone state="Last sync failed at 14:02" isWarn>
        content
      </SetupRowFrame>,
    );
    expect(screen.getByRole('region', { name: 'Telegram alerts' })).not.toHaveClass('border-gold/45');

    rerender(
      <SetupRowFrame n={3} title="Telegram alerts" row={baseRow(false)} isDone state="Both on">
        content
      </SetupRowFrame>,
    );
    expect(screen.getByRole('region', { name: 'Telegram alerts' })).not.toHaveClass('border-gold/45');
  });
});
