import type { CrossexAccount, CrossexPosition, PositionsResponse } from '../api/types';
import { fmtAge, fmtUsd, num, prettyVenue } from './fmt';

/**
 * Where the account liquidates if ONE coin moves and every other coin holds
 * still.
 *
 * Gate liquidates a CrossEx account when margin balance falls to maintenance
 * margin. Checked on the live account on 2026-09-07: maintenance margin is
 * the sum of every position's maintenance margin plus 10% of the USDC
 * liability, to the cent. In a hedged pair the margin balance is flat, so the
 * ratio falls only because maintenance margin grows with the move, twice
 * over: each leg's maintenance margin scales with its notional, and the
 * losing Hyperliquid leg drives its USDC wallet negative, which is a borrow
 * that adds 10% of itself to maintenance margin.
 *
 * Both curves are anchored on Gate's own current figures and only the CHANGE
 * is modelled. The change in a leg's maintenance margin follows Gate's risk
 * limit tiers when the table for that symbol is known, and the flat rate Gate
 * charges today when it is not.
 */
export interface LiquidationLine {
  base: string;
  venue: string;
  side: 'long' | 'short' | null;
  /** Price of the coin at the line. */
  price: number;
  /** Signed move from the mark: +0.37 is a 37% pump, -0.2 a 20% dump. */
  move: number;
}

/** Cash moved between wallets before the move is priced, in USD. Positive
 * adds to the wallet. Used to price "after the rebalance". */
export type WalletShift = Partial<Record<string, number>>;

/** Gate's maintenance margin on a borrow: 10% of the liability. */
const BORROW_MM = 0.1;

/** Gate's quick_cal_amount is a deduction, not a charge: on a live read of /crossex/rule/risk_limits on 2026-09-21, HYPE tier 4 and tier 5 both give $21,300 at $1M. */
export interface MarginTier {
  from: number;
  rate: number;
  deduction: number;
}

export type MarginTiers = Readonly<Record<string, readonly MarginTier[]>>;

export function maintenanceAt(tiers: readonly MarginTier[], notional: number): number {
  if (tiers.length === 0) return 0;
  const row = tiers.reduce((best, t) => (t.from <= notional && t.from >= best.from ? t : best), tiers[0]);
  return Math.max(0, notional * row.rate - row.deduction);
}

export interface LiquidationUnknown {
  base: string;
  venue: string;
  sinceMs: number | null;
}

export function gateNumber(raw: string | number | undefined | null): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

interface Leg {
  base: string;
  exchange: string;
  wallet: string;
  sign: 1 | -1;
  value: number;
  mm: number;
  mark: number;
  tiers?: readonly MarginTier[];
}

const USDC_WALLET_VENUES: readonly string[] = ['HYPERLIQUID', 'LIGHTER'];

function walletOf(exchange: string): string {
  return USDC_WALLET_VENUES.includes(exchange) ? `USDC/${exchange}` : 'USDT/CROSSEX';
}

function staleSinceOf(p: CrossexPosition): number | null {
  const ms = gateNumber((p as { markStaleSinceMs?: number }).markStaleSinceMs);
  return ms !== null && ms > 0 ? ms : null;
}

function legsOf(positions: PositionsResponse, tiers: MarginTiers): { legs: Leg[]; unknown: LiquidationUnknown[] } {
  const bySymbol = new Map(positions.positions.map((p) => [p.symbol, p]));
  const legs: Leg[] = [];
  const unpriced = new Map<string, LiquidationUnknown>();
  for (const g of positions.exposure) {
    for (const l of g.legs) {
      const p = bySymbol.get(l.symbol);
      if (!p || !(l.value > 0)) continue;
      const mark = gateNumber(p.markPrice);
      const mm = gateNumber(p.maintenanceMargin);
      if (mark === null || mark <= 0 || mm === null || mm < 0) {
        if (!unpriced.has(g.base)) {
          unpriced.set(g.base, {
            base: g.base,
            venue: prettyVenue(l.exchange),
            sinceMs: staleSinceOf(p),
          });
        }
        continue;
      }
      legs.push({
        base: g.base,
        exchange: l.exchange,
        wallet: walletOf(l.exchange),
        sign: l.side === 'LONG' ? 1 : -1,
        value: l.value,
        mm,
        mark,
        tiers: tiers[l.symbol],
      });
    }
  }
  return { legs: legs.filter((l) => !unpriced.has(l.base)), unknown: [...unpriced.values()] };
}

/** Bisect g on [lo, hi] where g(lo) > 0 >= g(hi) or the reverse. */
function root(g: (f: number) => number, lo: number, hi: number): number {
  let a = lo;
  let b = hi;
  for (let i = 0; i < 60; i++) {
    const m = (a + b) / 2;
    if ((g(a) > 0) === (g(m) > 0)) a = m;
    else b = m;
  }
  return (a + b) / 2;
}

interface MarginModel {
  legs: Leg[];
  unknown: LiquidationUnknown[];
  gapOf: (mine: Leg[]) => (f: number) => number;
}

const MM_TABLE_TOLERANCE = 0.01;

function mmChange(l: Leg, f: number): number {
  const flat = l.mm * (f - 1);
  if (l.tiers === undefined || l.tiers.length === 0) return flat;
  const mmNow = maintenanceAt(l.tiers, l.value);
  const tiered = maintenanceAt(l.tiers, l.value * f) - mmNow;
  const disagrees = Math.abs(mmNow - l.mm) > MM_TABLE_TOLERANCE * l.mm;
  return disagrees ? Math.max(flat, tiered) : tiered;
}

function marginModel(
  acc: CrossexAccount,
  positions: PositionsResponse,
  shift: WalletShift,
  tiers: MarginTiers,
): MarginModel | null {
  const marginBalance = gateNumber(acc.marginBalance);
  const maintenance = gateNumber(acc.maintenanceMargin);
  if (marginBalance === null || maintenance === null) return null;
  const { legs, unknown } = legsOf(positions, tiers);

  const equityNow = new Map<string, number>();
  for (const a of acc.assets) {
    const equity = gateNumber(a.equity);
    if (equity === null) return null;
    equityNow.set(`${a.coin}/${a.exchangeType}`, equity);
  }
  const wallets = [...new Set([...equityNow.keys(), ...legs.map((l) => l.wallet)])];
  const liabilityOf = (equity: (w: string) => number) =>
    wallets.reduce((sum, w) => sum + Math.max(0, -equity(w)), 0);
  const liabilityNow = liabilityOf((w) => equityNow.get(w) ?? 0);

  const gapOf =
    (mine: Leg[]) =>
    (f: number): number => {
      const d = f - 1;
      const upnl = mine.reduce((s, l) => s + l.sign * l.value * d, 0);
      const mm = mine.reduce((s, l) => s + mmChange(l, f), 0);
      const liability = liabilityOf(
        (w) =>
          (equityNow.get(w) ?? 0) +
          (shift[w] ?? 0) +
          mine.filter((l) => l.wallet === w).reduce((s, l) => s + l.sign * l.value * d, 0),
      );
      return marginBalance + upnl - (maintenance + mm + BORROW_MM * (liability - liabilityNow));
    };
  return { legs, unknown, gapOf };
}

function crossings(g: (f: number) => number): { down: number | null; up: number | null } {
  if (g(1) <= 0) return { down: 1, up: 1 };
  return { down: g(0) <= 0 ? root(g, 0, 1) : null, up: upCrossing(g) };
}

function upCrossing(g: (f: number) => number): number | null {
  for (let hi = 2; hi <= Number.MAX_SAFE_INTEGER; hi *= 2) {
    if (g(hi) <= 0) return root(g, hi / 2, hi);
  }
  return null;
}

function lineAt(mine: Leg[], f: number, losingSign: 1 | -1): { line: LiquidationLine; exchange: string } {
  const biggest = mine.reduce((a, b) => (b.value > a.value ? b : a));
  const losing = mine.filter((l) => l.sign === losingSign);
  const loser = (losing.length > 0 ? losing : mine).reduce((a, b) => (b.value > a.value ? b : a));
  const side = losing.length === 0 ? null : loser.sign === 1 ? 'long' : 'short';
  return {
    line: { base: loser.base, venue: prettyVenue(loser.exchange), side, price: biggest.mark * f, move: f - 1 },
    exchange: loser.exchange,
  };
}

/** The lines the model found, nearest first, and the coins no price of
 * their own liquidates. A coin in neither has no priced leg. */
export interface LiquidationView {
  lines: LiquidationLine[];
  far: string[];
  unknown: LiquidationUnknown[];
}

/** One line per coin held. Null when Gate's margin figures are not numbers:
 * unknown is not the same as far, and the cards must not say safe. */
export function liquidationLines(
  acc: CrossexAccount,
  positions: PositionsResponse,
  shift: WalletShift = {},
  tiers: MarginTiers = {},
): LiquidationView | null {
  const model = marginModel(acc, positions, shift, tiers);
  if (model === null) return null;

  const lines: LiquidationLine[] = [];
  const far: string[] = [];
  for (const base of new Set(model.legs.map((l) => l.base))) {
    const mine = model.legs.filter((l) => l.base === base);
    const { down, up } = crossings(model.gapOf(mine));
    const candidates = [up, down].filter((f): f is number => f !== null);
    if (candidates.length === 0) {
      far.push(base);
      continue;
    }
    const f = candidates.reduce((a, b) => (Math.abs(a - 1) <= Math.abs(b - 1) ? a : b));
    lines.push(lineAt(mine, f, f > 1 ? -1 : 1).line);
  }
  return { lines: lines.sort((a, b) => Math.abs(a.move) - Math.abs(b.move)), far, unknown: model.unknown };
}

export interface LiquidationSide extends LiquidationLine {
  exchange: string;
}

export interface LiquidationSides {
  down: LiquidationSide | null;
  up: LiquidationSide | null;
}

export function liquidationSides(
  acc: CrossexAccount,
  positions: PositionsResponse,
  base: string,
  tiers: MarginTiers = {},
): LiquidationSides | null {
  const model = marginModel(acc, positions, {}, tiers);
  if (model === null) return null;
  const upper = base.toUpperCase();
  const mine = model.legs.filter((l) => l.base.toUpperCase() === upper);
  if (mine.length === 0) return { down: null, up: null };
  const { down, up } = crossings(model.gapOf(mine));
  const sideAt = (f: number | null, losingSign: 1 | -1): LiquidationSide | null => {
    if (f === null) return null;
    const { line, exchange } = lineAt(mine, f, losingSign);
    return { ...line, exchange };
  };
  return { down: sideAt(down, 1), up: sideAt(up, -1) };
}

/** This coin's entry in a view: its line, 'far' when it was priced without
 * one, null when it has no priced leg. */
export function lineFor(view: LiquidationView, base: string): LiquidationLine | 'far' | null {
  const up = base.toUpperCase();
  return view.lines.find((l) => l.base.toUpperCase() === up) ?? (view.far.some((b) => b.toUpperCase() === up) ? 'far' : null);
}

/** `+37%`, `-20%`. Whole percents: the line is a model, not a quote. */
export function fmtMove(move: number): string {
  return `${move < 0 ? '-' : '+'}${num(Math.abs(move) * 100, 0)}%`;
}

/** `~$3,150` for a big coin, `~$86.70` for a small one. */
export function fmtLinePrice(price: number): string {
  return `~${fmtUsd(price, price >= 1000 ? 0 : 2)}`;
}

/** `Liquidation ~$3,150 (+37%)` — the signed move carries the direction. The chip sits in the coin's
 *  own card, so it does not repeat the coin. */
export function lineLabel(line: LiquidationLine): string {
  return `Liquidation ${fmtLinePrice(line.price)} (${fmtMove(line.move)})`;
}

/** The losing leg and the model, for the hover on a chip that already shows the price. */
export function lineDetail(line: LiquidationLine): string {
  const leg = line.side === null ? '' : `Losing leg: ${line.venue} ${line.side}. `;
  return `${leg}Estimate: other coins flat.`;
}

/** The full line, for a hover that does not show the price. */
export function describeLine(line: LiquidationLine): string {
  const price = fmtUsd(line.price, line.price >= 1000 ? 0 : 2);
  return `${line.base} ${line.move < 0 ? 'falls' : 'rises'} to ${price} (${fmtMove(line.move)}). ${lineDetail(line)}`;
}

export function unknownLabel(unknown: { venue: string; sinceMs: number }, nowMs: number): string {
  return `No ${unknown.venue} price from Gate for ${fmtAge(nowMs - unknown.sinceMs)}.`;
}
