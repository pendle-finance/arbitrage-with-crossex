# Changelog

Only substantial releases are listed here — each one bumps `version.json` (which is what the
in-app update check compares against).

## 1.5.0 — 2026-08-27

An update button that updates, gas you never have to think about, and messages that say what
to do instead of naming a flag.

- **The update button in the pop-up now installs the update.** It was a pair of commands to copy
  into a terminal. Press it and the app downloads the new version, installs it, restarts, and the
  page reloads itself onto the copy that is now serving. It refuses while a deal is working or a
  Boros order may still be settling, and says which. A "Read the code changes →" link opens the
  exact GitHub comparison between the version you are running and the one that will install — and
  it installs *that* commit, not whatever `main` holds by the time the download starts.
- **The update pop-up shows what the installer is doing.** It used to say the install takes a few
  minutes and then show the same screen for those minutes, which is indistinguishable from a stuck
  update. It now names the step the installer is on, ticks off the five steps it goes through, and
  runs a clock. An update that fails and rolls back says so, with the installer's own output to
  read. The dialog asks one question first — let the app do it, or copy the command and run it
  yourself — and puts a single button under the answer.
- **⚠ Windows users must re-run the install command once.** Every Windows install so far reported
  itself as a source checkout, so the button refused it. The fix cannot install itself: run the
  install command from the pop-up one more time, and every update after this one is a button
  press. macOS installs pick this up automatically.
- **An order now pays for its own gas.** Boros bills each action to a prepaid pot, separate from
  your trading collateral, and an empty pot used to stop every order with nothing to click. An
  order now tops the pot up inside the same transaction, so there is no wait and nothing to press.
  A healthy balance shows nothing at all; a low one gets one amber line naming the amount. Closing
  a position is never charged for gas it can already afford.
- **A too-small order says what it needs, in words.** A pair that could not be sized told a browser
  user to "increase --notional", a flag no browser has, and never said which venue was the
  problem. Every one of those messages is rewritten and names the leg at fault: *this size is worth
  2.49, below BINANCE_FUTURE_ETH_USDT's minimum order value of 20 — increase it*. A Boros leg worth
  ten dollars or less is now caught while you type the size, instead of failing after you confirm.
- **Profit is counted from the day the position opened.** A position's Fixed APY spread the whole
  term's income over the days remaining rather than the days held, which overstated the headline
  and the ROI beside it. The locked spread beside it now opens a breakdown — one row per Boros
  leg with its rate, its size, the window it accrues over and what it is worth by maturity — and a
  leg with no known open date is marked rather than quietly guessed.
- **An update that installs but will not start puts the previous version back.** Both installers
  keep the old copy, and restore it if the new one does not answer. A machine can no longer be left
  with no server at all.
- **Amount boxes keep one precision rule.** Ten editable quantity fields rounded differently; they
  now agree. A value that is not a number leaves the box empty instead of writing `NaN`.
- **Security.** The local API's token check compared an address in a way that a crafted request
  could sidestep. Closed, along with two dead ends the first pass at the gas fix introduced.

## 1.4.1 — 2026-08-26

Closing a position stops asking for margin it does not need.

- **A close is never blocked by margin.** Closing was refused when available margin had gone
  negative — the one state where closing matters most. An order that only reduces an open position
  is now charged for the part that actually opens, if any, and nothing more.
- **The ticket's margin figure agrees with what it lets you do.** It quoted the full requirement
  while the gate charged the incremental one, so the number on screen and the button's behaviour
  disagreed.

## 1.4.0 — 2026-08-25

Boros legs from inside the app, a two-step pair wizard, and hand-grouped positions.

- **Open and close Boros legs directly in the app**, without a detour to the Boros front end. Both
  legs of a pair go out as one atomic batch: neither trades unless both are accepted.
- **A four-leg arb goes up in two steps** — pick the pair, confirm the size, and the legs are
  placed for you.
- **Positions pair their legs instead of pooling them by coin.** When automatic grouping cannot
  tell shared legs apart, group a composite position by hand and the app keeps your split; it also
  forgets closed legs, holds one maturity, and stops a close crossing past flat.
- **Share links are far shorter** — the same snapshot, in a URL that survives a paste into X or
  Telegram. The tracked address travels with the mint, raw and out of the link.
- **Opportunities lists every viable pair** behind a compact facet bar, with the tenor filter
  flipped to a floor and the card unpacked.
- **Position tracking and cost settings are streamlined into one place**, so what you paid and what
  you hold read together.
- **The app is renamed Arbitrage with CrossEx**, and re-homed as a Pendle open-source project.

## 1.3.0 — 2026-08-07

Share a position, explain a stopped deal, and a Windows service that stays hidden.

- **A fully hedged 4-leg position box grows a "Share ↗" button.** It renders a PNG card — "I'm
  getting X% fixed APR on $Y capital" plus the four legs — and offers the link, the PNG, and an X
  post pre-filled with the link. The numbers are frozen as you saw them, cost toggles included.
- **The link is a page that explains the trade.** `boros.pendle.finance/arbitrage-crossex/position` draws how the four
  legs hedge, the PnL waterfall and the capital split, with collapsible explainers, a roll-over /
  close-perps toggle that re-derives every number, and a "self-reported, not verified" disclaimer.
- **The whole snapshot travels in the URL.** The public page stores nothing — no database, no new
  API route. The payload is strictly validated and copied field by field, with no free-text field
  at all: your wallet address and the card's warnings have no path into a link, and leg sizes and
  the open time are rounded so a share can't be joined against a public Boros fill.
- **A deal that gives up on a crossing limit now says why.** After five post-only rejects — the
  limit price was through the market, so the order could never rest — the report used to read a
  bare "stopped". It now names the cause and points you back to the order form for a fresh price.
- **The live deal graph shows what the hedge will pay.** While Leg A rests, the Leg B column draws
  the market order the deal fires, sized to everything still unhedged and refreshed as it runs. A
  simulation off the venue book, not a promised fill.
- **The Windows background service no longer pops up a terminal window at logon** — and closing
  that window used to kill the supervisor that restarts the server. Existing installs pick the fix
  up by re-running the install command. It came in as a pull request from HubertHalim — thank you.
- **Smaller things.** The Gate API-key steps name Gate's actual fields (Trading account, IP
  Permissions "Later", Cross-Exchange with Read and Write); the README says why to leave the
  machine on while a deal is open; modals open centred instead of clipped inside the header; and
  CI now builds the public bundle too, guarding it against credential and trading-UI leakage.

## 1.2.0 — 2026-08-04

Cost modelling, order handling, and dashboard legibility.

- **The perp entry cost is itemised.** A new "Perp entry cost" assumption joins the exit one
  (now labelled Include / Omit (rolling over)), the cost breaks down per execution so a book
  built across several deals can drop the ones a position never paid, and entry slippage
  follows the deal journal even when a book was rebuilt along the way.
- **Single orders behave like single orders.** A lone limit order is placed as a plain order
  rather than a deal to supervise, its "order placed" receipt sticks, cancelling shows as
  pending instead of the order silently vanishing, and a deal frozen on a venue status the
  decoder cannot read can be unwedged. A pasted amount that isn't a number now says why.
- **Token-margined markets show notionals in token terms.** For Boros markets not margined in
  USDT, every leg's notional in the Opportunities and Positions boxes carries the token amount
  in brackets — Boros legs in their collateral token, perp position legs as their base-coin
  size. USDT-margined markets are unchanged.
- **The opportunity details link out.** Each Boros leg opens its market on Boros with the
  side prefilled.
- **"Enable CrossEx" is its own onboarding step**, before the API key and the funds.
- **Flat folder tabs.** The tab bar was machined down — colour is a signal, not decoration.
- **Install and dev hardening.** `install.sh` pins npm's prefix so a user `~/.npmrc` can't
  hijack the yarn install, and a dev stack can now run beside the installed app.

## 1.1.0 — 2026-07-30

Security pass, acting on an external audit (its findings, and what remains open, are in
`docs/REVIEW-FINDINGS.md`).

- **The local API requires a token.** Binding to loopback never stopped another local
  process from trading; every `/api` route except the installer's health probe now needs a
  per-install token stored 0600 beside your keys. Your browser gets it from the page, so the
  bookmarked http://localhost:6688 is unchanged. Scripting the API needs the `x-arb-token`
  header — see the README.
- **Hand-cancelling can no longer abandon a live deal.** The refusal guard now covers the
  client-text id the venue also accepts, and the window where an order is live on the venue
  before our ledger knows its id. Either path previously read as a deliberate STOP and gave up
  the rest of the entry permanently.
- **Install exactly what you audited.** `BOROS_REF` pins any commit, tag or branch on both
  platforms; the installers record the commit they laid down, and Settings → About shows it.
- **Windows key-file permissions no longer undo themselves** on every boot, and running from
  a source checkout no longer narrows the whole checkout to owner-only.
- **The macOS install/uninstall scripts** no longer SIGKILL an editor that happens to have
  the server path in its arguments — and no longer miss a server started with relative paths.

## 1.0.0 — 2026-07-30

- Update notifications — the terminal now tells you when a new version is out, with per-OS
  update instructions.
- User guide (docs/USER_GUIDE.md), linked from the header: how to set the Opportunities
  assumptions and how to open a pair well.
- Per-leg hedge top-ups: an under-hedged position names exactly how much more to open on each
  venue, and a one-click pair CTA completes a symmetric gap.
- Sizing gate: a strategy's headline APR / capital / PnL-by-maturity stay hidden until the
  4-leg book is genuinely built (Boros legs matched, perp legs matched, layers sized together).
- Boros order books now ride the shared 30s cache cadence — an order of magnitude fewer
  backend requests from an open dashboard.
- USDC-margined twin contracts (Binance/OKX/Bybit) removed from the venue pickers — separate
  books with independently-settled funding, unhedgeable against the Boros markets this
  terminal tracks.
