import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ToastProvider } from './components/Toast';
import { LandingApp } from './LandingApp';
import './styles.css';

/** Public landing entry, swapped in for main.tsx by the landing plugin in
 * vite.config.ts. A separate entry — rather than a runtime branch in App — is
 * what guarantees the credentials/trading UI can't ship: it is simply never in
 * this module graph. */

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
      <ToastProvider>
        <LandingApp />
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
