/** The "Share your position" dialog: previews the generated PNG (the preview
 * IS the shared bytes — one canvas, one toDataURL), the public link, and the
 * X intent. The payload was frozen when Share was clicked, so the 4s position
 * poll can't mutate an open modal. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { postJson } from '../api/client';
import { Modal } from '../components/Modal';
import { Spinner } from '../components/Spinner';
import { useToast } from '../components/Toast';
import { buildShareUrl, buildShortShareUrl, buildXIntentUrl, shareFileName } from '../lib/share';
import { renderShareCard } from '../lib/shareCard';
import { encodeSharePayload, type SharePayloadV1 } from '../lib/shareCodec';
import { useTrackedAddressOptional } from './trackedAddress';

/** `ClipboardItem` accepts a Blob PROMISE — and Safari in fact requires the
 * promise form (constructing after an await loses the user gesture). */
const canCopyImage = () =>
  typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard?.write === 'function';

/**
 * How long the link field waits for the short-code mint before falling back to
 * the long URL. Long enough for a local round-trip, short enough that a dead
 * backend costs no perceptible wait.
 */
const SHORT_LINK_GRACE_MS = 1_500;

export function SharePositionModal({ payload, onClose }: { payload: SharePayloadV1; onClose: () => void }) {
  const toast = useToast();
  // The tracked address rides ALONGSIDE the payload when the code is minted —
  // never inside it. The wire format has no address field by construction and
  // the link is posted in public; this travels raw in the POST body, is stored
  // next to the code, and is never echoed by the resolve endpoint. It exists so
  // a share code can be checked against what that wallet actually held.
  const trackedAddress = useTrackedAddressOptional()?.address ?? null;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  // The link never depends on the canvas — a rendering failure still shares.
  const longUrl = useMemo(() => {
    try {
      return buildShareUrl(payload);
    } catch {
      return null;
    }
  }, [payload]);

  /**
   * Upgrade to a short link in the background. The long URL remains the silent
   * fallback if the backend is slow, down, or throttled — sharing never waits
   * indefinitely on the network.
   *
   * ⚠ But it must not be shown and then REPLACED. Rendering the long URL
   * immediately made the field visibly flip to the short one a moment later,
   * which reads as a glitch and — worse — puts two different URLs in front of
   * someone who may already be dragging a selection across the first.
   *
   * So the field holds until the mint settles, for a short grace window only.
   * The mint is a local round-trip; if it has not answered within the window
   * it is not going to be quick, and the long URL takes over for good.
   */
  const [shortUrl, setShortUrl] = useState<string | null>(null);
  const [mintSettled, setMintSettled] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setShortUrl(null);
    setMintSettled(false);
    let d: string;
    try {
      d = encodeSharePayload(payload);
    } catch {
      // Nothing to mint from — the long URL is the only answer there is.
      setMintSettled(true);
      return;
    }
    // The window is the whole of the flicker guard: whatever happens, the user
    // has a link by the time it elapses.
    // Once this fires the long URL is committed: a late mint must NOT swap the
    // field out from under a selection the user is already making. That delayed
    // swap is the same flicker, just later.
    let graceElapsed = false;
    const timer = setTimeout(() => {
      graceElapsed = true;
      if (!cancelled) setMintSettled(true);
    }, SHORT_LINK_GRACE_MS);
    postJson<{ code: string }>('/share-link', trackedAddress ? { d, address: trackedAddress } : { d })
      .then((r) => {
        if (cancelled || graceElapsed) return;
        if (r?.code) setShortUrl(buildShortShareUrl(r.code));
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setMintSettled(true);
      });
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [payload, trackedAddress]);

  // Null while the mint is still in its grace window — the field renders its
  // placeholder rather than a URL that is about to change.
  const shareUrl = shortUrl ?? (mintSettled ? longUrl : null);

  useEffect(() => {
    let cancelled = false;
    renderShareCard(payload)
      .then((canvas) => {
        if (cancelled) return;
        canvasRef.current = canvas;
        setDataUrl(canvas.toDataURL('image/png'));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [payload]);

  const copyLink = () => {
    if (!shareUrl) return;
    if (!navigator.clipboard?.writeText) {
      toast.push('error', 'Clipboard unavailable — select the link text instead');
      return;
    }
    navigator.clipboard
      .writeText(shareUrl)
      .then(() => toast.push('success', 'Link copied'))
      .catch(() => toast.push('error', 'Clipboard unavailable — select the link text instead'));
  };

  const copyImage = () => {
    const canvas = canvasRef.current;
    if (!canvas || !canCopyImage()) return;
    const blob = new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png');
    });
    navigator.clipboard
      .write([new ClipboardItem({ 'image/png': blob })])
      .then(() => toast.push('success', 'Image copied — paste it into the X composer'))
      .catch(() => toast.push('error', 'Copying the image failed — use Download instead'));
  };

  return (
    <Modal title="Share your position" onClose={onClose} widthClass="w-[680px]">
      <div className="flex flex-col gap-3">
        {failed ? (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-xs text-amber-300">
            Image generation failed — the link below still works.
          </div>
        ) : dataUrl ? (
          <img
            src={dataUrl}
            alt="Position share card"
            className="w-full rounded-lg border border-ink-700"
          />
        ) : (
          <div className="flex aspect-video w-full items-center justify-center rounded-lg border border-ink-700 bg-ink-950/60 text-xs text-ink-400">
            <Spinner /> <span className="ml-2">Rendering the card…</span>
          </div>
        )}

        <p className="text-xs leading-relaxed text-ink-500">
          X can't attach an image from a link — the post opens pre-filled with your link; download
          or copy the image and add it in the compose window. Your wallet address is not part of
          the link or the image, and leg details are rounded to display precision. Pendle does store
          your address with the short code, so a shared position can be checked for incentive
          campaigns.
        </p>

        {shareUrl ? (
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={shareUrl}
              aria-label="Position share link"
              onFocus={(e) => e.currentTarget.select()}
              className="input flex-1 select-all font-mono text-[11px]"
            />
            <button type="button" className="btn shrink-0" onClick={copyLink}>
              Copy link
            </button>
          </div>
        ) : (
          // Held only for the grace window above — a placeholder the same
          // height as the field, so nothing jumps when the link lands.
          <div className="flex h-[34px] items-center rounded-lg border border-ink-800 bg-ink-950/60 px-2.5 text-[11px] text-ink-400">
            <Spinner /> <span className="ml-2">Minting a short link…</span>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {shareUrl && (
            <a
              href={buildXIntentUrl(payload, shareUrl)}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-primary"
            >
              Share on X →
            </a>
          )}
          {dataUrl && (
            <a href={dataUrl} download={shareFileName(payload)} className="btn">
              Download PNG
            </a>
          )}
          {dataUrl && canCopyImage() && (
            <button type="button" className="btn" onClick={copyImage}>
              Copy image
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
