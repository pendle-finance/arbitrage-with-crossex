/**
 * Read-only client for the public Boros backend (https://api.boros.finance).
 * No auth, no secrets — everything is keyed by a public EVM address.
 *
 * Scaling conventions (verified against live responses, 2026-07):
 * - Raw sizes/balances/PnL are 18-decimal integer strings → divide by 1e18.
 *   The RESULT is denominated in the market's COLLATERAL token (tokenId), not
 *   USD: stable-margined books (tokenId 3) are ~USD; token-margined books
 *   (BTC/ETH/…) need × the collateral token's USD price (`assetMarkPrice` of a
 *   market on that same asset). Getting this wrong mis-scales by orders of
 *   magnitude — do all USD conversion through `resolveCollateralPricesUsd`.
 * - APR fields (fixedApr/markApr/floatingApr) are plain decimal fractions.
 * - Fee RATES in market config (settleFeeRate/takerFee) are 18-dec fractions.
 * - List endpoints wrap results as { results, total, skip } — never a bare array.
 */
import { CoreError } from '../errors';

const BOROS_BASE_URL = 'https://api.boros.finance';
/** The api-gateway surface (`/apis` → api-gateway → open-api's `open-api-v2/…`
 * mounts). New endpoints live here — the bare `/open-api` prefix is deprecated. */
const BOROS_GATEWAY_BASE_URL = 'https://api-boros.pendle.finance/apis';

/**
 * Gas the order pays for itself.
 *
 * Boros funds its relayer from an off-chain USD budget per root, separate from
 * trading collateral, and an account with plenty of margin can still be unable
 * to send an order. The venue's own app never makes a user think about that,
 * and the mechanism is not a background job: a `payTreasury` call placed in the
 * SAME submission is counted as a credit by the relayer's pre-check
 * (`deltaFee = gas - marketEntranceFee - payTreasuryFee`, gas-tracking.service),
 * so a bundle carrying its own top-up is accepted even when the budget is at
 * zero or in debt. We do the same, so a low balance is never a dead end.
 *
 * These mirror the backend's ops-fee defaults (`minOpsFeeInUSD` 0.2,
 * `opsFeeToTakeInUSD` 1). They are app-settings values retuned upstream against
 * live gas prices and we do not read them — ours fire slightly earlier on
 * purpose, so an order tops up before it reaches the venue's own floor rather
 * than racing it. If Boros ever raises its floor above this, the venue's
 * refusal is still reported honestly as a gas failure.
 *
 * Here, not in borosApi, so the gate that warns and the client that tops up
 * read one number instead of two that drift.
 */
export const AUTO_TOP_UP_BELOW_USD = 0.3;
export const AUTO_TOP_UP_USD = 1;

/** tokenId → collateral token symbol (mirrors boros-tools' TOKEN_IDS). */
export const BOROS_TOKEN_SYMBOLS: Record<number, string> = {
  1: 'BTC',
  2: 'ETH',
  3: 'USDT',
  4: 'BNB',
  5: 'HYPE',
};

export type FetchLike = (
  url: string,
  init?: {
    signal?: AbortSignal;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/** The fetch a Boros route should use: the injected test seam when present,
 * else the runtime's global fetch. */
export const resolveBorosFetch = (override?: FetchLike): FetchLike =>
  override ?? (globalThis.fetch as unknown as FetchLike);

/** All raw Boros values are 18-dec fixed-point strings; NaN-guards to 0. */
export const norm18 = (raw: string | number | undefined | null): number => {
  const n = Number(raw);
  return Number.isFinite(n) ? n / 1e18 : 0;
};

/** Normalized market: only the fields the strategy math consumes. */
export interface BorosMarket {
  marketId: number;
  /** Collateral token of the book (NOT the traded coin). */
  tokenId: number;
  /** Human name, e.g. "Hyperliquid ETH 31 Jul 2026". */
  name: string;
  /** Reference perp venue, e.g. "Hyperliquid" (metadata.platformName). */
  venue: string;
  /** Underlying coin, e.g. "ETH" (metadata.assetSymbol). */
  base: string;
  /** Unix seconds. */
  maturity: number;
  /** Settlement interval, seconds. */
  paymentPeriod: number;
  /** Settlement fee as APR fraction (extConfig.settleFeeRate / 1e18). */
  settleFeeApr: number;
  markApr: number;
  floatingApr: number;
  /** Mid of best bid/ask as an APR fraction — the OTC dashboard's ranking rate. */
  midApr: number;
  /** Open interest in COLLATERAL token units (× the collateral price for USD). */
  notionalOi: number;
  /** Taker fee as a rate fraction (config.takerFee / 1e18); charged rate × notional × years. */
  takerFeeRate: number;
  /**
   * The venue's own cap on how far a trade may move the rate, as an APR
   * fraction: `config.maxRateDeviationFactorBase1e4 / 1e4 × markApr`.
   *
   * The factor is a FRACTION OF THE MARK, not the deviation itself — 2500 on a
   * 6.57% market is 0.25 × 0.0657 = 1.64% APR, which is what the venue UI shows
   * as "max rate deviation". A close bound wider than this can never fill, so
   * half of it is the natural default slippage.
   */
  maxRateDeviationApr: number;
  /** Lifecycle state; "Normal" means live and tradable. */
  state: string;
  /** USD price of the market's UNDERLYING asset. */
  assetMarkPriceUsd: number;
  // Initial-margin inputs. The whitepaper formula, linear in notional, so a USD
  // notional yields IM in USD directly:
  //   IM = N × max(|apr|, floor) × max(DTM_days, tThresh_days) / 365 × kIM
  //   floor = 1.00005 ** (imTickThresh × imTickStep) − 1
  // All four default to 0 when absent, so callers can detect the degraded case.
  /** Margin coefficient (config.kIM / 1e18). Its reciprocal is the venue's
   * leverage preset — live kIM 0.476 ⇒ 2.1x, 0.909 ⇒ 1.1x. */
  kIM: number;
  /** imData.iTickThresh — with `imTickStep`, sets the APR floor the IM formula
   * charges when the entry rate is smaller. */
  imTickThresh: number;
  /** imData.tickStep — the MARGIN tick step (2 live), unrelated to the order
   * book's `BOROS_BOOK_TICK_SIZE`. */
  imTickStep: number;
  /** Floor on the time the IM formula charges, seconds: it uses
   * `max(timeToMaturity, tThreshSec)`. Lives on `config`, NOT on `imData`. */
  tThreshSec: number;
  /**
   * The market can ONLY be traded on isolated margin — it carries its own
   * collateral bucket and cannot draw on the cross pool. Drives §6B of the
   * two-leg panel (a per-market shortfall that must never be summed with
   * another bucket's).
   *
   * ⚠ UNVERIFIED WIRE FIELD. The live payload was not observed carrying this
   * flag when this was written, so it is read defensively from either of the
   * two plausible homes and defaults to FALSE. False is the safe default: it
   * routes the leg's margin check at the shared cross bucket, which is the
   * behaviour every market had before this feature. Confirm the real field
   * name against a live isolated-only market before relying on §6B. Optional
   * precisely because it is unconfirmed: absent and false must behave alike.
   */
  isolatedOnly?: boolean;
}

/** Boros books are quoted in whole APR ticks of this size (apr = tick × 0.0001). */
const BOROS_BOOK_TICK_SIZE = 0.0001;

/** Per-side level cap — deep tails are noise for VWAP walks at sane notionals. */
const MAX_BOOK_LEVELS = 500;

/** One side's levels are `[aprFraction, sizeCollateralUnits]`, best-first. */
export interface BorosOrderBook {
  marketId: number;
  bids: Array<[number, number]>;
  asks: Array<[number, number]>;
}

/** One position inside a margin group. Raw 18-dec strings kept as-is; the
 * returns layer scales them with the group's collateral price. */
export interface BorosMarketPosition {
  marketId: number;
  /** 0 = LONG (pays fixed, receives floating), 1 = SHORT. */
  side: number;
  /** SIGNED 18-dec string (short positions are negative). */
  notionalSize: string;
  fixedApr: number;
  markApr: number;
  pnl: {
    /** Cumulative funding settled for the CURRENT position — verified NET of
     * settlement fees (settlement = yieldReceived − yieldPaid − fee). */
    rateSettlementPnl: string;
    unrealisedPnl: string;
  };
  /** Required per the API (MarketPositionResponse) — this position's own share
   * of the margin group's initial margin. */
  positionInitialMargin: string;
  /** Also required per the API, but kept optional here: it is only ever read
   * as a fallback for the line above, and nothing breaks if a legacy response
   * omits it. */
  initialMargin?: string;
}

/** A margin group: the cross account or one isolated position bucket. */
export interface BorosMarginGroup {
  isCross: boolean;
  netBalance: string;
  initialMargin?: string;
  marketPositions: BorosMarketPosition[];
}

export interface BorosCollateralZone {
  tokenId: number;
  cross: BorosMarginGroup | null;
  isolated: BorosMarginGroup[];
}

/**
 * One fill from /pnl/transactions, projected to the fields this app reads —
 * `required` / `optional` below mirror PnlTransactionResponse in the API's own
 * OpenAPI document (https://api.boros.finance/core/docs).
 *
 * `txType` is deliberately NOT modelled: it is required upstream and
 * enumerated 'normal' | 'liquidate' | 'force_deleverage' | 'otc_swap', but
 * every one of those MOVES the position, so nothing here may filter on it —
 * the position chain (prevPositionS → postPositionS) is the whole truth, and
 * reading it keeps a liquidation or an ADL from silently vanishing from a
 * position's history.
 *
 * `pnl` is net of `fee` (opens: pnl = −fee).
 */
export interface BorosTxn {
  marketId: number;
  /** Unix seconds. Collides when one order fills across several book levels —
   * order by the position chain (prev/post), never by time alone. */
  time: number;
  /** 18-dec fee in collateral-token units. */
  fee: string;
  /** 18-dec realized trade PnL NET of fee, collateral-token units. */
  pnl: string;
  /** Position before/after — an open-from-flat has prevPositionS === '0'. */
  prevPositionS: string;
  postPositionS: string;
  /** THIS fill's traded fixed rate (decimal fraction, may be 0 or negative).
   * REQUIRED by the API (PnlTransactionResponse), so a non-finite value here
   * means the response was not the documented shape — callers bail rather
   * than average a NaN into a position's entry rate. A position's blended
   * rate is the notional-weighted average of these, which is what lets one
   * position be split back into the strategies that built it. */
  fixedApr: number;
  /** The average entry rate of the position being REDUCED. OPTIONAL per the
   * API, and in practice present only on reducing fills. Verified equal to the
   * replayed weighted average, so it doubles as a free correctness check. */
  entryApr?: number;
}

/**
 * Client-identification tag the Boros backend expects on every request from
 * this tool. Appended centrally here so no fetcher can forget it. The tag is
 * `pendle_client=boroscrossex<version><_active?>` — e.g. `boroscrossex1.3.0` or
 * `boroscrossex1.3.0_active` for a credentialed ("active") user.
 *
 * WHY mutable module state instead of a const: the version comes from a server
 * boot-time fs read of version.json, and `active` flips at runtime when a user
 * hot-swaps in Gate credentials — neither is knowable at import. This core
 * module stays free of any fs/env reads (that would couple it to the server
 * layout); the server injects both via `setClientTagContext`. The defaults
 * reproduce today's plain `boroscrossex` tag, so any caller that never sets the
 * context (e.g. unit tests) is unaffected.
 */
const clientTagState = { version: '', active: false };

/**
 * Merge a partial update into the client-tag context. A null `version` clears
 * it (falls back to the versionless tag). The version is sanitized defensively
 * because it is concatenated into a URL unencoded: trimmed, and accepted only
 * if it matches the safe set below — otherwise it is treated as absent.
 */
export function setClientTagContext(ctx: { version?: string | null; active?: boolean }): void {
  if (ctx.version !== undefined) {
    const trimmed = ctx.version === null ? '' : ctx.version.trim();
    clientTagState.version = /^[0-9A-Za-z._-]+$/.test(trimmed) ? trimmed : '';
  }
  if (ctx.active !== undefined) {
    clientTagState.active = ctx.active;
  }
}

async function getJson(fetchImpl: FetchLike, path: string): Promise<unknown> {
  const clientTag =
    'pendle_client=boroscrossex' + clientTagState.version + (clientTagState.active ? '_active' : '');
  const url = `${BOROS_BASE_URL}${path}${path.includes('?') ? '&' : '?'}${clientTag}`;
  let resp: Awaited<ReturnType<FetchLike>>;
  try {
    resp = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new CoreError(
      `Boros API unreachable (${path}): ${(err as Error)?.message ?? String(err)}`,
      'network',
    );
  }
  if (!resp.ok) {
    // 429 keeps its rate-limited category so TtlCache's cooldown/stale-serving
    // engages instead of surfacing a misleading 502.
    throw new CoreError(
      `Boros API ${path} returned HTTP ${resp.status}`,
      resp.status === 429 ? 'rate-limited' : 'network',
    );
  }
  try {
    return await resp.json();
  } catch {
    throw new CoreError(`Boros API ${path} returned a non-JSON body`, 'network');
  }
}

/** GET /core/v1/markets → normalized markets (list is small, one page). */
export async function fetchBorosMarkets(fetchImpl: FetchLike): Promise<BorosMarket[]> {
  const body = (await getJson(fetchImpl, '/core/v1/markets')) as {
    results?: Array<Record<string, unknown>>;
  };
  if (!Array.isArray(body?.results)) {
    throw new CoreError('Boros /markets: unexpected response shape (no results[])', 'network');
  }
  return body.results.map((m) => {
    const imData = (m.imData ?? {}) as Record<string, unknown>;
    const extConfig = (m.extConfig ?? {}) as Record<string, unknown>;
    const metadata = (m.metadata ?? {}) as Record<string, unknown>;
    const data = (m.data ?? {}) as Record<string, unknown>;
    const config = (m.config ?? {}) as Record<string, unknown>;
    return {
      marketId: Number(m.marketId),
      tokenId: Number(m.tokenId),
      name: String(imData.name ?? ''),
      venue: String(metadata.platformName ?? ''),
      base: String(metadata.assetSymbol ?? ''),
      maturity: Number(imData.maturity ?? 0),
      paymentPeriod: Number(extConfig.paymentPeriod ?? 0),
      settleFeeApr: norm18(extConfig.settleFeeRate as string),
      markApr: Number(data.markApr ?? 0),
      floatingApr: Number(data.floatingApr ?? 0),
      midApr: Number(data.midApr ?? 0),
      notionalOi: Number(data.notionalOI ?? 0),
      takerFeeRate: norm18(config.takerFee as string),
      maxRateDeviationApr:
        (Number(config.maxRateDeviationFactorBase1e4 ?? 0) / 1e4) * Number(data.markApr ?? 0),
      state: String(m.state ?? ''),
      assetMarkPriceUsd: Number(data.assetMarkPrice ?? 0),
      kIM: norm18(config.kIM as string),
      imTickThresh: Number(imData.iTickThresh ?? 0),
      imTickStep: Number(imData.tickStep ?? 0),
      tThreshSec: Number(config.tThresh ?? 0),
      isolatedOnly: Boolean(config.isolatedOnly ?? imData.isolatedOnly ?? false),
    };
  });
}

/**
 * GET /core/v1/order-books/{marketId} → normalized book, best-first.
 *
 * ⚠ SIGN CONVENTION — the wire side names are the COUNTERPARTY's side, so they
 * read backwards. The wire `short` side is the ASK side: you LIFT those to go
 * LONG fixed (pay fixed). The wire `long` side is the BID side: you HIT those to
 * go SHORT fixed (receive fixed). Hence `short → asks`, `long → bids`, and asks
 * price ABOVE bids (verified live: market 155 best long 0.0922 < best short
 * 0.0923). Inverting this silently flips every rate the strategy math locks in.
 *
 * Levels are `[apr, size]`: apr = tick × BOROS_BOOK_TICK_SIZE, size in
 * COLLATERAL token units. Wire order is not guaranteed, so both sides are sorted.
 */
export async function fetchBorosOrderBook(
  fetchImpl: FetchLike,
  marketId: number,
): Promise<BorosOrderBook> {
  const path = `/core/v1/order-books/${marketId}?tickSize=${BOROS_BOOK_TICK_SIZE}`;
  const body = (await getJson(fetchImpl, path)) as {
    short?: { ia?: unknown; sz?: unknown };
    long?: { ia?: unknown; sz?: unknown };
  };

  const toLevels = (side: { ia?: unknown; sz?: unknown } | undefined, name: string) => {
    const ia = side?.ia;
    const sz = side?.sz;
    if (!Array.isArray(ia) || !Array.isArray(sz) || ia.length !== sz.length) {
      throw new CoreError(
        `Boros /order-books/${marketId}: unexpected ${name} side shape (ia/sz missing or mismatched)`,
        'network',
      );
    }
    const levels: Array<[number, number]> = [];
    for (let k = 0; k < ia.length; k += 1) {
      const apr = Number(ia[k]) * BOROS_BOOK_TICK_SIZE;
      const size = norm18(sz[k] as string);
      if (!Number.isFinite(apr) || !Number.isFinite(size) || size <= 0) continue;
      levels.push([apr, size]);
    }
    return levels;
  };

  if (!body?.short || !body?.long) {
    throw new CoreError(
      `Boros /order-books/${marketId}: unexpected response shape (no short/long sides)`,
      'network',
    );
  }
  const asks = toLevels(body.short, 'short');
  const bids = toLevels(body.long, 'long');
  return {
    marketId,
    asks: asks.sort((a, b) => a[0] - b[0]).slice(0, MAX_BOOK_LEVELS),
    bids: bids.sort((a, b) => b[0] - a[0]).slice(0, MAX_BOOK_LEVELS),
  };
}

/** GET /core/v1/collaterals/summary — margin groups + positions per zone. */
export async function fetchBorosCollaterals(
  fetchImpl: FetchLike,
  address: string,
  accountId = 0,
): Promise<BorosCollateralZone[]> {
  const body = (await getJson(
    fetchImpl,
    `/core/v1/collaterals/summary?userAddress=${address}&accountId=${accountId}`,
  )) as { collaterals?: Array<Record<string, unknown>> };
  if (!Array.isArray(body?.collaterals)) {
    throw new CoreError(
      'Boros /collaterals/summary: unexpected response shape (no collaterals[])',
      'network',
    );
  }

  const toPosition = (p: Record<string, unknown>): BorosMarketPosition => {
    const pnl = (p.pnl ?? {}) as Record<string, unknown>;
    return {
      marketId: Number(p.marketId),
      side: Number(p.side),
      notionalSize: String(p.notionalSize ?? '0'),
      fixedApr: Number(p.fixedApr ?? 0),
      markApr: Number(p.markApr ?? 0),
      pnl: {
        rateSettlementPnl: String(pnl.rateSettlementPnl ?? '0'),
        unrealisedPnl: String(pnl.unrealisedPnl ?? '0'),
      },
      positionInitialMargin: String(p.positionInitialMargin ?? p.initialMargin ?? '0'),
      initialMargin: p.initialMargin as string | undefined,
    };
  };
  const toGroup = (g: Record<string, unknown>, isCross: boolean): BorosMarginGroup => ({
    isCross,
    netBalance: String(g.netBalance ?? '0'),
    initialMargin: g.initialMargin as string | undefined,
    marketPositions: Array.isArray(g.marketPositions)
      ? (g.marketPositions as Array<Record<string, unknown>>).map(toPosition)
      : [],
  });

  return body.collaterals.map((zone) => {
    const cross = zone.crossPosition as Record<string, unknown> | undefined;
    const isolated = Array.isArray(zone.isolatedPositions)
      ? (zone.isolatedPositions as Array<Record<string, unknown>>)
      : [];
    return {
      tokenId: Number(zone.tokenId),
      cross: cross ? toGroup(cross, true) : null,
      isolated: isolated.map((g) => toGroup(g, false)),
    };
  });
}

/**
 * GET /core/v1/pnl/transactions for one collateral zone — paginates fully
 * (fees + open-time detection need the whole history; counts are small).
 *
 * ⚠ Returns its own COVERAGE, not a bare list. The page cap below is a
 * runaway guard, but an account that reaches it gets a silently truncated
 * history — and a truncated history is not merely less useful, it is
 * misleading in one specific way: any reasoning of the form "this fill has no
 * counterpart nearby, so it was placed alone" is an argument from ABSENCE, and
 * absence is exactly what truncation fakes. Callers must be able to see the
 * difference, so `complete` is impossible to receive without noticing.
 * (The Gate fill fetch already reports its own cap this way.)
 */
export async function fetchBorosTransactions(
  fetchImpl: FetchLike,
  address: string,
  tokenId: number,
  accountId = 0,
): Promise<{ txns: BorosTxn[]; complete: boolean }> {
  const limit = 200;
  const all: BorosTxn[] = [];
  // Hard page cap: 25 pages = 5k fills. Beyond that something is wrong (or the
  // account is far outside this feature's scope) — stop rather than hammer.
  const maxPages = 25;
  let complete = false;
  for (let skip = 0, page = 0; page < maxPages; skip += limit, page += 1) {
    const body = (await getJson(
      fetchImpl,
      `/core/v1/pnl/transactions?userAddress=${address}&accountId=${accountId}&tokenId=${tokenId}&skip=${skip}&limit=${limit}`,
    )) as { results?: Array<Record<string, unknown>>; total?: number };
    if (!Array.isArray(body?.results)) {
      // Same guard as the other fetchers — a shape change must throw, not get
      // cached as "no trade history" (which would silently zero the fees).
      throw new CoreError('Boros /pnl/transactions: unexpected response shape (no results[])', 'network');
    }
    const results = body.results;
    for (const t of results) {
      // Number(null) is 0, not NaN — so a null rate would read as a real 0%
      // OTC price. Absent must stay absent.
      const asRate = (v: unknown): number =>
        v === null || v === undefined || v === '' ? Number.NaN : Number(v);
      const entryApr = asRate(t.entryApr);
      all.push({
        marketId: Number(t.marketId),
        time: Number(t.time ?? 0),
        fee: String(t.fee ?? '0'),
        pnl: String(t.pnl ?? '0'),
        prevPositionS: String(t.prevPositionS ?? '0'),
        postPositionS: String(t.postPositionS ?? '0'),
        // No `?? 0` on the rate: a rate of exactly 0 is a real OTC price, so a
        // missing one must stay distinguishable (NaN), not become a free trade.
        fixedApr: asRate(t.fixedApr),
        // Optional per the API — omitted rather than NaN so "no cross-check
        // available" and "cross-check says 0%" stay different things.
        ...(Number.isFinite(entryApr) ? { entryApr } : {}),
      });
    }
    const total = Number(body?.total ?? 0);
    // Only a run that reaches the end of the venue's own count is complete.
    // Falling out of the loop on the page cap is not — that is the case this
    // flag exists to name.
    if (skip + limit >= total || results.length === 0) {
      complete = true;
      break;
    }
  }
  return { txns: all, complete };
}

/**
 * USD price per collateral tokenId. Stables are 1; a token-margined zone is
 * priced via any live market on that same asset (its `assetMarkPrice`).
 * Unpriceable tokens map to null — callers must exclude those zones and warn,
 * never silently treat token units as dollars.
 */
export function resolveCollateralPricesUsd(markets: BorosMarket[]): Map<number, number | null> {
  const prices = new Map<number, number | null>();
  const tokenIds = new Set(markets.map((m) => m.tokenId));
  for (const tokenId of tokenIds) {
    const symbol = BOROS_TOKEN_SYMBOLS[tokenId];
    if (symbol === 'USDT') {
      prices.set(tokenId, 1);
      continue;
    }
    const ref = markets.find((m) => m.base === symbol && m.assetMarkPriceUsd > 0);
    prices.set(tokenId, ref ? ref.assetMarkPriceUsd : null);
  }
  return prices;
}

/**
 * POST {gateway}/v1/crossex/shared-positions — store a share payload on the public
 * backend and get its short code back. `d` is the base64url payload the long
 * link would carry after `?d=`; the backend keys it by content hash, so
 * re-sharing the same position returns the same code with a refreshed ~90-day
 * expiry. Throws CoreError('network') on any failure — the share modal treats
 * that as "no short link today" and falls back to the long URL.
 */
export async function createShareShortLink(
  fetchImpl: FetchLike,
  d: string,
  /** The sharer's tracked address, lowercased — sent RAW alongside `d`, never
   * folded into it, and never part of the resulting public link. */
  address?: string,
): Promise<{ code: string; expiresAt: number }> {
  const clientTag =
    'pendle_client=boroscrossex' + clientTagState.version + (clientTagState.active ? '_active' : '');
  const url = `${BOROS_GATEWAY_BASE_URL}/v1/crossex/shared-positions?${clientTag}`;
  let resp: Awaited<ReturnType<FetchLike>>;
  try {
    resp = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(address ? { d, address } : { d }),
      // Snappier than the read timeout: the modal already shows the long link,
      // a short link that takes this long isn't worth upgrading to.
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new CoreError(
      `Boros API unreachable (shared-positions): ${(err as Error)?.message ?? String(err)}`,
      'network',
    );
  }
  if (!resp.ok) {
    throw new CoreError(
      `Boros API shared-positions returned HTTP ${resp.status}`,
      resp.status === 429 ? 'rate-limited' : 'network',
    );
  }
  let body: unknown;
  try {
    body = await resp.json();
  } catch {
    throw new CoreError('Boros API shared-positions returned a non-JSON body', 'network');
  }
  const code = (body as { code?: unknown })?.code;
  const expiresAt = (body as { expiresAt?: unknown })?.expiresAt;
  if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{4,32}$/.test(code)) {
    throw new CoreError('Boros API shared-positions returned no usable code', 'network');
  }
  return { code, expiresAt: typeof expiresAt === 'number' ? expiresAt : 0 };
}
