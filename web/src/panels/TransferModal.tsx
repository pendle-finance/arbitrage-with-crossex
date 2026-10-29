import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../api/client';
import { useRebalance, type useStartTransfer } from '../api/queries';
import type { GateAccount, TransferCoin, TransferJob, TransferLock, TransferPath, TransferView } from '../api/types';
import { Chip } from '../components/Chip';
import { HoldToConfirmButton } from '../components/HoldToConfirmButton';
import { HoverCard } from '../components/HoverCard';
import { t } from '../i18n';
import { Modal } from '../components/Modal';
import { SegmentedToggle } from '../components/SegmentedToggle';
import { amountError } from '../lib/amount';
import { fmtAbout, fmtAge, num, sig } from '../lib/fmt';
import { floorCents, roundToStep } from '../lib/ticks';
import { useNow } from '../lib/useNow';
import { ProgressBar } from './RebalanceBits';
import { Facts, type Fact } from './RebalanceHovers';
import { HOVER, transferCta } from './rebalanceCopy';
import {
  findPath,
  fmtTransferAmount,
  NoSpotReadLine,
  SpotTile,
  TransferFacts,
  WalletList,
  coinOf,
  walletName,
  type CrossexWallet,
} from './TransferBits';
import { localizeServerText } from '../i18n/serverMessages';

type Tab = 'into' | 'out';

const TABS: readonly Tab[] = ['into', 'out'];

const LOCK_LINE: Readonly<Record<TransferLock, string>> = {
  get rebalance() { return t('accounts.transfer.lock.rebalance'); },
  get halted() { return t('accounts.transfer.lock.halted'); },
  get deal() { return t('accounts.transfer.lock.deal'); },
};

export interface TransferPick {
  coin: TransferCoin;
  wallet: GateAccount;
  nonce: number;
}

const isZero = (trimmed: string): boolean => trimmed !== '' && Number(trimmed) === 0;

function parsedAmount(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (isZero(trimmed)) return 0;
  if (amountError(trimmed) !== null) return null;
  return Number(trimmed);
}

function formatLine(text: string): string | null {
  if (text.includes(',')) return t('accounts.transfer.removeCommas');
  if (isZero(text.trim())) return null;
  return amountError(text);
}

function limitLine(tab: Tab, path: TransferPath, amount: number | null): string | null {
  if (amount === null) return null;
  if (path.max !== null && amount > path.max) {
    const values = { max: num(path.max), coin: path.coin };
    return t(tab === 'out' ? 'accounts.transfer.maxOut' : 'accounts.transfer.maxInto', values);
  }
  if (amount < path.min) return t('accounts.transfer.minimumLine', { min: sig(path.min), coin: path.coin });
  return null;
}

const fieldAmount = (value: number): string => roundToStep(floorCents(value), '0.01', 'down');

function SendingSteps({ to }: { to: GateAccount }) {
  const { t } = useTranslation();
  return (
    <ol className="flex flex-col gap-1.5 text-xs">
      <li className="text-grass">{`✓ ${t('accounts.transfer.stepAsked')}`}</li>
      <li aria-current="step" className="text-pastel-blue">{`• ${t('accounts.transfer.stepWaiting', { wallet: walletName(to) })}`}</li>
      <li className="text-ink-600">{`○ ${t('accounts.transfer.stepReading')}`}</li>
    </ol>
  );
}

function SendingBody({ job, path, now }: { job: TransferJob; path: TransferPath | undefined; now: number }) {
  const { t } = useTranslation();
  const elapsedMs = Math.max(0, now - job.createdAt);
  const items: Fact[] = [
    { key: 'moving', label: t('accounts.transfer.moving'), value: `${num(job.amount)} ${job.coin}` },
    { key: 'from', label: t('accounts.rebalanceModal.from'), value: walletName(job.from) },
    { key: 'to', label: t('accounts.rebalanceModal.to'), value: walletName(job.to) },
  ];
  return (
    <div className="flex flex-col gap-3.5">
      <p className="text-xs text-ink-400">
        {path
          ? t('accounts.transfer.startedUsually', { age: fmtAge(elapsedMs), usual: fmtAbout(path.seconds) })
          : t('accounts.transfer.started', { age: fmtAge(elapsedMs) })}
      </p>
      <Facts items={items} className="flex flex-wrap gap-x-8 gap-y-3" />
      <ProgressBar ratio={path ? elapsedMs / (path.seconds * 1000) : 0} tone="running" />
      <SendingSteps to={job.to} />
      <p className="border-t border-ink-800 pt-3.5 text-xs text-ink-400">{t('accounts.transfer.rebalanceWaits')}</p>
    </div>
  );
}

function allowsFact(job: TransferJob, max: number | null): Fact {
  if (max === null) {
    return {
      key: 'allows',
      label: t('accounts.transfer.gateAllows'),
      value: t('accounts.transfer.notKnown'),
      sub: [t('accounts.transfer.cannotReadSpot')],
    };
  }
  const source = t(job.from === 'SPOT' ? 'accounts.transfer.spotBalance' : 'accounts.transfer.freeMarginNow');
  return { key: 'allows', label: t('accounts.transfer.gateAllows'), value: `${num(max)} ${job.coin}`, sub: [source], warn: true };
}

function FailedBody({
  job,
  max,
  onRetry,
  onClose,
}: {
  job: TransferJob;
  max: number | null;
  onRetry: (amount: number | null) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const retry = max === null ? null : Math.min(job.amount, max);
  const items: Fact[] = [
    { key: 'asked', label: t('accounts.transfer.youAsked'), value: `${num(job.amount)} ${job.coin}` },
    allowsFact(job, max),
    {
      key: 'moved',
      label: t('accounts.rebalanceModal.moved'),
      value: job.received === null ? t('accounts.transfer.nothing') : `${num(job.received)} ${job.coin}`,
    },
  ];
  return (
    <div className="flex flex-col gap-3.5">
      <div role="alert" className="alert-red">
        <span className="text-xs font-medium text-guava">{t('accounts.transfer.failed')}</span>
        <span className="text-xs text-ink-400">{job.failText && localizeServerText(job.failText)}</span>
      </div>
      <Facts items={items} className="flex flex-wrap gap-x-8 gap-y-3" />
      <div className="flex items-center gap-3 border-t border-ink-800 pt-3.5">
        <button type="button" className="btn-primary num" onClick={() => onRetry(retry)}>
          {retry === null ? t('accounts.transfer.tryAgain') : t('accounts.transfer.tryAgainWith', { amount: fmtTransferAmount(retry) })}
        </button>
        <button type="button" className="btn" onClick={onClose}>
          {t('common.close')}
        </button>
      </div>
    </div>
  );
}

export function TransferModal({
  view,
  onClose,
  holdMs,
  pick,
  start,
}: {
  view: TransferView;
  onClose: () => void;
  holdMs?: number;
  pick?: TransferPick | null;
  start: ReturnType<typeof useStartTransfer>;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('out');
  const [wallet, setWallet] = useState<CrossexWallet>('CROSSEX');
  const [typed, setTyped] = useState('');
  const [retriedId, setRetriedId] = useState<string | null>(null);
  const buckets = useRebalance().data?.buckets;
  const now = useNow(1_000);
  const inputId = useId();
  const appliedNonce = useRef<number | null>(null);

  useEffect(() => {
    if (!pick || pick.nonce === appliedNonce.current) return;
    appliedNonce.current = pick.nonce;
    if (pick.wallet === 'SPOT') return;
    setTab('into');
    setWallet(pick.wallet);
  }, [pick]);

  const job = view.transfer;
  const moving = job?.status === 'moving' ? job : null;
  const failed = job !== null && job.status === 'failed' && job.failText !== null && job.id !== retriedId ? job : null;

  const title = (
    <span className="flex items-center gap-2.5">
      <span>{transferCta()}</span>
      {moving && <Chip tone="info">{t('accounts.transfer.sending')}</Chip>}
      {failed && <Chip tone="red">{t('accounts.transfer.failedChip')}</Chip>}
      {!moving && !failed && (
        <span className="text-xs font-normal text-ink-400">{t('accounts.transfer.gateCannot')}</span>
      )}
    </span>
  );

  if (moving) {
    return (
      <Modal title={title} onClose={onClose} widthClass="w-[680px]">
        <SendingBody job={moving} path={findPath(view.paths, moving)} now={now} />
      </Modal>
    );
  }

  const retry = (from: GateAccount, to: GateAccount, id: string, amount: number | null) => {
    setRetriedId(id);
    if (from === 'SPOT') {
      if (to !== 'SPOT') setWallet(to);
      setTab('into');
    } else {
      setWallet(from);
      setTab('out');
    }
    setTyped(amount === null ? '' : fieldAmount(amount));
  };

  if (failed) {
    return (
      <Modal title={title} onClose={onClose} widthClass="w-[680px]">
        <FailedBody
          job={failed}
          max={findPath(view.paths, failed)?.max ?? null}
          onRetry={(amount) => retry(failed.from, failed.to, failed.id, amount)}
          onClose={onClose}
        />
      </Modal>
    );
  }

  const coin = coinOf(wallet);
  const from: GateAccount = tab === 'out' ? wallet : 'SPOT';
  const to: GateAccount = tab === 'out' ? 'SPOT' : wallet;
  const path = findPath(view.paths, { coin, from, to });
  const max = path?.max ?? null;
  const locked = view.lock !== null;
  const amount = parsedAmount(typed);
  const problem = formatLine(typed.trim()) ?? (path ? limitLine(tab, path, amount) : null);
  const canSend = !locked && !start.isPending && path !== undefined && amount !== null && problem === null;

  const send = () => {
    if (!path || amount === null) return;
    start.mutate({ coin: path.coin, from: path.from, to: path.to, amount: typed.trim() });
  };

  const walletList = (side: 'From' | 'To') => (
    <WalletList side={side} wallet={wallet} buckets={buckets} disabled={locked} onPick={setWallet} />
  );
  const spotTile = (side: 'From' | 'To') => <SpotTile side={side} spot={view.spot} disabled={locked} />;

  return (
    <Modal title={title} onClose={onClose} widthClass="w-[820px]">
      <div className="flex flex-col gap-3.5">
        {view.lock && (
          <p className="rounded border border-info/40 bg-info/10 px-3 py-2 text-xs text-pastel-blue">
            {LOCK_LINE[view.lock]}
          </p>
        )}
        {view.spot === null && <NoSpotReadLine />}
        <fieldset disabled={locked} className="grid min-w-0 gap-6 md:grid-cols-2">
          <div className="flex flex-col gap-3">
            <SegmentedToggle<Tab>
              ariaLabel={t('accounts.transfer.direction')}
              value={tab}
              onChange={setTab}
              options={TABS.map((value) => ({ value, label: t(value === 'into' ? 'accounts.transfer.into' : 'accounts.transfer.out') }))}
              className={locked ? 'opacity-50' : undefined}
              fill
            />
            {tab === 'out' ? walletList('From') : spotTile('From')}
            {tab === 'out' ? spotTile('To') : walletList('To')}
          </div>
          <div className="flex flex-col gap-3 md:border-l md:border-ink-700 md:pl-6">
            <div className="flex items-baseline gap-2">
              <label htmlFor={inputId} className={`text-xs text-ink-400 ${locked ? 'opacity-50' : ''}`}>
                {t('accounts.rebalanceModal.amount')}
                {max !== null && ' · '}
                {max !== null && (
                  <HoverCard label={<span className="num">{t('accounts.transfer.upTo', { max: num(max) })}</span>} icon={false} widthPx={280}>
                    {tab === 'out' ? HOVER.upToOut : HOVER.upToInto}
                  </HoverCard>
                )}
              </label>
              {max !== null && (
                <button
                  type="button"
                  className="btn-ghost-xs ml-auto leading-4"
                  onClick={() => setTyped(fieldAmount(max))}
                >
                  {t('common.max')}
                </button>
              )}
            </div>
            <input
              id={inputId}
              className={`input num w-full disabled:cursor-not-allowed disabled:opacity-60 ${problem ? '!border-guava/60' : ''}`}
              inputMode="decimal"
              aria-invalid={problem ? true : undefined}
              value={typed}
              onChange={(e) => {
                setTyped(e.target.value);
                start.reset();
              }}
            />
            {path && <TransferFacts path={path} amount={amount ?? 0} showYouGet={!problem} disabled={locked} />}
            {problem && <p className="num text-xs text-guava">{problem}</p>}
            <HoldToConfirmButton tone="cyan" holdMs={holdMs} disabled={!canSend} onConfirm={send} className="num self-start">
              {t('accounts.transfer.holdSend', { amount: fmtTransferAmount(amount ?? 0), coin, to: walletName(to) })}
            </HoldToConfirmButton>
            {start.error && (
              <p role="alert" className="num text-xs text-guava">
                {start.error.message}
                {start.error instanceof ApiError && start.error.hint ? (
                  <span className="block text-guava/80">{start.error.hint}</span>
                ) : null}
              </p>
            )}
          </div>
        </fieldset>
      </div>
    </Modal>
  );
}
