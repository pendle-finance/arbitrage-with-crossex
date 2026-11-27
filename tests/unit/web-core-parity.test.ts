import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { REPEG_CHOICES_BP, REPEG_DEFAULT_BP, TIMEOUT_MAX_S, TIMEOUT_MIN_S, TIMEOUT_RANGE_TEXT } from '../../src/engine/create';
import { spanText as coreSpanText, TWAP_LIMITS } from '../../src/core/twap';
import i18n from '../../web/src/i18n';
import { localizeServerText } from '../../web/src/i18n/serverMessages';
import { spanText as webSpanText } from '../../web/src/lib/span';
import enPairTicket from '../../web/src/locales/en/pairTicket.json';

const makerSettings = readFileSync(fileURLToPath(new URL('../../web/src/trade/MakerSettings.tsx', import.meta.url)), 'utf8');

function webConst(name: string): unknown {
  const m = new RegExp(`^(?:export )?const ${name} = (.+?)(?: as const)?;$`, 'm').exec(makerSettings);
  if (!m) throw new Error(`MakerSettings.tsx has no const ${name}`);
  return JSON.parse(m[1].replace(/_/g, ''));
}

describe('Maker settings choices match what the server accepts', () => {
  it('offers the same re-peg choices and default', () => {
    expect(webConst('REPEG_BP')).toEqual([...REPEG_CHOICES_BP]);
    expect(webConst('REPEG_DEFAULT_BP')).toBe(REPEG_DEFAULT_BP);
  });

  it('takes the same taker-after range and says it the same way', () => {
    expect(webConst('CUSTOM_MIN_SEC')).toBe(TIMEOUT_MIN_S);
    expect(webConst('CUSTOM_MAX_SEC')).toBe(TIMEOUT_MAX_S);
    const range = `${webSpanText(TIMEOUT_MIN_S)} to ${webSpanText(TIMEOUT_MAX_S)}`;
    expect(enPairTicket.makerSettings.customRange).toBe(range);
    expect(TIMEOUT_RANGE_TEXT).toBe(`Taker after must be ${range}.`);
  });
});

const SPANS = [
  0, 1, 30, 59, 60, 61, 90, 299, 300, 599, 600, 3_599, 3_600, 3_601, 3_660, 3_661, 5_400, 43_200, 86_399, 86_400, 90_061,
  TWAP_LIMITS.minDurationSec,
  TWAP_LIMITS.maxDurationSec,
  TWAP_LIMITS.minIntervalSec,
];

describe('span text is the same in web and core', () => {
  afterAll(() => i18n.changeLanguage('en'));

  it.each(SPANS)('%i seconds', (sec) => {
    expect(webSpanText(sec)).toBe(coreSpanText(sec));
  });

  it.each(SPANS.filter((s) => s > 0))('the Chinese rules read the core text for %i seconds', async (sec) => {
    await i18n.changeLanguage('zh-CN');
    const span = coreSpanText(sec);
    expect(localizeServerText(`Interval at most ${span}.`)).toBe(`间隔最多 ${span}。`);
    expect(localizeServerText(`Use ${span}`)).toBe(`改用 ${span}`);
    expect(localizeServerText(`Use ${span} interval`)).toBe(`改用 ${span} 间隔`);
  });
});
