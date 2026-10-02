/**
 * restrictToOwner — owner-only permissions for the files holding the live-money
 * secret. The POSIX branch is a chmod; the WINDOWS branch is the interesting
 * one, and it used to be untested on every platform (its assertions were
 * skipped off-Windows, and the function catches everything so it cannot throw).
 * Mocking child_process lets the icacls sequence be asserted here, on any OS.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { restrictToOwner } from '../../src/server/secretFile';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn((cmd: string) =>
    // whoami /user /fo csv /nh — the SID the grant must be keyed on.
    cmd === 'whoami' ? '"HOST\\user","S-1-5-21-1-2-3-1001"\n' : '',
  ),
}));

// Pass-through, so one test can make a chmod fail: an ESM namespace cannot be spied on.
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return { ...real, chmodSync: vi.fn(real.chmodSync) };
});

const execMock = vi.mocked(execFileSync);

/** The icacls argument lists issued during one call (target stripped). */
const icaclsArgs = (): string[][] =>
  execMock.mock.calls
    .filter((c) => c[0] === 'icacls')
    .map((c) => (c[1] as string[]).slice(1));

/** Run the Windows branch on this machine. */
function asWindows<T>(fn: () => T): T {
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', real);
  }
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sec-'));

afterEach(() => {
  execMock.mockClear();
  vi.restoreAllMocks();
});

describe('restrictToOwner — POSIX', () => {
  it('makes a file owner-only and is idempotent', () => {
    const dir = tmpDir();
    const f = path.join(dir, '.env');
    fs.writeFileSync(f, 'GATE_KEY=secret\n', { mode: 0o644 });
    restrictToOwner(f);
    restrictToOwner(f);
    if (process.platform !== 'win32') expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('makes a directory owner-only', () => {
    const dir = tmpDir();
    fs.chmodSync(dir, 0o755);
    restrictToOwner(dir);
    if (process.platform !== 'win32') expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('never throws on a missing path', () => {
    expect(() => restrictToOwner(path.join(os.tmpdir(), 'nope-does-not-exist-xyz'))).not.toThrow();
  });

  it('warns once, and does not throw, when the chmod fails', () => {
    const dir = tmpDir();
    vi.mocked(fs.chmodSync).mockImplementationOnce(() => {
      throw new Error('EPERM: operation not permitted');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => restrictToOwner(dir)).not.toThrow();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/could not make .* owner-only \(EPERM/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('restrictToOwner — Windows branch', () => {
  it('grants BEFORE dropping inheritance (the ordering that avoids an empty DACL)', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, '.env'), 'K=v\n');
    asWindows(() => restrictToOwner(dir));

    // The whole point of the sequence: a failed grant AFTER /inheritance:r
    // leaves a DACL that locks out even the owner.
    expect(icaclsArgs()).toEqual([
      ['/grant:r', '*S-1-5-21-1-2-3-1001:(OI)(CI)F'],
      ['/inheritance:r'],
    ]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('uses the file grant form (no inheritance flags) on a file', () => {
    const dir = tmpDir();
    const f = path.join(dir, '.env');
    fs.writeFileSync(f, 'K=v\n');
    asWindows(() => restrictToOwner(f));
    expect(icaclsArgs()[0]).toEqual(['/grant:r', '*S-1-5-21-1-2-3-1001:(F)']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('leaves the ACL alone when the SID cannot be resolved', () => {
    const dir = tmpDir();
    execMock.mockImplementationOnce(() => {
      throw new Error('whoami unavailable');
    });
    asWindows(() => restrictToOwner(dir));
    expect(icaclsArgs()).toEqual([]); // a grantee we cannot name = no change
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('skips read-only files instead of reverting the whole directory', () => {
    // The old probe threw on any read-only file and then ran a RECURSIVE
    // reset — undoing the protection on every boot, silently. A read-only
    // attribute says nothing about the DACL, so such files are not evidence.
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'readonly.bak'), 'x', { mode: 0o444 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    asWindows(() => restrictToOwner(dir));

    expect(icaclsArgs().some((a) => a[0] === '/reset')).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a genuinely unusable target is reported and reset — scoped, never recursive', () => {
    const dir = tmpDir();
    // Write bit set but unreadable: an r+ open really fails, which is exactly
    // the lockout the probe exists to catch.
    const f = path.join(dir, 'locked');
    fs.writeFileSync(f, 'x');
    fs.chmodSync(f, 0o200);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    asWindows(() => restrictToOwner(dir));

    const resets = icaclsArgs().filter((a) => a[0] === '/reset');
    expect(resets).toEqual([['/reset']]); // no /t, no /c — this path only
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/not usable after tightening/);
    fs.chmodSync(f, 0o600);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
