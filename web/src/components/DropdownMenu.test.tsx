import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DropdownMenu } from './DropdownMenu';

function renderMenu() {
  const spies = { a: vi.fn(), b: vi.fn(), c: vi.fn() };
  render(
    <>
      <button type="button">Before</button>
      <DropdownMenu
        label="More actions"
        trigger={<span aria-hidden>...</span>}
        triggerClassName="btn-ghost-xs"
        items={[
          { label: 'Alpha', onSelect: spies.a },
          { label: 'Beta', onSelect: spies.b },
          { label: 'Gamma', onSelect: spies.c },
        ]}
      />
      <button type="button">After</button>
    </>,
  );
  return { trigger: screen.getByRole('button', { name: 'More actions' }), spies };
}

const item = (name: string) => screen.getByRole('menuitem', { name });

function stubBox(rect: Partial<DOMRect>) {
  const full = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}), ...rect } as DOMRect;
  vi.spyOn(HTMLButtonElement.prototype, 'getBoundingClientRect').mockReturnValue(full);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(128);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(100);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DropdownMenu', () => {
  it('trigger says it opens a menu', async () => {
    const { trigger } = renderMenu();
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('menu')).toBeNull();
    await userEvent.click(trigger);
    const menu = screen.getByRole('menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger).toHaveAttribute('aria-controls', menu.id);
    expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Alpha', 'Beta', 'Gamma']);
    for (const m of within(menu).getAllByRole('menuitem')) expect(m).toHaveAttribute('tabindex', '-1');
  });

  it('click opens with focus on the menu', async () => {
    const { trigger } = renderMenu();
    await userEvent.click(trigger);
    expect(screen.getByRole('menu')).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(item('Alpha')).toHaveFocus();
  });

  it('click on an open trigger closes it', async () => {
    const { trigger, spies } = renderMenu();
    await userEvent.click(trigger);
    await userEvent.click(trigger);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(spies.a).not.toHaveBeenCalled();
  });

  it.each([
    ['{Enter}', 'Alpha'],
    ['[Space]', 'Alpha'],
    ['{ArrowDown}', 'Alpha'],
    ['{ArrowUp}', 'Gamma'],
  ])('%s on the trigger opens on %s', async (key, first) => {
    const { trigger, spies } = renderMenu();
    trigger.focus();
    await userEvent.keyboard(key);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(item(first)).toHaveFocus();
    expect(spies.a).not.toHaveBeenCalled();
    expect(spies.c).not.toHaveBeenCalled();
  });

  it('arrows, Home and End move focus', async () => {
    const { trigger } = renderMenu();
    trigger.focus();
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.keyboard('{ArrowDown}');
    expect(item('Beta')).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(item('Gamma')).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(item('Alpha')).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}');
    expect(item('Gamma')).toHaveFocus();
    await userEvent.keyboard('{Home}');
    expect(item('Alpha')).toHaveFocus();
    await userEvent.keyboard('{End}');
    expect(item('Gamma')).toHaveFocus();
  });

  it('pointing at an item focuses it', async () => {
    const { trigger } = renderMenu();
    await userEvent.click(trigger);
    await userEvent.hover(item('Beta'));
    expect(item('Beta')).toHaveFocus();
  });

  it('Escape closes and returns focus', async () => {
    const { trigger, spies } = renderMenu();
    trigger.focus();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
    expect(spies.b).not.toHaveBeenCalled();
  });

  it('Tab closes the menu back on the trigger', async () => {
    const { trigger } = renderMenu();
    trigger.focus();
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.tab();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
  });

  it('outside click closes without a select', async () => {
    const { trigger, spies } = renderMenu();
    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole('button', { name: 'Before' }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(Object.values(spies).every((s) => s.mock.calls.length === 0)).toBe(true);
  });

  it('scroll and resize close it', async () => {
    const { trigger } = renderMenu();
    await userEvent.click(trigger);
    fireEvent.scroll(window);
    expect(screen.queryByRole('menu')).toBeNull();
    await userEvent.click(trigger);
    fireEvent(window, new Event('resize'));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('click on an item fires once and closes', async () => {
    const { trigger, spies } = renderMenu();
    await userEvent.click(trigger);
    await userEvent.click(item('Beta'));
    expect(spies.b).toHaveBeenCalledTimes(1);
    expect(spies.a).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it.each([['{Enter}'], ['[Space]']])('%s on an item selects it', async (key) => {
    const { trigger, spies } = renderMenu();
    trigger.focus();
    await userEvent.keyboard('{ArrowUp}');
    await userEvent.keyboard(key);
    expect(spies.c).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('the Space that opens the menu does not select the first item', async () => {
    const { trigger, spies } = renderMenu();
    trigger.focus();
    fireEvent.keyDown(trigger, { key: ' ' });
    await screen.findByRole('menu');
    expect(item('Alpha')).toHaveFocus();
    expect(fireEvent.keyUp(item('Alpha'), { key: ' ' })).toBe(false);
    expect(spies.a).not.toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('a double click fires once', async () => {
    const { trigger, spies } = renderMenu();
    await userEvent.click(trigger);
    const alpha = item('Alpha');
    act(() => {
      fireEvent.click(alpha);
      fireEvent.click(alpha);
    });
    expect(spies.a).toHaveBeenCalledTimes(1);
    await userEvent.click(trigger);
    await userEvent.click(item('Alpha'));
    expect(spies.a).toHaveBeenCalledTimes(2);
  });

  it('sits right-aligned under the trigger', async () => {
    stubBox({ top: 100, bottom: 120, left: 480, right: 500 });
    const { trigger } = renderMenu();
    await userEvent.click(trigger);
    const menu = screen.getByRole('menu');
    expect(menu.style.left).toBe('372px');
    expect(menu.style.top).toBe('126px');
    expect(menu.style.bottom).toBe('');
  });

  it('flips above when it does not fit below', async () => {
    stubBox({ top: window.innerHeight - 68, bottom: window.innerHeight - 48, left: 480, right: 500 });
    const { trigger } = renderMenu();
    await userEvent.click(trigger);
    const menu = screen.getByRole('menu');
    expect(menu.style.left).toBe('372px');
    expect(menu.style.top).toBe('');
    expect(menu.style.bottom).toBe('74px');
  });
});
