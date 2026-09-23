import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Buttons side by side must share one height. A full-size button (.btn,
 * .btn-primary, .btn-danger: 36px) next to a small one (.btn-ghost-xs: 24px)
 * is the mismatch this guards. Put questions in InlineConfirm; give a Cancel
 * or Close next to a full-size action the .btn class.
 */
const SRC = join(__dirname, '..');
const FULL = /className=[{"`]+(btn|btn-primary|btn-danger)[\s"`]/;
const SMALL = /btn-ghost-xs/;
const WINDOW = 12;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith('.tsx') && !name.includes('.test.') ? [path] : [];
  });
}

describe('button sizes', () => {
  it('no small button sits within a few lines of a full-size one', () => {
    const mixed = sources(SRC).flatMap((path) => {
      const lines = readFileSync(path, 'utf8').split('\n');
      return lines.flatMap((line, i) =>
        SMALL.test(line) && lines.slice(Math.max(0, i - WINDOW), i + WINDOW).some((near) => FULL.test(near))
          ? [`${path.slice(SRC.length + 1)}:${i + 1}`]
          : [],
      );
    });
    expect(mixed).toEqual([]);
  });
});
