import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { LtpLandingApp } from './LtpLandingApp';
import './styles.css';

/** Boros × LTP landing entry (`/ltp`), built with yarn --cwd web build:ltp.
 * No credential forms or trading controls are reachable from this page. */

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: true,
      retry: 1,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <LtpLandingApp />
    </QueryClientProvider>
  </StrictMode>,
);
