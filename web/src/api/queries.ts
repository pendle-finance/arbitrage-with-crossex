/** react-query hooks for every monitoring endpoint. All list/table queries use
 * `placeholderData: keepPreviousData` so background refetches never blank tables. */
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { del, fetchJson, postJson, putJson } from './client';
import { uuid } from '../lib/uuid';
import type {
  BorosCancelAndCloseResult,
  DealAlert,
  DealView,
  BookTouch,
  BorosEntryMode,
  BorosAgentInput,
  BorosAgentStatus,
  BorosPairContext,
  BorosPairExecuteResponse,
  BorosPairRequest,
  BorosPairSimulateResponse,
  CapitalBasis,
  CredentialsInfo,
  CredentialsInput,
  DisclaimerStatus,
  CrossexAccount,
  EntryMode,
  ExitMode,
  LeverageInfo,
  OpenOrder,
  OpportunitiesResult,
  PositionsResponse,
  StrategyReturns,
  SymbolDetail,
  SymbolRule,
  TradesResponse,
  VenueFees,
  UpdateStatus,
  TopUpGasResponse,
  RunUpdateResponse,
} from './types';

export const qk = {
  credentials: ['credentials'] as const,
  disclaimer: ['disclaimer'] as const,
  version: ['version'] as const,
  account: ['account'] as const,
  positions: ['positions'] as const,
  openOrders: ['orders', 'open'] as const,
  trades: ['trades'] as const,
  fees: ['fees'] as const,
  symbols: (q: string) => ['symbols', q] as const,
  symbolsByBase: (base: string) => ['symbols', 'base', base] as const,
  symbolDetail: (symbol: string) => ['symbolDetail', symbol] as const,
  strategy: (address: string, since: number | null, partition = '', capital = 'balance') =>
    ['strategy', address, since ?? '', partition, capital] as const,
  borosAgent: ['boros', 'agent'] as const,
  borosPairContext: (address: string) => ['boros', 'pair', 'context', address] as const,
  opportunities: (
    notionalUsd: number,
    borosEntry: BorosEntryMode,
    entryMode: EntryMode,
    exitMode: ExitMode,
    feeTier: string | undefined,
  ) => ['opportunities', notionalUsd, borosEntry, entryMode, exitMode, feeTier ?? ''] as const,
  deal: (id: string) => ['deal', id] as const,
  activeDeals: ['deals', 'active'] as const,
  alerts: ['alerts'] as const,
};

export function useCredentials() {
  return useQuery({
    queryKey: qk.credentials,
    queryFn: () => fetchJson<CredentialsInfo>('/credentials'),
    staleTime: Infinity, // fetch once; invalidated explicitly after a PUT
    // When the query is in an error state (no data), a NEW observer mounting
    // retries it by default (`retryOnMount`), and each retry flips `isPending`
    // back to true — App would bounce between the skeleton and the first-run
    // view for as long as the error persists. Recovery is explicit (PUT
    // invalidation / manual refetch), matching the "fetch once" contract.
    retryOnMount: false,
  });
}

export function useAccount() {
  return useQuery({
    queryKey: qk.account,
    queryFn: () => fetchJson<CrossexAccount>('/account'),
    refetchInterval: 5_000,
    placeholderData: keepPreviousData,
  });
}

export function usePositions() {
  return useQuery({
    queryKey: qk.positions,
    queryFn: () => fetchJson<PositionsResponse>('/positions'),
    refetchInterval: 4_000,
    placeholderData: keepPreviousData,
  });
}

export function useOpenOrders(symbol?: string) {
  const search = symbol ? `?symbol=${encodeURIComponent(symbol)}` : '';
  return useQuery({
    queryKey: [...qk.openOrders, symbol ?? ''] as const,
    queryFn: () => fetchJson<OpenOrder[]>(`/orders/open${search}`),
    refetchInterval: 4_000,
    placeholderData: keepPreviousData,
  });
}

export function useTrades(limit = 100) {
  return useInfiniteQuery({
    queryKey: [...qk.trades, limit] as const,
    queryFn: ({ pageParam }) =>
      fetchJson<TradesResponse>(`/trades?limit=${limit}&page=${pageParam}&join=1`),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.hasMore ? last.page + 1 : undefined),
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });
}

/** 4-leg strategy returns for the tracked EVM address (Boros legs + perp overlay).
 * Settlements are hourly at the fastest — 30s keeps the card feeling live.
 * Deliberately NO keepPreviousData: after a Change to a different address the
 * old address's financial data must never render attributed to the new one
 * (same-key background polls keep data without it). */
export function useStrategy(
  address: string | null,
  since: number | null = null,
  /** base64url pins from partitionStore — the user's edits to the split. */
  partition = '',
  /** 'im' counts only the margin the Boros legs post as capital. */
  capital: CapitalBasis = 'balance',
) {
  const params = new URLSearchParams();
  if (since) params.set('since', String(since));
  if (partition) params.set('partition', partition);
  if (capital !== 'balance') params.set('capital', capital);
  // NOT params.size: it is Baseline-2023 (Safari 17), and where it is
  // undefined the ternary would drop the whole query string — silently
  // disabling the clock override and every pin.
  const query = params.toString();
  const search = query ? `?${query}` : '';
  return useQuery({
    queryKey: qk.strategy(address ?? '', since, partition, capital),
    queryFn: () => fetchJson<StrategyReturns>(`/strategy/${encodeURIComponent(address ?? '')}${search}`),
    enabled: Boolean(address),
    refetchInterval: 30_000,
  });
}

export interface OpportunitiesParams {
  notionalUsd: number;
  borosEntry: BorosEntryMode;
  entryMode: EntryMode;
  exitMode: ExitMode;
  /** Simulate a Gate CrossEx VIP fee tier (e.g. 'vip0') instead of the
   * account's live schedule — the unconfigured view always sends one. */
  feeTier?: string;
}

/** Route bounds (src/server/routes/opportunities.ts): anything outside them is
 * a 400, so the hook must not send it. */
export const OPPORTUNITY_NOTIONAL_MIN = 1_000;
export const OPPORTUNITY_NOTIONAL_MAX = 100_000_000;

/** Mirror of the server's simulated CrossEx fee tiers
 * (src/core/estimate/crossexFeeTiers.ts) — anything else is a 400. */
export const OPPORTUNITY_FEE_TIERS = Array.from(
  { length: 17 },
  (_, i) => `vip${i}` as const,
) as readonly `vip${number}`[];
export type OpportunityFeeTier = (typeof OPPORTUNITY_FEE_TIERS)[number];

export function isValidOpportunityNotional(notionalUsd: number): boolean {
  return (
    Number.isFinite(notionalUsd) &&
    notionalUsd >= OPPORTUNITY_NOTIONAL_MIN &&
    notionalUsd <= OPPORTUNITY_NOTIONAL_MAX
  );
}

/** Forward-looking fixed-return opportunities across the Boros arb groups.
 * The size and the three modes are all part of the key — every combination is
 * a different computation. `keepPreviousData` covers both the 12s poll and a
 * size/mode switch, so the cards never blank out mid-recompute (read
 * `isPlaceholderData` to dim them). */
export function useOpportunities(p: OpportunitiesParams) {
  const search =
    `?notionalUsd=${p.notionalUsd}&borosEntry=${p.borosEntry}` +
    `&entryMode=${p.entryMode}&exitMode=${p.exitMode}` +
    (p.feeTier ? `&feeTier=${p.feeTier}` : '');
  return useQuery({
    queryKey: qk.opportunities(p.notionalUsd, p.borosEntry, p.entryMode, p.exitMode, p.feeTier),
    queryFn: () => fetchJson<OpportunitiesResult>(`/opportunities${search}`),
    enabled: isValidOpportunityNotional(p.notionalUsd),
    refetchInterval: 12_000,
    placeholderData: keepPreviousData,
  });
}

export function useFees() {
  return useQuery({
    queryKey: qk.fees,
    queryFn: () => fetchJson<VenueFees[]>('/fees'),
    refetchInterval: 600_000,
    placeholderData: keepPreviousData,
  });
}

export function useCancelOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (orderId: string) => del<unknown>(`/orders/${encodeURIComponent(orderId)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.openOrders }),
  });
}

/** First-run disclaimer acceptance state (fetch once; the accept mutation updates
 * it in place). Not registered in public mode, where it resolves 404 → treated as
 * not-required by the gate (which only mounts in the terminal build). */
export function useDisclaimer() {
  return useQuery({
    queryKey: qk.disclaimer,
    queryFn: () => fetchJson<DisclaimerStatus>('/disclaimer'),
    staleTime: Infinity,
    retryOnMount: false,
  });
}

/** Server-side update check — the server caches the GitHub read for hours, so
 * the client mirrors that cadence. Never retries: silent on failure by design
 * (an errored query leaves data undefined, so the update pill simply doesn't
 * render). */
export function useVersion() {
  return useQuery({
    queryKey: qk.version,
    queryFn: () => fetchJson<UpdateStatus>('/version'),
    staleTime: 21_600_000,
    refetchInterval: 21_600_000,
    retry: false,
    retryOnMount: false,
  });
}

/**
 * Watches the installed commit while an update runs, so the page can reload
 * onto the new bundle.
 *
 * A separate key from `qk.version` on purpose: that one is cached for six
 * hours and would keep answering from the pre-update snapshot, which is the
 * whole reason the badge went on offering an update the machine already had.
 * Errors are expected here — the server is stopped for part of the swap — so
 * the interval keeps polling through them.
 *
 * ⚠ `refetchIntervalInBackground` IS LOAD-BEARING. An update takes about a
 * minute, and nobody watches a progress line for a minute — the tab is hidden
 * for most of it. React Query pauses a plain interval on a hidden tab, so
 * without this flag the watch fetches once and then stops, and the page never
 * learns that the swap happened. Measured on a real update: the watch made one
 * request, while `/api/deals` and `/api/alerts`, which set this flag, made 19
 * and 11.
 */
export function useInstallWatch(enabled: boolean) {
  return useQuery({
    queryKey: [...qk.version, 'watch'] as const,
    queryFn: () => fetchJson<UpdateStatus>('/version'),
    enabled,
    refetchInterval: 2_500,
    refetchIntervalInBackground: true,
    staleTime: 0,
    retry: false,
  });
}

export function useAcceptDisclaimer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (version: string) => postJson<DisclaimerStatus>('/disclaimer/accept', { version }),
    onSuccess: (data) => qc.setQueryData(qk.disclaimer, data),
  });
}

// ---------------------------------------------------------------------------
// Trading hooks
// ---------------------------------------------------------------------------

/** Symbols filtered to one base coin (pair-ticket venue rows). */
export function useSymbolsByBase(base: string | null) {
  return useQuery({
    queryKey: qk.symbolsByBase(base ?? ''),
    queryFn: () => fetchJson<SymbolRule[]>(`/symbols?base=${encodeURIComponent(base ?? '')}`),
    enabled: Boolean(base),
    staleTime: 300_000,
    placeholderData: keepPreviousData,
  });
}

/** One symbol's rule + leverageMax (ticket leverage cap, tick snapping). */
export function useSymbolDetail(symbol: string | null) {
  return useQuery({
    queryKey: qk.symbolDetail(symbol ?? ''),
    queryFn: () => fetchJson<SymbolDetail>(`/symbols/${encodeURIComponent(symbol ?? '')}`),
    enabled: Boolean(symbol),
    staleTime: 300_000,
  });
}

/** Poll one deal every second while it works; stop at DONE (kept for review). */
export function useDealView(id: string | null) {
  const qc = useQueryClient();
  const settled = useRef<string | null>(null);
  const query = useQuery({
    queryKey: qk.deal(id ?? ''),
    queryFn: () => fetchJson<DealView>(`/deals/${encodeURIComponent(id ?? '')}`),
    enabled: Boolean(id),
    refetchInterval: (q) => (q.state.data?.pair.mode === 'DONE' ? false : 1_000),
    refetchIntervalInBackground: true,
  });

  /**
   * ⚠ A finished deal must refresh the POSITION feeds.
   *
   * The poll stops at DONE and nothing else asked the position or strategy
   * queries to re-read — so an order could fill, the modal could say it had,
   * and the cards behind it would still show the pre-trade book until their
   * own 4s/30s interval came round (or the user reloaded). The deal is the
   * only thing that knows when the fill actually landed.
   *
   * Guarded by id so this fires ONCE per deal, not on every poll after DONE.
   */
  const mode = query.data?.pair.mode;
  useEffect(() => {
    if (!id || mode !== 'DONE' || settled.current === id) return;
    settled.current = id;
    void qc.invalidateQueries({ queryKey: qk.positions });
    void qc.invalidateQueries({ queryKey: ['strategy'] });
    void qc.invalidateQueries({ queryKey: qk.account });
  }, [id, mode, qc]);

  return query;
}

/** Venue touch for the re-peg decision UI — polls only while enabled. */
export function useVenueBook(symbol: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['book', symbol ?? ''] as const,
    queryFn: () => fetchJson<BookTouch>(`/books/${encodeURIComponent(symbol ?? '')}`),
    enabled: enabled && Boolean(symbol),
    refetchInterval: 2_500,
    placeholderData: keepPreviousData,
  });
}

/** Deal commands: one-row intent edits the reconcile loop reads on its next tick. */
export function useDealCommand(command: 'convert' | 'repeg' | 'stop' | 'resume') {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body?: Record<string, unknown> }) =>
      postJson<{ id: string }>(`/deals/${encodeURIComponent(id)}/${command}`, body ?? {}),
    onSuccess: (_r, { id }) => void qc.invalidateQueries({ queryKey: qk.deal(id) }),
  });
}

/** Deals still working (the recovery banner + a tab-reload's way back in). */
export function useActiveDeals() {
  return useQuery({
    queryKey: qk.activeDeals,
    queryFn: () => fetchJson<DealView[]>('/deals?active=1'),
    refetchInterval: 5_000,
    refetchIntervalInBackground: true,
  });
}

/** Standing engine alerts (walls, quarantines, unresolved orders). */
export function useAlerts() {
  return useQuery({
    queryKey: qk.alerts,
    queryFn: () => fetchJson<DealAlert[]>('/alerts?unacked=1'),
    refetchInterval: 10_000,
    refetchIntervalInBackground: true,
  });
}

export function useAckAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => postJson<{ acked: boolean }>(`/alerts/${id}/ack`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.alerts }),
  });
}

/** PUT /api/leverage/:symbol; positions carry leverage, so bust them. */
export function useSetLeverage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ symbol, leverage }: { symbol: string; leverage: number }) =>
      putJson<LeverageInfo>(`/leverage/${encodeURIComponent(symbol)}`, { leverage }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.positions }),
  });
}

/** PUT /api/credentials — the backend route ships later; callers must handle
 * 404/network errors gracefully ("credentials service not available yet"). */
export function usePutCredentials() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CredentialsInput) => putJson<CredentialsInfo>('/credentials', body),
    onSuccess: () => qc.invalidateQueries(), // credentials changed — everything is suspect
  });
}

// ---------------------------------------------------------------------------
// Boros two-leg market entry
// ---------------------------------------------------------------------------

/** The pairable Boros universe plus this address's per-market state. Keyed by
 * address: two addresses must never share positions or margin buckets. */
export function useBorosPairContext(address: string | null) {
  return useQuery({
    queryKey: qk.borosPairContext(address ?? ''),
    queryFn: () => fetchJson<BorosPairContext>(`/boros/pair/context?address=${address}`),
    enabled: Boolean(address),
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
  });
}

/**
 * Live pair simulation. `refetchInterval` is deliberately well inside the
 * server's `SIMULATION_MAX_AGE_MS`: a quote that ages out blocks confirm, so
 * the panel must replace it before that happens rather than after.
 *
 * A POST behind useQuery rather than useMutation on purpose — this is a pure
 * read that happens to need a body, and it has to poll.
 */
export function useBorosPairSimulation(req: BorosPairRequest | null, enabled = true) {
  return useQuery({
    // The whole request is the key: any field change is a different quote.
    queryKey: ['boros', 'pair', 'simulate', JSON.stringify(req)] as const,
    queryFn: () => postJson<BorosPairSimulateResponse>('/boros/pair/simulate', req),
    enabled: Boolean(req) && enabled,
    placeholderData: keepPreviousData,
    refetchInterval: 4_000,
    // A stale quote must never back a confirm, so don't serve one from cache
    // across a remount.
    gcTime: 0,
  });
}

export function useExecuteBorosPair() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: BorosPairRequest) =>
      postJson<BorosPairExecuteResponse>('/boros/pair/execute', req),
    // ⚠ Same contract as the close below: the CARD reads the STRATEGY feed,
    // not the pair context. Without ['strategy'] a leg that had just been
    // opened did not appear until some other refetch happened to pull it in.
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['boros', 'pair', 'context'] });
      void qc.invalidateQueries({ queryKey: ['strategy'] });
      void qc.invalidateQueries({ queryKey: qk.positions });
    },
  });
}

export function useTopUpGas() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (amountUsd: number) =>
      postJson<TopUpGasResponse>('/boros/pair/top-up-gas', { amountUsd }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['boros', 'pair', 'simulate'] });
      void qc.invalidateQueries({ queryKey: qk.borosAgent });
    },
  });
}

export function useRunUpdate() {
  return useMutation({
    mutationFn: () => postJson<RunUpdateResponse>('/version/update', {}),
  });
}

/**
 * §6A remediation: cancel every resting order on a market, then close it.
 *
 * The account is NOT sent — the server derives it from the agent key it signs
 * with, because this route takes the close size from whatever position it
 * reads. The id is minted per attempt: this route has no replay memo, and a
 * retry after a failure is a genuinely new order.
 */
export function useBorosCancelAndClose() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      marketId,
      size,
      slippageApr,
    }: {
      marketId: number;
      /** Omitted = close whatever is open. The server clamps to it either way. */
      size?: number;
      /** APR fraction; omitted = the server's default bound. */
      slippageApr?: number;
    }) =>
      postJson<BorosCancelAndCloseResult>(`/boros/pair/market/${marketId}/cancel-and-close`, {
        clientOrderId: `cx-${uuid()}`.slice(0, 64),
        ...(size === undefined ? {} : { size }),
        ...(slippageApr === undefined ? {} : { slippageApr }),
      }),
    // ⚠ The CARD reads the strategy feed, not the pair context. Invalidating
    // only the context left a closed leg on screen at its old size until the
    // user reloaded — the close had happened, the page just never re-asked.
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['boros', 'pair', 'context'] });
      void qc.invalidateQueries({ queryKey: ['strategy'] });
      void qc.invalidateQueries({ queryKey: qk.positions });
    },
  });
}

/** The delegated Boros trading key's status. Cheap and read often — the ticket
 * gates its confirm on it. */
export function useBorosAgent() {
  return useQuery({
    queryKey: qk.borosAgent,
    queryFn: () => fetchJson<BorosAgentStatus>('/boros/agent'),
    staleTime: 10_000,
  });
}

export function useProvisionBorosAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: BorosAgentInput) => putJson<BorosAgentStatus>('/boros/agent', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.borosAgent }),
  });
}

/** Forgets the key on THIS machine. Does not revoke the on-chain approval —
 * the server's response says so and the UI repeats it. */
export function useForgetBorosAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => del<{ configured: boolean; note: string }>('/boros/agent'),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.borosAgent }),
  });
}
