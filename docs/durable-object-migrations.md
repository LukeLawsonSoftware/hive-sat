# Durable Object migration convention

HiveSAT uses Wrangler's ordered `migrations` array as an append-only deployment
ledger. The empty array in `wrangler.jsonc` is intentional until the first
Durable Object classes are introduced.

When a phase adds or changes a Durable Object namespace:

1. Append one new migration at the end of the array with a unique, increasing
   tag such as `v0001_job_coordinators`.
2. Create every new namespace with `new_sqlite_classes`. The legacy
   `new_classes` storage backend is not allowed.
3. Never edit, remove, reorder, or reuse a migration that has reached `main`.
4. Keep class exports, bindings, generated `worker-configuration.d.ts`, tests,
   and the migration entry in the same pull request.
5. Run `pnpm wrangler:types:check`, the Workers-runtime tests, and
   `pnpm wrangler:dry-run` before merge.

Renames and deletions must also be appended as new migration entries. If a
deployed history is wrong, correct it with a later migration instead of
rewriting history.
