/**
 * The active Boros wallet, on every tab: whose account the screen shows, and
 * whether this terminal can trade it. A click opens the Boros wallet row in
 * Settings.
 */
import { short } from '../panels/HomeControls';
import { useActiveWallet } from '../panels/trackedAddress';
import { Chip } from './Chip';
import { ViewOnlyChip } from './ViewOnlyChip';

export function ActiveWalletChip() {
  const wallet = useActiveWallet();
  if (!wallet.address || !wallet.state) return null;
  const tag =
    wallet.state === 'view-only' ? (
      <ViewOnlyChip />
    ) : wallet.state === 'expired' ? (
      <Chip sm tone="red">
        Login expired
      </Chip>
    ) : wallet.state === 'not-approved' ? (
      <Chip sm tone="red">
        Not approved
      </Chip>
    ) : wallet.endsSoon !== null ? (
      <Chip sm tone="amber">
        Renew by {new Date(wallet.endsSoon * 1000).toLocaleDateString()}
      </Chip>
    ) : (
      <Chip sm tone="green">
        Can trade
      </Chip>
    );
  return (
    <button
      type="button"
      onClick={wallet.openLogin}
      title="Boros wallet. Click to manage."
      aria-label={`Boros wallet ${wallet.address}`}
      className="flex h-[30px] items-center gap-2 rounded border border-ink-700 px-2 text-[11.5px] text-ink-200 hover:border-ink-500"
    >
      <span className="num">{short(wallet.address)}</span>
      {tag}
    </button>
  );
}
