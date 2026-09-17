import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HoverCard } from './HoverCard';

function renderCard(children: ReactNode) {
  render(
    <>
      <button type="button">Before</button>
      <HoverCard label="How">{children}</HoverCard>
      <button type="button">After</button>
    </>,
  );
  return screen.getByRole('button', { name: 'How' });
}

const twoLinks = (
  <>
    <a href="https://example.com/keys">API Management</a>
    <a href="https://example.com">Gate</a>
  </>
);

describe('HoverCard', () => {
  it('enter moves focus into a card with a link', async () => {
    const trigger = renderCard(twoLinks);
    trigger.focus();
    await userEvent.keyboard('{Enter}');

    const card = await screen.findByRole('tooltip');
    expect(within(card).getByRole('link', { name: 'API Management' })).toHaveFocus();
  });

  it('tab past the last link closes the card and returns to the trigger', async () => {
    const trigger = renderCard(twoLinks);
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    const card = await screen.findByRole('tooltip');

    await userEvent.tab();
    expect(within(card).getByRole('link', { name: 'Gate' })).toHaveFocus();

    await userEvent.tab();
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(trigger).toHaveFocus();

    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
  });

  it('shift tab from the first link closes the card and returns to the trigger', async () => {
    const trigger = renderCard(twoLinks);
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    await screen.findByRole('tooltip');

    await userEvent.tab({ shift: true });
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(trigger).toHaveFocus();

    await userEvent.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Before' })).toHaveFocus();
  });

  it('escape returns focus to the trigger', async () => {
    const trigger = renderCard(twoLinks);
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    const card = await screen.findByRole('tooltip');
    expect(within(card).getByRole('link', { name: 'API Management' })).toHaveFocus();

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('mouse open keeps focus where it was', async () => {
    const trigger = renderCard(twoLinks);
    const before = screen.getByRole('button', { name: 'Before' });
    before.focus();

    await userEvent.hover(trigger);
    await screen.findByRole('tooltip');
    expect(before).toHaveFocus();
  });

  it('enter on a focused card button presses it', async () => {
    const onPress = vi.fn();
    const trigger = renderCard(
      <button type="button" onClick={onPress}>
        Rebalance on Balances ▸
      </button>,
    );
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    const card = await screen.findByRole('tooltip');
    expect(within(card).getByRole('button', { name: 'Rebalance on Balances ▸' })).toHaveFocus();

    await userEvent.keyboard('{Enter}');
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('a link inside the card opens', async () => {
    const trigger = renderCard(
      <a href="https://example.com" target="_blank" rel="noreferrer">
        API Management
      </a>,
    );
    expect(fireEvent.click(trigger)).toBe(false);
    const card = await screen.findByRole('tooltip');

    expect(fireEvent.click(within(card).getByRole('link', { name: 'API Management' }))).toBe(true);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('a card with no link keeps focus on the trigger', async () => {
    const trigger = renderCard(<p>Fee is flat.</p>);
    trigger.focus();
    await userEvent.keyboard('{Enter}');

    await screen.findByRole('tooltip');
    expect(trigger).toHaveFocus();
  });

  it('tab away from a card with no focusable content closes it', async () => {
    const trigger = renderCard(<p>Fee is flat.</p>);
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    await screen.findByRole('tooltip');

    await userEvent.tab();
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
  });

  it('a card around a button opens on its focus and adds no tab stop', async () => {
    const onPress = vi.fn();
    render(
      <>
        <button type="button">Before</button>
        <HoverCard
          wrapsControl
          label={
            <button type="button" onClick={onPress}>
              Resume
            </button>
          }
        >
          <p>Continue from the stopped step.</p>
        </HoverCard>
        <button type="button">After</button>
      </>,
    );
    expect(screen.getAllByRole('button')).toHaveLength(3);
    screen.getByRole('button', { name: 'Before' }).focus();

    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Resume' })).toHaveFocus();
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Continue from the stopped step.');

    await userEvent.keyboard('{Enter}');
    expect(onPress).toHaveBeenCalledTimes(1);

    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('two cards never stay open together from the keyboard', async () => {
    render(
      <>
        <HoverCard label="First">
          <p>First card.</p>
        </HoverCard>
        <HoverCard label="Second">
          <p>Second card.</p>
        </HoverCard>
      </>,
    );
    const first = screen.getByRole('button', { name: 'First' });
    const second = screen.getByRole('button', { name: 'Second' });
    first.focus();
    await userEvent.keyboard('{Enter}');
    await screen.findByRole('tooltip');

    await userEvent.tab();
    expect(second).toHaveFocus();
    expect(screen.queryByRole('tooltip')).toBeNull();

    await userEvent.keyboard('{Enter}');
    expect(screen.getAllByRole('tooltip')).toHaveLength(1);
  });
});

describe('HoverCard placement', () => {
  const VIEW_HEIGHT = 800;

  /** The trigger sits at `top`, 20 px tall; the card's content is `height` px. */
  function place(top: number, height: number) {
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(VIEW_HEIGHT);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('role') === 'button' ? new DOMRect(40, top, 60, 20) : new DOMRect(0, 0, 0, 0);
    });
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('role') === 'tooltip' ? height : 0;
    });
    render(
      <HoverCard label="How">
        <p>A tall card.</p>
      </HoverCard>,
    );
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'How' }));
    return screen.getByRole('tooltip');
  }

  afterEach(() => vi.restoreAllMocks());

  it('opens below when it fits there', () => {
    const card = place(100, 300);
    expect(card.style.top).toBe('126px');
    expect(card.style.bottom).toBe('');
    expect(card.style.maxHeight).toBe('666px');
  });

  it('a card near the bottom that fits below still opens below', () => {
    const card = place(600, 120);
    expect(card.style.top).toBe('626px');
  });

  it('a tall card near the bottom opens above, where it fits', () => {
    const card = place(700, 500);
    expect(card.style.top).toBe('');
    expect(card.style.bottom).toBe('106px');
    expect(card.style.maxHeight).toBe('686px');
  });

  it('a card taller than either side takes the roomier side and scrolls inside', () => {
    const card = place(500, 900);
    expect(card.style.bottom).toBe('306px');
    expect(card.style.maxHeight).toBe('486px');
    expect(card).toHaveClass('overflow-y-auto');
  });

  it('scrolling inside the card keeps it open; scrolling the page closes it', () => {
    const card = place(500, 900);
    fireEvent.scroll(card);
    expect(screen.getByRole('tooltip')).toBe(card);
    fireEvent.scroll(window);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
