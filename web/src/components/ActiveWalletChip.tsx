/**
 * The active Boros wallet, on every tab: whose account the screen shows, and
 * whether this terminal can trade it. A click opens the Boros wallet row in
 * Settings.
 */
import { fmtDateShort } from '../lib/fmt';
import { short } from '../panels/HomeControls';
import { useActiveWallet, type ActiveWallet } from '../panels/trackedAddress';
import { BorosLogo } from './BorosLogo';
import { Chip } from './Chip';
import { ViewOnlyChip } from './ViewOnlyChip';

/** The wallet's state as one tag. The header chip and the Settings row use
 * the same tags, so a state reads the same everywhere. */
export function WalletStateTag({
  wallet,
  quiet = false,
}: {
  wallet: Pick<ActiveWallet, 'state' | 'endsSoon'>;
  /** The header: the normal state is a green dot, not a word. Only a state
   * that needs attention gets a tag there. */
  quiet?: boolean;
}) {
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
  if (quiet) {
    return <span role="img" aria-label="Logged in" title="Logged in" className="h-1.5 w-1.5 rounded-full bg-grass" />;
  }
  return (
    <Chip sm tone="green">
      Logged in
    </Chip>
  );
}

export function ActiveWalletChip() {
  const wallet = useActiveWallet();
  if (!wallet.address || !wallet.state) return null;
  return (
    <button
      type="button"
      onClick={wallet.openLogin}
      title="Boros wallet. Click to manage."
      aria-label={`Boros wallet ${wallet.address}`}
      className="flex h-[30px] items-center gap-2 rounded border border-ink-700 px-2 text-[11.5px] text-ink-200 hover:border-ink-500"
    >
      <span aria-hidden className="inline-flex h-3 w-2.5 shrink-0 overflow-hidden">
        <BorosLogo className="h-3 w-auto max-w-none shrink-0" />
      </span>
      <span className="num">{short(wallet.address)}</span>
      <WalletStateTag wallet={wallet} quiet />
    </button>
  );
}
