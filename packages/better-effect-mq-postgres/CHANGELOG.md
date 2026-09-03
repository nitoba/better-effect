# Changelog

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

## Unreleased

Future changes will be recorded here without promising a release date.
