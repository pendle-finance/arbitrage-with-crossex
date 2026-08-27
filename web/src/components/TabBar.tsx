/**
 * Top-level view switcher: one horizontal tab strip instead of a fixed-width
 * left sidebar, so narrow viewports spend their width on content.
 *
 * Opportunities and Positions are the primary tabs (what the terminal is FOR)
 * and are rendered large and cyan-highlighted; Balances / Open Orders / Trades /
 * Fees are reference views, rendered small and dim after a divider. Panels stay
 * MOUNTED while inactive (hidden via the `hidden` attribute) so react-query
 * polling and live count badges keep working off-screen.
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
    // Mirrors <main>'s grid in App.tsx (max-w, px-5, gap-5, w-[340px] rail) so
    // the cyan shelf below lines up with the content column exactly.
    <div className="mx-auto flex max-w-[1500px] items-stretch gap-5 px-5">
      {/* The folder's surface: a cyan hairline spanning the content column and
          stopping at the order ticket, which every tab shows. -mb-px pulls it
          over the header's grey border-b, which a child's border paints above. */}
      <div className="-mb-px min-w-0 flex-1 border-b border-cyan-500/40">
        {/* The second -mb-px pulls the tabs down over the hairline. Children
            paint above their parent's border, so the active tab's opaque
            background cuts the shelf; transparent tabs let it show through. */}
        <div
          role="tablist"
          aria-label="Sections"
          className="-mb-px flex items-stretch overflow-x-auto"
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
                  // Active = a folder tab, machined flat: square corners,
                  // opaque surface, hairline sides, a 2px cyan signal cap, and
                  // no bottom border so it cuts the shelf and reads as one
                  // surface with the content. Colour is a signal, not paint —
                  // the label goes bright white; only the cap is cyan. Inactive
                  // keeps the same box (transparent borders) so nothing shifts.
                  className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap border-x border-t-2 uppercase transition-colors ${
                    t.primary
                      ? 'px-5 pb-2.5 pt-[9px] text-[15px] font-semibold tracking-wider'
                      : 'px-3 pb-2.5 pt-[11px] text-[11px] font-medium tracking-wider'
                  } ${
                    activeTab
                      ? 'border-x-ink-700 border-t-cyan-400 bg-ink-900 text-ink-100'
                      : `border-transparent hover:border-t-ink-500 hover:bg-ink-900/40 ${
                          t.primary ? 'text-ink-400 hover:text-ink-200' : 'text-ink-500 hover:text-ink-300'
                        }`
                  }`}
                >
                  {t.label}
                  {t.badge}
                </button>
              </Fragment>
            );
          })}
        </div>
      </div>
      {/* Sized to its controls. This used to reserve a fixed 340px for the
          order-ticket rail, but the ticket is an overlay drawer now and <main>
          has no rail column — so the reservation only squeezed the controls
          into wrapping, which is what made the row four different heights. */}
      {right && (
        <div className="flex shrink-0 items-center justify-end gap-2 pb-1.5">{right}</div>
      )}
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
