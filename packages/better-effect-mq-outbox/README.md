# better-effect-mq-outbox

Storage-neutral durable outbox foundations for `better-effect-mq`.

This package currently defines immutable `OutboxRecord` DTOs, outbox identity
and failure envelopes, a post-commit `OutboxStore` contract, and the in-memory
reference store used for lifecycle tests. It deliberately does not include a
publisher, database adapters, transaction handles, dashboard, or flow APIs.

An outbox record stores an already prepared `PreparedEnqueue`. The request is
encoded and versioned before it reaches an application transaction, so no
codec, callback, Service, Runtime, connection, or transaction handle is
persisted. Database adapters should expose their own `appendIn(tx, record)`
function with the concrete transaction type owned by that adapter.

The delivery guarantee is at-least-once. A publisher crash after enqueueing to
the JobStore and before marking the outbox record published is expected to
redeliver the record. Deterministic Job IDs or idempotency keys make that
second enqueue converge; the complete outbox-to-handler pipeline is not
exactly-once.

```ts
import {
  MemoryOutboxStore,
  OutboxId,
  makeOutboxRecord,
  validatePreparedEnqueue
} from 'better-effect-mq-outbox'

const outbox = MemoryOutboxStore.make()
const prepared = validatePreparedEnqueue({
  protocolVersion: 1,
  identity: { queue: 'emails', name: 'invoice', version: 1 },
  payload: { invoiceId: '123' },
  metadata: {},
  priority: 0,
  runAt: Date.now(),
  attemptsMax: 3,
  now: Date.now()
}).unwrap()
const record = makeOutboxRecord({
  id: OutboxId.make('invoice-created:123').unwrap(),
  target: 'jobs-postgres',
  request: prepared,
  nowMs: Date.now()
}).unwrap()

await outbox.append(record)
```

`OutboxId` deduplication is idempotent for the same canonical prepared
request and returns `OutboxConflictError` when the same ID is reused for a
different request.

## Conformance kit

The `./testing` subpath exports a runner-agnostic contract suite for adapters:

```ts
import { MemoryOutboxStore } from 'better-effect-mq-outbox'
import { outboxStoreContract } from 'better-effect-mq-outbox/testing'

const suite = outboxStoreContract({
  makeOutboxStore: (name) => MemoryOutboxStore.make(),
  clock: () => {
    let current = 0
    return {
      now: () => current,
      advance: (milliseconds: number) => {
        current += milliseconds
      }
    }
  }
})

for (const scenario of suite) {
  await scenario.run()
}
```

Each scenario creates an isolated store and covers append idempotency/conflicts,
claim ordering, leases/fencing, heartbeat/recovery, settlement and lost
responses, poison failures, list/counts, retry redrive, and named outbox
isolation. A test runner only needs to register `scenario.run`; the suite does
not use a database, publisher, timers, or Runtime. Transactional append
commit/rollback remains adapter-specific, and delivery remains at-least-once,
not exactly-once.
