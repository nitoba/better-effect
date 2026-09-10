# Changelog

## Unreleased

### Changed

- Updated the `better-effect` peer range to `>=0.14.0 <0.15.0` and preserved
  the exact database schema type through Service instances and transactions.

## [0.1.0] - 2026-09-02

Initial release of `better-effect-kysely`.

- Add yieldable Kysely Service tokens with schema-preserving inference.
- Add explicit owned (`scoped`) and borrowed (`borrowed`, `succeed`) database Layers.
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
- Validate packed external consumers across the latest Bun release and current
  Node.js LTS with Bun SQLite, `better-sqlite3`, PGlite and the current
  TypeScript 7.x compiler; the public peer range begins at TypeScript 6.0.
- Document the compatibility matrix, ownership model and cancellation limits.

This release does not certify every Kysely dialect or driver combination,
does not provide universal server-side cancellation, and is not a drop-in
replacement for Kysely. Migrations, streaming, controlled transactions,
schema codecs and repository abstractions remain outside the package.
