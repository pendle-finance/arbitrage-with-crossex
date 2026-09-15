/**
 * First-run disclaimer acceptance — persisted alongside the .env in the config
 * dir. Trading routes refuse until the CURRENT disclaimer version is accepted;
 * bumping DISCLAIMER_VERSION (when the DISCLAIMER materially changes) re-prompts
 * the user. Acceptance is a local file only — nothing leaves the machine.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { restrictToOwner } from './secretFile';

/** Bump when docs/DISCLAIMER.md changes materially. A stored acceptance of an older
 * version is treated as not-accepted, so the user is re-prompted. */
export const DISCLAIMER_VERSION = '1';

function acceptancePath(envPath: string): string {
  return path.join(path.dirname(envPath), 'disclaimer.json');
}

/** The disclaimer version the user last accepted, or null if none/unreadable. */
export function acceptedVersion(envPath: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(acceptancePath(envPath), 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

export function isDisclaimerAccepted(envPath: string): boolean {
  return acceptedVersion(envPath) === DISCLAIMER_VERSION;
}

export const DISCLAIMER_NOT_ACCEPTED = {
  ok: false,
  error: {
    category: 'validation',
    label: 'DISCLAIMER_NOT_ACCEPTED',
    message: 'You must accept the disclaimer before placing any order.',
    retryable: false,
  },
} as const;

/** Record acceptance of the current version (atomic write, owner-only). */
export function recordAcceptance(envPath: string): void {
  const dir = path.dirname(envPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const body = JSON.stringify({ version: DISCLAIMER_VERSION, acceptedAt: new Date().toISOString() }, null, 2);
  const file = acceptancePath(envPath);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, file); // atomic on the same filesystem
  restrictToOwner(file); // Windows ignores the 0600 above
}
