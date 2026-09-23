/**
 * The active Boros wallet, on every tab: whose account the screen shows, and
 * whether this terminal can trade it. A click opens the Boros wallet row in
 * Settings.
 */
import { short } from '../panels/HomeControls';
import { useActiveWallet, type ActiveWallet } from '../panels/trackedAddress';
import { Chip } from './Chip';
import { ViewOnlyChip } from './ViewOnlyChip';

/** The wallet's state as one tag. The header chip and the Settings row use
 * the same tags, so a state reads the same everywhere. */
export function WalletStateTag({ wallet }: { wallet: Pick<ActiveWallet, 'state' | 'endsSoon'> }) {
  if (!wallet.state) return null;
  if (wallet.state === 'view-only') return <ViewOnlyChip />;
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
  if (wallet.endsSoon !== null)
    return (
      <Chip sm tone="amber">
        Renew by {new Date(wallet.endsSoon * 1000).toLocaleDateString()}
      </Chip>
    );
  return (
    <Chip sm tone="green">
      Can trade
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
      <span className="num">{short(wallet.address)}</span>
      <WalletStateTag wallet={wallet} />
    </button>
  );
}
