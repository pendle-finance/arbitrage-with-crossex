import { useTranslation } from 'react-i18next';

export function Spinner({ className = 'h-3.5 w-3.5' }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <span
      role="status"
      aria-label={t('app.loadingLower')}
      className={`inline-block animate-spin rounded-full border-2 border-ink-500 border-t-ink-100 ${className}`}
    />
  );
}
