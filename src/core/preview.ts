/**
 * Preview service: resolveActions (no side effects) enriched with fill-price and
 * fee estimates. Estimates are advisory and never block — violations do that.
 */
import { resolveActions, type ActionInput, type PreviewResult } from './actions';
import type { Clients } from './clients';
import {
  fetchVenueBook as realFetchVenueBook,
  touchOf,
  type fetchVenueBook,
  type NormalizedBook,
} from './estimate/books';
import { estimateFill } from './estimate/fill';
import { estimateFees, resolveFeeRates, type VenueFeeRow } from './estimate/fees';
import { pickMakerLeg, type MakerLegPick } from './estimate/makerLeg';
import { DEFAULT_STEP, parseSymbol } from './numbers';
import { marketableClosePrice } from './orders';
import { impactOf, pairTwapDefaultOf, type TwapDefault } from './rebalance/slices';
import { planSlices, type TwapInput, type TwapLegRule, type TwapPlan, type TwapRefusal } from './twap';

interface PreviewDeps {
  clients: Clients;
  /** The account's /crossex/fee rows (server caches them). */
  feeRows: VenueFeeRow[];
  /** Injectable for tests. */
  fetchBook?: typeof fetchVenueBook;
}

const TOUCH_KEEP_MS = 10_000;
const lastTouch = new Map<string, { touch: NonNullable<ReturnType<typeof touchOf>>; at: number }>();

export async function previewActions(deps: PreviewDeps, actions: ActionInput[], sliced = false): Promise<PreviewResult[]> {
  const resolved = await resolveActions(deps.clients, actions, { mode: 'preview', sliced });
  return Promise.all(
    resolved.map(async (r): Promise<PreviewResult> => {
      const preview: PreviewResult = { ...r, warnings: [...r.warnings] };

      // Tentative avg fill price for anything that crosses the book NOW:
      // market opens and marketable-limit (IOC) closes.
      const crossesNow = r.type === 'MARKET' || (r.type === 'LIMIT' && r.tif === 'IOC');
      if (crossesNow && r.qty && r.violations.length === 0) {
        const refPrice = r.refPrice?.value ?? r.closing?.mark;
        const est = await estimateFill(
          { clients: deps.clients, fetchBook: deps.fetchBook },
          { symbol: r.symbol, side: r.side, qty: r.qty, refPrice },
        ).catch(() => null);
        if (est) {
          preview.fillEstimate = est;
          /**
           * A reduce-only close is re-priced by the ENGINE at send time off the
           * venue book's mid (venueGate.refPrice), not off CrossEx's mark. The
           * resolver only had the mark; now that the book has been walked,
           * quote the band off the same mid the order will actually carry, so
           * the "limit px" the dialog prints is the one that goes out.
           */
          const close = r.reduceOnly && r.type === 'LIMIT' && r.tif === 'IOC' && r.closing;
          const slippage = r.input.kind === 'close-position' ? r.input.slippagePct : undefined;
          const mid = est.midPrice;
          if (close && slippage !== undefined && mid !== undefined && mid > 0) {
            preview.price = marketableClosePrice(mid, r.side, slippage, r.symbol, r.rule?.tickSize ?? DEFAULT_STEP);
          }
        } else preview.warnings.push('No fill estimate (no book, no reference price)');
      }

      // A POC leg doesn't cross — surface the venue's touch instead, so the
      // ticket can default/refresh the maker price to the top of the book.
      if (r.type === 'LIMIT' && r.tif === 'POC') {
        const { exchange, base, quote } = parseSymbol(r.symbol);
        const book = await (deps.fetchBook ?? realFetchVenueBook)(exchange, base, quote).catch(() => null);
        const fresh = touchOf(book);
        if (fresh) lastTouch.set(r.symbol, { touch: fresh, at: Date.now() });
        const kept = lastTouch.get(r.symbol);
        const touch = fresh ?? (kept && Date.now() - kept.at <= TOUCH_KEEP_MS ? kept.touch : null);
        if (touch) preview.restEstimate = touch;
        else preview.warnings.push("No order book, so the maker price can't follow the market");
      }

      const rates = resolveFeeRates(deps.feeRows, r.symbol);
      if (!rates) {
        preview.warnings.push(`No fee rates for ${r.symbol}, so the fee is not estimated`);
      } else if (r.qty) {
        const price =
          preview.fillEstimate?.avgPrice ??
          (r.price ? Number(r.price) : (r.refPrice?.value ?? r.closing?.mark ?? 0));
        if (price > 0) {
          preview.fees = estimateFees(rates, { type: r.type, tif: r.tif, qty: r.qty, price });
        }
      }
      return preview;
    }),
  );
}

export const TWAP_DEFAULT_INPUT: TwapInput = { durationSec: 3_600, slices: 12 };

export interface MakerLegPreview {
  auto: MakerLegPick['leg'];
  why: MakerLegPick['why'];
}

export interface PriceImpactPreview {
  whole: number | null;
  sliced: number;
  twapDefault: TwapDefault;
}

export interface TwapPlanPreview {
  plan: TwapPlan | null;
  refusal: TwapRefusal | null;
}

export interface TwapPreview {
  makerLeg: MakerLegPreview | null;
  priceImpact: PriceImpactPreview | null;
  twap: TwapPlanPreview | null;
}

interface TwapPreviewDeps {
  feeRows: VenueFeeRow[];
  book: (symbol: string) => Promise<NormalizedBook | null>;
}

export interface TwapLegBook {
  symbol: string;
  side: 'BUY' | 'SELL';
  book: NormalizedBook | null;
  mid: number | null;
}

type SizedLegBook = TwapLegBook & { qty: number };

export type TwapRuleRow = Partial<Record<'lotSize' | 'minSize' | 'minNotional' | 'maxMarketSize' | 'maxLimitSize', string>>;

const DECIMAL = /^\d*\.?\d+(?:[eE][+-]?\d+)?$/;

function decimalOf(raw: string | undefined): string | null {
  const text = raw?.trim();
  return text !== undefined && DECIMAL.test(text) ? text : null;
}

export function twapRuleOf(row: TwapRuleRow, symbol: string): TwapLegRule {
  const { exchange, base } = parseSymbol(symbol);
  return {
    venue: exchange,
    coin: base,
    lot: decimalOf(row.lotSize) ?? '0',
    minSize: decimalOf(row.minSize) ?? '0',
    minNotional: decimalOf(row.minNotional) ?? '0',
    maxMarketSize: decimalOf(row.maxMarketSize),
    maxLimitSize: decimalOf(row.maxLimitSize),
  };
}

function impactAt(leg: TwapLegBook, qty: number): ReturnType<typeof impactOf> {
  return leg.book && leg.mid ? impactOf(leg.book, leg.side, leg.mid, qty) : null;
}

export function depthOf(leg: TwapLegBook): number | null {
  if (!leg.book) return null;
  const levels = leg.side === 'BUY' ? leg.book.asks : leg.book.bids;
  return levels.reduce((total, [, size]) => (size > 0 ? total + size : total), 0);
}

export function makerLegOf(feeRows: VenueFeeRow[], a: SizedLegBook, b: SizedLegBook): MakerLegPreview {
  const impactA = impactAt(a, a.qty);
  const impactB = impactAt(b, b.qty);
  const inputOf = (leg: SizedLegBook, impact: ReturnType<typeof impactAt>) => {
    const rates = resolveFeeRates(feeRows, leg.symbol);
    return {
      makerRate: rates?.makerRate ?? null,
      takerRate: rates?.takerRate ?? null,
      slippagePct: impact ? impact.bp / 100 : null,
      pastBookDepth: impact?.pastBook ? (depthOf(leg) ?? 0) : null,
    };
  };
  const pick = pickMakerLeg(inputOf(a, impactA), inputOf(b, impactB));
  return { auto: pick.leg, why: pick.why };
}

function twapPlanOf(previews: PreviewResult[], legs: TwapLegBook[], qty: string, input: TwapInput): TwapPlanPreview | null {
  const rules = previews.flatMap((preview) => (preview.rule ? [twapRuleOf(preview.rule, preview.symbol)] : []));
  if (rules.length !== previews.length) return null;
  const first = previews[0];
  const mark = first.refPrice?.value ?? first.closing?.mark ?? legs[0].mid ?? 0;
  if (!(mark > 0)) return null;
  const depths = legs.map(depthOf).filter((depth): depth is number => depth !== null);
  const bookMaxQty = depths.length ? String(Math.min(...depths)) : null;
  const result = planSlices(qty, input, rules, mark, bookMaxQty);
  return result.ok ? { plan: result.plan, refusal: null } : { plan: result.plan, refusal: result.refusal };
}

export function priceImpactOf(legs: TwapLegBook[], qty: number, plan: TwapPlan): PriceImpactPreview | null {
  if (legs.some((leg) => !leg.book || !leg.mid)) return null;
  const wholes = legs.map((leg) => impactAt(leg, qty));
  const whole = wholes.every((impact) => impact && !impact.pastBook)
    ? wholes.reduce((total, impact) => total + (impact?.usd ?? 0), 0)
    : null;
  const sliceQty = Number(plan.sliceQty);
  const lastQty = Number(plan.lastQty);
  const sliced = legs.reduce(
    (total, leg) =>
      total + (impactAt(leg, sliceQty)?.usd ?? 0) * (plan.slices - 1) + (impactAt(leg, lastQty)?.usd ?? 0),
    0,
  );
  return { whole, sliced, twapDefault: pairTwapDefaultOf(legs.map((leg) => ({ book: leg.book, side: leg.side, mid: leg.mid, qty }))) };
}

export async function previewTwap(
  deps: TwapPreviewDeps,
  previews: PreviewResult[],
  input: TwapInput,
): Promise<TwapPreview> {
  const none: TwapPreview = { makerLeg: null, priceImpact: null, twap: null };
  if (previews.length === 0 || previews.length > 2) return none;
  const coins = new Set(previews.map((preview) => parseSymbol(preview.symbol).base));
  const isPair = previews.length === 2;
  if (coins.size > 1 || (isPair && previews[0].side === previews[1].side)) return none;
  const legs = await Promise.all(
    previews.map(async ({ symbol, side }): Promise<TwapLegBook> => {
      const book = await deps.book(symbol).catch(() => null);
      return { symbol, side, book, mid: touchOf(book)?.mid ?? null };
    }),
  );
  const qty = previews[0].qty;
  const sameQty = previews.every((preview) => Number(preview.qty) === Number(qty));
  const underLot = !(Number(qty) > 0) && previews.every(({ input: typed }) => Number(typed.qty ?? ('notional' in typed ? typed.notional : undefined)) > 0);
  const twap = sameQty && (Number(qty) > 0 || underLot) ? twapPlanOf(previews, legs, underLot ? '0' : qty, input) : null;
  const priceImpact = twap?.plan ? priceImpactOf(legs, Number(qty), twap.plan) : null;
  const makerLeg = isPair
    ? makerLegOf(deps.feeRows, { ...legs[0], qty: Number(previews[0].qty) }, { ...legs[1], qty: Number(previews[1].qty) })
    : null;
  return { makerLeg, priceImpact, twap };
}
