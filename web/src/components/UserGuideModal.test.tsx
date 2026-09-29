/** Links in the remotely-fetched guide: only web links and in-page anchors go
 * through as written; any other scheme falls back to the guide itself. */
import { describe, expect, it } from 'vitest';
import { absolute, USER_GUIDE_HTML_URL } from './UserGuideModal';

describe('absolute', () => {
  it('sends a script or data link to the guide instead', () => {
    expect(absolute('javascript:alert(1)')).toBe(USER_GUIDE_HTML_URL);
    expect(absolute('data:text/html,x')).toBe(USER_GUIDE_HTML_URL);
  });

  it('keeps web links and anchors, and resolves sibling docs on GitHub', () => {
    expect(absolute('https://www.gate.com/crossex')).toBe('https://www.gate.com/crossex');
    expect(absolute('#setup')).toBe('#setup');
    expect(absolute('./DISCLAIMER.md')).toBe(
      'https://github.com/pendle-finance/arbitrage-with-crossex/blob/main/docs/DISCLAIMER.md',
    );
  });
});
