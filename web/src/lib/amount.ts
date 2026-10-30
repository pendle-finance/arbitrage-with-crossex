import { t } from '../i18n';

/**
 * Why a typed amount is not a usable number — or null when it is fine.
 *
 * Every amount field in the app is free text (paste has to work), and every one
 * of them used to fail SILENTLY: `Number("7,668.31")` is NaN, so the ticket
 * simply went dead with no message and no disabled-reason. Pasting a formatted
 * number out of a spreadsheet or an exchange UI is the single most likely way
 * to type an amount, so it has to say what is wrong.
 */
export function amountError(raw: string, opts?: { min?: number; max?: number }): string | null {
  const s = raw.trim();
  if (!s) return null; // an untouched field should not shout

  if (s.includes(',')) {
    // Deliberately NOT auto-stripped: "7,5" is seven-and-a-half to a large part
    // of the world, and guessing wrong here changes an order size. Show the
    // exact text to use instead and let the human confirm it.
    const stripped = s.replace(/,/g, '');
    const n = Number(stripped);
    return Number.isFinite(n) && n > 0
      ? t('app.amount.removeCommasType', { value: stripped })
      : t('app.amount.removeCommas');
  }

  const n = Number(s);
  if (!Number.isFinite(n)) return t('app.amount.notNumber');
  if (n <= 0) return t('app.amount.notPositive');
  if (opts?.min !== undefined && n < opts.min) return t('app.amount.min', { value: opts.min.toLocaleString('en-US') });
  if (opts?.max !== undefined && n > opts.max) return t('app.amount.max', { value: opts.max.toLocaleString('en-US') });
  return null;
}
