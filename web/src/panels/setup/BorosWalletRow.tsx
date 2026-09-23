/**
 * Settings: the Boros wallet. The terminal shows the browser wallet's account,
 * like the Boros app, so this row answers one question: can this terminal
 * trade the wallet on screen? Then it offers the one action that changes that.
 */
import { useState, type ReactNode } from 'react';
import { ApiError } from '../../api/client';
import { useBorosAgent, useForgetBorosAgent, useTelegramLinked } from '../../api/queries';
import { WalletStateTag } from '../../components/ActiveWalletChip';
import { ConnectWalletButton } from '../../components/ConnectWalletButton';
import { InlineConfirm } from '../../components/InlineConfirm';
import { BorosLogInButton, NOT_APPROVED_TEXT } from '../../trade/BorosAgentSetup';
import { fmtDateShort } from '../../lib/fmt';
import { describeWalletError, hasInjectedWallet, requestWalletAccount } from '../../lib/wallet';
import { short } from '../HomeControls';
import { isSameAddress, useActiveWallet, useTrackedAddress } from '../trackedAddress';
import { SetupRowFrame } from './SetupRowFrame';
import type { SetupRowProps } from './setupState';

export function BorosWalletRow(p: SetupRowProps) {
  const { address, followWallet, followBrowserWallet, upgradeNote, dismissUpgradeNote } = useTrackedAddress();
  const active = useActiveWallet();
  const agent = useBorosAgent().data;
  const forget = useForgetBorosAgent();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [askLogOut, setAskLogOut] = useState(false);
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
    body = <ConnectWalletButton />;
  } else if (active.state === 'can-trade' || active.state === 'unchecked') {
    body = (
      <>
        <p className="text-xs text-ink-400">
          Trades only. Cannot deposit or withdraw.
          {agent?.expiry ? ` Login ends ${fmtDateShort(agent.expiry, { year: 'numeric' })}.` : ''}
        </p>
        {active.endsSoon !== null && logIn}
      </>
    );
  } else if (active.state === 'logging-in') {
    body = logIn;
  } else if (active.state === 'expired') {
    body = (
      <>
        <p className="text-xs text-rose-300">
          Login ended{agent?.expiry ? ` ${fmtDateShort(agent.expiry, { year: 'numeric' })}` : ''}. Boros refuses orders.
        </p>
        {logIn}
      </>
    );
  } else if (active.state === 'not-approved') {
    body = (
      <>
        <p className="text-xs text-rose-300">{NOT_APPROVED_TEXT}</p>
        {logIn}
      </>
    );
  } else {
    body = (
      <>
        {otherLoggedIn ? (
          <div className="text-xs text-ink-400">
            <p>
              Logged in here: <span className="num text-ink-200">{short(otherLoggedIn)}</span>
            </p>
            <ul className="mt-0.5 flex list-disc flex-col gap-0.5 pl-4">
              <li>It trades on this terminal.</li>
              {alertsLinked && <li>It gets the Telegram alerts.</li>}
            </ul>
          </div>
        ) : (
          <p className="text-xs text-ink-400">Log in once to trade. The agent key cannot deposit or withdraw.</p>
        )}
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
      doneTone={
        p.variant === 'settings' && (active.state === 'view-only' || active.state === 'not-logged-in')
          ? 'neutral'
          : 'done'
      }
      state={address ? short(address) : null}
      stateNode={
        address ? (
          <>
            <span className="num whitespace-nowrap">{short(address)}</span>
            <WalletStateTag wallet={active} />
          </>
        ) : undefined
      }
      isWarn={active.state === 'expired' || active.state === 'not-approved'}
      alert={upgrade}
      skipConsequence="Without a Boros wallet the terminal cannot open Boros legs, and Positions cannot show them."
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
          {isOwnLogin && !askLogOut && active.state !== 'logging-in' && (
            <button type="button" className="btn-link ml-auto text-ink-400" onClick={() => setAskLogOut(true)}>
              Log out
            </button>
          )}
        </div>
      ) : null}
      {isOwnLogin && askLogOut && loggedIn && (
        <InlineConfirm
          tone="warn"
          label={`Log out ${short(loggedIn)}?`}
          question={
            <>
              Log out <span className="num">{short(loggedIn)}</span>? This terminal stops trading it. Open positions
              stay open.
            </>
          }
          confirmLabel="Log out"
          busyLabel="Logging out…"
          busy={forget.isPending}
          onConfirm={async () => {
            setError(null);
            try {
              await forget.mutateAsync();
            } catch (err) {
              setError(err instanceof ApiError ? err.message : String(err));
              return;
            }
            setAskLogOut(false);
            setNote('Logged out. The approval stays live on-chain until you revoke it in the Boros app.');
          }}
          onCancel={() => setAskLogOut(false)}
        />
      )}
    </SetupRowFrame>
  );
}
