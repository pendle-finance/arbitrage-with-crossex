import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const read = (f: string): string => readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');

function shFunction(sh: string, name: string): string {
  const start = sh.indexOf(`\n${name}() {`);
  expect(start, `${name} is gone from install.sh`).toBeGreaterThan(0);
  return sh.slice(start, sh.indexOf('\n}', start) + 2);
}

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe('the installers ignore a yarnPath from the folder they are run in', () => {
  it('install.sh runs every yarn call with YARN_IGNORE_PATH=1', () => {
    const root = mkdtempSync(join(tmpdir(), 'boros-yarn-'));
    roots.push(root);
    mkdirSync(join(root, 'node', 'bin'), { recursive: true });
    const log = join(root, 'yarn.log');
    const stub = join(root, 'node', 'bin', 'yarn');
    writeFileSync(stub, `#!/bin/sh\necho "YARN_IGNORE_PATH=\${YARN_IGNORE_PATH:-unset}" >> "${log}"\n`);
    chmodSync(stub, 0o755);
    const sh = read('install.sh');
    const script = [
      'set -euo pipefail',
      `ROOT='${root}'`,
      `say() { :; }`,
      `fail() { echo "FAIL $*" >&2; exit 1; }`,
      shFunction(sh, 'run_step'),
      shFunction(sh, 'build_app'),
      'build_app',
    ].join('\n');
    const { YARN_IGNORE_PATH: _y, ...clean } = process.env;
    execFileSync('bash', ['-c', script], { encoding: 'utf8', env: clean });
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(Array(3).fill('YARN_IGNORE_PATH=1'));
  });

  it('install.ps1 sets YARN_IGNORE_PATH before its first yarn call', () => {
    const ps = read('install.ps1');
    const build = ps.slice(ps.indexOf('function Build-App {'));
    const set = build.indexOf("$env:YARN_IGNORE_PATH = '1'");
    expect(set).toBeGreaterThan(0);
    expect(set).toBeLessThan(build.indexOf('& $yarn'));
  });
});
