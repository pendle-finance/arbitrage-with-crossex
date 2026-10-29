import { Languages } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { setLanguage } from '../i18n';
import { LANGUAGES } from '../i18n/languages';
import { DropdownMenu } from './DropdownMenu';

/** Header language picker. The choice is saved in this browser only. */
export function LanguageSwitch() {
  const { t, i18n } = useTranslation();
  const current = LANGUAGES.find((l) => l.code === i18n.language) ?? LANGUAGES[0];
  return (
    <DropdownMenu
      label={t('app.language')}
      triggerClassName="hdr-ctl gap-1.5 font-medium"
      trigger={
        <>
          <Languages size={14} aria-hidden />
          {current.short}
        </>
      }
      items={LANGUAGES.map((l) => ({ label: l.label, onSelect: () => setLanguage(l.code) }))}
    />
  );
}
