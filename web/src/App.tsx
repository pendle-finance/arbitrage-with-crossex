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

const GATE_KEY_GUIDE_SECTION = 'How to set up Gate and make an API key';

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
      {isTrading && <ActiveWalletChip />}
      <FreshnessIndicator />
      <button
        type="button"
        aria-label="Settings"
        title="Settings"
        onClick={openSettings}
        className="pp-chevron h-[30px] w-[30px] !p-0 text-ink-200 hover:bg-ink-600/25 hover:text-ink-50"
      >
        <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
          <path
            d="M8.19655 6.00986C7.78623 5.96933 7.37341 6.05662 7.01462 6.25978C6.65582 6.46294 6.36859 6.77204 6.19226 7.14474C6.01592 7.51745 5.95909 7.93555 6.02955 8.34181C6.10002 8.74806 6.29433 9.1226 6.58588 9.41415C6.87743 9.70571 7.25197 9.90002 7.65823 9.97048C8.06448 10.0409 8.48258 9.98412 8.85529 9.80778C9.228 9.63144 9.53709 9.34421 9.74025 8.98542C9.94341 8.62662 10.0307 8.21381 9.99018 7.80348C9.94398 7.34351 9.74016 6.91365 9.41327 6.58676C9.08638 6.25987 8.65653 6.05606 8.19655 6.00986ZM13.0118 8.00003C13.0106 8.21741 12.9946 8.43445 12.964 8.64968L14.3768 9.75773C14.4383 9.80872 14.4797 9.87987 14.4937 9.95853C14.5077 10.0372 14.4934 10.1183 14.4533 10.1874L13.1168 12.4997C13.0763 12.5682 13.0128 12.6201 12.9377 12.6463C12.8626 12.6726 12.7806 12.6714 12.7062 12.6432L11.3032 12.0782C11.2258 12.0474 11.142 12.0363 11.0593 12.0458C10.9766 12.0553 10.8975 12.0853 10.8292 12.1329C10.6151 12.2803 10.39 12.4113 10.1561 12.5247C10.0826 12.5605 10.0189 12.6138 9.97087 12.6799C9.9228 12.7461 9.89176 12.8231 9.8805 12.9041L9.6702 14.4005C9.65639 14.4796 9.61556 14.5513 9.55468 14.6036C9.49381 14.6559 9.41668 14.6854 9.33647 14.6871H6.66353C6.58464 14.6857 6.50857 14.6575 6.44785 14.6071C6.38713 14.5568 6.34538 14.4872 6.32949 14.4099L6.1195 12.9156C6.10771 12.8337 6.07587 12.756 6.0268 12.6894C5.97774 12.6228 5.91298 12.5693 5.83827 12.5338C5.60461 12.421 5.38036 12.2896 5.16769 12.141C5.0996 12.0936 5.02079 12.0639 4.93837 12.0546C4.85594 12.0453 4.77249 12.0566 4.69554 12.0876L3.29282 12.6522C3.21849 12.6805 3.13654 12.6817 3.06143 12.6555C2.98632 12.6293 2.92286 12.5775 2.88222 12.5091L1.54575 10.1968C1.50557 10.1277 1.49121 10.0466 1.50523 9.96789C1.51925 9.88921 1.56074 9.81805 1.62231 9.7671L2.81629 8.82966C2.8817 8.77774 2.93311 8.7103 2.96586 8.63347C2.9986 8.55663 3.01163 8.47284 3.00378 8.38969C2.99253 8.25939 2.98566 8.1294 2.98566 7.9991C2.98566 7.86879 2.99222 7.74067 3.00378 7.61318C3.01077 7.53054 2.9971 7.44746 2.96399 7.37142C2.93088 7.29538 2.87937 7.22877 2.8141 7.17759L1.62075 6.24015C1.56018 6.18893 1.51956 6.11804 1.50602 6.03988C1.49248 5.96172 1.50688 5.88129 1.54669 5.81268L2.88316 3.50034C2.92375 3.4319 2.98719 3.37999 3.06231 3.35375C3.13742 3.32751 3.21939 3.32863 3.29376 3.35691L4.69679 3.92187C4.77416 3.95268 4.85796 3.96381 4.94069 3.95427C5.02342 3.94472 5.10249 3.9148 5.17082 3.86719C5.38494 3.71974 5.60995 3.58875 5.8439 3.47534C5.91745 3.43959 5.98106 3.38629 6.02913 3.32013C6.0772 3.25397 6.10824 3.17699 6.1195 3.09599L6.3298 1.59953C6.34361 1.5205 6.38444 1.44872 6.44531 1.39645C6.50619 1.34419 6.58332 1.31469 6.66353 1.31299H9.33647C9.41536 1.31435 9.49143 1.34255 9.55215 1.39293C9.61287 1.44331 9.65461 1.51287 9.67051 1.59016L9.8805 3.08443C9.89229 3.16632 9.92413 3.24403 9.97319 3.31065C10.0223 3.37726 10.087 3.43072 10.1617 3.46628C10.3954 3.57907 10.6196 3.71042 10.8323 3.85906C10.9004 3.90644 10.9792 3.93613 11.0616 3.94546C11.1441 3.95479 11.2275 3.94346 11.3045 3.9125L12.7072 3.34785C12.7815 3.31954 12.8635 3.31838 12.9386 3.34456C13.0137 3.37074 13.0771 3.42258 13.1178 3.49096L14.4542 5.80331C14.4944 5.87239 14.5088 5.9535 14.4948 6.03218C14.4807 6.11086 14.4393 6.18201 14.3777 6.23297L13.1837 7.1704C13.118 7.22216 13.0663 7.28952 13.0333 7.36637C13.0003 7.44321 12.987 7.52709 12.9947 7.61037C13.005 7.73974 13.0118 7.86973 13.0118 8.00003Z"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
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
                <SetupPage onFinish={finishSetup} onOpenGuide={() => openGuide(GATE_KEY_GUIDE_SECTION)} />
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
            onOpenGuide={() => openGuide(GATE_KEY_GUIDE_SECTION)}
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
