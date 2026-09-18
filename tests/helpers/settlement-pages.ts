import type { FetchLike } from '../../src/core/boros/client';

export type SettlementPage = { results: unknown[]; resumeToken: string | null };

export function pagedSettlementFetch(
  rest: FetchLike,
  pages: Record<string, () => Promise<SettlementPage>>,
  served: string[],
): FetchLike {
  return async (url, init) => {
    const u = new URL(url);
    if (!u.pathname.endsWith('/settlement-events')) return rest(url, init);
    const token = u.searchParams.get('resumeToken') ?? 'head';
    const page = pages[token];
    if (!page) throw new Error(`no settlement page ${token}`);
    const body = await page();
    served.push(token);
    return { ok: true, status: 200, json: async () => body };
  };
}
