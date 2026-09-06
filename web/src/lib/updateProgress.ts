/**
 * Reading the installer's own output back to the user.
 *
 * `install.sh` and `install.ps1` both announce each step they start as
 * `==> <message>`, and both print the same banner when a build fails and the
 * old version goes back. That is enough to drive a progress panel without
 * either script having to know an app is watching.
 *
 * The match list is deliberately loose. A message that drifts costs the panel
 * one tick of its checklist — the step line, the elapsed clock and the log are
 * all still right — where a strict parser would show a stalled update instead.
 */

/** install.sh colours its `say` output; a redirected log keeps the escapes. */
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

export const UPDATE_PHASES = [
  { key: 'runtime', label: 'Runtime', match: /Node\.js|yarn package manager/i },
  { key: 'fetch', label: 'Download', match: /Downloading the app/i },
  { key: 'deps', label: 'Dependencies', match: /Installing dependencies/i },
  { key: 'build', label: 'Build', match: /Building the web interface/i },
  {
    key: 'restart',
    label: 'Restart',
    match: /Stopping (the previous version|any running instance)|Registering the background service|Waiting for the app to start/i,
  },
] as const;

const DONE = /^Done!/i;
const ROLLED_BACK = /previous version is running again|version that failed is kept/i;

export interface UpdateProgressState {
  /** The last step the installer named, verbatim. */
  step: string | null;
  /** Index into UPDATE_PHASES; -1 before anything is recognised. */
  phase: number;
  done: boolean;
  failed: boolean;
  /** The log without its colour codes — what "Show log" shows. */
  plain: string;
}

export function readUpdateLog(text: string): UpdateProgressState {
  const plain = text.replace(ANSI, '');
  const steps = plain
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('==>'))
    .map((l) => l.slice(3).trim());

  // The FURTHEST phase reached, not the phase of the last line. A step can be
  // skipped ("Node.js already installed"), and the installer prints notes
  // between steps — either would walk the checklist backwards.
  let phase = -1;
  for (const s of steps) {
    const i = UPDATE_PHASES.findIndex((p) => p.match.test(s));
    if (i > phase) phase = i;
  }

  return {
    step: steps.length > 0 ? (steps[steps.length - 1] ?? null) : null,
    phase,
    done: steps.some((s) => DONE.test(s)),
    failed: ROLLED_BACK.test(plain),
    plain,
  };
}
