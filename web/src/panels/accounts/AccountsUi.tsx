/**
 * The one place that answers "is any of my
 * accounts in trouble?" for CrossEx AND Boros, plus its two echoes — the
 * header status and the Positions warning.
 */
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { Skeleton } from '../../components/Skeleton';
import { fmtPct, fmtTokenQty, fmtUsd } from '../../lib/fmt';
import {
  RISK_MM_USED,
  WATCH_MM_USED,
  verdictText,
  type AccountRow,
  type AccountsView,
  type RiskLevel,
} from './accountsModel';
import { openAccounts, useAccountsView } from './useAccountsView';

const BAR: Record<RiskLevel, string> = { ok: 'bg-grass', watch: 'bg-gold', risk: 'bg-guava' };
const TEXT: Record<RiskLevel, string> = { ok: 'text-ink-100', watch: 'text-amber-300', risk: 'text-rose-300' };
const BOX: Record<RiskLevel, string> = {
  ok: 'border-grass/40 bg-grass/[0.06] text-grass',
  watch: 'border-gold/50 bg-gold/[0.08] text-amber-200',
  risk: 'border-guava/60 bg-guava/[0.10] text-rose-200',
};

/** A bar and its percentage. `ticks` marks the amber and red lines (MM only). */
function Usage({ used, barClass, textClass, ticks = false }: { used: number | null; barClass: string; textClass: string; ticks?: boolean }) {
  const pct = used === null ? 0 : Math.max(0, Math.min(100, used * 100));
  return (
    <span className="flex items-center gap-2.5">
      <span className="relative block h-1.5 w-28 overflow-hidden rounded-full bg-ink-850">
        <span className={`block h-full ${used === null ? 'bg-ink-600' : barClass}`} style={{ width: `${pct}%` }} />
        {ticks && (
          <>
            <span className="absolute inset-y-0 w-px bg-ink-400/60" style={{ left: `${WATCH_MM_USED * 100}%` }} />
            <span className="absolute inset-y-0 w-px bg-ink-400/60" style={{ left: `${RISK_MM_USED * 100}%` }} />
          </>
        )}
      </span>
      <span className={`num w-10 text-right ${textClass}`}>{used === null ? 'n/a' : fmtPct(used, 0)}</span>
    </span>
  );
}

function VerdictIcon({ level, size = 14 }: { level: RiskLevel; size?: number }) {
  return level === 'ok' ? <CheckCircle2 size={size} aria-hidden /> : <AlertTriangle size={size} aria-hidden />;
}

const money = (usd: number | null) => (usd === null ? 'n/a' : fmtUsd(usd));
const headCell = 'pb-2 text-[12px] font-normal text-ink-400';

function Row({ r }: { r: AccountRow }) {
  return (
    <tr className="border-t border-ink-800">
      <td className="py-2.5 text-ink-50">{r.name}</td>
      <td className="num py-2.5 text-right">
        {r.token ? (
          // In the account's own coin first; dollars under it.
          <span className="flex flex-col items-end gap-0.5">
            <span>
              <span className="text-ink-50">{fmtTokenQty(r.token.available, r.token.symbol)}</span>
              <span className="text-ink-500">
                {' '}/ {r.token.balance === null ? 'n/a' : fmtTokenQty(r.token.balance, r.token.symbol)}
              </span>
            </span>
            <span className="text-[11.5px] text-ink-500">
              {money(r.availableUsd)} / {money(r.balanceUsd)}
            </span>
          </span>
        ) : (
          <>
            <span className="text-ink-50">{money(r.availableUsd)}</span>
            <span className="text-ink-500"> / {money(r.balanceUsd)}</span>
          </>
        )}
      </td>
      <td className="py-2.5 pl-10">
        <Usage used={r.imUsed} barClass="bg-info" textClass="text-ink-200" />
      </td>
      <td className="py-2.5">
        <Usage used={r.mmUsed} barClass={BAR[r.level]} textClass={TEXT[r.level]} ticks />
      </td>
    </tr>
  );
}

/** Top of the Accounts tab: the verdict, then every account in one format. */
export function AccountsOverview() {
  const v = useAccountsView();
  if (!v) return null;
  const group = (venue: 'CrossEx' | 'Boros') => {
    const rows = v.rows.filter((r) => r.venue === venue);
    const loading = venue === 'Boros' && rows.length === 0 && v.borosPending;
    if (rows.length === 0 && !loading) return null;
    return (
      <>
        <tr>
          <td colSpan={4} className="pb-1.5 pt-4 text-[11px] font-semibold uppercase tracking-wider text-ink-500">
            {venue}
          </td>
        </tr>
        {rows.map((r) => (
          <Row key={r.key} r={r} />
        ))}
        {loading && (
          <tr className="border-t border-ink-800">
            <td colSpan={4} className="py-2.5">
              <Skeleton className="h-4 w-full" />
            </td>
          </tr>
        )}
      </>
    );
  };
  return (
    <section aria-label="Accounts" className="card flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-[14px] font-semibold text-ink-50">Accounts</h2>
        <span className={`inline-flex items-center gap-1.5 rounded border px-2.5 py-1 text-[12.5px] font-semibold ${BOX[v.level]}`}>
          <VerdictIcon level={v.level} />
          {verdictText(v)}
        </span>
      </div>

      <table className="w-full table-fixed text-[13px]">
        <colgroup>
          <col style={{ width: '22%' }} />
          <col style={{ width: '28%' }} />
          <col style={{ width: '25%' }} />
          <col />
        </colgroup>
        <thead>
          <tr className="text-left">
            <th className={headCell}>Account</th>
            <th className={`${headCell} text-right`}>Available / Balance</th>
            <th className={`${headCell} pl-10`} title="Initial margin ÷ balance: how much of the account your positions hold.">
              <span className="tip-label">IM used</span>
            </th>
            <th className={headCell} title="Maintenance margin ÷ balance. The account liquidates at 100%; amber from 67%, red from 91%.">
              <span className="tip-label">MM used</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {group('CrossEx')}
          {group('Boros')}
        </tbody>
      </table>
    </section>
  );
}

/** The header, minimal: is anything at risk (and which account), then each
 * venue's available against its balance. One click opens Accounts. */
export function AccountStatusStrip({ children }: { children?: ReactNode }) {
  const v = useAccountsView();
  if (!v) return <div className="ml-auto" />;
  const stat = (label: string, t: { availableUsd: number; balanceUsd: number } | null) =>
    t === null ? null : (
      <span className="flex items-baseline gap-1.5 whitespace-nowrap">
        <span className="text-ink-400">{label}</span>
        <span className="num font-medium text-ink-50">{fmtUsd(t.availableUsd, 0)}</span>
        <span className="num text-ink-500">/ {fmtUsd(t.balanceUsd, 0)}</span>
      </span>
    );
  return (
    <div className="ml-auto flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
      <button
        type="button"
        onClick={openAccounts}
        className="flex items-center gap-4 rounded px-1.5 py-1 text-xs hover:bg-wash/[0.06]"
        title="Available / balance per venue (Boros: every account summed). Open Accounts for each account."
      >
        <span className={`flex items-center gap-1.5 whitespace-nowrap font-medium ${TEXT[v.level]}`}>
          <VerdictIcon level={v.level} size={13} />
          {v.worst ? `${v.worst.venue} ${v.worst.name} ${fmtPct(v.worst.mmUsed ?? 0, 0)} MM used` : 'Healthy'}
        </span>
        {stat('Gate', v.totals.CrossEx)}
        {stat('Boros', v.totals.Boros)}
      </button>
      {children}
    </div>
  );
}

/** Positions: silent when healthy; one line pointing at Accounts otherwise.
 * Replaces the per-account Boros block. */
export function AccountsAlert({ view }: { view?: AccountsView | null }) {
  const own = useAccountsView();
  const v = view ?? own;
  if (!v || v.level === 'ok') return null;
  const worst = v.worst;
  return (
    <button
      type="button"
      onClick={openAccounts}
      className={`mb-6 flex w-full items-center gap-2 rounded border px-3 py-2 text-left text-[12.5px] ${BOX[v.level]}`}
    >
      <VerdictIcon level={v.level} />
      <span className="font-semibold">{verdictText(v)}</span>
      {worst && (
        <span className="text-ink-200">
          · {worst.venue} {worst.name} at {fmtPct(worst.mmUsed ?? 0, 0)} MM used
        </span>
      )}
      <span className="ml-auto text-ink-300">View accounts ›</span>
    </button>
  );
}
