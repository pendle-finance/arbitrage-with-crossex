import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/Toast';
import { fmtDateUtc } from '../lib/fmt';
import { buildShareUrl } from '../lib/share';
import { renderShareCard } from '../lib/shareCard';
import { decodeSharePayload } from '../lib/shareCodec';
import { makeSharePayload } from '../test/fixtures';
import { SharePositionModal } from './SharePositionModal';

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

afterEach(() => vi.unstubAllGlobals());

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

  it('shows a link that decodes back to the exact payload', () => {
    mount();
    const input = screen.getByLabelText('Position share link') as HTMLInputElement;
    expect(input.value).toBe(buildShareUrl(payload));
    expect(input.value.startsWith('https://crossexboros.com/position?d=')).toBe(true);
    const d = new URL(input.value).searchParams.get('d') ?? '';
    expect(decodeSharePayload(d)).toEqual({ ok: true, payload });
  });

  it('opens the X intent pre-filled with the tweet text and the link', () => {
    mount();
    const x = screen.getByRole('link', { name: 'Share on X →' });
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
    await userEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(writeText).toHaveBeenCalledWith(buildShareUrl(payload));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Link copied'));
  });

  it('explains the manual image attach and the address privacy', () => {
    mount();
    expect(screen.getByText(/X can't attach an image from a link/)).toBeInTheDocument();
    expect(screen.getByText(/wallet address is not part of the link/)).toBeInTheDocument();
  });

  it('degrades to link-only when the card render fails — the share still works', async () => {
    vi.mocked(renderShareCard).mockRejectedValueOnce(new Error('no canvas'));
    mount();
    expect(await screen.findByText(/Image generation failed — the link below still works/)).toBeInTheDocument();
    expect(screen.getByLabelText('Position share link')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Share on X →' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Download PNG' })).not.toBeInTheDocument();
    expect(screen.queryByAltText('Position share card')).not.toBeInTheDocument();
  });
});
