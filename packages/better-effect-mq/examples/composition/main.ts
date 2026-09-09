import { Effect, Layer, Runtime } from 'better-effect'
import { ClockLive } from 'better-effect/standard-services'
import { Result } from 'better-result'
import {
  JobEventStore,
  JobStore,
  MemoryJobEventStore,
  MemoryJobStore,
  Worker
} from 'better-effect-mq'

import { SendEmail } from '../shared/jobs'

const events = MemoryJobEventStore.make({
  retention: { count: 1_000, ageMs: 24 * 60 * 60 * 1_000 }
})
const store = MemoryJobStore.make({ eventStore: events })

const AppWorker = Worker.service('@examples/CompositionWorker')
const handler = Worker.handle(SendEmail, (payload) =>
  // oxlint-disable-next-line require-yield -- this handler has no contextual requirements.
  Effect.fn(async function* () {
    return Result.ok(`sent:${payload.recipient}`)
  })
)
const AppWorkerLive = AppWorker.layer(() => ({
  handlers: [handler] as const,
  concurrency: 1,
  pollIntervalMs: 1
}))

const AppLive = Layer.complete(
  Layer.merge(
    Layer.succeed(JobStore, JobStore.of(store)),
    Layer.merge(
      Layer.succeed(JobEventStore, JobEventStore.of(events)),
      Layer.merge(ClockLive, AppWorkerLive)
    )
  )
)

const runtime = await Runtime.make(AppLive)

try {
  const started = await runtime.run(() =>
    Effect.gen(async function* () {
      return Result.ok(yield* AppWorker)
    })
  )
  if (Result.isError(started)) throw started.error

  const completed = await runtime.run(() =>
    Effect.gen(async function* () {
      const jobId = yield* SendEmail.enqueue({
        messageId: 'composition-message-1',
        recipient: 'ada@example.test'
      })
      const result = yield* SendEmail.awaitResult(jobId, {
        strategy: 'events',
        eventStore: JobEventStore,
        pollFallbackMs: 50
      })
      return Result.ok({ jobId, result })
    })
  )
  if (Result.isError(completed)) throw completed.error

  await started.value.awaitIdle({ timeoutMs: 2_000 })

  const tail = await events.tailCursor()
  if (Result.isError(tail)) throw tail.error
  const page = await events.read({ after: tail.value, limit: 10 })
  if (Result.isError(page) || page.value.events.length !== 0) {
    throw new Error('the example expected the tail cursor to be exclusive')
  }
} finally {
  await runtime.dispose()
}
