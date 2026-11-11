import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import type { SessionResponse } from '@lc/contract';
import { errorMessage, frontendApi } from './frontendApi.js';
import { LoginPage } from './loginPage.js';
import { MailboxPage } from './mailboxPage.js';

function SessionPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const session = useQuery({
    queryKey: ['session'],
    staleTime: 0,
    queryFn: ({ signal }) => frontendApi.session(signal),
  });
  const signedOut = useCallback(() => {
    // Cancel in-flight reads before dropping every account's cache. No old mailbox can flash at next login.
    void queryClient.cancelQueries();
    // Keep the observed session query: removing it can trigger a fresh /me request on navigation
    // and immediately sign back in with the shared cookie we just rejected.
    queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== 'session' });
    queryClient.getMutationCache().clear();
    queryClient.setQueryData(['session'], null);
    navigate('/login', { replace: true });
  }, [queryClient, navigate]);
  const signedIn = (claims: SessionResponse) => {
    queryClient.clear();
    queryClient.setQueryData(['session'], claims);
    navigate(`/mailbox${location.pathname === '/mailbox' ? location.search : ''}`, {
      replace: true,
    });
  };
  if (session.isPending)
    return (
      <main className="pageStatus" role="status">
        Opening your workspace…
      </main>
    );
  if (session.isError && session.data === undefined)
    return (
      <main className="emptyState standalone">
        <h1>Workspace unavailable</h1>
        <p role="alert">{errorMessage(session.error)}</p>
        <button className="button primary" onClick={() => void session.refetch()}>
          Try again
        </button>
      </main>
    );
  if (!session.data) return <LoginPage onSignedIn={signedIn} />;
  if (location.pathname !== '/mailbox') return <Navigate to="/mailbox" replace />;
  return (
    <MailboxPage
      key={`${session.data.tenantId}/${session.data.mailboxId}`}
      session={session.data}
      onSignedOut={signedOut}
      sessionError={session.isError ? errorMessage(session.error) : undefined}
    />
  );
}

export function FrontendApp() {
  return (
    <Routes>
      <Route path="/" element={<SessionPage />} />
      <Route path="/login" element={<SessionPage />} />
      <Route path="/mailbox" element={<SessionPage />} />
      <Route
        path="*"
        element={
          <main className="emptyState standalone">
            <h1>Page not found</h1>
            <p>This page is not part of your workspace.</p>
            <Link className="button primary" to="/mailbox">
              Go to mailbox
            </Link>
          </main>
        }
      />
    </Routes>
  );
}
