/** Landing-build constants. IS_LANDING is true only under
 * `vite build --mode landing` (see vite.config.ts define); the terminal build
 * leaves VITE_LANDING unset so every landing branch is inert. */
export const IS_LANDING = import.meta.env.VITE_LANDING === '1';

export const REPO_URL = 'https://github.com/pendle-finance/crossex-boros-terminal';

/** Verbatim from README "Install (macOS)" — the one command a visitor runs. */
export const INSTALL_CMD =
  '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/pendle-finance/crossex-boros-terminal/main/install.sh)"';

/** Verbatim from README "Install (Windows)". Windows 10/11 with the built-in
 * Windows PowerShell 5 — the visitor installs nothing first. */
export const INSTALL_CMD_WINDOWS =
  'irm https://raw.githubusercontent.com/pendle-finance/crossex-boros-terminal/main/install.ps1 | iex';

/** Paste-into-your-own-LLM audit prompt. The whole pitch is "don't trust us,
 * the source is right there" — this hands the visitor a concrete way to act on
 * that before any key exists. Questions are the ones that actually matter for a
 * tool that holds exchange keys, and it asks for citations so the answer can be
 * checked rather than believed.
 *
 * The URL here must match REPO_URL above: this prompt renders one FAQ row below
 * a link built from it, and two different repo URLs for the same project is
 * exactly the doubt the prompt exists to remove. */
export const AUDIT_PROMPT = `Audit this open-source tool for me before I run it:
https://github.com/pendle-finance/crossex-boros-terminal

It runs on my own machine and will hold my Gate exchange API keys. Read the real
source, then answer:

1. Can it send my API keys, or any other secret, anywhere off my machine?
2. Can it withdraw funds, or place any trade I have not explicitly confirmed?
3. What do install.sh (macOS) and install.ps1 (Windows) change on my system, and
   how do I remove all of it later?
4. Anything else I should know before trusting it with exchange API keys?

Cite the files and line numbers behind each answer, and tell me plainly if
anything looks wrong or unsafe.`;

export const LOCAL_APP_URL = 'http://localhost:6688';
