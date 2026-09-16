import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChartTooltip } from './ChartTooltip';

const WINDOW_SIZE = { innerWidth: window.innerWidth, innerHeight: window.innerHeight };

const setWindowSize = (innerWidth: number, innerHeight: number) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: innerWidth });
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: innerHeight });
};

const renderBar = (): HTMLElement => {
  render(
    <ChartTooltip content={<span>Cash 20.00</span>}>
      <div>bar</div>
    </ChartTooltip>,
  );
  const hit = document.querySelector<HTMLElement>('[data-bar-hit]');
  if (!hit) throw new Error('no hit area');
  return hit;
};

const placeOf = (tip: HTMLElement): string[] => [tip.style.left, tip.style.top];

describe('ChartTooltip', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setWindowSize(WINDOW_SIZE.innerWidth, WINDOW_SIZE.innerHeight);
  });

  it('shows beside the pointer and hides on leave', () => {
    const hit = renderBar();
    expect(screen.queryByRole('tooltip')).toBeNull();

    fireEvent.mouseEnter(hit, { clientX: 40, clientY: 30 });
    const tip = screen.getByRole('tooltip');
    expect(placeOf(tip)).toEqual(['52px', '42px']);
    expect(tip.textContent).toBe('Cash 20.00');
    expect(tip.parentElement).toBe(document.body);
    expect(tip.className).toContain('fixed');
    expect(tip.className).toContain('pointer-events-none');
    expect(tip.className).toContain('z-[60]');
    expect(hit.getAttribute('aria-describedby')).toBe(tip.id);

    fireEvent.mouseMove(hit, { clientX: 300, clientY: 200 });
    expect(placeOf(screen.getByRole('tooltip'))).toEqual(['312px', '212px']);

    fireEvent.mouseLeave(hit);
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(hit.hasAttribute('aria-describedby')).toBe(false);
  });

  it('stays inside the right and bottom edges', () => {
    setWindowSize(400, 300);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(200);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(80);
    const hit = renderBar();

    fireEvent.mouseMove(hit, { clientX: 390, clientY: 290 });
    expect(placeOf(screen.getByRole('tooltip'))).toEqual(['192px', '212px']);
  });

  it('a window that reads zero size still shows it', () => {
    setWindowSize(0, 0);
    const hit = renderBar();

    fireEvent.mouseMove(hit, { clientX: 40, clientY: 30 });
    expect(placeOf(screen.getByRole('tooltip'))).toEqual(['52px', '42px']);
  });

  it('focus shows it at the bar center and blur hides it', () => {
    const hit = renderBar();
    vi.spyOn(hit, 'getBoundingClientRect').mockReturnValue({
      x: 100,
      y: 20,
      left: 100,
      top: 20,
      right: 300,
      bottom: 32,
      width: 200,
      height: 12,
      toJSON: () => ({}),
    });
    expect(hit.tabIndex).toBe(0);

    fireEvent.focus(hit);
    expect(placeOf(screen.getByRole('tooltip'))).toEqual(['212px', '38px']);

    fireEvent.blur(hit);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('a click focus keeps the pointer place', () => {
    const hit = renderBar();

    fireEvent.mouseMove(hit, { clientX: 40, clientY: 30 });
    fireEvent.focus(hit);
    expect(placeOf(screen.getByRole('tooltip'))).toEqual(['52px', '42px']);
  });

  it('Escape closes the tooltip and not the modal around it', () => {
    const hit = renderBar();
    const onWindowKey = vi.fn();
    window.addEventListener('keydown', onWindowKey);

    fireEvent.focus(hit);
    fireEvent.keyDown(hit, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(onWindowKey).not.toHaveBeenCalled();

    fireEvent.keyDown(hit, { key: 'Escape' });
    expect(onWindowKey).toHaveBeenCalledTimes(1);
    window.removeEventListener('keydown', onWindowKey);
  });
});
