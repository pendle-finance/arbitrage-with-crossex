import { describe, expect, it } from 'vitest';
import {
  MAX_SHARE_PARAM_LENGTH,
  decodeSharePayload,
  encodeSharePayload,
  roundTo,
  type SharePayloadV1,
} from './shareCodec';

// The golden vector below is the CROSS-REPO contract: the decoder that has to
// accept these bytes lives in the arbitrage-landing repo, and no test can span
// the two. Change the fixture or its encoding only in lockstep with that repo's
// web/src/lib/shareCodec.test.ts — a green suite here proves nothing about
// whether shared links still open.

/** Canonical 4-leg fixture. Keep the literal AND its encoding in sync with the
 * arbitrage-landing repo's copy of this suite. */
const fixture: SharePayloadV1 = {
  v: 1,
  b: 'HYPE',
  t: 1754500000,
  m: 1758758400,
  cs: 1751500000,
  a: 0.1781,
  c: 41320,
  cp: 33056,
  cb: 8264,
  p: 282,
  sp: 0.0295,
  h: 'h',
  ce: 1,
  cx: 1,
  l: [
    { k: 'b', x: 'BINANCE', s: 'S', n: 100000, r: 0.0812 },
    { k: 'b', x: 'HYPERLIQUID', s: 'L', n: 100000, r: 0.0517 },
    { k: 'p', x: 'BINANCE', s: 'S', n: 100000 },
    { k: 'p', x: 'HYPERLIQUID', s: 'L', n: 100000 },
  ],
  f: { pp: 42.5, ps: 18.75, pb: 12.3, pl: 5.25, fp: 42.5, fs: 20.1, fb: 9.8 },
};

/** Golden vector: the exact bytes the fixture must encode to, pinned so the
 * wire format can never drift silently (links in the wild must keep decoding). */
const GOLDEN =
  'eyJ2IjoxLCJiIjoiSFlQRSIsInQiOjE3NTQ1MDAwMDAsIm0iOjE3NTg3NTg0MDAsImNzIjoxNzUxNTAwMDAwLCJhIjowLjE3ODEsImMiOjQxMzIwLCJjcCI6MzMwNTYsImNiIjo4MjY0LCJwIjoyODIsInNwIjowLjAyOTUsImgiOiJoIiwiY2UiOjEsImN4IjoxLCJsIjpbeyJrIjoiYiIsIngiOiJCSU5BTkNFIiwicyI6IlMiLCJuIjoxMDAwMDAsInIiOjAuMDgxMn0seyJrIjoiYiIsIngiOiJIWVBFUkxJUVVJRCIsInMiOiJMIiwibiI6MTAwMDAwLCJyIjowLjA1MTd9LHsiayI6InAiLCJ4IjoiQklOQU5DRSIsInMiOiJTIiwibiI6MTAwMDAwfSx7ImsiOiJwIiwieCI6IkhZUEVSTElRVUlEIiwicyI6IkwiLCJuIjoxMDAwMDB9XSwiZiI6eyJwcCI6NDIuNSwicHMiOjE4Ljc1LCJwYiI6MTIuMywicGwiOjUuMjUsImZwIjo0Mi41LCJmcyI6MjAuMSwiZmIiOjkuOH19';

/** base64url-encode an arbitrary string — for crafting hostile payloads. */
const b64url = (s: string): string =>
  btoa(String.fromCharCode(...new TextEncoder().encode(s)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const reEncode = (mutate: (p: Record<string, unknown>) => void): string => {
  const obj = JSON.parse(JSON.stringify(fixture)) as Record<string, unknown>;
  mutate(obj);
  return b64url(JSON.stringify(obj));
};

describe('encodeSharePayload (browser mirror)', () => {
  it('matches the golden vector exactly', () => {
    expect(encodeSharePayload(fixture)).toBe(GOLDEN);
  });

  it('emits only base64url characters', () => {
    expect(encodeSharePayload(fixture)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('keeps a 4-leg payload under 900 chars and a maximal 8-leg one under 2000', () => {
    expect(encodeSharePayload(fixture).length).toBeLessThan(900);
    // Widest wire shape: every optional field present, worst-case widths.
    const big: SharePayloadV1 = {
      ...fixture,
      l: Array.from({ length: 8 }, (_, i) =>
        i % 2
          ? { k: 'p' as const, x: 'HYPERLIQUID', s: 'L' as const, n: 123456789, tn: 999999.123456, ts: 'ABCDEFGHIJKL' }
          : { k: 'b' as const, x: 'HYPERLIQUID', s: 'S' as const, n: 123456789, r: -0.1234, tn: 999999.123456, ts: 'ABCDEFGHIJKL' },
      ),
    };
    expect(encodeSharePayload(big).length).toBeLessThan(2000);
  });

  it('canonicalizes rounding (APR 4dp, USD whole, fees 2dp)', () => {
    const enc = encodeSharePayload({
      ...fixture,
      a: 0.17814999,
      c: 41320.4,
      f: { ...fixture.f, pp: 42.499 },
    });
    const dec = decodeSharePayload(enc);
    expect(dec.ok && dec.payload.a).toBe(0.1781);
    expect(dec.ok && dec.payload.c).toBe(41320);
    expect(dec.ok && dec.payload.f.pp).toBe(42.5);
  });

  it('throws on a payload that fails the schema (programmer error)', () => {
    expect(() =>
      encodeSharePayload({ ...fixture, l: [{ k: 'p', x: 'bad venue!', s: 'L', n: 1 }] }),
    ).toThrow(/schema/);
  });

  it('canonicalizes token sizes (tn 6dp) and round-trips the tn/ts pair', () => {
    const tokenized: SharePayloadV1 = {
      ...fixture,
      l: [{ ...fixture.l[0], tn: 42.1234567, ts: 'HYPE' }, ...fixture.l.slice(1)],
    };
    const dec = decodeSharePayload(encodeSharePayload(tokenized));
    expect(dec.ok && dec.payload.l[0].tn).toBe(42.123457);
    expect(dec.ok && dec.payload.l[0].ts).toBe('HYPE');
    expect(dec.ok && dec.payload.l[1].tn).toBeUndefined();
  });
});

describe('decodeSharePayload (browser mirror)', () => {
  it('round-trips the fixture', () => {
    const dec = decodeSharePayload(encodeSharePayload(fixture));
    expect(dec).toEqual({ ok: true, payload: fixture });
  });

  it('rejects non-strings and empty/oversized input', () => {
    for (const raw of [null, undefined, 42, ['a', 'b'], {}, '', 'x'.repeat(MAX_SHARE_PARAM_LENGTH + 1)])
      expect(decodeSharePayload(raw)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects garbage base64, impossible lengths, bad UTF-8 and non-JSON', () => {
    expect(decodeSharePayload('!!!not-base64!!!')).toEqual({ ok: false, reason: 'malformed' });
    expect(decodeSharePayload('AAAAA')).toEqual({ ok: false, reason: 'malformed' }); // len % 4 === 1
    expect(decodeSharePayload('__4')).toEqual({ ok: false, reason: 'malformed' }); // 0xff 0xfe
    expect(decodeSharePayload(b64url('not json'))).toEqual({ ok: false, reason: 'malformed' });
    expect(decodeSharePayload(b64url('[1,2,3]'))).toEqual({ ok: false, reason: 'malformed' });
    expect(decodeSharePayload(b64url('"hi"'))).toEqual({ ok: false, reason: 'malformed' });
  });

  it("reports 'version' for a well-formed payload from a newer schema", () => {
    expect(decodeSharePayload(b64url('{"v":2,"whatever":true}'))).toEqual({
      ok: false,
      reason: 'version',
    });
    expect(decodeSharePayload(b64url('{"v":"2"}'))).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects unknown keys anywhere (including __proto__) without polluting prototypes', () => {
    expect(decodeSharePayload(reEncode((o) => (o.extra = 1)))).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(
      decodeSharePayload(reEncode((o) => ((o.l as unknown[])[0] = { k: 'p', x: 'GATE', s: 'L', n: 1, z: 1 }))),
    ).toEqual({ ok: false, reason: 'malformed' });
    const json = JSON.stringify(fixture);
    const proto = b64url(`{"__proto__":{"polluted":true},${json.slice(1)}`);
    expect(decodeSharePayload(proto)).toEqual({ ok: false, reason: 'malformed' });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('rejects missing keys and bad field shapes', () => {
    expect(decodeSharePayload(reEncode((o) => delete o.f))).toEqual({ ok: false, reason: 'malformed' });
    expect(decodeSharePayload(reEncode((o) => (o.b = 'lower')))).toEqual({ ok: false, reason: 'malformed' });
    expect(decodeSharePayload(reEncode((o) => (o.b = 'TOOLONGBASE1X')))).toEqual({ ok: false, reason: 'malformed' });
    expect(decodeSharePayload(reEncode((o) => (o.h = 'x')))).toEqual({ ok: false, reason: 'malformed' });
    expect(decodeSharePayload(reEncode((o) => (o.ce = 2)))).toEqual({ ok: false, reason: 'malformed' });
    expect(decodeSharePayload(reEncode((o) => (o.m = 100)))).toEqual({ ok: false, reason: 'malformed' });
    expect(decodeSharePayload(reEncode((o) => (o.cs = 4000000001)))).toEqual({ ok: false, reason: 'malformed' });
    expect(decodeSharePayload(reEncode((o) => (o.a = 1e400)))).toEqual({ ok: false, reason: 'malformed' }); // JSON 1e400 → Infinity
    expect(decodeSharePayload(reEncode((o) => (o.t = 1754500000.5)))).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects a token size without its token, the reverse, and bad token shapes', () => {
    const leg = (o: Record<string, unknown>) => (o.l as Record<string, unknown>[])[0];
    expect(decodeSharePayload(reEncode((o) => (leg(o).tn = 42)))).toEqual({ ok: false, reason: 'malformed' });
    expect(decodeSharePayload(reEncode((o) => (leg(o).ts = 'HYPE')))).toEqual({ ok: false, reason: 'malformed' });
    expect(
      decodeSharePayload(reEncode((o) => Object.assign(leg(o), { tn: 42, ts: 'hype' }))),
    ).toEqual({ ok: false, reason: 'malformed' });
    expect(
      decodeSharePayload(reEncode((o) => Object.assign(leg(o), { tn: -1, ts: 'HYPE' }))),
    ).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects hostile leg strings and out-of-bounds leg counts', () => {
    expect(
      decodeSharePayload(reEncode((o) => ((o.l as { x: string }[])[0].x = '"><script>'))),
    ).toEqual({ ok: false, reason: 'malformed' });
    expect(decodeSharePayload(reEncode((o) => (o.l = [])))).toEqual({ ok: false, reason: 'malformed' });
    expect(
      decodeSharePayload(
        reEncode((o) => (o.l = Array.from({ length: 9 }, () => ({ k: 'p', x: 'GATE', s: 'L', n: 1 })))),
      ),
    ).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('roundTo (browser mirror)', () => {
  it('rounds to the requested decimals', () => {
    expect(roundTo(0.12345, 4)).toBe(0.1235);
    expect(roundTo(-1.005, 2)).toBe(-1);
  });
});

describe('the unconfirmed-split flag (uc) (browser mirror)', () => {
  it('is omitted when false, so an unsplit position encodes exactly as before', () => {
    expect(encodeSharePayload({ ...fixture, uc: 0 })).toBe(GOLDEN);
  });

  it('round-trips when the split was only a proposal', () => {
    const encoded = encodeSharePayload({ ...fixture, uc: 1 });
    const out = decodeSharePayload(encoded);
    expect(out.ok && out.payload.uc).toBe(1);
  });

  it('still decodes a link minted before the flag existed', () => {
    const out = decodeSharePayload(GOLDEN);
    expect(out.ok && out.payload.uc).toBeUndefined();
  });

  it('rejects a value that is neither 0 nor 1', () => {
    expect(decodeSharePayload(reEncode((p) => (p.uc = 2)))).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });
});
