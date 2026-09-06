# better-effect-mq-outbox

Storage-neutral durable outbox foundations for `better-effect-mq`.

This package defines immutable `OutboxRecord` DTOs, outbox identity and failure
envelopes, a post-commit `OutboxStore` contract, explicit `OutboxRoutes`, a
Runtime-owned `OutboxPublisher`, and the in-memory reference store used for
lifecycle tests. Database adapters remain separate packages.

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
  OutboxPublisher,
  OutboxRoutes,
  OutboxStore,
  validatePreparedEnqueue
} from 'better-effect-mq-outbox'
import { JobStore } from 'better-effect-mq'
import { Layer, Runtime, Service } from 'better-effect'

class OutboxConfig extends Service<OutboxConfig>()('OutboxConfig') {
  readonly concurrency!: number
}

const ApplicationOutbox = OutboxStore.named('application')
const DurableJobStore = JobStore.named('jobs-postgres')
const Routes = OutboxRoutes.make({
  'jobs-postgres': DurableJobStore
})

const ApplicationPublisher = OutboxPublisher.service('@app/OutboxPublisher')
const ApplicationPublisherLive = ApplicationPublisher.layer(async function* () {
  const config = yield* OutboxConfig
  return {
    outboxes: [ApplicationOutbox] as const,
    routes: Routes,
    concurrency: config.concurrency,
    leaseDurationMs: 30_000,
    heartbeatIntervalMs: 10_000,
    pollIntervalMs: 1_000
  }
})

const app = Layer.complete(
  Layer.merge(
    OutboxConfig.layer, // the application owns this provider
    ApplicationOutboxLive,
    DurableJobStoreLive,
    ApplicationPublisherLive
  )
)
const runtime = await Runtime.make(app)
await runtime.warmup()

// append a PreparedEnqueue-backed record through the concrete adapter here.
// The publisher starts and stops with this Runtime; it does not capture one.
await runtime.dispose()
```

`OutboxRoutes.make` is the only routing table: every target names a concrete
`JobStore` Service token. Ordered entries are also accepted when runtime input
must be checked for duplicate targets. A missing route produces an
`OutboxRouteMissingError`, remains inspectable, and follows the configured
attempt budget rather than being discarded.

The publisher claims records, validates the persisted `PreparedEnqueue`, calls
the selected JobStore, and fences `markPublished` with the claim token. A
duplicate enqueue is success. Retryable failures use bounded exponential
backoff and `markRetry`; invalid, permanent, or exhausted records use
`markFailed`. Runtime quiesce stops new claims while admitted work continues
through heartbeat, enqueue, and settlement.

The contract is at-least-once, not exactly-once. A crash after enqueue and
before settlement can redeliver the record; deterministic Job IDs or
idempotency keys make that duplicate converge.

`OutboxId` deduplication is idempotent for the same canonical prepared
request and returns `OutboxConflictError` when the same ID is reused for a
different request.
