import { describe, expect, it } from 'vitest';
import { readUpdateLog } from './updateProgress';

/** install.sh colours every step it announces; a redirected log keeps them. */
const say = (m: string) => `\x1b[1;36m==>\x1b[0m ${m}`;

describe('readUpdateLog', () => {
  it('knows a rolled-back install from one still running', () => {
    expect(readUpdateLog(say('Building the web interface…')).failed).toBe(false);
    expect(
      readUpdateLog('      the previous version is running again at http://localhost:6688').failed,
    ).toBe(true);
  });

  it('strips the colour codes it was handed', () => {
    expect(readUpdateLog(say('Build…')).plain).toBe('==> Build…');
  });
});
