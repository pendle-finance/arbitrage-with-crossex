/**
 * Connect: pick which account the terminal shows. It asks the browser wallet
 * for its account only: no chain switch, no signature. Logging in to trade is
 * a separate step, like the Boros app.
 */
import { useState } from 'react';
import { describeWalletError, hasInjectedWallet, requestWalletAccount } from '../lib/wallet';
import { useTrackedAddressOptional } from '../panels/trackedAddress';

export function ConnectWalletButton() {
  const tracked = useTrackedAddressOptional();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!hasInjectedWallet()) {
    return <p className="text-xs text-ink-400">Install Rabby or MetaMask, then reload.</p>;
  }

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      tracked?.followBrowserWallet(await requestWalletAccount());
    } catch (err) {
      setError(describeWalletError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs text-ink-400">Connect the wallet that holds your Boros account.</p>
      <button type="button" className="btn-primary w-full" disabled={busy} onClick={connect}>
        {busy ? 'Waiting for your wallet…' : 'Connect wallet'}
      </button>
      {error && (
        <p role="alert" className="text-[11px] text-rose-300">
          {error}
        </p>
      )}
    </div>
  );
}
