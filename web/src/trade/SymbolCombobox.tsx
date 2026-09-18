/**
 * Coin-first fuzzy symbol search over GET /api/symbols?q= (debounced 250ms),
 * plus the chip pickers the two perp tickets are built from.
 *
 * - CoinCombobox (pair ticket): a "Coin" row — quick-pick majors as chips, a
 *   search box for anything else — that selects a BASE only.
 * - MarketPicker (single ticket): "Market" = a VENUE chip row over a COIN chip
 *   row. Pick a coin, then one of its venues; searching a non-major coin lists
 *   it with its venue chips, and clicking a venue selects that full symbol.
 *   Pasting a full symbol (OKX_FUTURE_BTC_USDT) selects it directly.
 *
 * Both hide ratio-pair bases (ETHBTC…) from the list (see lib/ratioBase).
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { fetchJson } from '../api/client';
import { qk, useSymbolsByBase } from '../api/queries';
import type { SymbolRule } from '../api/types';
import { parseSymbol } from '../lib/fmt';
import { isRatioBase } from '../lib/ratioBase';
import { useDebounced } from '../lib/useDebounced';

const MAX_GROUPS = 10;

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
// Chips
// ---------------------------------------------------------------------------

/**
 * The ticket's pick chip: an outlined pill, filled and brightened when it is
 * the chosen one. Every selectable thing in the two perp tickets — coin,
 * venue — is one of these, so "which one is on" reads the same everywhere.
 * `aria-pressed` carries the state for assistive tech (and tests).
 */
export function PickChip({
  active,
  disabled,
  title,
  onClick,
  children,
}: {
  active?: boolean;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active ? true : false}
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={`inline-flex items-center gap-1 rounded border px-2.5 py-[3px] text-[11px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
        active
          ? 'border-ink-200/70 bg-ink-100/[0.08] text-ink-50'
          : 'border-ink-600 text-ink-300 hover:border-ink-400 hover:text-ink-100'
      }`}
    >
      {children}
    </button>
  );
}

/** Majors pinned as quick picks in both tickets. */
const QUICK_PICK_COINS = ['ETH', 'BTC', 'HYPE', 'SOL'];

/**
 * The coin chip row: the majors, plus the chosen coin as an extra chip when it
 * is not one of them (a searched-for coin must still show as selected). The
 * trailing "other coin" opens the search again — the search box itself is
 * only on screen while nothing is picked.
 */
function CoinChips({
  active,
  onPick,
  onOther,
}: {
  active: string | null;
  onPick: (coin: string) => void;
  /** Clear the pick and show the search box. Omitted = nothing picked yet. */
  onOther?: () => void;
}) {
  const coins = active && !QUICK_PICK_COINS.includes(active) ? [...QUICK_PICK_COINS, active] : QUICK_PICK_COINS;
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Quick pick coin">
      {coins.map((coin) => (
        <PickChip key={coin} active={active === coin} onClick={() => onPick(coin)}>
          {coin}
        </PickChip>
      ))}
      {onOther && (
        <button
          type="button"
          onClick={onOther}
          className="ml-0.5 text-[10.5px] text-ink-400 underline decoration-ink-600 underline-offset-2 transition-colors hover:text-ink-100"
        >
          other coin
        </button>
      )}
    </div>
  );
}

/** Pickable venue chip for a SymbolRule (search rows here + the single
 * ticket's venue row): exchange with a dim non-USDT quote note, plus
 * active/disabled states. */
export function VenuePickChip({
  rule,
  onPick,
  active,
  disabled,
  disabledTitle,
}: {
  rule: SymbolRule;
  onPick: () => void;
  active?: boolean;
  disabled?: boolean;
  disabledTitle?: string;
}) {
  return (
    <PickChip active={active} disabled={disabled} title={disabled ? disabledTitle : rule.symbol} onClick={onPick}>
      {rule.exchange}
      {rule.quote !== 'USDT' && <span className="text-[9px] font-medium opacity-70">{rule.quote}</span>}
    </PickChip>
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

/** The small caption every ticket section starts with. */
export function FieldLabel({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="text-[11.5px] text-ink-200">
      {children}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Market picker (single ticket): venue row over coin row
// ---------------------------------------------------------------------------

interface MarketPickerProps {
  /** The coin, chosen or implied by the symbol. */
  base: string | null;
  /** The full symbol, once a venue is picked too. */
  symbol: string | null;
  /** A coin was picked by hand — the venue is chosen next. */
  onBase: (base: string) => void;
  /** A full symbol was picked (venue chip, search row, or a pasted symbol). */
  onSymbol: (symbol: string) => void;
  /** Back to nothing picked: shows the search box. */
  onClear: () => void;
}

export function MarketPicker({ base, symbol, onBase, onSymbol, onClear }: MarketPickerProps) {
  const [text, setText] = useState('');
  const q = useDebounced(text.trim(), 250);
  const results = useSymbolSearch(q);
  const groups = useMemo(() => groupByBase(results.data, q), [results.data, q]);
  const venues = useSymbolsByBase(base);

  const choose = (sym: string) => {
    onSymbol(sym);
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

  const rules = (venues.data ?? []).filter((r) => r.base === base);

  return (
    <div className="flex flex-col gap-2">
      <FieldLabel>Market</FieldLabel>
      {/* Venue first, as the mock reads it — but a venue is only meaningful
          for a coin, so the row states what it is waiting for until then. */}
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Venue chips">
        {base ? (
          <>
            {rules.map((r) => (
              <VenuePickChip key={r.symbol} rule={r} active={symbol === r.symbol} onPick={() => choose(r.symbol)} />
            ))}
            {venues.isPending && <span className="text-[10.5px] text-ink-500">loading venues…</span>}
            {!venues.isPending && rules.length === 0 && (
              <span className="text-[10.5px] text-ink-500">no live perps for {base}</span>
            )}
          </>
        ) : (
          <span className="text-[10.5px] text-ink-500">pick a coin to see its venues</span>
        )}
      </div>
      <CoinChips
        active={base}
        onPick={(coin) => {
          if (coin !== base) onBase(coin);
        }}
        onOther={base ? onClear : undefined}
      />
      {!base && (
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
          {text.trim() !== '' && (
            <SearchResults
              q={q}
              isPending={results.isPending || q !== text.trim()}
              groups={groups}
              renderGroup={(b, rs) => (
                <div key={b} className="flex items-center gap-2 border-t border-ink-800 px-2.5 py-1.5 first:border-t-0">
                  <span className="w-14 shrink-0 text-xs font-semibold text-ink-100">{b}</span>
                  <span className="flex flex-wrap gap-1">
                    {rs.map((r) => (
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
  /** Right-hand end of the "Coin" caption row — the pair ticket puts the
   * coin's live price there. */
  aside?: ReactNode;
}

export function CoinCombobox({ value, onSelect, onClear, aside }: CoinComboboxProps) {
  const [text, setText] = useState('');
  const q = useDebounced(text.trim(), 250);
  const results = useSymbolSearch(q);
  const groups = useMemo(() => groupByBase(results.data, q), [results.data, q]);

  const pick = (base: string) => {
    onSelect(base);
    setText('');
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <FieldLabel>Coin</FieldLabel>
        {aside}
      </div>
      <CoinChips
        active={value}
        onPick={(coin) => {
          if (coin !== value) pick(coin);
        }}
        onOther={value ? onClear : undefined}
      />
      {!value && (
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

/** The coin a full symbol names — for callers that hold only the symbol. */
export function baseOfSymbol(symbol: string | null): string | null {
  return symbol ? parseSymbol(symbol).base || null : null;
}
