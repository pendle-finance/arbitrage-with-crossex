import type { CrossexAccount, PositionsResponse } from '../../../web/src/api/types';
import { liquidationSides, type LiquidationSide, type MarginTiers } from '../../../web/src/lib/liquidation';
import { SUPPORTED_COINS, type SupportedCoin } from '../coins';
import { CoreError } from '../errors';
import { rememberMarks } from '../marks';
import { interestPrices } from './interestPrice';

export type Venue = string;

export type Wallet = 'USDT' | 'HYPERLIQUID' | 'LIGHTER';

export interface TriggerRoll {
  longVenue: string;
  shortVenue: string;
  maturity: number;
  targets: Array<{ maturity: number; apr: number; currentApr: number }>;
}

export interface TriggerCoin {
  coin: SupportedCoin;
  legs: Array<{ venue: Venue; side: 'long' | 'short' }>;
  liquidation: { down: { price: number; venue: Venue } | null; up: { price: number; venue: Venue } | null };
  liquidationUnknown?: boolean;
  interest: { down: { price: number; wallet: Wallet } | null; up: { price: number; wallet: Wallet } | null };
  rolls: TriggerRoll[];
}

const BOROS_EXCHANGE = 'BOROS';

function triggerOf(side: LiquidationSide | null): { price: number; venue: Venue } | null {
  return side === null ? null : { price: side.price, venue: side.exchange };
}

export function buildTriggerCoins(
  acc: CrossexAccount,
  positions: PositionsResponse,
  tiers: MarginTiers = {},
): TriggerCoin[] {
  const { rows, unknown } = rememberMarks(positions.positions);
  const crossex: PositionsResponse = {
    positions: rows,
    exposure: positions.exposure.map((g) => ({ ...g, legs: g.legs.filter((l) => l.exchange !== BOROS_EXCHANGE) })),
  };
  const coins: TriggerCoin[] = [];
  for (const group of crossex.exposure) {
    const coin = SUPPORTED_COINS.find((c) => c === group.base.toUpperCase());
    const legs = group.legs.filter((l) => l.value > 0);
    if (coin === undefined || legs.length === 0) continue;
    const sides = liquidationSides(acc, crossex, group.base, tiers);
    if (sides === null) {
      throw new CoreError(
        `Gate sent a margin balance or maintenance margin that is not a number: ${acc.marginBalance}, ${acc.maintenanceMargin}`,
        'unknown',
      );
    }
    const blind = legs.some((l) => unknown.has(l.symbol));
    coins.push({
      coin,
      legs: legs.map((l) => ({ venue: l.exchange, side: l.side === 'LONG' ? 'long' : 'short' })),
      liquidation: blind ? { down: null, up: null } : { down: triggerOf(sides.down), up: triggerOf(sides.up) },
      ...(blind ? { liquidationUnknown: true as const } : {}),
      interest: interestPrices(acc, crossex, group.base),
      rolls: [],
    });
  }
  return coins;
}
