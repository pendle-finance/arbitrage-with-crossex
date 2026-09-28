import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useRef } from 'react';
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
  opts: {
    debounceMs?: number;
    refetchInterval?: number | false;
    /**
     * Says the shown preview still describes `current` although the input
     * changed — the one case is a maker price auto-tracking the book, within a
     * tolerance (see trackedPriceDrift.ts). When it returns true the change
     * does NOT count as estimating; the new preview still loads behind it.
     */
    tolerate?: (shown: ActionInput[], current: ActionInput[]) => boolean;
  } = {},
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

  /** The input the SHOWN previews were computed for, and when they landed —
   * placeholder data belongs to an earlier key, so it keeps that key's stamp. */
  const shown = useRef<{ json: string; at: number } | null>(null);
  if (query.data && !query.isPlaceholderData && query.dataUpdatedAt > 0) {
    shown.current = { json: debounced, at: query.dataUpdatedAt };
  }

  // A pending edit (json not yet debounced) or placeholder data from the prior
  // key means the shown previews describe a DIFFERENT input than the current one.
  const changed = json !== '' && (debounced !== json || query.isPlaceholderData);
  const tolerated =
    changed &&
    opts.tolerate !== undefined &&
    shown.current !== null &&
    shown.current.json !== '' &&
    opts.tolerate(JSON.parse(shown.current.json) as ActionInput[], JSON.parse(json) as ActionInput[]);
  const estimating = changed && !tolerated;

  return {
    ...query,
    previews: json !== '' && debounced !== '' ? query.data?.previews : undefined,
    estimating,
    /** When the shown previews were fetched (0 = none yet). */
    shownAt: shown.current?.at ?? 0,
  };
}
