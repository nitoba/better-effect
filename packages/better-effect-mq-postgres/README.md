# better-effect-mq-postgres

`better-effect-mq-postgres` makes PostgreSQL the durable storage backend for
[`better-effect-mq`](../better-effect-mq). It provides the `JobStore` for
enqueueing, claiming, and settling jobs safely across processes, along with
optional extensions for durable events, schedules, flows, and outbox records.

The package is designed for applications that need jobs to survive restarts,
multiple workers, and network failures without adding a separate broker.
PostgreSQL remains the source of truth; the `better-effect-mq` Worker handles
processing while your application remains responsible for its business logic.

## When to use

Use this adapter when you already operate PostgreSQL and need:

- durable jobs with enqueue, claim, lease, retry, cancellation, and inspection;
- multiple processes or replicas consuming the same queue;
- persistent schedules with idempotent ticks;
- a finite event feed for dashboards, operational auditing, or event-driven
  waits;
- flows with fan-out/fan-in and reconciliation; and
- an outbox for recording a publishing intent in the same transaction as the
  domain change.

It does not turn PostgreSQL into an exactly-once system. Delivery is
at-least-once: if a process performs an external effect and crashes before
persisting settlement, the job may be delivered again. Make external effects
idempotent by using the job ID or an idempotency key from your application.

## Installation

With Bun:

```bash
bun add better-effect-mq-postgres better-effect-mq better-effect better-result better-effect-mq-outbox pg
```

With npm:

```bash
npm install better-effect-mq-postgres better-effect-mq better-effect better-result better-effect-mq-outbox pg
```

`pg` is an optional peer. It is loaded only when you use a configuration with
`connectionString` (`layerFromConfig`, `PostgresClient.fromConfig`, etc.).
When you provide an existing pool, the adapter uses only the pool interface
and does not import `pg` itself.

## Quick start: pool and Layer

The recommended workflow is to run the migration as an explicit deployment
step, validate the schema at startup, and then provide the pool to the Runtime.
A Layer does not run migrations automatically.

```ts
import { Pool } from 'pg'
import { Runtime, ServiceRuntime } from 'better-effect'
import { JobName, JobStore, QueueName } from 'better-effect-mq'
import { PostgresJobStore, PostgresMigrator } from 'better-effect-mq-postgres'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

await PostgresMigrator.run(pool, { schema: 'public' })
await PostgresMigrator.validate(pool, { schema: 'public' })

const runtime = await Runtime.make(
  PostgresJobStore.layer({
    pool,
    namespace: 'billing'
  })
)

try {
  const enqueued = await runtime.run(async () => {
    const store = await ServiceRuntime.resolve(JobStore)
    return store.enqueue({
      job: {
        queue: QueueName.make('billing').unwrap(),
        name: JobName.make('send-invoice').unwrap(),
        version: 1
      },
      payload: { invoiceId: 'inv_123' },
      metadata: { source: 'billing-api' },
      runAt: Date.now(),
      attemptsMax: 3,
      now: Date.now()
    })
  })

  if (enqueued.isErr()) throw enqueued.error
  console.log(enqueued.value.job.id)
} finally {
  await runtime.dispose()
  await pool.end()
}
```

`layer({ pool })` uses a borrowed pool: the Runtime does not close it. Close
the pool in the component that created it, as in the example. To have the
adapter create and own the pool, use `layerFromConfig`:

```ts
const DurableLive = PostgresJobStore.layerFromConfig({
  connectionString: process.env.DATABASE_URL,
  namespace: 'billing'
})
const runtime = await Runtime.make(DurableLive)

// runtime.dispose() closes the pool created by the adapter.
```

The four forms follow the same pattern:

| Resource  | Pool supplied by the application | Pool created by the adapter                |
| --------- | -------------------------------- | ------------------------------------------ |
| Jobs      | `PostgresJobStore.layer`         | `PostgresJobStore.layerFromConfig`         |
| Events    | `PostgresJobEventStore.layer`    | `PostgresJobEventStore.layerFromConfig`    |
| Schedules | `PostgresJobScheduleStore.layer` | `PostgresJobScheduleStore.layerFromConfig` |
| Outbox    | `PostgresOutbox.layer`           | `PostgresOutbox.layerFromConfig`           |

The `layerFor` and `layerFromConfigFor` variants let you provide a named
token. `namespace` separates data for applications or environments that share
the same PostgreSQL instance; keep the same `pool`, `schema`, and `namespace`
when two Layers need to access the same store.

## Migrations and requirements

- PostgreSQL 12 or newer.
- A PostgreSQL schema that the application can read and update.
- The package version and schema must be upgraded together during deployment.

Run `PostgresMigrator.run(pool, { schema })` in a controlled deployment step
and keep `validateSchema: true` (the default) in production Layers. Validation
fails early when the database is incomplete, belongs to another component, or
has not yet been updated to the version expected by the adapter.

The migrator is forward-only, checks the integrity of what has already been
applied, and does not downgrade or remove data automatically. For an
application rollback, restore a compatible backup or run a reviewed manual
migration; do not expect startup to revert the database.

During a gradual deployment, first make changes compatible with the versions
currently running, then publish the code that uses them, and only afterward
remove what has become obsolete. In production environments, prefer separating
the migration step from replica startup and use adapter validation as a second
barrier.

## Composition: JobStore, JobEventStore, and Runtime

Jobs and events are Services in the same Runtime. Do not create a separate
Runtime to read events: doing so can produce different pools, scopes, and
configurations for the same namespace.

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
        retention: {
          count: 100_000,
          ageMs: 7 * 24 * 60 * 60 * 1_000
        }
      }),
      ClockLive
    )
  )
)

const runtime = await Runtime.make(DurableLive)
```

When both Layers use the same pool and namespace, `JobStore` mutations feed
`JobEventStore` consistently with the durable operation. The feed can be read
with `JobEvents.page`/`JobEvents.forEach` or used by `Job.awaitResult` with
`strategy: 'events'` and a `pollFallbackMs`. Polling fallback remains the
authoritative source when a wake signal is delayed or lost.

For named stores, use matching tokens in the same Runtime:

```ts
import { JobEventStore, JobStore } from 'better-effect-mq'
import { PostgresJobEventStore, PostgresJobStore } from 'better-effect-mq-postgres'

const Durable = JobStore.named('durable')
const DurableEvents = JobEventStore.for(Durable)

const DurableLive = Layer.merge(
  PostgresJobStore.layerFor(Durable, { pool, namespace: 'billing' }),
  PostgresJobEventStore.layerFor(DurableEvents, {
    pool,
    namespace: 'billing'
  })
)
```

If event persistence is mandatory for every writer in the namespace, explicitly
promote the store:

```ts
import { ServiceRuntime } from 'better-effect'
import { JobEventStore } from 'better-effect-mq'

const events = await runtime.run(() => ServiceRuntime.resolve(JobEventStore))
const activation = await events.activate({ mode: 'required', now: Date.now() })
if (activation.isErr()) throw activation.error
```

Do this only after every process in the rollout supports EventLog; otherwise,
an older version may continue writing jobs without the expected events.

## Schedules

`PostgresJobScheduleStore` persists schedules and their revisions alongside the
`JobStore`. Each tick checks the revision and the next expected time, creates
deterministic occurrences, and advances the schedule in one operation.
Repeating a tick after a lost response does not create the same occurrence
twice.

Provide both Layers with the same pool, schema, and namespace:

```ts
import { Layer, Runtime, ServiceRuntime } from 'better-effect'
import { JobScheduleStore, JobStore } from 'better-effect-mq'
import { PostgresJobScheduleStore, PostgresJobStore } from 'better-effect-mq-postgres'

const runtime = await Runtime.make(
  Layer.merge(
    PostgresJobStore.layer({ pool, namespace: 'billing' }),
    PostgresJobScheduleStore.layer({ pool, namespace: 'billing' })
  )
)

const schedules = await runtime.run(() => ServiceRuntime.resolve(JobScheduleStore))
```

The contract exposes `upsertSchedule`, `dueSchedules`, `tickSchedule`,
`pauseSchedule`, `resumeSchedule`, `getSchedule`, `listSchedules`, and
`removeSchedule`. Misfire and overlap decisions belong to the schedule; the
adapter persists the result and keeps job creation associated with the tick.

## Flows

Flows are optional. Use `PostgresFlowStore` when the application needs to
coordinate fan-out/fan-in, child reports, or cascade reconciliation. It is an
explicit store, not a Runtime Layer:

```ts
import { PostgresFlowStore } from 'better-effect-mq-postgres'

const flows = await PostgresFlowStore.make({
  pool,
  namespace: 'billing'
})

try {
  const snapshot = await flows.getFlow({ flowId })
  if (snapshot.isErr()) throw snapshot.error
  console.log(snapshot.value)
} finally {
  await flows.dispose()
}
```

Use `makeFromConfig` when the adapter should create and close the pool. Before
instantiating the flow store, apply the current migrations and keep validation
enabled. If the flow extension is not present, creation fails early; it does
not interpret an old schema as supporting flows.

Fan-out operations and reports are idempotent for replays of the same command.
Enqueueing or cancelling jobs in different stores remains an at-least-once
operation: there is no distributed transaction across two PostgreSQL
instances, two namespaces, or two adapters.

## Outbox

The outbox adapter provides a durable `OutboxStore` with claim, heartbeat,
publishing, retry, failure, release, stalled-lease recovery, listing, and
counting. Provide it to the same Runtime when an application publisher uses
the `PostgresOutbox` token:

```ts
import { Layer, Runtime, ServiceRuntime } from 'better-effect'
import { PostgresOutbox } from 'better-effect-mq-postgres'

const runtime = await Runtime.make(
  PostgresOutbox.layer({
    pool,
    namespace: 'billing'
  })
)

const outbox = await runtime.run(() => ServiceRuntime.resolve(PostgresOutbox))
```

To ensure that a domain change and a publishing intent are committed together,
prepare the record and call
`PostgresOutbox.appendIn(transaction, record, { namespace, schema })` inside
the transaction the application has already opened. `appendIn` does not begin,
commit, or roll back that transaction; the caller remains responsible for
commit, rollback, and releasing the client.

Use `PostgresOutbox.named('emails')` and `PostgresOutbox.layerFor(...)` when
you need isolated outboxes in the same Runtime. Later publishing is still
at-least-once; the consumer must accept replays and acknowledge the record only
after completing the external effect.

## Events, attempts, and observers

There are three complementary surfaces. Choose the one that matches the
operational question:

| Surface                                    | Use it for                                                       | Durability and limits                                                                 |
| ------------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `JobEventStore` (EventLog)                 | Ordered feed of safe facts, cursors, dashboards, and wakeups     | Durable, but with finite retention by `count`, `ageMs`, or both; cursors can expire   |
| `AttemptRecord` via `JobStore.getAttempts` | Detailed history of each delivery, retry, and job result/failure | Durable with the job; not a feed, not a cursor, and may contain sensitive data        |
| `JobObserver` local                        | Logs, metrics, tracing, and process/Worker signals               | Best-effort and process-local; callbacks are not persisted and do not alter execution |

By default, EventLog omits payloads, results, complete failures, and arbitrary
metadata. Do not use it as an infinite historical archive or as a replacement
for `AttemptRecord`. The observer does not replace either one: it may lose
events during a crash, shutdown, or callback failure.

When consuming pages, persist the cursor only after the handler finishes
successfully. If retention has already removed the cursor, the adapter returns
`JobEventCursorExpiredError`; choose an explicit policy, such as restarting
from the current tail, requesting a replay from another source, or failing
visibly.

`awaitEvents` is a wakeup hint. Use bounded polling as a fallback and do not
base processing correctness on any notification signal.

## Operational guarantees and limits

- **Persistence:** enqueue, claim, lease, settlement, retry, stalled-job
  recovery, and enabled extensions use PostgreSQL's transactional unit.
- **Concurrency:** leases and tokens prevent an old worker from settling a
  newer worker's delivery. They do not undo an external effect that has already
  run.
- **Delivery:** it is at-least-once. Crashes between the external effect and
  persisted settlement can cause redelivery.
- **Wakeups:** notifications speed up the worker, but are not the source of
  truth; the worker must continue querying durable state.
- **Retention:** EventLog is always bounded by the retention policy when you
  define `count`/`ageMs`; retention is not a backup or an archive.
- **External transactions:** `appendIn` participates in the caller's
  transaction, but the adapter does not coordinate transactions across
  databases, pools, namespaces, or services.
- **Transient failures:** temporary database conflicts may be reported as
  retryable; configure retries and backoff in the Worker or in the operation
  that calls the store.
- **Capacity:** pool size, connections, indexes, I/O, and queue size remain
  PostgreSQL limits. Size the pool and monitor latency before increasing worker
  concurrency.

## Production

Before directing traffic to the application:

1. Run `PostgresMigrator.run` with a controlled deployment identity.
2. Keep `validateSchema` at its default (`true`) in replica Layers.
3. Confirm that workers, schedules, events, and outbox use the same namespace
   when they should share state.
4. Set EventLog retention according to the consumption window, and keep a
   separate audit archive when unlimited history is required.
5. Configure heartbeat and lease durations so legitimate handlers have time to
   finish, and monitor redeliveries and stalled-job recovery.
6. Monitor queue depth and age, active jobs, failures, lost leases, stalled
   recovery, database latency, pool usage, event lag, and expired cursors.
7. Test replays, lost responses, worker restarts, and temporary database
   unavailability before the first rollout.

If the host owns the pool, use `layer`; if the Runtime should own the pool, use
`layerFromConfig` and let `runtime.dispose()` complete the lifecycle. Do not
close a borrowed pool while a Runtime or operation is using it.

## Troubleshooting

### The Layer fails to initialize because the schema is invalid

Run `PostgresMigrator.validate(pool, { schema })` with the same schema and
namespace used by the application. If it is not up to date, run
`PostgresMigrator.run` during deployment. Also verify that the application is
connecting to the correct database and that the user can read and modify the
schema.

### A flow does not start, but regular jobs work

Flows require the flow extension to be installed in the schema. Update the
database before creating `PostgresFlowStore`; do not disable validation to work
around the problem in production. If you do not need flows, use only
`PostgresJobStore`.

### The consumer receives `JobEventCursorExpiredError`

Retention removed the cursor. Restart from a recent tail or recover the facts
from a replay source maintained by your application. Increasing `count` or
`ageMs` helps slow consumers but does not create an infinite archive.

### Jobs appear to run twice

This is possible with the at-least-once model, especially when the process
crashes before settlement or loses its connection during confirmation. Use an
idempotency key for the external effect, inspect `AttemptRecord` with
`JobStore.getAttempts`, and check the Worker's lease and heartbeat.

### Events do not appear

Confirm that `PostgresJobStore.layer` and `PostgresJobEventStore.layer` use the
same pool, schema, and namespace and belong to the same Runtime. Check whether
retention removed the events and whether required activation is being attempted
before all writers have been updated. Keep polling fallback enabled for waits.

### The outbox has active or stalled records

Use `recoverStalled`, confirm that the publisher's clock is correct, and check
pool connectivity. `appendIn` only records the entry; the publisher still
needs to perform claim, heartbeat, and settlement. The external effect must be
idempotent because publication confirmation may also be repeated.

### The pool closes too early or never closes

An application-provided pool (`layer`) is borrowed and must be closed by the
host. A pool created by `layerFromConfig` belongs to the Runtime and is closed
during `runtime.dispose()`. Do not mix the two lifecycles or call `pool.end()`
while the Runtime is still active.

## More information

- [`better-effect-mq`](../better-effect-mq) — job contracts, Worker, schedules,
  events, and outbox.
- [Composition guide](../better-effect-mq/docs/composition.md) — shared rules
  for stores, events, Runtime, retention, and observability.
- [Composition example](../better-effect-mq/examples/composition/main.ts) — a
  Runtime with `JobStore` and `JobEventStore`.
