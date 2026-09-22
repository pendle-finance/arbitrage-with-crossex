/**
 * Token and venue icons, from the Boros app's own asset bucket.
 *
 * ⚠️ The venue filenames are NOT derivable from the venue's name. Boros stores
 * whatever the designer exported — `binance_icon.svg`, but also
 * `Layer_x0020_1_0.svg` (Bybit) and `Frame 1000005731.svg` (Gate) — and serves
 * the real name in `platform.icon` on `GET /core/v1/markets`. So the map below
 * is transcribed from that response rather than guessed. Guessing is what left
 * Gate and OKX without marks: `gate.svg` and `okx.svg` 403, while the three
 * venues that happened to match a lowercase name looked like the rule worked.
 *
 * Coins ARE keyed by their upper-case symbol (`ETH.svg`), but the bucket only
 * holds the collateral coins — ETH, BTC, USDT, USDC. Everything else Boros
 * lists (SOL, HYPE, XRP, BNB, the metals/oil/index markets) 403s, and
 * `metadata.icon` is no help: it is a per-MARKET composite (`ETHUSDT
 * BINANCE.svg`), not a coin mark.
 *
 * So a missing icon is the NORMAL case, not an error, and the fallback has to
 * be good enough to sit in a table beside a real one: same disc, same size,
 * the symbol's first character in the house grey. `onError` swaps to it when
 * the network says no, which also covers an offline terminal — this app must
 * render the same with the network blocked, which is why the fonts are
 * self-hosted too.
 */
import { useEffect, useState } from 'react';

const BUCKET = 'https://storage.googleapis.com/boros-prod';

/** Venue key → the bucket filename Boros serves in `platform.icon`.
 * Transcribed 2026-09-21 from `GET /core/v1/markets`; a venue that is not
 * here simply falls back to its initial, which is what Kraken and Deribit
 * (CrossEx venues Boros does not list) get. */
const VENUE_FILE: Record<string, string> = {
  BINANCE: 'binance_icon.svg',
  BYBIT: 'Layer_x0020_1_0.svg',
  GATE: 'Frame 1000005731.svg',
  HYPERLIQUID: 'hyperliquid_icon.svg',
  KUCOIN: 'KuCoin Symbol SVG.svg',
  LIGHTER: 'lighter-2.svg',
  OKX: 'okx_icon.svg',
};

/** The coins the bucket actually holds — the Boros collateral set. */
const TOKEN_FILES = new Set(['ETH', 'BTC', 'USDT', 'USDC']);

/** A coin icon is keyed by its upper-case symbol. Null when the bucket has
 * none, so the caller renders the fallback without a wasted request. */
export function tokenIconUrl(symbol: string): string | null {
  const key = symbol.trim().toUpperCase();
  return TOKEN_FILES.has(key) ? `${BUCKET}/${key}.svg` : null;
}

export function venueIconUrl(venue: string): string | null {
  const file = VENUE_FILE[venue.trim().toUpperCase()];
  return file ? `${BUCKET}/${encodeURIComponent(file)}` : null;
}

function Fallback({ label, size, title }: { label: string; size: number; title?: string }) {
  return (
    <span
      aria-hidden="true"
      title={title}
      style={{ width: size, height: size, fontSize: Math.max(8, Math.round(size * 0.44)) }}
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-wash/[0.15] font-semibold leading-none text-ink-300"
    >
      {label.trim().charAt(0).toUpperCase()}
    </span>
  );
}

function RemoteIcon({
  src,
  label,
  size,
  title,
}: {
  src: string;
  label: string;
  size: number;
  title?: string;
}) {
  const [failed, setFailed] = useState(false);
  // A new symbol in the same slot must get its own chance at the network —
  // otherwise one 403 would poison every later icon rendered by that element.
  useEffect(() => setFailed(false), [src]);

  if (failed) return <Fallback label={label} size={size} title={title} />;
  return (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      title={title}
      width={size}
      height={size}
      loading="lazy"
      onError={() => setFailed(true)}
      style={{ width: size, height: size }}
      className="block shrink-0 rounded-full"
    />
  );
}

/** A coin's icon — ETH, BTC, … Decorative: the symbol is always written beside it. */
export function TokenIcon({ symbol, size = 20 }: { symbol: string; size?: number }) {
  if (!symbol) return null;
  const src = tokenIconUrl(symbol);
  if (!src) return <Fallback label={symbol} size={size} />;
  return <RemoteIcon src={src} label={symbol} size={size} />;
}

/** An exchange's icon — Hyperliquid, Gate, … */
export function VenueIcon({ venue, size = 20 }: { venue: string; size?: number }) {
  if (!venue) return null;
  const src = venueIconUrl(venue);
  if (!src) return <Fallback label={venue} size={size} />;
  return <RemoteIcon src={src} label={venue} size={size} />;
}
