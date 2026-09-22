import { useState } from 'react';
import { useBorosAgent } from '../../api/queries';
import { SegmentedToggle } from '../../components/SegmentedToggle';
import { BorosAgentSetup } from '../../trade/BorosAgentSetup';
import { AddressForm, short } from '../HomeControls';
import { useTrackedAddress } from '../trackedAddress';
import { SetupRowFrame } from './SetupRowFrame';
import type { SetupRowProps } from './setupState';

type Tab = 'connect' | 'paste';

const TABS: { value: Tab; label: string }[] = [
  { value: 'connect', label: 'Connect wallet' },
  { value: 'paste', label: 'Paste address' },
];

const isSameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

function walletLine(root: string | null, isExpired: boolean, tracked: string | null): string | null {
  if (root && isExpired) return 'Approval expired';
  if (root) return `${short(root)} · can trade${tracked && isSameAddress(root, tracked) ? ' · tracked' : ''}`;
  if (tracked) return `${short(tracked)} · tracked`;
  return null;
}

export function BorosWalletRow(p: SetupRowProps) {
  const agent = useBorosAgent();
  const { address, setAddress } = useTrackedAddress();
  const root = agent.data?.configured ? agent.data.root : null;
  const isExpired = root !== null && agent.data?.expired === true;
  const [tab, setTab] = useState<Tab>(!root && address ? 'paste' : 'connect');

  const nudge =
    root && address && !isSameAddress(root, address) ? (
      <div className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
        <div className="flex gap-3">
          <span className="w-28 shrink-0 text-ink-500">Trading wallet</span>
          <span className="num text-ink-200">{short(root)}</span>
        </div>
        <div className="flex gap-3">
          <span className="w-28 shrink-0 text-ink-500">Tracked address</span>
          <span className="num text-ink-200">{short(address)}</span>
        </div>
        <p className="text-amber-300">Boros legs you open here will not show on Positions.</p>
        <button type="button" className="btn num w-fit" onClick={() => setAddress(root)}>
          {`Track ${short(root)}`}
        </button>
      </div>
    ) : null;

  return (
    <SetupRowFrame
      n={2}
      title="Boros wallet"
      row={p}
      isDone={root !== null || address !== null}
      state={walletLine(root, isExpired, address)}
      isWarn={isExpired}
      alert={nudge}
      skipConsequence="Without a Boros wallet the terminal cannot open Boros legs, and Positions cannot show them."
      closeLabel="Close"
    >
      <SegmentedToggle value={tab} options={TABS} onChange={setTab} ariaLabel="Boros wallet source" />
      {tab === 'connect' ? (
        <BorosAgentSetup
          compact
          onDone={(wallet) => {
            setAddress(wallet);
            p.onDone();
          }}
        />
      ) : (
        <>
          <p className="text-xs text-ink-400">Tracks positions only. The terminal cannot place Boros orders.</p>
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
