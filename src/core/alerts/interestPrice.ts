import type { CrossexAccount, PositionsResponse } from '../../../web/src/api/types';
import { CoreError } from '../errors';
import { HYPERLIQUID_FREE_BORROW_USDC, LIGHTER_WALLET, USDC_WALLET, USDT_WALLET } from '../rebalance/plan';
import type { TriggerCoin, Wallet } from './triggers';

export { HYPERLIQUID_FREE_BORROW_USDC };
const PRICE_FLOOR = 0.02;
const PRICE_CEILING = 10;

interface WalletRule {
  wallet: Wallet;
  coin: string;
  venue: string;
  threshold: number;
}

const USDT_RULE: WalletRule = { wallet: 'USDT', ...USDT_WALLET, threshold: 0 };

const WALLET_RULES: readonly WalletRule[] = [
  USDT_RULE,
  { wallet: 'HYPERLIQUID', ...USDC_WALLET, threshold: -HYPERLIQUID_FREE_BORROW_USDC },
  { wallet: 'LIGHTER', ...LIGHTER_WALLET, threshold: 0 },
];

function walletRuleOf(exchange: string): WalletRule {
  return WALLET_RULES.find((rule) => rule.venue === exchange) ?? USDT_RULE;
}

function equityOf(acc: CrossexAccount, rule: WalletRule): number {
  const asset = acc.assets.find((a) => a.coin === rule.coin && a.exchangeType === rule.venue);
  if (!asset) return 0;
  const equity = Number(asset.equity);
  if (!Number.isFinite(equity)) {
    throw new CoreError(`Gate sent a ${rule.coin} ${rule.venue} wallet equity that is not a number: ${asset.equity}`, 'unknown');
  }
  return equity;
}

export function interestPrices(
  acc: CrossexAccount,
  positions: PositionsResponse,
  base: string,
): TriggerCoin['interest'] {
  const prices: TriggerCoin['interest'] = { down: null, up: null };
  const marks = new Map(positions.positions.map((p) => [p.symbol, Number(p.markPrice)]));
  const upper = base.toUpperCase();
  const legs = (positions.exposure.find((g) => g.base.toUpperCase() === upper)?.legs ?? []).filter(
    (l) => l.value > 0 && marks.has(l.symbol),
  );
  if (legs.length === 0) return prices;
  const mark = marks.get(legs.reduce((a, b) => (b.value > a.value ? b : a)).symbol) ?? 0;
  if (!(mark > 0)) return prices;
  for (const rule of WALLET_RULES) {
    const exposure = legs
      .filter((l) => walletRuleOf(l.exchange) === rule)
      .reduce((sum, l) => sum + (l.side === 'LONG' ? l.value : -l.value), 0);
    if (exposure === 0) continue;
    const factor = 1 + (rule.threshold - equityOf(acc, rule)) / exposure;
    if (!(factor >= PRICE_FLOOR && factor <= PRICE_CEILING)) continue;
    const price = mark * factor;
    if (exposure > 0) {
      if (prices.down === null || price > prices.down.price) prices.down = { price, wallet: rule.wallet };
      continue;
    }
    if (prices.up === null || price < prices.up.price) prices.up = { price, wallet: rule.wallet };
  }
  return prices;
}
