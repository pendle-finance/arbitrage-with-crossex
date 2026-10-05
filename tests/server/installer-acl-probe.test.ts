import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ps = readFileSync(new URL('../../install.ps1', import.meta.url), 'utf8');

function psFunction(name: string): string {
  const start = ps.indexOf(`\nfunction ${name} {`);
  expect(start, `${name} is gone from install.ps1`).toBeGreaterThan(0);
  return ps.slice(start, ps.indexOf('\n}', start) + 2);
}

describe('install.ps1 tells a locked file from a denied one', () => {
  it('opens each existing file with read-write sharing, so the open deals.sqlite of a running server passes', () => {
    const fn = psFunction('Protect-Directory');
    const loop = fn.slice(fn.indexOf('Get-ChildItem -File'));
    expect(loop).toMatch(/\[IO\.File\]::Open\(\$f\.FullName, 'Open', 'ReadWrite', 'ReadWrite'\)/);
  });
});
