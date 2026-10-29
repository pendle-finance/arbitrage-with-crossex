import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { useTranslation } from 'react-i18next';
import App from './App';
import { ToastProvider } from './components/Toast';
import './i18n';
import './styles.css';

// A language switch remounts the app: copy built in memos, helpers and
// memoized cards would otherwise keep the old language until their inputs
// change. Query data lives above, so nothing is fetched again.
function LocalizedApp() {
  const { i18n } = useTranslation();
  return <App key={i18n.language} />;
}

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
        <LocalizedApp />
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
