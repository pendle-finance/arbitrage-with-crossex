/**
 * Settings: the Boros wallet. The terminal shows the browser wallet's account,
 * like the Boros app, so this row answers one question: can this terminal
 * trade the wallet on screen? Then it offers the one action that changes that.
 */
import { useState, type ReactNode } from 'react';
import { useBorosAgent, useForgetBorosAgent, useTelegramLinked } from '../../api/queries';
import { WalletStateTag } from '../../components/ActiveWalletChip';
import { BorosLogInButton } from '../../trade/BorosAgentSetup';
import { describeWalletError, hasInjectedWallet, requestWalletAccount } from '../../lib/wallet';
import { short } from '../HomeControls';
import { isSameAddress, useActiveWallet, useTrackedAddress } from '../trackedAddress';
import { SetupRowFrame } from './SetupRowFrame';
import type { SetupRowProps } from './setupState';

const day = (unix: number): string => new Date(unix * 1000).toLocaleDateString();

export function BorosWalletRow(p: SetupRowProps) {
  const { address, followWallet, followBrowserWallet, upgradeNote, dismissUpgradeNote } = useTrackedAddress();
  const active = useActiveWallet();
  const agent = useBorosAgent().data;
  const forget = useForgetBorosAgent();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const hasWallet = hasInjectedWallet();
  const alertsLinked = useTelegramLinked();

  const loggedIn = agent?.configured ? agent.root : null;
  const isOwnLogin = loggedIn !== null && address !== null && isSameAddress(loggedIn, address);
  // The other wallet's login still works, so logging in here would end it.
  const otherLoggedIn =
    loggedIn !== null && !isOwnLogin && !agent?.expired && agent?.approval !== 'not-approved' ? loggedIn : null;

  const connect = async () => {
    setError(null);
    try {
      followBrowserWallet(await requestWalletAccount());
    } catch (err) {
      setError(describeWalletError(err));
    }
  };

  const upgrade = upgradeNote ? (
    <div className="flex items-center gap-3 rounded-lg border border-ink-700 px-3 py-2 text-xs text-ink-300">
      <span>
        Now showing <span className="num text-ink-100">{short(upgradeNote)}</span>, the wallet that trades.
      </span>
      <button type="button" className="btn-link ml-auto" onClick={dismissUpgradeNote}>
        Dismiss
      </button>
    </div>
  ) : null;

  const logIn = hasWallet ? (
    <BorosLogInButton renew={active.endsSoon !== null} onDone={() => p.onDone()} />
  ) : (
    <p className="text-xs text-ink-400">Install Rabby or MetaMask to log in.</p>
  );

  let body: ReactNode;
  if (!address) {
    body = hasWallet ? (
      <>
        <p className="text-xs text-ink-400">Connect the wallet that holds your Boros account.</p>
        <button type="button" className="btn-primary w-full" onClick={connect}>
          Connect wallet
        </button>
      </>
    ) : (
      <p className="text-xs text-ink-400">Install Rabby or MetaMask, then reload.</p>
    );
  } else if (active.state === 'can-trade') {
    body = (
      <>
        <p className="text-xs text-ink-400">
          Agent key: trades only, cannot deposit or withdraw.
          {agent?.expiry ? ` Login ends ${day(agent.expiry)}.` : ''}
        </p>
        {active.endsSoon !== null && logIn}
      </>
    );
  } else if (active.state === 'expired') {
    body = (
      <>
        <p className="text-xs text-rose-300">
          Login ended{agent?.expiry ? ` ${day(agent.expiry)}` : ''}. Boros refuses orders.
        </p>
        {logIn}
      </>
    );
  } else if (active.state === 'not-approved') {
    body = (
      <>
        <p className="text-xs text-rose-300">
          Boros has no approval for this login. The wallet prompt was rejected, or the login was revoked.
        </p>
        {logIn}
      </>
    );
  } else {
    body = (
      <>
        <p className="text-xs text-ink-400">
          {otherLoggedIn ? (
            <>
              <span className="num text-ink-200">{short(otherLoggedIn)}</span> is still logged in. This terminal
              trades it{alertsLinked ? ' and syncs its Telegram alerts' : ''}.
            </>
          ) : (
            'Log in once to trade. The agent key cannot deposit or withdraw.'
          )}
        </p>
        {logIn}
      </>
    );
  }

  return (
    <SetupRowFrame
      n={2}
      title="Boros wallet"
      row={p}
      isDone={address !== null}
      state={address ? short(address) : null}
      stateNode={
        address ? (
          <>
            <span className="num">{short(address)}</span>
            <WalletStateTag wallet={active} />
          </>
        ) : undefined
      }
      isWarn={active.state === 'expired' || active.state === 'not-approved'}
      alert={upgrade}
      skipConsequence="Without a Boros wallet the terminal cannot open Boros legs, and Positions cannot show them."
      closeLabel="Close"
    >
      {body}
      {error && (
        <p role="alert" className="text-[11px] text-rose-300">
          {error}
        </p>
      )}
      {note && <p className="text-[11px] text-ink-400">{note}</p>}
      {(address && !followWallet && hasWallet) || isOwnLogin ? (
        <div className="flex items-center gap-4">
          {address && !followWallet && hasWallet && (
            <button type="button" className="btn-link" onClick={connect}>
              Use my browser wallet
            </button>
          )}
          {isOwnLogin && (
            <button
              type="button"
              className="btn-link ml-auto text-ink-400"
              disabled={forget.isPending}
              onClick={async () => {
                await forget.mutateAsync();
                setNote('Logged out. The approval stays live on-chain until you revoke it in the Boros app.');
              }}
            >
              {forget.isPending ? 'Logging out…' : 'Log out'}
            </button>
          )}
        </div>
      ) : null}
    </SetupRowFrame>
  );
}
