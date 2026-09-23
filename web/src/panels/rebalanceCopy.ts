import type { GoalKind, Pool } from '../api/types';
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

/** The two presets and the custom move, as the dialog names them: what each
 * one does to the wallets, since "Rebalance" is the dialog they sit in. */
export const GOAL_LABEL: Readonly<Record<GoalKind, string>> = { even: 'Balance positions', repay: 'Clear debt', custom: 'Custom amount' };
/** The card's button and its job lines: the feature's own name when it leads
 * with the position split, the preset's when it leads with the debt. */
export const CARD_LABEL: Readonly<Record<GoalKind, string>> = { even: 'Rebalance', repay: 'Clear debt', custom: 'Custom move' };
export const PRESET_OFF: Readonly<Record<'even' | 'repay', string>> = { even: 'No open positions', repay: 'No borrow' };
export const USE_PRESET = 'Use a preset';
export const MOVE = 'Move';
export const MOVE_FROM = 'from';
export const MOVE_TO = 'to';
export const NOTHING_TO_MOVE = 'Nothing to move.';
export const SHORT_OF_CASH = 'more than the wallet holds.';
export const HOLD_LABEL: Readonly<Record<GoalKind, string>> = { even: 'Hold to rebalance', repay: 'Hold to clear debt', custom: 'Hold to move' };
export const AFTER_LABEL: Readonly<Record<GoalKind, string>> = { even: 'After rebalance', repay: 'After clearing debt', custom: 'After the move' };

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
  presets:
    'Balance positions splits equity by position size. Clear debt moves just enough to bring every negative wallet to zero, from the wallet with the most equity. Custom amount moves what you type.',
  custom: 'Moves this amount out of one CrossEx wallet into another. Fees come off what lands.',
  walletUsdt: 'CrossEx wallet. Margin for Gate, Binance, OKX and Bybit legs.',
  walletUsdc: 'CrossEx wallet. Margin for Hyperliquid legs.',
  walletLighter: 'CrossEx wallet. Margin for Lighter legs.',
  walletGate: 'CrossEx wallet. USDC left from a spot buy. Still margin. Rebalance empties it.',
  now: 'Equity = cash + unrealized PnL.',
  interestNow: {
    lead: 'Gate charges interest every hour when a CrossEx wallet is negative.',
    head: { wallet: 'Wallet', interest: 'Interest', rate: 'Rate now' },
    wallets: [
      { key: 'USDT/CROSSEX', interest: 'from the first dollar' },
      { key: 'USDC/HYPERLIQUID', interest: 'free to 10,000 USDC, then on the part over' },
      { key: 'USDC/LIGHTER', interest: 'from the first dollar' },
    ],
  },
  borrowing: 'A negative wallet is a borrow. The Margin card at the top shows the initial margin it locks.',
  route: 'How the money moves. The fee includes Gate fees and the spot spread. Spot loop runs until the move is done, however many rounds that takes.',
  mix: (cap: number) => `Spot loop for up to ${roundCount(cap)}, then Convert the rest.`,
  recommended: 'Cheapest route that takes 15 min or less.',
  noDirectTransfer: 'Gate has no direct transfer between CrossEx wallets.',
  repeats: 'Repeats in rounds.',
  convert: 'Instant swap between your CrossEx USDT and USDC wallets. 0.2% fee.',
  convertAcross: 'USDC between Hyperliquid and Lighter swaps twice, through USDT.',
  round: 'A round is one trip through Gate spot, capped by your free margin.',
  whyMoreThanOne: 'A move bigger than your free margin takes more than one.',
  whyMoreThanOneBorrow: (amountText: string) =>
    `Gate locks ${amountText} of initial margin for your borrow. Each round repays some borrow, so the next round is bigger.`,
  frees: 'Initial margin the repaid borrow no longer locks.',
  interestMonth: "Borrow interest for 30 days at today's rates, now and after this rebalance.",
  onTheWay: 'In transit through Gate spot. Not margin.',
  gateSpot: 'Not margin.',
  gateSpotAssets: 'Not margin. No equity or PnL.',
  abandon: 'Stop the run. Funds stay where they are.',
  fee: 'Gate fee for this move.',
  time: 'Typical time. Moves into or out of the CrossEx Hyperliquid and Lighter wallets can take longer.',
  minimum: 'Gate minimum for moves into or out of the CrossEx Hyperliquid and Lighter wallets. Fee included.',
  upToOut: "Free margin, capped at this wallet's cash.",
  upToInto: 'Your Gate spot balance.',
} as const;

export const VERDICT_NO_BORROW = 'No borrow. No transfer or rebalancing necessary.';
export const VERDICT_BALANCED = 'Wallets match their position share. Nothing to move.';
/** The even split is off, but what would move is margin for open positions,
 * so nothing can. A warning, and no amount: the figure read as a to-do (his
 * call 2026-09-23). */
export const VERDICT_NO_CASH_TO_MOVE = 'Equity unbalanced but no available cash to move';
/** Borrowing, but inside a wallet's interest-free allowance, so it costs
 * nothing today. Distinct from NOT_WORTH_IT: that one weighs a fee against
 * real interest, and weighing it against zero produced a verdict that
 * contradicted the "$0.00 an hour" figure beside it. */
export const VERDICT_NO_INTEREST = 'No interest payment yet. No transfer or rebalancing necessary.';
/** A borrow whose rate Gate did not return. Silence here read as "nothing to
 * do" while the dialog still priced a fee beside it, so the card says plainly
 * that the reading failed (his call 2026-09-19). */
export const VERDICT_RATE_UNKNOWN = 'Could not read the borrow interest rate. Check the fee before you move anything.';
export const VERDICT_NOT_WORTH_IT = 'Not worth it yet. The fee is more than 30 days of the interest it saves.';
/** Each verdict names WHICH move it judges. Two presets move different amounts
 * for the same interest, so an unsubjected sentence on the card read as a
 * contradiction of the dialog's (his catch 2026-09-19). */
export const VERDICT_WORTH_IT = 'Rebalance recommended.';
export const VERDICT_REPAY_WORTH_IT = 'Clear debt recommended.';
/** With no legs there is no fee-versus-interest question: the borrow locks
 * the cash, so it is repaid regardless of what the move costs. */
export const VERDICT_REPAY_NO_LEGS_SUB = 'Debt prevents you from withdrawing your cash.';
export const PAYS_BACK = (daysText: string) => `The fee equals ${daysText} of the interest it saves.`;

export const FACT_BORROWING = 'Borrowing';
export const FACT_INTEREST_NOW = 'Interest now';
export const FACT_INTEREST_PAID = 'Interest paid';
export const FACT_LIQUIDATION = 'Liquidation';
export const LIQUIDATION_NOT_KNOWN = 'unknown';

export const BAR_CAPTION = 'Equity (cash + unrealized PnL)';
export const GATE_SPOT = 'Gate spot';

export const HOVER_CASH = 'Cash';
export const HOVER_UPNL = 'Unrealized PnL';
export const HOVER_TARGET = 'Balanced target';

export const MODAL_ALL_ROUTES = 'Show all routes';
export const MODAL_FEE = (usdText: string) => `Fee ${usdText}`;
export const MODAL_AFTER = 'After rebalance';
export const MODAL_FREES = 'Frees';
export const MODAL_INTEREST = 'Interest';
export const MODAL_FEE_LABEL = 'Fee';
export const PER_MONTH = (nowText: string, afterText: string) => `${nowText} → ${afterText} a month`;
export const MODAL_STEPS = 'Show steps';
export const MODAL_HOLD = 'Hold to rebalance';
/** Replaces the confirm while the quote is stale: the plan moved under the
 * dialog, so the only next step is to price the new one. */
export const MODAL_REFRESH_ROUTE = 'Refresh route';
export const MODAL_RESUME = 'Resume';
export const MODAL_ABANDON = 'Abandon';

export const WAITS_FOR_TRANSFER = 'Transfer running';
export const WAITS_FOR_DEAL = 'Deal running';
export const WAITS_FOR_REBALANCE = 'Rebalance running';
export const WAITS_FOR_STOPPED_REBALANCE = 'Rebalance stopped';

export const TRANSFER_CTA = 'Manual Transfer';

export const RATE_UNKNOWN = 'rate unknown';
export const INTEREST_PER_HOUR = (usdText: string) => `${usdText} an hour`;
export const RATE_PER_YEAR = (pctText: string) => `${pctText}% a year`;
