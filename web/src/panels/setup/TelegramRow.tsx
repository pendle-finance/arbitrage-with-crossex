import { ArrowUpRight } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Trans } from 'react-i18next';
import { ApiError } from '../../api/client';
import { t } from '../../i18n';
import {
  qk,
  refreshTelegramFresh,
  useCancelTelegramLink,
  useDisconnectTelegram,
  useStartTelegramLink,
  useTelegram,
  useTelegramLink,
  useTelegramSettings,
} from '../../api/queries';
import type { InterestFloor, TelegramInfo, TelegramLinkStatus } from '../../api/types';
import { HoverCard } from '../../components/HoverCard';
import { InlineConfirm } from '../../components/InlineConfirm';
import { Spinner } from '../../components/Spinner';
import { Switch } from '../../components/Switch';
import { useToast } from '../../components/Toast';
import { fmtClock, fmtSyncAge, fmtUsd } from '../../lib/fmt';
import { useNow } from '../../lib/useNow';
import { short } from '../HomeControls';
import { isSameAddress, useTrackedAddressOptional } from '../trackedAddress';
import { Ext } from '../onboardingBits';
import { SetupRowFrame } from './SetupRowFrame';
import type { SetupRowProps } from './setupState';

/** The bot's page, where alert settings live per wallet. */
const ALERTS_PAGE_FALLBACK = 'https://boros-bot-notification.pendle.finance/alerts';

type Phase = 'idle' | 'waiting' | 'expired';

type AlertSettings = { liquidation: boolean; interest: boolean; maturity: boolean; rollover: boolean };

const WALLET_NAME: Record<string, string> = { USDT: 'CrossEx', HYPERLIQUID: 'Hyperliquid', LIGHTER: 'Lighter' };

const floorLine = (floor: InterestFloor): string => {
  const name = t('app.telegram.walletName', { coin: floor.coin, wallet: WALLET_NAME[floor.wallet] ?? floor.wallet });
  return floor.floorUsd < 0
    ? t('app.telegram.floorBorrow', { name, amount: fmtUsd(-floor.floorUsd, 0) })
    : t('app.telegram.floorEquity', { name, amount: fmtUsd(floor.floorUsd, 0) });
};




const interestCaption = (floors: readonly InterestFloor[]) => (
  <>
    {t('app.telegram.interestLead')}{' '}
    <HoverCard label={t('app.telegram.borrowing')} widthPx={300}>
      <div className="flex flex-col gap-1 text-xs">
        {floors.length === 0 && <div className="text-ink-200">{t('app.telegram.floorsLoading')}</div>}
        {floors.map((floor) => (
          <div key={floor.wallet} className="num text-ink-200">
            {floorLine(floor)}
          </div>
        ))}
      </div>
    </HoverCard>
  </>
);


function alertSettings(info: TelegramInfo): AlertSettings {
  return {
    liquidation: info.settings?.liquidation ?? false,
    interest: info.settings?.interest ?? false,
    maturity: info.settings?.maturity ?? false,
    rollover: info.settings?.rollover ?? false,
  };
}

function alertsLabel(settings: AlertSettings): string {
  const on = Object.values(settings).filter(Boolean).length;
  if (on === 4) return t('app.telegram.allOn');
  if (on === 0) return t('app.telegram.noneOn');
  return t('app.telegram.someOn', { on });
}

function syncFailure(info: TelegramInfo): string | null {
  const error = info.lastSyncError;
  if (!info.connected || error === null) return null;
  if (info.lastSyncAt !== null && info.lastSyncAt >= error.at) return null;
  return info.lastSyncAt === null
    ? t('app.telegram.syncFailed', { time: fmtClock(error.at) })
    : t('app.telegram.syncFailedSince', { time: fmtClock(error.at), since: fmtClock(info.lastSyncAt) });
}

/** A stored key the bot has not answered for yet (the server just started):
 * not "connected", which would read as a green tick and "None on". */
const isChecking = (info: TelegramInfo | undefined): boolean =>
  info?.state === 'connected' && info.settings === null && info.lastSyncAt === null && info.lastSyncError === null;

const unlinkedOf = (info: TelegramInfo | undefined): string | null =>
  info?.connected === true && info.state === 'connected' && info.unlinkedWallet ? info.unlinkedWallet : null;

function stateLine(info: TelegramInfo | undefined, now: number): { text: string | null; isWarn: boolean } {
  if (!info) return { text: null, isWarn: false };
  // Not set up for this wallet, moved to another terminal, or removed on the
  // bot page: each needs Set up, so each reads as a row never set up. The
  // opened row says which wallet.
  if (unlinkedOf(info) || info.state === 'replaced' || info.state === 'removed') return { text: null, isWarn: false };
  if (!info.connected) return { text: null, isWarn: false };
  if (isChecking(info)) return { text: t('app.telegram.checking'), isWarn: false };
  if (syncFailure(info)) return { text: t('app.telegram.lastSyncFailed'), isWarn: true };
  const alerts = alertsLabel(alertSettings(info));
  return {
    text:
      info.lastSyncAt === null
        ? alerts
        : t('app.telegram.stateSynced', { alerts, age: fmtSyncAge(now - info.lastSyncAt) }),
    isWarn: false,
  };
}

export function TelegramRow(p: SetupRowProps) {
  const telegram = useTelegram();
  const info = telegram.data;
  const start = useStartTelegramLink();
  const saveSettings = useTelegramSettings();
  const disconnect = useDisconnectTelegram();
  const [askDisconnect, setAskDisconnect] = useState(false);
  const cancelLink = useCancelTelegramLink();
  const qc = useQueryClient();
  // Opening the row asks the bot once, so a wallet stopped on the bot page
  // shows here now, not at the next 5-minute sync. It waits for the mount read
  // to land first: a read landing after it would make it drop its answer.
  const askedBot = useRef(false);
  const reading = telegram.isFetching;
  useEffect(() => {
    if (reading || askedBot.current) return;
    askedBot.current = true;
    refreshTelegramFresh(qc).catch(() => undefined);
  }, [reading, qc]);
  const toast = useToast();
  const now = useNow(1000);
  const [phase, setPhase] = useState<Phase>('idle');
  const link = useTelegramLink(phase === 'waiting');
  const linkStatus = phase === 'waiting' ? link.data?.status : undefined;
  const unlinked = unlinkedOf(info);
  const checking = isChecking(info);
  // Alerts are per wallet: linked to another wallet means not set up for the viewed one.
  const viewed = useTrackedAddressOptional()?.address ?? null;
  const otherWallet =
    info?.alertWallet && viewed && !isSameAddress(info.alertWallet, viewed) ? info.alertWallet : null;
  const isConnected =
    info?.connected === true && info.state === 'connected' && unlinked === null && !checking && otherWallet === null;

  useEffect(() => {
    if (linkStatus === 'confirmed') {
      setPhase('idle');
      void qc.invalidateQueries({ queryKey: qk.telegram });
    }
    if (linkStatus === 'expired') setPhase('expired');
    if (linkStatus === 'none') setPhase('idle');
  }, [linkStatus, qc]);

  const openBorosPage = (addWallet: boolean) => {
    p.onOpen();
    const tab = window.open('', '_blank');
    if (tab) tab.opener = null;
    start.mutate(addWallet ? { addWallet: true } : undefined, {
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
    <button type="button" className="btn-primary w-fit" disabled={start.isPending} onClick={() => openBorosPage(false)}>
      {start.isPending && <Spinner />}
      {t('app.setup.setUp')}
      <ArrowUpRight size={12} aria-hidden className="inline" />
    </button>
  );

  // In the closed row the state already names the wallet, so the button is
  // short: the long label covered the state text in the narrow Settings panel.
  const addWalletButton = (wallet: string, compact = false) => (
    <button
      type="button"
      className="btn-primary num w-fit"
      disabled={start.isPending}
      onClick={() => openBorosPage(true)}
    >
      {start.isPending && <Spinner />}
      {compact ? t('app.setup.setUp') : t('app.telegram.setUpFor', { wallet: short(wallet) })}
      <ArrowUpRight size={12} aria-hidden className="inline" />
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

  const disconnectLink = (
    <button
      type="button"
      className="btn-link ml-auto text-ink-400"
      disabled={disconnect.isPending || askDisconnect}
      onClick={() => setAskDisconnect(true)}
    >
      {t('app.telegram.disconnect')}
    </button>
  );

  // Asks first, like Log out: this stops alerts for every wallet on the terminal.
  const disconnectBlock = (
    <>
      {askDisconnect && (
        <InlineConfirm
          tone="danger"
          label={t('app.telegram.disconnectLabel')}
          question={t('app.telegram.disconnectQuestion')}
          confirmLabel={t('app.telegram.disconnectConfirm')}
          busyLabel={t('app.telegram.disconnecting')}
          busy={disconnect.isPending}
          onConfirm={() => disconnect.mutate(undefined, { onSettled: () => setAskDisconnect(false) })}
          onCancel={() => setAskDisconnect(false)}
        />
      )}
      {disconnect.isError && (
        <p role="alert" className="text-xs text-amber-300">
          <Trans
            i18nKey="app.telegram.botNotReached"
            components={{ a: <Ext href={info?.alertsPageUrl ?? ALERTS_PAGE_FALLBACK} /> }}
          />
        </p>
      )}
    </>
  );

  const connectedBody = (settings: AlertSettings, lastSyncAt: number | null) => (
    <>
      <div className="flex flex-col gap-0.5">
        <Switch
          on={settings.liquidation}
          label={t('app.telegram.liquidation')}
          disabled={saveSettings.isPending}
          onChange={(next) => save({ liquidation: next })}
        />
        <p className="pl-9 text-xs text-ink-500">{t('app.telegram.liquidationCaption')}</p>
      </div>
      <div className="flex flex-col gap-0.5">
        <Switch
          on={settings.interest}
          label={t('app.telegram.interest')}
          disabled={saveSettings.isPending}
          onChange={(next) => save({ interest: next })}
        />
        <p className="pl-9 text-xs text-ink-500">{interestCaption(info?.floors ?? [])}</p>
      </div>
      <div className="flex flex-col gap-0.5">
        <Switch
          on={settings.maturity}
          label={t('app.telegram.maturity')}
          disabled={saveSettings.isPending}
          onChange={(next) => save({ maturity: next })}
        />
        <p className="pl-9 text-xs text-ink-500">{t('app.telegram.maturityCaption')}</p>
      </div>
      <div className="flex flex-col gap-0.5">
        <Switch
          on={settings.rollover}
          label={t('app.telegram.rollover')}
          disabled={saveSettings.isPending}
          onChange={(next) => save({ rollover: next })}
        />
        <p className="pl-9 text-xs text-ink-500">{t('app.telegram.rolloverCaption')}</p>
      </div>
      <div className="flex flex-wrap items-center gap-x-1 gap-y-1 text-xs text-ink-400">
        {info?.alertWallet && <span className="num">{t('app.telegram.alertsFor', { wallet: short(info.alertWallet) })}</span>}
        {lastSyncAt !== null ? (
          <span className="num">
            <HoverCard label={t('app.telegram.synced', { age: fmtSyncAge(now - lastSyncAt) })} widthPx={300}>
              <div className="text-xs text-ink-200">{t('app.telegram.caveat')}</div>
            </HoverCard>
          </span>
        ) : (
          <span className="text-ink-500">{t('app.telegram.caveat')}</span>
        )}
      </div>
      {p.variant !== 'setup' && !askDisconnect && (
        <div className="flex items-center gap-3">
          <a
            href={info?.alertsPageUrl ?? ALERTS_PAGE_FALLBACK}
            target="_blank"
            rel="noreferrer"
            className="btn-link inline-flex items-center gap-1"
          >
            {t('app.telegram.borosNotifications')}
            <ArrowUpRight size={12} aria-hidden />
          </a>
          {disconnectLink}
        </div>
      )}
      {p.variant === 'setup' ? (
        <button type="button" className="btn-primary w-fit" onClick={p.onDone}>
          {t('app.telegram.finish')}
        </button>
      ) : (
        disconnectBlock
      )}
    </>
  );

  const unlinkedBody = (wallet: string) => (
    <>
      <p className="num text-xs text-ink-300">
        {t('app.telegram.perWallet')}
      </p>
      {phase === 'expired' && <p className="text-xs text-amber-300">{t('app.telegram.linkExpired')}</p>}
      {startError && (
        <p role="alert" className="text-xs text-amber-300">
          {startError}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {addWalletButton(wallet)}
        {p.variant !== 'setup' && !askDisconnect && disconnectLink}
      </div>
      {p.variant !== 'setup' && disconnectBlock}
    </>
  );

  const waitingBody = (
    <>
      <div className="flex items-center gap-2 text-xs text-ink-300">
        <Spinner />
        <span>{t('app.telegram.waiting')}</span>
      </div>
      {pageUrl && <Ext href={pageUrl}>
          {t('app.telegram.openAgain')} <ArrowUpRight size={12} aria-hidden className="inline" />
        </Ext>}
      <button
        type="button"
        className="btn-ghost-xs w-fit"
        disabled={cancelLink.isPending}
        onClick={() => cancelLink.mutate(undefined, { onSuccess: () => setPhase('idle'), onError: showError })}
      >
        {t('common.cancel')}
      </button>
    </>
  );

  const idleBody = (
    <>
      <div className="flex flex-col gap-2 text-xs">
        <div className="flex flex-col gap-0.5">
          <span className="text-ink-100">{t('app.telegram.liquidation')}</span>
          <span className="text-ink-500">{t('app.telegram.liquidationCaption')}</span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-ink-100">{t('app.telegram.interest')}</span>
          <span className="text-ink-500">{interestCaption(info?.floors ?? [])}</span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-ink-100">{t('app.telegram.maturity')}</span>
          <span className="text-ink-500">{t('app.telegram.maturityCaption')}</span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-ink-100">{t('app.telegram.rollover')}</span>
          <span className="text-ink-500">{t('app.telegram.rolloverCaption')}</span>
        </div>
      </div>
      {phase === 'expired' && <p className="text-xs text-amber-300">{t('app.telegram.linkExpired')}</p>}
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
      title={t('app.telegram.title')}
      row={p}
      isDone={isConnected}
      state={otherWallet ? t('app.telegram.notForThisWallet') : p.open && isConnected ? null : line.text}
      isWarn={line.isWarn}
      alert={
        ((failure && p.open) || readError) && (
          <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            {failure ?? readError}
          </p>
        )
      }
      setupAction={checking || otherWallet ? <span /> : unlinked ? addWalletButton(unlinked, true) : setupButton}
      skipConsequence={t('app.telegram.skip')}
    >
      {checking ? (
        <div className="flex items-center gap-2 text-xs text-ink-300">
          <Spinner />
          <span>{t('app.telegram.checkingBot')}</span>
        </div>
      ) : otherWallet && viewed ? (
        <p className="text-xs text-ink-300">
          <Trans
            i18nKey="app.telegram.linkedElsewhere"
            values={{ other: short(otherWallet), viewed: short(viewed) }}
            components={{ a: <span className="num text-ink-100" />, b: <span className="num text-ink-100" /> }}
          />
        </p>
      ) : unlinked && phase !== 'waiting'
        ? unlinkedBody(unlinked)
        : info && isConnected
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
