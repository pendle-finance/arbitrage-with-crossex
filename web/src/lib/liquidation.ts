import type { CrossexAccount, PositionsResponse } from '../api/types';
import { fmtUsd, num } from './fmt';

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
 * is modelled, so tiered rates and rounding on the venue side cancel out at
 * the mark.
 */
export interface LiquidationLine {
  base: string;
  /** Price of the coin at the line. */
  price: number;
  /** Signed move from the mark: +0.37 is a 37% pump, -0.2 a 20% dump. */
  move: number;
}

/** Cash moved between wallets before the move is priced, in USD. Positive
 * adds to the wallet. Used to price "after the rebalance". */
export type WalletShift = Partial<Record<'USDC/HYPERLIQUID' | 'USDT/CROSSEX', number>>;

/** Gate's maintenance margin on a borrow: 10% of the liability. */
const BORROW_MM = 0.1;
/** No line is reported past a 10x pump or a 98% dump. */
const F_MAX = 10;
const F_MIN = 0.02;

interface Leg {
  base: string;
  wallet: string;
  sign: 1 | -1;
  value: number;
  mm: number;
  mark: number;
}

/** Only Hyperliquid settles in USDC. Every other venue's leg lives in the pooled USDT wallet. */
function walletOf(exchange: string): 'USDC/HYPERLIQUID' | 'USDT/CROSSEX' {
  return exchange === 'HYPERLIQUID' ? 'USDC/HYPERLIQUID' : 'USDT/CROSSEX';
}

function legsOf(positions: PositionsResponse): Leg[] {
  const bySymbol = new Map(positions.positions.map((p) => [p.symbol, p]));
  const legs: Leg[] = [];
  for (const g of positions.exposure) {
    for (const l of g.legs) {
      const p = bySymbol.get(l.symbol);
      if (!p || !(l.value > 0)) continue;
      legs.push({
        base: g.base,
        wallet: walletOf(l.exchange),
        sign: l.side === 'LONG' ? 1 : -1,
        value: l.value,
        mm: Number(p.maintenanceMargin) || 0,
        mark: Number(p.markPrice) || 0,
      });
    }
  }
  return legs;
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

/** One line per coin held, nearest first. Empty when nothing is open or the
 * account is missing a figure. */
export function liquidationLines(
  acc: CrossexAccount,
  positions: PositionsResponse,
  shift: WalletShift = {},
): LiquidationLine[] {
  const legs = legsOf(positions);
  const marginBalance = Number(acc.marginBalance);
  const maintenance = Number(acc.maintenanceMargin);
  if (legs.length === 0 || !Number.isFinite(marginBalance) || !Number.isFinite(maintenance)) return [];

  const equityNow = new Map<string, number>();
  for (const a of acc.assets) equityNow.set(`${a.coin}/${a.exchangeType}`, Number(a.equity) || 0);
  const wallets = [...new Set([...equityNow.keys(), ...legs.map((l) => l.wallet)])];
  const liabilityOf = (equity: (w: string) => number) =>
    wallets.reduce((sum, w) => sum + Math.max(0, -equity(w)), 0);
  const liabilityNow = liabilityOf((w) => equityNow.get(w) ?? 0);

  const lines: LiquidationLine[] = [];
  for (const base of new Set(legs.map((l) => l.base))) {
    const mine = legs.filter((l) => l.base === base);
    const g = (f: number): number => {
      const d = f - 1;
      const upnl = mine.reduce((s, l) => s + l.sign * l.value * d, 0);
      const mm = mine.reduce((s, l) => s + l.mm * d, 0);
      const liability = liabilityOf(
        (w) =>
          (equityNow.get(w) ?? 0) +
          (shift[w as keyof WalletShift] ?? 0) +
          mine.filter((l) => l.wallet === w).reduce((s, l) => s + l.sign * l.value * d, 0),
      );
      return marginBalance + upnl - (maintenance + mm + BORROW_MM * (liability - liabilityNow));
    };
    const candidates: number[] = [];
    if (g(1) <= 0) candidates.push(1);
    else {
      if (g(F_MAX) <= 0) candidates.push(root(g, 1, F_MAX));
      if (g(F_MIN) <= 0) candidates.push(root(g, F_MIN, 1));
    }
    if (candidates.length === 0) continue;
    const f = candidates.reduce((a, b) => (Math.abs(a - 1) <= Math.abs(b - 1) ? a : b));
    const biggest = mine.reduce((a, b) => (b.value > a.value ? b : a));
    lines.push({ base, price: biggest.mark * f, move: f - 1 });
  }
  return lines.sort((a, b) => Math.abs(a.move) - Math.abs(b.move));
}

export function nearestLiquidation(
  acc: CrossexAccount | undefined,
  positions: PositionsResponse | undefined,
  shift?: WalletShift,
): LiquidationLine | null {
  if (!acc || !positions) return null;
  return liquidationLines(acc, positions, shift)[0] ?? null;
}

/** `+37%`, `-20%`. Whole percents: the line is a model, not a quote. */
export function fmtMove(move: number): string {
  return `${move < 0 ? '-' : '+'}${num(Math.abs(move) * 100, 0)}%`;
}

/** `~$3,150` for a big coin, `~$86.70` for a small one. */
export function fmtLinePrice(price: number): string {
  return `~${fmtUsd(price, price >= 1000 ? 0 : 2)}`;
}

/** `Liquidates if ETH hits ~$3,150 (+37%)`, or `falls to` for a dump. The chip text. */
export function lineLabel(line: LiquidationLine): string {
  return `Liquidates if ${line.base} ${line.move < 0 ? 'falls to' : 'hits'} ${fmtLinePrice(line.price)} (${fmtMove(line.move)})`;
}

/** One sentence for a hover. */
export function describeLine(line: LiquidationLine): string {
  return `Liquidates at about ${fmtUsd(line.price, line.price >= 1000 ? 0 : 2)} if only ${line.base} moves (${fmtMove(line.move)}) and every other coin holds still.`;
}
