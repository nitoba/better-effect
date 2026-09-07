# MongoDB JobEventStore Implementation Plan

> **For agentic workers:** implement this plan task-by-task with focused tests and verification.

**Goal:** Add the MongoDB durable `JobEventStore` adapter and append its events atomically with MongoDB JobStore transitions.

**Architecture:** Persist namespace-scoped events in a dedicated collection and allocate opaque cursors from a namespace counter. The event reader owns retention, cursor validation, polling, and best-effort change-stream wake hints; the JobStore receives an optional event appender and invokes it inside existing caller-owned transactions.

**Tech Stack:** TypeScript, Bun, `bun:test`, `better-effect-mq` event contracts, optional MongoDB driver facade.

**Spec:** `#87` canonical JobEventStore contract and the PostgreSQL/Redis implementations already present on `main`.

## Global Constraints

- Keep the extension optional and do not register it implicitly in Runtime.
- Never promise atomic append when the MongoDB topology cannot run transactions; fail explicitly at the existing topology boundary.
- Use `JobEventStore`/`JobEventStore.for(JobStoreToken)` tokens and Layer-first factories.
- Event records contain only the safe fields in `DurableJobEvent`; never payload, result, failure data, or arbitrary metadata.
- Use explicit bounded retention; TTL alone is insufficient.

### Task 1: Event persistence and reader

- Add `events` collection and `job-event-sequence` counter layout/migration.
- Add `MongoJobEventStore` with `tailCursor`, exclusive filtered `read`, retention and cursor expiry.
- Add change-stream wake hints with polling fallback and disposal handling.
- Add default/named/from-config Layer factories and type tests.

### Task 2: Atomic JobStore integration

- Add optional event configuration to Mongo JobStore factories.
- Append one safe event for each supported durable transition inside the existing Mongo transaction.
- Keep duplicate enqueue and heartbeat semantics unchanged.
- Add `layerWithEvents*` factories without Runtime-first bridges.

### Task 3: Migration, conformance, and docs

- Add migration and integration/conformance coverage for ordering, filters, retention, cursor expiry, wake fallback, and rollback.
- Update exports, README, package consumer/type fixtures, and changelog.
- Run the package check and inspect the final diff for scope violations.
