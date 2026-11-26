import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { TokenIcon } from '../components/AssetIcon';

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
      data-active={active ? true : false}
      className="pick-chip"
    >
      {children}
    </button>
  );
}

/** The coins the terminal supports (src/core/coins.ts), pinned as quick picks in both tickets. */
const QUICK_PICK_COINS = ['ETH', 'BTC', 'HYPE'];

/** The small caption every ticket section starts with. */
export function FieldLabel({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="text-[11.5px] text-ink-200">
      {children}
    </label>
  );
}

interface CoinComboboxProps {
  value: string | null;
  coins?: string[];
  onSelect: (base: string) => void;
  /** Right-hand end of the "Coin" caption row — the pair ticket puts the
   * coin's live price there. */
  aside?: ReactNode;
}

export function CoinCombobox({ value, coins: offered = QUICK_PICK_COINS, onSelect, aside }: CoinComboboxProps) {
  const { t } = useTranslation();
  const isValue = (coin: string): boolean => value !== null && coin.toUpperCase() === value.toUpperCase();
  const coins = value && !offered.some(isValue) ? [...offered, value] : offered;
  return (
    <div className="flex flex-col gap-2">
      <FieldLabel>{t('common.coin')}</FieldLabel>
      <div className="flex flex-wrap items-center gap-1.5">
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('common.coin')}>
          {coins.map((coin) => (
            <PickChip key={coin} active={isValue(coin)} onClick={() => onSelect(coin)}>
              <TokenIcon symbol={coin} size={14} />
              {coin}
            </PickChip>
          ))}
        </div>
        {aside && <span className="ml-1.5">{aside}</span>}
      </div>
    </div>
  );
}
