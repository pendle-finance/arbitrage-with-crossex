/**
 * Read-only client for the public Boros backend. Every read goes to the
 * open-api surface (https://api-boros.pendle.finance/apis/v1).
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
import { BOROS_NETWORK } from '../../../web/src/lib/borosNetwork';
import { prettyVenue } from '../../../web/src/lib/fmt';
import { CoreError } from '../errors';
import { BOOK_VENUES } from '../estimate/books';
import { borosInitialMarginUsd } from './opportunities';
import { normalizeVenue } from './venue';

/** The api-gateway surface (`/apis` → api-gateway → open-api's `open-api-v2/…`
 * mounts). New endpoints live here — the bare `/open-api` prefix is deprecated. */
const BOROS_GATEWAY_BASE_URL = BOROS_NETWORK.apiBase;

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
  /** Reference perp venue, e.g. "Hyperliquid" (platform.platformId, display-cased). */
  venue: string;
  /** Underlying coin, e.g. "ETH" (metadata.underlyingSymbol). */
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
  /** Maintenance-margin coefficient (config.kMM / 1e18), the same formula as
   * kIM. `kIM − kMM` is the rate move a position posting exactly its initial
   * margin survives before liquidation. 0 when absent. */
  kMM: number;
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
  fixedApr: number | null;
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
  hasRestingOrders?: boolean;
}

/** A margin group: the cross account or one isolated position bucket. */
export interface BorosMarginGroup {
  isCross: boolean;
  marketAcc: string;
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
 * The feed does not label a fill's KIND, and nothing here wants it to: a
 * liquidation, an ADL and an OTC swap all MOVE the position, so the position
 * chain (prevPositionS → postPositionS) is the whole truth, and reading it
 * keeps any of them from silently vanishing from a position's history.
 *
 * `pnl` is net of `fee` (opens: pnl = −fee).
 */
export interface BorosTxn {
  id: string;
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
  /** The average entry rate of the position being REDUCED — the feed's
   * `prevPositionF`, scaled. Emitted ONLY on a fill that reduces without
   * flipping. */
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

async function requestJson(
  fetchImpl: FetchLike,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<unknown> {
  const clientTag =
    'pendle_client=boroscrossex' + clientTagState.version + (clientTagState.active ? '_active' : '');
  const url = `${path}${path.includes('?') ? '&' : '?'}${clientTag}`;
  let resp: Awaited<ReturnType<FetchLike>>;
  try {
    resp = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(15_000) });
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

/** GET {gateway}/v1/markets → normalized markets.
 * ⚠ LIVE MARKETS ONLY: a matured market drops out of this listing. History
 * that references one resolves it through `fetchBorosMarket` instead. */
export async function fetchBorosMarkets(fetchImpl: FetchLike): Promise<BorosMarket[]> {
  const out: Array<Record<string, unknown>> = [];
  const seen = new Set<unknown>();
  let resumeToken: string | null = null;
  for (;;) {
    const cursor = resumeToken ? `&resumeToken=${encodeURIComponent(resumeToken)}` : '';
    const body = (await requestJson(
      fetchImpl,
      `${BOROS_GATEWAY_BASE_URL}/v1/markets?isMatured=false&limit=200${cursor}`,
    )) as { results?: Array<Record<string, unknown>>; resumeToken?: unknown };
    if (!Array.isArray(body?.results)) {
      throw new CoreError('Boros /markets: unexpected response shape (no results[])', 'network');
    }
    const added = body.results.filter((m) => !seen.has(m.marketId));
    for (const m of added) seen.add(m.marketId);
    out.push(...added);
    resumeToken = typeof body.resumeToken === 'string' && body.resumeToken ? body.resumeToken : null;
    if (resumeToken === null || added.length === 0) break;
  }
  const nowSec = Date.now() / 1000;
  return out.map((m) => normalizeBorosMarket(m, nowSec));
}

/**
 * GET {gateway}/v1/markets/by-ids — one market by id, INCLUDING matured ones
 * (probed live 2026-09-17: id 155, matured 31 Jul, still served here while
 * absent from the listing). This is how history rows on delisted markets get
 * their base/venue/token back. Metadata of a matured market is immutable, so
 * callers may cache it for as long as they like.
 */
export async function fetchBorosMarket(fetchImpl: FetchLike, marketId: number): Promise<BorosMarket> {
  const body = (await requestJson(
    fetchImpl,
    `${BOROS_GATEWAY_BASE_URL}/v1/markets/by-ids?marketIds=${marketId}`,
  )) as { results?: Array<Record<string, unknown>> };
  const found = Array.isArray(body?.results) ? body.results[0] : undefined;
  if (!found || !Number.isFinite(Number(found.marketId))) {
    throw new CoreError(`Boros /markets/by-ids ${marketId}: unexpected response shape`, 'network');
  }
  return normalizeBorosMarket(found, Date.now() / 1000);
}

const MARKET_STATUS: Record<number, string> = { 0: 'Paused', 1: 'CloseOnly', 2: 'Normal' };

function normalizeBorosMarket(m: Record<string, unknown>, nowSec: number): BorosMarket {
  const imData = (m.imData ?? {}) as Record<string, unknown>;
  const maturity = Number(imData.maturity ?? 0);
    const extConfig = (m.extConfig ?? {}) as Record<string, unknown>;
    const metadata = (m.metadata ?? {}) as Record<string, unknown>;
    const data = (m.data ?? {}) as Record<string, unknown>;
    const config = (m.config ?? {}) as Record<string, unknown>;
    const platform = (m.platform ?? {}) as Record<string, unknown>;
    const platformId = String(platform.platformId ?? '');
    const venueKey = normalizeVenue(platformId);
    return {
      marketId: Number(m.marketId),
      tokenId: Number(m.tokenId),
      name: String(imData.name ?? ''),
      venue: BOOK_VENUES.has(venueKey) ? prettyVenue(venueKey) : platformId,
      base: String(metadata.underlyingSymbol ?? ''),
      maturity,
      paymentPeriod: Number(extConfig.paymentPeriod ?? 0),
      settleFeeApr: norm18(extConfig.settleFeeRate as string),
      markApr: Number(data.markApr ?? 0),
      floatingApr: Number(data.floatingApr ?? 0),
      midApr: Number(data.midApr ?? 0),
      notionalOi: Number(data.notionalOI ?? 0),
      takerFeeRate: norm18(config.takerFee as string),
      maxRateDeviationApr:
        (Number(config.maxRateDeviationFactorBase1e4 ?? 0) / 1e4) * Number(data.markApr ?? 0),
      state:
        maturity > 0 && maturity <= nowSec ? 'Matured' : (MARKET_STATUS[Number(config.status)] ?? 'Unknown'),
      assetMarkPriceUsd: Number(data.assetMarkPrice ?? 0),
      kIM: norm18(config.kIM as string),
      kMM: norm18(config.kMM as string),
      imTickThresh: Number(imData.iTickThresh ?? 0),
      imTickStep: Number(imData.tickStep ?? 0),
      tThreshSec: Number(config.tThresh ?? 0),
      isolatedOnly: imData.isIsolatedOnly === true,
  };
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
  const path = `${BOROS_GATEWAY_BASE_URL}/v1/markets/order-book?marketId=${marketId}&tickSize=${BOROS_BOOK_TICK_SIZE}`;
  const body = (await requestJson(fetchImpl, path)) as {
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

/**
 * Split a `marketAcc` into its segments: root(20B)·accountId(1B)·tokenId(2B)·
 * marketId(3B), the marketId segment being 0xFFFFFF for a cross account. Null
 * when the handle is too short to be one.
 */
function decodeMarketAcc(
  marketAcc: string,
): { accountId: number; tokenId: number; marketId: number; isCross: boolean } | null {
  const acc = marketAcc.replace(/^0x/i, '');
  if (acc.length < 52) return null;
  const marketSeg = acc.slice(46, 52).toLowerCase();
  return {
    accountId: parseInt(acc.slice(40, 42), 16),
    tokenId: parseInt(acc.slice(42, 46), 16),
    marketId: parseInt(marketSeg, 16),
    isCross: marketSeg === 'ffffff',
  };
}

/**
 * Margin groups + positions per zone, joined from two account reads:
 *   - market-acc-infos-by-root → one row per marketAcc: netBalance, initial
 *     margin, and each market's position size, margin and resting orders;
 *   - active-positions → the rates and PnL the first read does not carry
 *     (fixedApr, side, unrealisedPnl, settlementPnl).
 * `markApr` comes from `markets`, and so does the formula that splits the
 * combined per-market margin back into the position's own (see
 * `positionOnlyInitialMargin`).
 */
export async function fetchBorosCollaterals(
  fetchImpl: FetchLike,
  address: string,
  markets: BorosMarket[],
  accountId = 0,
): Promise<BorosCollateralZone[]> {
  const marketById = new Map(markets.map((m) => [m.marketId, m]));
  const nowSec = Date.now() / 1000;
  const [infos, actives] = (await Promise.all([
    requestJson(
      fetchImpl,
      `${BOROS_GATEWAY_BASE_URL}/v1/accounts/market-acc-infos-by-root?root=${address}`,
    ),
    requestJson(
      fetchImpl,
      `${BOROS_GATEWAY_BASE_URL}/v1/accounts/active-positions?root=${address}&accountId=${accountId}`,
    ),
  ])) as Array<{ results?: Array<Record<string, unknown>> }>;
  if (!Array.isArray(infos?.results)) {
    throw new CoreError(
      'Boros /accounts/market-acc-infos-by-root: unexpected response shape (no results[])',
      'network',
    );
  }
  if (!Array.isArray(actives?.results)) {
    throw new CoreError(
      'Boros /accounts/active-positions: unexpected response shape (no results[])',
      'network',
    );
  }

  const live = new Map<string, Record<string, unknown>>();
  const byRootAccs = new Set(infos.results.map((r) => String(r.marketAcc ?? '').toLowerCase()));
  const droppedAccs = new Map<string, string>();
  for (const a of actives.results) {
    const marketAcc = String(a.marketAcc ?? '');
    live.set(`${marketAcc.toLowerCase()}:${Number(a.marketId)}`, a);
    if (decodeMarketAcc(marketAcc)?.accountId !== accountId || byRootAccs.has(marketAcc.toLowerCase())) continue;
    droppedAccs.set(marketAcc.toLowerCase(), marketAcc);
  }
  const accountRows = infos.results.concat(await fetchMarketAccInfos(fetchImpl, [...droppedAccs.values()]));

  const toPosition = (marketAcc: string, p: Record<string, unknown>): BorosMarketPosition => {
    const side = toBig(p.signedSize) < 0n ? 1 : 0;
    const a = live.get(`${marketAcc.toLowerCase()}:${Number(p.marketId)}`) ?? {};
    const rate = Number(a.side ?? side) === side ? a.fixedApr : undefined;
    return {
      marketId: Number(p.marketId),
      side,
      notionalSize: String(p.signedSize ?? '0'),
      fixedApr: typeof rate === 'number' && Number.isFinite(rate) ? rate : null,
      markApr: marketById.get(Number(p.marketId))?.markApr ?? 0,
      pnl: {
        rateSettlementPnl: String(a.settlementPnl ?? '0'),
        unrealisedPnl: String(a.unrealisedPnl ?? '0'),
      },
      positionInitialMargin: positionOnlyInitialMargin(p, marketById.get(Number(p.marketId)), nowSec),
      initialMargin: p.initialMargin as string | undefined,
      hasRestingOrders: Array.isArray(p.orders) && p.orders.length > 0,
    };
  };

  const zones = new Map<number, BorosCollateralZone>();
  for (const r of accountRows) {
    const marketAcc = String(r.marketAcc ?? '');
    const seg = decodeMarketAcc(marketAcc);
    if (!seg || seg.accountId !== accountId) continue;
    const { tokenId, isCross } = seg;
    const group: BorosMarginGroup = {
      isCross,
      marketAcc,
      netBalance: String(r.netBalance ?? '0'),
      initialMargin: r.initialMargin as string | undefined,
      marketPositions: Array.isArray(r.positions)
        ? (r.positions as Array<Record<string, unknown>>).map((p) =>
            toPosition(String(r.marketAcc ?? ''), p),
          )
        : [],
    };
    const zone = zones.get(tokenId) ?? { tokenId, cross: null, isolated: [] };
    if (isCross) zone.cross = group;
    else zone.isolated.push(group);
    zones.set(tokenId, zone);
  }
  return [...zones.values()];
}

async function fetchMarketAccInfos(
  fetchImpl: FetchLike,
  marketAccs: string[],
): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < marketAccs.length; i += 100) {
    const body = (await requestJson(fetchImpl, `${BOROS_GATEWAY_BASE_URL}/v1/accounts/market-acc-infos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ marketAccs: marketAccs.slice(i, i + 100) }),
    })) as { results?: Array<Record<string, unknown>> };
    if (!Array.isArray(body?.results)) {
      throw new CoreError('Boros /accounts/market-acc-infos: unexpected response shape (no results[])', 'network');
    }
    rows.push(...body.results);
  }
  return rows;
}

/** A raw 18-dec integer string as bigint; exponent forms go through Number. */
const toBig = (v: unknown): bigint => {
  const str = String(v ?? '0');
  if (/^-?\d+$/.test(str)) return BigInt(str);
  const n = Math.trunc(Number(str));
  return Number.isFinite(n) ? BigInt(n) : 0n;
};

/**
 * The position's own IM out of the combined per-market `initialMargin`, which
 * the venue computes as max(pos + same-side orders, opposite-side orders − pos).
 * Both branches fit the combined number, so the whitepaper IM at mark picks the
 * right one.
 */
function positionOnlyInitialMargin(
  p: Record<string, unknown>,
  market: BorosMarket | undefined,
  nowSec: number,
): string {
  const combined = toBig(p.initialMargin);
  const size = toBig(p.signedSize);
  const orders = Array.isArray(p.orders) ? (p.orders as Array<Record<string, unknown>>) : [];
  if (size === 0n) return '0';
  if (orders.length === 0) return combined.toString();
  const side = size > 0n ? 0 : 1;
  let same = 0n;
  let opposite = 0n;
  for (const o of orders) {
    if (Number(o.side) === side) same += toBig(o.initialMargin);
    else opposite += toBig(o.initialMargin);
  }
  const candidates = [combined - same, opposite - combined].filter((c) => c > 0n);
  if (candidates.length === 0) return '0';
  const est = market ? borosInitialMarginUsd(market, market.markApr, Math.abs(norm18(size.toString())), nowSec) : null;
  if (est === null || candidates.length === 1) return candidates[0].toString();
  const [a, b] = candidates.map((c) => Math.abs(norm18(c.toString()) - est));
  return (a <= b ? candidates[0] : candidates[1]).toString();
}

/**
 * GET /v1/accounts/position-update-events for ONE (marketAcc, marketId) — the
 * fills of a single market in a single collateral account, paginated fully
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
  marketAcc: string,
  marketId: number,
  opts: { pace?: RequestPacer; prev?: { txns: BorosTxn[]; complete: boolean } } = {},
): Promise<{ txns: BorosTxn[]; complete: boolean }> {
  const held = opts.prev;
  const headId = held?.txns[0]?.id;
  const all: BorosTxn[] = [];
  // Hard page cap: 30 pages × 200 = 6k fills on ONE market. 200 is one CU per
  // page; limit=2000 bills 10 CU even when the market has a handful of fills.
  const maxPages = 30;
  let resumeToken: string | null = null;
  for (let page = 0; page < maxPages; page += 1) {
    await opts.pace?.();
    const body = (await requestJson(
      fetchImpl,
      `${BOROS_GATEWAY_BASE_URL}/v1/accounts/position-update-events?marketAcc=${marketAcc}` +
        `&marketId=${marketId}&limit=200` +
        (resumeToken ? `&resumeToken=${encodeURIComponent(resumeToken)}` : ''),
    )) as { results?: Array<Record<string, unknown>>; resumeToken?: string | null };
    if (!Array.isArray(body?.results)) {
      // Same guard as the other fetchers — a shape change must throw, not get
      // cached as "no trade history" (which would silently zero the fees).
      throw new CoreError(
        'Boros /accounts/position-update-events: unexpected response shape (no results[])',
        'network',
      );
    }
    for (const t of body.results) {
      const id = String(t.id ?? '');
      if (held && headId && id === headId) return { txns: [...all, ...held.txns], complete: held.complete };
      // Number(null) is 0, not NaN — so a null rate would read as a real 0%
      // OTC price. Absent must stay absent.
      const asRate = (v: unknown): number =>
        v === null || v === undefined || v === '' ? Number.NaN : Number(v);
      const prevPositionS = String(t.prevPositionS ?? '0');
      const postPositionS = String(t.postPositionS ?? '0');
      // `prevPositionF` rides on EVERY row, but the venue only ever reported
      // an entry rate on a fill that reduces the position without flipping it
      // — and the difference is load-bearing: on an open-from-flat the field
      // reads 0, which must never be mistaken for "cross-check says 0%".
      const prev = toBig(prevPositionS);
      const post = toBig(postPositionS);
      const abs = (v: bigint): bigint => (v < 0n ? -v : v);
      const reduces = abs(post) < abs(prev) && (post === 0n || post > 0n === prev > 0n);
      const entryApr =
        reduces && t.prevPositionF !== null && t.prevPositionF !== undefined
          ? norm18(t.prevPositionF as string)
          : Number.NaN;
      all.push({
        id,
        marketId: Number(t.marketId),
        time: Number(t.timestamp ?? 0),
        fee: String(t.fee ?? '0'),
        pnl: String(t.pnl ?? '0'),
        prevPositionS,
        postPositionS,
        // No `?? 0` on the rate: a rate of exactly 0 is a real OTC price, so a
        // missing one must stay distinguishable (NaN), not become a free trade.
        fixedApr: asRate(t.tradeRate),
        // Optional per the API — omitted rather than NaN so "no cross-check
        // available" and "cross-check says 0%" stay different things.
        ...(Number.isFinite(entryApr) ? { entryApr } : {}),
      });
    }
    resumeToken = body.resumeToken ?? null;
    if (!resumeToken || body.results.length === 0) return { txns: all, complete: true };
  }
  return { txns: all, complete: false };
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


/** One periodic funding settlement for a (marketAcc, marketId) — the venue's
 * own per-period record: when, at what size, at what effective rate, and the
 * cash that moved. Amounts are in the market's SETTLEMENT TOKEN (norm18'd),
 * not USD — the caller owns the conversion. */
export interface BorosSettlementEvent {
  marketId: number;
  timeSec: number;
  /** |position| at the settlement instant, token units. */
  positionAbs: number;
  /** Net settlement = yieldReceived − yieldPaid − fee, SIGNED (+ = received
   * by the account, a gain; − = paid). */
  settlementToken: number;
  /** Settlement fee charged this period (positive cost). */
  feeToken: number;
  /** Annualized rate effectively applied this period. */
  settlementRate: number;
}

export interface BorosSettlementRow extends BorosSettlementEvent {
  id: string;
  marketAcc: string;
  /** Decoded from `marketAcc`; null when it does not decode to this account. */
  tokenId: number | null;
}

export interface BorosSettlementLedger {
  /** Newest first — the feed's own order (eventIndex descending). */
  rows: BorosSettlementRow[];
  coversFromSec: number;
  olderToken?: string | null;
}

export type RequestPacer = () => Promise<void>;

export function createRequestPacer(opts: {
  perMinute: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}): RequestPacer {
  const sentAt: number[] = [];
  return async () => {
    for (;;) {
      const now = opts.now();
      while (sentAt.length > 0 && now - sentAt[0]! >= 60_000) sentAt.shift();
      if (sentAt.length < opts.perMinute) {
        sentAt.push(now);
        return;
      }
      await opts.sleep(sentAt[0]! + 60_000 - now);
    }
  };
}

interface SettlementPage {
  rows: BorosSettlementRow[];
  resumeToken: string | null;
  isLast: boolean;
}

async function fetchSettlementPage(
  fetchImpl: FetchLike,
  address: string,
  accountId: number,
  resumeToken: string | null,
): Promise<SettlementPage> {
  const clientTag =
    'pendle_client=boroscrossex' + clientTagState.version + (clientTagState.active ? '_active' : '');
  const url =
    `${BOROS_GATEWAY_BASE_URL}/v1/accounts/settlement-events?root=${address}` +
    `&accountId=${accountId}&limit=200` +
    (resumeToken ? `&resumeToken=${encodeURIComponent(resumeToken)}` : '') +
    `&${clientTag}`;
  let resp: Awaited<ReturnType<FetchLike>>;
  try {
    resp = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new CoreError(
      `Boros API unreachable (settlement-events): ${(err as Error)?.message ?? String(err)}`,
      'network',
    );
  }
  if (!resp.ok) {
    throw new CoreError(
      `Boros API settlement-events returned HTTP ${resp.status}`,
      resp.status === 429 ? 'rate-limited' : 'network',
    );
  }
  const body = (await resp.json()) as {
    results?: Array<Record<string, unknown>>;
    resumeToken?: string | null;
  };
  if (!Array.isArray(body?.results)) {
    throw new CoreError('Boros settlement-events: unexpected response shape (no results[])', 'network');
  }
  const rows: BorosSettlementRow[] = [];
  for (const r of body.results) {
    const timeSec = Number(r.timestamp);
    if (!Number.isFinite(timeSec) || timeSec <= 0) continue;
    const marketAcc = String(r.marketAcc ?? '');
    const seg = decodeMarketAcc(marketAcc);
    rows.push({
      id: String(r.id ?? ''),
      marketAcc,
      tokenId: seg && seg.accountId === accountId ? seg.tokenId : null,
      marketId: Number(r.marketId),
      timeSec,
      positionAbs: Math.abs(norm18(r.positionSize as string)),
      settlementToken: norm18(r.settlement as string),
      feeToken: Math.abs(norm18(r.fee as string)),
      settlementRate: Number(r.settlementRate ?? Number.NaN),
    });
  }
  const next = body.resumeToken ?? null;
  return { rows, resumeToken: next, isLast: !next || body.results.length === 0 };
}

async function sweepSettlements(
  fetchImpl: FetchLike,
  address: string,
  accountId: number,
  prev: BorosSettlementLedger | undefined,
  opts: { floorSec: number; pace: RequestPacer; maxPages: number },
): Promise<BorosSettlementLedger | null> {
  const headId = prev?.rows[0]?.id;
  const known = new Set(prev?.rows.map((r) => r.id));
  const fresh: BorosSettlementRow[] = [];
  const older: BorosSettlementRow[] = [];
  let metHead = false;
  let oldestSec = Number.POSITIVE_INFINITY;
  let token: string | null = null;
  const ledger = (coversFromSec: number, olderToken: string | null): BorosSettlementLedger =>
    prev && metHead
      ? { rows: [...fresh.filter((r) => !known.has(r.id)), ...prev.rows, ...older], coversFromSec, olderToken }
      : { rows: fresh, coversFromSec, olderToken };
  for (let pages = 0; pages < opts.maxPages; pages += 1) {
    await opts.pace();
    let page: SettlementPage;
    try {
      page = await fetchSettlementPage(fetchImpl, address, accountId, token);
    } catch (err) {
      if (prev ? !metHead : fresh.length === 0) throw err;
      return ledger(prev ? Math.min(oldestSec, prev.coversFromSec) : oldestSec, token);
    }
    let pageOldestSec = Number.POSITIVE_INFINITY;
    let jumpTo: string | null = null;
    for (const row of page.rows) {
      pageOldestSec = Math.min(pageOldestSec, row.timeSec);
      if (prev && !metHead && row.id === headId) {
        metHead = true;
        if (prev.coversFromSec === 0 || prev.coversFromSec < opts.floorSec) {
          return ledger(prev.coversFromSec, prev.olderToken ?? null);
        }
        if (prev.olderToken) {
          jumpTo = prev.olderToken;
          oldestSec = Math.min(oldestSec, prev.coversFromSec);
          break;
        }
        continue;
      }
      if (metHead && known.has(row.id)) continue;
      (metHead ? older : fresh).push(row);
    }
    if (jumpTo !== null) {
      token = jumpTo;
      continue;
    }
    oldestSec = Math.min(oldestSec, pageOldestSec);
    token = page.resumeToken;
    if (page.isLast) return ledger(0, null);
    if (pageOldestSec < opts.floorSec) return ledger(oldestSec, token);
  }
  return null;
}

/**
 * GET /v1/accounts/settlement-events (gateway) — the per-settlement ledger
 * that makes windowed Boros reconstruction EXACT. Settlements are immutable
 * and the feed pages newest-first on `{root, accountId, eventIndex: -1}`, so
 * the full history is swept once and every later call reads only the head
 * pages until it meets `prev`'s newest row. A page is 1 CU up to limit=200.
 */
export async function syncSettlementLedger(
  fetchImpl: FetchLike,
  address: string,
  accountId: number,
  prev: BorosSettlementLedger | undefined,
  opts: { floorSec: number; pace: RequestPacer },
): Promise<BorosSettlementLedger> {
  const ledger = await sweepSettlements(fetchImpl, address, accountId, prev, {
    ...opts,
    maxPages: Number.POSITIVE_INFINITY,
  });
  if (ledger === null) throw new CoreError('Boros settlement-events: the read ended with no ledger', 'network');
  return ledger;
}

export function readSettlementHead(
  fetchImpl: FetchLike,
  address: string,
  accountId: number,
  prev: BorosSettlementLedger | undefined,
  pace: RequestPacer,
): Promise<BorosSettlementLedger | null> {
  const head = prev?.rows[0];
  return sweepSettlements(fetchImpl, address, accountId, prev, {
    floorSec: head ? head.timeSec + 1 : Number.POSITIVE_INFINITY,
    pace,
    maxPages: 1,
  });
}

/**
 * The window `sinceSec..now` of a ledger. `pairs` is every (marketAcc,
 * marketId) the account ever settled — the fill feed needs a marketId, and
 * this is the only account-wide feed that carries both ids.
 */
export function settlementWindow(
  ledger: BorosSettlementLedger,
  sinceSec: number,
): {
  events: BorosSettlementEvent[];
  coversFromSec: number;
  pairs: Array<{ marketAcc: string; tokenId: number; marketId: number }>;
} {
  const pairs = new Map<string, { marketAcc: string; tokenId: number; marketId: number }>();
  for (const r of ledger.rows) {
    if (r.tokenId === null || !Number.isFinite(r.marketId)) continue;
    pairs.set(`${r.marketAcc.toLowerCase()}:${r.marketId}`, {
      marketAcc: r.marketAcc,
      tokenId: r.tokenId,
      marketId: r.marketId,
    });
  }
  return {
    events: ledger.rows
      .filter((r) => r.timeSec >= sinceSec)
      .map(({ marketId, timeSec, positionAbs, settlementToken, feeToken, settlementRate }) => ({
        marketId,
        timeSec,
        positionAbs,
        settlementToken,
        feeToken,
        settlementRate,
      })),
    coversFromSec: ledger.coversFromSec > sinceSec ? ledger.coversFromSec : 0,
    pairs: [...pairs.values()],
  };
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
