import type { GoalKind, Pool } from '../api/types';
import { t } from '../i18n';
import { num, WALLET_SHORT } from '../lib/fmt';

export const roundCount = (n: number) => t('accounts.rebalance.rounds', { count: n, n: num(n, 0) });

export const WALLET_LABEL: Readonly<Record<string, string>> = {
  'USDT/CROSSEX': 'USDT · CrossEx',
  'USDC/HYPERLIQUID': 'USDC · Hyperliquid',
  'USDC/LIGHTER': 'USDC · Lighter',
  'USDC/GATE': 'USDC · Gate',
};

export const poolKey = (pool: Pool): string => (pool === 'CROSSEX' ? 'USDT/CROSSEX' : `USDC/${pool}`);

const venueWallet = (pool: Pool): string => t('accounts.rebalance.venueWallet', { name: WALLET_SHORT[poolKey(pool)] });

export const LEG_TEXT: Readonly<Record<string, string>> = {
  get 'Buy USDC'() { return t('accounts.rebalance.leg.buyUsdc'); },
  get 'To spot'() { return t('accounts.rebalance.leg.toSpot'); },
  get 'To Hyperliquid'() { return t('accounts.rebalance.leg.toHyperliquid'); },
  get 'To Lighter'() { return t('accounts.rebalance.leg.toLighter'); },
  get 'From Hyperliquid'() { return t('accounts.rebalance.leg.fromHyperliquid'); },
  get 'From Lighter'() { return t('accounts.rebalance.leg.fromLighter'); },
  get 'To Gate'() { return t('accounts.rebalance.leg.toGate'); },
  get 'Sell USDC'() { return t('accounts.rebalance.leg.sellUsdc'); },
};

export const noLegs = () => t('accounts.rebalance.noLegs');

/** The two presets and the custom move, as the dialog names them: what each
 * one does to the wallets, since "Rebalance" is the dialog they sit in. */
export const GOAL_LABEL: Readonly<Record<GoalKind, string>> = {
  get even() { return t('accounts.rebalance.goal.even'); },
  get repay() { return t('accounts.rebalance.goal.repay'); },
  get custom() { return t('accounts.rebalance.goal.custom'); },
};
/** The card's button and its job lines: the feature's own name when it leads
 * with the position split, the preset's when it leads with the debt. */
export const CARD_LABEL: Readonly<Record<GoalKind, string>> = {
  get even() { return t('accounts.rebalance.card.even'); },
  get repay() { return t('accounts.rebalance.card.repay'); },
  get custom() { return t('accounts.rebalance.card.custom'); },
};
export const PRESET_OFF: Readonly<Record<'even' | 'repay', string>> = {
  get even() { return t('accounts.rebalance.presetOff.even'); },
  get repay() { return t('accounts.rebalance.presetOff.repay'); },
};
export const usePresetText = () => t('accounts.rebalance.usePreset');
export const moveText = () => t('accounts.rebalance.move');
export const moveFromText = () => t('accounts.rebalance.moveFrom');
export const moveToText = () => t('accounts.rebalance.moveTo');
export const nothingToMove = () => t('accounts.rebalance.nothingToMove');
export const shortOfCash = () => t('accounts.rebalance.shortOfCash');
export const HOLD_LABEL: Readonly<Record<GoalKind, string>> = {
  get even() { return t('accounts.rebalance.hold.even'); },
  get repay() { return t('accounts.rebalance.hold.repay'); },
  get custom() { return t('accounts.rebalance.hold.custom'); },
};
/** The confirm when the verdict does not ask for the move: the trader may
 * still run it, but the button no longer reads as the recommended step. */
export const HOLD_ANYWAY_LABEL: Readonly<Record<GoalKind, string>> = {
  get even() { return t('accounts.rebalance.holdAnyway.even'); },
  get repay() { return t('accounts.rebalance.holdAnyway.repay'); },
  get custom() { return t('accounts.rebalance.holdAnyway.custom'); },
};
/** Under a "nothing to save" verdict in the dialog, where a fee is priced
 * right below it: the move is a choice, and this is what it costs. */
export const OPTIONAL_MOVE = (goal: GoalKind, fee: string | null): string =>
  fee === null ? t(`accounts.rebalance.optional.${goal}`) : t(`accounts.rebalance.optionalFee.${goal}`, { fee });
export const AFTER_LABEL: Readonly<Record<GoalKind, string>> = {
  get even() { return t('accounts.rebalance.after.even'); },
  get repay() { return t('accounts.rebalance.after.repay'); },
  get custom() { return t('accounts.rebalance.after.custom'); },
};

export const MOVE_TEXT = {
  step: (from: Pool, to: Pool, move: string, arrives: string): string => {
    if (to === 'CROSSEX') return t('accounts.rebalance.moveText.stepOut', { move, from: venueWallet(from), arrives });
    return t('accounts.rebalance.moveText.step', { move, from: venueWallet(from), to: venueWallet(to) });
  },
  into: (to: Pool): string => venueWallet(to),
  convert: (from: Pool, to: Pool, move: string): string => {
    if (from === 'CROSSEX') return t('accounts.rebalance.moveText.convertIn', { move, to: venueWallet(to) });
    if (to === 'CROSSEX') return t('accounts.rebalance.moveText.convertOut', { move, from: venueWallet(from) });
    return t('accounts.rebalance.moveText.convertAcross', { move, from: venueWallet(from), to: venueWallet(to) });
  },
  loop: (moves: readonly { from: Pool; to: Pool }[]): string[] => {
    const wallets = (pools: Pool[]) =>
      pools.map(venueWallet).reduce((a, b) => t('accounts.rebalance.moveText.and', { a, b }));
    const into = moves.filter((move) => move.from === 'CROSSEX').map((move) => move.to);
    const out = moves.filter((move) => move.to === 'CROSSEX').map((move) => move.from);
    const across = moves.filter((move) => move.from !== 'CROSSEX' && move.to !== 'CROSSEX');
    return [
      ...(into.length > 0 ? [t('accounts.rebalance.moveText.loopInto', { wallets: wallets(into) })] : []),
      ...(out.length > 0 ? [t('accounts.rebalance.moveText.loopOut', { wallets: wallets(out) })] : []),
      ...across.map((move) =>
        t('accounts.rebalance.moveText.loopAcross', { from: venueWallet(move.from), to: venueWallet(move.to) }),
      ),
    ];
  },
};

const h = (key: string): string => t(`accounts.rebalance.hover.${key}` as 'accounts.rebalance.hover.now');

export const HOVER = {
  rebalanceTitle: {
    get equity() { return h('title.equity'); },
    get walletHead() {
      return { wallet: h('title.walletHead.wallet'), legs: h('title.walletHead.legs'), interest: h('title.walletHead.interest') };
    },
    get wallets() {
      return [
        { wallet: 'USDT · CrossEx', legs: 'Gate, Binance, OKX, Bybit', interest: h('title.interest.usdt') },
        { wallet: 'USDC · Hyperliquid', legs: 'Hyperliquid', interest: h('title.interest.hyperliquid') },
        { wallet: 'USDC · Lighter', legs: 'Lighter', interest: h('title.interest.lighter') },
      ];
    },
    get borrow() { return h('title.borrow'); },
    get rounds() { return h('title.rounds'); },
    get routeHead() {
      return { route: h('title.routeHead.route'), path: h('title.routeHead.path'), time: h('title.routeHead.time'), cost: h('title.routeHead.cost') };
    },
    get routes() {
      const min = (n: string) => h(`title.time.min${n}`);
      const from = (usd: string) => t('accounts.rebalance.hover.title.costFrom', { usd });
      return [
        {
          route: h('title.spotLoop'),
          paths: [
            { path: h('title.path.usdtToHyperliquid'), time: min('2'), cost: from('$0.05') },
            { path: h('title.path.hyperliquidToUsdt'), time: min('6_5'), cost: from('$1.00') },
            { path: h('title.path.usdtToLighter'), time: min('4'), cost: from('$1.03') },
            { path: h('title.path.lighterToUsdt'), time: min('3'), cost: from('$0') },
            { path: h('title.path.hyperliquidToLighter'), time: min('10'), cost: from('$2.03') },
            { path: h('title.path.lighterToHyperliquid'), time: min('5'), cost: from('$0.05') },
          ],
        },
        {
          route: h('title.convert'),
          paths: [
            { path: 'USDT ↔ USDC', time: h('title.time.instant'), cost: '0.2%' },
            { path: 'Hyperliquid ↔ Lighter', time: h('title.time.instant'), cost: h('title.twoSwaps') },
          ],
        },
      ];
    },
    get recommended() { return h('title.recommended'); },
  },
  get presets() { return h('presets'); },
  get custom() { return h('custom'); },
  get walletUsdt() { return h('walletUsdt'); },
  get walletUsdc() { return h('walletUsdc'); },
  get walletLighter() { return h('walletLighter'); },
  get walletGate() { return h('walletGate'); },
  get now() { return h('now'); },
  interestNow: {
    get lead() { return h('interestNow.lead'); },
    get head() {
      return { wallet: h('interestNow.head.wallet'), interest: h('interestNow.head.interest'), rate: h('interestNow.head.rate') };
    },
    get wallets() {
      return [
        { key: 'USDT/CROSSEX', interest: h('interestNow.usdt') },
        { key: 'USDC/HYPERLIQUID', interest: h('interestNow.hyperliquid') },
        { key: 'USDC/LIGHTER', interest: h('interestNow.lighter') },
      ];
    },
  },
  get borrowing() { return h('borrowing'); },
  get route() { return h('route'); },
  mix: (cap: number) => t('accounts.rebalance.hover.mix', { rounds: roundCount(cap) }),
  get recommended() { return h('recommended'); },
  get noDirectTransfer() { return h('noDirectTransfer'); },
  get repeats() { return h('repeats'); },
  get convert() { return h('convert'); },
  get convertAcross() { return h('convertAcross'); },
  get round() { return h('round'); },
  get whyMoreThanOne() { return h('whyMoreThanOne'); },
  whyMoreThanOneBorrow: (amountText: string) => t('accounts.rebalance.hover.whyMoreThanOneBorrow', { amount: amountText }),
  get frees() { return h('frees'); },
  get interestMonth() { return h('interestMonth'); },
  get onTheWay() { return h('onTheWay'); },
  get gateSpot() { return h('gateSpot'); },
  get gateSpotAssets() { return h('gateSpotAssets'); },
  get abandon() { return h('abandon'); },
  get fee() { return h('fee'); },
  get time() { return h('time'); },
  get minimum() { return h('minimum'); },
  get upToOut() { return h('upToOut'); },
  get upToInto() { return h('upToInto'); },
};

const v = (key: string): string => t(`accounts.rebalance.verdict.${key}` as 'accounts.rebalance.verdict.noBorrow');

export const verdictNoBorrow = () => v('noBorrow');
export const verdictBalanced = () => v('balanced');
/** The even split is off, but what would move is margin for open positions,
 * so nothing can. A warning, and no amount: the figure read as a to-do. */
export const verdictNoCashToMove = () => v('noCashToMove');
/** Borrowing, but inside a wallet's interest-free allowance, so it costs
 * nothing today. Distinct from NOT_WORTH_IT: that one weighs a fee against
 * real interest, and weighing it against zero produced a verdict that
 * contradicted the "$0.00 an hour" figure beside it. */
export const verdictNoInterest = () => v('noInterest');
/** A borrow whose rate Gate did not return. Silence here read as "nothing to
 * do" while the dialog still priced a fee beside it, so the card says plainly
 * that the reading failed. */
export const verdictRateUnknown = () => v('rateUnknown');
export const verdictNotWorthIt = () => v('notWorthIt');
/** Each verdict names WHICH move it judges. Two presets move different amounts
 * for the same interest, so an unsubjected sentence on the card read as a
 * contradiction of the dialog's. */
export const verdictWorthIt = () => v('worthIt');
export const verdictRepayWorthIt = () => v('repayWorthIt');
/** With no legs there is no fee-versus-interest question: the borrow locks
 * the cash, so it is repaid regardless of what the move costs. */
export const verdictRepayNoLegsSub = () => v('repayNoLegsSub');
export const PAYS_BACK = (daysText: string) => t('accounts.rebalance.verdict.paysBack', { days: daysText });

export const factBorrowing = () => t('accounts.rebalance.fact.borrowing');
export const factInterestNow = () => t('accounts.rebalance.fact.interestNow');
export const factInterestPaid = () => t('accounts.rebalance.fact.interestPaid');

export const gateSpot = () => t('accounts.rebalance.gateSpot');

export const hoverCash = () => t('accounts.rebalance.bar.cash');
export const hoverUpnl = () => t('accounts.rebalance.bar.upnl');
export const hoverTarget = () => t('accounts.rebalance.bar.target');

export const MODAL_FEE = (usdText: string) => t('accounts.rebalance.modal.feeUsd', { usd: usdText });
export const modalFrees = () => t('accounts.rebalance.modal.frees');
export const modalInterest = () => t('accounts.rebalance.modal.interest');
export const modalFeeLabel = () => t('accounts.rebalance.modal.fee');
export const PER_MONTH = (nowText: string, afterText: string) =>
  t('accounts.rebalance.modal.perMonth', { now: nowText, after: afterText });
export const modalSteps = () => t('accounts.rebalance.modal.steps');
/** Replaces the confirm while the quote is stale: the plan moved under the
 * dialog, so the only next step is to price the new one. */
export const modalRefreshRoute = () => t('accounts.rebalance.modal.refreshRoute');
export const modalResume = () => t('accounts.rebalance.modal.resume');
export const modalAbandon = () => t('accounts.rebalance.modal.abandon');

export const waitsForTransfer = () => t('accounts.rebalance.waits.transfer');
export const waitsForDeal = () => t('accounts.rebalance.waits.deal');
export const waitsForRebalance = () => t('accounts.rebalance.waits.rebalance');
export const waitsForStoppedRebalance = () => t('accounts.rebalance.waits.stoppedRebalance');

export const transferCta = () => t('accounts.rebalance.transferCta');

export const rateUnknown = () => t('accounts.rebalance.rateUnknown');
export const INTEREST_PER_HOUR = (usdText: string) => t('accounts.rebalance.interestPerHour', { usd: usdText });
export const RATE_PER_YEAR = (pctText: string) => t('accounts.rebalance.ratePerYear', { pct: pctText });
