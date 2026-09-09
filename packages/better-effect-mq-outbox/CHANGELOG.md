# Changelog

## Unreleased

### Changed

- Document adapter-owned transaction callbacks as the application boundary for
  atomic domain writes and outbox appends; low-level `appendIn` helpers remain
  advanced adapter integrations.

## [0.1.0] - 2026-09-08

### Added

- Storage-neutral `PreparedEnqueue`-backed outbox records and identities.
- Post-commit `OutboxStore` contract and a Memory reference implementation.
- At-least-once lease and idempotent settlement foundations.
- Default and named `OutboxStore` Service tokens for Layer-based adapter composition.
- Explicit `OutboxRoutes` target registries with duplicate validation and missing-route diagnostics.
- Layer-first `OutboxPublisher` with bounded concurrency, retry/backoff, heartbeat/fencing, and Runtime-owned drain.
