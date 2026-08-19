import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PositionApp } from './PositionApp';
import './styles.css';

/** Shared-position page entry (`/position?d=…`), an HTML entry of the landing
 * build (vite.config.ts). Same module-graph guarantee as main-landing.tsx: no
 * credentials/trading UI is reachable from here. The page is fully static from
 * the URL payload — no API calls, so no QueryClientProvider either. */

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PositionApp />
  </StrictMode>,
);
