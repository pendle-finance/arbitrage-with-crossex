import { describe, expect, it } from 'vitest';
import { readUpdateLog, UPDATE_PHASES } from './updateProgress';

/** install.sh colours every step it announces; a redirected log keeps them. */
const say = (m: string) => `\x1b[1;36m==>\x1b[0m ${m}`;
const phase = (key: string) => UPDATE_PHASES.findIndex((p) => p.key === key);

describe('readUpdateLog', () => {
  it('reports the last step the installer named', () => {
    const s = readUpdateLog(
      [say('Downloading the app…'), say('Installing dependencies…')].join('\n'),
    );
    expect(s.step).toBe('Installing dependencies…');
    expect(s.phase).toBe(phase('deps'));
    expect(s.done).toBe(false);
    expect(s.failed).toBe(false);
  });

  it('holds the furthest phase when a step is skipped or a note follows it', () => {
    // "already installed" skips a step, and the last line here is a heading
    // that matches no phase at all. Neither may walk the checklist backwards.
    const s = readUpdateLog(
      [
        say('Node.js v24.19.0 already installed — skipping.'),
        say('Building the web interface…'),
        say('Installing CrossEx-Boros Terminal into /Users/x/.boros-crossex'),
      ].join('\n'),
    );
    expect(s.phase).toBe(phase('build'));
  });

  it('knows a finished install from a rolled-back one', () => {
    expect(readUpdateLog(say('Done! Opening http://localhost:6688 …')).done).toBe(true);
    expect(
      readUpdateLog('      the previous version is running again at http://localhost:6688').failed,
    ).toBe(true);
  });

  it('strips the colour codes it was handed', () => {
    expect(readUpdateLog(say('Build…')).plain).toBe('==> Build…');
  });
});
