import type { Pool } from '../api/types';
import { num } from '../lib/fmt';

export const roundCount = (n: number) => `${num(n, 0)} ${n === 1 ? 'round' : 'rounds'}`;

export const WALLET_LABEL: Readonly<Record<string, string>> = {
  'USDT/CROSSEX': 'USDT · CrossEx',
  'USDC/HYPERLIQUID': 'USDC · Hyperliquid',
  'USDC/LIGHTER': 'USDC · Lighter',
  'USDC/GATE': 'USDC · Gate',
};

export const VENUE_NAME: Readonly<Record<string, string>> = { HYPERLIQUID: 'Hyperliquid', LIGHTER: 'Lighter' };

export const poolKey = (pool: Pool): string => (pool === 'CROSSEX' ? 'USDT/CROSSEX' : `USDC/${pool}`);

const venueWallet = (pool: Pool): string => `the CrossEx ${VENUE_NAME[pool]} wallet`;

export const LEG_TEXT: Readonly<Record<string, string>> = {
  'Buy USDC': 'Buy USDC in CrossEx',
  'To spot': 'CrossEx to Gate spot',
  'To Hyperliquid': 'Gate spot to the CrossEx Hyperliquid wallet',
  'To Lighter': 'Gate spot to the CrossEx Lighter wallet',
  'From Hyperliquid': 'CrossEx Hyperliquid wallet to Gate spot',
  'From Lighter': 'CrossEx Lighter wallet to Gate spot',
  'To Gate': 'Gate spot to CrossEx',
  'Sell USDC': 'Sell USDC for USDT',
};

export const NO_LEGS = 'No open positions. Nothing to rebalance.';

export const MOVE_TEXT = {
  step: (from: Pool, to: Pool, move: string, arrives: string): string => {
    if (to === 'CROSSEX') return `Move ${move} USDC out of ${venueWallet(from)}, sell ${arrives} for USDT`;
    return `Move ${move} USDC from ${venueWallet(from)} to ${venueWallet(to)}`;
  },
  into: (to: Pool): string => venueWallet(to),
  convert: (from: Pool, to: Pool, move: string): string => {
    if (from === 'CROSSEX') return `Convert ${move} USDT to USDC in ${venueWallet(to)}`;
    if (to === 'CROSSEX') return `Convert ${move} USDC to USDT from ${venueWallet(from)}`;
    return `Convert ${move} USDC from ${venueWallet(from)} to ${venueWallet(to)}`;
  },
  loop: (moves: readonly { from: Pool; to: Pool }[]): string[] => {
    const wallets = (pools: Pool[]) => pools.map(venueWallet).join(' and ');
    const into = moves.filter((move) => move.from === 'CROSSEX').map((move) => move.to);
    const out = moves.filter((move) => move.to === 'CROSSEX').map((move) => move.from);
    const across = moves.filter((move) => move.from !== 'CROSSEX' && move.to !== 'CROSSEX');
    return [
      ...(into.length > 0 ? [`Buy USDC in CrossEx, move it through Gate spot into ${wallets(into)}.`] : []),
      ...(out.length > 0 ? [`Move USDC from ${wallets(out)} through Gate spot, back into CrossEx, and sell it for USDT.`] : []),
      ...across.map((move) => `Move USDC from ${venueWallet(move.from)} through Gate spot into ${venueWallet(move.to)}.`),
    ];
  },
  round: (from: Pool, to: Pool, about: string): string => {
    if (from === 'CROSSEX') return `Buy USDC in CrossEx. Move it to Gate spot, then into ${venueWallet(to)}. ${about}.`;
    if (to === 'CROSSEX') return `Move USDC from ${venueWallet(from)} to Gate spot, then back into CrossEx. Sell it for USDT. ${about}.`;
    return `Move USDC from ${venueWallet(from)} to Gate spot, then into ${venueWallet(to)}. ${about}.`;
  },
  roundTerm: (from: Pool, to: Pool): string => `A round, ${WALLET_LABEL[poolKey(from)]} to ${WALLET_LABEL[poolKey(to)]}`,
};

export const HOVER = {
  rebalanceTitle: {
    equity:
      'Rebalance splits CrossEx equity by position size at mark price. Example: $500 of positions on Gate, $250 on Hyperliquid and $250 on Lighter give 50%, 25% and 25%.',
    walletHead: { wallet: 'Wallet', legs: 'Legs', interest: 'Borrow interest' },
    wallets: [
      { wallet: 'USDT · CrossEx', legs: 'Gate, Binance, OKX, Bybit', interest: 'from the first dollar' },
      { wallet: 'USDC · Hyperliquid', legs: 'Hyperliquid', interest: 'free up to 10,000 USDC, then about 5% a year' },
      { wallet: 'USDC · Lighter', legs: 'Lighter', interest: 'from the first dollar, about 11% a year' },
    ],
    borrow: 'A negative wallet is a borrow. A borrow locks 20% of its size as initial margin.',
    rounds: 'Spot loop moves in rounds. Free margin caps each round. Time and cost are per round.',
    routeHead: { route: 'Route', path: 'Path', time: 'Time', cost: 'Cost' },
    routes: [
      {
        route: 'Spot loop',
        paths: [
          { path: 'USDT to Hyperliquid', time: 'about 2 min', cost: 'from $0.05' },
          { path: 'Hyperliquid to USDT', time: 'about 6.5 min', cost: 'from $1.00' },
          { path: 'USDT to Lighter', time: 'about 4 min', cost: 'from $1.03' },
          { path: 'Lighter to USDT', time: 'about 3 min', cost: 'from $0' },
          { path: 'Hyperliquid to Lighter', time: 'about 10 min', cost: 'from $2.03' },
          { path: 'Lighter to Hyperliquid', time: 'about 5 min', cost: 'from $0.05' },
        ],
      },
      {
        route: 'Convert',
        paths: [
          { path: 'USDT ↔ USDC', time: 'instant', cost: '0.2%' },
          { path: 'Hyperliquid ↔ Lighter', time: 'instant', cost: '0.4%, two swaps' },
        ],
      },
    ],
    recommended: 'Recommended: cheapest route that takes 15 min or less.',
  },
  walletUsdt: 'CrossEx wallet. Margin for Gate, Binance, OKX and Bybit legs.',
  walletUsdc: 'CrossEx wallet. Margin for Hyperliquid legs.',
  walletLighter: 'CrossEx wallet. Margin for Lighter legs.',
  walletGate: 'CrossEx wallet. USDC left from a spot buy. Still margin. Rebalance empties it.',
  now: 'Equity = cash + unrealized PnL.',
  positionShare: "This wallet's positions at mark price ÷ all positions. Rebalance moves equity to this share.",
  interestUsdc: 'No interest under 10,000 USDC. Interest only on the part over.',
  interestLighter: 'Interest from the first dollar. About 11% a year.',
  interestUsdt: 'Interest from the first dollar.',
  interestPaid: 'Total interest paid, all time.',
  route: 'How the money moves. Cost includes Gate fees and spot spread. Spot loop shows only when it costs less than Convert.',
  mix: (cap: number) => `Spot loop for up to ${roundCount(cap)}, then Convert the rest.`,
  recommended: 'Cheapest route that takes 15 min or less.',
  noDirectTransfer: 'Gate has no direct transfer between CrossEx wallets.',
  repeats: 'Repeats in rounds.',
  convert: 'Instant swap between your CrossEx USDT and USDC wallets. 0.2% fee.',
  convertAcross: 'USDC between Hyperliquid and Lighter swaps twice, through USDT.',
  roundLabel: 'A round',
  whyMoreThanOneLabel: 'Why more than one',
  whyMoreThanOne: 'Gate caps each transfer by your free margin.',
  whyMoreThanOneBorrow: (amountText: string) =>
    `Your borrow locks ${amountText} (20%) as initial margin. Each round repays some borrow and frees that margin, so the next round is bigger.`,
  whyLabel: (n: number) => `Why ${num(n, 0)}`,
  whyMixAtCap: (cap: number) => `Spot loop stops at ${roundCount(cap)}, the most that fit in 15 min. Convert does the rest.`,
  whyMixCheapest: (n: number) => `${roundCount(n)}, then Convert is the cheapest mix that takes 15 min or less.`,
  whyMixUnderCap: (n: number, costText: string, nextCostText: string) =>
    `${roundCount(n)}, then Convert costs ${costText}. ${roundCount(n + 1)} cost ${nextCostText}.`,
  whyLoopOne: 'One round moves it all.',
  whyOnePerWallet: 'One round for each wallet.',
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
  fee: 'Gate fee. CrossEx Hyperliquid wallet: in $0.05, out $1.00. CrossEx Lighter wallet: in $1.03, out free. Others free.',
  time: 'Typical time. Moves into or out of the CrossEx Hyperliquid and Lighter wallets can take longer.',
  minimum: 'Gate minimum for moves into or out of the CrossEx Hyperliquid and Lighter wallets. Fee included.',
  upToOut: "Free margin, capped at this wallet's cash.",
  upToInto: 'Your Gate spot balance.',
} as const;
