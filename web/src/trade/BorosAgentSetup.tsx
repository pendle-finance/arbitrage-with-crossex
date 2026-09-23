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
import { useState } from 'react';
import type { Hex } from 'viem';
import { useBorosAgent, useForgetBorosAgent, useProvisionBorosAgent } from '../api/queries';
import { Chip } from '../components/Chip';
import { short } from '../panels/HomeControls';
import { isSameAddress, useActiveWallet, useTrackedAddressOptional } from '../panels/trackedAddress';
import { connectWallet, describeWalletError, hasInjectedWallet, BOROS_CHAIN } from '../lib/wallet';

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

type Step = 'idle' | 'connecting' | 'approving' | 'saving';

const STEP_LABEL: Record<Exclude<Step, 'idle'>, string> = {
  connecting: 'Waiting for your wallet…',
  approving: 'Approving the agent on-chain…',
  saving: 'Handing the key to your terminal…',
};

function useBorosLogIn(onDone?: (root: string) => void, expected?: string | null) {
  const provision = useProvisionBorosAgent();
  const tracked = useTrackedAddressOptional();
  const [step, setStep] = useState<Step>('idle');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const run = async () => {
    setError(null);
    setNote(null);
    try {
      setStep('connecting');
      const wallet = await connectWallet();
      if (expected && !isSameAddress(wallet.address, expected)) {
        setError(`Your browser wallet is ${short(wallet.address)}. Switch it to ${short(expected)} to log in.`);
        return;
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
      // gas, and revocable only by hand in the Boros app.
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
      setNote(
        `Done — this terminal can place Boros orders until ${new Date(expiry * 1000).toLocaleDateString()}.`,
      );
      tracked?.setAddress(wallet.address);
      onDone?.(wallet.address);
    } catch (err) {
      setError(describeWalletError(err));
    } finally {
      setStep('idle');
    }
  };

  return { run, step, busy: step !== 'idle', error, note, setNote };
}

export function BorosLogInButton({ className }: { className?: string }) {
  const { address, loginLabel, openLogin } = useActiveWallet();
  const login = useBorosLogIn(undefined, address);
  if (!loginLabel) return null;
  return (
    <div className={`flex flex-col gap-1.5 ${className ?? ''}`}>
      <button
        type="button"
        className="btn-primary num w-full"
        disabled={login.busy}
        onClick={hasInjectedWallet() ? login.run : openLogin}
      >
        {login.busy ? STEP_LABEL[login.step as Exclude<Step, 'idle'>] : loginLabel}
      </button>
      {login.error && (
        <p role="alert" className="text-[11px] leading-relaxed text-rose-300">
          {login.error}
        </p>
      )}
    </div>
  );
}

export function BorosAgentSetup({
  onDone,
  compact = false,
  hideConnect = false,
}: {
  onDone?: (root: string) => void;
  compact?: boolean;
  hideConnect?: boolean;
}) {
  const status = useBorosAgent();
  const forget = useForgetBorosAgent();
  const tracked = useTrackedAddressOptional();
  const { run, step, busy, error, note, setNote } = useBorosLogIn(onDone);

  const connectButton = hideConnect ? null : !hasInjectedWallet() ? (
    <p className="mt-2 text-[11px] leading-relaxed text-amber-300">
      No browser wallet detected. Install MetaMask (or another injected wallet) and reload.
    </p>
  ) : (
    <button
      type="button"
      disabled={busy}
      onClick={run}
      className="mt-2 w-full rounded border border-cyan-500/60 bg-cyan-500/15 px-2 py-1.5 text-[12px] font-medium text-cyan-200 hover:bg-cyan-500/25 disabled:opacity-60"
    >
      {busy ? STEP_LABEL[step as Exclude<Step, 'idle'>] : 'Connect wallet'}
    </button>
  );

  if (status.isPending) {
    return <p className="text-[11px] text-ink-400">Checking Boros trading setup…</p>;
  }

  if (status.data?.configured) {
    const active = tracked?.address ?? null;
    const root = status.data.root;
    const otherWallet = active && root && !isSameAddress(active, root) ? short(active) : null;
    return (
      <div className="rounded-lg border border-ink-700 bg-ink-950 px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <Chip sm tone={status.data.expired ? 'red' : 'green'}>
            {status.data.expired ? 'approval expired' : 'trading enabled'}
          </Chip>
          <span className="num text-[11px] text-ink-300">{status.data.rootMasked}</span>
          <button
            type="button"
            className="ml-auto rounded border border-ink-600 px-2 py-0.5 text-[10.5px] text-ink-300 hover:border-ink-400 disabled:opacity-50"
            disabled={forget.isPending}
            onClick={async () => {
              const res = await forget.mutateAsync();
              setNote(res.note);
            }}
          >
            {forget.isPending ? 'Removing…' : 'Remove key'}
          </button>
        </div>
        <p
          className="mt-1 text-[10.5px] leading-relaxed text-ink-500"
          title="A delegated key that signs your orders. It cannot deposit or withdraw."
        >
          Agent key — trades only, <span className="text-ink-300">cannot deposit or withdraw</span>
          {status.data.expiry !== null && !status.data.expired
            ? ` · expires ${new Date(status.data.expiry * 1000).toLocaleDateString()}`
            : ''}
        </p>
        {status.data.expired ? (
          // Otherwise this only shows up as AuthAgentExpired() on a confirm the
          // user has already committed to.
          <p className="mt-1 text-[10.5px] leading-relaxed text-rose-300">
            The on-chain approval lapsed
            {status.data.expiry ? ` on ${new Date(status.data.expiry * 1000).toLocaleDateString()}` : ''} —
            every order will be refused. Remove the key and connect again to re-approve.
          </p>
        ) : (
          null
        )}
        {note && <p className="mt-1 text-[10.5px] leading-relaxed text-amber-300">{note}</p>}
        {otherWallet && (
          <>
            <p className="mt-1 text-[10.5px] leading-relaxed text-ink-400">
              Connect <span className="num text-ink-200">{otherWallet}</span> to trade it.
            </p>
            {connectButton}
            {error && (
              <p role="alert" className="mt-1.5 text-[11px] leading-relaxed text-rose-300">
                {error}
              </p>
            )}
          </>
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
      {compact ? (
        <p className="text-xs text-ink-400">Connect the wallet that holds your Boros account.</p>
      ) : (
        <>
          <p className="text-[12px] font-medium text-ink-100">Enable Boros trading</p>
          <p className="mt-1 text-[10.5px] leading-relaxed text-ink-400">
            Connect once to approve a <span className="text-ink-200">delegated agent key</span>. The
            terminal then trades with that key — your wallet is not needed again, so a fill can be
            completed even with this tab closed.
          </p>
          <ol className="mt-1.5 flex flex-col gap-0.5 text-[10.5px] leading-relaxed text-ink-400">
            <li>1. Connect your wallet ({BOROS_CHAIN.name})</li>
            <li>2. Approve the agent — one on-chain transaction</li>
            <li>3. The key is stored on this machine only</li>
          </ol>
        </>
      )}
      <p className="mt-1.5 text-[10.5px] leading-relaxed text-ink-300">Approval cost: free</p>
      {!compact && (
        <p className="mt-1.5 text-[10.5px] leading-relaxed text-ink-500">
          The agent can <span className="text-ink-300">trade</span> this account. It{' '}
          <span className="text-ink-300">cannot deposit or withdraw</span> — Boros requires your
          wallet for that, and this tool never asks for your wallet's key.
        </p>
      )}

      {connectButton}
      {error && (
        <p role="alert" className="mt-1.5 text-[11px] leading-relaxed text-rose-300">
          {error}
        </p>
      )}
      {note && <p className="mt-1.5 text-[11px] leading-relaxed text-emerald-300">{note}</p>}
    </div>
  );
}
