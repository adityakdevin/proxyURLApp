# This history is NOT authoritative

This project syncs its database with **`prisma db push`** (see `docs/DEPLOYMENT.md` and
`TESTING.md`). The files in this directory cannot rebuild the current schema: only the
July 2026 baseline is here, and `schema.prisma` has moved ~71 lines beyond it since —
dropped `sub_category_id` columns on three master tables, a `red_flag_status` column, the
`spell_terms` table, enum changes.

Consequences, so nobody finds out the hard way:

- **Do not run `npm run db:migrate` / `prisma migrate dev`.** On a fresh database it applies
  what is here and then auto-authors a migration containing `DROP COLUMN` on three tables.
  On an existing one it detects drift and offers a reset. Use `npm run db:push`.
- **`prisma migrate deploy` does not work here either.** It fails with P3005 against any
  db-push'd database (non-empty schema, no `_prisma_migrations` rows).
- Migrations added since the baseline are written by hand and guarded to be idempotent, so
  they are harmless if a database already has the objects they create.

Fixing this properly means squashing the current schema into a new baseline and marking it
applied everywhere. That is tracked as a P1 in `TODOS.md`.
