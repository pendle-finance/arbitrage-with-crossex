import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useCredentials, useDisclaimer, useOpenOrders, usePositions } from './api/queries';
import { AccountHealthStrip } from './components/AccountHealthStrip';
import { ActiveWalletChip } from './components/ActiveWalletChip';
import { BorrowChip } from './components/BorrowChip';
import { BrandMark } from './components/BrandMark';
import { Chip } from './components/Chip';
import { DisclaimerGate } from './components/DisclaimerGate';
import { FinishSetupPill } from './components/FinishSetupPill';
import { FreshnessIndicator } from './components/FreshnessIndicator';
import { TooltipLayer } from './components/TooltipLayer';
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
import { RollSignalProvider } from './panels/rollSignal';
import { RollOverBanner } from './panels/RollOverBanner';
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
  const [guideSection, setGuideSection] = useState<string | undefined>(undefined);
  const openGuide = useCallback((section?: string) => {
    setGuideSection(section);
    setGuideOpen(true);
  }, []);
  // null = the user has never picked a tab, so the landing tab is still up for
  // grabs: it resolves to Positions once we know they hold some, else
  // Opportunities. An explicit pick (persisted) always wins.
  const [chosenTab, setChosenTab] = useState<TabId | null>(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('tab');
    if (isTabId(fromUrl)) return fromUrl;
    return readJson<TabId | null>(ACTIVE_TAB_KEY, null, (parsed) => (isTabId(parsed) ? parsed : null));
  });

  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('tab')) return;
    url.searchParams.delete('tab');
    window.history.replaceState(null, '', url);
  }, []);
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
  const openLogin = useCallback(() => openSettingsAt('borosWallet'), [openSettingsAt]);

  // Freshness + settings ride the tab row once it exists, and fall back to the
  // brand row in the states that have no tabs (loading, first-run).
  // The mock splits the header in two. Row 1 is the ACCOUNT: the brand, the
  // balance/margin cluster, and a round icon button for settings — nothing
  // that starts a task. Row 2 is the tab strip, and the task buttons (Order
  // ticket, User guide) sit at its right end. Freshness and the update pill
  // stay with the account, since both describe the data behind it.
  const accountControls = (
    <>
      <UpdateIndicator />
      {isTrading && <SetupPrompt onOpen={openSettingsAt} />}
      <FreshnessIndicator />
      <ActiveWalletChip onOpen={openSettings} showWallet={isTrading} />
    </>
  );

  const guideButton = (
    <button
      type="button"
      aria-label="User guide"
      title="How to read the Opportunities scan and open a pair well"
      onClick={() => {
        markGuideHintDone();
        openGuide();
      }}
      className="hdr-ctl border-info/50 bg-transparent font-medium text-pastel-blue hover:bg-info/[0.16]"
    >
      User guide
    </button>
  );

  // The tab strip's right end: the two things a trader STARTS from here. The
  // strip only exists once configured, so when it does not the guide falls
  // back to row 1 — a first-run reader is exactly who it is written for, and
  // gating it on `configured` put it out of reach (audit 2026-09-21).
  const stripActions = isTrading ? (
    <>
      <OrderTicketButton />
      {guideButton}
    </>
  ) : null;

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
      <RollSignalProvider>
      <TrackedAddressProvider onOpenSettings={openSettings} onOpenLogin={openLogin}>
        <TooltipLayer />
        <DisclaimerGate />
        {/* Only once the terminal is usable: the disclaimer gate is a locked
            modal, and the first-run view already leads with its own setup
            guide — a second nudge on top of either is noise. */}
        <UserGuideHint enabled={isTrading && disclaimer.data?.accepted === true} onOpen={() => openGuide()} />
        <div className="flex min-h-full flex-col">
          {/* The tab strip lives INSIDE the sticky header so it can never be
              hidden under it — the header wraps to two rows on narrow screens,
              which a fixed `top-16` offset would get wrong. */}
          <header className="sticky top-0 z-40 border-b border-ink-700 bg-ink-950/[0.88] backdrop-blur-xl">
            <div className="mx-auto flex min-h-[64px] max-w-[1500px] flex-wrap items-center gap-x-4 gap-y-2 px-5 py-2">
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
              {/* Row 1 is the account only — status, then settings. `ml-auto`
                  when the strip is hidden so they still sit right. */}
              <div className={`flex items-center gap-2 ${showsChecklist ? 'ml-auto' : ''}`}>
                {!isTrading && guideButton}
                {accountControls}
              </div>
            </div>
            {isTrading && (
              /* The strip's own rule, so the tabs read as a band under the
                 account row rather than as part of it. */
              <div className="border-t border-ink-700/60">
                <TabBar
                  active={activeTab}
                  onSelect={selectTab}
                  right={stripActions}
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
              </div>
            )}
            {/* INSIDE the sticky header: a hedge about to mature must stay on
                screen while the trader scrolls a long tab, and it is news for
                every tab, not just Positions (his call 2026-09-20). */}
            {isTrading && <RollOverBanner onShowPositions={() => selectTab('positions')} />}
          </header>

          {credentials.data?.configured && <RecoveryBanner onOpenTab={selectTab} />}

          {/* Full-width content: the order ticket is no longer a permanent
              column — the wizard and the drawer overlay on demand. */}
          <main className="mx-auto flex w-full max-w-[1500px] flex-1 items-start gap-5 px-5 pb-24 pt-6">
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
          <SettingsDrawer
            open={settingsOpen}
            focusStep={settingsFocus}
            onClose={() => setSettingsOpen(false)}
          />
          {/* Mounted only while open, so the guide is fetched on first request. */}
          {guideOpen && (
            <Suspense fallback={null}>
              <UserGuideModal
                section={guideSection}
                onClose={() => {
                  setGuideOpen(false);
                  setGuideSection(undefined);
                }}
              />
            </Suspense>
          )}
        </div>
      </TrackedAddressProvider>
      </RollSignalProvider>
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
      title="Free-form Boros and CrossEx orders."
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
