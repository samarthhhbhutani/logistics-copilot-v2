import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import '@fontsource-variable/dm-sans';
import { FrontendApp } from './frontendApp.js';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, staleTime: 30_000, refetchOnWindowFocus: true },
    mutations: { retry: false },
  },
});
const root = document.getElementById('root');
if (!root) throw new Error('Frontend root is missing');
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <FrontendApp />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
