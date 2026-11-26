import { prettyVenue } from '../../web/src/lib/fmt';
import { type Fx, FX_DECIMALS, fx, fxMax, fxMin, fxStr } from '../engine/fx';
import { DEFAULT_STEP } from './numbers';

export const TWAP_LIMITS = {
  minDurationSec: 300,
  maxDurationSec: 86_400,
  minIntervalSec: 60,
  minSlices: 2,
  maxSlices: 100,
  takerAfterRatio: 0.8,
} as const;

export interface TwapInput {
  durationSec?: number;
  intervalSec?: number;
  sliceQty?: string;
  slices?: number;
}

export interface TwapLegRule {
  venue: string;
  coin: string;
  lot: string;
  minSize: string;
  minNotional: string;
  maxMarketSize: string | null;
  maxLimitSize: string | null;
}

export interface TwapPlan {
  slices: number;
  sliceQty: string;
  lastQty: string;
  intervalSec: number;
  durationSec: number;
  takerAfterSec: number;
}

export interface TwapRefusal {
  field: 'duration' | 'interval' | 'sliceSize';
  text: string;
  fix: { label: string; patch: TwapInput } | null;
}

export type TwapPlanResult = { ok: true; plan: TwapPlan } | { ok: false; plan: TwapPlan | null; refusal: TwapRefusal };

type Mode = 'duration-slices' | 'duration-interval' | 'duration-size' | 'interval-size' | 'interval-slices';

type RefusalKind =
  | 'too-small'
  | 'duration-low'
  | 'duration-high'
  | 'count-low'
  | 'count-high'
  | 'interval-low'
  | 'leg-min'
  | 'leg-max'
  | 'book';

interface LegLimit {
  venue: string;
  minQty: Fx;
  minLots: bigint;
  maxLots: bigint | null;
}

interface Context {
  coin: string;
  lot: Fx;
  totalLots: bigint;
  mark: number;
  minLeg: LegLimit;
  maxLeg: LegLimit | null;
  bookLots: bigint | null;
}

interface Shape {
  mode: Mode;
  slices: number;
  intervalSec: number;
  durationSec: number;
  baseLots: bigint;
  lastLots: bigint;
}

interface Verdict {
  kind: RefusalKind;
  field: TwapRefusal['field'];
  text: string;
  boundLots: bigint | null;
}

const ONE = fx('1');

export function takerAfterCapSec(intervalSec: number): number {
  return Math.floor(intervalSec * TWAP_LIMITS.takerAfterRatio);
}

function fxOf(raw: string): Fx {
  const parts = /^\s*(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d{1,3}))?\s*$/.exec(raw);
  const digits = parts ? `${parts[1]}${parts[2] ?? ''}` : '';
  if (!parts || digits === '') throw new Error(`twap: not a decimal: "${raw}"`);
  const point = parts[1].length + Number(parts[3] ?? '0');
  if (point <= -FX_DECIMALS) return 0n;
  const padded = point < 0 ? `${'0'.repeat(-point)}${digits}` : digits.padEnd(point, '0');
  const at = Math.max(point, 0);
  const whole = padded.slice(0, at) || '0';
  const fraction = padded.slice(at, at + FX_DECIMALS);
  return fx(fraction ? `${whole}.${fraction}` : whole);
}

function secOf(value: number | undefined, name: string): number {
  if (value === undefined || !Number.isFinite(value)) throw new Error(`twap: ${name} must be a number`);
  return Math.floor(value);
}

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));

function spanText(sec: number): string {
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const seconds = sec % 60;
  const parts = [hours ? `${hours}h` : '', minutes ? `${minutes}m` : '', seconds ? `${seconds}s` : ''];
  return parts.filter(Boolean).join(' ') || '0s';
}

function qtyText(qty: Fx): string {
  const [whole, fraction] = fxStr(qty).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction ? `${grouped}.${fraction}` : grouped;
}

export function usdText(usd: number): string {
  return `$${usd.toLocaleString('en-US', { maximumFractionDigits: usd < 10 ? 2 : 0 })}`;
}

function contextOf(totalQty: string, rules: TwapLegRule[], mark: number, bookMaxQty: string | null | undefined): Context {
  if (rules.length === 0) throw new Error('twap: no legs');
  const markFx = Number.isFinite(mark) && mark > 0 ? fxOf(String(mark)) : 0n;
  if (markFx <= 0n) throw new Error(`twap: mark must be a positive number, got ${mark}`);
  const lots = rules.map((rule) => fxOf(rule.lot)).filter((lot) => lot > 0n);
  const lot = lots.length ? lots.reduce((a, b) => (a / gcd(a, b)) * b) : fx(DEFAULT_STEP);
  const legs = rules.map((rule): LegLimit => {
    const minQty = fxMax(fxOf(rule.minSize), ceilDiv(fxOf(rule.minNotional) * ONE, markFx));
    const caps = [rule.maxMarketSize, rule.maxLimitSize]
      .filter((cap): cap is string => cap !== null)
      .map(fxOf)
      .filter((cap) => cap > 0n);
    return {
      venue: prettyVenue(rule.venue),
      minQty,
      minLots: fxMax(1n, ceilDiv(minQty, lot)),
      maxLots: caps.length ? caps.reduce(fxMin) / lot : null,
    };
  });
  const minLeg = legs.reduce((a, b) => (b.minLots > a.minLots || (b.minLots === a.minLots && b.minQty > a.minQty) ? b : a));
  const capped = legs.filter((leg) => leg.maxLots !== null);
  const maxLeg = capped.length ? capped.reduce((a, b) => ((b.maxLots ?? 0n) < (a.maxLots ?? 0n) ? b : a)) : null;
  return {
    coin: rules[0].coin,
    lot,
    totalLots: fxOf(totalQty) / lot,
    mark,
    minLeg,
    maxLeg,
    bookLots: bookMaxQty === null || bookMaxQty === undefined ? null : fxOf(bookMaxQty) / lot,
  };
}

function modeOf(input: TwapInput): Mode {
  const has = (value: unknown): boolean => value !== undefined && value !== null;
  if (has(input.durationSec) && has(input.slices)) return 'duration-slices';
  if (has(input.durationSec) && has(input.intervalSec)) return 'duration-interval';
  if (has(input.durationSec) && has(input.sliceQty)) return 'duration-size';
  if (has(input.intervalSec) && has(input.sliceQty)) return 'interval-size';
  if (has(input.intervalSec) && has(input.slices)) return 'interval-slices';
  throw new Error('twap: give two of duration, interval and slice size');
}

const isSizeMode = (mode: Mode): boolean => mode === 'duration-size' || mode === 'interval-size';

const hasDuration = (mode: Mode): boolean => mode.startsWith('duration-');

function countShape(ctx: Context, input: TwapInput, mode: Mode): Shape {
  const typedInterval = mode === 'duration-slices' ? 0 : secOf(input.intervalSec, 'interval');
  const typedDuration = hasDuration(mode) ? secOf(input.durationSec, 'duration') : 0;
  const counted =
    mode === 'duration-interval'
      ? typedInterval > 0
        ? Math.floor(typedDuration / typedInterval)
        : 0
      : secOf(input.slices, 'slices');
  const slices = Math.max(0, counted);
  const baseLots = slices > 0 ? ctx.totalLots / BigInt(slices) : 0n;
  const lastLots = slices > 0 ? ctx.totalLots - baseLots * BigInt(slices - 1) : 0n;
  if (mode === 'interval-slices') {
    return { mode, slices, intervalSec: typedInterval, durationSec: slices * typedInterval, baseLots, lastLots };
  }
  const intervalSec = mode === 'duration-interval' ? typedInterval : slices > 0 ? Math.floor(typedDuration / slices) : typedDuration;
  return { mode, slices, intervalSec, durationSec: typedDuration, baseLots, lastLots };
}

function sizeShape(ctx: Context, input: TwapInput, mode: Mode): Shape {
  const asked = fxOf(input.sliceQty ?? '') / ctx.lot;
  const total = ctx.totalLots;
  const sizeLots = asked < 1n ? 1n : asked > total ? total : asked;
  const full = sizeLots > 0n ? total / sizeLots : 0n;
  const rest = sizeLots > 0n ? total % sizeLots : 0n;
  const merged = rest > 0n && rest < ctx.minLeg.minLots && full > 0n;
  const slices = Number(full) + (rest > 0n && !merged ? 1 : 0);
  const lastLots = rest === 0n ? sizeLots : merged ? sizeLots + rest : rest;
  if (mode === 'interval-size') {
    const intervalSec = secOf(input.intervalSec, 'interval');
    return { mode, slices, intervalSec, durationSec: slices * intervalSec, baseLots: sizeLots, lastLots };
  }
  const durationSec = secOf(input.durationSec, 'duration');
  const intervalSec = slices > 0 ? Math.floor(durationSec / slices) : durationSec;
  return { mode, slices, intervalSec, durationSec, baseLots: sizeLots, lastLots };
}

function shapeOf(ctx: Context, input: TwapInput): Shape {
  const mode = modeOf(input);
  return isSizeMode(mode) ? sizeShape(ctx, input, mode) : countShape(ctx, input, mode);
}

function minText(ctx: Context): string {
  const qty = ctx.minLeg.minLots * ctx.lot;
  const usd = Number(fxStr(qty)) * ctx.mark;
  return `${ctx.minLeg.venue} takes at least ${qtyText(qty)} ${ctx.coin} (${usdText(usd)}) a slice.`;
}

function verdictOf(ctx: Context, shape: Shape): Verdict | null {
  const { coin, lot, totalLots, minLeg, maxLeg, bookLots } = ctx;
  const countField = isSizeMode(shape.mode) ? 'sliceSize' : 'interval';
  const smallest = shape.baseLots < shape.lastLots ? shape.baseLots : shape.lastLots;
  const largest = shape.baseLots > shape.lastLots ? shape.baseLots : shape.lastLots;
  if (totalLots < minLeg.minLots * BigInt(TWAP_LIMITS.minSlices)) {
    return { kind: 'too-small', field: 'sliceSize', text: `Too small for 2 slices: ${minText(ctx)}`, boundLots: null };
  }
  if (shape.durationSec < TWAP_LIMITS.minDurationSec) {
    return { kind: 'duration-low', field: 'duration', text: `Duration at least ${spanText(TWAP_LIMITS.minDurationSec)}.`, boundLots: null };
  }
  if (shape.durationSec > TWAP_LIMITS.maxDurationSec) {
    return { kind: 'duration-high', field: 'duration', text: `Duration at most ${spanText(TWAP_LIMITS.maxDurationSec)}.`, boundLots: null };
  }
  if (shape.slices < TWAP_LIMITS.minSlices) {
    const half = totalLots / BigInt(TWAP_LIMITS.minSlices);
    const text = isSizeMode(shape.mode)
      ? `${shape.slices} ${shape.slices === 1 ? 'slice' : 'slices'}. Min 2: slice size at most ${qtyText(half * lot)} ${coin}.`
      : `Interval at most ${spanText(Math.floor(shape.durationSec / TWAP_LIMITS.minSlices))}.`;
    return { kind: 'count-low', field: countField, text, boundLots: half };
  }
  if (shape.slices > TWAP_LIMITS.maxSlices) {
    const least = ceilDiv(totalLots, BigInt(TWAP_LIMITS.maxSlices));
    const text = `${shape.slices.toLocaleString('en-US')} slices. Max ${TWAP_LIMITS.maxSlices}: slice size at least ${qtyText(least * lot)} ${coin}.`;
    return { kind: 'count-high', field: countField, text, boundLots: least };
  }
  if (shape.intervalSec < TWAP_LIMITS.minIntervalSec) {
    return { kind: 'interval-low', field: 'interval', text: `Interval at least ${spanText(TWAP_LIMITS.minIntervalSec)}.`, boundLots: null };
  }
  if (smallest < minLeg.minLots) {
    return { kind: 'leg-min', field: 'sliceSize', text: minText(ctx), boundLots: minLeg.minLots };
  }
  if (maxLeg?.maxLots != null && largest > maxLeg.maxLots) {
    const text = `${maxLeg.venue} takes at most ${qtyText(maxLeg.maxLots * lot)} ${coin} a slice.`;
    return { kind: 'leg-max', field: 'sliceSize', text, boundLots: maxLeg.maxLots };
  }
  if (bookLots !== null && largest > bookLots) {
    return { kind: 'book', field: 'sliceSize', text: `Book too thin for ${qtyText(largest * lot)} ${coin} a slice.`, boundLots: bookLots };
  }
  return null;
}

function countsNear(current: number): number[] {
  const counts = Array.from({ length: TWAP_LIMITS.maxSlices - TWAP_LIMITS.minSlices + 1 }, (_, i) => i + TWAP_LIMITS.minSlices);
  return counts.sort((a, b) => Math.abs(a - current) - Math.abs(b - current) || a - b);
}

function intervalPatches(durationSec: number, current: number): TwapInput[] {
  return countsNear(current).map((count) => ({ durationSec, intervalSec: Math.floor(durationSec / count) }));
}

function sizePatches(ctx: Context, shape: Shape, boundLots: bigint | null): TwapInput[] {
  const other: TwapInput = shape.mode === 'duration-size' ? { durationSec: shape.durationSec } : { intervalSec: shape.intervalSec };
  const bound = boundLots !== null && boundLots > 0n ? [boundLots] : [];
  const near = countsNear(shape.slices).map((count) => ceilDiv(ctx.totalLots, BigInt(count)));
  return [...bound, ...near].map((lots) => ({ ...other, sliceQty: fxStr(lots * ctx.lot) }));
}

function keepWithDuration(input: TwapInput, durationSec: number): TwapInput[] {
  const kept: TwapInput[] = [];
  if (input.slices !== undefined) kept.push({ durationSec, slices: input.slices });
  if (input.intervalSec !== undefined) kept.push({ durationSec, intervalSec: input.intervalSec });
  if (input.sliceQty !== undefined) kept.push({ durationSec, sliceQty: input.sliceQty });
  return kept;
}

function minuteInterval(input: TwapInput, shape: Shape): TwapInput {
  const intervalSec = TWAP_LIMITS.minIntervalSec;
  if (hasDuration(shape.mode)) return { durationSec: shape.durationSec, intervalSec };
  if (shape.mode === 'interval-size') return { intervalSec, sliceQty: input.sliceQty };
  return { intervalSec, slices: input.slices };
}

function candidatesOf(ctx: Context, input: TwapInput, shape: Shape, verdict: Verdict): TwapInput[] {
  if (verdict.field === 'duration') {
    const durationSec = verdict.kind === 'duration-low' ? TWAP_LIMITS.minDurationSec : TWAP_LIMITS.maxDurationSec;
    return [...keepWithDuration(input, durationSec), ...intervalPatches(durationSec, shape.slices)];
  }
  if (verdict.field === 'interval') {
    const minute = verdict.kind === 'interval-low' ? [minuteInterval(input, shape)] : [];
    return [...minute, ...(hasDuration(shape.mode) ? intervalPatches(shape.durationSec, shape.slices) : [])];
  }
  if (isSizeMode(shape.mode)) return sizePatches(ctx, shape, verdict.boundLots);
  return hasDuration(shape.mode) ? intervalPatches(shape.durationSec, shape.slices) : [];
}

function labelOf(ctx: Context, verdict: Verdict, patch: TwapInput, next: Shape): string {
  if (verdict.field === 'duration') return `Use ${spanText(next.durationSec)}`;
  if (verdict.field === 'interval') return `Use ${spanText(next.intervalSec)}`;
  if (patch.sliceQty !== undefined) return `Use ${qtyText(fxOf(patch.sliceQty))} ${ctx.coin}`;
  return `Use ${spanText(next.intervalSec)} interval`;
}

function fixOf(ctx: Context, input: TwapInput, shape: Shape, verdict: Verdict): TwapRefusal['fix'] {
  if (verdict.kind === 'too-small') return { label: 'Turn TWAP off', patch: {} };
  for (const patch of candidatesOf(ctx, input, shape, verdict)) {
    const next = shapeOf(ctx, patch);
    if (verdictOf(ctx, next) === null) return { label: labelOf(ctx, verdict, patch, next), patch };
  }
  return null;
}

function planOf(ctx: Context, shape: Shape): TwapPlan | null {
  if (shape.slices < 1 || shape.baseLots <= 0n) return null;
  return {
    slices: shape.slices,
    sliceQty: fxStr(shape.baseLots * ctx.lot),
    lastQty: fxStr(shape.lastLots * ctx.lot),
    intervalSec: shape.intervalSec,
    durationSec: shape.durationSec,
    takerAfterSec: takerAfterCapSec(shape.intervalSec),
  };
}

export function restPlan(restQty: string, slicesLeft: number, intervalSec: number, legs: TwapLegRule[], mark: number): TwapPlan | null {
  const ctx = contextOf(restQty, legs, mark, null);
  const total = ctx.totalLots;
  if (total <= 0n) return null;
  const lastOf = (n: bigint): bigint => total - (total / n) * (n - 1n);
  const most = total / ctx.minLeg.minLots;
  let count = BigInt(Math.max(1, Math.floor(slicesLeft)));
  if (count > most) count = most > 0n ? most : 1n;
  const cap = ctx.maxLeg?.maxLots ?? null;
  if (cap !== null && cap > 0n) {
    count = fxMax(count, ceilDiv(total, cap));
    while (count < total && lastOf(count) > cap) count += 1n;
  }
  const slices = Number(count);
  return planOf(ctx, { mode: 'interval-slices', slices, intervalSec, durationSec: slices * intervalSec, baseLots: total / count, lastLots: lastOf(count) });
}

export function planSlices(
  totalQty: string,
  input: TwapInput,
  legs: TwapLegRule[],
  mark: number,
  bookMaxQty?: string | null,
): TwapPlanResult {
  const ctx = contextOf(totalQty, legs, mark, bookMaxQty);
  const shape = shapeOf(ctx, input);
  const plan = planOf(ctx, shape);
  const verdict = verdictOf(ctx, shape);
  if (verdict === null && plan !== null) return { ok: true, plan };
  if (verdict === null) throw new Error('twap: a plan with no slices passed every check');
  return { ok: false, plan, refusal: { field: verdict.field, text: verdict.text, fix: fixOf(ctx, input, shape, verdict) } };
}
