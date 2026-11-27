import type { Store } from '../engine/db';
import { hasMarginRefusalLabel, project } from '../engine/decide';
import { TUNING, type PairRow } from '../engine/types';

export const isWalledStop = (store: Store, pair: PairRow): boolean =>
  pair.mode === 'STOPPING' &&
  pair.b !== null &&
  pair.b.reduceOnly !== true &&
  pair.hedgeRejectStreak >= TUNING.HEDGE_REJECT_HALT &&
  !project(pair, store.listOrders(pair.id)).anyPending;

export function haltWalled(store: Store, pair: PairRow): void {
  const lastHedge = store.listOrders(pair.id).filter((order) => order.leg === 'B').at(-1);
  store.updatePair(pair.id, {
    mode: 'HALTED',
    haltKind: lastHedge && hasMarginRefusalLabel(lastHedge) ? 'hedge-margin' : null,
  });
}
