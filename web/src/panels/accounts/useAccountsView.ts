/**
 * The accounts view: the Gate account the app already polls, and the light
 * Boros margin read (`/boros/margin`), so the header can show it on every
 * tab without polling the whole asset view.
 */
import { useMemo } from 'react';
import { useAccount, useBorosMargin } from '../../api/queries';
import { useTrackedAddress } from '../trackedAddress';
import { buildAccountsView, type AccountsView } from './accountsModel';

/** Ask the shell to open the Accounts tab (it listens; see App.tsx). */
export function openAccounts(): void {
  window.dispatchEvent(new CustomEvent('crossex:open-tab', { detail: 'balances' }));
}

/** The view, plus whether the Boros side is still on its first load (its
 * feed is the slow one, so its rows arrive seconds after Gate's). */
export function useAccountsView(): (AccountsView & { borosPending: boolean }) | null {
  const { address } = useTrackedAddress();
  const acc = useAccount().data;
  const boros = useBorosMargin(address);
  const borosMargin = boros.data?.borosMargin;
  const borosPending = Boolean(address) && boros.isPending;
  return useMemo(() => {
    if (!acc && !borosMargin) return null;
    const built = buildAccountsView({ acc, borosMargin: borosMargin ?? [] });
    return { ...built, borosPending };
  }, [acc, borosMargin, borosPending]);
}
