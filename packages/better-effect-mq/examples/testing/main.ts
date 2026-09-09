import { Effect, Layer } from 'better-effect'
import { ClockTest, IdGeneratorTest } from 'better-effect/standard-services'
import { TestRuntime } from 'better-effect/testing'
import { Result } from 'better-result'
import { Worker } from 'better-effect-mq'
import { TestJobStore } from 'better-effect-mq/testing'

import { SendEmail } from '../shared/jobs'

const clock = new ClockTest(Date.UTC(2026, 0, 1))
const ids = IdGeneratorTest.from((index) => `test-${index + 1}`)
const testStore = TestJobStore.make({ clock, ids })
const AppWorker = Worker.service('@examples/TestWorker')
let handlerAttempts = 0
const handler = Worker.handle(SendEmail, (payload) =>
  Effect.fn(async function* () {
    yield* Result.await(Promise.resolve(Result.ok(undefined)))
    handlerAttempts += 1
    if (handlerAttempts === 1) {
      return Result.err({ code: 'temporary-failure' })
    }

    return Result.ok(`sent:${payload.recipient}`)
  })
)
const AppWorkerLive = AppWorker.layer(() => ({
  handlers: [handler] as const,
  concurrency: 1,
  pollIntervalMs: 1,
  leaseDurationMs: 100,
  heartbeatIntervalMs: 10,
  stalledIntervalMs: 100,
  now: () => clock.now(),
  random: () => 0.5
}))
const runtime = await TestRuntime.make(
  Layer.complete(Layer.merge(testStore.layer, AppWorkerLive)),
  {
    clock,
    idGenerator: ids
  }
)

try {
  const observed = testStore.observe(SendEmail)
  const jobId = await runtime.run(() =>
    Effect.gen(async function* () {
      const id = yield* observed.enqueue(
        {
          messageId: 'test-message-1',
          recipient: 'ada@example.test'
        },
        {
          attempts: 2,
          backoff: { type: 'constant', delayMs: 0 }
        }
      )
      return Result.ok(id)
    })
  )
  if (Result.isError(jobId)) {
    throw jobId.error
  }

  const workerResult = await runtime.runtime.run(() =>
    Effect.gen(async function* () {
      return Result.ok(yield* AppWorker)
    })
  )
  if (Result.isError(workerResult)) {
    throw workerResult.error
  }

  await workerResult.value.awaitIdle({ timeoutMs: 2_000 })

  const completed = await testStore.job(jobId.value)
  if (completed?.state !== 'completed' || completed.result !== 'sent:ada@example.test') {
    throw new Error('test Worker did not complete the enqueued job')
  }

  const attempts = await testStore.attempts(jobId.value)
  if (
    attempts.length !== 2 ||
    attempts.map((attempt) => attempt.outcome).join(',') !== 'retried,completed'
  ) {
    throw new Error('test harness did not preserve the retry attempt ledger')
  }
} finally {
  await runtime.dispose()
}
