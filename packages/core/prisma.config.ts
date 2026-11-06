import 'dotenv/config';
import { defineConfig } from 'prisma/config';

/**
 * Prisma CLI config. Migrations use DIRECT_URL (Supabase port 5432): the transaction
 * pooler on 6543 cannot hold the advisory locks / multi-statement transactions migrate needs.
 * The application client (src/db/client.ts) uses DATABASE_URL (pooler) via @prisma/adapter-pg.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? '' },
});
