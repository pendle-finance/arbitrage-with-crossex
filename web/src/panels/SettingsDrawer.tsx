import { useCredentials, useVersion } from '../api/queries';
import { CredentialsForm } from '../components/CredentialsForm';
import { Drawer } from '../components/Drawer';
import { SegmentedToggle } from '../components/SegmentedToggle';
import { AddressForm } from './HomeControls';
import { useTrackedAddress } from './trackedAddress';

/** Settings drawer: the tracked Boros address, masked key display, and the
 * replace-credentials form. */
export function SettingsDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data } = useCredentials();
  const { address, capitalBasis, setAddress, setCapitalBasis } = useTrackedAddress();
  const version = useVersion(); // same query key as the header pill — deduped
  const install = version.data?.install ?? null;

  return (
    <Drawer open={open} title="Settings" onClose={onClose}>
      <div className="flex flex-col gap-6">
        <section>
          <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-400">
            Tracked Boros address
          </h3>
          <p className="mb-2 text-xs leading-relaxed text-ink-400">
            The EVM address holding your Boros legs. The terminal matches them with your Gate perp
            legs to show your locked and realized return, net of all costs.
          </p>
          <div className="card num mb-2 break-all px-4 py-3 text-xs text-ink-200">
            {address ?? 'not tracking any address'}
          </div>
          {/* Remount on change so the input picks up the new address. */}
          <AddressForm
            key={address ?? 'none'}
            full
            initial={address ?? ''}
            submitLabel={address ? 'Update' : 'Track'}
            onTrack={setAddress}
          />
          {address && (
            <button
              type="button"
              className="btn-ghost-xs mt-2"
              onClick={() => setAddress(null)}
            >
              Stop tracking
            </button>
          )}
        </section>

        <section>
          <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-400">
            Capital counted per position
          </h3>
          <p className="mb-2 text-xs leading-relaxed text-ink-400">
            Every APR is a return ON this number, so it decides whether a position looks good.
            The perp side is always its initial margin; this picks what the Boros side counts.
          </p>
          <SegmentedToggle
            ariaLabel="Boros capital"
            value={capitalBasis}
            onChange={setCapitalBasis}
            options={[
              { value: 'balance', label: 'Posted balance' },
              { value: 'im', label: 'Margin used' },
            ]}
          />
          <p className="mt-2 text-xs leading-relaxed text-ink-500">
            {capitalBasis === 'balance'
              ? 'Counting the whole collateral balance. If you also keep trading money in that account, it is counted as capital these positions needed — switch to Margin used.'
              : 'Counting only the margin the Boros legs post. Idle cash in the same collateral account is left out.'}
          </p>
        </section>

        <section>
          <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-400">
            Gate API key
          </h3>
          <div className="card num px-4 py-3 text-sm text-ink-200">
            {data?.configured ? data.keyMasked ?? '(configured)' : 'not configured'}
          </div>
        </section>

        <section>
          <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-400">
            Replace credentials
          </h3>
          <CredentialsForm submitLabel="Replace credentials" />
        </section>
        <section>
          <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-400">
            About
          </h3>
          <div className="card px-4 py-3 text-xs text-ink-200">
            <div className="num">
              Version {version.data?.current ?? 'unknown'}
              {version.data?.updateAvailable && version.data.latest
                ? ` — v${version.data.latest} available`
                : ''}
            </div>
            {/* Which code is actually running: the installer records the exact
                commit it laid down, so "did I install what I audited?" has an
                answer in the app. A checkout has no installer provenance. */}
            <div className="num mt-1 text-[11px] text-ink-400">
              {install ? (
                <>
                  {install.commit ? (
                    install.repo ? (
                      <a
                        href={`https://github.com/${install.repo}/commit/${install.commit}`}
                        target="_blank"
                        rel="noreferrer"
                        className="underline decoration-ink-600 underline-offset-2 hover:text-ink-200"
                      >
                        {install.commit.slice(0, 9)}
                      </a>
                    ) : (
                      install.commit.slice(0, 9)
                    )
                  ) : (
                    'commit unknown'
                  )}
                  {install.requestedRef ? ` · ${install.requestedRef}` : ''}
                  {install.installedAt ? ` · installed ${install.installedAt.slice(0, 10)}` : ''}
                </>
              ) : (
                'source checkout'
              )}
            </div>
          </div>
        </section>
      </div>
    </Drawer>
  );
}
