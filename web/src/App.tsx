import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useCredentials, useDisclaimer, useOpenOrders, usePositions } from './api/queries';
import { AccountHealthStrip } from './components/AccountHealthStrip';
import { BorrowChip } from './components/BorrowChip';
import { BrandMark } from './components/BrandMark';
import { Chip } from './components/Chip';
import { DisclaimerGate } from './components/DisclaimerGate';
import { FinishSetupPill } from './components/FinishSetupPill';
import { FreshnessIndicator } from './components/FreshnessIndicator';
import { UpdateIndicator } from './components/UpdateIndicator';
import { markGuideHintDone, UserGuideHint } from './components/UserGuideHint';
import { TableSkeleton } from './components/Skeleton';
import { ACTIVE_TAB_KEY, isTabId, TabBar, TabPanel, type TabId } from './components/TabBar';
import { readJson, writeJson } from './lib/storage';
import { BalancesPanel } from './panels/BalancesPanel';
import { FeesPanel } from './panels/FeesPanel';
import { OpenOrdersPanel } from './panels/OpenOrdersPanel';
import { OpportunitiesPanel } from './panels/OpportunitiesPanel';
import { AssetsHome } from './panels/assets/AssetsHome';
import { SettingsDrawer } from './panels/SettingsDrawer';
import { SetupPage } from './panels/setup/SetupPage';
import { SETUP_SHOWN_KEY, useSetupState, type SetupStep } from './panels/setup/setupState';
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
  const [settingsFocus, setSettingsFocus] = useState<SetupStep | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  // null = the user has never picked a tab, so the landing tab is still up for
  // grabs: it resolves to Positions once we know they hold some, else
  // Opportunities. An explicit pick (persisted) always wins.
  const [chosenTab, setChosenTab] = useState<TabId | null>(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('tab');
    if (isTabId(fromUrl)) return fromUrl;
    return readJson<TabId | null>(ACTIVE_TAB_KEY, null, (parsed) => (isTabId(parsed) ? parsed : null));
  });
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

  const setupNeeded = !credentials.isPending && !credentials.data?.configured;
  const [isChecklistKept, setIsChecklistKept] = useState(false);
  useEffect(() => {
    if (setupNeeded) setIsChecklistKept(true);
  }, [setupNeeded]);
  const showsChecklist = setupNeeded || isChecklistKept;
  const isTrading = !credentials.isPending && !showsChecklist;
  const orderCount = openOrders.data?.length ?? 0;
  const ordersBadge =
    orderCount > 0 ? (
      <Chip
        sm
        tone="info"
        className="num"
        title={`${orderCount} open order${orderCount === 1 ? '' : 's'}`}
      >
        {orderCount}
      </Chip>
    ) : undefined;

  const openSettings = useCallback(() => {
    setSettingsFocus(null);
    setSettingsOpen(true);
  }, []);
  const openSettingsAt = useCallback((step: SetupStep) => {
    setSettingsFocus(step);
    setSettingsOpen(true);
  }, []);

  // Freshness + settings ride the tab row once it exists, and fall back to the
  // brand row in the states that have no tabs (loading, first-run).
  const headerControls = (
    <>
      <UpdateIndicator />
      {/* The manual free-form ticket, behind a button now: the guided wizard
          is the primary path, and an always-on armed order form beside
          unrelated content was the old layout's mis-execution hazard. */}
      {isTrading && <SetupPrompt onOpen={openSettingsAt} />}
      {isTrading && <OrderTicketButton />}
      {/* The one tinted control up here — `info`, the same blue every other
          "this is an action" wears. It used to shout in cyan with a glow ring
          on the theory that a new user who misses it trades without reading
          the assumptions; that job now belongs to UserGuideHint, which points
          AT this button on first run and can't be tuned out by familiarity the
          way a permanently loud control is. */}
      <button
        type="button"
        aria-label="User guide"
        title="How to read the Opportunities scan and open a pair well"
        onClick={() => {
          markGuideHintDone();
          setGuideOpen(true);
        }}
        className="hdr-ctl border-info/50 bg-info/[0.12] font-medium text-pastel-blue hover:bg-info/[0.22]"
      >
        User guide
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

  const finishSetup = () => {
    writeJson(SETUP_SHOWN_KEY, true);
    setIsChecklistKept(false);
    selectTab('opportunities');
  };

  return (
    <TradeFlowProvider>
      <TrackedAddressProvider onOpenSettings={openSettings}>
        <DisclaimerGate />
        {/* Only once the terminal is usable: the disclaimer gate is a locked
            modal, and the first-run view already leads with its own setup
            guide — a second nudge on top of either is noise. */}
        <UserGuideHint
          enabled={isTrading && disclaimer.data?.accepted === true}
          onOpen={() => setGuideOpen(true)}
        />
        <div className="flex min-h-full flex-col">
          {/* The tab strip lives INSIDE the sticky header so it can never be
              hidden under it — the header wraps to two rows on narrow screens,
              which a fixed `top-16` offset would get wrong. */}
          <header className="sticky top-0 z-40 border-b border-ink-700 bg-ink-950/95">
            <div className="mx-auto flex min-h-[52px] max-w-[1500px] flex-wrap items-center gap-x-[14px] gap-y-2 px-5 py-2">
              <BrandMark />
              {/* Unconfigured, /api/account 503s forever and the strip would
                  sit on its loading skeleton — hide it until keys exist. */}
              {!showsChecklist && (
                <AccountHealthStrip>
                  {/* The borrow, on every tab: the Rebalance section lives on
                      Balances, and a trader on Positions would never learn
                      about it otherwise. */}
                  {isTrading && <BorrowChip onOpen={() => selectTab('balances')} />}
                </AccountHealthStrip>
              )}
              {/* The controls ride in the TOP bar beside the account cluster,
                  not down in the tab row: they act on the account, which is
                  what the rest of this bar is about, and the tab row is then
                  free to be only tabs. `ml-auto` when the strip is hidden so
                  they still sit right. */}
              <div
                className={`flex items-center gap-2 ${showsChecklist ? 'ml-auto' : ''}`}
              >
                {headerControls}
              </div>
            </div>
            {isTrading && (
              <TabBar
                active={activeTab}
                onSelect={selectTab}
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

          {credentials.data?.configured && <RecoveryBanner onOpenTab={selectTab} />}

          {/* Full-width content: the order ticket is no longer a permanent
              column — the wizard and the drawer overlay on demand. */}
          <main className="mx-auto flex w-full max-w-[1500px] flex-1 items-start gap-5 px-5 pb-16 pt-5">
            <section className="min-w-0 flex-1">
              {credentials.isPending ? (
                <TableSkeleton rows={6} cols={7} />
              ) : showsChecklist ? (
                <SetupPage onFinish={finishSetup} />
              ) : (
                <>
                  {/* Every panel brings its own card chrome, so the tab panels
                      wrap them bare. */}
                  <TabPanel id="opportunities" active={activeTab === 'opportunities'}>
                    <OpportunitiesPanel />
                  </TabPanel>
                  <TabPanel id="positions" active={activeTab === 'positions'}>
                    <AssetsHome />
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
          </main>

          {isTrading && (
            <>
              <StrategyWizard onViewPositions={() => selectTab('positions')} />
              <OrderTicketDrawer />
            </>
          )}
          <SettingsDrawer open={settingsOpen} focusStep={settingsFocus} onClose={() => setSettingsOpen(false)} />
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

function SetupPrompt({ onOpen }: { onOpen: (step: SetupStep) => void }) {
  const { doneCount, firstMissing, isLoading } = useSetupState();
  const disclaimer = useDisclaimer();
  const hasChecked = useRef(false);
  const isReady = !isLoading && disclaimer.data?.accepted === true;

  useEffect(() => {
    if (!isReady || hasChecked.current) return;
    hasChecked.current = true;
    if (firstMissing === null || readJson(SETUP_SHOWN_KEY, false, (parsed) => parsed === true)) return;
    writeJson(SETUP_SHOWN_KEY, true);
    onOpen(firstMissing);
  }, [isReady, firstMissing, onOpen]);

  if (isLoading || firstMissing === null) return null;
  return <FinishSetupPill doneCount={doneCount} onOpen={() => onOpen(firstMissing)} />;
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
    <Drawer
      open={flow.railOpen}
      title="Order ticket"
      locked={busy}
      onClose={flow.closeRail}
      widthClass="w-[560px]"
    >
      <TradeRail onBusyChange={setBusy} />
    </Drawer>
  );
}
