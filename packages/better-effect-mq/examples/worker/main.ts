import { Effect, Layer, Runtime } from 'better-effect'
import { ClockLive } from 'better-effect/standard-services'
import { Result } from 'better-result'
import { JobStore, JobContext, MemoryJobStore, Worker } from 'better-effect-mq'

import { SendEmail } from '../shared/jobs'

const store = MemoryJobStore.make()
const handler = Worker.handle(SendEmail, (payload) =>
  Effect.fn(async function* () {
    const context = yield* JobContext
    void context
    return Result.ok(`sent:${payload.recipient}`)
  })
)
const AppWorker = Worker.service('@examples/EmailWorker')
const AppWorkerLive = AppWorker.layer(() => ({
  handlers: [handler] as const,
  concurrency: 1,
  pollIntervalMs: 1
}))
const runtime = await Runtime.make(
  Layer.complete(Layer.merge(Layer.succeed(JobStore, JobStore.of(store)), ClockLive, AppWorkerLive))
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

  const workerResult = await runtime.run(() =>
    Effect.gen(async function* () {
      return Result.ok(yield* AppWorker)
    })
  )
  if (Result.isError(workerResult)) {
    throw workerResult.error
  }

  await workerResult.value.awaitIdle()

  const completed = await store.getJob({ jobId: enqueued.value })
  if (Result.isError(completed) || completed.value?.state !== 'completed') {
    throw new Error('Worker did not complete the enqueued job')
  }
} finally {
  await runtime.dispose()
}
