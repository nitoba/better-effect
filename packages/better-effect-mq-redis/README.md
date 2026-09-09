# better-effect-mq-redis

Redis and Valkey storage for [`better-effect-mq`](../better-effect-mq). The
adapter provides the queue state needed by `JobStore`, optional durable job
events, schedules, and flow persistence while keeping the application-facing
API in `better-effect-mq`.

## What this adapter provides

- `RedisJobStore` layers for the default or a named `JobStore`.
- `RedisJobEventStore` and the combined `RedisJobStore.layerWithEvents*`
  layers for bounded, resumable transition events.
- `RedisJobScheduleStore` layers for durable schedules.
- `RedisOutboxStore` layers and `RedisOutbox.transaction` for durable
  Redis-native outbox writes.
- `RedisClient` for an initialized namespaced command/subscriber pair, and
  `RedisFlowStore.make` for the lower-level flow surface.
- Standalone and compatible Redis Cluster client integration through the
  structural client types exported by this package.

The adapter is a storage provider, not a second job API. Define jobs and run
workers with `better-effect-mq`, then provide the Redis layers to one
`better-effect` runtime.

## Is Redis or Valkey a good fit?

Choose this adapter when you need low-latency enqueue/claim/settlement, several
worker processes, leases and retries, or a durable event feed backed by an
existing Redis or Valkey service. It is also a good fit when each application
domain can be isolated with a namespace and most reads are by job, queue, or
the event cursor.

Choose a relational adapter when the primary workload is join-heavy reporting,
complex metadata search, cross-domain transactions, or long-term archival.
The Redis event feed is intentionally bounded, and event records do not contain
job payloads, results, complete failure bodies, or arbitrary metadata.

Valkey is supported when the selected server and client implement the Redis
commands and behavior used by the adapter. Test the exact server, client, TLS,
replication, and failover combination that will run in production.

## Installation

```sh
bun add better-effect-mq-redis better-effect-mq better-effect better-result better-effect-schema zod redis
```

The `redis` peer is optional. It is loaded only by the `*FromConfig` factories,
which create connections through the official `redis` package. If the
application already owns a compatible client, use the client-based factories
and pass that client directly; the adapter does not need to load `redis`.

## Quick start: a durable queue and worker

For a normal application, let the Layer create and close the command and
subscriber connections. The adapter only supplies storage; jobs and workers
remain the `better-effect-mq` application contract:

```ts
import * as z from 'zod'
import { Effect, Layer, Runtime } from 'better-effect'
import { ClockLive } from 'better-effect/standard-services'
import { Result } from 'better-result'
import { Codec, JobEncodeFailure, JobEventStore, Queue, Worker } from 'better-effect-mq'
import { Schema as CoreSchema } from 'better-effect-schema'
import { Schema } from 'better-effect-schema/zod'
import { RedisJobStore } from 'better-effect-mq-redis'

const DateFromISOString = z.codec(z.iso.datetime(), z.date(), {
  decode: (value) => new Date(value),
  encode: (value) => value.toISOString()
})
class SendEmailPayload extends Schema.Class<SendEmailPayload>('app/SendEmailPayload')({
  recipient: z.email(),
  requestedAt: DateFromISOString
}) {}
const SendEmailResult = z.object({ status: z.literal('sent'), recipient: z.email() })
const sendEmailPayloadCodec = Codec.standardSchema({
  schema: SendEmailPayload,
  encode: (value) =>
    CoreSchema.encode(SendEmailPayload, value).mapError(
      (error) => new JobEncodeFailure({ message: error.message, code: 'schema-encode' })
    )
})
const sendEmailResultCodec = Codec.standardSchema({ schema: SendEmailResult })

const Emails = Queue.define('emails')
const SendEmail = Emails.job('send-email', {
  version: 1,
  payload: sendEmailPayloadCodec,
  result: sendEmailResultCodec
})

const EmailWorker = Worker.service('@app/EmailWorker')
const emailHandler = Worker.handle(SendEmail, (payload) =>
  Effect.fn(async function* () {
    console.log(`sending to ${payload.recipient} at ${payload.requestedAt.toISOString()}`)
    return Result.ok({ status: 'sent' as const, recipient: payload.recipient })
  })
)
const EmailWorkerLive = EmailWorker.layer(() => ({
  handlers: [emailHandler] as const,
  concurrency: 2,
  pollIntervalMs: 100
}))

const redisUrl = process.env.REDIS_URL
if (redisUrl === undefined) throw new Error('REDIS_URL is required')

const DurableLive = Layer.complete(
  Layer.merge(
    RedisJobStore.layerWithEventsFromConfig(
      {
        url: redisUrl,
        namespace: 'orders'
      },
      {
        retention: {
          count: 100_000,
          ageMs: 7 * 24 * 60 * 60 * 1_000
        }
      }
    ),
    Layer.merge(ClockLive, EmailWorkerLive)
  )
)

const runtime = await Runtime.make(DurableLive)

try {
  const started = await runtime.run(() =>
    Effect.gen(async function* () {
      return Result.ok(yield* EmailWorker)
    })
  )
  if (Result.isError(started)) throw started.error

  const completed = await runtime.run(() =>
    Effect.gen(async function* () {
      const payload = Schema.decodeUnknown(SendEmailPayload, {
        recipient: 'ada@example.test',
        requestedAt: '2026-09-09T10:00:00.000Z'
      })
      if (Result.isError(payload)) throw payload.error
      const jobId = yield* SendEmail.enqueue(payload.value)
      const result = yield* SendEmail.awaitResult(jobId, {
        strategy: 'events',
        eventStore: JobEventStore,
        pollFallbackMs: 5_000
      })
      return Result.ok({ jobId, result })
    })
  )
  if (Result.isError(completed)) throw completed.error

  console.log(completed.value)
  await started.value.awaitIdle()
} finally {
  await runtime.dispose()
}
```

`layerWithEventsFromConfig` provides the matching `JobStore` and
`JobEventStore` services. Use `RedisJobStore.layerFromConfig` when event
persistence is not needed. The Layer initializes the client before exposing the
services and releases its resources when the runtime is disposed.

The preconfigured Zod `better-effect-schema` facade uses the Zod 4 provider for boundary
validation, `CoreSchema.encode` projects the decoded `SendEmailPayload` class to
JSON, and `Codec.standardSchema` adapts that contract to durable Job payloads
and results. Redis supplies persistence and wake-ups; it does not replace the
core Job or Worker APIs. The Outbox and Flow journeys below use the same
schema-first payload boundary. Result or failure values that are already plain
JSON may use a concise `Codec.standardSchema` shape; the payload boundaries in
both journeys remain schema-first.

## Redis-native outbox transactions

When the domain write is also a Redis write, use `RedisOutbox.transaction`.
The adapter creates the native `MULTI` context, invokes the callback, appends
the prepared outbox record, and executes or discards the transaction for you:

```ts
import * as z from 'zod'
import { Effect, Layer, Runtime } from 'better-effect'
import { Codec, JobEncodeFailure, Queue } from 'better-effect-mq'
import { Schema as CoreSchema } from 'better-effect-schema'
import { Schema } from 'better-effect-schema/zod'
import { Result } from 'better-result'
import { OutboxId, makeOutboxRecord } from 'better-effect-mq-outbox'
import { RedisClient, RedisJobStore, RedisOutbox, RedisOutboxStore } from 'better-effect-mq-redis'

class OrderEmailPayload extends Schema.Class<OrderEmailPayload>('app/OrderEmailPayload')({
  orderId: z.string()
}) {}
const orderEmailPayloadCodec = Codec.standardSchema({
  schema: OrderEmailPayload,
  encode: (value) =>
    CoreSchema.encode(OrderEmailPayload, value).mapError(
      (error) => new JobEncodeFailure({ message: error.message, code: 'schema-encode' })
    )
})

const Emails = Queue.define('emails')
const SendEmail = Emails.job('send-email', {
  version: 1,
  payload: orderEmailPayloadCodec,
  result: Codec.standardSchema({ schema: z.string() })
})

const redisUrl = process.env.REDIS_URL
if (redisUrl === undefined) throw new Error('REDIS_URL is required')
const redisConfig = { url: redisUrl, namespace: 'orders' }
const AppLive = Layer.complete(
  Layer.merge(
    RedisJobStore.layerFromConfig(redisConfig),
    Layer.merge(
      RedisOutboxStore.layerFromConfig(redisConfig),
      RedisClient.layerFromConfig(redisConfig)
    )
  )
)
const runtime = await Runtime.make(AppLive)

try {
  const prepared = await runtime.run(() =>
    Effect.gen(async function* () {
      const payload = Schema.decodeUnknown(OrderEmailPayload, { orderId: 'order-123' })
      if (Result.isError(payload)) throw payload.error
      return Result.ok(yield* SendEmail.prepare(payload.value, { jobId: 'send-email:order-123' }))
    })
  )
  if (Result.isError(prepared)) throw prepared.error

  const record = makeOutboxRecord({
    id: OutboxId.make('outbox:order-123').unwrap(),
    target: 'emails',
    request: prepared.value,
    attemptsMax: 5
  })
  if (Result.isError(record)) throw record.error

  const committed = await runtime.run(() =>
    Effect.gen(async function* () {
      const redis = yield* RedisClient
      const value = yield* Result.await(
        RedisOutbox.transaction(redis, record.value, (transaction) => {
          transaction.sendCommand([
            'HSET',
            `${redis.layout.base}:orders`,
            'order-123:status',
            'created'
          ])
          return Result.ok('committed')
        })
      )
      return Result.ok(value)
    })
  )
  if (Result.isError(committed)) throw committed.error
} finally {
  await runtime.dispose()
}
```

`RedisOutboxStore.layerFromConfig` provides the `OutboxStore` used by an
`OutboxPublisher`; compose the publisher and your canonical `Worker.layer`
with `AppLive` in a full application. Prepare the job before the transaction so
the callback only persists JSON-safe data. The payload uses the same
schema-first boundary shown in the example (the preconfigured Zod `Schema`,
`Schema.Class`, and `CoreSchema.encode`); concise result/failure codecs are suitable
for plain-JSON outcomes. A callback `Result.err`, thrown or rejected callback,
append conflict, or `EXEC` failure is returned as a typed failure, and queued
commands are discarded when they have not been executed.

This boundary is atomic only for Redis-native writes in the same Redis
namespace. Redis cannot include a PostgreSQL, MySQL, SQLite, MongoDB, or other
database write in its `MULTI/EXEC`; do not describe a database write followed
by this helper as cross-database atomic. Use the transaction helper from the
database adapter that owns the domain write, or make the handoff explicitly
eventual. Redis transactions also do not roll back commands that have already
run when a later command reports an error, so use deterministic IDs and
idempotent Redis writes when retrying an uncertain result.

After the Redis transaction commits, the Runtime-owned publisher and Worker
deliver the same prepared request. Route to the `JobStore` Service token (not
the store instance), and keep the Worker handler from the normal queue example:

```ts
import { Layer, Runtime } from 'better-effect'
import { JobStore } from 'better-effect-mq'
import { OutboxPublisher, OutboxRoutes } from 'better-effect-mq-outbox'
import { RedisJobStore, RedisOutboxStore } from 'better-effect-mq-redis'

const Routes = OutboxRoutes.make({ emails: JobStore })
const Publisher = OutboxPublisher.service('@app/EmailOutboxPublisher')
const PublisherLive = Publisher.layer(() => ({
  outboxes: [OutboxStore] as const,
  routes: Routes,
  concurrency: 2,
  pollIntervalMs: 500
}))
const ApplicationLive = Layer.complete(
  Layer.merge(
    RedisJobStore.layerFromConfig({ url: redisUrl, namespace: 'orders' }),
    Layer.merge(
      RedisOutboxStore.layerFromConfig({ url: redisUrl, namespace: 'orders' }),
      Layer.merge(EmailWorkerLive, PublisherLive)
    )
  )
)
const applicationRuntime = await Runtime.make(ApplicationLive)
const completed = await applicationRuntime.run(() => SendEmail.awaitResult('send-email:order-123'))
```

The publisher claims the committed record, enqueues it in `JobStore`, and only
then settles the outbox row. A crash between enqueue and settlement can repeat
the enqueue; the deterministic Job ID and the handler's downstream idempotency
key make that replay converge. It is still at-least-once, not exactly-once.

### Advanced: native client integrations

`RedisTransaction` and `RedisCommandClient.multi()` remain available for
adapter integrations that already own the native client. Application code should use
`RedisOutbox.transaction` so transaction setup, append ordering, and cleanup
stay adapter-owned.

## Using an existing client

When connection pools, authentication, or lifecycle are managed by the host,
pass a command client instead. Keep the same `Queue`/`Job` and Worker
definitions from the Quick Start; only the storage Layer changes:

```ts
import { Layer, Runtime } from 'better-effect'
import { ClockLive } from 'better-effect/standard-services'

const DurableLive = RedisJobStore.layerWithEvents(
  {
    client,
    namespace: 'orders',
    prefix: 'better-effect-mq'
  },
  { retention: { count: 100_000 } }
)

const runtime = await Runtime.make(
  Layer.complete(Layer.merge(DurableLive, Layer.merge(ClockLive, EmailWorkerLive)))
)
try {
  // Enqueue and await SendEmail jobs with runtime.run(...), as in the Quick Start.
} finally {
  await runtime.dispose()
}
```

The client-based forms are `RedisClient.layer`,
`RedisJobStore.layer`, `RedisJobStore.layerWithEvents`,
`RedisJobEventStore.layer`, and the corresponding schedule layers. They borrow
the supplied command client. If no subscriber is supplied, the adapter calls
`client.duplicate()` and owns the duplicate; an explicitly supplied subscriber
is borrowed too. Borrowed clients remain the caller's responsibility during
runtime shutdown.

For direct client ownership, initialize the client before constructing the
application's storage Layer. The Layer borrows these clients, while the
application-owned `RedisClient` is disposed after the Runtime:

```ts
import { Layer, Runtime } from 'better-effect'
import { ClockLive } from 'better-effect/standard-services'
import { RedisClient, RedisJobStore } from 'better-effect-mq-redis'

const redis = await RedisClient.fromConfig({
  url: process.env.REDIS_URL,
  namespace: 'orders'
})

await redis.initialize()
const DurableLive = Layer.complete(
  Layer.merge(
    RedisJobStore.layerWithEvents({
      client: redis.client,
      subscriber: redis.subscriber,
      namespace: 'orders'
    }),
    Layer.merge(ClockLive, EmailWorkerLive)
  )
)
const runtime = await Runtime.make(DurableLive)
try {
  // Enqueue and await SendEmail jobs with runtime.run(...).
} finally {
  await runtime.dispose()
  await redis.dispose()
}
```

`RedisClient.fromConfig` owns both connections and closes them at most once.
`RedisClient.fromClients` borrows the command client and follows the ownership
rules above. `RedisClient.layerFromConfig` and `RedisClient.layer` expose the
same lifecycle through a Layer.

## Composing jobs, events, schedules, and flows

Use one runtime for the job store and its event reader. The combined factory is
the safest way to ensure that job transitions append to the same event store.
Inside an Effect program, yield the core Services rather than resolving them
through a separate resolver:

```ts
import { Effect } from 'better-effect'
import { JobEventStore, JobStore } from 'better-effect-mq'
import { Result } from 'better-result'

const useStores = Effect.gen(async function* () {
  const jobs = yield* JobStore
  const events = yield* JobEventStore
  return Result.ok({ jobs, events })
})

const stores = await runtime.run(() => useStores)
if (Result.isError(stores)) throw stores.error
```

`RedisJobEventStore.layerFromConfig`
is useful when an event reader is installed separately; it does not make an
unrelated `RedisJobStore.layerFromConfig` append events. Use the combined
factory when the job transitions themselves must be recorded.

The same event options can be passed to `RedisJobScheduleStore.layer*` and to
`RedisFlowStore.make(redis, options)`. For multiple stores, use
`JobStore.named(...)`, `JobEventStore.for(...)`, and the adapter's `layerFor` or
`layerWithEventsFromConfigFor` factories so each store has an explicit token and
namespace.

## Durable Redis flows

A Flow is a parent Job that creates typed child Jobs and collects their terminal
results. Start with the complete [order-fulfillment Flow walkthrough](../better-effect-mq/README.md#flow-coordinate-a-parent-execution):
its parent fans out to one inventory child per line and a payment child, then
`collect` returns reservation, payment, and failure information. The
provider-backed Zod 4 classes and `CoreSchema.encode` in that example are the
recommended schema-first boundary; Redis changes only durable storage.

Create the Redis flow provider and compose it with the same Worker that
registers the canonical flow route and child handlers:

```ts
import { Layer } from 'better-effect'
import { FlowStore } from 'better-effect-mq'
import { RedisClient, RedisFlowStore, RedisJobStore } from 'better-effect-mq-redis'

const redisUrl = process.env.REDIS_URL
if (redisUrl === undefined) throw new Error('REDIS_URL is required')
const redis = await RedisClient.fromConfig({ url: redisUrl, namespace: 'orders' })
await redis.initialize()
const flowStore = RedisFlowStore.make(redis)
const ApplicationLive = Layer.complete(
  Layer.merge(
    RedisJobStore.layer({
      client: redis.client,
      subscriber: redis.subscriber,
      namespace: 'orders'
    }),
    Layer.succeed(FlowStore, FlowStore.of(flowStore))
  )
)
```

The JobStore Layer borrows the initialized clients. The surrounding application
owns that `RedisClient`, so it disposes the Runtime first and the client second.
Child enqueue and relay are at least once; stable child keys and idempotent
handlers make recovery after a crash safe. For a named JobStore, provide
`FlowStore.for(namedStore)` and the matching `RedisFlowStore` instance under
that associated token.

## Configuration and connection ownership

Both configuration shapes are intentionally small:

- `RedisJobStoreConnectionConfig`: `url`, optional driver `clientOptions`,
  `namespace`, `prefix`, `validateLayout`, and optional `eventWriter`.
- `RedisJobStoreConfig`: an existing `client`, optional `subscriber`, and the
  same namespace, prefix, validation, and event-writer settings.

`namespace` defaults to `default` and `prefix` defaults to
`better-effect-mq`. Use explicit values in production so environments and
applications cannot accidentally share data. Keep the same namespace and
prefix for the JobStore and its event/schedule layers when they are intended to
operate together.

The config-based factories create and own both connections. The client-based
factories never close a caller-owned command or subscriber. A Runtime should
usually own one set of Layers for the lifetime of the process; do not create a
new Redis client for every job.

### Redis Cluster

The adapter can use a compatible cluster client through `fromClients` or the
client-based Layer factories. The `*FromConfig` path creates a standalone
client with `redis.createClient`; it is not a cluster-client constructor. For a
cluster deployment, create the cluster client with the driver, verify that its
duplicate/subscriber connection behaves as required, and pass it to the
adapter.

One namespace is kept together as an atomic unit on the cluster. A single
queue or namespace therefore does not spread its work across every shard. Use
separate namespaces for independently scalable domains, and do not assume that
adding cluster shards increases the throughput of one namespace linearly.

## Durable events: retention and cursors

Event persistence is opt-in through `RedisJobStore.layerWithEvents*` or
`RedisJobEventStore.layer*`. Configure a bounded stream with `retention.count`,
`retention.ageMs`, or both; each value must be a positive safe integer. Treat
the event feed as an operational history, not as an archive of job data.

`JobEventStore.read` uses opaque cursors scoped to the configured namespace.
The `after` cursor is exclusive. A page's `nextCursor` advances past every
event examined, including events removed by a filter, so persist it only after
the page has been handled successfully. Consumers should be prepared for
at-least-once processing after a crash.

Retention can remove a cursor. In that case the adapter returns
`JobEventCursorExpiredError`; choose an explicit recovery policy, such as
starting from `tailCursor()` and reconciling from the JobStore, or replaying
from another archive. There is no infinite event history in this adapter.

For rolling deployments, event activation can remain optional while all writers
are upgraded. Call `JobEventStore.activate({ mode: 'required' })` only after
every writer can append events; required activation is monotonic and rejects a
writer that cannot append before it changes job state.

## Reconnect and wake behavior

Workers and event readers use Redis notifications as a wake hint, not as the
source of truth:

- Job wake waits re-check the persisted wake state.
- Event waits check the stream and then keep a bounded polling fallback.
- A lost, duplicated, or malformed notification can delay a wake, but it does
  not lose a persisted job transition.
- Owned subscriber connections are reconnected with bounded backoff. A
  borrowed subscriber is not reconnected or closed by the adapter; its owner
  must maintain that connection.

Always pass an `AbortSignal` to long waits and treat a wake as a reason to read
again, not as proof that a particular job is available. If a notification
channel is unavailable, normal reads and bounded polling remain the recovery
path.

## Production operation

- Use a dedicated namespace per environment and application domain. Keep the
  prefix stable for the lifetime of that data.
- Enable and test Redis/Valkey persistence, replication, failover, backups, and
  restore procedures. The adapter cannot recover data that the server evicts or
  permanently loses.
- Do not use an eviction policy that can discard queued jobs or event history.
  Monitor memory, queue depth, command latency, connection errors, and event
  retention.
- Test the exact Redis/Valkey version, client version, TLS settings, and
  cluster/failover behavior before production rollout.
- Keep `validateLayout` enabled (the default) unless deployment tooling already
  provides an equivalent consistency check. Roll out all writers for a
  namespace deliberately and use the same namespace/prefix configuration.
- Size event retention separately from job retention. A high-volume event feed
  can consume substantial memory even when completed jobs are removed.

## Guarantees and limits

| Area          | What to rely on                                                                                        | What not to assume                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Job lifecycle | Leases, retries, settlement, cancellation, and stalled-job recovery are persisted by the JobStore.     | Exactly-once execution; a crash can cause a job to run again.                  |
| Transitions   | A supported transition is applied as one Redis-side state change.                                      | A transaction spanning multiple namespaces or unrelated Redis data.            |
| Events        | With a combined event Layer, supported job transitions and their event records are committed together. | An unbounded archive, payload/result storage, or arbitrary metadata index.     |
| Delivery      | Event and wake consumers can resume from an opaque cursor and should use at-least-once handling.       | A cursor that survives configured retention forever.                           |
| Queries       | Job and queue reads plus bounded event filtering.                                                      | Join-heavy reporting or fast secondary-index searches over arbitrary metadata. |
| Availability  | Connection failures are surfaced as operation failures, and wake paths recover by reading again.       | Automatic recovery from every server, network, or failover policy.             |

## Troubleshooting and implementers

- `RedisConfigurationError`: check that the command client exposes
  `sendCommand()` and `duplicate()`, and that the subscriber exposes
  `subscribe()`.
- `RedisConnectionError`: inspect both command and subscriber connectivity,
  credentials, TLS, and shutdown ownership. Config factories clean up partial
  setup when connection creation fails.
- `RedisLayoutMismatchError`: the namespace/prefix already contains data that
  does not match this adapter configuration. Use a new namespace for an
  isolated deployment or coordinate the migration; disable validation only
  when an external process owns that decision.
- `JobEventCursorExpiredError`: retention removed the requested cursor. Rebase
  from a current cursor or recover from another source.
- Cluster routing failures: use a cluster-aware client with the client-based
  factories and verify that command and subscriber connections are distinct.

Custom integrations should implement the exported `RedisCommandClient` and
`RedisSubscriberClient` shapes and use the public exports from the package
entrypoint.

## Development

From `packages/better-effect-mq-redis`:

```sh
bun run check
```

Redis integration tests run only when `REDIS_URL` is explicitly configured;
unit, type, packaging, and consumer checks do not require a live Redis server.

## Plain JSON escape hatch

For a trusted JSON-safe payload, the core `Codec.json<T>()` codec remains
available:

```ts
const AuditJob = Queue.define('audit').job('record', {
  version: 1,
  payload: Codec.json<{ readonly event: string }>()
})
```

Use a Zod 4 schema through `better-effect-schema/zod` when the Job should
validate and decode untrusted input at its boundary.
