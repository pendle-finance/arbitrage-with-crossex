import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The share codec is deliberately duplicated — src/core/share/codec.ts (server)
// and web/src/lib/shareCodec.ts (browser) — because the repo forbids cross-tree
// imports. A validator tightened in one copy but not the other is exactly the
// bug class a wire format can't afford, so the copies are pinned byte-for-byte.

const CANONICAL = fileURLToPath(new URL('../../src/core/share/codec.ts', import.meta.url));
const MIRROR = fileURLToPath(new URL('../../web/src/lib/shareCodec.ts', import.meta.url));

describe('share codec mirror', () => {
  it('web/src/lib/shareCodec.ts is byte-identical to src/core/share/codec.ts', () => {
    const canonical = readFileSync(CANONICAL, 'utf8');
    const mirror = readFileSync(MIRROR, 'utf8');
    expect(
      mirror,
      'The two share-codec copies have drifted. Edit src/core/share/codec.ts, then ' +
        '`cp src/core/share/codec.ts web/src/lib/shareCodec.ts` so both trees ship the same bytes.',
    ).toBe(canonical);
  });
});
