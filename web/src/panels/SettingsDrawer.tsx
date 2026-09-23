import { useState } from 'react';
import { useVersion } from '../api/queries';
import { Drawer } from '../components/Drawer';
import { GithubMark } from '../components/GithubMark';
import { REPO_URL } from '../lib/app';
import type { SetupStep } from './setup/setupState';
import { SetupRows } from './setup/SetupRows';

export function SettingsDrawer({
  open,
  onClose,
  focusStep = null,
}: {
  open: boolean;
  onClose: () => void;
  focusStep?: SetupStep | null;
}) {
  const version = useVersion(); // same query key as the header pill — deduped
  const install = version.data?.install ?? null;
  const [openStep, setOpenStep] = useState<SetupStep | null>(open ? focusStep : null);
  const [committed, setCommitted] = useState({ open, focusStep });
  if (committed.open !== open || committed.focusStep !== focusStep) {
    setCommitted({ open, focusStep });
    if (open) setOpenStep(focusStep);
  }

  return (
    <Drawer open={open} title="Settings" onClose={onClose}>
      <div className="flex flex-col gap-6">
        <SetupRows
          openStep={openStep}
          onOpenStep={setOpenStep}
          onDone={() => setOpenStep(null)}
          variant="settings"
        />
        <section>
          <h3 className="mb-2 text-[12px] font-normal leading-[14.52px] text-ink-300">
            About
          </h3>
          <div className="flex flex-col gap-[5px] rounded border border-ink-700 px-3 py-[11px] text-[11.5px] text-ink-100">
            <div className="flex items-baseline justify-between gap-3">
              <div className="num">
                Version {version.data?.current ?? 'unknown'}
                {/* Gold, not a button: an available update is a FACT about this
                    install, and the upgrade runs through the installer, not from
                    in here. Colouring it is what makes it noticed. */}
                {version.data?.updateAvailable && version.data.latest ? (
                  <span className="text-gold"> — v{version.data.latest} available</span>
                ) : null}
              </div>
              <a
                href={REPO_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex shrink-0 items-center gap-1.5 text-ink-300 hover:text-ink-100"
              >
                <GithubMark size={13} />
                GitHub
              </a>
            </div>
            {/* Which code is actually running: the installer records the exact
                commit it laid down, so "did I install what I audited?" has an
                answer in the app. A checkout has no installer provenance. */}
            <div className="num text-[11px] text-ink-300">
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
