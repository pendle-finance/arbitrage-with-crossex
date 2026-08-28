/**
 * The installer half of the duplicate-tab fix.
 *
 * version.test.ts covers the server end — the updater sets BOROS_NO_BROWSER=1
 * for both platforms. This covers the other end: that install.sh really does
 * skip its parting `open`, and that install.ps1 has no way out that misses the
 * guard. Without this, the two halves can drift apart and nobody finds out
 * until a user reports a second tab.
 *
 * install.sh is RUN, not read: the closing block of the real file is executed
 * with `say` and `open` stubbed, so it fails on a dropped guard rather than on
 * reworded text. install.ps1 is only read — there is no PowerShell on macOS or
 * on CI, so its check is the narrower "every browser open names the guard".
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (f: string): string => readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');

/** The tail of install.sh's main(), from the guard comment to its closing `}`. */
function closingBlock(): string {
  const sh = read('install.sh');
  const start = sh.indexOf('# BOROS_NO_BROWSER');
  const end = sh.indexOf('\n}', start);
  expect(start, 'the BOROS_NO_BROWSER guard is gone from install.sh').toBeGreaterThan(0);
  return sh.slice(start, end);
}

function runClosing(env: Record<string, string> = {}): string {
  // `open` is a real macOS binary; a shell function of the same name shadows it.
  const script = [
    'set -euo pipefail',
    // The two variables the block reads; an unbound one fails loudly here.
    'PORT=6688',
    "APP_TITLE='Arbitrage with CrossEx'",
    `say() { printf '==> %s\\n' "$*"; }`,
    'open() { echo "OPENED $*"; }',
    closingBlock(),
  ].join('\n');
  // A developer who happens to export it must not decide the unset case.
  const { BOROS_NO_BROWSER: _unset, ...clean } = process.env;
  return execFileSync('bash', ['-c', script], { encoding: 'utf8', env: { ...clean, ...env } });
}

describe('install.sh and the update that is already watching its own page', () => {
  it('opens the app when someone runs the installer by hand', () => {
    const out = runClosing();
    expect(out).toContain('OPENED http://localhost:6688');
    expect(out).toContain('Done! Opening');
  });

  it('opens nothing when the in-app updater set BOROS_NO_BROWSER', () => {
    const out = runClosing({ BOROS_NO_BROWSER: '1' });
    expect(out).not.toContain('OPENED');
    expect(out).toContain('==> Done!');
    // The line must not promise an open that is not coming either.
    expect(out).not.toContain('Done! Opening');
  });
});

describe('install.ps1', () => {
  it('has no browser open that skips the guard', () => {
    const opens = read('install.ps1')
      .split('\n')
      .filter((l) => /Start-Process\s+["']http/.test(l));
    expect(opens.length).toBeGreaterThan(0);
    for (const line of opens) expect(line).toContain('BOROS_NO_BROWSER');
  });
});
