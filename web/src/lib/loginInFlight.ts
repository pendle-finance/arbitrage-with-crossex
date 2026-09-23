import { useSyncExternalStore } from 'react';

/**
 * One login at a time, across every Log in button on screen. The pair ticket,
 * the close form and Settings can all show one, and two clicks must not open
 * two wallet prompts. The wallet state reads it too: a key saved but not yet
 * signed is a login in progress, not an error.
 */
let loginInFlight = false;
const inFlightListeners = new Set<() => void>();

export const isLoginInFlight = (): boolean => loginInFlight;

export const setLoginInFlight = (value: boolean): void => {
  loginInFlight = value;
  for (const l of inFlightListeners) l();
};

const subscribeInFlight = (l: () => void) => {
  inFlightListeners.add(l);
  return () => inFlightListeners.delete(l);
};

export const useLoginInFlight = (): boolean => useSyncExternalStore(subscribeInFlight, isLoginInFlight);
