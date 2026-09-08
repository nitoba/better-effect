# Composition guide: stores, events, and runtimes

`better-effect-mq` keeps storage providers and application behavior separate:
`JobStore` owns durable jobs and detailed attempt records, while
`JobEventStore` is an optional, bounded event-log extension. Both are Services
provided to one `Runtime`; do not create a second Runtime just to read events.

The complete reference example is [`examples/composition/main.ts`](../examples/composition/main.ts).
It runs entirely in memory and exercises the same Layer shape used by the
database adapters:

```ts
import { Effect, Layer, Runtime } from 'better-effect'
import { ClockLive } from 'better-effect/standard-services'
import { JobEventStore, JobStore, MemoryJobEventStore, MemoryJobStore } from 'better-effect-mq'

const events = MemoryJobEventStore.make({
  retention: { count: 1_000, ageMs: 24 * 60 * 60 * 1_000 }
})
const store = MemoryJobStore.make({ eventStore: events })

const AppLive = Layer.complete(
  Layer.merge(
    Layer.succeed(JobStore, JobStore.of(store)),
    Layer.merge(Layer.succeed(JobEventStore, JobEventStore.of(events)), ClockLive)
  )
)

const runtime = await Runtime.make(AppLive)
```

Passing the same `events` instance to `MemoryJobStore.make({ eventStore })`
is what appends committed Memory transitions. Providing `JobEventStore` in the
Layer makes the reader available to `JobEvents.page`, `JobEvents.forEach`, and
event-driven `Job.awaitResult` calls. The production adapters provide the same
two tokens through their own Layer factories.

## PostgreSQL and Redis

Use a borrowed pool/client when its lifecycle belongs to the host. Use the
`layerFromConfig` forms when the adapter should create and own connections.
PostgreSQL requires matching `pool` and `namespace` values for both Layers:

```ts
import { Layer, Runtime } from 'better-effect'
import { ClockLive } from 'better-effect/standard-services'
import { PostgresJobEventStore, PostgresJobStore } from 'better-effect-mq-postgres'

const DurableLive = Layer.complete(
  Layer.merge(
    PostgresJobStore.layer({ pool, namespace: 'billing' }),
    Layer.merge(
      PostgresJobEventStore.layer({
        pool,
        namespace: 'billing',
        retention: { count: 100_000, ageMs: 7 * 24 * 60 * 60 * 1_000 }
      }),
      ClockLive
    )
  )
)

const runtime = await Runtime.make(DurableLive)
```

For Redis, `RedisJobStore.layerWithEvents` and
`RedisJobStore.layerWithEventsFromConfig` return both matching providers. The
`redis` client is optional; the config factory loads it lazily only when used:

```ts
import { Layer, Runtime } from 'better-effect'
import { ClockLive } from 'better-effect/standard-services'
import { RedisJobStore } from 'better-effect-mq-redis'

const DurableLive = Layer.complete(
  Layer.merge(
    RedisJobStore.layerWithEventsFromConfig(
      { url: process.env.REDIS_URL, namespace: 'orders' },
      { retention: { count: 100_000, ageMs: 7 * 24 * 60 * 60 * 1_000 } }
    ),
    ClockLive
  )
)

const runtime = await Runtime.make(DurableLive)
```

With an already-created compatible Redis client, replace the config factory
with `RedisJobStore.layerWithEvents({ client, namespace: 'orders' }, options)`.
For PostgreSQL, use `PostgresJobStore.layerFromConfig` and
`PostgresJobEventStore.layerFromConfig` together when the adapter owns the
connection; both adapters close only resources they own.

Named stores use matching tokens rather than a second Runtime:

```ts
const Durable = JobStore.named('durable')
const DurableEvents = JobEventStore.for(Durable)

const DurableLive = Layer.merge(
  PostgresJobStore.layerFor(Durable, { pool, namespace: 'billing' }),
  PostgresJobEventStore.layerFor(DurableEvents, { pool, namespace: 'billing' })
)
```

## Optional versus required event persistence

Event persistence starts `inactive`. The first event-capable writer establishes
`optional`; it must not silently establish `required`. Promote a namespace only
after every writer in the rollout can append the matching event extension:

```ts
import { Effect } from 'better-effect'
import { JobEventStore } from 'better-effect-mq'
import { Result } from 'better-result'

const RequireEvents = Effect.gen(async function* () {
  const events = yield* JobEventStore
  const activation = yield* events.activate({
    mode: 'required',
    now: Date.now()
  })
  return Result.ok(activation)
})
```

In `optional` mode, a writer without event support may still perform the base
JobStore mutation. In `required` mode, the JobStore rejects that mutation
before changing state. Required activation is monotonic: it is idempotent and
cannot be downgraded. The adapter's `eventWriter` readiness check is the
deployment hook for rolling upgrades.

## Waiting for a result: events with a poll fallback

`Job.awaitResult` owns the race-safe ordering: it reads an event-store tail,
checks the Job record, reads matching terminal events, and checks the record
again before waiting. Use the matching event token for event-driven waiting:

```ts
const result = Effect.gen(async function* () {
  const jobId = yield* SendEmail.enqueue({
    messageId: 'message-1',
    recipient: 'ada@example.test'
  })

  return Result.ok(
    yield* SendEmail.awaitResult(jobId, {
      strategy: 'events',
      eventStore: JobEventStore,
      pollFallbackMs: 5_000
    })
  )
})
```

The fallback is bounded polling, not a second subscriber or Runtime. It wins
when a wake hint is lost or delayed; an event-reader failure degrades to
polling, and an expired hint cursor is rebased from a fresh tail. Use
`strategy: 'polling'` when event persistence is intentionally not installed.
Aborting the wait never cancels the persisted Job.

For a continuous reader, `JobEvents.forEach` uses `awaitEvents` as a wake hint
and the configured bounded polling interval as its fallback. The caller owns
the cursor: persist it only after the handler succeeds. Restarting from the
last persisted cursor therefore provides at-least-once delivery. External
side effects must be idempotent because a worker can act before its settlement
or acknowledgement is durably committed.

## Cursors, retention, and the three observability surfaces

Pages use opaque, exclusive cursors. `nextCursor` is the last event examined,
including filtered-out events, so a filtered consumer can resume without
overlap. Retention is bounded by `count`, `ageMs`, or both. When a consumer's
cursor has been removed, adapters return `JobEventCursorExpiredError`; the
consumer must choose an explicit policy, usually refresh from a current tail
or fail closed and request a replay from another source. There is no infinite
archive built into EventLog, and a cursor cannot be used as an archival
guarantee.

These surfaces deliberately have different contracts and none replaces the
others:

| Surface                  | Durable purpose                                                  | Payload/result/failure behavior                                                                                                    | Loss and retention                                                                   |
| ------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `JobEventStore` EventLog | Append-only committed transition facts, cursors, wake/read feeds | Safe event fields and bounded attributes only; payloads, results, complete failures, and arbitrary metadata are omitted by default | Durable but bounded; at-least-once consumers own checkpoints; cursors can expire     |
| `AttemptRecord`          | Detailed per-delivery ledger for Job inspection and debugging    | The Job definition controls typed result/failure decoding; treat these fields as sensitive                                         | Durable with the JobStore's records; not an append-only feed and not a cursor source |
| `JobObserver`            | Process-local metrics/logging/tracing hooks                      | Storage-neutral event snapshots; observers are best-effort and must not change MQ behavior                                         | Not durable; callbacks can be dropped on crash, shutdown, or observer failure        |

Use `JobEventStore` for resumable feeds and transition notifications, query
`Job.attempts(jobId)` for detailed delivery history, and compose observers for
local telemetry. Do not copy sensitive payloads/results/failure bodies into
event attributes. `JobEventStore` is intentionally not a replacement for
`AttemptRecord`, and an observer is not a replacement for either durable
surface.

## Dashboard and SSE boundaries

The dashboard composes the same `JobEventStore` into its optional
`DashboardEventFeed`. A durable feed emits resumable `job-event` SSE records
whose `id` is the event cursor; heartbeat frames use `event: heartbeat` and do
not consume a durable cursor. The `heartbeatMs` query parameter is bounded to
300 seconds. When retention expires the requested cursor, the stream emits a
`cursor-expired` frame and the client must refresh its cursor policy. Without
the extension, the dashboard keeps list/detail/action routes available while
event and SSE endpoints report `events_unavailable`.

See [Durable Job Events v1](./protocol/durable-events-v1.md), [Cursors and
ordering v1](./protocol/cursors-and-ordering-v1.md), and the [dashboard
README](../../../apps/mq-dashboard/README.md) for the normative protocol and
HTTP behavior.
