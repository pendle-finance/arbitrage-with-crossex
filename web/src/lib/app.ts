/** App-level constants: where this tool lives and how it is installed.
 *
 * Was `lib/landing.ts`, when one codebase built both the terminal and the
 * public site. The site now lives in its own repo (arbitrage-landing), so all
 * that survives here is what the TERMINAL itself needs: the repo it updates
 * from, and the install commands the update prompt shows.
 */
export const REPO_URL = 'https://github.com/pendle-finance/arbitrage-with-crossex';

/** Verbatim from README "Install (macOS)" — the one command a user runs. */
export const INSTALL_CMD =
  '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/pendle-finance/arbitrage-with-crossex/main/install.sh)"';

/** Verbatim from README "Install (Windows)". Windows 10/11 with the built-in
 * Windows PowerShell 5 — the user installs nothing first. */
export const INSTALL_CMD_WINDOWS =
  'irm https://raw.githubusercontent.com/pendle-finance/arbitrage-with-crossex/main/install.ps1 | iex';

export const LOCAL_APP_URL = 'http://localhost:6688';
