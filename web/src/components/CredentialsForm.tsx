import { Check } from 'lucide-react';
import type { TFunction } from 'i18next';
import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../api/client';
import { usePutCredentials } from '../api/queries';
import { Spinner } from './Spinner';

/** Shared key/secret form (first-run setup guide + Settings drawer).
 * A 404/405/network failure on PUT (a backend without the credentials service)
 * renders as a friendly inline message rather than a raw error. */
function refusedText(err: unknown, t: TFunction): string | null {
  if (!(err instanceof ApiError) || err.category !== 'auth') return null;
  return t('app.credentials.refused', { reason: err.label ?? err.message.replace(/\.$/, '') });
}

export function CredentialsForm({
  submitLabel,
  onSaved,
}: {
  submitLabel?: string;
  onSaved?: () => void;
}) {
  const { t } = useTranslation();
  const keyId = useId();
  const secretId = useId();
  const [key, setKey] = useState('');
  const [secret, setSecret] = useState('');
  const [saved, setSaved] = useState(false);
  const put = usePutCredentials();

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!key.trim() || !secret.trim() || put.isPending) return;
    setSaved(false);
    put.mutate(
      { key: key.trim(), secret: secret.trim() },
      {
        onSuccess: () => {
          setSaved(true);
          setKey('');
          setSecret('');
          onSaved?.();
        },
      },
    );
  };

  const err = put.error;
  const serviceMissing =
    err instanceof ApiError &&
    (err.httpStatus === 404 || err.httpStatus === 405 || err.category === 'network');
  const refused = refusedText(err, t);

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <div>
        <label htmlFor={keyId} className="mb-1 block text-xs font-medium text-ink-300">
          {t('app.credentials.apiKey')}
        </label>
        <input
          id={keyId}
          type="password"
          autoComplete="off"
          className="input num"
          placeholder={t('app.credentials.keyPlaceholder')}
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
      </div>
      <div>
        <label htmlFor={secretId} className="mb-1 block text-xs font-medium text-ink-300">
          {t('app.credentials.apiSecret')}
        </label>
        <input
          id={secretId}
          type="password"
          autoComplete="off"
          className="input num"
          placeholder={t('app.credentials.secretPlaceholder')}
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
        />
      </div>

      {err != null &&
        (serviceMissing ? (
          <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            {t('app.credentials.serviceMissing')}
          </p>
        ) : refused ? (
          <p className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
            {refused}
          </p>
        ) : (
          <p className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
            {err instanceof ApiError ? err.message : String(err)}
            {err instanceof ApiError && err.hint ? <span className="block text-rose-400/80">{err.hint}</span> : null}
          </p>
        ))}

      {saved && !put.isPending && err == null && (
        <p className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
          {t('app.credentials.saved')} <Check size={12} aria-hidden className="inline" />
        </p>
      )}

      <button type="submit" className="btn btn-primary self-start" disabled={put.isPending || !key.trim() || !secret.trim()}>
        {put.isPending && <Spinner />}
        {put.isPending ? t('app.credentials.checking') : (submitLabel ?? t('app.credentials.save'))}
      </button>
    </form>
  );
}
