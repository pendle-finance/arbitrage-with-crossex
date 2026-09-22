import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ApiError } from '../../api/client';
import {
  qk,
  useCancelTelegramLink,
  useDisconnectTelegram,
  useStartTelegramLink,
  useTelegram,
  useTelegramLink,
  useTelegramSettings,
} from '../../api/queries';
import type { TelegramInfo, TelegramLinkStatus } from '../../api/types';
import { HoverCard } from '../../components/HoverCard';
import { Spinner } from '../../components/Spinner';
import { Switch } from '../../components/Switch';
import { useToast } from '../../components/Toast';
import { fmtClock, fmtSyncAge, fmtUsd } from '../../lib/fmt';
import { useNow } from '../../lib/useNow';
import { Ext } from '../onboardingBits';
import { SetupRowFrame } from './SetupRowFrame';
import type { SetupRowProps } from './setupState';

type Phase = 'idle' | 'waiting' | 'expired';

type AlertSettings = { liquidation: boolean; interest: boolean };

const INTEREST_FLOORS = [
  { wallet: 'USDT CrossEx wallet', equityUsd: 0 },
  { wallet: 'USDC Lighter wallet', equityUsd: 0 },
  { wallet: 'USDC Hyperliquid wallet', equityUsd: -10_000 },
];

const LIQUIDATION_CAPTION = 'a 20% price move would liquidate a leg';

const interestCaption = (
  <>
    borrowing starts at your{' '}
    <HoverCard label="interest price" widthPx={280}>
      <div className="flex flex-col gap-1 text-xs">
        {INTEREST_FLOORS.map((floor) => (
          <div key={floor.wallet} className="num text-ink-200">
            {`${floor.wallet} · equity under ${fmtUsd(floor.equityUsd, 0)}`}
          </div>
        ))}
      </div>
    </HoverCard>
  </>
);

const CAVEAT =
  "Alerts use the terminal's last sync, at most 5 min old. A trade made elsewhere counts after the next one.";

function alertSettings(info: TelegramInfo): AlertSettings {
  return { liquidation: info.settings?.liquidation ?? false, interest: info.settings?.interest ?? false };
}

function alertsLabel({ liquidation, interest }: AlertSettings): string {
  if (liquidation && interest) return 'Both on';
  if (liquidation) return 'Liquidation only';
  if (interest) return 'Interest only';
  return 'Alerts off';
}

function syncFailure(info: TelegramInfo): string | null {
  const error = info.lastSyncError;
  if (!info.connected || error === null) return null;
  if (info.lastSyncAt !== null && info.lastSyncAt >= error.at) return null;
  const since = info.lastSyncAt === null ? null : `Alerts still use the sync from ${fmtClock(info.lastSyncAt)}.`;
  return [`Last sync failed at ${fmtClock(error.at)}.`, since, 'Retrying.'].filter(Boolean).join(' ');
}

function stateLine(info: TelegramInfo | undefined, now: number): { text: string | null; isWarn: boolean } {
  if (!info) return { text: null, isWarn: false };
  if (info.state === 'replaced') return { text: 'Connected on another terminal', isWarn: true };
  if (info.state === 'removed') return { text: 'Removed on the Boros alerts page', isWarn: true };
  if (!info.connected) return { text: null, isWarn: false };
  if (syncFailure(info)) return { text: 'last sync failed', isWarn: true };
  const synced = info.lastSyncAt === null ? '' : ` · synced ${fmtSyncAge(now - info.lastSyncAt)}`;
  return { text: `${alertsLabel(alertSettings(info))}${synced}`, isWarn: false };
}

export function TelegramRow(p: SetupRowProps) {
  const telegram = useTelegram();
  const info = telegram.data;
  const start = useStartTelegramLink();
  const saveSettings = useTelegramSettings();
  const disconnect = useDisconnectTelegram();
  const cancelLink = useCancelTelegramLink();
  const qc = useQueryClient();
  const toast = useToast();
  const now = useNow(1000);
  const [phase, setPhase] = useState<Phase>('idle');
  const link = useTelegramLink(phase === 'waiting');
  const linkStatus = phase === 'waiting' ? link.data?.status : undefined;
  const isConnected = info?.connected === true && info.state === 'connected';

  useEffect(() => {
    if (linkStatus === 'confirmed') {
      setPhase('idle');
      void qc.invalidateQueries({ queryKey: qk.telegram });
    }
    if (linkStatus === 'expired') setPhase('expired');
    if (linkStatus === 'none') setPhase('idle');
  }, [linkStatus, qc]);

  const openBorosPage = () => {
    p.onOpen();
    const tab = window.open('', '_blank');
    if (tab) tab.opener = null;
    start.mutate(undefined, {
      onSuccess: (started) => {
        const pending: TelegramLinkStatus = { status: 'pending', url: started.url, expiresAt: started.expiresAt };
        qc.setQueryData(qk.telegramLink, pending);
        if (tab) tab.location.href = started.url;
        setPhase('waiting');
      },
      onError: () => tab?.close(),
    });
  };

  const showError = (err: unknown) => toast.push('error', err instanceof ApiError ? err.message : String(err));

  const save = (body: Partial<AlertSettings>) => saveSettings.mutate(body, { onError: showError });

  const setupButton = (
    <button type="button" className="btn-primary w-fit" disabled={start.isPending} onClick={openBorosPage}>
      {start.isPending && <Spinner />}
      Set up ↗
    </button>
  );

  const line = stateLine(info, now);
  const failure = info ? syncFailure(info) : null;
  const readError = telegram.isError
    ? telegram.error instanceof ApiError
      ? telegram.error.message
      : String(telegram.error)
    : null;
  const startError = start.error instanceof ApiError ? start.error.message : start.error ? String(start.error) : null;
  const pageUrl = link.data?.url ?? start.data?.url ?? null;

  const connectedBody = (settings: AlertSettings, lastSyncAt: number | null) => (
    <>
      <div className="flex flex-col gap-0.5">
        <Switch
          on={settings.liquidation}
          label="Close to liquidation"
          disabled={saveSettings.isPending}
          onChange={(next) => save({ liquidation: next })}
        />
        <p className="num pl-9 text-xs text-ink-500">{LIQUIDATION_CAPTION}</p>
      </div>
      <div className="flex flex-col gap-0.5">
        <Switch
          on={settings.interest}
          label="Started paying interest"
          disabled={saveSettings.isPending}
          onChange={(next) => save({ interest: next })}
        />
        <p className="pl-9 text-xs text-ink-500">{interestCaption}</p>
      </div>
      {lastSyncAt !== null && (
        <p className="num text-xs text-ink-400">{`Last synced ${fmtSyncAge(now - lastSyncAt)}`}</p>
      )}
      <p className="text-xs text-ink-500">{CAVEAT}</p>
      {p.variant === 'setup' ? (
        <button type="button" className="btn-primary w-fit" onClick={p.onDone}>
          Finish
        </button>
      ) : (
        <>
          <button
            type="button"
            className="btn-link text-ink-400"
            disabled={disconnect.isPending}
            onClick={() => disconnect.mutate()}
          >
            Disconnect this terminal
          </button>
          {disconnect.isError && (
            <p role="alert" className="text-xs text-amber-300">
              Could not reach the bot. Try again, or remove this terminal on the{' '}
              <Ext href={info?.alertsPageUrl ?? 'https://boros-bot-notification.pendle.finance/alerts'}>
                Boros alerts page
              </Ext>
              .
            </p>
          )}
        </>
      )}
    </>
  );

  const waitingBody = (
    <>
      <div className="flex items-center gap-2 text-xs text-ink-300">
        <Spinner />
        <span>Waiting for you to confirm on the Boros alerts page</span>
      </div>
      {pageUrl && <Ext href={pageUrl}>Open the page again ↗</Ext>}
      <button
        type="button"
        className="btn-ghost-xs w-fit"
        disabled={cancelLink.isPending}
        onClick={() => cancelLink.mutate(undefined, { onSuccess: () => setPhase('idle'), onError: showError })}
      >
        Cancel
      </button>
    </>
  );

  const idleBody = (
    <>
      <div className="flex flex-col gap-1.5 text-xs">
        <div className="flex gap-3">
          <span className="w-40 shrink-0 text-ink-100">Close to liquidation</span>
          <span className="num text-ink-400">{LIQUIDATION_CAPTION}</span>
        </div>
        <div className="flex gap-3">
          <span className="w-40 shrink-0 text-ink-100">Started paying interest</span>
          <span className="text-ink-400">{interestCaption}</span>
        </div>
      </div>
      {phase === 'expired' && <p className="text-xs text-amber-300">Link expired. Set up again.</p>}
      {startError && (
        <p role="alert" className="text-xs text-amber-300">
          {startError}
        </p>
      )}
      {setupButton}
    </>
  );

  return (
    <SetupRowFrame
      n={3}
      title="Telegram alerts"
      row={p}
      isDone={isConnected}
      state={p.open && isConnected ? null : line.text}
      isWarn={line.isWarn}
      alert={
        (failure || readError) && (
          <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            {failure ?? readError}
          </p>
        )
      }
      setupAction={setupButton}
      skipConsequence="Without Telegram alerts nothing warns you near liquidation or when interest starts."
    >
      {info && isConnected
        ? connectedBody(
            { ...alertSettings(info), ...(saveSettings.isPending ? saveSettings.variables : {}) },
            info.lastSyncAt,
          )
        : phase === 'waiting'
          ? waitingBody
          : idleBody}
    </SetupRowFrame>
  );
}
