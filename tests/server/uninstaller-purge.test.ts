import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (f: string): string => readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');

function psFunction(ps: string, name: string): string {
  const start = ps.indexOf(`\nfunction ${name} {`);
  expect(start, `${name} is gone`).toBeGreaterThan(0);
  return ps.slice(start, ps.indexOf('\n}', start) + 2);
}

function purgeBlock(ps: string): string {
  const start = ps.indexOf('if ($Purge) {');
  expect(start, 'the -Purge branch is gone').toBeGreaterThan(0);
  const end = ps.indexOf('} else {', start);
  expect(end).toBeGreaterThan(start);
  return ps.slice(start, end);
}

function codeOnly(ps: string): string {
  return ps
    .replace(/<#[\s\S]*?#>/g, '')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n');
}

const REVOKE = 'Also revoke the Gate API key and the Boros agent. Deleting the file does not cancel them.';

describe('uninstall.ps1 -Purge never reports success while the folder is still on disk', () => {
  const ps = read('uninstall.ps1');

  it('has the same Invoke-WithRetry as install.ps1, defined before the -Purge branch', () => {
    expect(psFunction(ps, 'Invoke-WithRetry')).toBe(psFunction(read('install.ps1'), 'Invoke-WithRetry'));
    expect(ps.indexOf('\nfunction Invoke-WithRetry {')).toBeLessThan(ps.indexOf('if ($Purge) {'));
  });

  it('deletes the folder through Invoke-WithRetry and keeps the reason', () => {
    const purge = purgeBlock(ps);
    expect(purge).toMatch(/try\s*\{\s*Invoke-WithRetry\s*\{\s*Remove-Item -Recurse -Force \$Root\s*\}\s*\}\s*catch\s*\{[^}]*\$_\.Exception\.Message/);
    expect(purge).not.toMatch(/Remove-Item[^\n]*\$Root[^\n]*SilentlyContinue/);
  });

  it('checks the folder again, names config\\.env first, lists what is left, then throws', () => {
    const purge = purgeBlock(ps);
    const retry = purge.search(/Invoke-WithRetry\s*\{\s*Remove-Item -Recurse -Force \$Root/);
    const check = purge.indexOf('if (Test-Path $Root) {', retry);
    const keys = purge.indexOf("'config\\.env'", check);
    const onDisk = purge.indexOf('STILL ON DISK', keys);
    const left = purge.search(/Get-ChildItem[^\n]*\$Root/);
    const again = purge.indexOf('-Purge again', onDisk);
    const thrown = purge.search(/\n\s*throw /);
    expect(retry).toBeGreaterThan(0);
    expect(check).toBeGreaterThan(retry);
    expect(keys).toBeGreaterThan(check);
    expect(onDisk).toBeGreaterThan(keys);
    expect(left).toBeGreaterThan(check);
    expect(again).toBeGreaterThan(onDisk);
    expect(thrown).toBeGreaterThan(Math.max(onDisk, left, again));
    expect(purge.slice(onDisk, purge.indexOf('\n', onDisk))).toContain('-ForegroundColor Red');
  });

  it('prints the revoke line after the check, and "Uninstalled." only after the -Purge branch', () => {
    const purge = purgeBlock(ps);
    expect(purge.indexOf(REVOKE)).toBeGreaterThan(purge.search(/\n\s*throw /));
    expect(ps.indexOf("Say 'Uninstalled.'")).toBeGreaterThan(ps.indexOf(REVOKE));
  });

  it('never calls exit, which would close the trader PowerShell window', () => {
    expect(codeOnly(ps)).not.toMatch(/\bexit\b/i);
  });
});
