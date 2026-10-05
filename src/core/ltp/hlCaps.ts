/** Hyperliquid's per-asset max leverage, from its public meta endpoint.
 *
 * The HL legs of an LTP pair run over a DMA rail: LTP passes Hyperliquid's own
 * limits through and exposes no leverage-cap feed of its own (HL is absent
 * from `sym/info` entirely), so HL's published `maxLeverage` is the binding
 * verifiable cap for those legs. No other venue in the engine has a public
 * cap feed wired — their legs keep the requested leverage.
 *
 * Same transport and timeout as the venue-book fetcher (core/estimate/books.ts)
 * against the same endpoint — a blackholed HL API must not stall the scan.
 */
import axios from 'axios';

const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';
const TIMEOUT_MS = 2_500;

/** BASE (upper-case) → max leverage. Throws on HTTP/shape failure so the
 * caller can degrade with a warning instead of silently not clamping. */
export async function fetchHyperliquidMaxLeverage(): Promise<Map<string, number>> {
  const { data } = await axios.post(HL_INFO_URL, { type: 'meta' }, { timeout: TIMEOUT_MS });
  const universe = (data as { universe?: Array<{ name?: string; maxLeverage?: number }> } | null)
    ?.universe;
  const caps = new Map<string, number>();
  for (const asset of universe ?? []) {
    const lev = Number(asset?.maxLeverage);
    if (asset?.name && Number.isFinite(lev) && lev > 0) {
      caps.set(String(asset.name).toUpperCase(), lev);
    }
  }
  if (caps.size === 0) throw new Error('hyperliquid meta: empty universe');
  return caps;
}
