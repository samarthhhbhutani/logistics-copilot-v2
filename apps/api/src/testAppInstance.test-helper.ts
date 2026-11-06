import { loadConfig } from '@lc/core';
import type { Express } from 'express';
import { createAppInstance } from './createAppInstance.js';
import { createInMemoryRepositories } from './inMemoryRepositories.test-helper.js';

export const testSessionSecret = 'test-session-secret-that-is-at-least-32-chars';

/** An app wired with in-memory repositories; `stage` lets a test exercise the secure-cookie path. */
export function createTestAppInstance(stage: 'dev' | 'staging' = 'dev'): Express {
  const config = loadConfig({
    STAGE: stage,
    DATABASE_URL: 'postgresql://user:pw@localhost:6543/db',
    SESSION_SECRET: testSessionSecret,
  });
  return createAppInstance({
    config,
    ...createInMemoryRepositories(),
    sessionSecret: testSessionSecret,
  });
}
