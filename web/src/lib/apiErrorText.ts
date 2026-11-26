import { ApiError } from '../api/client';
import { joinSentences } from '../i18n/serverMessages';

export function apiErrorText(error: Error): string {
  const hint = error instanceof ApiError ? error.hint : undefined;
  return hint ? joinSentences(error.message, hint) : error.message;
}
