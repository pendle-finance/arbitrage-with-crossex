/**
 * Reading the installer's own output back to the user.
 *
 * `install.sh` and `install.ps1` both print the same banner when a build fails
 * and the old version goes back. That banner is the one thing the dialog has
 * to find in the log, and neither script has to know an app is watching.
 */

/** install.sh colours its `say` output; a redirected log keeps the escapes. */
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

const ROLLED_BACK = /previous version is running again|version that failed is kept/i;

export interface UpdateProgressState {
  failed: boolean;
  /** The log without its colour codes — what "Show log" shows. */
  plain: string;
}

export function readUpdateLog(text: string): UpdateProgressState {
  const plain = text.replace(ANSI, '');
  return { failed: ROLLED_BACK.test(plain), plain };
}
