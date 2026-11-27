import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Modal } from './Modal';

const tabs = <span role="radiogroup" aria-label="Venue" />;

describe('Modal close button', () => {
  it('a tabbed window ends its tab row with a close button', () => {
    const onClose = vi.fn();
    render(<Modal tabbed title={tabs} onClose={onClose}>body</Modal>);
    fireEvent.click(screen.getByRole('button', { name: 'close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a window with no title still has a close button', () => {
    const onClose = vi.fn();
    render(<Modal title={null} onClose={onClose}>body</Modal>);
    fireEvent.click(screen.getByRole('button', { name: 'close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a locked window has no close button', () => {
    render(<Modal tabbed locked title={tabs} onClose={() => {}}>body</Modal>);
    render(<Modal locked title={null} onClose={() => {}}>body</Modal>);
    expect(screen.queryByRole('button', { name: 'close' })).toBeNull();
  });
});
