import { describe, expect, it } from 'vitest';
import type { Symbol as RuleSymbol } from 'gate-api';
import { resolveActions, type ActionInput, type ResolvedAction } from '../../src/core/actions';
import type { Clients } from '../../src/core/clients';
import { clientsWith } from '../helpers/fake-clients';

const GATE = 'GATE_FUTURE_BTC_USDT';
const OKX = 'OKX_FUTURE_BTC_USDT';

const rule = (symbol: string, lotSize: string, minNotional = '5'): RuleSymbol =>
  ({
    symbol,
    exchangeType: symbol.split('_')[0],
    businessType: 'FUTURE',
    state: 'live',
    lotSize,
    tickSize: '0.1',
    minSize: '0.0001',
    minNotional,
  }) as RuleSymbol;

function fakeClients(rules: RuleSymbol[], refPrice?: number): Clients {
  const base = clientsWith({ listCrossexRuleSymbols: async () => ({ body: rules }) });
  if (refPrice === undefined) return base;
  return { ...base, spot: { listTickers: async () => ({ body: [{ last: String(refPrice) }] }) } } as Clients;
}

const leg = (symbol: string, side: 'BUY' | 'SELL', size: { qty?: string; notional?: string }): ActionInput => ({
  kind: 'open-market',
  symbol,
  side,
  pairGroupId: 'g1',
  ...size,
});

const codes = (r: ResolvedAction[]): string[] => r.flatMap((l) => l.violations.map((v) => v.code));
const messages = (r: ResolvedAction[]): string[] => r.flatMap((l) => l.violations.map((v) => v.message));
const warnings = (r: ResolvedAction[]): string[] => r.flatMap((l) => l.warnings);

describe('shared pair sizing', () => {
  it('coin-sized pair: both legs take the coarser lot, and the warning names both sizes', async () => {
    const clients = fakeClients([rule(GATE, '0.001'), rule(OKX, '0.0001')], 65_000);
    const r = await resolveActions(
      clients,
      [leg(GATE, 'BUY', { qty: '2.5296' }), leg(OKX, 'SELL', { qty: '2.5296' })],
      { mode: 'preview' },
    );

    expect(r.map((l) => l.qty)).toEqual(['2.529', '2.529']);
    expect(codes(r)).not.toContain('pair-qty-mismatch');
    expect(warnings(r)).toContain('size set to 2.529 (was 2.5296) so both legs trade the same amount');
  });

  it('coin-sized pair sizes with no reference price, and skips the min-notional check', async () => {
    const clients = fakeClients([rule(GATE, '0.001', '1000'), rule(OKX, '0.0001', '1000')]);
    const r = await resolveActions(
      clients,
      [leg(GATE, 'BUY', { qty: '2.5296' }), leg(OKX, 'SELL', { qty: '2.5296' })],
      { mode: 'execute' },
    );

    expect(r.map((l) => l.qty)).toEqual(['2.529', '2.529']);
    expect(codes(r)).toEqual([]);
    expect(r.every((l) => Number.isFinite(l.estNotional))).toBe(true);
  });

  it('keeps a leg priced off its own limit price when the shared sizing has no price', async () => {
    const clients = fakeClients([rule(GATE, '0.001'), rule(OKX, '0.0001')]);
    const r = await resolveActions(
      clients,
      [
        { kind: 'open-limit', symbol: GATE, side: 'BUY', qty: '2.5296', price: '65000', pairGroupId: 'g1' },
        leg(OKX, 'SELL', { qty: '2.5296' }),
      ],
      { mode: 'preview' },
    );

    expect(r.map((l) => l.qty)).toEqual(['2.529', '2.529']);
    expect(r[0].estNotional).toBeCloseTo(2.529 * 65_000);
    expect(Number.isFinite(r[1].estNotional)).toBe(true);
  });

  it('values a maker leg at its own limit price, not the market reference', async () => {
    const clients = fakeClients([rule(GATE, '0.001'), rule(OKX, '0.0001')], 65_000);
    const r = await resolveActions(
      clients,
      [
        { kind: 'open-limit', symbol: GATE, side: 'BUY', qty: '2.5296', price: '60000', pairGroupId: 'g1' },
        leg(OKX, 'SELL', { qty: '2.5296' }),
      ],
      { mode: 'preview' },
    );

    expect(r.map((l) => l.qty)).toEqual(['2.529', '2.529']);
    expect(r[0].estNotional).toBeCloseTo(2.529 * 60_000);
    expect(r[1].estNotional).toBeCloseTo(2.529 * 65_000);
  });

  it('refuses a pair with one leg in coins and one in dollars', async () => {
    const clients = fakeClients([rule(GATE, '0.001'), rule(OKX, '0.0001')], 65_000);
    const r = await resolveActions(
      clients,
      [leg(GATE, 'BUY', { qty: '2.5296' }), leg(OKX, 'SELL', { notional: '164000' })],
      { mode: 'preview' },
    );

    const first = r.map((l) => l.violations.find((v) => v.code === 'pair-qty-mismatch')?.message);
    expect(first).toEqual([
      'pair legs are sized differently — one in coins, one in dollars; size both the same way',
      'pair legs are sized differently — one in coins, one in dollars; size both the same way',
    ]);
    expect(messages(r).some((m) => m.startsWith('pair sizing:'))).toBe(false);
  });

  it('refuses two different coin sizes instead of adopting one of them', async () => {
    const clients = fakeClients([rule(GATE, '0.001'), rule(OKX, '0.001')], 65_000);
    const r = await resolveActions(
      clients,
      [leg(GATE, 'BUY', { qty: '2.5' }), leg(OKX, 'SELL', { qty: '2.4' })],
      { mode: 'preview' },
    );

    expect(codes(r)).toContain('pair-qty-mismatch');
    expect(messages(r)).toContain('pair legs have different qty (2.5 vs 2.4) — use one shared qty');
  });

  it('names both venues when the two lots have no common size', async () => {
    const clients = fakeClients([rule(GATE, '0.003'), rule(OKX, '0.002')], 65_000);
    const r = await resolveActions(
      clients,
      [leg(GATE, 'BUY', { qty: '0.009' }), leg(OKX, 'SELL', { qty: '0.009' })],
      { mode: 'preview' },
    );

    const lot = r.map((l) => l.violations.find((v) => v.code === 'lot-incompatible')?.message);
    expect(lot).toEqual([
      `${GATE} trades in steps of 0.003 and ${OKX} in steps of 0.002 — no size fits both legs`,
      `${GATE} trades in steps of 0.003 and ${OKX} in steps of 0.002 — no size fits both legs`,
    ]);
    expect(messages(r).some((m) => m.includes('--qty'))).toBe(false);
  });

  it('dollar-sized pair keeps its shared size and its min-notional check', async () => {
    const rules = [rule(GATE, '0.001'), rule(OKX, '0.0001')];
    const both = [leg(GATE, 'BUY', { notional: '500' }), leg(OKX, 'SELL', { notional: '500' })];

    const ok = await resolveActions(fakeClients(rules, 65_000), both, { mode: 'preview' });
    expect(ok.map((l) => l.qty)).toEqual(['0.007', '0.007']);
    expect(codes(ok)).not.toContain('pair-qty-mismatch');

    const rich = [rule(GATE, '0.001', '1000'), rule(OKX, '0.0001', '1000')];
    const low = await resolveActions(fakeClients(rich, 65_000), both, { mode: 'preview' });
    expect(codes(low)).toContain('below-min-notional');
    expect(messages(low)).toContain('pair sizing: est. notional 455.00 is below a leg min notional (1000); increase --notional');
  });

  it('leaves a dollar-sized pair unsized when there is no reference price', async () => {
    const clients = fakeClients([rule(GATE, '0.001'), rule(OKX, '0.0001')]);
    const r = await resolveActions(
      clients,
      [leg(GATE, 'BUY', { notional: '500' }), leg(OKX, 'SELL', { notional: '500' })],
      { mode: 'preview' },
    );

    expect(r.map((l) => l.qty)).toEqual(['', '']);
    expect(codes(r)).toEqual(['ref-price-unavailable', 'ref-price-unavailable']);
  });
});
