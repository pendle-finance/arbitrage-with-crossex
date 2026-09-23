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
import { useEffect, useRef, useState } from 'react';
import type { Hex } from 'viem';
import { fetchJson, postJson } from '../api/client';
import { qk, useBorosAgent, useProvisionBorosAgent, useTelegramLinked } from '../api/queries';
import type { BorosAgentStatus } from '../api/types';
import { WalletStateTag } from '../components/ActiveWalletChip';
import { ConnectWalletButton } from '../components/ConnectWalletButton';
import { useToastOptional } from '../components/Toast';
import { fmtDateShort } from '../lib/fmt';
import { isLoginInFlight, setLoginInFlight, useLoginInFlight } from '../lib/loginInFlight';
import { short } from '../panels/HomeControls';
import { isSameAddress, useActiveWallet, useTrackedAddressOptional } from '../panels/trackedAddress';
import { connectWallet, describeWalletError, hasInjectedWallet } from '../lib/wallet';
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
  connecting: 'Open your wallet…',
  replace: 'Waiting for your answer…',
  saving: 'Saving the key on this machine…',
  approving: 'Sign in your wallet…',
  confirming: 'Waiting for Boros…',
};

export const NOT_APPROVED_TEXT = 'Boros shows no approval for this login. Log in again.';

const day = (unix: number): string => fmtDateShort(unix, { year: 'numeric' });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TELEGRAM_REFRESH_MS = 2_000;

type Confirmed = 'approved' | 'older-server' | 'timeout' | 'unchecked';

async function waitForApproval(root: string): Promise<Confirmed> {
  let lastUnknown = false;
  for (let i = 0; i < CONFIRM_TRIES; i++) {
    const s = await fetchJson<BorosAgentStatus>('/boros/agent?fresh=1').catch(() => null);
    if (s?.root && isSameAddress(s.root, root)) {
      if (!('approval' in s)) return 'older-server';
      if (s.approval === 'approved') return 'approved';
      lastUnknown = s.approval === 'unknown';
    }
    if (i < CONFIRM_TRIES - 1) await sleep(CONFIRM_EVERY_MS);
  }
  return lastUnknown ? 'unchecked' : 'timeout';
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
    if (isLoginInFlight()) return;
    setLoginInFlight(true);
    setError(null);
    setNote(null);
    const prev = status.data?.configured && status.data.root ? status.data.root : null;
    let provisioned = false;
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
      setStep('saving');
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
      await provision.mutateAsync({
        root: wallet.address,
        accountId: 0,
        agentPrivateKey: privateKey as Hex,
        expiry,
      });
      provisioned = true;

      setStep('approving');
      await approveAgent({
        walletClient: wallet.client,
        root: wallet.address,
        accountId: 0,
        agentAddress,
        expiry,
      });

      // Not done until Boros shows the approval.
      provisioned = false;
      setStep('confirming');
      const confirmed = await waitForApproval(wallet.address);
      void qc.invalidateQueries({ queryKey: qk.borosAgent });
      if (confirmed === 'timeout') {
        setError('Boros has not confirmed the approval yet. Wait a minute. If Log in still shows, log in again.');
        return;
      }
      if (confirmed === 'unchecked') {
        setError('Boros did not answer. If Log in shows again, the approval did not land.');
        return;
      }
      // The server moves Telegram alerts to this wallet on its next sync, which
      // the approval starts. Re-read the Telegram row once that has had time.
      setTimeout(() => void qc.invalidateQueries({ queryKey: qk.telegram }), TELEGRAM_REFRESH_MS);
      const done = `Logged in. This terminal can trade ${short(wallet.address)} until ${day(expiry)}.`;
      setNote(done);
      toast?.push('success', done);
      tracked?.followBrowserWallet(wallet.address);
      onDone?.(wallet.address);
    } catch (err) {
      let restored = false;
      if (provisioned) {
        restored = await postJson('/boros/agent/rollback', {}).then(
          () => true,
          () => false,
        );
        void qc.invalidateQueries({ queryKey: qk.borosAgent });
      }
      setError(`${describeWalletError(err)}${restored && prev ? ` ${short(prev)} is still logged in.` : ''}`);
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
      aria-label={`Log out ${short(from)} and log in ${short(to)}?`}
      className="rounded border border-amber-500/40 bg-amber-500/5 px-2.5 py-2"
    >
      <p className="text-[12px] font-medium text-amber-200">
        Log out <span className="num">{short(from)}</span> and log in <span className="num">{short(to)}</span>?
      </p>
      <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-4 text-[11px] leading-relaxed text-amber-200/90">
        <li>
          This terminal trades <span className="num">{short(to)}</span>.
        </li>
        {alertsLinked && (
          <li>
            Telegram alerts are per wallet. If <span className="num">{short(to)}</span> has none, set them up once in
            Settings.
          </li>
        )}
        <li>
          <span className="num">{short(from)}</span> positions stay open. Close them in the Boros app.
        </li>
        <li>
          Your Gate perps stay open. They show as unhedged until you log in <span className="num">{short(from)}</span>{' '}
          again.
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
  if (!label && !login.note && !login.error) return null;
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
  const active = useActiveWallet();

  if (status.isPending) {
    return <p className="text-[11px] text-ink-400">Checking Boros trading setup…</p>;
  }

  if (status.data?.configured) {
    const { expired, expiry, approval } = status.data;
    const notApproved = !expired && approval === 'not-approved';
    const tagState = expired
      ? 'expired'
      : notApproved
        ? 'not-approved'
        : approval === 'unknown'
          ? 'unchecked'
          : 'can-trade';
    const warning = expired
      ? `Login ended${expiry ? ` ${day(expiry)}` : ''}. Boros refuses orders.`
      : notApproved
        ? NOT_APPROVED_TEXT
        : active.endsSoon !== null
          ? `Login ends ${day(active.endsSoon)}. Renew it in Settings.`
          : null;
    return (
      <div className="rounded-lg border border-ink-700 bg-ink-950 px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="num text-[11px] text-ink-300">{status.data.rootMasked}</span>
          <WalletStateTag wallet={{ state: tagState, endsSoon: active.endsSoon }} />
        </div>
        {warning && (
          <p
            className={`mt-1 text-[10.5px] leading-relaxed ${expired || notApproved ? 'text-rose-300' : 'text-amber-300'}`}
          >
            {warning}
          </p>
        )}
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
      <p className="text-[10.5px] leading-relaxed text-ink-300">
        Log in once to trade. One free wallet signature. The key trades only. It cannot deposit or withdraw.
      </p>
      {active.address === null && (
        <div className="mt-2">
          <ConnectWalletButton />
        </div>
      )}
    </div>
  );
}
