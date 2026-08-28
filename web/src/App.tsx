import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { useCredentials, useDisclaimer, useOpenOrders, usePositions } from './api/queries';
import { AccountHealthStrip } from './components/AccountHealthStrip';
import { BrandMark } from './components/BrandMark';
import { Chip } from './components/Chip';
import { DisclaimerGate } from './components/DisclaimerGate';
import { FreshnessIndicator } from './components/FreshnessIndicator';
import { UpdateIndicator } from './components/UpdateIndicator';
import { markGuideHintDone, UserGuideHint } from './components/UserGuideHint';
import { TableSkeleton } from './components/Skeleton';
import { ACTIVE_TAB_KEY, isTabId, TabBar, TabPanel, type TabId } from './components/TabBar';
import { readJson, writeJson } from './lib/storage';
import { BalancesPanel } from './panels/BalancesPanel';
import { FeesPanel } from './panels/FeesPanel';
import { OnboardingGuide } from './panels/OnboardingGuide';
import { OpenOrdersPanel } from './panels/OpenOrdersPanel';
import { OpportunitiesPanel } from './panels/OpportunitiesPanel';
import { PositionsHome } from './panels/PositionsHome';
import { SettingsDrawer } from './panels/SettingsDrawer';
import { TrackedAddressProvider } from './panels/trackedAddress';
import { TradesPanel } from './panels/TradesPanel';
import { Drawer } from './components/Drawer';
import { RecoveryBanner } from './trade/RecoveryBanner';
import { StrategyWizard } from './trade/StrategyWizard';
import { TradeFlowProvider, useTradeFlow } from './trade/TradeFlow';
import { TradeRail } from './trade/TradeRail';

// The markdown renderer is ~160kB and only the guide needs it — split it out so
// opening the terminal doesn't pay for a document most sessions never read.
const UserGuideModal = lazy(() =>
  import('./components/UserGuideModal').then((m) => ({ default: m.UserGuideModal })),
);

export default function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  // null = the user has never picked a tab, so the landing tab is still up for
  // grabs: it resolves to Positions once we know they hold some, else
  // Opportunities. An explicit pick (persisted) always wins.
  const [chosenTab, setChosenTab] = useState<TabId | null>(() =>
    readJson<TabId | null>(ACTIVE_TAB_KEY, null, (parsed) => (isTabId(parsed) ? parsed : null)),
  );
  const credentials = useCredentials();
  const disclaimer = useDisclaimer();
  const openOrders = useOpenOrders();
  const positions = usePositions();

  useEffect(() => {
    if (chosenTab !== null || positions.isPending) return;
    // Deliberately NOT persisted: with no explicit pick the landing tab should
    // keep tracking whether they actually hold positions.
    setChosenTab((positions.data?.positions?.length ?? 0) > 0 ? 'positions' : 'opportunities');
  }, [chosenTab, positions.isPending, positions.data]);

  const activeTab = chosenTab ?? 'opportunities';

  // Once the credentials query settles (not pending), anything short of a
  // confirmed `configured: true` — including a load ERROR (data undefined) —
  // means we must NOT expose the live trading UI. Fall back to the first-run
  // view: live opportunities on the left, the setup guide on the right.
  const setupNeeded = !credentials.isPending && !credentials.data?.configured;
  const configured = !credentials.isPending && !setupNeeded;
  const orderCount = openOrders.data?.length ?? 0;
  const ordersBadge =
    orderCount > 0 ? (
      <Chip sm tone="cyan" className="num" title={`${orderCount} open order${orderCount === 1 ? '' : 's'}`}>
        {orderCount}
      </Chip>
    ) : undefined;

  const openSettings = useCallback(() => setSettingsOpen(true), []);

  // Freshness + settings ride the tab row once it exists, and fall back to the
  // brand row in the states that have no tabs (loading, first-run).
  const headerControls = (
    <>
      <UpdateIndicator />
      {/* The manual free-form ticket, behind a button now: the guided wizard
          is the primary path, and an always-on armed order form beside
          unrelated content was the old layout's mis-execution hazard. */}
      {configured && <OrderTicketButton />}
      {/* Deliberately the loudest thing in the header after the tabs: new users
          who miss it place real orders without knowing what the scan's
          assumptions mean. */}
      <button
        type="button"
        // The label carries the emoji; the a11y name stays plain.
        aria-label="User guide"
        title="How to read the Opportunities scan and open a pair well"
        onClick={() => {
          markGuideHintDone();
          setGuideOpen(true);
        }}
        className="hdr-ctl border-cyan-400/70 bg-cyan-500/10 text-cyan-300 shadow-[0_0_0_1px_rgba(34,211,238,0.15)] hover:border-cyan-300 hover:bg-cyan-500/20 hover:text-cyan-200"
      >
        📖 User guide
      </button>
      <FreshnessIndicator />
      <button
        type="button"
        aria-label="Settings"
        title="Settings"
        onClick={openSettings}
        className="hdr-ctl border-ink-700 bg-ink-900 text-base leading-none text-ink-400 hover:border-ink-500 hover:text-ink-100"
      >
        ⚙
      </button>
    </>
  );

  const selectTab = (id: TabId) => {
    setChosenTab(id);
    writeJson(ACTIVE_TAB_KEY, id);
    // A tall tab (Positions) must not leave a short one (Fees) scrolled past
    // its content.
    window.scrollTo({ top: 0 });
  };

  return (
    <TradeFlowProvider>
      <TrackedAddressProvider onOpenSettings={openSettings}>
        <DisclaimerGate />
        {/* Only once the terminal is usable: the disclaimer gate is a locked
            modal, and the first-run view already leads with its own setup
            guide — a second nudge on top of either is noise. */}
        <UserGuideHint
          enabled={configured && disclaimer.data?.accepted === true}
          onOpen={() => setGuideOpen(true)}
        />
        <div className="flex min-h-full flex-col">
          {/* The tab strip lives INSIDE the sticky header so it can never be
              hidden under it — the header wraps to two rows on narrow screens,
              which a fixed `top-16` offset would get wrong. */}
          <header className="sticky top-0 z-40 border-b border-ink-800 bg-ink-950/80 backdrop-blur">
            <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-x-6 gap-y-1.5 px-5 py-2">
              <BrandMark />
              {/* Unconfigured, /api/account 503s forever and the strip would
                  sit on its loading skeleton — hide it until keys exist. */}
              {!setupNeeded && <AccountHealthStrip />}
              {!configured && <div className="ml-auto flex items-center gap-2">{headerControls}</div>}
            </div>
            {configured && (
              <TabBar
                active={activeTab}
                onSelect={selectTab}
                right={headerControls}
                tabs={[
                  // Forward-looking: what to put on next, then what is on.
                  { id: 'opportunities', label: 'Opportunities', primary: true },
                  { id: 'positions', label: 'Positions', primary: true },
                  { id: 'balances', label: 'Balances' },
                  { id: 'orders', label: 'Open Orders', badge: ordersBadge },
                  { id: 'trades', label: 'Trades' },
                  { id: 'fees', label: 'Fees' },
                ]}
              />
            )}
          </header>

          {credentials.data?.configured && <RecoveryBanner />}

          {/* Full-width content: the order ticket is no longer a permanent
              column — the wizard and the drawer overlay on demand. */}
          <main className="mx-auto flex w-full max-w-[1500px] flex-1 items-start gap-5 px-5 py-5">
            <section className="min-w-0 flex-1">
              {credentials.isPending ? (
                <TableSkeleton rows={6} cols={7} />
              ) : setupNeeded ? (
                <>
                  <h2 className="mb-3 text-[34px] font-bold leading-tight tracking-tight text-ink-100">
                    Live fixed rates, up for grabs
                  </h2>
                  <OpportunitiesPanel unconfigured />
                </>
              ) : (
                <>
                  {/* Every panel brings its own card chrome, so the tab panels
                      wrap them bare. */}
                  <TabPanel id="opportunities" active={activeTab === 'opportunities'}>
                    <OpportunitiesPanel />
                  </TabPanel>
                  <TabPanel id="positions" active={activeTab === 'positions'}>
                    <PositionsHome />
                  </TabPanel>
                  <TabPanel id="balances" active={activeTab === 'balances'}>
                    <BalancesPanel />
                  </TabPanel>
                  <TabPanel id="orders" active={activeTab === 'orders'}>
                    <OpenOrdersPanel />
                  </TabPanel>
                  <TabPanel id="trades" active={activeTab === 'trades'}>
                    <TradesPanel />
                  </TabPanel>
                  <TabPanel id="fees" active={activeTab === 'fees'}>
                    <FeesPanel />
                  </TabPanel>
                </>
              )}
            </section>

            {setupNeeded && <OnboardingGuide />}
          </main>

          {configured && (
            <>
              <StrategyWizard onViewPositions={() => selectTab('positions')} />
              <OrderTicketDrawer />
            </>
          )}
          <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />
          {/* Mounted only while open, so the guide is fetched on first request. */}
          {guideOpen && (
            <Suspense fallback={null}>
              <UserGuideModal onClose={() => setGuideOpen(false)} />
            </Suspense>
          )}
        </div>
      </TrackedAddressProvider>
    </TradeFlowProvider>
  );
}

/** Opens the manual order-ticket drawer. Must render inside TradeFlowProvider. */
function OrderTicketButton() {
  const flow = useTradeFlow();
  return (
    <button
      type="button"
      aria-label="Order ticket"
      title="The manual order ticket — free-form Boros and CrossEx orders. The cards' own buttons walk you through a full strategy."
      onClick={flow.openRail}
      className="hdr-ctl border-ink-700 bg-ink-900 text-ink-300 hover:border-ink-500 hover:text-ink-100"
    >
      Order ticket
    </button>
  );
}

/** The manual ticket, mounted ONLY while its drawer is open — a closed drawer
 * cannot sit armed with a stale order. Closing also clears any prefills.
 * `locked` while a Boros execution is in flight: closing would unmount the
 * ticket, and its fill report — a partial fill's remediation included — and
 * replay-protection order ids are component state that die with it while the
 * order executes at the venue regardless. */
function OrderTicketDrawer() {
  const flow = useTradeFlow();
  const [busy, setBusy] = useState(false);
  return (
    <Drawer open={flow.railOpen} title="Order ticket" locked={busy} onClose={flow.closeRail}>
      <TradeRail onBusyChange={setBusy} />
    </Drawer>
  );
}
