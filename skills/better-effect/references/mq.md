# Durable jobs, workers, schedules, and flows

Package: `better-effect-mq`. Reference:
[MQ README](https://github.com/nitoba/better-effect/blob/main/packages/better-effect-mq/README.md).
Storage comes from [adapter Layers](mq-storage-outbox.md), not a second queue API.

## Complete in-memory application

This local example validates a plain JSON payload and runs one Layer-owned
worker. MemoryJobStore is deliberately process-local, not durable storage.

```ts
import * as z from 'zod'
import { Effect, Layer, Runtime } from 'better-effect'
import { ClockLive } from 'better-effect/standard-services'
import { Result } from 'better-result'
import { Codec, JobStore, MemoryJobStore, Queue, Worker } from 'better-effect-mq'

const Notices = Queue.define('notices')
const FormatNotice = Notices.job('format-notice', {
  version: 1,
  payload: Codec.standardSchema({ schema: z.object({ message: z.string().min(1) }) }),
  result: Codec.string
})

const handler = Worker.handle(FormatNotice, (payload) =>
  Effect.fn(async function* () {
    return Result.ok(payload.message.toUpperCase())
  })
)
const NoticeWorker = Worker.service('@example/NoticeWorker')
const NoticeWorkerLive = NoticeWorker.layer(() => ({
  handlers: [handler] as const,
  concurrency: 1,
  pollIntervalMs: 10
}))
const AppLive = Layer.complete(Layer.merge(
  Layer.succeed(JobStore, JobStore.of(MemoryJobStore.make())),
  ClockLive,
  NoticeWorkerLive
))

await using runtime = await Runtime.make(AppLive)
const result = await runtime.run(Effect.fn(async function* () {
  yield* NoticeWorker
  const id = yield* FormatNotice.enqueue({ message: 'Hello' })
  const formatted = yield* FormatNotice.awaitResult(id)
  return Result.ok({ id, formatted })
}))
```

The explicit worker resolution starts its lazy provider before waiting for work.
For a server, warm the complete graph before readiness. Keep one Runtime for
HTTP requests, worker attempts, scheduler, and publisher when they belong to
one application; these integrations capture the existing executor.

## Job definitions and operations

`Queue.define(name).job(name, options)` creates immutable descriptors, not a
connection, registration side effect, or worker. Give each persisted contract
a version. Incompatible payload/result/failure changes need a deliberate
version/deployment strategy, not a silent schema replacement.

Use schema-backed payload/result/failure codecs at untrusted boundaries.
`Codec.json<T>()` is a JSON-safe escape hatch, not runtime shape validation.
A class or Date in the handler needs an explicit wire encoder; see
[Schema](schema.md). Keep enqueue input, decoded payload, and stored JSON
separate rather than decoding/transforming the same object twice.

| Job operation | Purpose |
| --- | --- |
| `enqueue` / `enqueueMany` | Submit one/batched codec inputs |
| `poll` / `awaitResult` | Observe a snapshot or terminal decoded outcome |
| `execute` | Enqueue and wait |
| `attempts` | Inspect the delivery ledger |
| `cancel`, `retry`, `promote` | Explicit per-job administration |
| `prepare` | Produce an immutable JSON-safe request for outbox; does not enqueue |

`Worker.handle(job, payload => Program)` retains typed payload, failure, and
Service requirements. Yield `JobContext` for ID, attempt/delivery metadata,
worker identity, and the current attempt context. Handler failures, codec
failures, timeouts, cancellations, and defects are distinct operational states.
Use explicit failure codecs/retry policies; do not serialize arbitrary errors.

Job defaults include attempts, backoff, and timeoutMs. MQ uses
`Retry.fixed({ delayMs, maxAttempts })` or
`Retry.exponential({ initialDelayMs, factor, maxDelayMs, maxAttempts })`.
Those names/budgets are **not** interchangeable with HTTP HttpRetry options.
A job's `retryable` policy and an application's idempotency key serve different
purposes. Retries may repeat external side effects even with lease fencing.

## Schedules

Schedules are durable declarations reconciled against a matching
JobScheduleStore. Continuing the FormatNotice example:

```ts
import { JobScheduler, JobSchedules } from 'better-effect-mq'

const NoticeSchedules = JobSchedules.define({
  group: 'notice-maintenance',
  schedules: [
    JobSchedules.schedule(FormatNotice, 'heartbeat', {
      everyMs: 60_000,
      payload: { message: 'Alive' }
    })
  ]
})
const NoticeScheduler = JobScheduler.service('@example/NoticeScheduler')
const NoticeSchedulerLive = NoticeScheduler.layer(() => ({
  registries: [NoticeSchedules] as const,
  startupReconcile: true,
  sweepIntervalMs: 1_000,
  batchSize: 100
}))
```

Compose its Layer with Clock, the associated JobStore, and JobScheduleStore;
adding a scheduler does not implicitly provide storage. Use
`yield* JobSchedules.reconcile(definition, options)` for explicit reconciliation.
Choose group-scoped removal and a rolling-deploy grace period deliberately.
Do not accidentally delete another group's schedules.

Cron is five-field and defaults to UTC. Explicit timezones have wall-clock/DST
semantics. The default misfire policy is run-once; default overlap is allow.
Select `overlap: 'skip'` when a previous occurrence should block the next one.
Do not substitute a process-local setInterval for persisted occurrence handling.
Source/type contract: [schedule guide](https://github.com/nitoba/better-effect/blob/main/packages/better-effect-mq/src/schedule/README.md)
and [scheduler type tests](https://github.com/nitoba/better-effect/blob/main/packages/better-effect-mq/tests/types/scheduler.types.ts).

## Flow, events, controls, and administration

`Flow.define(name, { parent, children, onChildFailure })` describes durable
parent/child work. `Flow.handle` supplies fanOut and collect Programs;
`Flow.children` ties child keys/payloads to their Job definitions. Register the
Flow handler through worker `flows` and provide the matching FlowStore as well
as JobStore. Choose `continue` for useful partial results or `fail` for a failed
child to fail the parent and trigger cancellation policy. Use the
[complete Flow example](https://github.com/nitoba/better-effect/blob/main/packages/better-effect-mq/README.md)
for the current results-reader terminal; do not assume it is an ordinary array.
A set of in-memory Promises is not a substitute for the persisted manifest.

JobEventStore is a bounded durable transition log; JobObserver is process-local
diagnostics; `job.attempts(id)` is a delivery ledger. They are complementary.
To await via events, provide a matching store and use
`{ strategy: 'events', eventStore: JobEventStore, pollFallbackMs }`.
Events are wake-up hints: terminal observation rereads authoritative Job state.
Do not promise infinite replay retention or replace checkpoints with a cursor.

`QueueControls` covers queue admission/concurrency/rate-control declarations;
`JobAdmin` covers administrative views/actions. `JobHealth`, `JobObserver`,
`makeJobDepthSampler`, and metric surfaces support diagnostics. Match the
installed adapter's declared capabilities instead of bypassing the contract
with direct SQL or assuming all optional control APIs behave identically.
For lower-level driver authoring, use the
[public driver contracts](https://github.com/nitoba/better-effect/blob/main/packages/better-effect-mq/src/index.ts).

With multiple stores, use named tokens and bind definitions to the intended
store according to the [composition guide](https://github.com/nitoba/better-effect/blob/main/packages/better-effect-mq/docs/composition.md).
Providing `layerFor(namedToken, ...)` alone does not retarget a Job still bound
to the default JobStore. Keep job, event, schedule, flow, and outbox namespaces
consistent where those features share durable state.

## Reliability checklist

Delivery is at least once. A lease prevents stale settlement, not repetition
of an external side effect. Use application idempotency keys, bounded retries,
and explicit timeout/cancellation handling. Quiesce supervisors before draining
attempts and releasing stores. Do not enqueue after a domain commit and call
that an atomic handoff: use a [transactional outbox](mq-storage-outbox.md).
