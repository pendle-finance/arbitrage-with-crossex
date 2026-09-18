import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeOwnerOnlyJson } from '../secretFile';

export interface TelegramKey {
  key: string;
  keyHash: string;
  createdAt: number;
}

const KEY_FILE = 'telegram-key';

const keyPath = (dataDir: string): string => path.join(dataDir, KEY_FILE);

const hashKey = (key: string): string => createHash('sha256').update(key, 'utf8').digest('hex');

export function newTelegramKey(now: number): TelegramKey {
  const key = randomBytes(32).toString('base64url');
  return { key, keyHash: hashKey(key), createdAt: now };
}

function parseKey(raw: unknown): TelegramKey | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { key, keyHash, createdAt } = raw as Record<string, unknown>;
  if (typeof key !== 'string' || key === '' || typeof createdAt !== 'number') return null;
  if (keyHash !== hashKey(key)) return null;
  return { key, keyHash, createdAt };
}

export function readTelegramKey(dataDir: string): TelegramKey | null {
  try {
    return parseKey(JSON.parse(fs.readFileSync(keyPath(dataDir), 'utf8')));
  } catch {
    return null;
  }
}

export function writeTelegramKey(dataDir: string, key: TelegramKey): void {
  writeOwnerOnlyJson(keyPath(dataDir), key);
}

export function deleteTelegramKey(dataDir: string): void {
  fs.rmSync(keyPath(dataDir), { force: true });
}
