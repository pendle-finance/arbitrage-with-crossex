/**
 * Top-level view switcher: one horizontal tab strip instead of a fixed-width
 * left sidebar, so narrow viewports spend their width on content.
 *
 * Opportunities and Positions are the primary tabs (what the terminal is FOR)
 * and are rendered large and cyan-highlighted; Balances / Open Orders / Trades /
 * Fees are reference views, rendered small and dim after a divider. Panels stay
 * MOUNTED while inactive (hidden via the `hidden` attribute) so react-query
 * polling and live count badges keep working off-screen.
 *
 * The strip itself is PpTabsNav's `glow` variant: the chosen tab is marked by
 * an underline inside its own box plus an info wash rising from that edge.
 */
import { Fragment, type ReactNode } from 'react';

export const ACTIVE_TAB_KEY = 'crossex:activeTab:v1';

export const TAB_IDS = ['opportunities', 'positions', 'balances', 'orders', 'trades', 'fees'] as const;
export type TabId = (typeof TAB_IDS)[number];

export function isTabId(v: unknown): v is TabId {
  return typeof v === 'string' && (TAB_IDS as readonly string[]).includes(v);
}

export interface TabDef {
  id: TabId;
  label: string;
  /** The two views the terminal exists for — large and highlighted. */
  primary?: boolean;
  /** Live count chip etc. — rendered after the label. */
  badge?: ReactNode;
}

export function TabBar({
  tabs,
  active,
  onSelect,
  right,
}: {
  tabs: TabDef[];
  active: TabId;
  onSelect: (id: TabId) => void;
  /** Header controls that share this row — freshness, settings. */
  right?: ReactNode;
}) {
  return (
    // Mirrors <main>'s grid in App.tsx (max-w, px-5, gap-5) so the strip's
    // rule and the content column share one left edge.
    <div className="mx-auto flex max-w-[1500px] items-stretch gap-5 px-5">
      <div
        role="tablist"
        aria-label="Sections"
        className="flex min-w-0 flex-1 items-stretch overflow-x-auto"
      >
        {tabs.map((t, i) => {
          const activeTab = t.id === active;
          const opensSecondary = !t.primary && Boolean(tabs[i - 1]?.primary);
          return (
            <Fragment key={t.id}>
              {opensSecondary && (
                <span aria-hidden="true" className="mx-3 h-4 w-px shrink-0 self-center bg-ink-700" />
              )}
              <button
                type="button"
                role="tab"
                id={`tab-${t.id}`}
                aria-selected={activeTab}
                aria-controls={`panel-${t.id}`}
                data-active={activeTab}
                onClick={() => onSelect(t.id)}
                // PpTabsNav, `glow` variant. The selection marker is a 2px info
                // underline INSIDE the tab (so a scrolling strip can never clip
                // it) plus a soft info wash rising from that edge — the wash is
                // a 200% background whose position animates, which is what
                // makes the change read as a sweep rather than a repaint. The
                // primaries keep their larger type; nothing is upper-cased,
                // because the mock's tabs are sentence case.
                className={`relative flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap border-0 bg-transparent transition-all duration-300 ease-in after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-info after:transition-transform after:duration-300 after:content-[''] ${
                  activeTab
                    ? 'text-ink-50 after:scale-x-100'
                    : 'text-ink-500 after:scale-x-0 hover:text-ink-400'
                } ${
                  t.primary
                    ? 'px-5 py-[15px] text-[13px] font-medium'
                    : 'px-4 py-[13px] text-[12px] font-normal'
                }`}
                style={{
                  backgroundImage:
                    'linear-gradient(to top, rgba(96,120,255,0.25) 0%, transparent 50%, transparent 100%)',
                  backgroundSize: '200% 200%',
                  backgroundPosition: activeTab ? '99% 99%' : '1% 1%',
                }}
              >
                {t.label}
                {t.badge}
              </button>
            </Fragment>
          );
        })}
      </div>
      {/* Sized to its controls. This used to reserve a fixed 340px for the
          order-ticket rail, but the ticket is an overlay drawer now and <main>
          has no rail column — so the reservation only squeezed the controls
          into wrapping, which is what made the row four different heights. */}
      {right && <div className="flex shrink-0 items-center justify-end gap-2 py-2">{right}</div>}
    </div>
  );
}

export function TabPanel({
  id,
  active,
  children,
}: {
  id: TabId;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <div role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`} hidden={!active}>
      {children}
    </div>
  );
}
