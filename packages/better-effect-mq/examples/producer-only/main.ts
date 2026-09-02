import { Effect, Layer, Runtime } from 'better-effect'
import { ClockLive } from 'better-effect/standard-services'
import { Result } from 'better-result'
import { JobStore, MemoryJobStore } from 'better-effect-mq'

import { SendEmail } from '../shared/jobs'

const store = MemoryJobStore.make()
const runtime = await Runtime.make(
  Layer.merge(Layer.succeed(JobStore, JobStore.of(store)), ClockLive)
)

try {
  const result = await runtime.run(() =>
    Effect.gen(async function* () {
      const first = yield* SendEmail.enqueue({
        messageId: 'message-1',
        recipient: 'ada@example.test'
      })
      const duplicate = yield* SendEmail.enqueue(
        {
          messageId: 'message-1',
          recipient: 'ada@example.test'
        },
        { idempotencyKey: 'message-1' }
      )
      return Result.ok({ first, duplicate })
    })
  )

  if (Result.isError(result)) {
    throw result.error
  }

  if (result.value.first !== result.value.duplicate) {
    throw new Error('idempotent enqueue returned different Job IDs')
  }
} finally {
  await runtime.dispose()
}
