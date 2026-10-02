import { describe, expect, it, vi } from 'vitest';
import type { Clients } from '../../src/core/clients';
import { fetchVenueBook } from '../../src/core/estimate/books';
import { gateVenue } from '../../src/engine/venueGate';

vi.mock('../../src/core/estimate/books', () => ({ fetchVenueBook: vi.fn() }));

const book = (bid: string, ask: string) =>
  ({ bids: [[bid, '1']], asks: [[ask, '1']] }) as unknown as Awaited<ReturnType<typeof fetchVenueBook>>;

describe('gateVenue.touch', () => {
  // The touch price rests post-only, so it snaps AWAY from crossing. One gap
  // behind the touch: BUY 2·100.017 − 100.018 = 100.016 → 100.01 (nearest
  // 100.02); SELL 2·100.011 − 100.010 = 100.012 → 100.02 (nearest 100.01).
  it('snaps the behind-touch price directionally, not to the nearest tick', async () => {
    vi.mocked(fetchVenueBook).mockResolvedValueOnce(book('100.017', '100.018'));
    vi.mocked(fetchVenueBook).mockResolvedValueOnce(book('100.010', '100.011'));
    const venue = gateVenue(() => ({}) as Clients);

    expect(await venue.touch('BINANCE_FUTURE_ETH_USDT', 'BUY', '0.01')).toBe('100.01');
    expect(await venue.touch('BINANCE_FUTURE_ETH_USDT', 'SELL', '0.01')).toBe('100.02');
  });
});
