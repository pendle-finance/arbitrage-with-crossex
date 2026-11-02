import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { LANGUAGES } from '../i18n/languages';

// Each language is a folder of JSON buckets. English is the source: every
// other language must carry the same keys and the same {{placeholders}}, or
// a trader sees an English line, or a number dropped from a sentence.
const localesDir = __dirname;
const srcDir = join(localesDir, '..');
type Messages = Record<string, unknown>;

const PLURAL = /_(zero|one|two|few|many|other)$/;

function readLanguage(code: string): Map<string, string> {
  const out = new Map<string, string>();
  const dir = join(localesDir, code);
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const walk = (m: Messages, prefix: string) => {
      for (const [k, v] of Object.entries(m)) {
        const path = `${prefix}.${k}`;
        if (v !== null && typeof v === 'object') walk(v as Messages, path);
        else out.set(path, String(v));
      }
    };
    walk(JSON.parse(readFileSync(join(dir, file), 'utf8')) as Messages, file.replace(/\.json$/, ''));
  }
  return out;
}

/** Plural forms differ by language (English one/other, Chinese other only), so keys compare by their base. */
const baseKeys = (m: Map<string, string>) => new Set([...m.keys()].map((k) => k.replace(PLURAL, '')));
const placeholders = (s: string) => [...s.matchAll(/\{\{\s*([\w.]+)[^}]*\}\}/g)].map((x) => x[1]).sort();
/** Every placeholder any plural form of a key uses (an English `_one` may drop {{count}}). */
const placeholdersOf = (m: Map<string, string>, base: string) =>
  [...new Set([...m].filter(([k]) => k.replace(PLURAL, '') === base).flatMap(([, v]) => placeholders(v)))].sort();
/** Trans tags like <b>…</b> or <1>…</1> map to components; a missing one drops the styling or the link. */
const tags = (s: string) => [...s.matchAll(/<\/?([\w]+)\s*\/?>/g)].map((x) => x[0]).sort();

const en = readLanguage('en');

describe('locale files', () => {
  it('every language has a folder with the same bucket files as English', () => {
    const files = (code: string) => readdirSync(join(localesDir, code)).filter((f) => f.endsWith('.json')).sort();
    for (const { code } of LANGUAGES) expect(files(code), code).toEqual(files('en'));
  });

  for (const { code } of LANGUAGES.filter((l) => l.code !== 'en')) {
    describe(code, () => {
      const other = readLanguage(code);

      it('has every English key and no extra one', () => {
        const missing = [...baseKeys(en)].filter((k) => !baseKeys(other).has(k));
        const extra = [...baseKeys(other)].filter((k) => !baseKeys(en).has(k));
        expect({ missing, extra }).toEqual({ missing: [], extra: [] });
      });

      it('keeps every placeholder and tag of the English line', () => {
        const wrong = [...baseKeys(en)]
          .filter((k) => baseKeys(other).has(k))
          .filter((k) => {
            const sameVars = placeholdersOf(other, k).join() === placeholdersOf(en, k).join();
            const enTags = [...en].filter(([x]) => x.replace(PLURAL, '') === k).map(([, v]) => tags(v).join())[0];
            const otherTags = [...other].filter(([x]) => x.replace(PLURAL, '') === k).map(([, v]) => tags(v).join())[0];
            return !sameVars || enTags !== otherTags;
          });
        expect(wrong).toEqual([]);
      });
    });
  }

  it('has no empty line in any language', () => {
    for (const { code } of LANGUAGES) {
      const empty = [...readLanguage(code)].filter(([, v]) => v.trim() === '').map(([k]) => k);
      expect(empty, code).toEqual([]);
    }
  });
});

// Copy typed straight into a screen never reaches a translator. This reads
// every component and fails on English text in JSX or in a text attribute.
// Strings built in plain code (template literals in helpers) are not scanned:
// those go through `t` by review.

/** Names and units that read the same in every language. */
const KEEP = new Set(
  (
    'Boros CrossEx Gate Hyperliquid Binance Lighter OKX Bybit Telegram GitHub Arbitrum Pendle Rabby MetaMask ' +
    'YU APR APY PnL ETH BTC USDT USDC USD HYPE SOL BNB XRP DOGE bp bps x k M B ID API'
  ).split(' '),
);
const TEXT_ATTRS = new Set(['title', 'placeholder', 'aria-label', 'alt', 'label']);
/** Files whose English is deliberate. */
const ENGLISH_ON_PURPOSE = new Set<string>([
  // The disclaimer is the legal text; a translation must not stand in for it.
  'components/DisclaimerGate.tsx',
  // Brand marks.
  'components/BrandMark.tsx',
  'components/BorosLogo.tsx',
  'components/GithubMark.tsx',
]);

function isEnglish(text: string): boolean {
  const words = text.match(/[A-Za-z][A-Za-z']*/g) ?? [];
  return words.some((w) => /[a-z]{2}/.test(w) && !KEEP.has(w));
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== 'test' && name !== 'locales') sourceFiles(full, out);
    } else if (name.endsWith('.tsx') && !/\.(test|cases)\.tsx$/.test(name)) out.push(full);
  }
  return out;
}

function englishIn(file: string): string[] {
  const src = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const line = (n: ts.Node) => src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1;
  const visit = (n: ts.Node) => {
    if (ts.isJsxText(n) && isEnglish(n.text)) found.push(`${line(n)}: ${n.text.trim()}`);
    if (ts.isJsxAttribute(n) && n.initializer && ts.isStringLiteral(n.initializer)) {
      const name = n.name.getText(src);
      if (TEXT_ATTRS.has(name) && isEnglish(n.initializer.text)) found.push(`${line(n)}: ${name}="${n.initializer.text}"`);
    }
    if (ts.isJsxExpression(n) && n.expression && ts.isStringLiteral(n.expression) && ts.isJsxElement(n.parent) && isEnglish(n.expression.text))
      found.push(`${line(n)}: {'${n.expression.text}'}`);
    ts.forEachChild(n, visit);
  };
  visit(src);
  return found;
}

describe('screens', () => {
  it('have no English text outside the locale files', () => {
    const offenders = Object.fromEntries(
      sourceFiles(srcDir)
        .map((f) => [relative(srcDir, f), f] as const)
        .filter(([rel]) => !ENGLISH_ON_PURPOSE.has(rel))
        .map(([rel, f]) => [rel, englishIn(f)] as const)
        .filter(([, hits]) => hits.length > 0),
    );
    expect(offenders).toEqual({});
  });
});
