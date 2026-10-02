import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (f: string): string => readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');

function psFunction(ps: string, name: string): string {
  const start = ps.indexOf(`\nfunction ${name} {`);
  expect(start, `${name} is gone from install.ps1`).toBeGreaterThan(0);
  return ps.slice(start, ps.indexOf('\n}', start) + 2);
}

function statements(body: string): string[] {
  return body
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l))
    .join('\n')
    .replace(/`\r?\n\s*/g, ' ')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

describe('install.ps1 keeps the service alive between logons', () => {
  const body = statements(psFunction(read('install.ps1'), 'Install-Service'));
  const register = body.findIndex((s) => /^Register-ScheduledTask\b/i.test(s));

  function registeredTriggers(): string[] {
    expect(register, 'Register-ScheduledTask is gone from Install-Service').toBeGreaterThanOrEqual(0);
    const arg = /-Trigger\s+(@\([^)]*\)|\$\w+(?:\s*,\s*\$\w+)*)/i.exec(body[register])?.[1];
    expect(arg, 'Register-ScheduledTask has no -Trigger').toBeDefined();
    return [...(arg as string).matchAll(/\$(\w+)/g)].map((m) => m[1]);
  }

  function definition(name: string | undefined): { at: number; text: string } {
    expect(name, 'Register-ScheduledTask does not get this trigger').toBeDefined();
    const at = body.findIndex((s) => new RegExp(`^\\$${name}\\s*=\\s*New-ScheduledTaskTrigger\\b`, 'i').test(s));
    expect(at, `$${name} is not made by New-ScheduledTaskTrigger`).toBeGreaterThanOrEqual(0);
    expect(at).toBeLessThan(register);
    return { at, text: body[at] };
  }

  it('registers two triggers', () => {
    const names = registeredTriggers();
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
  });

  it('the first trigger starts the task at logon', () => {
    expect(definition(registeredTriggers()[0]).text).toMatch(/-AtLogOn\b/i);
  });

  it('the second trigger is a time trigger that starts after install and repeats every minute', () => {
    const { text } = definition(registeredTriggers()[1]);
    expect(text).toMatch(/-Once\b/i);
    expect(text).not.toMatch(/-AtLogOn\b/i);
    expect(text).toMatch(/-At\s+\(Get-Date\)/i);
    expect(text).toMatch(/-RepetitionInterval\s+\(New-TimeSpan\s+-Minutes\s+1\)/i);
  });

  it('the second trigger repeats with no end', () => {
    const name = registeredTriggers()[1];
    const { text } = definition(name);
    expect(text).not.toMatch(/-RepetitionDuration\b/i);
    expect(text).not.toMatch(/MaxValue/i);
    const own = body.filter((s) => s.toLowerCase().startsWith(`$${name?.toLowerCase()}.`));
    for (const s of own) {
      expect(s).not.toMatch(/\.EndBoundary\s*=/i);
      const duration = /\.Repetition\.Duration\s*=\s*(.+)$/i.exec(s)?.[1].trim();
      if (duration !== undefined) expect(duration).toMatch(/^(''|"")$/);
      expect(s).not.toMatch(/\.Repetition\s*=/i);
    }
  });
});
