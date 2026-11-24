import { useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OperatorSessionResponse } from '@lc/contract';
import { Brand } from './brand.js';
import { errorMessage, frontendApi } from './frontendApi.js';

/**
 * The operator console at /operator: sign in as an operator (account made by `npm run
 * operator:create`), then create tenants and their mailboxes. Separate from the mailbox session,
 * so an operator can be signed in to both at once. Nothing here is stored in the browser.
 */
export function OperatorPage() {
  const queryClient = useQueryClient();
  const session = useQuery({
    queryKey: ['operatorSession'],
    staleTime: 0,
    queryFn: ({ signal }) => frontendApi.operatorSession(signal),
  });
  const signedIn = (operator: OperatorSessionResponse) =>
    queryClient.setQueryData(['operatorSession'], operator);
  const signedOut = () => queryClient.setQueryData(['operatorSession'], null);

  if (session.isPending)
    return (
      <main className="pageStatus" role="status">
        Opening the operator console…
      </main>
    );
  if (session.isError && session.data === undefined)
    return (
      <main className="emptyState standalone">
        <h1>Operator console unavailable</h1>
        <p role="alert">{errorMessage(session.error)}</p>
        <button className="button primary" onClick={() => void session.refetch()}>
          Try again
        </button>
      </main>
    );
  if (!session.data) return <OperatorSignIn onSignedIn={signedIn} />;
  return <OperatorConsole operator={session.data} onSignedOut={signedOut} />;
}

function OperatorSignIn({
  onSignedIn,
}: {
  onSignedIn: (operator: OperatorSessionResponse) => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const login = useMutation({
    mutationFn: () => frontendApi.operatorLogin(email.trim(), password),
    onSuccess: (operator) => {
      setPassword('');
      onSignedIn(operator);
    },
    onError: () => setPassword(''),
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!login.isPending) login.mutate();
  }
  const error = login.error ? errorMessage(login.error) : undefined;
  return (
    <main className="operatorLayout" id="main-content">
      <section className="loginFormWrap" aria-labelledby="operator-login-title">
        <Brand />
        <p className="eyebrow">Operator console</p>
        <h2 id="operator-login-title">Sign in as an operator.</h2>
        <p className="muted">Operator accounts are created on the server, not here.</p>
        <form onSubmit={submit} aria-busy={login.isPending}>
          <label htmlFor="operator-email">Operator email</label>
          <input
            id="operator-email"
            name="email"
            type="email"
            autoComplete="username"
            required
            maxLength={254}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            readOnly={login.isPending}
          />
          <label htmlFor="operator-password">Password</label>
          <input
            id="operator-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            maxLength={256}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            readOnly={login.isPending}
            aria-describedby={error ? 'operator-login-error' : undefined}
          />
          {error && (
            <p className="formError" id="operator-login-error" role="alert">
              {error}
            </p>
          )}
          <button
            className="button primary signInButton"
            type="submit"
            aria-disabled={login.isPending}
          >
            {login.isPending ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </section>
    </main>
  );
}

const emptyTenantForm = {
  name: '',
  googleClientId: '',
  googleClientSecret: '',
  pubsubTopicName: '',
  pushServiceAccountEmail: '',
};

function OperatorConsole({
  operator,
  onSignedOut,
}: {
  operator: OperatorSessionResponse;
  onSignedOut: () => void;
}) {
  const [tenantForm, setTenantForm] = useState(emptyTenantForm);
  const [mailboxTenantId, setMailboxTenantId] = useState('');
  const [mailboxEmail, setMailboxEmail] = useState('');
  const [mailboxPassword, setMailboxPassword] = useState('');
  const logout = useMutation({
    mutationFn: () => frontendApi.operatorLogout(),
    onSettled: onSignedOut,
  });
  const createTenant = useMutation({
    mutationFn: () => frontendApi.createTenant(tenantForm),
    onSuccess: ({ tenantId }) => {
      setTenantForm(emptyTenantForm);
      setMailboxTenantId(tenantId);
    },
  });
  const createMailbox = useMutation({
    mutationFn: () =>
      frontendApi.createMailbox(mailboxTenantId.trim(), {
        email: mailboxEmail.trim(),
        password: mailboxPassword,
      }),
    onSuccess: () => {
      setMailboxEmail('');
      setMailboxPassword('');
    },
  });
  const setTenantField = (field: keyof typeof emptyTenantForm) => (value: string) =>
    setTenantForm((form) => ({ ...form, [field]: value }));
  function submitTenant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!createTenant.isPending) createTenant.mutate();
  }
  function submitMailbox(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!createMailbox.isPending) createMailbox.mutate();
  }
  return (
    <main className="operatorLayout" id="main-content">
      <header className="operatorHeader">
        <Brand />
        <p className="muted">
          Signed in as <strong>{operator.email}</strong>
        </p>
        <button className="button" type="button" onClick={() => logout.mutate()}>
          Sign out
        </button>
      </header>
      <div className="operatorForms">
        <section className="loginFormWrap" aria-labelledby="create-tenant-title">
          <p className="eyebrow">Step 1</p>
          <h2 id="create-tenant-title">Create a tenant</h2>
          <p className="muted">One logistics desk, with its own Google project.</p>
          <form onSubmit={submitTenant} aria-busy={createTenant.isPending}>
            <TextField
              id="tenant-name"
              label="Desk name"
              value={tenantForm.name}
              onChange={setTenantField('name')}
              maxLength={120}
            />
            <TextField
              id="tenant-google-client-id"
              label="Google OAuth client id"
              value={tenantForm.googleClientId}
              onChange={setTenantField('googleClientId')}
              maxLength={200}
            />
            <TextField
              id="tenant-google-client-secret"
              label="Google OAuth client secret"
              type="password"
              value={tenantForm.googleClientSecret}
              onChange={setTenantField('googleClientSecret')}
              maxLength={200}
            />
            <TextField
              id="tenant-pubsub-topic"
              label="Pub/Sub topic"
              placeholder="projects/<project>/topics/<topic>"
              value={tenantForm.pubsubTopicName}
              onChange={setTenantField('pubsubTopicName')}
            />
            <TextField
              id="tenant-push-service-account"
              label="Push service account email"
              placeholder="<name>@<project>.iam.gserviceaccount.com"
              value={tenantForm.pushServiceAccountEmail}
              onChange={setTenantField('pushServiceAccountEmail')}
            />
            {createTenant.error && (
              <p className="formError" role="alert">
                {errorMessage(createTenant.error)}
              </p>
            )}
            {createTenant.data && (
              <p className="formSuccess" role="status">
                Tenant created: <code>{createTenant.data.tenantId}</code>
              </p>
            )}
            <button
              className="button primary signInButton"
              type="submit"
              aria-disabled={createTenant.isPending}
            >
              {createTenant.isPending ? 'Creating…' : 'Create tenant'}
            </button>
          </form>
        </section>
        <section className="loginFormWrap" aria-labelledby="create-mailbox-title">
          <p className="eyebrow">Step 2</p>
          <h2 id="create-mailbox-title">Create a mailbox</h2>
          <p className="muted">The owner signs in with these and connects Gmail themselves.</p>
          <form onSubmit={submitMailbox} aria-busy={createMailbox.isPending}>
            <TextField
              id="mailbox-tenant-id"
              label="Tenant id"
              value={mailboxTenantId}
              onChange={setMailboxTenantId}
            />
            <TextField
              id="mailbox-email"
              label="Mailbox email"
              type="email"
              value={mailboxEmail}
              onChange={setMailboxEmail}
              maxLength={254}
            />
            <TextField
              id="mailbox-password"
              label="Initial password"
              type="password"
              value={mailboxPassword}
              onChange={setMailboxPassword}
              minLength={6}
              maxLength={256}
            />
            {createMailbox.error && (
              <p className="formError" role="alert">
                {errorMessage(createMailbox.error)}
              </p>
            )}
            {createMailbox.data && (
              <p className="formSuccess" role="status">
                Mailbox created: <code>{createMailbox.data.mailboxId}</code>. Share the email and
                password with its owner.
              </p>
            )}
            <button
              className="button primary signInButton"
              type="submit"
              aria-disabled={createMailbox.isPending}
            >
              {createMailbox.isPending ? 'Creating…' : 'Create mailbox'}
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}

function TextField({
  id,
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  minLength,
  maxLength,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'email' | 'password';
  placeholder?: string;
  minLength?: number;
  maxLength?: number;
}) {
  return (
    <>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        name={id}
        type={type}
        required
        autoComplete="off"
        placeholder={placeholder}
        minLength={minLength}
        maxLength={maxLength}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </>
  );
}
