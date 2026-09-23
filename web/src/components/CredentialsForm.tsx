import { Check } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { ApiError } from '../api/client';
import { usePutCredentials } from '../api/queries';
import { Spinner } from './Spinner';

/** Shared key/secret form (first-run setup guide + Settings drawer).
 * A 404/405/network failure on PUT (a backend without the credentials service)
 * renders as a friendly inline message rather than a raw error. */
function refusedText(err: unknown): string | null {
  if (!(err instanceof ApiError) || err.category !== 'auth') return null;
  return `Gate refused this key: ${err.label ?? err.message.replace(/\.$/, '')}. Check you pasted the whole key.`;
}

export function CredentialsForm({
  submitLabel = 'Save credentials',
  onSaved,
}: {
  submitLabel?: string;
  onSaved?: () => void;
}) {
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
  const refused = refusedText(err);

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <div>
        <label htmlFor={keyId} className="mb-1 block text-xs font-medium text-ink-300">
          API key
        </label>
        <input
          id={keyId}
          type="password"
          autoComplete="off"
          className="input num"
          placeholder="Gate API key"
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
      </div>
      <div>
        <label htmlFor={secretId} className="mb-1 block text-xs font-medium text-ink-300">
          API secret
        </label>
        <input
          id={secretId}
          type="password"
          autoComplete="off"
          className="input num"
          placeholder="Gate API secret"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
        />
      </div>

      {err != null &&
        (serviceMissing ? (
          <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            credentials service not available yet
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
          Credentials saved <Check size={12} aria-hidden className="inline" />
        </p>
      )}

      <button type="submit" className="btn btn-primary self-start" disabled={put.isPending || !key.trim() || !secret.trim()}>
        {put.isPending && <Spinner />}
        {put.isPending ? 'Checking with Gate…' : submitLabel}
      </button>
    </form>
  );
}
