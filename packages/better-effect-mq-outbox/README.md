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
