import { Effect, Layer, Runtime } from 'better-effect'
import { ClockLive } from 'better-effect/standard-services'
import { Result } from 'better-result'
import { JobStore, JobContext, MemoryJobStore, Worker } from 'better-effect-mq'

import { SendEmail } from '../shared/jobs'

const store = MemoryJobStore.make()
const runtime = await Runtime.make(
  Layer.merge(Layer.succeed(JobStore, JobStore.of(store)), ClockLive)
)
const handler = Worker.handle(SendEmail, (payload) =>
  Effect.fn(async function* () {
    const context = yield* JobContext
    void context
    return Result.ok(`sent:${payload.recipient}`)
  })
)

try {
  const enqueued = await runtime.run(() =>
    Effect.gen(async function* () {
      const id = yield* SendEmail.enqueue({
        messageId: 'worker-message-1',
        recipient: 'ada@example.test'
      })
      return Result.ok(id)
    })
  )
  if (Result.isError(enqueued)) {
    throw enqueued.error
  }

  await Worker.use(
    runtime,
    {
      handlers: [handler],
      concurrency: 1,
      pollIntervalMs: 1
    },
    (worker) => worker.awaitIdle()
  )

  const completed = await store.getJob({ jobId: enqueued.value })
  if (Result.isError(completed) || completed.value?.state !== 'completed') {
    throw new Error('Worker did not complete the enqueued job')
  }
} finally {
  await runtime.dispose()
}
