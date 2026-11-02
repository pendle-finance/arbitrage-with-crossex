/**
 * The active Boros wallet, on every tab: whose account the screen shows, and
 * whether this terminal is logged in to it. A click opens Settings.
 */
import { Settings } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fmtDateShort } from '../lib/fmt';
import { short } from '../panels/HomeControls';
import { useActiveWallet, type ActiveWallet } from '../panels/trackedAddress';
import { Chip } from './Chip';
import { ViewOnlyChip } from './ViewOnlyChip';

/** The wallet's state as one tag, for the Settings drawer. The header only
 * carries the logged-in dot. */
export function WalletStateTag({ wallet }: { wallet: Pick<ActiveWallet, 'state' | 'endsSoon'> }) {
  const { t } = useTranslation();
  if (!wallet.state) return null;
  if (wallet.state === 'view-only') return <ViewOnlyChip />;
  if (wallet.state === 'not-logged-in')
    return (
      <Chip sm tone="neutral">
        {t('app.wallet.notLoggedIn')}
      </Chip>
    );
  if (wallet.state === 'expired')
    return (
      <Chip sm tone="red">
        {t('app.wallet.loginExpired')}
      </Chip>
    );
  if (wallet.state === 'logging-in')
    return (
      <Chip sm tone="neutral">
        {t('app.wallet.loggingIn')}
      </Chip>
    );
  if (wallet.state === 'not-approved')
    return (
      <Chip sm tone="red">
        {t('app.wallet.notApproved')}
      </Chip>
    );
  if (wallet.state === 'unchecked')
    return (
      <Chip sm tone="neutral" title={t('app.wallet.uncheckedTitle')}>
        {t('app.wallet.loginNotChecked')}
      </Chip>
    );
  if (wallet.endsSoon !== null)
    return (
      <Chip sm tone="amber">
        {t('app.wallet.renewBy', { date: fmtDateShort(wallet.endsSoon, { year: 'numeric' }) })}
      </Chip>
    );
  return (
    <Chip sm tone="green">
      {t('app.wallet.loggedIn')}
    </Chip>
  );
}

/**
 * The header's one account button: Settings and the active Boros wallet open
 * the same drawer, so they are one control (his call 2026-09-23). With a
 * wallet it shows the gear, the address (no Boros mark, his call) and a green dot when this terminal is
 * logged in to it — no dot for every other state; the words for those live in
 * the drawer's Boros wallet row. Without a wallet it is the plain gear.
 */
export function ActiveWalletChip({ onOpen, showWallet = true }: { onOpen: () => void; showWallet?: boolean }) {
  const wallet = useActiveWallet();
  const { t } = useTranslation();
  if (!showWallet || !wallet.address || !wallet.state) {
    return (
      <button
        type="button"
        aria-label={t('app.settings')}
        title={t('app.settings')}
        onClick={onOpen}
        className="pp-chevron h-[30px] w-[30px] !p-0 text-ink-200 hover:bg-ink-600/25 hover:text-ink-50"
      >
        <Settings size={16} strokeWidth={1.6} aria-hidden />
      </button>
    );
  }
  const loggedIn = wallet.state === 'can-trade';
  return (
    <button
      type="button"
      onClick={onOpen}
      title={t('app.wallet.settingsTitle')}
      aria-label={t(loggedIn ? 'app.wallet.settingsAriaLoggedIn' : 'app.wallet.settingsAria', { address: wallet.address })}
      className="hdr-ctl gap-2 border-ink-700 font-normal text-ink-200 hover:border-ink-500"
    >
      <Settings size={14} strokeWidth={1.6} aria-hidden className="shrink-0" />
      <span className="num">{short(wallet.address)}</span>
      {loggedIn && <span role="img" aria-label={t('app.wallet.loggedIn')} title={t('app.wallet.loggedIn')} className="h-1.5 w-1.5 rounded-full bg-grass" />}
    </button>
  );
}
