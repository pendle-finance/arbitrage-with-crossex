# User guide

In this guide, we will cover:
1. How the strategy works
2. The recommended flow for using CrossEx Boros Terminal
3. How to maximise return
4. What could go wrong

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

## 4. What could go wrong
Last, let's see the different ways things could go wrong:
1. Issues with Gate as an exchange.
   - **Your money sits within Gate.** Anything happening to Gate will affect your money
2. Issues with CrossEx as a cross-margin platform
   - CrossEx might malfunction as a platform (for example, if CrossEx itself is deleveraged or liquidated on some exchange), and your position on CrossEx **might not hold**
3. Liquidation of Perp positions due to extreme perp price differences.
   - The prices on the two perps could, for some reason, deviate so much that even a delta-neutral perp pair **could get liquidated**. This is *extremely unlikely*, but could still happen in theory
4. Liquidation of Boros positions:
   - If the Boros market prices move too much away from the spread you locked in, your Boros position could be **liquidated**, and the 4-legged position's fixed return is compromised.
   - To avoid this, its advisable to **maintain a buffer** on the Boros margin (especially when Boros margin is relatively non-capital-intensive)
5. Issues with CrossEx Boros Terminal:
   - Any issues that result in opening a **non-hedged pair** of perp positions will expose you to losses due to price fluctuation.
   - Its advisable to **double check that your perp positions are hedged** after execution.

Ultimately, you should **do your own research**, make sense of all the different risks and rewards, and make the decisions for yourself.