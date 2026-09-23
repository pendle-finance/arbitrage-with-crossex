/**
 * The active Boros wallet, on every tab: whose account the screen shows, and
 * whether this terminal is logged in to it. A click opens Settings.
 */
import { Settings } from 'lucide-react';
import { fmtDateShort } from '../lib/fmt';
import { short } from '../panels/HomeControls';
import { useActiveWallet, type ActiveWallet } from '../panels/trackedAddress';
import { Chip } from './Chip';
import { ViewOnlyChip } from './ViewOnlyChip';

/** The wallet's state as one tag, for the Settings drawer. The header only
 * carries the logged-in dot. */
export function WalletStateTag({ wallet }: { wallet: Pick<ActiveWallet, 'state' | 'endsSoon'> }) {
  if (!wallet.state) return null;
  if (wallet.state === 'view-only') return <ViewOnlyChip />;
  if (wallet.state === 'not-logged-in')
    return (
      <Chip sm tone="neutral">
        Not logged in
      </Chip>
    );
  if (wallet.state === 'expired')
    return (
      <Chip sm tone="red">
        Login expired
      </Chip>
    );
  if (wallet.state === 'logging-in')
    return (
      <Chip sm tone="neutral">
        Logging in…
      </Chip>
    );
  if (wallet.state === 'not-approved')
    return (
      <Chip sm tone="red">
        Not approved
      </Chip>
    );
  if (wallet.state === 'unchecked')
    return (
      <Chip sm tone="neutral" title="Boros did not answer. The venue still checks the login.">
        Login not checked
      </Chip>
    );
  if (wallet.endsSoon !== null)
    return (
      <Chip sm tone="amber">
        Renew by {fmtDateShort(wallet.endsSoon, { year: 'numeric' })}
      </Chip>
    );
  return (
    <Chip sm tone="green">
      Logged in
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
  if (!showWallet || !wallet.address || !wallet.state) {
    return (
      <button
        type="button"
        aria-label="Settings"
        title="Settings"
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
      title="Settings and Boros wallet"
      aria-label={`Settings. Boros wallet ${wallet.address}${loggedIn ? ', logged in' : ''}`}
      className="hdr-ctl gap-2 border-ink-700 font-normal text-ink-200 hover:border-ink-500"
    >
      <Settings size={14} strokeWidth={1.6} aria-hidden className="shrink-0" />
      <span className="num">{short(wallet.address)}</span>
      {loggedIn && <span role="img" aria-label="Logged in" title="Logged in" className="h-1.5 w-1.5 rounded-full bg-grass" />}
    </button>
  );
}
