import * as fs from 'node:fs';
import * as path from 'node:path';
import { CoreError } from '../core/errors';
import { writeOwnerOnlyJson } from './secretFile';

export type ExclusionEntry = number | { qty: number; at?: number } | 'all';

export interface AssetPrefs {
  sinceByAsset: Record<string, number>;
  exclusions: Record<string, ExclusionEntry>;
  legSince: Record<string, number>;
}

const SECTIONS = ['sinceByAsset', 'exclusions', 'legSince'] as const;

type Section = (typeof SECTIONS)[number];

type StoredBook = AssetPrefs & { restored?: Partial<Record<Section, string[]>> };

type AllBooks = Record<string, StoredBook>;

export const BOOK_KEY_PATTERN = /^(0x[0-9a-f]{40}|none)\|.{1,40}$/;

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

const emptyPrefs = (): AssetPrefs => ({ sinceByAsset: {}, exclusions: {}, legSince: {} });

function cleanSince(q: unknown): number | null {
  const n = Number(q);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function cleanLegSince(key: string, q: unknown): number | null {
  const n = Number(q);
  return key.startsWith('boros:') && Number.isFinite(n) && n > 0 ? n : null;
}

const isQty = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

function cleanExclusion(key: string, q: unknown): ExclusionEntry | null {
  if (!key.startsWith('boros:')) return null;
  if (q === 'all') return 'all';
  if (isObject(q)) {
    if (!isQty(q.qty)) return null;
    return typeof q.at === 'number' && Number.isFinite(q.at) ? { qty: q.qty, at: q.at } : { qty: q.qty };
  }
  return isQty(q) ? q : null;
}

function cleanEntry(section: Section, key: string, q: unknown): [string, unknown] | null {
  if (section === 'sinceByAsset') {
    const n = cleanSince(q);
    return n === null ? null : [key.toUpperCase(), n];
  }
  const cleaned = section === 'exclusions' ? cleanExclusion(key, q) : cleanLegSince(key, q);
  return cleaned === null ? null : [key, cleaned];
}

function validatePrefs(raw: unknown): AssetPrefs {
  const out = emptyPrefs();
  if (!isObject(raw)) return out;
  for (const section of SECTIONS) {
    const body = raw[section];
    if (!isObject(body)) continue;
    for (const [key, q] of Object.entries(body)) {
      const entry = cleanEntry(section, key, q);
      if (entry) (out[section] as Record<string, unknown>)[entry[0]] = entry[1];
    }
  }
  return out;
}

function validateRestored(raw: unknown): StoredBook['restored'] {
  if (!isObject(raw) || !isObject(raw.restored)) return undefined;
  const out: StoredBook['restored'] = {};
  for (const section of SECTIONS) {
    const keys = raw.restored[section];
    if (Array.isArray(keys)) out[section] = keys.filter((k): k is string => typeof k === 'string');
  }
  return out;
}

const publicPrefs = ({ sinceByAsset, exclusions, legSince }: StoredBook): AssetPrefs => ({
  sinceByAsset,
  exclusions,
  legSince,
});

export class AssetPrefsFile {
  private readonly file: string;
  private readonly marker: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'asset-prefs.json');
    this.marker = `${this.file}.unreadable`;
  }

  get wasUnreadable(): boolean {
    return fs.existsSync(this.marker) || (!fs.existsSync(this.file) && fs.existsSync(`${this.file}.bad`));
  }

  private keepBadCopy(): void {
    let target = `${this.file}.bad`;
    for (let n = 1; fs.existsSync(target); n++) target = `${this.file}.bad.${n}`;
    fs.renameSync(this.file, target);
    fs.writeFileSync(this.marker, '');
  }

  private readAll(): AllBooks {
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (!isObject(parsed)) {
      this.keepBadCopy();
      return {};
    }
    const books: AllBooks = {};
    for (const [book, prefs] of Object.entries(parsed)) books[book] = { ...validatePrefs(prefs), restored: validateRestored(prefs) };
    return books;
  }

  get(book: string): AssetPrefs {
    return publicPrefs(this.readAll()[book] ?? emptyPrefs());
  }

  patch(book: string, body: unknown): AssetPrefs {
    if (!isObject(body)) throw new CoreError('body must be an object');
    for (const section of SECTIONS) {
      if (body[section] !== undefined && !isObject(body[section])) {
        throw new CoreError(`${section} must be an object`);
      }
    }
    const books = this.readAll();
    const prefs: StoredBook = books[book] ?? emptyPrefs();
    for (const section of SECTIONS) {
      const changes = body[section];
      if (!isObject(changes)) continue;
      const target = prefs[section] as Record<string, unknown>;
      const restored = new Set(prefs.restored?.[section]);
      for (const [key, q] of Object.entries(changes)) {
        if (q === null) {
          const name = section === 'sinceByAsset' ? key.toUpperCase() : key;
          delete target[name];
          restored.add(name);
          continue;
        }
        const entry = cleanEntry(section, key, q);
        if (!entry) continue;
        target[entry[0]] = entry[1];
        restored.delete(entry[0]);
      }
      prefs.restored = { ...prefs.restored, [section]: [...restored] };
    }
    books[book] = prefs;
    writeOwnerOnlyJson(this.file, books);
    fs.rmSync(this.marker, { force: true });
    return publicPrefs(prefs);
  }

  importAll(raw: unknown): void {
    if (!isObject(raw)) return;
    const books = this.readAll();
    let changed = false;
    for (const [book, prefs] of Object.entries(raw)) {
      if (!BOOK_KEY_PATTERN.test(book) || !isObject(prefs)) continue;
      const mine = (books[book] ??= emptyPrefs());
      const incoming = validatePrefs(prefs);
      for (const section of SECTIONS) {
        const target = mine[section] as Record<string, unknown>;
        const restored = mine.restored?.[section] ?? [];
        for (const [key, value] of Object.entries(incoming[section])) {
          if (key in target || restored.includes(key)) continue;
          target[key] = value;
          changed = true;
        }
      }
    }
    if (changed) writeOwnerOnlyJson(this.file, books);
  }
}
