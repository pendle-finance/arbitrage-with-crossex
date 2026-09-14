import { num } from '../lib/fmt';

export const roundCount = (n: number) => `${num(n, 0)} ${n === 1 ? 'round' : 'rounds'}`;

export const WALLET_LABEL: Readonly<Record<string, string>> = {
  'USDT/CROSSEX': 'USDT · CrossEx',
  'USDC/HYPERLIQUID': 'USDC · Hyperliquid',
  'USDC/GATE': 'USDC · Gate',
};

export const LEG_TEXT: Readonly<Record<string, string>> = {
  'Buy USDC': 'Buy USDC in CrossEx',
  'To spot': 'CrossEx to Gate spot',
  'To Hyperliquid': 'Gate spot to the CrossEx Hyperliquid wallet',
  'From Hyperliquid': 'CrossEx Hyperliquid wallet to Gate spot',
  'To Gate': 'Gate spot to CrossEx',
  'Sell USDC': 'Sell USDC for USDT',
};

export const HOVER = {
  rebalanceTitle: {
    wallets: 'CrossEx margin sits in two wallets. USDT: Gate, Binance, OKX and Bybit legs. USDC: Hyperliquid legs.',
    equity: 'Rebalance makes their equity equal. A negative wallet is a borrow.',
    rounds:
      'Spot loop moves in rounds. Gate caps each transfer by your free margin, and a borrow locks 20% of its size as initial margin.',
    head: { route: 'Route', how: 'How', time: 'Time', cost: 'Cost' },
    routes: [
      {
        route: 'Spot loop',
        how: 'rounds through Gate spot',
        time: 'about 2 min a round toward USDC, 6.5 min toward USDT',
        cost: '$0.05 a round toward USDC, $1.00 toward USDT',
      },
      { route: 'Convert', how: 'one swap inside CrossEx', time: 'instant', cost: '0.2%' },
    ],
    recommended: 'Recommended: cheapest route that takes 15 min or less.',
  },
  walletUsdt: 'CrossEx wallet. Margin for Gate, Binance, OKX and Bybit legs.',
  walletUsdc: 'CrossEx wallet. Margin for Hyperliquid legs.',
  walletGate: 'CrossEx wallet. USDC left from a spot buy. Still margin. Rebalance empties it.',
  now: 'Equity = cash + unrealized PnL.',
  interest: (coin: string) => `No interest under 10,000 ${coin}.`,
  interestPaid: 'Total interest paid, all time.',
  route: 'How the money moves. Cost includes Gate fees and spot spread.',
  mix: (cap: number) => `Spot loop for up to ${roundCount(cap)}, then Convert the rest.`,
  recommended: 'Cheapest route that takes 15 min or less.',
  loopToUsdc:
    'Buy USDC in CrossEx, move it through Gate spot into the CrossEx Hyperliquid wallet. Gate has no direct transfer between CrossEx wallets. Repeats in rounds.',
  loopToUsdt:
    'Move USDC from the CrossEx Hyperliquid wallet through Gate spot, back into CrossEx, and sell it for USDT. Repeats in rounds.',
  convert: 'Instant swap between your CrossEx USDT and USDC wallets. 0.2% fee.',
  roundLabel: 'A round',
  roundToUsdc: 'Buy USDC in CrossEx. Move it to Gate spot, then into the CrossEx Hyperliquid wallet. About 2 min.',
  roundToUsdt:
    'Move USDC from the CrossEx Hyperliquid wallet to Gate spot, then back into CrossEx. Sell it for USDT. About 6.5 min.',
  whyMoreThanOneLabel: 'Why more than one',
  whyMoreThanOne: 'Gate caps each transfer by your free margin.',
  whyMoreThanOneBorrow: (amountText: string) =>
    `Your borrow locks ${amountText} (20%) as initial margin. Each round repays some borrow and frees that margin, so the next round is bigger.`,
  whyLabel: (n: number) => `Why ${num(n, 0)}`,
  whyMixAtCap: (cap: number) => `Recommended stops at ${roundCount(cap)}. Convert does the rest.`,
  whyMixUnderCap: (n: number, costText: string, nextCostText: string) =>
    `${roundCount(n)}, then Convert costs ${costText}. ${roundCount(n + 1)} cost ${nextCostText}.`,
  whyLoopOne: 'One round moves it all.',
  whyLoopMore: (n: number) => `Spot loop runs until even. That takes ${roundCount(n)} here.`,
  frees: 'Initial margin the repaid borrow no longer locks.',
  saves: 'Borrow interest per day this stops.',
  liquidation: 'Price where Gate liquidates the account if only this coin moves. Now → after the rebalance.',
  onTheWay: 'In transit through Gate spot. Not margin.',
  gateSpot: 'Not margin.',
  gateSpotAssets: 'Not margin. No equity or PnL.',
  resume: 'Continue from the stopped step.',
  abandon: 'Stop the run. Funds stay where they are.',
  shortOfEven: 'Unrealized gain. Cannot move until those positions close.',
  transferTitle: "Move funds between Gate spot and CrossEx. Gate's website cannot do this.",
  fee: 'Gate fee. Into the CrossEx Hyperliquid wallet $0.05. Out of it $1.00. Others free.',
  time: 'Typical time. Moves out of the CrossEx Hyperliquid wallet can take longer.',
  minimum: 'Gate minimum for moves into or out of the CrossEx Hyperliquid wallet. Fee included.',
  upToOut: "Free margin, capped at this wallet's cash.",
  upToInto: 'Your Gate spot balance.',
} as const;
