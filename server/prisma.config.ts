import { config } from 'dotenv';
import { defineConfig } from 'prisma/config';

// Prisma 7 no longer reads .env itself. Prisma commands run from server/, so the default
// path is server/.env.
config({ quiet: true });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  // process.env, not env(): env() throws when unset, and `prisma generate` must work
  // without a database (CI's build job has none).
  datasource: { url: process.env.DATABASE_URL },
});
