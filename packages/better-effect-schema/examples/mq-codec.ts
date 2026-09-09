import * as z from 'zod'
import { Effect, Layer, Runtime } from 'better-effect'
import { ClockLive } from 'better-effect/standard-services'
import { Result } from 'better-result'
import { Codec, JobEncodeFailure, JobStore, MemoryJobStore, Queue, Worker } from 'better-effect-mq'
import { Schema as CoreSchema } from 'better-effect-schema'
import { Schema } from 'better-effect-schema/zod'

const DateFromISOString = z.codec(z.iso.datetime(), z.date(), {
  decode: (value) => new Date(value),
  encode: (value) => value.toISOString()
})

class UserEvent extends Schema.Class<UserEvent>('examples/MqUserEvent')({
  eventId: z.uuid(),
  occurredAt: DateFromISOString,
  kind: z.string().min(1),
  payload: z.record(z.string(), z.string())
}) {}

const EventReceipt = z.object({
  accepted: z.literal(true),
  eventId: z.uuid()
})

const EventFailure = z.object({
  code: z.string().min(1),
  retryable: z.boolean()
})

// The MQ schema codec validates persisted values and the explicit encoder
// delegates wire conversion to the better-effect-schema class.
const userEventCodec = Codec.standardSchema({
  schema: UserEvent,
  encode: (value) =>
    CoreSchema.encode(UserEvent, value).mapError(
      (error) => new JobEncodeFailure({ message: error.message, code: 'schema-encode' })
    )
})

const receiptCodec = Codec.standardSchema({ schema: EventReceipt })
const failureCodec = Codec.standardSchema({ schema: EventFailure })

const Events = Queue.define('examples.events')
const IngestEvent = Events.job('ingest-event', {
  version: 1,
  payload: userEventCodec,
  result: receiptCodec,
  failure: failureCodec,
  idempotencyKey: ({ eventId }) => eventId,
  retryable: ({ retryable }) => retryable
})

const handler = Worker.handle(IngestEvent, (event) =>
  Effect.fn(async function* () {
    return Result.ok({ accepted: true as const, eventId: event.eventId })
  })
)

const EventsWorker = Worker.service('@examples/EventsWorker')
const EventsWorkerLive = EventsWorker.layer(() => ({
  handlers: [handler] as const,
  concurrency: 1,
  pollIntervalMs: 10
}))

const AppLive = Layer.complete(
  Layer.merge(
    Layer.succeed(JobStore, JobStore.of(MemoryJobStore.make())),
    Layer.merge(ClockLive, EventsWorkerLive)
  )
)
const runtime = await Runtime.make(AppLive)

try {
  const started = await runtime.run(() =>
    Effect.gen(async function* () {
      return Result.ok(yield* EventsWorker)
    })
  )
  if (Result.isError(started)) throw started.error

  const completed = await runtime.run(() =>
    Effect.gen(async function* () {
      const jobId = yield* IngestEvent.enqueue({
        eventId: '550e8400-e29b-41d4-a716-446655440000',
        occurredAt: '2026-09-02T10:00:00.000Z',
        kind: 'user.created',
        payload: { source: 'example' }
      })
      const receipt = yield* IngestEvent.awaitResult(jobId)
      return Result.ok({ jobId, receipt })
    })
  )
  if (Result.isError(completed)) throw completed.error

  await started.value.awaitIdle()
  console.log('mq-codec: ok', completed.value.receipt)
} finally {
  await runtime.dispose()
}
