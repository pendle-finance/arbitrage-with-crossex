import { useState, type ReactNode } from 'react';
import type { SetupRowProps } from './setupState';
import { InlineConfirm } from '../../components/InlineConfirm';
import { ChevronDown } from 'lucide-react';

type DotTone = 'done' | 'current' | 'warn' | 'later';

const DOT_CLASS: Record<DotTone, string> = {
  done: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300',
  current: 'border-cyan-500/50 bg-cyan-500/10 text-cyan-300',
  warn: 'border-amber-500/50 bg-amber-500/10 text-amber-300',
  later: 'border-ink-600 text-ink-400',
};

/** A short part of the state line ("synced 3 min ago") never breaks. A long
 * one wraps by word, so it cannot run under the row's action. */
const WHOLE_PART_MAX = 20;
const keepShortPartWhole = (part: string): string =>
  part.length <= WHOLE_PART_MAX ? part.replace(/ /g, '\u00a0') : part;

export function SetupRowFrame({
  n,
  title,
  row,
  isDone,
  doneTone = 'done',
  state,
  stateNode,
  isWarn = false,
  alert,
  setupAction,
  skipConsequence,
  children,
}: {
  n: number;
  title: string;
  row: SetupRowProps;
  isDone: boolean;
  doneTone?: 'done' | 'neutral';
  state: string | null;
  /** Shown in place of `state`'s text, e.g. an address and a tag. */
  stateNode?: ReactNode;
  isWarn?: boolean;
  alert?: ReactNode;
  setupAction?: ReactNode;
  skipConsequence?: string;
  children: ReactNode;
}) {
  const [isSkipped, setIsSkipped] = useState(false);
  const [isAsking, setIsAsking] = useState(false);
  const isSettings = row.variant === 'settings';
  const showsNotSetUp = !isDone && state === null && (isSettings || isSkipped);
  const line = showsNotSetUp ? 'not set up' : state;
  const isLineWarn = isWarn || showsNotSetUp;
  const dot: DotTone = isDone && !isLineWarn ? (doneTone === 'done' ? 'done' : 'later') : isLineWarn ? 'warn' : row.open ? 'current' : 'later';
  const canSkip = !isSettings && !isDone && row.onSkip !== undefined && skipConsequence !== undefined;

  // Settings: a set-up row opens and closes like a card, by its chevron. A row
  // not set up yet keeps its "Set up" call to action.
  const isDisclosure = isSettings && (isDone || row.open);
  const chevron = (
    <span aria-hidden className={`pp-chevron !p-1.5 transition-transform ${row.open ? 'rotate-180' : ''}`}>
      <ChevronDown size={14} aria-hidden />
    </span>
  );
  const action = isDisclosure ? (
    <button
      type="button"
      aria-label={row.open ? 'Collapse' : 'Expand'}
      aria-expanded={row.open}
      onClick={row.open ? row.onClose : row.onOpen}
      className="rounded-full hover:text-ink-50"
    >
      {chevron}
    </button>
  ) : (
    (setupAction ?? (
      <button type="button" className="btn-primary" onClick={row.onOpen}>
        Set up
      </button>
    ))
  );

  const skipAnyway = () => {
    setIsSkipped(true);
    setIsAsking(false);
    row.onSkip?.();
  };

  return (
    <section
      aria-label={title}
      className={`flex flex-col gap-3 px-4 py-3 ${showsNotSetUp ? 'rounded !border !border-gold/45' : ''}`}
    >
      <div
        className={`flex items-center gap-3 ${isDisclosure ? 'cursor-pointer' : ''}`}
        // The whole header toggles, not only the chevron. Keyboard users get
        // the chevron button, so this div needs no role of its own.
        onClick={
          isDisclosure
            ? (e) => {
                if ((e.target as HTMLElement).closest('button')) return;
                (row.open ? row.onClose : row.onOpen)?.();
              }
            : undefined
        }
      >
        <span
          aria-hidden="true"
          className={`num flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${DOT_CLASS[dot]}`}
        >
          {dot === 'done' ? '✓' : dot === 'warn' ? '!' : n}
        </span>
        <span className="shrink-0 text-sm font-medium text-ink-100">{title}</span>
        {stateNode && !showsNotSetUp ? (
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-300">{stateNode}</span>
        ) : line && (
          <span className={`num min-w-0 text-xs ${isLineWarn ? 'text-amber-400' : 'text-ink-400'}`}>
            {line
              .split(' · ')
              .map(keepShortPartWhole)
              .join(' · ')}
          </span>
        )}
        {isSettings && <span className="ml-auto shrink-0">{action}</span>}
      </div>
      {alert}
      {row.open && isAsking && (
        <InlineConfirm
          tone="warn"
          label={`Skip ${title}?`}
          question={
            <>
              <span className="font-semibold">Not recommended.</span> <span>{skipConsequence}</span>
            </>
          }
          confirmLabel="Skip anyway"
          confirmKind="neutral"
          cancelLabel="Back"
          onConfirm={skipAnyway}
          onCancel={() => setIsAsking(false)}
        />
      )}
      {row.open && !isAsking && children}
      {row.open && !isAsking && canSkip && (
        <button type="button" className="btn-link self-end text-ink-400" onClick={() => setIsAsking(true)}>
          Skip, not recommended
        </button>
      )}
    </section>
  );
}
