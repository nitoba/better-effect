# Changelog

## [0.1.0] - 2026-09-02

Initial release of `better-effect-kysely`.

- Add yieldable Kysely Service tokens with schema-preserving inference.
- Add explicit owned (`layer`) and borrowed (`succeed`) database Layers.
- Add lazy Effect `$call` terminals for queries, first-row reads, and raw or
  compiled `QueryResult` values.
- Forward Runtime-linked cancellation through Kysely's native abort strategy
  options without exposing a second `signal` option.
- Add safe typed `KyselyQueryError` and `KyselyTransactionError` boundaries.
- Add a transaction bridge that commits `Result.ok` and rolls back
  `Result.err`, defects, and cancellation while retaining native transaction
  settings.
- Validate the bridge with real Bun SQLite and PGlite integrations, plus
  type-only coverage for PostgreSQL, MySQL and SQLite Kysely dialects.
- Validate packed external consumers across Bun and Node.js 24 with Bun SQLite,
  `better-sqlite3`, PGlite, TypeScript 5.7.2 and the current compiler.
- Document the compatibility matrix, ownership model and cancellation limits.

This release does not certify every Kysely dialect or driver combination,
does not provide universal server-side cancellation, and is not a drop-in
replacement for Kysely. Migrations, streaming, controlled transactions,
schema codecs and repository abstractions remain outside the package.

## Unreleased

- Add lazy `scoped` and `borrowed` Kysely factories with sync/async contextual
  Service requirements.
- Keep `succeed` caller-owned and make `layer` a deprecated alias of `scoped`.
- Preserve Kysely schema/query/transaction inference and add shared-pool
  ownership guidance.
