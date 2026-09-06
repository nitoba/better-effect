# Changelog

## Unreleased

- Add the PostgreSQL v1 `OutboxStore` adapter with transactional `appendIn`,
  digest-idempotent appends, fenced leases, settlements, recovery, inspection,
  and default/named Service Layers.
- Add migration `003_outbox.sql` and schema validation for the durable outbox
  layout.

## [0.1.0] - 2026-09-02

Initial release of `better-effect-mq-postgres`.

- Add the isolated `PostgresClient` boundary with explicit pool ownership.
- Add borrowed and config-backed client Layers.
- Add ordered, checksummed, locked, idempotent migrations.
- Add read-only schema validation and safe identifier/configuration checks.
- Ship the protocol schema, constraints, indexes, and migrations in the npm tarball.
- Keep PostgreSQL driver loading lazy through the optional `pg` peer.

This release includes the durable `JobStore` operations, claims, settlements,
heartbeats, and LISTEN/NOTIFY support provided by this adapter.

Future changes will be recorded here without promising a release date.
