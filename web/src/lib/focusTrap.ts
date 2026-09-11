/**
 * Keyboard containment for an overlay (drawer, modal).
 *
 * On activation: remember what had focus, move focus into the container
 * (its first focusable control, else the container itself), and keep Tab /
 * Shift+Tab cycling inside it. On deactivation: hand focus back to where it
 * was. Without this a Tab from an open drawer landed on the page behind the
 * backdrop, and a screen reader never entered the dialog at all.
 */
import { useEffect, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const focusables = (root: HTMLElement): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.hasAttribute('hidden') && el.getClientRects().length > 0,
  );

export function useFocusTrap(ref: RefObject<HTMLElement>, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const root = ref.current;
    if (!root) return;
    const previous = document.activeElement as HTMLElement | null;
    // Focus the first control on the next frame: the panel may still be
    // laying out on the same tick it mounted.
    const raf = requestAnimationFrame(() => {
      // Already inside (the user clicked a control before this frame ran):
      // moving it would drop the keystrokes they are mid-way through.
      const current = document.activeElement;
      if (current && current !== document.body && root.contains(current)) return;
      const first = focusables(root)[0];
      if (first) first.focus();
      else {
        root.tabIndex = -1;
        root.focus();
      }
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = focusables(root);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement as HTMLElement | null;
      const inside = current !== null && root.contains(current);
      if (e.shiftKey && (current === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (current === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKey, true);
      if (previous && document.contains(previous)) previous.focus();
    };
  }, [ref, active]);
}
