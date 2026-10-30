import { useTranslation } from 'react-i18next';
import { EmptyState } from './EmptyState';

/** Standard "couldn't load X" state for a failed query, with an optional Retry. */
export function QueryError({
  title,
  error,
  onRetry,
  className,
}: {
  title: string;
  error: unknown;
  onRetry?: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const el = (
    <EmptyState
      icon="⚠"
      title={title}
      hint={(error as Error)?.message}
      action={
        onRetry ? (
          <button type="button" className="btn-primary" onClick={onRetry}>
            {t('common.retry')}
          </button>
        ) : undefined
      }
    />
  );
  return className ? <div className={className}>{el}</div> : el;
}
