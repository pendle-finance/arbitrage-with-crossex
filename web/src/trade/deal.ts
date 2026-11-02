/**
 * ActionInput[] → DealRequest mapping — THE contract in front of POST /api/deals.
 *
 * The tickets keep speaking ActionInput (the preview pipeline's language); this
 * maps the CONFIRMED intent (decorated finalized actions, zipped with their
 * previews for resolver-stamped qty/side/price) onto the engine's deal
 * shapes:
 *  - pair with a 'maker' role  → maker deal (A rests POC, B hedges)
 *  - two open-markets          → taker pair (A clips, B hedges)
 *  - one open-market / -limit  → single-leg deal (taker / resting maker)
 *  - close-position(s)         → reduce-only taker deal(s), banded clips
 * Returns null for shapes the engine does not model (confirm stays disabled).
 */
import type { ActionInput, DealRequest, PreviewResult } from '../api/types';
import { parseSymbol } from '../lib/fmt';

interface Zipped {
  action: ActionInput;
  preview: PreviewResult;
}

function zip(actions: ActionInput[], previews: PreviewResult[]): Zipped[] | null {
  if (actions.length !== previews.length) return null;
  return actions.map((action, i) => ({ action, preview: previews[i] }));
}

const isGate = (leg: Zipped): boolean => parseSymbol(leg.preview.symbol).exchange === 'GATE';

function levOf(action: ActionInput): number | undefined {
  return 'leverage' in action ? action.leverage : undefined;
}

export function dealFromActions(
  id: string,
  actions: ActionInput[],
  previews: PreviewResult[],
): DealRequest | null {
  const legs = zip(actions, previews);
  if (!legs || legs.length === 0 || legs.length > 2) return null;

  // --- maker+hedge pair: exactly one leg carries pairRole 'maker' ---
  const maker = legs.find((l) => 'pairRole' in l.action && l.action.pairRole === 'maker');
  const hedge = legs.find((l) => 'pairRole' in l.action && l.action.pairRole === 'hedge');
  if (maker || hedge) {
    if (!maker || !hedge || legs.length !== 2 || maker.action.kind !== 'open-limit') return null;
    if (!maker.preview.qty || !maker.preview.price) return null;
    return {
      id,
      a: { symbol: maker.preview.symbol, side: maker.preview.side },
      b: { symbol: hedge.preview.symbol, side: hedge.preview.side },
      qty: maker.preview.qty,
      execution: 'maker',
      price: maker.preview.price,
      pricePolicy: maker.action.pegToTouch ? 'touch' : 'fixed',
      timeoutSec: maker.action.makerTimeoutSec,
      leverage: { a: levOf(maker.action), b: levOf(hedge.action) },
    };
  }

  // --- close(s): reduce-only taker deal with the protection band ---
  if (legs.every((l) => l.action.kind === 'close-position')) {
    const [a, b] = legs;
    if (!a.preview.qty) return null;
    if (b && (!b.preview.qty || Number(b.preview.qty) !== Number(a.preview.qty))) return null;
    const band = a.action.kind === 'close-position' ? (a.action.slippagePct ?? 0.5) : 0.5;
    return {
      id,
      a: { symbol: a.preview.symbol, side: a.preview.side, reduceOnly: true },
      b: b ? { symbol: b.preview.symbol, side: b.preview.side, reduceOnly: true } : null,
      qty: a.preview.qty,
      execution: 'taker',
      clipBandPct: band,
    };
  }
  if (legs.some((l) => l.action.kind === 'close-position')) return null; // mixed open+close

  // --- both-market pair ---
  if (legs.length === 2) {
    // Leg A clips first and B only hedges A's fills. Gate refuses an order past
    // its position cap a few seconds after taking it, so a Gate leg goes first:
    // a refusal there leaves nothing to hedge.
    const [a, b] = isGate(legs[1]) && !isGate(legs[0]) ? [legs[1], legs[0]] : legs;
    if (a.action.kind !== 'open-market' || b.action.kind !== 'open-market') return null;
    if (!a.preview.qty || Number(a.preview.qty) !== Number(b.preview.qty)) return null;
    return {
      id,
      a: { symbol: a.preview.symbol, side: a.preview.side },
      b: { symbol: b.preview.symbol, side: b.preview.side },
      qty: a.preview.qty,
      execution: 'taker',
      leverage: { a: levOf(a.action), b: levOf(b.action) },
    };
  }

  // --- single open ---
  const [only] = legs;
  if (!only.preview.qty) return null;
  if (only.action.kind === 'open-market') {
    return {
      id,
      a: {
        symbol: only.preview.symbol,
        side: only.preview.side,
        ...(only.action.reduceOnly ? { reduceOnly: true } : {}),
      },
      qty: only.preview.qty,
      execution: 'taker',
      leverage: { a: levOf(only.action) },
    };
  }
  if (only.action.kind === 'open-limit') {
    if (!only.preview.price) return null;
    // maker legs are post-only BY DEFINITION (a crossing limit should be a
    // market order); a single maker deal rests with no deadline.
    return {
      id,
      a: {
        symbol: only.preview.symbol,
        side: only.preview.side,
        ...(only.action.reduceOnly ? { reduceOnly: true } : {}),
      },
      qty: only.preview.qty,
      execution: 'maker',
      price: only.preview.price,
      pricePolicy: 'fixed',
      leverage: { a: levOf(only.action) },
    };
  }
  return null;
}
