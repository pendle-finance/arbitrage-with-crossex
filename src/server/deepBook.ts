import { fetchDeepBook, type NormalizedBook } from '../core/estimate/books';
import { parseSymbol } from '../core/numbers';
import type { AppDeps } from './app';
import { TTL } from './cache';

export const deepBookOf = (deps: Pick<AppDeps, 'cache'>, symbol: string): Promise<NormalizedBook | null> => {
  const { exchange, base, quote } = parseSymbol(symbol);
  return deps.cache.get(`book:deep:${symbol}`, TTL.live, () => fetchDeepBook(exchange, base, quote)).then(
    ({ value }) => value,
    () => null,
  );
};
