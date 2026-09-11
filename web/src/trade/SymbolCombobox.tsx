/**
 * Coin-first fuzzy symbol search over GET /api/symbols?q= (debounced 250ms).
 *
 * - SymbolCombobox: rows are BASE coins with inline venue chips (sub-label =
 *   quote when not USDT); clicking a venue chip selects that full symbol.
 *   Pasting a full symbol (OKX_FUTURE_BTC_USDT) selects it directly.
 *   Recent selections (localStorage, max 8) show while the input is empty.
 * - CoinCombobox: same search, but a row click selects the BASE only (pair mode).
 *
 * Both hide ratio-pair bases (ETHBTC…) from the list (see lib/ratioBase) and
 * pin a quick-pick row of majors (ETH/BTC/HYPE/SOL) under the input.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { fetchJson } from '../api/client';
import { qk } from '../api/queries';
import type { SymbolRule } from '../api/types';
import { SymbolCell } from '../components/VenueChip';
import { parseSymbol } from '../lib/fmt';
import { isRatioBase } from '../lib/ratioBase';
import { readJson, writeJson } from '../lib/storage';
import { useDebounced } from '../lib/useDebounced';

const RECENTS_KEY = 'crossex.recentSymbols.v1';
const MAX_RECENTS = 8;
const MAX_GROUPS = 10;

function getRecentSymbols(): string[] {
  return readJson<string[]>(RECENTS_KEY, [], (parsed) =>
    Array.isArray(parsed)
      ? parsed.filter((s): s is string => typeof s === 'string').slice(0, MAX_RECENTS)
      : [],
  );
}

function pushRecentSymbol(symbol: string): void {
  const next = [symbol, ...getRecentSymbols().filter((s) => s !== symbol)].slice(0, MAX_RECENTS);
  writeJson(RECENTS_KEY, next);
}

function useSymbolSearch(q: string) {
  return useQuery({
    queryKey: qk.symbols(q),
    queryFn: () => fetchJson<SymbolRule[]>(`/symbols?q=${encodeURIComponent(q)}`),
    enabled: q.length > 0,
    staleTime: 300_000,
    placeholderData: keepPreviousData,
  });
}

/** Group matches by base, ranking exact base match > prefix > rest.
 * Ratio-pair bases (ETHBTC…) are hidden from the list — see isRatioBase. */
function groupByBase(rules: SymbolRule[] | undefined, needle: string): Array<[string, SymbolRule[]]> {
  const m = new Map<string, SymbolRule[]>();
  for (const r of rules ?? []) {
    const g = m.get(r.base) ?? [];
    g.push(r);
    m.set(r.base, g);
  }
  // The "base index" for ratio detection is only this result set — a best-effort
  // approximation. It is NOT a full base universe: a substring search for
  // "ETHBTC" does not also return "ETH" (ETH's symbols don't contain that
  // substring), so a ratio may slip through when the user types the ratio itself.
  // Wrapped-asset exceptions are handled inside isRatioBase, not here.
  const allBases = new Set(m.keys());
  const up = needle.toUpperCase();
  const rank = (b: string) => (b === up ? 0 : b.startsWith(up) ? 1 : 2);
  return [...m.entries()]
    .filter(([b]) => !isRatioBase(b, allBases))
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .slice(0, MAX_GROUPS);
}

// ---------------------------------------------------------------------------
// Quick-pick coins
// ---------------------------------------------------------------------------

/** Majors pinned under the coin search input in both tickets. */
const QUICK_PICK_COINS = ['ETH', 'BTC', 'HYPE', 'SOL'];

function QuickPicks({ active, onPick }: { active: string | null; onPick: (coin: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1" role="group" aria-label="Quick pick coin">
      {QUICK_PICK_COINS.map((coin) => (
        <button
          key={coin}
          type="button"
          onClick={() => onPick(coin)}
          className={`chip chip-sm transition-colors ${
            active === coin
              ? 'border-cyan-400/70 bg-cyan-500/15 text-cyan-300'
              : 'hover:border-ink-500 hover:text-ink-100'
          }`}
        >
          {coin}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Venue chips
// ---------------------------------------------------------------------------

/** Pickable venue chip for a SymbolRule (search rows here + PairTicket's venue
 * rows — hence exported): exchange with a dim non-USDT quote note, plus
 * active/disabled states. */
export function VenuePickChip({
  rule,
  onPick,
  active,
  activeClass = 'border-cyan-400/70 bg-cyan-500/15 text-cyan-300',
  disabled,
  disabledTitle,
}: {
  rule: SymbolRule;
  onPick: () => void;
  active?: boolean;
  activeClass?: string;
  disabled?: boolean;
  disabledTitle?: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={disabled ? disabledTitle : rule.symbol}
      onClick={onPick}
      className={`chip chip-sm transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
        active ? activeClass : 'hover:border-ink-500 hover:text-ink-100'
      }`}
    >
      {rule.exchange}
      {rule.quote !== 'USDT' && <span className="text-[9px] opacity-70">{rule.quote}</span>}
    </button>
  );
}

function SearchResults({
  q,
  isPending,
  groups,
  renderGroup,
}: {
  q: string;
  isPending: boolean;
  groups: Array<[string, SymbolRule[]]>;
  renderGroup: (base: string, rules: SymbolRule[]) => JSX.Element;
}) {
  return (
    <div className="max-h-56 overflow-y-auto rounded-lg border border-ink-800 bg-ink-950/70">
      {isPending ? (
        <div className="px-3 py-2 text-xs text-ink-500">searching…</div>
      ) : groups.length === 0 ? (
        <div className="px-3 py-2 text-xs text-ink-500">no live perps match “{q}”</div>
      ) : (
        groups.map(([base, rules]) => renderGroup(base, rules))
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Full-symbol combobox (single ticket)
// ---------------------------------------------------------------------------

interface SymbolComboboxProps {
  value: string | null;
  onSelect: (symbol: string) => void;
  onClear: () => void;
}

export function SymbolCombobox({ value, onSelect, onClear }: SymbolComboboxProps) {
  const [text, setText] = useState('');
  const q = useDebounced(text.trim(), 250);
  const results = useSymbolSearch(q);
  const groups = useMemo(() => groupByBase(results.data, q), [results.data, q]);

  const choose = (symbol: string) => {
    pushRecentSymbol(symbol);
    onSelect(symbol);
    setText('');
  };

  // Full-symbol paste: an exact symbol match selects immediately.
  useEffect(() => {
    const upper = q.toUpperCase();
    if (upper.split('_').length < 4) return;
    const hit = (results.data ?? []).find((s) => s.symbol === upper);
    if (hit) choose(hit.symbol);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, results.data]);

  const activeBase = value ? parseSymbol(value).base : null;
  const recents = value ? [] : getRecentSymbols();

  const onQuickPick = (coin: string) => {
    if (!value) return setText(coin);
    if (coin === activeBase) return;
    onClear();
    setText(coin); // reopen the search on that coin → its venue chips
  };

  return (
    <div className="flex flex-col gap-1.5">
      {value ? (
        <>
          <div className="flex items-center justify-between gap-2 rounded-lg border border-ink-700 bg-ink-950 px-3 py-2">
            <SymbolCell symbol={value} />
            <button type="button" aria-label="change symbol" className="btn-ghost-xs" onClick={onClear}>
              ✕
            </button>
          </div>
          <QuickPicks active={activeBase} onPick={onQuickPick} />
        </>
      ) : (
        <>
          <input
            className="input"
            placeholder="Search coin (BTC…) or paste a full symbol"
            aria-label="Symbol search"
            autoComplete="off"
            spellCheck={false}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <QuickPicks active={null} onPick={onQuickPick} />
          {text.trim() === '' ? (
            recents.length > 0 && (
              <div className="flex flex-col gap-1">
                <span className="text-[10px] uppercase tracking-wider text-ink-500">Recent</span>
                <div className="flex flex-wrap gap-1">
                  {recents.map((s) => {
                    const p = parseSymbol(s);
                    return (
                      <button
                        key={s}
                        type="button"
                        title={s}
                        onClick={() => choose(s)}
                        className="chip chip-sm transition-colors hover:border-ink-500 hover:text-ink-100"
                      >
                        {p.exchange} {p.base}
                        {p.quote !== 'USDT' && <span className="text-[9px] opacity-70">{p.quote}</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            )
          ) : (
            <SearchResults
              q={q}
              isPending={results.isPending || q !== text.trim()}
              groups={groups}
              renderGroup={(base, rules) => (
                <div key={base} className="flex items-center gap-2 border-t border-ink-800 px-2.5 py-1.5 first:border-t-0">
                  <span className="w-14 shrink-0 text-xs font-semibold text-ink-100">{base}</span>
                  <span className="flex flex-wrap gap-1">
                    {rules.map((r) => (
                      <VenuePickChip key={r.symbol} rule={r} onPick={() => choose(r.symbol)} />
                    ))}
                  </span>
                </div>
              )}
            />
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Base-coin combobox (pair ticket)
// ---------------------------------------------------------------------------

interface CoinComboboxProps {
  value: string | null;
  onSelect: (base: string) => void;
  onClear: () => void;
}

export function CoinCombobox({ value, onSelect, onClear }: CoinComboboxProps) {
  const [text, setText] = useState('');
  const q = useDebounced(text.trim(), 250);
  const results = useSymbolSearch(q);
  const groups = useMemo(() => groupByBase(results.data, q), [results.data, q]);

  const pick = (base: string) => {
    onSelect(base);
    setText('');
  };
  const onQuickPick = (coin: string) => coin !== value && pick(coin);

  return (
    <div className="flex flex-col gap-1.5">
      {value ? (
        <>
          <div className="flex items-center justify-between gap-2 rounded-lg border border-ink-700 bg-ink-950 px-3 py-2">
            <span className="text-sm font-semibold text-ink-100">{value}</span>
            <button type="button" aria-label="change coin" className="btn-ghost-xs" onClick={onClear}>
              ✕
            </button>
          </div>
          <QuickPicks active={value} onPick={onQuickPick} />
        </>
      ) : (
        <>
          <input
            className="input"
            placeholder="Search coin (BTC…)"
            aria-label="Coin search"
            autoComplete="off"
            spellCheck={false}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <QuickPicks active={null} onPick={onQuickPick} />
          {text.trim() !== '' && (
            <SearchResults
              q={q}
              isPending={results.isPending || q !== text.trim()}
              groups={groups}
              renderGroup={(base, rules) => (
                <button
                  key={base}
                  type="button"
                  className="flex w-full items-center gap-2 border-t border-ink-800 px-2.5 py-1.5 text-left transition-colors first:border-t-0 hover:bg-ink-800/60"
                  onClick={() => pick(base)}
                >
                  <span className="w-14 shrink-0 text-xs font-semibold text-ink-100">{base}</span>
                  <span className="flex flex-wrap gap-1">
                    {rules.map((r) => (
                      <span key={r.symbol} className="chip chip-sm">
                        {r.exchange}
                        {r.quote !== 'USDT' && <span className="text-[9px] opacity-70">{r.quote}</span>}
                      </span>
                    ))}
                  </span>
                </button>
              )}
            />
          )}
        </>
      )}
    </div>
  );
}
