import { useState } from 'react';
import { SegmentedToggle } from '../../components/SegmentedToggle';
import { BorosAgentSetup } from '../../trade/BorosAgentSetup';
import { AddressForm, short } from '../HomeControls';
import { useActiveWallet, useTrackedAddress, type ActiveWalletState } from '../trackedAddress';
import { SetupRowFrame } from './SetupRowFrame';
import type { SetupRowProps } from './setupState';

type Tab = 'connect' | 'paste';

const TABS: { value: Tab; label: string }[] = [
  { value: 'connect', label: 'Connect wallet' },
  { value: 'paste', label: 'Paste address' },
];

const STATE_TEXT: Record<ActiveWalletState, string> = {
  'can-trade': 'can trade',
  'view-only': 'view only',
  expired: 'login expired',
  'not-approved': 'not approved',
};

function walletLine(address: string | null, state: ActiveWalletState | null, follows: boolean): string | null {
  if (!address) return null;
  const line = `${short(address)} · ${STATE_TEXT[state ?? 'view-only']}`;
  return follows ? `${line} · follows your wallet` : line;
}

export function BorosWalletRow(p: SetupRowProps) {
  const { address, setAddress, followWallet, upgradeNote, dismissUpgradeNote } = useTrackedAddress();
  const { state } = useActiveWallet();
  // The trader's own wallet, but Boros refuses its orders.
  const isBroken = state === 'expired' || state === 'not-approved';
  const [tab, setTab] = useState<Tab>('connect');

  const note = upgradeNote ? (
    <div className="flex items-center gap-3 rounded-lg border border-ink-700 px-3 py-2 text-xs text-ink-300">
      <span>
        Now showing <span className="num text-ink-100">{short(upgradeNote)}</span>, the wallet that trades.
      </span>
      <button type="button" className="btn-link ml-auto" onClick={dismissUpgradeNote}>
        Dismiss
      </button>
    </div>
  ) : null;

  return (
    <SetupRowFrame
      n={2}
      title="Boros wallet"
      row={p}
      isDone={address !== null}
      state={walletLine(address, state, followWallet)}
      isWarn={isBroken}
      alert={note}
      skipConsequence="Without a Boros wallet the terminal cannot open Boros legs, and Positions cannot show them."
      closeLabel="Close"
    >
      <SegmentedToggle value={tab} options={TABS} onChange={setTab} ariaLabel="Boros wallet source" />
      {tab === 'connect' ? (
        <BorosAgentSetup compact onDone={() => p.onDone()} />
      ) : (
        <>
          <p className="text-xs text-ink-400">View only. Log in to trade.</p>
          <AddressForm
            full
            initial={address ?? ''}
            submitLabel="Track address"
            onTrack={(next) => {
              setAddress(next);
              p.onDone();
            }}
          />
        </>
      )}
      {address && (
        <button type="button" className="btn-link" onClick={() => setAddress(null)}>
          Stop tracking
        </button>
      )}
    </SetupRowFrame>
  );
}
