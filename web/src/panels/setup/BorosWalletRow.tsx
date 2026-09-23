import { useState } from 'react';
import { useBorosAgent } from '../../api/queries';
import { SegmentedToggle } from '../../components/SegmentedToggle';
import { BorosAgentSetup } from '../../trade/BorosAgentSetup';
import { AddressForm, short } from '../HomeControls';
import { isSameAddress, useActiveWallet, useTrackedAddress } from '../trackedAddress';
import { SetupRowFrame } from './SetupRowFrame';
import type { SetupRowProps } from './setupState';

type Tab = 'connect' | 'paste';

const TABS: { value: Tab; label: string }[] = [
  { value: 'connect', label: 'Connect wallet' },
  { value: 'paste', label: 'Paste address' },
];

function walletLine(address: string | null, isExpired: boolean, canTrade: boolean, follows: boolean): string | null {
  if (!address) return null;
  const line = isExpired ? 'Approval expired' : `${short(address)} · ${canTrade ? 'can trade' : 'view only'}`;
  return follows ? `${line} · follows your wallet` : line;
}

export function BorosWalletRow(p: SetupRowProps) {
  const agent = useBorosAgent();
  const { address, setAddress, followWallet, upgradeNote, dismissUpgradeNote } = useTrackedAddress();
  const { canTrade } = useActiveWallet();
  const root = agent.data?.configured ? agent.data.root : null;
  const isExpired = root !== null && address !== null && isSameAddress(root, address) && agent.data?.expired === true;
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
      state={walletLine(address, isExpired, canTrade, followWallet)}
      isWarn={isExpired}
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
