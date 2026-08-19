## ⚠️ Open-source project by Pendle — experimental, use at your own risk

This is an experimental, open-source trading tool published by Pendle, free of charge and on an **"as is"** basis. It runs entirely on your own machine against **your own exchange accounts and API keys** — no one else holds your funds, keys or orders. It places **real orders with real funds** and can lose money. **Nothing here is financial, investment, legal or tax advice.** Gate.io and the other venues referenced are independent third parties; nothing here implies their affiliation, sponsorship or endorsement.

**➡️ Read the full [DISCLAIMER](./docs/DISCLAIMER.md) before use. By using this software you accept it in full.**

Not available to, or intended for, any person where such use is unlawful (including restricted jurisdictions and sanctioned persons).

---

# CrossEx-Boros Terminal

**Open source tool** · **Experimental, use at your own risks**

A trading terminal for delta-neutral funding-rate arbitrage on Gate's
[CrossEx](https://www.gate.com/docs/developers/crossex/en/) platform: one collateral
pool backing perp positions on multiple venues (BINANCE, BYBIT, GATE, OKX, KRAKEN,
HYPERLIQUID). Go long a perp on one venue and short the same perp on another; the legs
are delta-neutral and you collect the funding spread.

You run it on your own machine — **macOS or Windows**. Your exchange API keys stay on
that machine and are only ever sent, signed, to Gate.io's official API; the app itself
talks to a short, fixed list of hosts (see *Your data & security* below).

---

## Install

<details open>
<summary><b>macOS</b></summary>

Paste this into the **Terminal** app (Finder → Applications → Utilities → Terminal) and
press Return:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/pendle-finance/arbitrage-with-crossex/main/install.sh)"
```

When it finishes (a few minutes the first time), the terminal opens in your browser at
**http://localhost:6688** — bookmark it. From then on the app is always running in the
background, even after you restart your Mac. You'll also find a **"CrossEx-Boros
Terminal"** launcher in your `~/Applications` folder.

Everything lands in one folder: `~/.boros-crossex`.

</details>

<details open>
<summary><b>Windows</b></summary>

Requires **Windows 10 or 11** and PowerShell 5 or newer (the built-in **Windows
PowerShell** is fine — no need to install anything first). Press `Win`, type
`PowerShell`, open it, then paste:

```powershell
irm https://raw.githubusercontent.com/pendle-finance/arbitrage-with-crossex/main/install.ps1 | iex
```

When it finishes, the terminal opens in your browser at **http://localhost:6688** —
bookmark it. The app then starts on its own every time you sign in, and you'll find a
**"CrossEx-Boros Terminal"** shortcut in your Start Menu.

Everything lands in one folder: `%LOCALAPPDATA%\CrossEx-Boros`.

> Do **not** run this from an Administrator prompt — it doesn't need one. If your
> organisation restricts script execution, the one-liner above already runs the installer
> in-process; the background task it registers is a normal per-user Scheduled Task.

</details>

### What that command does (and everything it does)

- Downloads a private copy of [Node.js](https://nodejs.org) (official build, checksum
  verified) and this app into a single folder — `~/.boros-crossex` on macOS,
  `%LOCALAPPDATA%\CrossEx-Boros` on Windows. Nothing else on your system is touched — no
  admin password, no changes to your system setup or PATH.
- Registers a background service that keeps the app running and restarts it after crashes
  and reboots: a standard **LaunchAgent** on macOS, a per-user **Scheduled Task** on
  Windows.
- Opens the app in your browser and creates the launcher (an app in `~/Applications`, or a
  Start Menu shortcut).
- **It never asks for your exchange keys in the terminal** — those are entered later, in
  the app itself.

You can read the install script for your platform — [install.sh](install.sh) (macOS,
~250 lines of commented shell) or [install.ps1](install.ps1) (Windows, commented
PowerShell) — or
better, [have an AI audit the whole repo for you](#verify-this-project-yourself-with-ai)
before running anything.

### First run: connect your Gate.io account

The app starts unconfigured and shows the live opportunities next to a setup guide asking
for a Gate.io API key:

1. Enable the **CrossEx feature** on your account at
   [gate.com/crossex](https://www.gate.com/crossex) — the API-key permission below and
   transfers into the CrossEx account need it switched on first.
2. Log in at [gate.io](https://www.gate.com) → profile icon → **API Management** →
   **Create API Key** (APIv4). When asked which account the key is for, choose
   **Trading account**.
3. Under **Permissions**, tick only **Cross-Exchange** with **Read and Write** — that's
   all it needs. **Leave Withdrawal OFF** (a trading bot never needs to withdraw your
   funds; the app cannot move money off your account without it).
4. Under **IP Permissions**, choose **"Later"** — unless your machine has a consistent
   IP, in which case binding the key to it adds extra protection. Caveat — home IPs
   change from time to time (e.g. after a router restart), and the key stops working
   until you update the binding.
5. Paste the key + secret into the setup guide. The app validates them against Gate with
   a live read-only call before saving; they're stored only in
   `~/.boros-crossex/config/.env` (macOS) or `%LOCALAPPDATA%\CrossEx-Boros\config\.env`
   (Windows), on your own machine.

### Everyday use

- Open **http://localhost:6688** (or the launcher app / Start Menu shortcut) any time —
  the server is already running.
- **Update** to the latest version by re-running the same install command for your
  platform. It stops the previous version first, so an old copy never lingers. Your keys
  and trade history are never touched by updates. When a new version is published, the
  terminal shows an amber **Update** pill in the header with these exact instructions.
- ⚠️ **Leave the machine on while a deal is open.** A trade here is a *deal* — a maker leg
  plus the hedge that neutralises it — and it is the server's reconcile loop that places
  that hedge once the maker leg fills, that requotes, retries, and closes. Gate's CrossEx
  has no dead-man's switch, so **nothing sits on the exchange as a backstop**: no resting
  stop, no server-side unwind. If the machine sleeps or shuts down mid-deal, a half-filled
  deal stays half-filled — one leg live, unhedged, moving with the market — for as long as
  it takes you to bring the server back. Nothing is lost or corrupted: the first tick after
  a restart reads venue truth and picks the deal up exactly where it left off (recovery *is*
  the loop — see [docs/MAKER-HEDGE.md](docs/MAKER-HEDGE.md)). Your exposure in the meantime
  is simply however long the server was down, so close out before a shutdown, or don't start
  a deal you can't leave the machine running for.

### Uninstall

**macOS**

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/pendle-finance/arbitrage-with-crossex/main/uninstall.sh)"
```

Keys and trade history in `~/.boros-crossex` are kept; append ` -- --purge` to remove
those too (or `rm -rf ~/.boros-crossex`).

**Windows**

```powershell
irm https://raw.githubusercontent.com/pendle-finance/arbitrage-with-crossex/main/uninstall.ps1 | iex
```

Keys and trade history in `%LOCALAPPDATA%\CrossEx-Boros` are kept. To remove those too:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/pendle-finance/arbitrage-with-crossex/main/uninstall.ps1))) -Purge
```

Either way this stops and removes the background service, the app, its private Node.js
copy, the launcher, and the logs. If the trading engine is running and cannot be stopped,
the uninstaller removes **nothing** and tells you so — it will not delete the app or the
trade journal out from under a live process that is still placing orders.

## Your data & security

- **Your API keys never leave your machine**, except inside signed requests to Gate.io's
  official API (`api.gateio.ws`) — the same way the exchange's own apps authenticate.
  They are stored in `~/.boros-crossex/config/.env` (macOS) or
  `%LOCALAPPDATA%\CrossEx-Boros\config\.env` (Windows), readable only by your user
  account — enforced with file modes on macOS and an explicit ACL on Windows, and
  re-asserted every time the server starts.
- **The app is not reachable from the network.** The server binds to `127.0.0.1`
  (this-machine-only) and additionally rejects any request whose Host/Origin isn't
  localhost. Nobody on your Wi-Fi can see it.
- **No telemetry, no analytics.** The app's only outbound requests are: `api.gateio.ws`
  (signed, your account and orders); `api.boros.finance` (public market data, keyed only
  by an EVM address you choose to enter); the venues' public order-book endpoints
  (`fapi.binance.com`, `api.bybit.com`, `www.okx.com`, `futures.kraken.com`,
  `api.hyperliquid.xyz`, `api.gateio.ws`) — public data, nothing about you; and
  `raw.githubusercontent.com` — a 6-hourly read of this repo's one-line `version.json`
  to show "update available". Nothing is ever sent, and `UPDATE_CHECK=0` disables it.
  The installer downloads only from `nodejs.org` and `github.com`.
- **Other accounts on your computer can't drive it.** Binding to loopback stops the
  network; it does not stop another local process from simply calling the API. So every
  request that can read your account or trade must carry a random token, created on
  first run and stored — readable only by you — in `~/.boros-crossex/config/api-token`
  (macOS) or `%LOCALAPPDATA%\CrossEx-Boros\config\api-token` (Windows). Your browser
  gets it automatically from the page. The same limit as your keys applies, and it is
  worth saying plainly: **anything running as you can read both.** Scripting the API
  yourself:
  `curl -H "x-arb-token: $(cat ~/.boros-crossex/config/api-token)" http://localhost:6688/api/positions`.
  Rotate it by deleting the file and restarting the app (open tabs then need a reload).
- **It can't withdraw your funds** — and if you created the key as described above,
  Gate.io enforces that at the account level too.

## Install exactly what you audited

The one-line installers above fetch the current tip of `main`. That is the right default
for staying current, but it means the code can change between the moment you (or an AI)
read it and the moment you run it — and again on every update. To close that gap:

**1. Pin a commit.** Clone the repo and note the exact tree you are about to audit:

```bash
git clone https://github.com/pendle-finance/arbitrage-with-crossex
cd arbitrage-with-crossex
git log -1 --format=%H     # ← this commit is what you are auditing
```

**2. Audit that tree** — read it yourself, or use the AI prompt below with the commit
filled in.

**3. Install that exact tree.** Either by ref (note the installer URL is pinned to the
same commit, so the script you run is the one you read):

```bash
REF=<commit-sha>
BOROS_REF=$REF /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/pendle-finance/arbitrage-with-crossex/$REF/install.sh)"
```

```powershell
$env:BOROS_REF = '<commit-sha>'
irm "https://raw.githubusercontent.com/pendle-finance/arbitrage-with-crossex/$($env:BOROS_REF)/install.ps1" | iex
```

…or straight from the clone you just audited, with no second download at all:

```bash
git archive --format=tar.gz -o ../boros.tgz HEAD
BOROS_TARBALL=../boros.tgz bash install.sh
```

**4. Check what you are running, any time.** **Settings → About** shows the version, the
exact commit installed, and when — a source checkout says so instead. The same data is on
`GET /api/version`.

Re-running the plain one-liner takes you back to the tip of `main`; re-pin if you want to
stay on an audited commit.

**What is and isn't verified, honestly.** The Node.js runtime download is SHA-256-checked
against nodejs.org's published manifest. The app archive comes from GitHub over TLS but is
**not signed and carries no separate checksum** — GitHub's generated archives are not
byte-stable, so publishing a hash of one would break spuriously and train you to ignore
the failure. Pinning a commit and auditing that commit is the integrity story. JavaScript
dependencies are locked by the committed `yarn.lock` files and installed with
`--frozen-lockfile`.

## Verify this project yourself with AI

Don't take this README's word for any of the above. Copy the prompt below into an AI
assistant with web access (Claude, ChatGPT, …) and let it audit the project for you —
or, if you use an AI coding tool (Claude Code, Cursor, …), point it at a downloaded copy
of this repo for an even deeper read.

```text
I'm considering installing an open-source crypto trading tool on my Mac, and I want you
to audit it before I run anything.

Repository:  https://github.com/pendle-finance/arbitrage-with-crossex
Commit to audit:  <paste the commit SHA you pinned — or "main" for the current tip>
Source tree at that commit:  https://github.com/pendle-finance/arbitrage-with-crossex/tree/<commit>
Installer I would run:  https://raw.githubusercontent.com/pendle-finance/arbitrage-with-crossex/<commit>/install.sh
Uninstaller:  https://raw.githubusercontent.com/pendle-finance/arbitrage-with-crossex/<commit>/uninstall.sh

Please read the installer, the uninstaller, and the application source code, then answer:

1. Does the installer ever ask for admin rights or use sudo? Does it write anywhere
   outside ~/.boros-crossex, ~/Library/LaunchAgents, ~/Library/Logs, and ~/Applications
   (macOS), or outside %LOCALAPPDATA%\CrossEx-Boros and the Start Menu (Windows)?
2. What exactly does it download, from which domains, and how is each download
   verified? The README claims: Node.js is SHA-256-verified against nodejs.org's
   manifest; the app archive comes from github.com over TLS with no signature or
   checksum of its own (pinning a commit with BOROS_REF and auditing that commit is
   the integrity story); npm dependencies are pinned by committed lockfiles installed
   with --frozen-lockfile. Verify each claim and flag anything that contradicts it.
3. What background service does it install, and what are the exact commands to remove
   everything it added?
4. Where are my exchange API keys stored, and do they ever leave my machine other than
   in signed requests to Gate.io's official API (api.gateio.ws)?
5. Is there any telemetry, analytics, or other "phoning home" in the app or installer?
   The README claims the only outbound hosts are Gate.io, public Boros/venue market-data
   APIs, and a version check against raw.githubusercontent.com — verify that list is
   complete.
6. Is the app's web server reachable from other devices on my network, or only from my
   own machine?
7. Could this app withdraw funds from my exchange account? Which API permissions does it
   actually need to function?
8. Any other red flags: obfuscated code, suspicious dependencies or postinstall scripts,
   or anything inconsistent with the claims in the project README?

Finish with a clear verdict: is it safe for me to paste the install command into my
terminal, and what residual risks remain?
```

## ⚠️ Disclaimer

**Experimental, use at your own risks.** This is experimental software that places real
orders with real money on your exchange account. Bugs, venue outages, thin order books,
or funding-rate reversals can lose money. Nothing here is financial advice, and the
software comes with no warranty of any kind (see [LICENSE](LICENSE)). Start with small
notionals and check your positions on the exchange directly.

## Troubleshooting

- **The page won't load** — the service may still be starting; wait a few seconds and
  reload. Check its status with
  `launchctl print gui/$(id -u)/com.boros.crossex-terminal | grep -E "state|pid"`
  and the logs at `~/Library/Logs/boros-crossex/server.err.log`.
- **"Port 6688 is already in use" during install** — another program is using that port.
  Find it with `lsof -nP -iTCP:6688 -sTCP:LISTEN`, quit it, and re-run the installer (or
  install on a different port: `BOROS_PORT=7788 /bin/bash -c "$(curl -fsSL …/install.sh)"`).
- **You toggled the app off under System Settings → Login Items** — re-run the install
  command to re-enable it.
- **Restart the service manually** —
  `launchctl kickstart -k gui/$(id -u)/com.boros.crossex-terminal`.

---

# Developer documentation

Everything below is for people working on the code. The app is a TypeScript monorepo:
a framework-free core library, a Fastify server, and a React SPA — built on
the **official `gate-api` Node SDK** (v7.2+, which ships a native `CrossExApi`).

## Setup

Package manager: **Yarn** (Classic 1.x). Node ≥ 20 (tested on 22 and 24; `.nvmrc` says 22).

```bash
yarn install              # server deps
yarn --cwd web install    # web SPA deps (separate package, no workspaces)
```

Create `.env` in the project root (copy `.env.example`) with API-v4 keys that have
**CrossEx trade permission** — or just start the server and enter them in the web UI:

```
GATE_API_KEY=...
GATE_API_SECRET=...
```

Scripts run with `tsx` (no build step). If `node`/`yarn` aren't on your PATH, this repo was
tested with nvm Node v22 — `nvm use 22` first.

Install-time env vars (all optional): `BOROS_REF` (install an exact commit, tag or
branch — see *Install exactly what you audited*), `BOROS_TARBALL`/`BOROS_ZIP` (install
from a local archive), `BOROS_PORT`, `BOROS_ROOT`, `BOROS_REPO`, `BOROS_BRANCH`.

Deployment-relevant env vars (all optional): `UPDATE_CHECK` (set `0` to disable the
GitHub version check), `PORT` (default 6688), `ARB_DATA_DIR`
(trade-journal dir; default `<repo>/data`), `DOTENV_CONFIG_PATH` (where credentials are
read from and saved to; default `<repo>/.env`). The macOS installer sets all three so
user data lives outside the auto-updated app directory.

## Web terminal — `yarn dev` / `yarn start`

A local web app ("CrossEx-Boros Terminal") wraps the same core with a monitoring dashboard and a
safety-gated trading UI:

```bash
yarn dev      # Fastify API (127.0.0.1:6688) + Vite dev server with /api proxy (:8711)
yarn start    # build the SPA once, serve everything from http://localhost:6688
```

- **Monitoring**: account margin strip, per-coin balances, positions with an **arb-exposure
  view grouped by coin** (neutral ✓ / imbalanced / single leg), recent trades with the **fee
  paid per fill** (maker/taker, bps), open orders with cancel, per-venue fee rates.
- **Trading**: order ticket (market with **tentative average fill price** walked from
  per-venue public orderbooks + estimated fees; limit with tick snapping and post-only),
  **pair ticket** (one notional → one shared qty across both legs), a **basket** of mixed
  actions executed concurrently, and a review modal (previews auto-refresh; confirm is
  hold-to-press and disabled when previews go stale). Executions run server-side, survive a
  closed tab, and re-check closes for remnants.
- **Safety**: pair legs are linked, and if exactly one leg fills you get a red **UNHEDGED**
  banner with one-click remediation (complete the missing leg / unwind the filled one) —
  the web version of `pair.ts`'s guard. Order state strings from Gate are undocumented, so
  unknown states render verbatim and a server-side reconciler keeps re-checking.
- **Credentials**: the server boots fine with no keys and shows the first-run setup guide;
  set/replace the Gate API key from Settings — validated against a live
  `getCrossexAccount` call before `.env` is rewritten and the client hot-swapped. The
  server binds to loopback only and rejects non-localhost Host/Origin headers.

## Testing

```bash
yarn test        # unit + server suites (offline — nock blocks all real HTTP)
yarn test:web    # frontend component tests (jsdom + msw)
yarn verify      # typecheck + all of the above ("check" is shadowed by a yarn builtin)
```

**Live trade suite** (places REAL ~$20 orders on your REAL account; run only deliberately):

```bash
LIVE_TRADE_ACK="I understand real orders will be placed with real money" yarn test:live
yarn live:cleanup   # standalone cleanup if a run dies (only touches attributable test orders)
```

Interlocks: the env flag + the literal ack sentence + a hard $100/order ceiling in code +
a preflight that refuses to run if the test symbols carry ANY existing position/order +
a cumulative run budget. Every order is tagged `lt<runId>_…` so cleanup is precise; a
markdown run report (orders, fees actually paid, order-state strings observed) is written
even on failure.

## Symbol format

`{EXCHANGE}_{BUSINESS}_{BASE}_{QUOTE}` — perps are `business_type = FUTURE`, e.g.
`BINANCE_FUTURE_BTC_USDT`, `OKX_FUTURE_ETH_USDT`. List all tradable contracts:

```bash
curl -s "https://api.gateio.ws/api/v4/crossex/rule/symbols" | jq '.[] | select(.business_type=="FUTURE" and .state=="live") | .symbol' | head
```

## How it works / internals

- `src/core/` — framework-free domain library shared by the server, the live suite, and tests:
  - `clients.ts` — `.env` → authenticated `ApiClient` + typed `CrossExApi`/`SpotApi`/`FuturesApi`
    (HMAC-SHA512 signing via the SDK); `makeClients(creds?)` supports credential hot-swap;
    `makeClientsIfConfigured()` lets the server boot with no keys (first-run setup).
  - `orders.ts` — `buildOrder`, `fetchPerpRule`, `resolveReferencePrice` (with BASE_USDT
    quote-proxy fallback for USD/USDC symbols), `resolveQty`, `marketableClosePrice`,
    leverage helpers, `fetchOrderFill`.
  - `numbers.ts` — `roundToStep` (float-safe), `formatLimitPrice` (tick + Hyperliquid 5-sig-fig
    cap), `parseSymbol`, formatting.
  - `positions.ts` — `computeExposure`: the neutrality view, grouped **by base coin** so
    USDT/USDC-quoted legs of one hedge read as one group.
  - `actions.ts` — the canonical action/basket contract + `resolveActions` (validation as
    structured violations; shared pair sizing; execute mode never re-sizes).
  - `../engine/` — THE execution engine (see `docs/MAKER-HEDGE.md`): every trade is a *deal* (maker+hedge
    pair, both-market pair, single open, reduce-only close) converged by one single-writer
    reconcile loop over a SQLite system of record — write-ahead order reservations, deterministic
    client ids, three-way wire-outcome classification, freeze-while-in-doubt; recovery IS the
    loop. Verified by a deterministic simulation harness (seeded adversarial episodes asserting
    never-over-hedge / never-over-acquire against venue truth).
  - `estimate/` — per-venue public orderbook fetchers, VWAP fill estimator (labeled
    source/confidence fallback chain), fee estimation with special-fee overrides.
  - `preview.ts` — `resolveActions` + estimates = `POST /api/preview`.
- `src/server/` — Fastify app: TTL cache with request coalescing + 429 stale-serve, localhost
  Host/Origin guard, `/api/deals` routes (thin intent writers — the loop owns every venue
  mutation), routes.
- `web/` — React 18 + Vite + Tailwind + react-query SPA (standalone package).
- `install.sh` / `uninstall.sh` — the macOS one-command installer (private Node runtime in
  `~/.boros-crossex`, LaunchAgent `com.boros.crossex-terminal`, user data outside the app dir).
- `tests/` — see Testing above.

## Caveats & next steps

- **No funding-rate endpoint in CrossEx.** The arb *signal* (which pair to open) must come
  from each venue's funding data — e.g. Gate futures `GET /futures/usdt/tickers` exposes
  `funding_rate`. A `funding.ts` scanner is the natural next script (not built yet).
- **Reference price for sizing** uses Gate's public spot/futures price, not the exact
  remote-venue fill price. Cross-venue prices differ only a few bps; for tight sizing pass
  `--price`. Qty is always floored to lot size, so the real notional is ≤ your target.
- **Real funds.** Start with `--dry-run` and a tiny `--notional`; the confirmation prompt is
  on by default. Margin rates show `n/a` when there are no open positions.

## The public site

The marketing page and the shared-position page (`/position?d=…`) live in a
separate repo — **[pendle-finance/arbitrage-landing](https://github.com/pendle-finance/arbitrage-landing)**
— deployed at <https://boros.pendle.finance/arbitrage-crossex>. It is read-only
and holds no credentials. This repo builds only the local terminal.

## License

[MIT](LICENSE) — free to use, modify, and share. Provided **as is**, with no warranty.
