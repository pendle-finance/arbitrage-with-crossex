import type { CrossexAccount, PositionsResponse } from '../../../web/src/api/types';
import { gateNumber } from '../../../web/src/lib/liquidation';
import { CoreError } from '../errors';
import { HYPERLIQUID_FREE_BORROW_USDC, LIGHTER_WALLET, USDC_WALLET, USDT_WALLET } from '../rebalance/plan';
import type { TriggerCoin, Wallet } from './triggers';

export { HYPERLIQUID_FREE_BORROW_USDC };

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
  const equity = gateNumber(asset.equity);
  if (equity === null) {
    throw new CoreError(`Gate sent a ${rule.coin} ${rule.venue} wallet equity that is not a number: ${asset.equity}`, 'unknown');
  }
  return equity;
}

function nearestBeyond(
  mark: number,
  candidates: Array<{ price: number; wallet: Wallet }>,
  beyond: (price: number) => boolean,
): { price: number; wallet: Wallet } | null {
  if (candidates.length === 0) return null;
  const pool = candidates.some((c) => beyond(c.price)) ? candidates.filter((c) => beyond(c.price)) : candidates;
  return pool.reduce((best, c) => (Math.abs(c.price - mark) < Math.abs(best.price - mark) ? c : best));
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
  const downs: Array<{ price: number; wallet: Wallet }> = [];
  const ups: Array<{ price: number; wallet: Wallet }> = [];
  for (const rule of WALLET_RULES) {
    const exposure = legs
      .filter((l) => walletRuleOf(l.exchange) === rule)
      .reduce((sum, l) => sum + (l.side === 'LONG' ? l.value : -l.value), 0);
    if (exposure === 0) continue;
    const factor = 1 + (rule.threshold - equityOf(acc, rule)) / exposure;
    if (!(factor > 0)) continue;
    const price = mark * factor;
    if (exposure > 0) downs.push({ price, wallet: rule.wallet });
    else ups.push({ price, wallet: rule.wallet });
  }
  prices.down = nearestBeyond(mark, downs, (p) => p <= mark);
  prices.up = nearestBeyond(mark, ups, (p) => p >= mark);
  return prices;
}
