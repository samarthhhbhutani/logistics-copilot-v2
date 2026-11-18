import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { Archive, FileText, Inbox, LogOut, Send } from 'lucide-react';
import type { GmailLabel } from '@lc/contract';
import { Brand } from './brand.js';
import { errorMessage, frontendApi, isUnauthenticated } from './frontendApi.js';

export const MAIL_FOLDERS = [
  { label: undefined, title: 'All mail', Icon: Archive },
  { label: 'inbox', title: 'Inbox', Icon: Inbox },
  { label: 'sent', title: 'Sent', Icon: Send },
] as const;

export type MailFolder = (typeof MAIL_FOLDERS)[number];

/** The folder a `?label=` value names; All mail for anything else. */
export function mailFolderFor(labelValue: string | null): MailFolder {
  return MAIL_FOLDERS.find((folder) => folder.label === labelValue) ?? MAIL_FOLDERS[0];
}

export function mailboxPath(label?: GmailLabel): string {
  return label ? `/mailbox?${new URLSearchParams({ label })}` : '/mailbox';
}

/**
 * The frame every signed-in page shares: sidebar (brand, mail folders, sign out) and the header with
 * the breadcrumb and the account address. Pages render inside as children. The sidebar is the one
 * place that knows every page, so a new page is a link here and a route in frontendApp; nothing
 * else moves.
 */
export function WorkspaceShell({
  pageTitle,
  accountAddress,
  sessionError,
  onSignedOut,
  onSignOutStarted,
  children,
}: {
  /** Breadcrumb leaf and the sidebar entry marked current. */
  pageTitle: 'Mailbox' | 'Vendor quotes';
  /** Undefined while the mailbox is still loading. */
  accountAddress: string | undefined;
  sessionError?: string;
  onSignedOut: () => void;
  /** Runs before the logout request: a page cancels work (an OAuth redirect) that must not outlive the session. */
  onSignOutStarted?: () => void;
  children: ReactNode;
}) {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const activeFolder = pageTitle === 'Mailbox' ? mailFolderFor(searchParams.get('label')) : null;
  const logoutController = useRef<AbortController | null>(null);
  useEffect(() => () => logoutController.current?.abort(), []);
  const logout = useMutation({
    mutationFn: () => {
      onSignOutStarted?.();
      logoutController.current = new AbortController();
      return frontendApi.logout(logoutController.current.signal);
    },
    onSuccess: () => {
      if (!logoutController.current?.signal.aborted) onSignedOut();
    },
  });
  const expired = isUnauthenticated(logout.error);
  useEffect(() => {
    if (expired) onSignedOut();
  }, [expired, onSignedOut]);

  return (
    <div className="workspace">
      <a className="skipLink" href="#main-content">
        Skip to content
      </a>
      <aside className="sidebar">
        <Brand />
        <div className="workspaceLabel">Mail workspace</div>
        <nav aria-label="Mail folders">
          {MAIL_FOLDERS.map((folder) => {
            const current = activeFolder === folder;
            return (
              <Link
                key={folder.title}
                className={`folderButton ${current ? 'active' : ''}`}
                aria-current={current ? 'page' : undefined}
                to={mailboxPath(folder.label)}
              >
                <folder.Icon size={19} aria-hidden="true" />
                <span>{folder.title}</span>
                {current && <span className="activeDot" />}
              </Link>
            );
          })}
        </nav>
        <div className="workspaceLabel">Requests</div>
        <nav aria-label="Requests">
          <Link
            className={`folderButton ${pageTitle === 'Vendor quotes' ? 'active' : ''}`}
            aria-current={pageTitle === 'Vendor quotes' ? 'page' : undefined}
            to="/rfqs"
          >
            <FileText size={19} aria-hidden="true" />
            <span>Vendor quotes</span>
            {pageTitle === 'Vendor quotes' && <span className="activeDot" />}
          </Link>
        </nav>
        <div className="sidebarBottom">
          <p className="sidebarNote">
            A workspace for
            <br />
            your conversations.
          </p>
          <button
            className="folderButton signOut"
            aria-disabled={logout.isPending}
            onClick={() => {
              if (!logout.isPending) logout.mutate();
            }}
          >
            <LogOut size={18} aria-hidden="true" />
            {logout.isPending ? 'Signing out…' : 'Sign out'}
          </button>
          {logout.error && !expired && (
            <p className="formError" role="alert">
              {errorMessage(logout.error)}
            </p>
          )}
        </div>
      </aside>
      <main className="mailboxMain" id="main-content" key={location.pathname}>
        <header className="workspaceHeader">
          <span className="breadcrumb">
            Workspace <span>/</span> {pageTitle}
          </span>
          <span className="accountAddress">{accountAddress ?? 'Loading mailbox…'}</span>
        </header>
        {sessionError && (
          <p className="inlineAlert" role="alert">
            Session check failed. {sessionError}
          </p>
        )}
        {children}
      </main>
    </div>
  );
}
