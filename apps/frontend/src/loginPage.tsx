import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowRight, LockKeyhole } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import { loginRequestSchema } from '@lc/contract';
import type { SessionResponse } from '@lc/contract';
import { Brand } from './brand.js';
import { errorMessage, frontendApi } from './frontendApi.js';

export function LoginPage({ onSignedIn }: { onSignedIn: (session: SessionResponse) => void }) {
  const passwordInput = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [validationError, setValidationError] = useState<string>();
  const login = useMutation({
    mutationFn: () => frontendApi.login(email.trim(), password),
    onSuccess: (session) => {
      setPassword('');
      onSignedIn(session);
    },
    onError: () => {
      setPassword('');
      passwordInput.current?.focus();
    },
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (login.isPending) return;
    const result = loginRequestSchema.safeParse({ email: email.trim(), password });
    if (!result.success) {
      setValidationError('Enter a valid email and a password of at least 6 characters.');
      return;
    }
    setValidationError(undefined);
    login.mutate();
  }
  const error = validationError ?? (login.error ? errorMessage(login.error) : undefined);
  return (
    <main className="loginLayout" id="main-content">
      <section className="loginStory" aria-label="About Logistics Copilot">
        <Brand />
        <div className="loginPitch">
          <p className="eyebrow">A calmer day at the desk</p>
          <h1>
            Every shipment
            <br />
            starts with
            <br />
            <em>a conversation.</em>
          </h1>
          <p>Your logistics mailbox, in one focused workspace.</p>
        </div>
        <div className="routeIllustration" aria-hidden="true">
          <span>Origin</span>
          <div className="routeLine">
            <i />
            <i />
            <i />
          </div>
          <span>Destination</span>
        </div>
        <p className="storyFooter">Built around the way your desk works.</p>
      </section>
      <section className="loginPanel" aria-labelledby="login-title">
        <div className="loginFormWrap">
          <p className="eyebrow">Your workspace</p>
          <h2 id="login-title">Welcome back.</h2>
          <p className="muted">Sign in with the account your team set up for you.</p>
          <form onSubmit={submit} aria-busy={login.isPending}>
            <label htmlFor="email">Work email</label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              required
              maxLength={254}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              readOnly={login.isPending}
              placeholder="you@company.com"
            />
            <label htmlFor="password">Password</label>
            <input
              ref={passwordInput}
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              minLength={6}
              maxLength={256}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              readOnly={login.isPending}
              aria-describedby={error ? 'login-error' : undefined}
            />
            {error && (
              <p className="formError" id="login-error" role="alert">
                {error}
              </p>
            )}
            <button
              className="button primary signInButton"
              type="submit"
              aria-disabled={login.isPending}
            >
              {login.isPending ? 'Signing in…' : 'Sign in'}
              <ArrowRight size={18} aria-hidden="true" />
            </button>
          </form>
          <p className="loginHelp">
            <LockKeyhole size={15} aria-hidden="true" /> Your session opens only your own mailbox.
          </p>
          <p className="accountHelp">
            Need access or a password reset?
            <br />
            Contact your workspace administrator.
          </p>
        </div>
      </section>
    </main>
  );
}
