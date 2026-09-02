import { Effect } from 'better-effect'
import { ClockTest, IdGeneratorTest } from 'better-effect/standard-services'
import { TestRuntime } from 'better-effect/testing'
import { Result } from 'better-result'
import { JobContext, Worker } from 'better-effect-mq'
import { TestJobStore } from 'better-effect-mq/testing'

import { SendEmail } from '../shared/jobs'

const clock = new ClockTest(Date.UTC(2026, 0, 1))
const ids = IdGeneratorTest.from((index) => `test-${index + 1}`)
const testStore = TestJobStore.make({ clock, ids })
const runtime = await TestRuntime.make(testStore.layer, {
  clock,
  idGenerator: ids
})

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

  const handler = Worker.handle(SendEmail, (payload) =>
    Effect.fn(async function* () {
      const context = yield* JobContext
      if (context.attempt === 1) {
        return Result.err({ code: 'temporary-failure' })
      }

      return Result.ok(`sent:${payload.recipient}`)
    })
  )

  await Worker.use(
    runtime.runtime,
    {
      handlers: [handler],
      concurrency: 1,
      pollIntervalMs: 1,
      leaseDurationMs: 100,
      heartbeatIntervalMs: 10,
      stalledIntervalMs: 100,
      now: () => clock.now(),
      random: () => 0.5
    },
    (worker) => worker.awaitIdle({ timeoutMs: 2_000 })
  )

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
