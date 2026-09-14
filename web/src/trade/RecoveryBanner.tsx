/** Deal recovery banner. Two cases:
 *  - a deal STILL WORKING after a tab reload — the modal was lost with the page
 *    and the user needs a way back into the live view (shown first: real orders
 *    are moving server-side).
 *  - standing engine ALERTS (hedge walls, quarantined orders, halted deals) —
 *    rendered until acked; the engine keeps retrying underneath. */
import { useAckAlert, useActiveDeals, useAlerts } from '../api/queries';
import { Spinner } from '../components/Spinner';
import { useTradeFlow } from './TradeFlow';

export function RecoveryBanner({ onOpenTab }: { onOpenTab?: (tab: 'balances') => void }) {
  const flow = useTradeFlow();
  const active = useActiveDeals();
  const alerts = useAlerts();
  const ack = useAckAlert();

  // A single resting limit order (no hedge leg, no deadline) is a plain order,
  // not a deal in flight — it lives in Open Orders and needs no supervision.
  // Nagging about it here is what made placing one feel like starting a process.
  // Anything that has actually gone wrong still surfaces through `standing`.
  const deals = (active.data ?? []).filter(
    (d) => !(d.pair.b === null && d.pair.limitPrice !== null && d.pair.mode === 'OPENING'),
  );
  const standing = alerts.data ?? [];

  if (!flow.modalOpen && deals.length > 0) {
    const newest = [...deals].sort((a, b) => b.pair.createdAt - a.pair.createdAt)[0];
    const halted = deals.filter((d) => d.pair.mode === 'HALTED').length;
    return (
      <div
        role="alert"
        className={`border-b ${halted ? 'border-rose-500/40 bg-rose-500/10' : 'border-cyan-500/30 bg-cyan-500/10'}`}
      >
        <div
          className={`mx-auto flex max-w-[1500px] flex-wrap items-center gap-3 px-5 py-2 text-xs ${halted ? 'text-rose-200' : 'text-cyan-200'}`}
        >
          <span className="inline-flex items-center gap-2">
            <Spinner className="h-3 w-3" />
            {halted
              ? `${halted} deal${halted === 1 ? ' is' : 's are'} HALTED. Operator needed.`
              : `A deal is still working${deals.length > 1 ? ` (+${deals.length - 1} more)` : ''}`}
          </span>
          <button
            type="button"
            className={`btn-ghost-xs ${halted ? 'border-rose-500/50 text-rose-300' : 'border-cyan-500/50 text-cyan-300'}`}
            onClick={() => flow.openDeal((deals.find((d) => d.pair.mode === 'HALTED') ?? newest).pair.id)}
          >
            View
          </button>
        </div>
      </div>
    );
  }

  if (standing.length === 0) return null;
  const alert = standing[0];
  const isRebalance = alert.pairId?.startsWith('rebalance:') ?? false;
  return (
    <div role="alert" className="border-b border-amber-500/30 bg-amber-500/10">
      <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-3 px-5 py-2 text-xs text-amber-200">
        <span>
          {alert.message}
          {standing.length > 1 ? ` (+${standing.length - 1} more)` : ''}
        </span>
        {isRebalance
          ? onOpenTab && (
              <button
                type="button"
                className="btn-ghost-xs border-amber-500/50 text-amber-300"
                onClick={() => onOpenTab('balances')}
              >
                View
              </button>
            )
          : alert.pairId && (
              <button
                type="button"
                className="btn-ghost-xs border-amber-500/50 text-amber-300"
                onClick={() => flow.openDeal(alert.pairId!)}
              >
                View
              </button>
            )}
        <button type="button" className="btn-ghost-xs" onClick={() => ack.mutate(alert.id)}>
          ack
        </button>
      </div>
    </div>
  );
}
