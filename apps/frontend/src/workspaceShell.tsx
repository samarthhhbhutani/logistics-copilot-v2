import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { Archive, FileText, Inbox, LogOut, MessageSquareText, Send } from 'lucide-react';
import { Brand } from './brand.js';
import { errorMessage, frontendApi, isUnauthenticated } from './frontendApi.js';
import type { MailListFilter } from './frontendApi.js';

export interface MailFolder {
  title: string;
  Icon: typeof Archive;
  filter: MailListFilter;
}

/** The Gmail folders, shown under "Mail folders". */
export const MAIL_FOLDERS: readonly MailFolder[] = [
  { title: 'All mail', Icon: Archive, filter: {} },
  { title: 'Inbox', Icon: Inbox, filter: { label: 'inbox' } },
  { title: 'Sent', Icon: Send, filter: { label: 'sent' } },
];

/** Inbound mail currently classified as a customer request, shown under "Requests" next to Vendor quotes. */
export const CUSTOMER_REQUESTS_FOLDER: MailFolder = {
  title: 'Customer requests',
  Icon: MessageSquareText,
  filter: { classification: 'customer_request' },
};

const ALL_MAIL_FOLDERS = [...MAIL_FOLDERS, CUSTOMER_REQUESTS_FOLDER];

/** The folder whose filter the URL's `label` and `classification` name; All mail for anything else. */
export function mailFolderFor(searchParams: URLSearchParams): MailFolder {
  const label = searchParams.get('label') ?? undefined;
  const classification = searchParams.get('classification') ?? undefined;
  return (
    ALL_MAIL_FOLDERS.find(
      (folder) => folder.filter.label === label && folder.filter.classification === classification,
    ) ?? MAIL_FOLDERS[0]!
  );
}

/** The filter as query-string entries, ready to spread next to `cursor` or `email`. */
export function mailListFilterParams(filter: MailListFilter): Record<string, string> {
  return {
    ...(filter.label ? { label: filter.label } : {}),
    ...(filter.classification ? { classification: filter.classification } : {}),
  };
}

export function mailboxPath(filter: MailListFilter): string {
  const params = new URLSearchParams(mailListFilterParams(filter));
  return params.size ? `/mailbox?${params}` : '/mailbox';
}

/**
 * The frame every signed-in page shares: sidebar (brand, mail folders, sign out) and the header with
 * the breadcrumb and the account address. Pages render inside as children. The sidebar is the one
 * place that knows every page, so a new page is a link here and a route in frontendApp; nothing
 * else moves.
 */
function folderLink(folder: MailFolder, current: boolean) {
  return (
    <Link
      key={folder.title}
      className={`folderButton ${current ? 'active' : ''}`}
      aria-current={current ? 'page' : undefined}
      to={mailboxPath(folder.filter)}
    >
      <folder.Icon size={19} aria-hidden="true" />
      <span>{folder.title}</span>
      {current && <span className="activeDot" />}
    </Link>
  );
}

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
  const activeFolder = pageTitle === 'Mailbox' ? mailFolderFor(searchParams) : null;
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
          {MAIL_FOLDERS.map((folder) => folderLink(folder, activeFolder === folder))}
        </nav>
        <div className="workspaceLabel">Requests</div>
        <nav aria-label="Requests">
          {folderLink(CUSTOMER_REQUESTS_FOLDER, activeFolder === CUSTOMER_REQUESTS_FOLDER)}
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
