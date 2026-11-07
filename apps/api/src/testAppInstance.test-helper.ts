import { randomBytes } from 'node:crypto';
import { createEncryptionUtil, loadConfig } from '@lc/core';
import type { EncryptionUtil } from '@lc/core';
import type { Express } from 'express';
import { createAppInstance } from './createAppInstance.js';
import { createFakeGmailOAuth } from './fakeGmailOAuth.test-helper.js';
import type { FakeGmailOAuth } from './fakeGmailOAuth.test-helper.js';
import { createInMemoryRepositories } from './inMemoryRepositories.test-helper.js';

export const testSessionSecret = 'test-session-secret-that-is-at-least-32-chars';

export interface TestAppOptions {
  /** Exercises the secure-cookie path. */
  stage?: 'dev' | 'staging';
  /** Set to get redirects from the Gmail callback instead of JSON. */
  portalUrl?: string;
  /** The Google account the fake lets consent; defaults to the test mailbox address. */
  consentingAccountEmail?: string;
}

export interface TestApp {
  app: Express;
  gmailOAuth: FakeGmailOAuth;
  encryptionUtil: EncryptionUtil;
  repositories: ReturnType<typeof createInMemoryRepositories>;
}

export const testMailboxEmail = 'ops@bhatia.example';

/** An app wired with in-memory repositories and a fake Google. */
export function createTestApp({
  stage = 'dev',
  portalUrl,
  consentingAccountEmail = testMailboxEmail,
}: TestAppOptions = {}): TestApp {
  const config = loadConfig({
    STAGE: stage,
    DATABASE_URL: 'postgresql://user:pw@localhost:6543/db',
    SESSION_SECRET: testSessionSecret,
    ...(portalUrl ? { PORTAL_URL: portalUrl } : {}),
  });
  const repositories = createInMemoryRepositories();
  const gmailOAuth = createFakeGmailOAuth(consentingAccountEmail);
  const encryptionUtil = createEncryptionUtil(randomBytes(32).toString('base64'));
  const app = createAppInstance({
    config,
    ...repositories,
    gmailOAuth,
    encryptionUtil,
    sessionSecret: testSessionSecret,
  });
  return { app, gmailOAuth, encryptionUtil, repositories };
}

/** Backwards-compatible shorthand for tests that only need the Express app. */
export function createTestAppInstance(stage: 'dev' | 'staging' = 'dev'): Express {
  return createTestApp({ stage }).app;
}
