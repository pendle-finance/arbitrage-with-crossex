/** Share-position payload codec — the wire format behind
 * `boros.pendle.finance/arbitrage-crossex/position?d=<encoded>`.
 *
 * The payload is a compact short-key JSON snapshot of one 4-leg position,
 * base64url-encoded into the URL itself: the public box stores nothing, so the
 * link IS the data. Decoding is reject-don't-sanitize: a strict schema guard
 * (charset-limited strings, finite range-clamped numbers, unknown keys
 * rejected) means a decoded payload is safe to interpolate into HTML meta tags
 * after entity-escaping, and there is deliberately NO free-text field — that
 * is what keeps addresses/symbols/warnings out of the wire format by
 * construction.
 *
 * CROSS-REPO MIRROR — UNGUARDED, the riskiest thing about this file. This
 * terminal only ENCODES; the page that DECODES lives in the separate
 * arbitrage-landing repo, which keeps its own byte-identical copies at
 * web/src/lib/shareCodec.ts and src/core/share/codec.ts. That repo's
 * shareCodec.mirror.test.ts pins ITS two copies to each other — nothing pins
 * them to THIS one, because no test can span two repos. So a change here that
 * is not copied there silently breaks every link this terminal emits. Edit
 * this file only together with the landing repo's copies, and keep all three
 * byte-identical. Everything here is environment-neutral:
 * TextEncoder/TextDecoder + a hand-rolled base64url — no Buffer, no atob.
 *
 * ADDITIVE FIELDS (like a leg's optional tn/ts): a decoder built before a
 * field existed rejects links that carry it as 'malformed' — the unknown-key
 * guard cannot tell "newer schema" from "hostile". So the PUBLIC SITE must
 * deploy a codec that knows a new field BEFORE any terminal release emits it,
 * or recipients of healthy links are told to ask the sender to re-share.
 */

/** One leg of the shared position. */
export interface ShareLegV1 {
  /** 'b' Boros rate leg | 'p' perp leg. */
  k: 'b' | 'p';
  /** Venue key as normalized upstream, e.g. "HYPERLIQUID". */
  x: string;
  /** 'L' LONG | 'S' SHORT. */
  s: 'L' | 'S';
  /** Notional USD, whole dollars. */
  n: number;
  /** Boros legs only: entry fixed APR, fraction, 4dp. */
  r?: number;
  /** Token-margined legs only, always together with `ts`: the notional in
   * token terms — Boros: size in the collateral token; perp: |qty| in the
   * base coin. Display precision, like `n`. */
  tn?: number;
  /** The token `tn` counts, e.g. "ETH". Same charset as the base asset. */
  ts?: string;
}

/** Fee breakdown, USD cents precision. Nullable where the source is unknowable. */
export interface ShareFeesV1 {
  /** Paid: perp trading fees. */
  pp: number;
  /** Paid: perp entry slippage (signed). */
  ps: number | null;
  /** Paid: Boros trade fees. */
  pb: number;
  /** Paid: Boros settlement fees accrued so far. */
  pl: number;
  /** Future: perp exit fees. */
  fp: number | null;
  /** Future: perp exit slippage (signed). */
  fs: number | null;
  /** Future: Boros settlement fees to maturity. */
  fb: number;
}

/** v1 share payload. Short keys — this travels in the URL. The USD/APR values
 * are the DISPLAYED numbers (after the terminal's entry/exit cost toggles),
 * frozen at the moment Share was clicked. */
export interface SharePayloadV1 {
  v: 1;
  /** Base asset, e.g. "ETH". */
  b: string;
  /** Snapshot unix sec — when Share was clicked. */
  t: number;
  /** Boros maturity unix sec. */
  m: number;
  /** APR clock start unix sec (position open) — timeline start; null when unknown. */
  cs: number | null;
  /** Fixed APR on capital, fraction, 4dp. */
  a: number;
  /** Capital USD, whole dollars. */
  c: number;
  /** Capital split: the perp legs' initial margin on CrossEx, whole dollars;
   * null when the source didn't carry the split. */
  cp: number | null;
  /** Capital split: the Boros margin apportioned to this position, whole
   * dollars; null when the source didn't carry the split. */
  cb: number | null;
  /** PnL by maturity USD (displayed). */
  p: number;
  /** Locked spread, fraction, 4dp. */
  sp: number;
  /** Hedge status: 'h' hedged | 'p' partial | 'u' unhedged. */
  h: 'h' | 'p' | 'u';
  /** 1 when the perp entry cost was included in the displayed numbers. */
  ce: 0 | 1;
  /** 1 when the perp exit cost was included in the displayed numbers. */
  cx: 0 | 1;
  /** 1 when the position's share of a leg shared with ANOTHER strategy was a
   * proposal (paired by price/open-time proximity) rather than measured from
   * the execution record. Absent = nothing was split, or the split was
   * measured. Optional so links minted before the split existed still
   * decode. */
  uc?: 0 | 1;
  /** The legs, at most 8. */
  l: ShareLegV1[];
  /** Fee breakdown. */
  f: ShareFeesV1;
}

/** Why a decode failed: 'version' = well-formed but a schema this build doesn't
 * know (say "made by a newer terminal"); 'malformed' = everything else. */
export type ShareDecodeResult =
  | { ok: true; payload: SharePayloadV1 }
  | { ok: false; reason: 'malformed' | 'version' };

/** Raw `d` params longer than this are rejected before any decode work.
 * Real 4-leg payloads encode to ~600-900 chars; 4KB leaves headroom while
 * staying far inside nginx's ~8KB request-line ceiling. */
export const MAX_SHARE_PARAM_LENGTH = 4096;

/** Round to `dp` decimal places (encoder-side canonicalization). */
export function roundTo(n: number, dp: number): number {
  const p = Math.pow(10, dp);
  return Math.round(n * p) / p;
}

// --- base64url (hand-rolled: no Buffer, no atob — see header) ---------------

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function bytesToBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 3) << 4) | (b1 >> 4)];
    if (i + 1 < bytes.length) out += B64_ALPHABET[((b1 & 15) << 2) | (b2 >> 6)];
    if (i + 2 < bytes.length) out += B64_ALPHABET[b2 & 63];
  }
  return out;
}

function base64UrlToBytes(s: string): Uint8Array | null {
  if (s.length % 4 === 1) return null; // no valid base64 stream has this shape
  const idx = new Array<number>(s.length);
  for (let i = 0; i < s.length; i++) {
    const v = B64_ALPHABET.indexOf(s[i]);
    if (v < 0) return null;
    idx[i] = v;
  }
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0;
  for (let i = 0; i + 1 < s.length; i += 4) {
    const v0 = idx[i];
    const v1 = idx[i + 1];
    const v2 = i + 2 < s.length ? idx[i + 2] : 0;
    const v3 = i + 3 < s.length ? idx[i + 3] : 0;
    out[o++] = (v0 << 2) | (v1 >> 4);
    if (i + 2 < s.length) out[o++] = ((v1 & 15) << 4) | (v2 >> 2);
    if (i + 3 < s.length) out[o++] = ((v2 & 3) << 6) | v3;
  }
  return out;
}

// --- validation (reject, never sanitize) ------------------------------------

const BASE_RE = /^[A-Z0-9]{1,12}$/;
const VENUE_RE = /^[A-Z0-9_]{1,20}$/;
const UNIX_SEC_MIN = 1e9; // 2001 — anything earlier is garbage, not a maturity
const UNIX_SEC_MAX = 4e9; // 2096

const isNum = (x: unknown, min: number, max: number): x is number =>
  typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max;
const isUnixSec = (x: unknown): x is number =>
  typeof x === 'number' && Number.isInteger(x) && x >= UNIX_SEC_MIN && x <= UNIX_SEC_MAX;
const hasExactKeys = (o: object, required: string[], optional: string[] = []): boolean =>
  Object.keys(o).every((k) => required.includes(k) || optional.includes(k)) &&
  required.every((k) => k in o);

function isShareLegV1(x: unknown): x is ShareLegV1 {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  if (!hasExactKeys(x, ['k', 'x', 's', 'n'], ['r', 'tn', 'ts'])) return false;
  const l = x as Record<string, unknown>;
  return (
    (l.k === 'b' || l.k === 'p') &&
    typeof l.x === 'string' &&
    VENUE_RE.test(l.x) &&
    (l.s === 'L' || l.s === 'S') &&
    isNum(l.n, 0, 1e10) &&
    (!('r' in l) || isNum(l.r, -100, 100)) &&
    // tn/ts travel as a pair or not at all — a qty without its token (or the
    // reverse) has no meaning and only a crafted link would carry one.
    ('tn' in l) === ('ts' in l) &&
    (!('tn' in l) || isNum(l.tn, 0, 1e12)) &&
    (!('ts' in l) || (typeof l.ts === 'string' && BASE_RE.test(l.ts)))
  );
}

function isShareFeesV1(x: unknown): x is ShareFeesV1 {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  if (!hasExactKeys(x, ['pp', 'ps', 'pb', 'pl', 'fp', 'fs', 'fb'])) return false;
  const f = x as Record<string, unknown>;
  const usd = (v: unknown) => isNum(v, -1e9, 1e9);
  const usdOrNull = (v: unknown) => v === null || isNum(v, -1e9, 1e9);
  return usd(f.pp) && usdOrNull(f.ps) && usd(f.pb) && usd(f.pl) && usdOrNull(f.fp) && usdOrNull(f.fs) && usd(f.fb);
}

/** Strict v1 shape guard. Unknown keys anywhere → false: the wire format has
 * no free-text and no extension point, so anything extra is hostile or wrong. */
export function isSharePayloadV1(x: unknown): x is SharePayloadV1 {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  if (
    !hasExactKeys(
      x,
      ['v', 'b', 't', 'm', 'cs', 'a', 'c', 'cp', 'cb', 'p', 'sp', 'h', 'ce', 'cx', 'l', 'f'],
      ['uc'],
    )
  )
    return false;
  const p = x as Record<string, unknown>;
  return (
    p.v === 1 &&
    typeof p.b === 'string' &&
    BASE_RE.test(p.b) &&
    isUnixSec(p.t) &&
    isUnixSec(p.m) &&
    (p.cs === null || (isUnixSec(p.cs) && p.cs <= p.m)) &&
    isNum(p.a, -100, 100) &&
    isNum(p.c, 0, 1e9) &&
    (p.cp === null || isNum(p.cp, 0, 1e9)) &&
    (p.cb === null || isNum(p.cb, 0, 1e9)) &&
    isNum(p.p, -1e9, 1e9) &&
    isNum(p.sp, -100, 100) &&
    (p.h === 'h' || p.h === 'p' || p.h === 'u') &&
    (p.ce === 0 || p.ce === 1) &&
    (p.cx === 0 || p.cx === 1) &&
    (!('uc' in p) || p.uc === 0 || p.uc === 1) &&
    Array.isArray(p.l) &&
    p.l.length >= 1 &&
    p.l.length <= 8 &&
    p.l.every(isShareLegV1) &&
    isShareFeesV1(p.f)
  );
}

// --- encode / decode --------------------------------------------------------

/** Canonicalize (rounding + explicit key order — deterministic bytes for equal
 * inputs) and encode. Throws on a payload that fails the schema guard: the
 * builder feeding this is trusted code, so that's a programmer error. */
export function encodeSharePayload(p: SharePayloadV1): string {
  const canonical: SharePayloadV1 = {
    v: 1,
    b: p.b,
    t: Math.round(p.t),
    m: Math.round(p.m),
    cs: p.cs === null ? null : Math.round(p.cs),
    a: roundTo(p.a, 4),
    c: Math.round(p.c),
    cp: p.cp === null ? null : Math.round(p.cp),
    cb: p.cb === null ? null : Math.round(p.cb),
    p: Math.round(p.p),
    sp: roundTo(p.sp, 4),
    h: p.h,
    ce: p.ce,
    cx: p.cx,
    // Omitted when false so an unsplit position encodes byte-identically to
    // the links this build's predecessors minted.
    ...(p.uc ? { uc: 1 as const } : {}),
    l: p.l.map((leg) => {
      const out: ShareLegV1 = { k: leg.k, x: leg.x, s: leg.s, n: Math.round(leg.n) };
      if (leg.r !== undefined) out.r = roundTo(leg.r, 4);
      if (leg.tn !== undefined && leg.ts !== undefined) {
        out.tn = roundTo(leg.tn, 6);
        out.ts = leg.ts;
      }
      return out;
    }),
    f: {
      pp: roundTo(p.f.pp, 2),
      ps: p.f.ps === null ? null : roundTo(p.f.ps, 2),
      pb: roundTo(p.f.pb, 2),
      pl: roundTo(p.f.pl, 2),
      fp: p.f.fp === null ? null : roundTo(p.f.fp, 2),
      fs: p.f.fs === null ? null : roundTo(p.f.fs, 2),
      fb: roundTo(p.f.fb, 2),
    },
  };
  if (!isSharePayloadV1(canonical)) throw new Error('share codec: payload fails the v1 schema');
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(canonical)));
}

/** Decode a raw `?d=` value. Never throws — every failure collapses to a
 * ShareDecodeResult so the server route and the public page each render their
 * generic fallback without a try/catch of their own. */
export function decodeSharePayload(raw: unknown): ShareDecodeResult {
  const malformed = { ok: false, reason: 'malformed' } as const;
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_SHARE_PARAM_LENGTH)
    return malformed;
  const bytes = base64UrlToBytes(raw);
  if (bytes === null) return malformed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return malformed;
  }
  if (isSharePayloadV1(parsed)) return { ok: true, payload: parsed };
  // Well-formed object claiming a schema we don't know → let the UI say
  // "made by a newer terminal" instead of "broken link".
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    typeof (parsed as Record<string, unknown>).v === 'number' &&
    (parsed as Record<string, unknown>).v !== 1
  )
    return { ok: false, reason: 'version' };
  return malformed;
}
