# MongoDB Durable Outbox Design

## Goal

Implement the durable MongoDB adapter for `better-effect-mq-outbox` in
`better-effect-mq-mongodb`, preserving caller-owned transaction semantics for
append and the existing Layer-first Service architecture.

## Scope

This change implements the storage adapter only. It does not implement an
outbox publisher, routing supervisor, retry policy, distributed transaction,
or exactly-once delivery.

## Public API

`MongoOutbox` exposes the adapter-specific append boundary:

```ts
MongoOutbox.appendIn(
  session: MongoSession,
  record: OutboxRecord,
  options?: MongoOutboxAppendOptions
): Promise<OutboxEffect<OutboxAppendResult, OutboxAppendError>>
```

The method validates the complete initial pending record, including its
`PreparedEnqueue`, and only uses the supplied session on MongoDB operations.
It never calls `withTransaction`, commit, rollback, or `endSession`.

`MongoOutboxStore` provides the default and named tokens from
`better-effect-mq-outbox`:

```ts
MongoOutboxStore.layer(config)
MongoOutboxStore.layerFor(OutboxStore.named('billing'), config)
MongoOutboxStore.layerFromConfig(config)
MongoOutboxStore.layerFromConfigFor(OutboxStore.named('billing'), config)
```

The adapter re-exports the canonical `OutboxStore` token for package-level
ergonomics; it does not define a second token family.

## Persistence layout

The adapter adds a separate `${collectionPrefix}_outbox` collection. Its
documents contain the storage-neutral OutboxRecord fields, with the prepared
request and serialized failure stored as BSON subdocuments. The `_id` combines
namespace and outbox id, while the explicit namespace/id fields remain
available to queries and validation.

The Mongo layout advances from v2 to v3. Migration creates or updates the
outbox validator and indexes without rewriting existing jobs, attempts,
schedules, queues, or counters.

Indexes cover namespace/id uniqueness, pending claim order, expired active
lease recovery, target/state administration, and recent inspection.

## Atomicity and deduplication

`appendIn` uses a caller-owned transaction session and an upsert keyed by the
namespace/id identity. `$setOnInsert` makes a same-transaction duplicate a
no-op without attempting a duplicate-key write. The persisted record is then
decoded and compared by `requestDigest`: equal digests return `duplicate: true`;
different digests return `OutboxConflictError`.

Post-commit store operations use short adapter-owned transactions through the
existing `MongoJobStoreClient`. The adapter owns those sessions and closes them
after the operation; this is separate from `appendIn` ownership.

## Leases, fencing, and recovery

Claim loops use `findOneAndUpdate` with a conditional pending/due filter,
deterministic ordering, a fresh lease token, owner, expiry, and incremented
attempt count. Heartbeat and every settlement operation include the current
lease token and a non-expired lease predicate, so a stale worker cannot mutate
a redelivered record. A published record is idempotently acknowledged as
`already-applied`.

Recovery atomically converts expired active records back to pending, or to
failed when the attempt limit has been reached, and clears the old fencing
fields. Release returns a live lease to pending without changing attempts.

Errors are normalized into the existing outbox error types. Protocol/layout
violations remain diagnosable, while MongoDB driver details are not copied into
public messages.

## Testing and documentation

Unit tests use a small Mongo boundary double to verify append transaction
ownership, digest behavior, lease predicates, and Layer token typing. MongoDB
integration tests are conditional on `MONGODB_URL` and cover actual replica-set
transactions, migration, duplicate/conflict behavior, fencing, heartbeat,
recovery, settlement, reads, counts, and named stores. Package consumer,
boundary, and declaration tests verify the published surface and optional
`mongodb` peer behavior. The README and changelog document the outbox API,
layout migration, transaction ownership, and at-least-once guarantee.
