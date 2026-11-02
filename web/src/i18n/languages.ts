/**
 * The languages the terminal ships. To add one: copy `locales/en` to
 * `locales/<code>`, translate the values, import it in `i18n/index.ts`, and
 * add a row here. `locales.test.ts` then checks every key and placeholder.
 */
export const LANGUAGES = [
  { code: 'en', label: 'English', dateLocale: 'en-GB' },
  { code: 'zh-CN', label: '简体中文', dateLocale: 'zh-CN' },
] as const;

export type Language = (typeof LANGUAGES)[number]['code'];

export const DEFAULT_LANGUAGE: Language = 'en';

export const LANGUAGE_STORAGE_KEY = 'crossex.language.v1';

export function isLanguage(value: unknown): value is Language {
  return LANGUAGES.some((l) => l.code === value);
}
