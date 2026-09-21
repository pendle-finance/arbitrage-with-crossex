import type { MarginTier, MarginTiers } from '../../web/src/lib/liquidation';
import { publicCrossEx } from './clients';

interface TierRow {
  minRiskLimitValue?: string;
  quickCalAmount?: string;
  maintenanceRate?: string;
}

interface RiskLimitRow {
  symbol?: string;
  tiers?: TierRow[];
}

export function marginTiersOf(rows: readonly RiskLimitRow[]): MarginTiers {
  const table: Record<string, MarginTier[]> = {};
  for (const r of rows) {
    if (!r.symbol) continue;
    const tiers = (r.tiers ?? [])
      .map((t) => ({
        from: Number(t.minRiskLimitValue),
        rate: Number(t.maintenanceRate),
        deduction: Number(t.quickCalAmount),
      }))
      .filter((t) => Number.isFinite(t.from) && Number.isFinite(t.deduction) && t.rate > 0)
      .sort((a, b) => a.from - b.from);
    if (tiers.length > 0) table[r.symbol] = tiers;
  }
  return table;
}

export async function loadMarginTiers(symbols: readonly string[]): Promise<MarginTiers> {
  const wanted = [...new Set(symbols)].filter((s) => s.length > 0);
  if (wanted.length === 0) return {};
  const { body } = await publicCrossEx().listCrossexRuleRiskLimits(wanted.join(','));
  return marginTiersOf(body ?? []);
}
