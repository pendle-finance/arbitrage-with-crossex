import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useTranslation } from 'react-i18next';
import App from './App';
import { ToastProvider } from './components/Toast';
import './i18n';
import './styles.css';

// A language switch remounts the app: copy built in memos, helpers and
// memoized cards would otherwise keep the old language until their inputs
// change. Query data lives above, so nothing is fetched again.
// The language picker lives in Settings, so the remounted app opens Settings
// again: the trader stays where they clicked.
function LocalizedApp() {
  const { i18n } = useTranslation();
  const [shown, setShown] = useState(i18n.language);
  const [switched, setSwitched] = useState(false);
  if (shown !== i18n.language) {
    setShown(i18n.language);
    setSwitched(true);
  }
  return <App key={i18n.language} settingsOpenOnMount={switched} />;
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
