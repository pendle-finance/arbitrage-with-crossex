import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (f: string): string => readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');

const ps = read('install.ps1');

function psFunction(name: string): string {
  const start = ps.indexOf(`\nfunction ${name} {`);
  expect(start, `${name} is gone from install.ps1`).toBeGreaterThan(0);
  return ps.slice(start, ps.indexOf('\n}', start) + 2);
}

const pathToken = String.raw`(\$\w+|\(?Join-Path\s+\$Root\s+'[^']+'\)?)`;
const bareNode = /Join-Path\s+\$Root\s+['"]node(\\[^'"]*)?['"]/;

interface Op {
  kind: 'move' | 'remove' | 'test';
  from: string;
  to?: string;
  at: number;
}

function resolver(body: string): (token: string) => string {
  const dirs = new Map<string, string>();
  for (const m of body.matchAll(/\$(\w+)\s*=\s*Join-Path\s+\$Root\s+'([^']+)'/g)) dirs.set(m[1], m[2]);
  return (token) => {
    const inline = token.match(/^\(?Join-Path\s+\$Root\s+'([^']+)'\)?$/);
    if (inline) return inline[1];
    return dirs.get(token.slice(1)) ?? token;
  };
}

function ops(body: string): Op[] {
  const r = resolver(body);
  const out: Op[] = [];
  for (const m of body.matchAll(new RegExp(String.raw`Move-Item\s+-Path\s+${pathToken}\s+-Destination\s+${pathToken}`, 'g'))) {
    out.push({ kind: 'move', from: r(m[1]), to: r(m[2]), at: m.index });
  }
  for (const m of body.matchAll(new RegExp(String.raw`Remove-Item\s+(?:-\w+\s+)*${pathToken}`, 'g'))) {
    out.push({ kind: 'remove', from: r(m[1]), at: m.index });
  }
  for (const m of body.matchAll(new RegExp(String.raw`Test-Path\s+${pathToken}`, 'g'))) {
    out.push({ kind: 'test', from: r(m[1]), at: m.index });
  }
  return out.sort((a, b) => a.at - b.at);
}

const moves = (body: string): Op[] => ops(body).filter((o) => o.kind === 'move');

describe('install.ps1 stages a new Node.js runtime and swaps it in only after the server stops', () => {
  it('Install-Node never deletes or moves $Root\\node', () => {
    const body = psFunction('Install-Node');
    const touched = ops(body)
      .filter((o) => o.kind !== 'test')
      .flatMap((o) => [o.from, o.to]);
    expect(touched).not.toContain('node');
    expect(body).not.toMatch(/Join-Path\s+\$Root\s+['"]node['"]/);
  });

  it('Install-Node unpacks the download into node.new', () => {
    expect(moves(psFunction('Install-Node')).map((o) => o.to)).toEqual(['node.new']);
  });

  it('Install-Node clears a stale node.new and node.old before its version check, which still reads node\\node.exe', () => {
    const body = psFunction('Install-Node');
    const skip = body.indexOf('already installed');
    expect(skip).toBeGreaterThan(0);
    const cleared = ops(body)
      .filter((o) => o.kind === 'remove' && o.at < skip)
      .map((o) => o.from);
    expect(cleared).toEqual(expect.arrayContaining(['node.new', 'node.old']));
    expect(body).toMatch(/Join-Path\s+\$Root\s+'node\\node\.exe'/);
  });

  it('Get-NodeDir returns node.new when it exists, else node', () => {
    const body = psFunction('Get-NodeDir');
    const r = resolver(body);
    const m = body.match(
      new RegExp(String.raw`if\s*\(\s*Test-Path\s+${pathToken}\s*\)\s*\{\s*${pathToken}\s*\}\s*else\s*\{\s*${pathToken}\s*\}`),
    );
    expect(m, 'Get-NodeDir is not one if/else on Test-Path').not.toBeNull();
    const [, tested, then, otherwise] = m as RegExpMatchArray;
    expect([r(tested), r(then), r(otherwise)]).toEqual(['node.new', 'node.new', 'node']);
  });

  it('Install-Yarn installs yarn into the runtime that Get-NodeDir returns', () => {
    const body = psFunction('Install-Yarn');
    expect(body).toMatch(/\$nodeDir\s*=\s*Get-NodeDir\b/);
    expect(body).not.toMatch(bareNode);
  });

  it('Build-App runs yarn from, and puts on PATH, the runtime that Get-NodeDir returns', () => {
    const body = psFunction('Build-App');
    expect(body).toMatch(/Get-NodeDir\b/);
    expect(body).not.toMatch(bareNode);
    const lines = body.split('\n');
    const fromNodeDir = /Get-NodeDir\b|\$nodeDir\b/;
    expect(lines.find((l) => /^\s*\$yarn\s*=/.test(l))).toMatch(fromNodeDir);
    expect(lines.find((l) => /\$env:PATH\s*=/.test(l))).toMatch(fromNodeDir);
  });

  it('the main block calls Swap-Node after Stop-RunningService and before Swap-App', () => {
    const calls = ps
      .slice(ps.lastIndexOf('\ntry {'))
      .split('\n')
      .map((l) => l.trim().split(/\s/)[0]);
    const at = (name: string): number => {
      expect(
        calls.filter((c) => c === name),
        `${name} in the main block`,
      ).toHaveLength(1);
      return calls.indexOf(name);
    };
    expect(at('Stop-RunningService')).toBeLessThan(at('Swap-Node'));
    expect(at('Swap-Node')).toBeLessThan(at('Swap-App'));
  });

  it('Swap-Node moves node to node.old, then node.new to node, and puts node.old back if that fails', () => {
    const body = psFunction('Swap-Node');
    const all = ops(body);
    const m = moves(body);
    expect(m.map((o) => `${o.from} -> ${o.to}`)).toEqual(['node -> node.old', 'node.new -> node', 'node.old -> node']);
    const staged = all.find((o) => o.kind === 'test' && o.from === 'node.new');
    expect(staged?.at ?? Number.POSITIVE_INFINITY).toBeLessThan(m[0].at);
    const cleared = all.find((o) => o.kind === 'remove' && o.from === 'node.old');
    expect(cleared?.at ?? Number.POSITIVE_INFINITY).toBeLessThan(m[0].at);
    const handler = body.indexOf('catch', m[1].at);
    expect(handler).toBeGreaterThan(m[1].at);
    expect(handler).toBeLessThan(m[2].at);
    expect(body.indexOf('throw', m[2].at)).toBeGreaterThan(m[2].at);
  });

  it('Restore-App puts node.old back after it reaps the new server and before it restarts the service', () => {
    const body = psFunction('Restore-App');
    const all = ops(body);
    const back = moves(body).find((o) => o.from === 'node.old' && o.to === 'node');
    const aside = moves(body).find((o) => o.from === 'node');
    expect(back, 'Restore-App never moves node.old back to node').toBeDefined();
    expect(aside, 'Restore-App never moves the failed node out of the way').toBeDefined();
    const backAt = (back as Op).at;
    const asideAt = (aside as Op).at;
    expect(['node', 'node.old']).not.toContain((aside as Op).to);
    expect(asideAt).toBeLessThan(backAt);
    const guard = all.find((o) => o.kind === 'test' && o.from === 'node.old');
    expect(guard?.at ?? Number.POSITIVE_INFINITY).toBeLessThan(asideAt);
    const reap = body.indexOf('Stop-StaleServer');
    expect(reap).toBeGreaterThan(0);
    expect(body.lastIndexOf('try {', asideAt)).toBeGreaterThan(reap);
    expect(backAt).toBeLessThan(body.indexOf('} catch {'));
    expect(backAt).toBeLessThan(body.indexOf('Install-Service'));
  });

  it('Remove-OldApp also deletes node.old, even without app.old, and never fails over it', () => {
    const body = psFunction('Remove-OldApp');
    const del = ops(body).find((o) => o.kind === 'remove' && o.from === 'node.old');
    expect(del, 'Remove-OldApp leaves node.old behind').toBeDefined();
    const at = (del as Op).at;
    const line = body.slice(body.lastIndexOf('\n', at), body.indexOf('\n', at));
    expect(line).toMatch(/\btry\b[\s\S]*\bcatch\b/);
    const firstReturn = body.search(/\breturn\b/);
    expect(firstReturn === -1 || at < firstReturn).toBe(true);
  });

  it('the live service is still matched and started from $Root\\node', () => {
    expect(psFunction('Get-ServerProcess')).toMatch(/\$nodeDir\s*=\s*\(Join-Path\s+\$Root\s+'node'\)\s*\+\s*'\\'/);
    expect(ps).toMatch(/FilePath\s*=\s*"`\$root\\node\\node\.exe"/);
  });
});

describe('uninstall.ps1', () => {
  it('removes node.new and node.old with the rest of the runtime', () => {
    const list = read('uninstall.ps1').match(/foreach \(\$d in @\(([^)]*'app\.old'[^)]*)\)\)/)?.[1];
    expect(list, 'the removal list is gone from uninstall.ps1').toBeDefined();
    const dirs = [...(list as string).matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(dirs).toEqual(expect.arrayContaining(['node', 'node.new', 'node.old']));
  });
});
