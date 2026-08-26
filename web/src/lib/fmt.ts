/** Number/format helpers. `num`, `sig`, `parseSymbol` are FAITHFUL PORTS of
 * src/core/numbers.ts (and `direction` of src/core/orders.ts) — keep behavior
 * identical; the fmt tests pin them to the core test expectations. */

/** Format a number to a fixed number of decimals with thousands separators. */
export function num(value: number | string, dp = 2): string {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return String(value);
  return n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/** Compact significant-figure formatting for prices/quantities of any scale. */
export function sig(value: number | string, maxDp = 8): string {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (n === 0) return '0';
  const abs = Math.abs(n);
  const dp = abs >= 1000 ? 2 : abs >= 1 ? 4 : maxDp;
  return n.toFixed(dp).replace(/\.?0+$/, '');
}

export const FIELD_SIG_FIGS = 8;

export function fieldValue(value: number, sigFigs: number = FIELD_SIG_FIGS): string {
  if (!Number.isFinite(value)) return '';
  return String(Number(value.toPrecision(sigFigs)));
}

/** Parse `{EXCHANGE}_{BUSINESS}_{BASE}_{QUOTE}` into parts. */
export function parseSymbol(symbol: string): {
  exchange: string;
  business: string;
  base: string;
  quote: string;
  pair: string; // BASE_QUOTE
} {
  const parts = symbol.split('_');
  const exchange = parts[0] ?? '';
  const business = parts[1] ?? '';
  const quote = parts[parts.length - 1] ?? '';
  const base = parts.slice(2, -1).join('_');
  return { exchange, business, base, quote, pair: `${base}_${quote}` };
}

/** Venue key → display casing: "GATE" → "Gate", "HYPERLIQUID" → "Hyperliquid";
 * short keys (≤3 chars, e.g. "OKX") stay upper-case. */
export function prettyVenue(v: string): string {
  return v.length <= 3 ? v : v.charAt(0) + v.slice(1).toLowerCase();
}

// ---------------------------------------------------------------------------
// Web-only additions
// ---------------------------------------------------------------------------

/**
 * "$1,234.50" (negative → "-$1,234.50").
 *
 * ⚠ `dp` is a MAXIMUM-magnitude preference, not a promise to round a real
 * balance away. Callers pass `dp = 0` to keep wide columns tidy, which is right
 * for $1,234 and wrong for $0.07 — that rendered as "$0", a number the user
 * holds printed as nothing. So a value that would round to zero at the
 * requested precision falls back to 2dp and shows its cents. Only an exact 0
 * prints as "$0".
 */
export function fmtUsd(value: number | string, dp = 2): string {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return String(value);
  const abs = Math.abs(n);
  const effectiveDp = dp < 2 && abs > 0 && abs < 0.5 * 10 ** -dp ? 2 : dp;
  return `${n < 0 ? '-' : ''}$${num(abs, effectiveDp)}`;
}

/** Compact notionals ("$2.58M") so tight numeric columns never clip. */
export function fmtUsdCompact(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${n < 0 ? '-' : ''}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e4) return `${n < 0 ? '-' : ''}$${(abs / 1e3).toFixed(1)}k`;
  return fmtUsd(n, 0);
}

/** Headline notionals ("$10k", "$14.7k", "$1.5M") — drops the trailing ".0". */
export function fmtNotionalShort(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${sign}$${+(abs / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e3) return `${sign}$${+(abs / 1e3).toFixed(abs >= 1e5 ? 0 : 1)}k`;
  return fmtUsd(n, 0);
}

/** Token quantities for notional brackets: "2.63 ETH", "142.7 ETH",
 * "1.2k HYPE", "1.5M HYPE". Compact ≥1k (fmtNotionalShort's tiers), 2 dp
 * for 1–100, 1 dp for 100–1000, 3 sig figs below 1; trailing zeros dropped.
 * Rounding that carries INTO the next tier promotes with it (999.96 → "1k",
 * never a separator-less "1000"); dust under a millionth reads "<0.000001"
 * rather than leaking exponential notation. */
export function fmtTokenQty(amount: number, symbol: string): string {
  if (!Number.isFinite(amount)) return '—';
  const sign = amount < 0 ? '-' : '';
  const abs = Math.abs(amount);
  if (abs > 0 && abs < 1e-6) return `${sign}<0.000001 ${symbol}`;
  const tier = (v: number): string => {
    if (v >= 1e6) return `${+(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M`;
    if (v >= 1e3) {
      const k = +(v / 1e3).toFixed(v >= 1e5 ? 0 : 1);
      return k >= 1e3 ? tier(k * 1e3) : `${k}k`;
    }
    if (v >= 100) {
      const r = +v.toFixed(1);
      return r >= 1e3 ? tier(r) : `${r}`;
    }
    if (v >= 1) {
      const r = +v.toFixed(2);
      return r >= 100 ? tier(r) : `${r}`;
    }
    const r = +v.toPrecision(3);
    return r >= 1 ? tier(r) : `${r}`;
  };
  return `${sign}${tier(abs)} ${symbol}`;
}

/** Ratio → percent: fmtPct(0.1234) → "12.34%". */
export function fmtPct(ratio: number | string, dp = 2): string {
  const n = typeof ratio === 'number' ? ratio : Number(ratio);
  if (!Number.isFinite(n)) return String(ratio);
  return `${num(n * 100, dp)}%`;
}

/** Fee fraction → basis points: bps(0.0002) → "2.0 bps". */
export function bps(rate: number | string): string {
  const n = typeof rate === 'number' ? rate : Number(rate);
  if (!Number.isFinite(n)) return String(rate);
  return `${(n * 10000).toFixed(1)} bps`;
}

/** Ratio → numeric basis points: bpsOf(0.0002) → 2 (caller formats). */
export function bpsOf(ratio: number): number {
  return ratio * 10_000;
}

/** Fee fraction → percent with fee precision: feePct(0.0002) → "0.0200%". */
export function feePct(rate: number | string): string {
  const n = typeof rate === 'number' ? rate : Number(rate);
  if (!Number.isFinite(n)) return String(rate);
  return `${(n * 100).toFixed(4)}%`;
}

/** Signed color class for PnL-like values. */
export function signedClass(value: number | string): string {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n === 0) return 'text-ink-300';
  return n > 0 ? 'text-emerald-400' : 'text-rose-400';
}

/** Defensive epoch parser: createTime may be seconds OR milliseconds
 * (value < 1e12 ⇒ seconds). */
export function toDate(epoch: number | string | undefined | null): Date | null {
  const n = Number(epoch ?? NaN);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n < 1e12 ? n * 1000 : n);
}

/** Compact age: "3s", "4m 12s", "2h 5m", "3d". */
export function fmtAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d`;
}

/** Unix seconds → UTC "YYYY-MM-DD" (maturities are quoted in UTC). */
export function fmtDateUtc(unixSec: number): string {
  return unixSec > 0 ? new Date(unixSec * 1000).toISOString().slice(0, 10) : '—';
}

/** Unix seconds → local "YYYY-MM-DD" (the clock-basis / maturity date form). */
export function fmtDateLocal(unixSec: number | null | undefined): string {
  if (unixSec === null || unixSec === undefined || !Number.isFinite(unixSec) || unixSec <= 0)
    return '—';
  const d = new Date(unixSec * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "HH:MM:SS" today, "MM-DD HH:MM:SS" otherwise. */
export function fmtTime(d: Date | null): string {
  if (!d) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  const hms = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  return sameDay ? hms : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hms}`;
}
