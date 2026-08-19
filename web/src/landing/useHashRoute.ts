import { useEffect, useRef, useState } from 'react';

/** The landing page's two views. `overview` is the pitch; `rates` is the
 * full opportunity list with the assumptions strip. */
export type LandingRoute = 'overview' | 'rates';

export const RATES_HASH = '#/rates';

function readHash(): LandingRoute {
  if (typeof window === 'undefined') return 'overview';
  return window.location.hash === RATES_HASH ? 'rates' : 'overview';
}

/**
 * A two-state route in the URL hash, so the deep view is linkable and the
 * browser's Back button returns to the pitch.
 *
 * A hash rather than a path: the landing is served as static files, so a real
 * path would 404 on a hard refresh unless the host rewrites it. A hash needs no
 * server cooperation and no router dependency.
 *
 * `hashchange` covers Back/Forward and any other in-page link; navigate() is
 * what the buttons call. Assigning `location.hash` pushes a history entry,
 * which is what makes Back work — never use `replace` here.
 */
export function useHashRoute(): [LandingRoute, (next: LandingRoute) => void] {
  const [route, setRoute] = useState<LandingRoute>(readHash);

  useEffect(() => {
    const onChange = () => setRoute(readHash());
    window.addEventListener('hashchange', onChange);
    // Resync once: useState's lazy initializer already read the hash, but a
    // redirect or an anchor click landing between that render and this effect
    // would otherwise leave `route` stale. Cheap, and a no-op when they agree.
    onChange();
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  /** Entries this hook itself pushed, so leaving `rates` can POP the one it
   * pushed rather than stacking a third. Without this the in-page Back button
   * pushed a second entry, and the browser's own Back then returned the visitor
   * to `#/rates` — the very view they had just dismissed. */
  const pushed = useRef(0);

  const navigate = (next: LandingRoute) => {
    if (next === 'rates') {
      window.location.hash = RATES_HASH;
      pushed.current += 1;
      return; // hashchange sets the route
    }

    if (pushed.current > 0) {
      // We put the #/rates entry there, so unwind it. `history.back()` is
      // async and fires hashchange, which is what updates `route`.
      pushed.current -= 1;
      window.history.back();
      return;
    }

    // Arrived directly on #/rates (a shared link): there is no entry of ours to
    // pop, so replace it — pushing '' here would make the browser's Back button
    // return to #/rates instead of leaving the site.
    if (window.location.hash) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
    setRoute('overview');
    window.scrollTo({ top: 0 });
  };

  return [route, navigate];
}
