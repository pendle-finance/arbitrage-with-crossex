import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from '../locales/en';
import zhCN from '../locales/zh-CN';
import { readJson, writeJson } from '../lib/storage';
import { DEFAULT_LANGUAGE, LANGUAGES, LANGUAGE_STORAGE_KEY, isLanguage, type Language } from './languages';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: { translation: typeof en };
  }
}

// Every language is bundled: the terminal is served from the trader's own
// machine, so a lazy chunk saves nothing and would flash English on load.
void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, 'zh-CN': { translation: zhCN } },
  lng: readJson<Language>(LANGUAGE_STORAGE_KEY, DEFAULT_LANGUAGE, (v) => (isLanguage(v) ? v : DEFAULT_LANGUAGE)),
  fallbackLng: DEFAULT_LANGUAGE,
  initAsync: false,
  // React escapes every string it renders.
  interpolation: { escapeValue: false },
  returnNull: false,
});

// Fonts and screen readers read the page language from <html lang>.
const markPage = (lng: string) => {
  if (typeof document !== 'undefined') document.documentElement.lang = lng;
};
markPage(i18n.language);
i18n.on('languageChanged', markPage);

export function currentLanguage(): Language {
  return isLanguage(i18n.language) ? i18n.language : DEFAULT_LANGUAGE;
}

export function setLanguage(lang: Language): void {
  writeJson(LANGUAGE_STORAGE_KEY, lang);
  void i18n.changeLanguage(lang);
}

/** The Intl locale for dates in the current language: "30 Oct" or "10月30日". */
export function dateLocale(): string {
  return LANGUAGES.find((l) => l.code === currentLanguage())?.dateLocale ?? 'en-GB';
}

/** For code outside React (copy builders, formatters). Components use `useTranslation`. */
export const t = i18n.t.bind(i18n);

export default i18n;
