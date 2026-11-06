import 'dotenv/config';
import { defineConfig } from 'prisma/config';

/**
 * Prisma ORM 7 config (CLI only).
 *
 * - v7 no longer loads `.env` automatically, hence `dotenv/config`.
 * - The datasource URL lives here instead of `schema.prisma`. It is attached
 *   only when `DATABASE_URL` is present so that codegen-only commands
 *   (`prisma generate`, run by `npm ci`/CI/Docker) work without a database.
 *   `migrate`/`db` commands still require it and fail loudly when it is
 *   missing.
 * - The runtime client connects through the `@prisma/adapter-pg` driver
 *   adapter (see `packages/server/src/infrastructure/prisma/client.ts`).
 * - Seeding is explicit in v7 (`prisma db seed`); `migrate dev` no longer runs
 *   it automatically.
 */
const databaseUrl = process.env.DATABASE_URL;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  ...(databaseUrl ? { datasource: { url: databaseUrl } } : {}),
});
