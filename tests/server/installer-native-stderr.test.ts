import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (f: string): string => readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');

function psFunction(ps: string, name: string): string {
  const start = ps.indexOf(`\nfunction ${name} {`);
  expect(start, `${name} is gone from install.ps1`).toBeGreaterThan(0);
  return ps.slice(start, ps.indexOf('\n}', start) + 2);
}

const STDERR_REDIRECT = /(?:^|\s)[2*]>/;
const ICACLS_OR_NPM = /&\s*(?:icacls\b|\$npm\b)/i;

describe('install.ps1: a native tool writing to stderr cannot stop the install on Windows PowerShell 5.1', () => {
  const ps = read('install.ps1');

  it('Invoke-Native sets Continue around the call and restores the old value in finally', () => {
    const fn = psFunction(ps, 'Invoke-Native');
    const call = fn.match(/param\(\s*\[scriptblock\]\s*\$(\w+)\s*\)/i)?.[1];
    const saved = fn.match(/\$(\w+)\s*=\s*\$ErrorActionPreference\b/i);
    expect(call).toBeDefined();
    expect(saved).not.toBeNull();
    const savedName = (saved as RegExpMatchArray)[1];
    const savedAt = fn.indexOf((saved as RegExpMatchArray)[0]);
    const relaxAt = fn.search(/\$ErrorActionPreference\s*=\s*'Continue'/i);
    const tryAt = fn.search(/\btry\s*\{/i);
    const runAt = fn.search(new RegExp(`&\\s*\\$${call}\\b`, 'i'));
    const fin = fn.match(/\bfinally\s*\{([^}]*)\}/i);
    expect(fin).not.toBeNull();
    const finallyAt = fn.indexOf((fin as RegExpMatchArray)[0]);
    expect(savedAt).toBeGreaterThan(0);
    expect(relaxAt).toBeGreaterThan(savedAt);
    expect(tryAt).toBeGreaterThan(relaxAt);
    expect(runAt).toBeGreaterThan(tryAt);
    expect(finallyAt).toBeGreaterThan(runAt);
    expect((fin as RegExpMatchArray)[1]).toMatch(new RegExp(`\\$ErrorActionPreference\\s*=\\s*\\$${savedName}\\b`, 'i'));
  });

  it('every icacls or npm call that redirects stderr runs inside Invoke-Native', () => {
    const calls = ps
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .filter((l) => ICACLS_OR_NPM.test(l));
    for (const site of ["'/grant:r'", "'/inheritance:r'", "'/reset'", 'yarn@']) {
      expect(
        calls.some((l) => l.includes(site)),
        `the ${site} call is gone`,
      ).toBe(true);
    }
    const redirected = calls.filter((l) => STDERR_REDIRECT.test(l));
    expect(redirected.length).toBeGreaterThanOrEqual(4);
    for (const line of redirected) {
      const inner = line.match(/Invoke-Native\s*\{(.*)\}/i)?.[1];
      expect(inner, `not wrapped: ${line.trim()}`).toBeDefined();
      expect(inner).toMatch(ICACLS_OR_NPM);
      expect(inner).toMatch(STDERR_REDIRECT);
    }
  });

  it('the grant still captures the icacls output for the note and checks its exit code', () => {
    const fn = psFunction(ps, 'Protect-Directory');
    const grant = fn.match(/\$(\w+)\s*=\s*Invoke-Native\s*\{[^\n]*'\/grant:r'[^\n]*\}/i);
    expect(grant, 'the grant does not capture Invoke-Native output').not.toBeNull();
    const after = fn.slice(fn.indexOf((grant as RegExpMatchArray)[0]) + (grant as RegExpMatchArray)[0].length);
    expect(after.trimStart()).toMatch(/^if\s*\(\s*\$LASTEXITCODE\s+-ne\s+0\s*\)/i);
    expect(after.slice(0, after.indexOf('return'))).toContain(`$${(grant as RegExpMatchArray)[1]}`);
  });
});
