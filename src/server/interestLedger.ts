/**
 * Interest paid, all time, as one running total per wallet.
 *
 * Gate's `history_margin_interests` is one row per hour per borrowed coin,
 * and it refuses a `from` before 2025-01-01. Paging the whole history on
 * every poll would be hundreds of calls, so the totals live on disk and each
 * sync reads only the rows since the newest one it has. The rows at that
 * newest timestamp are remembered by id, so the next sync can skip them.
 *
 * The ledger belongs to one Gate account. A sync for another account starts
 * a fresh one.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CoreError } from '../core/errors';
import { walletKey, type InterestPaidLike } from '../core/rebalance/plan';

/** 2025-01-01T00:00:00Z. Gate: `[from] must be greater than or equal to 1735689600000`. */
export const GATE_HISTORY_FLOOR_MS = 1_735_689_600_000;
export const INTEREST_PAGE_SIZE = 1000;
/** 100,000 rows a sync: eleven years of hourly rows for one coin. */
export const INTEREST_MAX_PAGES = 100;
/** `details` of the CoreError thrown when a sync does not fit in those pages. */
export const INTEREST_OVERFLOW = 'interest-overflow';

export interface InterestRowLike {
  interestId?: string;
  liabilityCoin?: string;
  exchangeType?: string;
  interest?: string;
  createTime?: string;
}

export interface InterestQuery {
  from: number;
  to: number;
  page: number;
  limit: number;
}

export interface Ledger {
  userId: string | null;
  /** createTime of the newest row counted. 0 before the first sync. */
  through: number;
  /** Ids of the rows at `through`, so a sync from `through` does not count them twice. */
  seenAtThrough: string[];
  paid: InterestPaidLike;
}

function parseLedger(raw: unknown): Ledger | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.through !== 'number' || !Array.isArray(r.seenAtThrough) || !r.paid || typeof r.paid !== 'object') return null;
  return {
    userId: typeof r.userId === 'string' ? r.userId : null,
    through: r.through,
    seenAtThrough: r.seenAtThrough.filter((id): id is string => typeof id === 'string'),
    paid: Object.fromEntries(Object.entries(r.paid as Record<string, unknown>).filter(([, v]) => typeof v === 'number')) as InterestPaidLike,
  };
}

export class InterestFile {
  private readonly file: string | null;
  private memory: Ledger | null = null;

  /** `null` keeps the ledger in memory, for tests. */
  constructor(dataDir: string | null) {
    this.file = dataDir === null ? null : path.join(dataDir, 'interest.json');
  }

  /** Null when there is no ledger yet, or the file is not one: the next sync
   * counts from the floor again, which is slow once and never wrong. */
  read(): Ledger | null {
    if (this.file === null) return this.memory;
    try {
      return parseLedger(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {
      return null;
    }
  }

  write(ledger: Ledger): void {
    if (this.file === null) {
      this.memory = ledger;
      return;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

const rowId = (r: InterestRowLike): string =>
  r.interestId ?? `${r.liabilityCoin}/${r.exchangeType}/${r.createTime}/${r.interest}`;

/**
 * Bring the ledger up to `now` and return the totals by wallet key.
 *
 * Throws a CoreError with INTEREST_OVERFLOW as details, and leaves the ledger as it was when the rows
 * since the last sync do not fit in INTEREST_MAX_PAGES pages: the pages are
 * newest first, so counting a partial read would lose the oldest rows for
 * good.
 */
export async function syncInterest(
  file: InterestFile,
  userId: string | null,
  list: (q: InterestQuery) => Promise<InterestRowLike[]>,
  now: number,
): Promise<InterestPaidLike> {
  const prior = file.read();
  const ledger: Ledger =
    prior && prior.userId === userId ? prior : { userId, through: 0, seenAtThrough: [], paid: {} };
  const from = Math.max(ledger.through, GATE_HISTORY_FLOOR_MS);

  const rows: InterestRowLike[] = [];
  for (let page = 1; ; page += 1) {
    if (page > INTEREST_MAX_PAGES) {
      throw new CoreError(
        `interest history has more than ${INTEREST_MAX_PAGES * INTEREST_PAGE_SIZE} rows since the last sync; the all-time total was not updated`,
        'validation',
        INTEREST_OVERFLOW,
      );
    }
    const batch = await list({ from, to: now, page, limit: INTEREST_PAGE_SIZE });
    rows.push(...batch);
    if (batch.length < INTEREST_PAGE_SIZE) break;
  }

  const paid: InterestPaidLike = { ...ledger.paid };
  let through = ledger.through;
  let seen = [...ledger.seenAtThrough];
  let added = 0;
  for (const r of rows) {
    const t = Number(r.createTime);
    if (!Number.isFinite(t) || t < from) continue;
    const id = rowId(r);
    if (t === ledger.through && ledger.seenAtThrough.includes(id)) continue;
    const key = walletKey(r.liabilityCoin ?? '', r.exchangeType ?? '');
    paid[key] = (paid[key] ?? 0) + (Number(r.interest) || 0);
    if (t > through) {
      through = t;
      seen = [id];
    } else if (t === through) {
      seen.push(id);
    }
    added += 1;
  }
  if (ledger !== prior || added > 0) file.write({ userId, through, seenAtThrough: seen, paid });
  return paid;
}
