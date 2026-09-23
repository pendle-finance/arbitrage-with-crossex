/**
 * One-time Boros trading setup: connect a wallet, approve a delegated agent,
 * hand the agent key to the local terminal.
 *
 * The wallet is connected ONCE, here, to sign the approval. After that the
 * terminal trades with the agent key and the wallet is never needed again —
 * which is what lets the panel's follow-ups (a retry, a §6A close) work while
 * no browser is open.
 *
 * Three steps, all visible before the user starts, because two of them are
 * wallet prompts and an unexplained popup is how people click through things
 * they did not mean to:
 *   1. Connect            — read the address, switch to Arbitrum if needed
 *   2. Approve the agent  — ONE on-chain transaction, signed by the wallet
 *   3. Hand over the key  — POSTed to localhost, stored 0600
 *
 * The generated key never leaves this machine: it goes from `Agent.create` to
 * the local server and nowhere else. It is not logged, not put in a URL, and
 * not rendered.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Hex } from 'viem';
import { fetchJson } from '../api/client';
import { qk, useBorosAgent, useForgetBorosAgent, useProvisionBorosAgent, useTelegramLinked } from '../api/queries';
import type { BorosAgentStatus } from '../api/types';
import { WalletStateTag } from '../components/ActiveWalletChip';
import { ConnectWalletButton } from '../components/ConnectWalletButton';
import { useToastOptional } from '../components/Toast';
import { short } from '../panels/HomeControls';
import { isSameAddress, useActiveWallet, useTrackedAddressOptional } from '../panels/trackedAddress';
import { connectWallet, describeWalletError, hasInjectedWallet, BOROS_CHAIN } from '../lib/wallet';
import { useQueryClient } from '@tanstack/react-query';

/**
 * How long the on-chain approval lasts, as a DURATION. A year: long enough that
 * a background terminal is not silently broken by an expiry nobody was watching
 * for, short enough that an abandoned install stops being able to trade.
 *
 * ⚠ The SDK's `expiry_s` is an ABSOLUTE unix timestamp, not a duration —
 * `createApproveAgentMessage` puts it straight into the contract struct with no
 * `now +`. Passing a duration approves the agent until 1971 and every order
 * then fails with `AuthAgentExpired()`. The SDK's own default gives it away:
 * `Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60`. Converted at the call
 * site below, never here.
 */
const APPROVAL_SECONDS = 365 * 24 * 3600;

/** Absolute unix-second expiry for a fresh approval. */
const approvalExpiryAt = (): number => Math.floor(Date.now() / 1000) + APPROVAL_SECONDS;

/** How long to wait for Boros to show the new approval, and how often to ask. */
const CONFIRM_TRIES = 20;
const CONFIRM_EVERY_MS = 1500;

type Step = 'idle' | 'connecting' | 'replace' | 'approving' | 'saving' | 'confirming';

const STEP_LABEL: Record<Exclude<Step, 'idle'>, string> = {
  connecting: 'Waiting for your wallet…',
  replace: 'Waiting for your answer…',
  approving: 'Approving the agent on-chain…',
  saving: 'Handing the key to your terminal…',
  confirming: 'Checking the approval on Boros…',
};

/**
 * One login at a time, across every Log in button on screen. The pair ticket,
 * the close form and Settings can all show one, and two clicks must not open
 * two wallet prompts.
 */
let loginInFlight = false;
const inFlightListeners = new Set<() => void>();
const setLoginInFlight = (value: boolean) => {
  loginInFlight = value;
  for (const l of inFlightListeners) l();
};
const subscribeInFlight = (l: () => void) => {
  inFlightListeners.add(l);
  return () => inFlightListeners.delete(l);
};
const useLoginInFlight = () => useSyncExternalStore(subscribeInFlight, () => loginInFlight);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until Boros shows the approval on-chain. True when it does, or when
 * this server cannot tell (Boros unreachable, or an older server). */
async function waitForApproval(): Promise<boolean> {
  for (let i = 0; i < CONFIRM_TRIES; i++) {
    const s = await fetchJson<BorosAgentStatus>('/boros/agent?fresh=1').catch(() => null);
    const approval = s?.approval;
    if (approval === 'approved' || approval === 'unknown' || approval === undefined) return true;
    await sleep(CONFIRM_EVERY_MS);
  }
  return false;
}

export interface ReplaceNotice {
  from: string;
  to: string;
}

function useBorosLogIn(onDone?: (root: string) => void, expected?: string | null) {
  const provision = useProvisionBorosAgent();
  const status = useBorosAgent();
  const qc = useQueryClient();
  const toast = useToastOptional();
  const tracked = useTrackedAddressOptional();
  const inFlight = useLoginInFlight();
  const [step, setStep] = useState<Step>('idle');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [replacing, setReplacing] = useState<ReplaceNotice | null>(null);
  const answer = useRef<((go: boolean) => void) | null>(null);
  // A button that unmounts while asking (the ticket closes) must not leave the
  // login waiting forever: that would hold every Log in button busy.
  useEffect(() => () => answer.current?.(false), []);

  const run = async () => {
    if (loginInFlight) return;
    setLoginInFlight(true);
    setError(null);
    setNote(null);
    try {
      setStep('connecting');
      const wallet = await connectWallet();
      if (expected && !isSameAddress(wallet.address, expected)) {
        setError(`Your browser wallet is ${short(wallet.address)}. Switch it to ${short(expected)} to log in.`);
        return;
      }

      // The terminal holds ONE agent. Logging in this wallet logs out the one
      // that can trade now, so ask first. No need when that login is dead.
      const current = status.data;
      if (
        current?.configured &&
        current.root &&
        !isSameAddress(current.root, wallet.address) &&
        !current.expired &&
        current.approval !== 'not-approved'
      ) {
        setReplacing({ from: current.root, to: wallet.address });
        setStep('replace');
        const go = await new Promise<boolean>((resolve) => {
          answer.current = resolve;
        });
        answer.current = null;
        setReplacing(null);
        if (!go) return;
      }

      // Generate the delegated key IN THE BROWSER. The root key never leaves
      // the wallet; this tool never sees it.
      //
      // The API module is imported LAZILY: it pulls viem's ABI encoder, and
      // this is a one-time flow most sessions never run, so the main chunk
      // must not pay for a button most users press once.
      setStep('approving');
      const { generateAgentKey, approveAgent } = await import('../lib/borosAgentApi');
      const { privateKey, address: agentAddress } = generateAgentKey();
      const expiry = approvalExpiryAt();

      // The key is handed over BEFORE the approval is submitted. Both orders
      // have a failure window, and this is the recoverable one: a key stored
      // without an approval is inert and the next attempt overwrites it, while
      // approving first and failing to store would strand a live, year-long
      // on-chain approval for a key the browser is about to forget — costing
      // gas, and revocable only by hand in the Boros app. The server reads the
      // chain, so an inert key shows as "not approved", never as "can trade".
      setStep('saving');
      await provision.mutateAsync({
        root: wallet.address,
        accountId: 0,
        agentPrivateKey: privateKey as Hex,
        expiry,
      });

      setStep('approving');
      await approveAgent({
        walletClient: wallet.client,
        root: wallet.address,
        accountId: 0,
        agentAddress,
        expiry,
      });

      // Not done until Boros shows the approval.
      setStep('confirming');
      const confirmed = await waitForApproval();
      void qc.invalidateQueries({ queryKey: qk.borosAgent });
      if (!confirmed) {
        setError('Boros has not confirmed the approval yet. Wait a minute. If Log in still shows, log in again.');
        return;
      }
      const done = `Logged in. This terminal can trade ${short(wallet.address)} until ${new Date(expiry * 1000).toLocaleDateString()}.`;
      setNote(done);
      toast?.push('success', done);
      tracked?.followBrowserWallet(wallet.address);
      onDone?.(wallet.address);
    } catch (err) {
      setError(describeWalletError(err));
    } finally {
      setStep('idle');
      setLoginInFlight(false);
    }
  };

  const answerReplace = (go: boolean) => answer.current?.(go);

  return {
    run,
    step,
    busy: step !== 'idle' || inFlight,
    error,
    note,
    setNote,
    replacing,
    answerReplace,
  };
}

type LogIn = ReturnType<typeof useBorosLogIn>;

const buttonText = (login: LogIn, idle: string): string =>
  login.step !== 'idle' ? STEP_LABEL[login.step] : login.busy ? 'Logging in…' : idle;

/** Asked before a login that logs out the wallet that can trade now. */
function ReplaceConfirm({ login }: { login: LogIn }) {
  const alertsLinked = useTelegramLinked();
  if (!login.replacing) return null;
  const { from, to } = login.replacing;
  return (
    <div
      role="alertdialog"
      aria-label={`Log out ${short(from)}?`}
      className="rounded border border-amber-500/40 bg-amber-500/5 px-2.5 py-2"
    >
      <p className="text-[12px] font-medium text-amber-200">
        Log out <span className="num">{short(from)}</span>?
      </p>
      <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-4 text-[11px] leading-relaxed text-amber-200/90">
        <li>
          Trading moves to <span className="num">{short(to)}</span>.
        </li>
        {alertsLinked && (
          <li>
            Telegram alerts move to <span className="num">{short(to)}</span>.
          </li>
        )}
        <li>
          To close <span className="num">{short(from)}</span> positions, use the Boros app.
        </li>
      </ul>
      <div className="mt-2 flex gap-2">
        <button type="button" className="btn-primary num flex-1" onClick={() => login.answerReplace(true)}>
          Log in {short(to)}
        </button>
        <button
          type="button"
          className="rounded border border-ink-600 px-3 text-[11px] text-ink-300 hover:border-ink-400"
          onClick={() => login.answerReplace(false)}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export function BorosLogInButton({
  className,
  renew = false,
  onDone,
}: {
  className?: string;
  renew?: boolean;
  onDone?: (root: string) => void;
}) {
  const { address, loginLabel, openLogin } = useActiveWallet();
  const login = useBorosLogIn(onDone, address);
  // `renew`: the login still works but ends soon, so there is no loginLabel.
  const label = loginLabel ?? (renew && address ? `Renew login for ${short(address)}` : null);
  if (!label && !login.note) return null;
  return (
    <div className={`flex flex-col gap-1.5 ${className ?? ''}`}>
      {/* While the log-out question is open, its two buttons are the only choices. */}
      {label && !login.replacing && (
        <button
          type="button"
          className="btn-primary num w-full"
          disabled={login.busy}
          onClick={hasInjectedWallet() ? login.run : openLogin}
        >
          {buttonText(login, label)}
        </button>
      )}
      <ReplaceConfirm login={login} />
      {login.error && (
        <p role="alert" className="text-[11px] leading-relaxed text-rose-300">
          {login.error}
        </p>
      )}
      {login.note && <p className="text-[11px] leading-relaxed text-emerald-300">{login.note}</p>}
    </div>
  );
}

/**
 * The ticket's Boros status card. Status only: the ticket's own
 * "Log in to trade 0x…" button, where Confirm sits, is the one login.
 */
export function BorosAgentSetup() {
  const status = useBorosAgent();
  const forget = useForgetBorosAgent();
  const active = useActiveWallet();
  const [note, setNote] = useState<string | null>(null);

  if (status.isPending) {
    return <p className="text-[11px] text-ink-400">Checking Boros trading setup…</p>;
  }

  if (status.data?.configured) {
    const notApproved = status.data.approval === 'not-approved';
    const expiryDate = status.data.expiry ? new Date(status.data.expiry * 1000).toLocaleDateString() : null;
    // The same tag as the header chip and Settings, so one state has one name.
    const tagState = status.data.expired ? 'expired' : notApproved ? 'not-approved' : 'can-trade';
    return (
      <div className="rounded-lg border border-ink-700 bg-ink-950 px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="num text-[11px] text-ink-300">{status.data.rootMasked}</span>
          <WalletStateTag wallet={{ state: tagState, endsSoon: active.endsSoon }} />
          <button
            type="button"
            className="ml-auto rounded border border-ink-600 px-2 py-0.5 text-[10.5px] text-ink-300 hover:border-ink-400 disabled:opacity-50"
            disabled={forget.isPending}
            onClick={async () => {
              await forget.mutateAsync();
              setNote('Logged out. The approval stays live on-chain until you revoke it in the Boros app.');
            }}
          >
            {forget.isPending ? 'Logging out…' : 'Log out'}
          </button>
        </div>
        <p
          className="mt-1 text-[10.5px] leading-relaxed text-ink-500"
          title="A delegated key that signs your orders. It cannot deposit or withdraw."
        >
          Agent key — trades only, <span className="text-ink-300">cannot deposit or withdraw</span>
          {expiryDate && !status.data.expired && !notApproved ? ` · expires ${expiryDate}` : ''}
        </p>
        {status.data.expired && (
          // Otherwise this only shows up as AuthAgentExpired() on a confirm the
          // user has already committed to.
          <p className="mt-1 text-[10.5px] leading-relaxed text-rose-300">
            Your login ended{expiryDate ? ` on ${expiryDate}` : ''}. Boros refuses every order until you renew it.
          </p>
        )}
        {notApproved && !status.data.expired && (
          <p className="mt-1 text-[10.5px] leading-relaxed text-rose-300">
            Boros has no approval for this key. The wallet prompt was rejected, or the login was revoked in the
            Boros app. Log in again to trade.
          </p>
        )}
        {active.endsSoon !== null && (
          <p className="mt-1 text-[10.5px] leading-relaxed text-amber-300">
            Your login ends on {new Date(active.endsSoon * 1000).toLocaleDateString()}. Renew it in Settings to keep
            trading.
          </p>
        )}
        {note && <p className="mt-1 text-[10.5px] leading-relaxed text-amber-300">{note}</p>}
      </div>
    );
  }

  if (!status.data?.canProvision) {
    return (
      <p className="rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-[11px] leading-relaxed text-ink-400">
        This build cannot place Boros orders. You can still price a pair here and trade it in the
        Boros app.
      </p>
    );
  }

  return (
    <div className="rounded-lg border border-cyan-500/25 bg-cyan-500/5 px-3 py-2.5">
      <p className="text-[12px] font-medium text-ink-100">Enable Boros trading</p>
      <p className="mt-1 text-[10.5px] leading-relaxed text-ink-400">
        Log in once to approve a <span className="text-ink-200">delegated agent key</span>. The terminal then
        trades with that key — your wallet is not needed again, so a fill can be completed even with this tab
        closed.
      </p>
      <ol className="mt-1.5 flex flex-col gap-0.5 text-[10.5px] leading-relaxed text-ink-400">
        <li>1. Connect your wallet ({BOROS_CHAIN.name})</li>
        <li>2. Approve the agent — one on-chain transaction</li>
        <li>3. The key is stored on this machine only</li>
      </ol>
      <p className="mt-1.5 text-[10.5px] leading-relaxed text-ink-300">Approval cost: free</p>
      <p className="mt-1.5 text-[10.5px] leading-relaxed text-ink-500">
        The agent can <span className="text-ink-300">trade</span> this account. It{' '}
        <span className="text-ink-300">cannot deposit or withdraw</span> — Boros requires your wallet for that,
        and this tool never asks for your wallet's key.
      </p>
      {active.address === null && (
        <div className="mt-2">
          <ConnectWalletButton />
        </div>
      )}
    </div>
  );
}
