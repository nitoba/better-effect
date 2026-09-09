# Changelog

## Unreleased

### Changed

- Document `adapter.transaction(resource, preparedRecord, callback, options?)`
  as the normal application boundary: the callback performs the domain write,
  the adapter appends the supplied record automatically, and the adapter owns
  commit, rollback, and cleanup. Low-level `appendIn` helpers remain explicitly
  advanced adapter integrations.

## [0.1.1] - 2026-09-09

### Changed

- Refreshed the public README with the current transaction, publishing, and
  durable outbox documentation.

## [0.1.0] - 2026-09-08

### Added

- Storage-neutral `PreparedEnqueue`-backed outbox records and identities.
- Post-commit `OutboxStore` contract and a Memory reference implementation.
- At-least-once lease and idempotent settlement foundations.
- Default and named `OutboxStore` Service tokens for Layer-based adapter composition.
- Explicit `OutboxRoutes` target registries with duplicate validation and missing-route diagnostics.
- Layer-first `OutboxPublisher` with bounded concurrency, retry/backoff, heartbeat/fencing, and Runtime-owned drain.
