import { ApiError } from '../api/client';

export function apiErrorText(error: Error): string {
  const hint = error instanceof ApiError ? error.hint : undefined;
  if (!hint) return error.message;
  const period = error.message.endsWith('.') ? '' : '.';
  return `${error.message}${period} ${hint}`;
}
