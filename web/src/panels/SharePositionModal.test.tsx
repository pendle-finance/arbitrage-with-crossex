import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/Toast';
import { fmtDateUtc } from '../lib/fmt';
import { buildShareUrl, buildShortShareUrl } from '../lib/share';
import { renderShareCard } from '../lib/shareCard';
import { decodeSharePayload, encodeSharePayload } from '../lib/shareCodec';
import { writeJson } from '../lib/storage';
import { makeSharePayload } from '../test/fixtures';
import { env, server } from '../test/server';
import { loadStored, STRATEGY_STORAGE_KEY } from './HomeControls';
import { SharePositionModal } from './SharePositionModal';
import { TrackedAddressProvider } from './trackedAddress';

const TRACKED = '0xAbC0000000000000000000000000000000000123';

// jsdom has no 2D canvas — stub the renderer with a canvas-shaped object.
vi.mock('../lib/shareCard', () => ({
  renderShareCard: vi.fn(async () => ({
    toDataURL: () => 'data:image/png;base64,stub',
    toBlob: (cb: (b: Blob | null) => void) => cb(new Blob(['x'], { type: 'image/png' })),
  })),
}));

const payload = makeSharePayload();

const mount = () =>
  render(
    <ToastProvider>
      <SharePositionModal payload={payload} onClose={() => {}} />
    </ToastProvider>,
  );

/** Same modal, but inside the provider and with an address already tracked —
 * the only difference the mint call should see. */
const mountTracked = () => {
  writeJson(STRATEGY_STORAGE_KEY, { ...loadStored(), address: TRACKED });
  return render(
    <ToastProvider>
      <TrackedAddressProvider>
        <SharePositionModal payload={payload} onClose={() => {}} />
      </TrackedAddressProvider>
    </ToastProvider>,
  );
};

afterEach(() => vi.unstubAllGlobals());

// The modal requests a short link on mount; default it to a failure so every
// existing assertion sees the deterministic long-URL fallback. Tests of the
// short link itself override with a success handler.
const shareLinkFails = http.post('*/api/share-link', () =>
  HttpResponse.json(
    { ok: false, error: { category: 'network', message: 'down', retryable: true } },
    { status: 502 },
  ),
);
const shareLinkMints = (code: string) =>
  http.post('*/api/share-link', () => HttpResponse.json(env({ code, expiresAt: 0 })));

beforeEach(() => server.use(shareLinkFails));

describe('SharePositionModal', () => {
  it('previews the generated PNG and offers the actions', async () => {
    mount();
    expect(await screen.findByAltText('Position share card')).toHaveAttribute(
      'src',
      'data:image/png;base64,stub',
    );
    const download = screen.getByRole('link', { name: 'Download PNG' });
    expect(download).toHaveAttribute('download', `crossex-boros-hype-${fmtDateUtc(payload.m)}.png`);
    // jsdom defines neither ClipboardItem nor clipboard.write → no Copy image.
    expect(screen.queryByRole('button', { name: 'Copy image' })).not.toBeInTheDocument();
  });

  it('shows a link that decodes back to the exact payload', async () => {
    mount();
    const input = (await screen.findByLabelText('Position share link')) as HTMLInputElement;
    expect(input.value).toBe(buildShareUrl(payload));
    expect(input.value.startsWith('https://boros.pendle.finance/arbitrage-crossex/position?d=')).toBe(true);
    const d = new URL(input.value).searchParams.get('d') ?? '';
    expect(decodeSharePayload(d)).toEqual({ ok: true, payload });
  });

  it('opens the X intent pre-filled with the tweet text and the link', async () => {
    mount();
    const x = await screen.findByRole('link', { name: 'Share on X →' });
    const href = x.getAttribute('href') ?? '';
    expect(href.startsWith('https://x.com/intent/post?text=')).toBe(true);
    const u = new URL(href);
    expect(u.searchParams.get('text')).toContain("I'm getting 17.81% fixed APR on $41,320 capital");
    expect(u.searchParams.get('url')).toBe(buildShareUrl(payload));
    expect(x).toHaveAttribute('target', '_blank');
    expect(x.getAttribute('rel')).toContain('noopener');
  });

  it('copies the link and confirms with a toast', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Copy link' }));
    expect(writeText).toHaveBeenCalledWith(buildShareUrl(payload));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Link copied'));
  });

  it('explains the manual image attach and the address privacy', () => {
    mount();
    expect(screen.getByText(/X can't attach an image from a link/)).toBeInTheDocument();
    expect(screen.getByText(/wallet address is not part of the link/)).toBeInTheDocument();
    // The address is not in the link, but it IS recorded — say both.
    expect(screen.getByText(/does store\s+your address with the short code/)).toBeInTheDocument();
  });

  it('sends the tracked address raw alongside the payload — never inside it', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    server.use(
      http.post('*/api/share-link', async ({ request }) => {
        bodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json(env({ code: 'Abc123_-xyz', expiresAt: 0 }));
      }),
    );
    mountTracked();
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0].address).toBe(TRACKED);
    // The payload is byte-identical to the address-less one, so the public
    // link never carries the wallet.
    expect(bodies[0].d).toBe(encodeSharePayload(payload));
    const input = (await screen.findByLabelText('Position share link')) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe(buildShortShareUrl('Abc123_-xyz')));
    expect(input.value).not.toContain(TRACKED.toLowerCase());
    expect(input.value).not.toContain(TRACKED);
  });

  it('omits the address entirely when none is tracked', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    server.use(
      http.post('*/api/share-link', async ({ request }) => {
        bodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json(env({ code: 'Abc123_-xyz', expiresAt: 0 }));
      }),
    );
    mount(); // no provider at all — the modal must still mint
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(Object.keys(bodies[0])).toEqual(['d']);
  });

  it('shows the SHORT url first time — never the long one, then a swap', async () => {
    /**
     * The field used to render the long URL immediately and visibly flip to
     * the short one a moment later. That reads as a glitch, and it puts a
     * second URL under a selection the user may already be dragging. The field
     * now holds for a short grace window, so the first link they see is final.
     */
    server.use(shareLinkMints('Abc123_-xyz'));
    mount();
    const input = (await screen.findByLabelText('Position share link')) as HTMLInputElement;
    expect(input.value).toBe('https://boros.pendle.finance/arbitrage-crossex/position?s=Abc123_-xyz');
    // It was never the long URL on the way there.
    expect(input.value).not.toBe(buildShareUrl(payload));
    const href = screen.getByRole('link', { name: 'Share on X →' }).getAttribute('href') ?? '';
    expect(new URL(href).searchParams.get('url')).toBe(buildShortShareUrl('Abc123_-xyz'));
  });

  it('keeps the long URL when the short-link mint fails — sharing never blocks on the backend', async () => {
    mount(); // beforeEach handler: /api/share-link 502s
    const input = (await screen.findByLabelText('Position share link')) as HTMLInputElement;
    expect(input.value).toBe(buildShareUrl(payload));
    // Give the rejected request time to settle; the value must not change.
    await waitFor(() => expect(input.value).toBe(buildShareUrl(payload)));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument(); // and no error toast — silent fallback
  });

  it('degrades to link-only when the card render fails — the share still works', async () => {
    vi.mocked(renderShareCard).mockRejectedValueOnce(new Error('no canvas'));
    mount();
    expect(await screen.findByText(/Image generation failed — the link below still works/)).toBeInTheDocument();
    expect(await screen.findByLabelText('Position share link')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Share on X →' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Download PNG' })).not.toBeInTheDocument();
    expect(screen.queryByAltText('Position share card')).not.toBeInTheDocument();
  });
});
