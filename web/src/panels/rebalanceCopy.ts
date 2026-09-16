import type { Pool } from '../api/types';
import { num, WALLET_SHORT } from '../lib/fmt';

export const roundCount = (n: number) => `${num(n, 0)} ${n === 1 ? 'round' : 'rounds'}`;

export const WALLET_LABEL: Readonly<Record<string, string>> = {
  'USDT/CROSSEX': 'USDT · CrossEx',
  'USDC/HYPERLIQUID': 'USDC · Hyperliquid',
  'USDC/LIGHTER': 'USDC · Lighter',
  'USDC/GATE': 'USDC · Gate',
};

export const poolKey = (pool: Pool): string => (pool === 'CROSSEX' ? 'USDT/CROSSEX' : `USDC/${pool}`);

const venueWallet = (pool: Pool): string => `the CrossEx ${WALLET_SHORT[poolKey(pool)]} wallet`;

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
      ...(out.length > 0 ? [`Move USDC from ${wallets(out)} through Gate spot into CrossEx. Sell it for USDT.`] : []),
      ...across.map((move) => `Move USDC from ${venueWallet(move.from)} through Gate spot into ${venueWallet(move.to)}.`),
    ];
  },
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
    borrow: 'A negative wallet is a borrow. Gate holds initial margin against each borrow.',
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
  borrowHeld: (list: string) => `A negative wallet is a borrow. Gate holds initial margin against it: ${list}.`,
  route: 'How the money moves. Cost includes Gate fees and spot spread. Spot loop shows only when it costs less than Convert.',
  mix: (cap: number) => `Spot loop for up to ${roundCount(cap)}, then Convert the rest.`,
  recommended: 'Cheapest route that takes 15 min or less.',
  noDirectTransfer: 'Gate has no direct transfer between CrossEx wallets.',
  repeats: 'Repeats in rounds.',
  convert: 'Instant swap between your CrossEx USDT and USDC wallets. 0.2% fee.',
  convertAcross: 'USDC between Hyperliquid and Lighter swaps twice, through USDT.',
  round: 'A round is one trip through Gate spot, capped by your free margin.',
  whyMoreThanOne: 'A move bigger than your free margin takes more than one.',
  whyMoreThanOneBorrow: (amountText: string) =>
    `Gate holds ${amountText} of initial margin against your borrow. Each round repays borrow, so the next is bigger.`,
  frees: 'Initial margin the repaid borrow no longer locks.',
  saves: 'Borrow interest per day this stops.',
  onTheWay: 'In transit through Gate spot. Not margin.',
  gateSpot: 'Not margin.',
  gateSpotAssets: 'Not margin. No equity or PnL.',
  abandon: 'Stop the run. Funds stay where they are.',
  transferTitle: "Move funds between Gate spot and CrossEx. Gate's website cannot do this.",
  fee: 'Gate fee for this move.',
  time: 'Typical time. Moves into or out of the CrossEx Hyperliquid and Lighter wallets can take longer.',
  minimum: 'Gate minimum for moves into or out of the CrossEx Hyperliquid and Lighter wallets. Fee included.',
  upToOut: "Free margin, capped at this wallet's cash.",
  upToInto: 'Your Gate spot balance.',
} as const;

export const VERDICT_NO_BORROW = 'No borrow. Rebalance saves nothing today.';
export const VERDICT_BALANCED = 'Every wallet is on its share. Nothing to move.';
export const VERDICT_REPAYS = (amountText: string) => `Repays ${amountText}.`;
export const VERDICT_STOPS = (perDayText: string) => `Stops ${perDayText} a day of interest.`;
export const VERDICT_STOPS_UNDER_A_CENT = 'Stops less than $0.01 a day of interest.';
export const VERDICT_FREE = 'This borrow is free today.';
export const VERDICT_REPAYS_NOTHING = 'Rebalance evens the wallets. It repays no borrow.';

export const FACT_BORROWING = 'Borrowing';
export const FACT_INTEREST_NOW = 'Interest now';
export const FACT_INTEREST_PAID = 'Interest paid';
export const FACT_LIQUIDATION = 'Liquidation';

export const BAR_CAPTION = 'Now against target';
export const SHARE_CAPTION = 'Position share';
export const GATE_SPOT = 'Gate spot';

export const HOVER_CASH = 'Cash';
export const HOVER_UPNL = 'Unrealized PnL';
export const HOVER_TARGET = 'Balanced equity';

export const MODAL_CHANGE_ROUTE = 'Change route';
export const MODAL_KEEP_ROUTE = 'Keep the recommended one';
export const MODAL_AFTER = 'After rebalance';
export const MODAL_FREES = 'Frees';
export const MODAL_SAVES = 'Saves';
export const MODAL_STEPS = 'Show the steps';
export const MODAL_HOLD = 'Hold to rebalance';
export const MODAL_RESUME = 'Resume';
export const MODAL_ABANDON = 'Abandon';

export const WAITS_FOR_TRANSFER = 'Waits for the transfer';
export const WAITS_FOR_DEAL = 'Waits for the deal';

export const TRANSFER_CTA = 'Move money';

export const HYPERLIQUID_FREE_LINE = 'free to 10,000';
export const INTEREST_PAID_ALL_TIME = 'all time';
export const NO_FREE_PART = 'all of it pays interest';
export const RATE_UNKNOWN = 'rate unknown';
