import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useStartTransfer, useTransfer } from '../api/queries';
import type { TransferJob, TransferLock } from '../api/types';
import { useToast } from '../components/Toast';
import { num } from '../lib/fmt';
import { useSettledError } from '../lib/useSettledError';
import { TRANSFER_CTA, WAITS_FOR_DEAL, WAITS_FOR_REBALANCE, WAITS_FOR_STOPPED_REBALANCE } from './rebalanceCopy';
import { destinationOf } from './TransferBits';
import { TransferModal, type TransferPick } from './TransferModal';

const LOCK_SHORT: Record<TransferLock, string> = {
  rebalance: WAITS_FOR_REBALANCE,
  halted: WAITS_FOR_STOPPED_REBALANCE,
  deal: WAITS_FOR_DEAL,
};

function doneText(transfer: TransferJob): string {
  const sent = `Sent ${num(transfer.amount)} ${transfer.coin} ${destinationOf(transfer.to)}.`;
  return transfer.received === null ? sent : `${sent} ${num(transfer.received)} arrived.`;
}

export function TransferSection({ holdMs, pick }: { holdMs?: number; pick?: TransferPick | null }) {
  const query = useTransfer();
  const start = useStartTransfer();
  const [open, setOpen] = useState(false);
  const [modalPick, setModalPick] = useState<TransferPick | null>(null);
  const appliedNonce = useRef<number | null>(null);
  const seenMoving = useRef(new Set<string>());
  const { push } = useToast();
  const loadError = useSettledError(query.status, query.error);
  const view = query.data;
  const job = view?.transfer ?? null;

  useEffect(() => {
    if (!pick || pick.nonce === appliedNonce.current) return;
    appliedNonce.current = pick.nonce;
    setModalPick(pick);
    setOpen(true);
  }, [pick]);

  useEffect(() => {
    if (!job) return;
    const { id } = job;
    if (job.status === 'moving') {
      seenMoving.current.add(id);
      return;
    }
    if (job.status !== 'done' || !seenMoving.current.has(id)) return;
    const text = doneText(job);
    const fire = () => {
      if (document.visibilityState !== 'visible' || !seenMoving.current.delete(id)) return;
      push('success', text);
    };
    fire();
    document.addEventListener('visibilitychange', fire);
    return () => document.removeEventListener('visibilitychange', fire);
  }, [job, push]);

  if (!view) {
    if (!loadError) return null;
    return (
      <div role="group" aria-label="Transfer" className="flex items-center gap-2">
        <p role="alert" className="text-xs text-rose-300">
          Could not load transfers. {loadError.message}
        </p>
        <button type="button" className="btn-ghost-xs leading-4" onClick={() => void query.refetch()}>
          Retry
        </button>
      </div>
    );
  }

  const moving = job?.status === 'moving' ? job : null;
  const failed = job !== null && job.status === 'failed' && job.failText !== null ? job : null;

  const openModal = () => {
    setModalPick(null);
    setOpen(true);
  };

  const closeModal = () => {
    setOpen(false);
    if (!start.isPending) start.reset();
  };

  let note: ReactNode = null;
  let button: ReactNode;
  if (moving) {
    button = (
      <button type="button" className="btn !py-1 !text-xs !border-info/40 !text-pastel-blue" onClick={openModal}>
        <span className="num">{`Sending ${num(moving.amount)} ${moving.coin}`}</span>
      </button>
    );
  } else if (failed) {
    button = (
      <button type="button" className="btn !py-1 !text-xs !border-guava/60 !text-guava" onClick={openModal}>
        {'Transfer failed · open'}
      </button>
    );
  } else {
    if (view.lock) note = <span className="text-xs text-ink-500">{LOCK_SHORT[view.lock]}</span>;
    button = (
      <button type="button" className="btn !py-1 !text-xs" disabled={view.lock !== null} onClick={openModal}>
        {TRANSFER_CTA}
      </button>
    );
  }

  return (
    <div role="group" aria-label="Transfer" className="flex items-center gap-2">
      {note}
      {button}
      {open && <TransferModal view={view} onClose={closeModal} holdMs={holdMs} pick={modalPick} start={start} />}
    </div>
  );
}
