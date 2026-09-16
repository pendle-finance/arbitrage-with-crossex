import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTransfer } from '../api/queries';
import type { TransferJob, TransferLock } from '../api/types';
import { Chip } from '../components/Chip';
import { HoverCard } from '../components/HoverCard';
import { useToast } from '../components/Toast';
import { num } from '../lib/fmt';
import { useSettledError } from '../lib/useSettledError';
import { HOVER, TRANSFER_CTA } from './rebalanceCopy';
import { destinationOf } from './TransferBits';
import { TransferModal, type TransferPick } from './TransferModal';

const LOCK_SHORT: Record<TransferLock, string> = {
  rebalance: 'Waits for the rebalance',
  halted: 'Waits for the rebalance',
  deal: 'Waits for the deal',
};

function doneText(transfer: TransferJob): string {
  const sent = `Sent ${num(transfer.amount)} ${transfer.coin} ${destinationOf(transfer.to)}.`;
  return transfer.received === null ? sent : `${sent} ${num(transfer.received)} arrived.`;
}

export function TransferSection({ holdMs, pick }: { holdMs?: number; pick?: TransferPick | null }) {
  const query = useTransfer();
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

  const title = (
    <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-400">
      <HoverCard label="Manual Transfer" widthPx={320} underline={false}>
        {HOVER.transferTitle}
      </HoverCard>
    </h2>
  );

  if (!view) {
    if (!loadError) return null;
    return (
      <section aria-label="Transfer" className="card flex flex-col gap-2 p-4">
        {title}
        <p role="alert" className="text-xs text-rose-300">
          Could not load transfers. {loadError.message}
        </p>
        <button type="button" className="btn-ghost-xs leading-4 self-start" onClick={() => void query.refetch()}>
          Retry
        </button>
      </section>
    );
  }

  const moving = job?.status === 'moving' ? job : null;
  const failed = job !== null && job.status === 'failed' && job.failText !== null ? job : null;

  const openModal = () => {
    setModalPick(null);
    setOpen(true);
  };

  let chip: ReactNode = null;
  let button: ReactNode;
  if (moving) {
    chip = <Chip tone="info">Sending</Chip>;
    button = (
      <button type="button" className="btn ml-auto !border-info/40 !text-pastel-blue" onClick={openModal}>
        <span className="num">{`${num(moving.amount)} ${moving.coin}`}</span>
      </button>
    );
  } else if (failed) {
    chip = <Chip tone="red">Failed</Chip>;
    button = (
      <button type="button" className="btn-primary ml-auto !bg-guava !text-ink-950 hover:!bg-guava/85" onClick={openModal}>
        {'Failed · open'}
      </button>
    );
  } else if (view.lock) {
    chip = <Chip tone="info">{LOCK_SHORT[view.lock]}</Chip>;
    button = (
      <button type="button" className="btn ml-auto" disabled>
        {TRANSFER_CTA}
      </button>
    );
  } else {
    button = (
      <button type="button" className="btn ml-auto" onClick={openModal}>
        {TRANSFER_CTA}
      </button>
    );
  }

  return (
    <section aria-label="Transfer" className="card flex items-center gap-3 p-4">
      <div className="flex flex-col gap-0.5">
        {title}
        <p className="text-xs text-ink-500">Between Gate spot and CrossEx</p>
      </div>
      {chip}
      {button}
      {open && <TransferModal view={view} onClose={() => setOpen(false)} holdMs={holdMs} pick={modalPick} />}
    </section>
  );
}
