# User guide

In this guide, we will cover:
1. How the strategy works
2. The recommended flow for using CrossEx Boros Terminal
3. How to maximise return
4. Risk Disclosure

## 1. How the strategy works

Perp traders pay (or earn) a floating funding rate. On [Boros](https://boros.pendle.finance), that funding rate is itself tradable - and the same coin's funding often carries **different implied fixed rates on different venues**: say ETH funding priced at 8% APR on Hyperliquid but 5% on Binance. The strategy locks in that gap.

One position is 4 legs, all at the same notional:

- **2 rate legs on Boros** - short the funding of the expensive market (you *receive* its fixed rate) and long the funding of the cheap one (you *pay* its fixed rate). Receive 8%, pay 5% → ~3% locked until the market's maturity.
- **2 perp legs via CrossEx** - a short perp on the first venue, a long perp on the second, both opened through [Gate CrossEx](https://www.gate.com/crossex) under one **unified margin** account. Each perp leg's funding cancels the floating funding its Boros leg owes, and the two perps cancel each other's price exposure - with the shared margin, one leg's gain collateralises the other's loss.

Once everything nets out there is no price exposure and no floating-rate exposure left - just the fixed spread, earned on the notional until maturity. The Opportunities scan prices that spread at your size, subtracts every cost it can model (Boros fees and price impact, perp fees and slippage, entry and exit), and shows what remains as a **net fixed APR on the capital** the four legs actually consume as margin.

Boros Academy walks through this strategy in more depth: [Fixed-Return Funding Arbitrage](https://docs.pendle.finance/boros-academy/advanced-strategies/fixed-return-funding-arbitrage).

**Fixed does not mean risk-free** - see section 4.

## 2. The recommended flow for using CrossEx Boros Terminal
You will use the tool for 3 things, in order:

### A. Discover and understand opportunities
A few things to note about the assumptions:
- Your current Gate VIP level is **already factored in**
- Other than that, its all about understanding the other assumptions:
![The assumptions bar above the Opportunities scan — notional, perp entry, perp exit cost and Boros entry](./Assumptions.png)
- For perp entry, **"Limit + hedge"** means the terminal will place a limit order on exchange A, wait for it to be filled, and immediately market order on the other exchange to hedge. This will save on perp fees (because *maker* fees is cheaper than *taker* fees)
- For perp exit cost, if you do not need to close the Perp positions (and be able to lock in another Boros spread in a subsequent 4-legged position), you can **Omit** it (instead of **Include**), which saves the perp fees.
- On Boros, **"At mark rate"** assumes you can enter the Boros legs without any price impact *(which could be unrealistic)*. **"Market at size"** assumes you do market orders on Boros for both legs. An optimised execution is to try to fill limit orders on one or two legs, to reduce price impact (and fees).

Other than that, the details are pretty self-explanatory. Try toggling the assumptions to see how it affects the PnL items.
![Opportunities details](./OpportunitiesDetails.png)

Note that you can click **"Execute it"** on an opportunity to pre-populate the forms for executing it.

### B. Execute a 4-legged Funding Rate Arbitrage position
It's recommended to **open the Boros legs first**, before opening the Perp legs. This is because the price impact from opening Boros position is higher and more uncertain, so you should "lock in" the Boros spread first before executing the whole 4-legged position.

Do **set your Boros address**, so that your Boros position can be tracked.

#### Executing the 2 perp legs


Executing with **"2 market orders"** is relatively straight forward.

As for executing the **"Limit + hedge"** default option, there are a few things to note:
1. The Limit (maker) side is auto chosen to minimise total fees
2. This is the default flow:
   - There is an **initial Maker price** (that is automatically set to be slightly beyond the best bid/best ask). You can also manually set this.
   - After you click **"Execute pair"**, a limit order is immediately placed at the initial maker price.
   - Whenever the limit order is filled (or partially filled), we automatically execute taker order (market order) to hedge the amount that were filled, repeat until the whole limit order is fully filled.
   - If the **countdown until convert** (default to 5 min) goes to zero and the trade is still not fully executed, the system will cancel the limit order and complete the pair through market orders. If you do not wish for this to happen, you can click **Stop** before the time runs out.
3. If the limit order is still not filled for some time (for example when you set a manual price that is far away), you can click **"Re-peg to touch"** to move the limit order close to the best bid/best ask. There is also an option to **Re-peg to a custom price**.
![Re-peg to touch](./RepegToTouch.png)

**Important:**
- You should try executing a **test amount first**, to get familiar with the flow, before executing a bigger amount
- When executing a large position, it's recommended to manually **break it into a few executions** (for example, do 5x 100k instead of 500k in one go)

### C. Monitor your position
Once opened, there's not much maintenance you need to do on a 4-legged position, except for when to close the two perp legs at maturity (if you don't roll over
into the next maturity).

What's most useful is to understand and breakdown the PnL for your positions.
![Current position](./CurrentPosition.png)

Each open position has two assumptions you can toggle, and both move the numbers *and* the waterfall charts:

**Perp exit cost** — what happens to the perp legs at maturity:
- **Include**. This is the default, and you need to incur another set of Perp trading fees. The chart uses the same fees and slippage as when you opened the perp legs.
- **Omit (rolling over)**: this means you don't need to pay perp fees for closing, which boosts your overall return. To do this, you need to be able to lock a decent spread on Boros, on the same perp pair, on a next maturity.

**Perp entry cost** — whether this position is charged what it cost to open the perp legs:
- **Include**. The default, and correct whenever you opened the perp legs for this position.
- **Omit (rolled over)**: use this when the perp legs were *already open* and you rolled them into this maturity. They paid their fees and crossed their spread during the previous position, but Gate reports a position's fees cumulatively and its entry price from the original open — so without this toggle, this position gets billed for money it never spent. Omitting moves the Current PnL as well as the projection.

Under **Include**, the **▾** button next to it itemises that cost so you can charge only *some* of it — useful when a book was built across several executions (a venue migration, a top-up, legs inherited from a previous maturity). Everything is ticked by default, the button shows how many parts are still charged (e.g. *Include (3 of 4)*), and your ticks are remembered per position. There are two kinds of row, and they are not equally precise:

- **Entry slip** rows are **per execution**, each with its date, the two venues crossed and the size matched. Untick the ones whose fills belonged to an earlier strategy.
- **Fees** rows are **per leg**, marked *position life*. Gate reports a position's trading fees as a single cumulative number and nothing records them per trade, so they genuinely cannot be split by date — the terminal shows them per leg rather than inventing a split. Note this also means a leg you have since migrated away from contributes nothing at all, since it is no longer an open position.

#### When one venue leg belongs to two positions

Run HL/OKX and HL/Binance at the same time and the HL side is **one** position everywhere you look: Gate reports a single row at a blended entry price, and Boros reports a single position at a blended fixed rate. Neither says which part is which strategy.

The terminal splits it back apart, and shows each position as its own box — its own size, its own entry prices, its own locked rate. It works from the execution record: the local deal journal, and your own fill history at the venue (each fill carries the order tag this terminal writes, so a fill can be matched back to the deal that made it). Where that record is complete, the split is a **measurement** — the chip on the box says *split measured*.

Where it isn't — positions opened elsewhere, or older than the fill history reaches — the terminal pairs the legs by how close their prices and open times are, and the box says *split unconfirmed*. Then:

- The sizes are still right: they come from the pairing itself, not from the prices.
- The **crossing cost is reported as unknown**, not estimated. The venue's blended entry price is an average across *both* strategies, so charging it to either one would invent a number.
- The **locked spread** falls back to the blended rate, which still nets out correctly across the two positions but is not exactly what either one locked.

**Adjust split** on the box is how you correct it. Type the size this position really holds and **Pin size**; the pinned size holds and everything unpinned is re-solved around it. **Detach** says these two legs are not a strategy together at all — both are then reported as unhedged. **Back to automatic** hands the pair back to the solver. Pins are remembered per tracked address.

If a venue position later shrinks below a pin, the pin is **clamped and reported** — never silently rescaled — and if a size ends up belonging to no position at all, it gets its own **unhedged** box rather than quietly disappearing.

#### What counts as your capital

Every APR on a position is a return *on capital*, so what goes into that number decides whether a position looks good. The perp side is always the initial margin those legs consume. For the Boros side there are two readings, and **Settings → Capital counted per position** picks one:

- **Posted balance** (default) — the collateral account's balance, split across the positions it backs. Right when that account exists for these positions and nothing else.
- **Margin used** — only the initial margin the Boros legs post. Use this if you also keep trading money in the same collateral account: otherwise that idle cash is counted as capital these positions needed, which inflates capital and drags every APR down.

The choice is remembered per browser and applies to every position box and the totals strip.

#### Rebalancing USDC and USDT

Your CrossEx account has three wallets. Every venue except Hyperliquid and Lighter margins and settles in USDT. Hyperliquid and Lighter settle in USDC, so each has its own USDC wallet, which starts at 0.

Opening a leg does not borrow. Its margin comes from your whole account. A wallet moves only when its legs pay or receive: hourly funding, fees, and profit or loss. When a wallet's legs lose more than it holds, the wallet goes negative and Gate lends you the coin: USDC for the Hyperliquid and Lighter legs, USDT for the legs on every other venue. Gate counts the unrealised loss too, so a borrow can show while the cash is still positive.

The borrow costs two things. Gate holds 20% of it as initial margin and 10% as maintenance margin. It also pays interest:

| Wallet | Legs | Borrow interest |
|---|---|---|
| USDT · CrossEx | Gate, Binance, OKX, Bybit | From the first dollar |
| USDC · Hyperliquid | Hyperliquid | Free up to 10,000 USDC. The part over pays about 5% a year |
| USDC · Lighter | Lighter | From the first dollar, about 11% a year |

A Lighter borrow of $50 pays interest on all $50. A Hyperliquid borrow of $50 pays nothing.

A hedged pair is delta-neutral, but not margin-neutral. Gate liquidates the account when the margin balance falls to the maintenance margin, and the maintenance margin grows with a move against a USDC leg on Hyperliquid or Lighter: each leg's maintenance margin scales with its notional, and the losing leg drives its wallet negative, a borrow that adds 10% of itself to the maintenance margin. Each card on the Positions tab carries a chip like `Liquidates if ETH hits ~$3,150 (+37%)`: the price of the coin at which the account liquidates if only that coin moves and every other coin holds still. It turns amber inside 30% and red inside 15%. A pair that the model priced to a 10x pump and a 98% dump without finding a line reads `Safe through a 10x HYPE pump or 98% dump`. If Gate's margin figures are missing, the chip reads `No liquidation estimate` rather than claiming safety. The same nearest line sits in the hover of the IM and MM gauges in the header, and the rebalance quote carries a `Liquidation` fact with the line before and after the move, as a price and a move (`ETH ~$3,150 (+37%) → ~$3,290 (+43%)`).

The Balances tab always shows a **Rebalance** card. It splits your CrossEx equity across the three wallets by position size. Each wallet's share is its legs at mark price, divided by all legs. Equity is cash plus unrealized profit or loss.

Example: $500 of positions on Gate, $250 on Hyperliquid and $250 on Lighter give 50%, 25% and 25%. With $1,000 of equity, the wallets aim for $500, $250 and $250. A wallet with no legs sends all its money to the wallets that have legs. With no open positions, there is nothing to rebalance.

The **Position share** column shows each wallet's share and the position size behind it, for example `49% · $1,774`. The USDC · Lighter row shows only when it has legs, money or a move.

USDC · Gate is one more CrossEx wallet for USDC. It counts as margin. Rebalance sells what is in it, in both directions, when it is worth 3 USDT or more.

Press and hold **Hold to rebalance** to start. There is no direction to pick and no amount to type. The button moves every wallet toward its share. When more than one wallet sends or receives, one hold runs every move, one after another. The app marks the cheapest route that takes 15 minutes or less as **Recommended** and picks it first. You can pick another route. The three routes are:

- **Spot loop, then Convert**: runs the rounds that give the lowest cost within 15 minutes, then moves the rest with Convert.
- **Spot loop**: runs rounds until every wallet reaches its share. There is no round limit.
- **Convert**: an instant swap inside CrossEx. It costs 0.2% of the amount moved. USDC between Hyperliquid and Lighter swaps twice, through USDT, so it costs about 0.4%.

A round moves money through Gate spot, because Gate has no direct transfer between CrossEx wallets. Time and cost are for one round. Cost adds the spot fee and spread when the round buys or sells USDC.

| Round | What it does | Time | Gate fee |
|---|---|---|---|
| USDT to Hyperliquid | Buys USDC in CrossEx, moves it through Gate spot into the Hyperliquid wallet | About 2 min | $0.05 |
| Hyperliquid to USDT | Moves USDC out through Gate spot, back into CrossEx, sells it for USDT | About 6.5 min | $1.00 |
| USDT to Lighter | Buys USDC in CrossEx, moves it through Gate spot into the Lighter wallet | About 4 min | $1.03 |
| Lighter to USDT | Moves USDC out through Gate spot, back into CrossEx, sells it for USDT | About 3 min | Free |
| Hyperliquid to Lighter | Moves USDC out of Hyperliquid, through Gate spot, into Lighter | About 10 min | $2.03 |
| Lighter to Hyperliquid | Moves USDC out of Lighter, through Gate spot, into Hyperliquid | About 5 min | $0.05 |

A round moves 11 USDC or more. A round from Hyperliquid to Lighter moves 12 or more, so 11 still reaches Gate spot after the $1.00 fee. A smaller move goes by Convert.

Each round leaves at least 112% of initial margin in the account. With $29.41 of initial margin, at least $32.94 of margin balance stays. Gate refuses a move that would leave less than 110%. A borrow locks 20% of its size as initial margin. Early rounds are small, and later rounds grow as the borrow shrinks.

You cannot stop a run once it starts. A failed step stops it. An app restart stops it too. When Gate is already moving a step's money, the app first waits for that step to land, then stops. New deals and transfers wait until the run ends.

A stopped run shows **Resume** and **Abandon**. Resume first looks up the last send on Gate by its tag. When that lookup misses, it sweeps Gate's order history for the same tag. When Gate cannot confirm the order, the run stays stopped. Press Resume again. No step sends twice.

When a run stops, a banner at the top of every tab shows where the money is. Click **View** to open the Balances tab.

After Abandon, any money left in Gate spot is plain spot money. Move it with Manual Transfer.

#### Manual Transfer between Gate spot and CrossEx

The Balances tab also shows a **Manual Transfer** card. It moves USDT and USDC between your Gate spot wallet and your four CrossEx wallets. Gate's own website cannot do this.

Without Spot Trading Read Only on your key, the Manual Transfer card and the Assets table show `Add Spot read permission to see spot balances.` The Gate spot tile then reads `balance hidden`.

Two tabs set the direction. **Into CrossEx** moves money from Gate spot into a CrossEx wallet. **Out of CrossEx** moves money from a CrossEx wallet to Gate spot.

There are eight paths, one for each wallet in each direction:

| Wallet | Coin | Into CrossEx | Out of CrossEx | Minimum |
|---|---|---|---|---|
| USDT · CrossEx | USDT | Free, about 3 s | Free, about 3 s | None |
| USDC · Gate | USDC | Free, about 5 s | Free, about 5 s | None |
| USDC · Hyperliquid | USDC | $0.05, about 2 min | $1.00, about 6.5 min | 11 USDC, fee included |
| USDC · Lighter | USDC | $1.03, about 4 min | Free, about 3 min | 11 USDC, fee included |

A move out of CrossEx is capped so 112% of initial margin stays in the account. With $29.41 of initial margin, at least $32.94 of margin balance stays. This is the same floor a rebalance round uses.

Transfers wait while a rebalance runs or is stopped, or while a deal is still working. Only one transfer moves at a time. If the app restarts mid-transfer, it never sends that transfer twice.

A deal waits a few seconds after a transfer starts, until Gate has taken the money.

## 3. How to maximise return
These few factors move the needle the most in maximising your return on the 4-legged Funding Rate Arbitrage
1. Reduce perp fees with a **higher VIP tier** in Gate.
   * Play around with the VIP tier assumption in https://boros.pendle.finance/arbitrage-crossex, and you will see the immediate impact of your VIP tier on the potential returns.
   * As an example, my current VIP8 tier boosts a particular opportunity from **11.3% APR** to **16.2% APR**. For reference, I need a 400k capital in Gate to get VIP8 tier.
2. **Rolling over**
   * Being able to roll over an existing 4-legged position into the next maturity is a powerful boost to your return
   * The boost is two-fold: the existing position will escape the perp closing fees, and the new position will escape the perp opening fees. Just change the **Perp exit cost** assumption from **Include** to **Omit (rolling over)** to see the impact on the return (and on the next position, untick the inherited executions under **Perp entry cost**, since those legs already paid).
   * If you manage to keep rolling over, the subsequent 4-legged position wont have to pay **a single cent of perp fees** (for both entry and exit), which boosts the return even more.
3. Reduce perp fees + slipapge through an optimised execution of **Limit + hedge**
   * The goal is to minimise slipapge when executing the **Limit + hedge**. Its even possible to get possible slippage (for example, short Hyperliquid ETH at 1601, long OKX ETH at 1600)
   * Its best to execute when the market is generally more calm, reducing risks for big slippage
   * Its best to break a big trade (lets say 1M notional) into multiple rounds, to reduce the average slippage
   * To be the most careful, always **manually set the maker price** at a price relatively further away, and do the execution in the **Deal modal**. At the deal modal, its a *mini-game* of re-pegging the limit order price decently close to market, patiently wait for it to get hit (say by other impatient users on the perp), trying to get an optimised slippage.
4. Optimise **Boros spread**
   * To optimise for the spread you are locking, try to use **limit orders** to fill at least one Boros leg, and do a **market order** on the other leg. Sometimes, it can give you a much higher spread.
   * That said, sometimes when a decent opportunity are there that you can just market order, you could just take it (otherwise, some other users might take it before you)

## 4. Risk Disclosure
- **CEX risk** - your funds custody with Gate.
- **Cross-margin risk** - CrossEx manages margin across exchanges for you.
- **Spread risk** - rare, but the perp legs could diverge enough to trigger liquidation.
- **Boros liquidation risk** - a big enough move against your locked-in spread can break the hedge; keep a margin buffer.
- **Execution risk** - if a leg doesn't open hedged, check after execution.

Ultimately, you should **do your own research**, make sense of all the different risks and rewards, and make the decisions for yourself.