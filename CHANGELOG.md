# Changelog

Only substantial releases are listed here — each one bumps `version.json` (which is what the
in-app update check compares against).

## 1.7.1 — 2026-09-23

TLDR: One Boros wallet at a time, like the Boros app, and Telegram alerts for each wallet. The
bot warns you before a leg liquidates, when a wallet starts paying interest, when a pair is a
week from maturity, and when a later maturity pays a better APR. The liquidation line is the
real price, however far away, read from Gate's real margin table, so it is right on a large
account.

- **One Boros wallet, like the Boros app.** The terminal shows one wallet everywhere and
  follows the account in Rabby or MetaMask. A chip in the header shows that wallet and its
  login on every tab. A wallet you are not logged in to is view only: it shows "Boros PnL ·
  0x…", hides your Gate positions, and every trade button reads "Log in to trade 0x…".
- **Login is checked on the chain.** Log in waits for Boros to confirm, then says "Logged in".
  While it waits, the wallet reads "Logging in…". A rejected prompt keeps your old login. An
  expired or revoked login says so and offers "Renew login". Settings warns 14 days before a
  login ends.
- **One login per terminal.** Logging in a second wallet asks first. The question names both
  wallets and warns about unhedged Gate perps. Gas top-up works only for the logged-in wallet.
- **After the update.** The terminal shows the account in Rabby or MetaMask, and switches when
  you switch there. With no wallet account, it shows the logged-in wallet once. A wallet you
  track by hand stays until you switch accounts in the wallet.

- **Telegram alerts for each wallet.** Settings has a Set up button. It opens the Boros
  notifications page. Confirm the terminal there, and the bot watches your legs from then on.
  Each wallet sets up once, and many wallets can use the same Telegram chat. Alerts cover the
  logged-in wallet. The alerts of your other wallets pause until you log in to them again. Four alerts: a leg nearing
  liquidation, a wallet that starts paying interest, a pair within 7 days of maturity, and a
  roll-over opportunity where a later maturity pays a better APR after fees. Each names the
  coin, the leg or the wallet, and the price or the maturity, so you know which side to fix.
  Turn any alert off in Settings. Each wallet keeps its own settings. The terminal checks roll
  targets itself every 5 minutes, so the alerts work with the browser closed.
- **The Telegram row says what is true now.** It reads "Checking…" until the first sync, and
  "not set up" for a wallet with no alerts. It links to the Boros notifications page. Opening
  it asks the bot at once, so a change made on that page shows here. "Disconnect this
  terminal" asks first.
- **Every 1.7.1 setting reads the same way.** Each Settings row opens and closes with its
  arrow. The interest caption says when a wallet starts borrowing, with the exact floors in a
  hover. The sync note is in the hover on "synced 3 min ago". A stale price says how long it has been
  missing instead of a clock time.
- **The liquidation line reads Gate's margin table.** Gate raises the margin rate in steps as a
  position grows, so a $400k HYPE leg is liquidated nearer than a flat rate says. The app now
  reads the table per coin and uses the rate for your size. On a $400k account at 3x that moves
  the line by $25.
- **The liquidation line is the real price.** The estimate used to stop at a 10x pump or a 98%
  dump. It now finds the price however far it is. A coin that no price liquidates reads
  "No HYPE price liquidates the account".
- **A coin Gate stops pricing says so.** The last good price is kept for 60 seconds, marked as
  held. Past that the card says "No liquidation estimate" and names the leg Gate stopped pricing,
  instead of showing nothing. A held price can no longer size a close: the close window drops its
  USD field until a real price arrives.
- **A setup checklist on first run.** Each step says what it needs and what is missing, so a new
  install reaches a working terminal without reading the guide. The Gate key step lists what
  comes first on Gate: fund Gate, enable CrossEx, fund CrossEx. Point at a step for the detail.
- **Only coins both venues support.** A coin one venue lists and the other does not is no longer
  offered, on Opportunities and in the order ticket.
- **A close-only market says so.** The order ticket marks a close-only market and asks you to
  tick Reduce-only before it sends.
- **Your tracking start date has a sensible default.** Funding and interest are counted from
  when you started, not from the beginning of the account.
- **Boros payment history is no longer capped.** The full settlement history loads.
- **Lighter reads on the Boros API cost less.** The order book is read every 90 seconds instead
  of 60, fill history and the settlement head every 60 instead of 30, and a hidden ticket stops
  polling. The worst minute now fits inside the Boros allowance instead of running past it.
- **The Spot loop says how long it will take.** The confirm step shows the route, the fee and
  the time, "Spot loop · Fee $3.41 · about 17 h 22 m", before you hold.
- **Smaller things.** Long waits read as "about 17 h 22 m" instead of "about 1042 min". The
  Positions health strip names the nearest line first. Venue names read as Gate and Hyperliquid,
  not as codes. A bundle's Notional hover carries the exact figure beside the short one. Icons
  match the Boros app. Buttons in one row have one height.

## 1.7.0 — 2026-09-21

TLDR: Roll a 4-legged position into the next maturity from the app, as one all-or-nothing
batch. Every trade form shares one look, and a Boros order that fails says why on the leg that
failed.

- **Roll over.** Positions flags a pair inside 10 days of maturity as *ready to roll*, and as a
  *roll opportunity* when a later maturity pays more than the one you hold; a banner at the top
  says which pairs and by how much. Roll over opens the pair on every later maturity, priced
  live, and the review shows the Exit and the Re-entry side by side: what you lock, for how
  long, what it earns and what it costs today, then each batch's estimated slippage against its
  own Max, seeded from that market's max rate deviation.
- **One batch, or nothing.** The old rate legs close and the new ones open in a single batch the
  venue builds: every order fills whole or the whole roll is refused, so a roll can no longer
  leave the old legs closed and the new ones half open. The venue previews the batch while you
  look at it — the hold is blocked, with the reason, when a leg cannot fill whole inside its
  bound or the account would run short of margin once the old legs are closed. After the hold
  there are three answers: *Rolled N to <date>*, *Nothing was traded — <why>*, or the rare
  *the venue did not confirm* — check the position on Boros before sending again.
- **The roll defaults to a size the book fills whole.** A market order is matched level by
  level up to its rate bound, and the venue refuses a last level past its own band, so the
  default size is the depth inside the nearer of the two — not an average that a lumpy book
  flatters. A refusal for liquidity says how much *does* fill.
- **Margin the roll is judged on.** *Can it fund?* shows the margin the new legs need against
  what is spendable before and after the batch, as the venue simulates it — the old legs free
  theirs first. Two figures fixed: a rolled slice was charged the whole position's Boros margin
  (rolling 13% read like rolling all of it), and the perp margin behind a slice is now the
  slice's.
- **Trade forms share one look.** Order tickets and close forms — CrossEx pair and single, Boros
  pair and single, close a perp leg, close a Boros leg, close a pair — use the same market
  picker, size box with the unit inside it, and one Estimate card each.
- **A Boros failure names its leg and its reason.** A batch the venue refuses says on each leg
  what stopped it — *Insufficient liquidity*, *Rate Too Far Off*, *Not enough margin* — instead of
  the first "batch aborted" read as *unknown — check Boros*. An order refused before it was
  sent, or turned away with a status code, reads as nothing traded, never as "may or may not
  have filled". The gas top-up that rides with a close now runs after it, so its margin check
  sees the margin the close frees.
- **A rate bound outside the venue's band is refused before sending.** An order whose bound
  falls outside mark ± the market's max rate deviation used to reach the venue and come back
  *Executed Rate Out of Range*; the form now says so and blocks the hold.
- **Hide inactive pairs.** On by default, Positions shows only assets with something open; a
  pair whose every leg has matured hides with the rest.
- **Smaller things.** The maturity reminder starts 10 days out. The simulation window is
  tidier, and the roll-over controls sit where the pair's own actions are.

## 1.6.3 — 2026-09-19

TLDR: Rebalance now clears a borrow after your positions are closed, and moves any amount you
type between two CrossEx wallets.

- **Clear debt.** Close every perp and a USDT or USDC borrow can stay behind. Rebalance used to
  say "No open positions. Nothing to rebalance." right above it. Clear debt brings every
  negative wallet to zero, paid from the wallet with the most equity first. It never pays with
  cash that covers an open loss, so a borrow is cleared, not moved to another wallet. What no
  wallet can cover shows as the amount short.
- **Custom amount.** Type an amount, pick a wallet to send from and one to send to. The window
  prices it like any other move. While a new amount is being priced the hold waits and says so.
- **Every route, always.** Spot loop + Convert, Spot loop, and Convert are all listed with time
  and fee side by side. Spot loop runs until the move is done, however many rounds that takes.
  The recommendation is unchanged: the cheapest route that finishes within 15 minutes.
- **The card leads with the move worth doing.** With no positions, that is Clear debt. With
  positions and a borrow, the cheaper of the two. Verdicts name their subject: "Rebalance
  recommended." or "Clear debt recommended."
- **With no positions, a borrow is not weighed against the fee.** It blocks a withdrawal
  whatever clearing it costs, so the card says that instead.
- **A rate the app could not read is an error,** shown in amber, instead of a silent card.
- **Fewer "Refresh route" prompts.** A quote only goes stale when its fee rose by more than $1
  or 5%, the same rule the app applies when you hold.

## 1.6.2 — 2026-09-17

TLDR: Lighter is on CrossEx, and the app trades it. Rebalance splits your equity across USDT,
Hyperliquid and Lighter, and is safe for large accounts.

- **Lighter pairs in Opportunities.** Up to 50x on ETH and BTC, so a pair needs less capital.
- **Rebalance splits equity by position size.** Each wallet gets the share its legs hold. The
  Rebalance window shows each share.
- **A third wallet: USDC · Lighter.** Rebalance and Manual Transfer move money into and out of
  it. A Lighter borrow pays about 11% a year from the first dollar.
- **Balances shows your assets above Rebalance.** Borrow and interest sit under the table, with
  Rebalance and Manual Transfer. Each opens in its own window. The Borrowing pill adds up every
  wallet.
- **Rebalance says when it pays.** It says how many days of saved interest pay the fee. Past 30
  days, it reads "Not worth it yet".
- **Rebalance is safe for large accounts.** Big moves split under Gate's caps, and Converts go
  out 2 s apart. A poor Convert price stops the run. So does a Gate rate limit, and the run
  says so. A step is never sent twice without you.
- **Spot loop plans 15 min at most,** and shows only when it costs less than Convert.
- **A finished run shows what landed,** after fees.

## 1.6.1 — 2026-09-15

TLDR: One hold now makes your CrossEx USDT and USDC equity even. A new Manual Transfer card moves
money between Gate spot and your CrossEx wallets.

- **Rebalance evens your USDT and USDC wallets with one hold.** You no longer pick a direction or
  type an amount. The card shows each wallet now and after the run, each with a line at zero.
- **A borrow no longer stops the run at "To spot".** The run moves in rounds. Each round keeps
  margin above 112% of initial margin, because Gate refuses a move out under 110%.
- **You see every route before you hold.** Spot loop, Convert, or both. Each route shows its
  rounds, time and cost, and you can pick one.
- **A new Manual Transfer card.** It moves USDT and USDC between Gate spot and USDT · CrossEx, USDC · Gate
  and USDC · Hyperliquid. It shows the fee, the time, the minimum and what arrives. It locks while
  a rebalance or a deal is working.
- **A stopped run says where your money is.** Money in transit shows once, as "On the way", in
  both directions. Resume continues from the stopped step. Abandon leaves the funds where they
  are. After a restart during a transfer, the app waits for Gate, then stops before the next send.
- **Gate spot shows on the Balances tab.** The Assets table lists a Gate spot group. The Rebalance
  card tells you when spot holds money you can move in, and a link fills the Manual Transfer card.
- **Borrow costs read as Gate charges them.** The Rebalance card shows the interest per day. A
  USDT borrow pays from the first dollar. A Hyperliquid USDC borrow pays only above 10,000. The
  Borrow pill card shows what Gate lent, for which legs, and the margin it holds.
- **Your 1.6.0 API key keeps working.** Spot balances need Spot Trading Read Only on the Gate key.
  Without it, every flow still works and the app says what is missing. Add it on Gate's API
  Management page. Setup guide step 4 now asks for it.
- **Smaller things.** A refused send from Gate spot says how much spot holds. A deal waits until
  Gate takes a new transfer. The halt banner's View opens the stopped card. Errors on the
  Rebalance and Manual Transfer cards read as a sentence. The API key cannot change while a rebalance
  runs.

## 1.6.0 — 2026-09-10

TLDR: The Positions tab is rebuilt around your coins. Every perp and Boros leg in an asset sits
under one card, with a PnL that foots to the cent, a funding bundle per exchange, and a close
button on every leg. The whole app now wears the Boros look.

- **Positions are grouped by asset, not by strategy box.** One card per coin holds every perp and
  Boros leg in it, across every venue and maturity. Nothing to enrol, nothing to group by hand,
  and every number comes from the venues' own records, so two machines tracking the same address
  read the same dollars. The old strategy-box tab, hand-grouping and entry-cost overrides are
  gone.
- **Each card leads with four numbers.** Total PnL with ROI, Current APR (the fixed rate the hedge
  locks right now), Capital and Lifetime Cost, plus a PnL waterfall. Clicking Total PnL opens the
  breakdown: funding settlements + Boros trade PnL − fees + price basis, and every table on the
  card sums to it.
- **A funding bundle per exchange.** Each exchange shows its perp with every Boros leg hedging it:
  notional, the blended fixed APR you receive or pay, the floating rate now, settlements with
  fees, and trade PnL. It expands to its legs. Matured and closed legs sit behind a toggle with
  the rate they locked. A missing or short leg says so, with a button that arms the order ticket
  with exactly what is needed.
- **Close any leg from its row.** Every live leg has Edit and Close leg. A perp closes reduce-only
  at mark; a Boros leg closes at market and pays only its own taker fee. The 4-leg pairs table
  closes both perps or both Boros legs of a pair with one size box, sized per leg so a close never
  leaves a naked remainder.
- **A start date and exclusions per asset.** Set a "since" date and funding and fees are summed
  from the venues' per-tick ledgers inside that window. Exclude a whole Boros leg or a slice of it
  at a given rate. Excluded legs stay listed and can be restored.
- **Hedge status says what to fix.** "fully covered ✓" or "N legs to fix", a check that the two
  perps cancel, and a warning when Boros coverage is about to mature. Pairs are formed at one
  maturity only, never blending terms.
- **Settlement fees are part of the rate.** They are netted inside the settlement they belong to
  and inside every locked rate, never listed as a cost, so tracking now agrees with the entry
  quote on the Opportunities tab. Interest paid on a Gate borrow counts against Total PnL.
- **The 2-step wizard and the Boros ticket are redesigned.** Form on the left, live quote on the
  right, so nothing moves while the quote ticks. Wizard sizes are targets per leg, so a
  half-filled leg only trades the unfilled part. The Boros ticket shows Market A and Market B with
  one spread-direction control and slippage as "Est. X / Max: Y", measured from mid.
- **The whole app wears the Boros look.** Boros palette, Inter with tabular numerals, a header
  strip with Avail, Balance and margin meters, and the Boros mark on the favicon and share card.
  Contrast is lifted to WCAG, dialogs trap focus, hover cards open from the keyboard.
- **Fixes.** Matured Boros legs leave the hedge and capital. Dollar-sized assets no longer print a
  coin ticker. A partial close shows the realised PnL of the closed part only. Nothing prints
  "-$0.00". The USDT to USDC rebalance says "Nothing to move" when there is nothing to move.

## 1.5.1 — 2026-09-08

TLDR: Gate lends you USDC or USDT when a wallet runs short. The app now shows the borrow and
what it costs, and pays it back with one hold. Each pair says where it liquidates. The update
dialog opens by itself.

- **A Rebalance section on the Balances tab.** Your account has two wallets. USDT pays for every
  venue but Hyperliquid. USDC pays for the Hyperliquid legs. When a wallet's legs lose more than
  it holds, Gate lends the coin. It holds 20% of the loan as initial margin and 10% as maintenance
  margin. Past 10,000 borrowed it also charges interest every hour. The section shows six facts:
  what Gate lent you, the margin it holds, the interest per day, the spare USDC on Hyperliquid,
  and the interest you have paid since January 2025. The six facts are the same with and without
  a borrow. An info mark next to the title explains them.
- **An amber pill in the header shows the borrow on every tab.** It shows from 1 USDC or USDT.
  Click it to open the section.
- **One hold pays the borrow back, in either direction.** USDT to Hyperliquid USDC pays a USDC
  borrow. Hyperliquid USDC to USDT pays a USDT borrow, or moves spare USDC back when there is no
  borrow. The amount is prefilled with the borrow. A move never opens a new borrow.
- **The app picks the cheaper route and shows it.** An instant convert costs 20 bps. A spot loop
  through Gate costs $0.05 toward USDC and a flat $1 toward USDT. The quote shows the route, the
  price, what lands, the cost, and the borrow after the move.
- **You can watch a move run.** A progress bar shows each step and its seconds. A page refresh
  keeps the move running. If the app restarts during a move, the move halts, says where the funds
  are, and offers Resume and Abandon. A move and a deal do not run at the same time.
- **Each pair says where it liquidates.** A hedged pair is delta-neutral, but a move against the
  Hyperliquid leg still grows the maintenance margin. Every card on the Positions tab says
  `Liquidates if ETH hits ~$3,150 (+37%)`. That is the price at which the account liquidates if
  only that coin moves. Amber inside 30%, red inside 15%. A pair with no line within 10x says so.
  The nearest line is in the header's margin-gauge hover. The rebalance quote shows the price
  before and after the move.
- **The update dialog opens by itself.** When a new version is out, the dialog opens on every
  open of the app until you install it. Close hides it until the next open. Before, the only sign
  was an amber button in the header, and people missed it.

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
