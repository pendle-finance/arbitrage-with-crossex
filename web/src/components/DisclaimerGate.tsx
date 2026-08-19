import { useState } from 'react';
import { useAcceptDisclaimer, useDisclaimer } from '../api/queries';
import { Modal } from './Modal';

const DISCLAIMER_URL = 'https://github.com/pendle-finance/crossex-boros-terminal/blob/main/docs/DISCLAIMER.md';

/** First-run gate: blocks the terminal until the disclaimer is accepted. The
 * server ALSO refuses trading routes until acceptance is recorded — this modal
 * is the user-facing half. Renders nothing while the status loads, or if the
 * endpoint is unavailable, so it never locks anyone out on a transient error
 * (the server gate is the backstop). */
export function DisclaimerGate() {
  const status = useDisclaimer();
  const accept = useAcceptDisclaimer();
  const [checked, setChecked] = useState(false);
  const [declined, setDeclined] = useState(false);

  // Block only once we KNOW the current version is unaccepted.
  if (!status.data || status.data.accepted) return null;
  const { version } = status.data;

  if (declined) {
    return (
      <Modal title="Disclaimer required" locked onClose={() => {}} widthClass="w-[460px]">
        <div className="flex flex-col gap-4 px-5 py-5 text-sm leading-relaxed text-ink-200">
          <p>
            You must accept the disclaimer to use this software. Nothing runs and no order can be
            placed until you do.
          </p>
          <div className="flex justify-end">
            <button type="button" className="btn" onClick={() => setDeclined(false)}>
              Review again
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Before you continue" locked onClose={() => {}} widthClass="w-[460px]">
      <div className="flex flex-col gap-4 px-5 py-5 text-sm leading-relaxed text-ink-200">
        <p>
          This is an experimental <strong>open-source project by Pendle</strong>, provided{' '}
          <strong>"as is"</strong> and free of charge. It is{' '}
          <strong>not financial advice</strong>. It places{' '}
          <strong>real orders with real funds</strong> on your own exchange accounts — you may lose
          money, including more than your margin. You use it entirely at your own risk.
        </p>
        <label className="flex items-start gap-2.5">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
          />
          <span>
            I have read and agree to the{' '}
            <a
              href={DISCLAIMER_URL}
              target="_blank"
              rel="noreferrer"
              className="text-cyan-300 underline decoration-cyan-500/40 underline-offset-2 hover:text-cyan-200"
            >
              DISCLAIMER
            </a>
            .
          </span>
        </label>
        {accept.isError && (
          <p role="alert" className="text-[12px] text-rose-300">
            Couldn't record your acceptance — please try again.
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="btn"
            disabled={accept.isPending}
            onClick={() => setDeclined(true)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!checked || accept.isPending}
            onClick={() => accept.mutate(version)}
          >
            {accept.isPending ? 'Saving…' : 'Agree and continue'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
