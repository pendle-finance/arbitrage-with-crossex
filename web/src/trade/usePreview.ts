import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { postJson } from '../api/client';
import { canFetch } from '../api/queries';
import type { ActionInput, PreviewResponse } from '../api/types';
import { useTabActive } from '../components/TabBar';
import { useDebounced } from '../lib/useDebounced';

/**
 * Debounced live preview: POST /api/preview once the actions have been stable
 * for `debounceMs`, then keep them fresh on `refetchInterval` while unchanged.
 * `previews` is undefined the moment `actions` goes null/invalid — stale
 * estimates for a different action are never shown.
 *
 * `estimating` is true whenever the returned previews may not describe the
 * CURRENT input: during the debounce window (`debounced !== json`) or while
 * `keepPreviousData` is serving the prior key's result (`isPlaceholderData`).
 * Consumers must NOT act on (enable execution off of) previews while estimating —
 * they belong to a stale input. The debounced result is still returned for
 * display so the panel doesn't blank between keystrokes.
 */
export function usePreviewDebounced(
  scope: string,
  actions: ActionInput[] | null,
  opts: { debounceMs?: number; refetchInterval?: number | false } = {},
) {
  const active = useTabActive();
  const json = actions && actions.length > 0 ? JSON.stringify(actions) : '';
  const debounced = useDebounced(json, opts.debounceMs ?? 400);

  const query = useQuery({
    queryKey: ['preview', scope, debounced],
    queryFn: () => postJson<PreviewResponse>('/preview', { actions: JSON.parse(debounced) as ActionInput[] }),
    enabled: (q) => debounced !== '' && canFetch(active, q),
    refetchInterval: active ? (opts.refetchInterval ?? false) : false,
    refetchIntervalInBackground: true,
    placeholderData: keepPreviousData,
    staleTime: 0,
    gcTime: 15_000,
  });

  // A pending edit (json not yet debounced) or placeholder data from the prior
  // key means the shown previews describe a DIFFERENT input than the current one.
  const estimating = json !== '' && (debounced !== json || query.isPlaceholderData);

  return {
    ...query,
    previews: json !== '' && debounced !== '' ? query.data?.previews : undefined,
    estimating,
  };
}
