import { useEffect, useState } from 'react';
import { ApiError } from '../api/client';
import { useInstallWatch, useRunUpdate, useUpdateLog, useVersion } from '../api/queries';
import { INSTALL_CMD, INSTALL_CMD_WINDOWS, REPO_URL } from '../lib/app';
import { readUpdateLog, UPDATE_PHASES } from '../lib/updateProgress';
import { CopyBlock } from './CopyBlock';
import { Modal } from './Modal';
import { SegmentedToggle } from './SegmentedToggle';

const CHANGELOG_URL = `${REPO_URL}/blob/main/CHANGELOG.md`;

type Os = 'macos' | 'windows';
/** Let the app do it, or do it yourself. One choice, one button under it. */
type Route = 'auto' | 'manual';

const OS_LABEL: Record<Os, string> = { macos: 'macOS', windows: 'Windows' };
const INSTALL_BY_OS: Record<Os, string> = { macos: INSTALL_CMD, windows: INSTALL_CMD_WINDOWS };
const thisMachine = (): Os => (navigator.userAgent.includes('Windows') ? 'windows' : 'macos');

const LINK_CLASS =
  'text-xs text-cyan-300 underline decoration-cyan-500/40 underline-offset-2 hover:text-cyan-200';

/** Longer than any install anyone has timed. Past it the panel stops implying
 * that waiting is still the right thing to do, and puts the log in reach. */
const SLOW_MS = 4 * 60_000;

const clock = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * What the installer is doing, while it does it.
 *
 * The old dialog said "this takes a few minutes" and then showed the same
 * screen for those minutes, which looks exactly like a stuck update — one
 * trader waited five. Three things fix that and all three come from the log:
 * the step it is on, a clock that moves, and a checklist that fills in.
 */
function UpdateProgress({
  startedAt,
  text,
  offline,
  logPath,
  onRetry,
}: {
  startedAt: number;
  text: string;
  /** The server stopped answering — normal, and expected near the end. */
  offline: boolean;
  logPath: string;
  onRetry: () => void;
}) {
  const { step, phase, done, failed, plain } = readUpdateLog(text);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (done || failed) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [done, failed]);

  const elapsed = now - startedAt;
  const slow = !done && !failed && elapsed > SLOW_MS;
  const pct = done ? 100 : Math.round(((phase + 1) / (UPDATE_PHASES.length + 1)) * 100);
  const headline = failed
    ? 'The update failed. Your previous version is running again.'
    : done
      ? 'Updated. Reloading this page…'
      : offline
        ? 'Restarting the app…'
        : (step ?? 'Starting the installer…');

  return (
    <div
      role="status"
      className={`rounded-lg border p-3 ${
        failed
          ? 'border-rose-500/40 bg-rose-500/[0.06]'
          : slow
            ? 'border-amber-500/40 bg-amber-500/[0.06]'
            : 'border-ink-700 bg-ink-950/60'
      }`}
    >
      <div className="flex items-baseline gap-2">
        {(failed || done) && (
          <span className={failed ? 'text-rose-400' : 'text-emerald-400'}>{failed ? '✕' : '✓'}</span>
        )}
        <span className="min-w-0 flex-1 truncate text-[13px] text-ink-100">{headline}</span>
        <span className="num shrink-0 text-[11px] text-ink-500">{clock(elapsed)}</span>
      </div>

      {!failed && (
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-ink-800">
          <div
            className="h-full rounded-full bg-cyan-400 transition-[width] duration-700"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}

      <ol className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1">
        {UPDATE_PHASES.map((p, i) => {
          // A failed update leaves nothing running, so the step it died on
          // must stop pulsing — a live marker under an ✕ reads as still working.
          const state =
            done || i < phase ? 'done' : i === phase && !failed ? 'now' : 'next';
          return (
            <li
              key={p.key}
              className={`flex items-center gap-1.5 text-[11px] ${
                state === 'now' ? 'text-cyan-200' : state === 'done' ? 'text-ink-400' : 'text-ink-600'
              }`}
            >
              <span
                className={
                  state === 'done'
                    ? 'text-emerald-400'
                    : state === 'now'
                      ? 'animate-pulse text-cyan-300'
                      : ''
                }
              >
                {state === 'done' ? '✓' : state === 'now' ? '●' : '○'}
              </span>
              {p.label}
            </li>
          );
        })}
      </ol>

      <p className="mt-2.5 text-[12px] text-ink-400">
        {failed
          ? 'Your keys and trade history are untouched. Try again, or run the command yourself.'
          : slow
            ? 'This is taking longer than usual. The installer’s own output is below.'
            : 'Installation running in the background. This page reloads itself when it is done.'}
      </p>

      <details className="mt-2">
        <summary className="cursor-pointer text-[11px] text-ink-500 hover:text-ink-300">
          Show log
        </summary>
        <pre className="num mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md border border-ink-800 bg-ink-950 p-2 text-[10px] leading-relaxed text-ink-400">
          {plain.trim() || 'nothing yet'}
        </pre>
        <p className="num mt-1 break-all text-[10px] text-ink-600">{logPath}</p>
      </details>

      {failed && (
        <button type="button" className="btn mt-2.5 text-xs" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function UpdateIndicator() {
  const { data } = useVersion();
  const runUpdate = useRunUpdate();
  const [open, setOpen] = useState(false);
  const [route, setRoute] = useState<Route>('auto');
  const [os, setOs] = useState<Os>(thisMachine);
  /** The dialog's own clock. The server's start time does not survive the swap
   * that replaces it, and this is what the user is actually timing. */
  const [startedAt, setStartedAt] = useState<number | null>(null);

  const running = runUpdate.data != null;
  const log = useUpdateLog(running);

  /**
   * RELOAD ONTO THE NEW BUNDLE, once the swap has actually happened.
   *
   * After a successful update this page reconnects to the new server still
   * running the OLD javascript, and its version answer is cached for six
   * hours. So the badge went on reading "Update available" for something the
   * machine already had — and clicking it again re-ran the installer and
   * re-opened the ten-minute window that refuses every Boros write.
   *
   * The commit is the signal, not a timer: it changes exactly when the new
   * copy is serving, however long the install took.
   */
  const installedCommit = data?.install?.commit ?? null;
  const servingCommit = useInstallWatch(running).data?.install?.commit ?? null;
  useEffect(() => {
    if (installedCommit && servingCommit && servingCommit !== installedCommit) {
      window.location.reload();
    }
  }, [installedCommit, servingCommit]);

  if (!data?.updateAvailable || !data.latest) return null;

  const target = data.latestCommit ?? 'main';
  const changesUrl = data.install?.commit
    ? `${REPO_URL}/compare/${data.install.commit}...${target}`
    : `${REPO_URL}/commits/${target}`;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={
          running
            ? 'The update is installing — click to watch it'
            : `Version ${data.latest} is available — click to review and update`
        }
        className="hdr-ctl border-amber-500/50 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20"
      >
        {running ? 'Updating…' : `Update v${data.latest}`}
      </button>
      {open && (
        <Modal
          title={running ? `Updating to v${data.latest}` : `Update available — v${data.latest}`}
          onClose={() => setOpen(false)}
          widthClass="w-[560px]"
        >
          <div className="flex flex-col gap-4 px-5 py-5 text-sm leading-relaxed text-ink-200">
            <div>
              <p className="text-[13px] text-ink-400">
                You&rsquo;re on <span className="num">v{data.current ?? 'unknown'}</span>.
              </p>
              {data.highlights.length > 0 && (
                <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[13px] text-ink-300">
                  {data.highlights.map((h) => (
                    <li key={h}>{h}</li>
                  ))}
                </ul>
              )}
            </div>

            {running && startedAt !== null ? (
              <UpdateProgress
                startedAt={startedAt}
                text={log.data?.text ?? ''}
                offline={log.isError}
                logPath={runUpdate.data?.logPath ?? ''}
                onRetry={() => {
                  runUpdate.reset();
                  setStartedAt(null);
                }}
              />
            ) : (
              /* One decision, then one button. The dialog used to show a copy
                 button and an update button side by side and let the reader
                 work out which of the two was the update. */
              <div className="flex flex-col gap-3 rounded-lg border border-ink-700 bg-ink-950/60 p-3">
                <SegmentedToggle
                  fill
                  value={route}
                  ariaLabel="How to update"
                  onChange={setRoute}
                  options={[
                    { value: 'auto', label: 'Update for me' },
                    { value: 'manual', label: 'Run it in my terminal' },
                  ]}
                />
                {route === 'auto' ? (
                  <>
                    <p className="text-[12px] text-ink-400">
                      Installs v{data.latest} on this machine and restarts the app. It takes about a
                      minute. Your keys and trade history are not touched.
                    </p>
                    <button
                      type="button"
                      className="btn btn-primary self-start"
                      disabled={runUpdate.isPending}
                      onClick={() => {
                        setStartedAt(Date.now());
                        runUpdate.mutate();
                      }}
                    >
                      {runUpdate.isPending ? 'Starting…' : `Update to v${data.latest}`}
                    </button>
                  </>
                ) : (
                  <>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-[12px] text-ink-400">Paste this into a terminal.</p>
                      <SegmentedToggle
                        value={os}
                        ariaLabel="Operating system"
                        onChange={setOs}
                        options={(['macos', 'windows'] as Os[]).map((v) => ({
                          value: v,
                          label: OS_LABEL[v],
                        }))}
                      />
                    </div>
                    <CopyBlock text={INSTALL_BY_OS[os]} />
                  </>
                )}
              </div>
            )}

            {runUpdate.error != null && (
              <p
                role="alert"
                className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-300"
              >
                {runUpdate.error instanceof ApiError
                  ? runUpdate.error.message
                  : String(runUpdate.error)}
              </p>
            )}

            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <a href={changesUrl} target="_blank" rel="noreferrer" className={LINK_CLASS}>
                Read the code changes →
              </a>
              <a href={CHANGELOG_URL} target="_blank" rel="noreferrer" className={LINK_CLASS}>
                Full changelog on GitHub →
              </a>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
