import { describe, expect, it } from 'vitest';
import { getPrismaClient, initializePrismaClient } from './prisma-client.js';

// Constructing the client opens no connection (pg pools lazily), so a placeholder URL is safe here.
const placeholderConfig = { DATABASE_URL: 'postgresql://user:password@localhost:6543/postgres' };

describe('Prisma client singleton', () => {
  it('throws a clear error when read before initialization', () => {
    expect(() => getPrismaClient()).toThrow(/initializePrismaClient\(config\)/);
  });

  it('initializes once and returns the same instance afterwards', () => {
    const firstInstance = initializePrismaClient(placeholderConfig, { maxConnections: 1 });
    const secondInstance = initializePrismaClient(placeholderConfig);
    expect(secondInstance).toBe(firstInstance);
    expect(getPrismaClient()).toBe(firstInstance);
  });
});
