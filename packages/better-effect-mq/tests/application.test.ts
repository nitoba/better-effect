import { describe, expect, test } from 'bun:test'
import { Effect, Layer, Runtime } from 'better-effect'
import { Clock, ClockTest } from 'better-effect/standard-services'
import { Result } from 'better-result'

import {
  Codec,
  JobAdmin,
  JobDecodeFailure,
  JobDefinitionError,
  JobEncodeFailure,
  JobAwaitAbortedError,
  JobExecutionCancelledError,
  JobExecutionFailureError,
  JobIdentityMismatchError,
  JobNotFoundError,
  JobNotRetryableError,
  JobStore,
  MemoryJobStore,
  UnsupportedJobStoreOperationError,
  makeSerializedJobFailure,
  type JobStoreContract,
  Queue,
  QueueName,
  makeWorkerId
} from '../src'

const queue = Queue.define('application-tests')
const Send = queue.job('send', {
  version: 1,
  payload: Codec.json<{ readonly id: string }>(),
  result: Codec.string,
  failure: Codec.json<{ readonly code: string }>(),
  idempotencyKey: (payload) => payload.id,
  metadata: (payload) => ({ source: payload.id }),
  defaults: { attempts: 3, priority: 2 }
})
const EncodeFailure = queue.job('encode-failure', {
  version: 1,
  payload: Codec.make<string>({
    encode: () => Result.err(new JobEncodeFailure({ code: 'encode-failure' })),
    decode: (value) => Codec.string.decode(value)
  })
})
const MetadataFailure = queue.job('metadata-failure', {
  version: 1,
  payload: Codec.string,
  metadata: () => {
    throw new Error('metadata secret')
  }
})
const BatchString = queue.job('batch-string', {
  version: 1,
  payload: Codec.string
})
const IdempotencyFailure = queue.job('idempotency-failure', {
  version: 1,
  payload: Codec.string,
  idempotencyKey: () => {
    throw new Error('idempotency secret')
  }
})

const makeTestRuntime = async () => {
  const clock = new ClockTest(0)
  let nextId = 0
  const storeLayer = MemoryJobStore.layerWith({
    clock,
    idGenerator: { next: () => `application-${nextId++}` }
  })
  const runtime = await Runtime.make(Layer.merge(storeLayer, Layer.succeed(Clock, clock)))
  return { clock, runtime }
}

describe('Job producer and admin programs', () => {
  test('enqueue applies codecs, defaults, callbacks, duplicate semantics, and batches', async () => {
    const { runtime } = await makeTestRuntime()

    try {
      const result = await runtime.run(() =>
        Effect.gen(async function* () {
          const first = yield* Send.enqueue(
            { id: 'one' },
            { delayMs: 10, metadata: { source: 'call' } }
          )
          const duplicate = yield* Send.enqueue({ id: 'one' })
          const batch = yield* Send.enqueueMany([{ id: 'two' }, { id: 'three' }], { chunkSize: 1 })
          const scheduled = yield* Send.enqueueMany(
            [{ payload: { id: 'four' }, options: { at: 25 } }],
            { delayMs: 10 }
          )
          const scheduledId = scheduled[0]
          if (scheduledId === undefined) return Result.err(new Error('missing scheduled Job'))
          const scheduledView = yield* Send.poll(scheduledId)
          const listed = yield* JobAdmin.for(JobStore).list({ queue: 'application-tests' })
          return Result.ok({ first, duplicate, batch, scheduled, scheduledView, listed })
        })
      )

      expect(Result.isOk(result)).toBe(true)
      if (Result.isError(result)) return
      expect(String(result.value.first)).toBe('application-0')
      expect(result.value.duplicate).toBe(result.value.first)
      expect(result.value.batch.map(String)).toEqual(['application-1', 'application-2'])
      expect(result.value.scheduled.map(String)).toEqual(['application-3'])
      expect(result.value.scheduledView?.runAt).toBe(25)
      expect(result.value.listed.jobs).toHaveLength(4)
      expect(result.value.listed.jobs[0]?.metadata).toEqual({ source: 'call' })
      expect(result.value.listed.jobs[0]?.runAt).toBe(10)
    } finally {
      await runtime.dispose()
    }
  })

  test('codec and callback failures return focused errors without inserting Jobs', async () => {
    const { runtime } = await makeTestRuntime()

    try {
      const encode = await runtime.run(() =>
        Effect.gen(async function* () {
          return Result.ok(yield* EncodeFailure.enqueue('payload'))
        })
      )
      expect(Result.isError(encode)).toBe(true)
      if (Result.isOk(encode)) return
      expect(JobEncodeFailure.is(encode.error)).toBe(true)

      const metadata = await runtime.run(() =>
        Effect.gen(async function* () {
          return Result.ok(yield* MetadataFailure.enqueue('payload'))
        })
      )
      expect(Result.isError(metadata)).toBe(true)
      if (Result.isOk(metadata)) return
      expect(JobDefinitionError.is(metadata.error)).toBe(true)

      const idempotency = await runtime.run(() =>
        Effect.gen(async function* () {
          return Result.ok(yield* IdempotencyFailure.enqueue('payload'))
        })
      )
      expect(Result.isError(idempotency)).toBe(true)
      if (Result.isOk(idempotency)) return

      const invalidSchedule = await runtime.run(() =>
        Effect.gen(async function* () {
          // SAFETY: intentionally violate the compile-time option type to exercise runtime validation.
          return Result.ok(
            yield* MetadataFailure.enqueue('payload', {
              delayMs: 1,
              at: 2
            } as never)
          )
        })
      )
      expect(Result.isError(invalidSchedule)).toBe(true)
      if (Result.isOk(invalidSchedule)) return
      expect(JobDefinitionError.is(invalidSchedule.error)).toBe(true)

      const counts = await runtime.run(() =>
        Effect.gen(async function* () {
          return Result.ok(yield* JobAdmin.for(JobStore).counts('application-tests'))
        })
      )
      expect(Result.isOk(counts)).toBe(true)
      if (Result.isError(counts)) return
      expect(counts.value.total).toBe(0)
    } finally {
      await runtime.dispose()
    }
  })

  test('enqueueMany reports partial application at chunk boundaries', async () => {
    const { runtime } = await makeTestRuntime()

    try {
      const batch = await runtime.run(() =>
        Effect.gen(async function* () {
          // SAFETY: intentionally violate the compile-time payload type to exercise runtime validation.
          const invalidPayload = JSON.parse('42') as string
          return Result.ok(
            yield* BatchString.enqueueMany(['first', invalidPayload], { chunkSize: 1 })
          )
        })
      )
      expect(Result.isError(batch)).toBe(true)
      if (Result.isOk(batch)) return
      expect(JobDecodeFailure.is(batch.error)).toBe(true)

      const counts = await runtime.run(() =>
        Effect.gen(async function* () {
          return Result.ok(yield* JobAdmin.for(JobStore).counts({ name: 'batch-string' }))
        })
      )
      expect(Result.isOk(counts)).toBe(true)
      if (Result.isError(counts)) return
      expect(counts.value.total).toBe(1)
    } finally {
      await runtime.dispose()
    }
  })

  test('poll verifies identity before decoding', async () => {
    const { runtime } = await makeTestRuntime()
    const otherQueue = Queue.define('other-application-tests')
    const Other = otherQueue.job('send', {
      version: 1,
      payload: Codec.json<{ readonly id: string }>()
    })

    try {
      const created = await runtime.run(() =>
        Effect.gen(async function* () {
          return Result.ok(yield* Send.enqueue({ id: 'identity' }))
        })
      )
      if (Result.isError(created)) throw created.error

      const mismatch = await runtime.run(() =>
        Effect.gen(async function* () {
          return Result.ok(yield* Other.poll(created.value))
        })
      )
      expect(Result.isError(mismatch)).toBe(true)
      if (Result.isOk(mismatch)) return
      expect(JobIdentityMismatchError.is(mismatch.error)).toBe(true)
    } finally {
      await runtime.dispose()
    }
  })

  test('attempts decodes completed ledgers and rejects unknown IDs', async () => {
    const { runtime } = await makeTestRuntime()

    try {
      const result = await runtime.run(() =>
        Effect.gen(async function* () {
          const id = yield* Send.enqueue({ id: 'attempts' })
          const store = yield* JobStore
          const claimed = yield* Result.await(
            Promise.resolve(
              store.claim({
                queue: QueueName.make(queue.queue).unwrap(),
                accepted: [Send.identity],
                limit: 1,
                workerId: makeWorkerId('attempts-worker').unwrap(),
                leaseDurationMs: 100,
                now: 0
              })
            )
          )
          const active = claimed.jobs[0]
          if (active === undefined) return Result.err(new Error('claim did not return the Job'))
          yield* Result.await(
            Promise.resolve(
              store.settle({
                jobId: id,
                leaseToken: active.leaseToken,
                outcome: { type: 'complete', result: 'done' },
                now: 0
              })
            )
          )
          const attempts = yield* Send.attempts(id)
          return Result.ok(attempts)
        })
      )

      expect(Result.isOk(result)).toBe(true)
      if (Result.isError(result)) return
      expect(result.value).toHaveLength(1)
      expect(result.value[0]?.result).toBe('done')

      const missing = await runtime.run(() =>
        Effect.gen(async function* () {
          return Result.ok(yield* Send.attempts('missing'))
        })
      )
      expect(Result.isError(missing)).toBe(true)
      if (Result.isOk(missing)) return
      expect(JobNotFoundError.is(missing.error)).toBe(true)
    } finally {
      await runtime.dispose()
    }
  })

  test('awaitResult decodes completion and distinguishes unknown IDs', async () => {
    const { runtime } = await makeTestRuntime()

    try {
      const completed = await runtime.run(() =>
        Effect.gen(async function* () {
          const id = yield* Send.enqueue({ id: 'complete' })
          const store = yield* JobStore
          const claimed = yield* Result.await(
            Promise.resolve(
              store.claim({
                queue: QueueName.make(queue.queue).unwrap(),
                accepted: [Send.identity],
                limit: 1,
                workerId: makeWorkerId('application-worker').unwrap(),
                leaseDurationMs: 100,
                now: 0
              })
            )
          )
          const active = claimed.jobs[0]
          if (active === undefined) return Result.err(new Error('claim did not return the Job'))
          yield* Result.await(
            Promise.resolve(
              store.settle({
                jobId: id,
                leaseToken: active.leaseToken,
                outcome: { type: 'complete', result: 'done' },
                now: 0
              })
            )
          )
          return Result.ok(yield* Send.awaitResult(id))
        })
      )
      expect(Result.isOk(completed)).toBe(true)
      if (Result.isError(completed)) return
      expect(completed.value).toBe('done')

      const missing = await runtime.run(() =>
        Effect.gen(async function* () {
          return Result.ok(yield* Send.awaitResult('missing'))
        })
      )
      expect(Result.isError(missing)).toBe(true)
      if (Result.isOk(missing)) return
      expect(JobNotFoundError.is(missing.error)).toBe(true)
    } finally {
      await runtime.dispose()
    }
  })

  test('awaitResult preserves typed and non-domain terminal failures', async () => {
    const { runtime } = await makeTestRuntime()
    const typedFailure = makeSerializedJobFailure({
      kind: 'typed',
      message: 'typed failure',
      retryable: false,
      recordedAt: 0,
      data: { code: 'typed' }
    }).unwrap()
    const defectFailure = makeSerializedJobFailure({
      kind: 'defect',
      message: 'defect failure',
      retryable: false,
      recordedAt: 0
    }).unwrap()

    try {
      const ids = await runtime.run(() =>
        Effect.gen(async function* () {
          const store = yield* JobStore
          const typedId = yield* Send.enqueue({ id: 'typed-failure' })
          const typedClaim = yield* Result.await(
            Promise.resolve(
              store.claim({
                queue: QueueName.make(queue.queue).unwrap(),
                accepted: [Send.identity],
                limit: 1,
                workerId: makeWorkerId('typed-failure-worker').unwrap(),
                leaseDurationMs: 100,
                now: 0
              })
            )
          )
          const typedActive = typedClaim.jobs[0]
          if (typedActive === undefined) return Result.err(new Error('typed claim did not return'))
          yield* Result.await(
            Promise.resolve(
              store.settle({
                jobId: typedId,
                leaseToken: typedActive.leaseToken,
                outcome: { type: 'fail', failure: typedFailure },
                now: 0
              })
            )
          )

          const defectId = yield* Send.enqueue({ id: 'defect-failure' })
          const defectClaim = yield* Result.await(
            Promise.resolve(
              store.claim({
                queue: QueueName.make(queue.queue).unwrap(),
                accepted: [Send.identity],
                limit: 1,
                workerId: makeWorkerId('defect-failure-worker').unwrap(),
                leaseDurationMs: 100,
                now: 0
              })
            )
          )
          const defectActive = defectClaim.jobs[0]
          if (defectActive === undefined)
            return Result.err(new Error('defect claim did not return'))
          yield* Result.await(
            Promise.resolve(
              store.settle({
                jobId: defectId,
                leaseToken: defectActive.leaseToken,
                outcome: { type: 'fail', failure: defectFailure },
                now: 0
              })
            )
          )

          const cancelledId = yield* Send.enqueue({ id: 'cancelled-failure' })
          return Result.ok({ typedId, defectId, cancelledId })
        })
      )
      if (Result.isError(ids)) throw ids.error

      const typed = await runtime.run(() =>
        Effect.gen(async function* () {
          return Result.ok(yield* Send.awaitResult(ids.value.typedId, { pollIntervalMs: 0 }))
        })
      )
      expect(Result.isError(typed)).toBe(true)
      if (Result.isOk(typed)) return
      expect(typed.error).toEqual({ code: 'typed' })

      const defect = await runtime.run(() =>
        Effect.gen(async function* () {
          return Result.ok(yield* Send.awaitResult(ids.value.defectId, { pollIntervalMs: 0 }))
        })
      )
      expect(Result.isError(defect)).toBe(true)
      if (Result.isOk(defect)) return
      expect(JobExecutionFailureError.is(defect.error)).toBe(true)
      if (JobExecutionFailureError.is(defect.error)) expect(defect.error.kind).toBe('defect')

      const cancelled = await runtime.run(() =>
        Effect.gen(async function* () {
          yield* Send.cancel(ids.value.cancelledId)
          return Result.ok(yield* Send.awaitResult(ids.value.cancelledId, { pollIntervalMs: 0 }))
        })
      )
      expect(Result.isError(cancelled)).toBe(true)
      if (Result.isOk(cancelled)) return
      expect(JobExecutionCancelledError.is(cancelled.error)).toBe(true)
    } finally {
      await runtime.dispose()
    }
  })

  test('execute composes enqueue and awaitResult without creating a Runtime', async () => {
    const clock = new ClockTest(0)
    const base = MemoryJobStore.make({
      clock,
      idGenerator: { next: () => 'execute-job' }
    })
    const autoCompletingStore: JobStoreContract = Object.create(base)
    autoCompletingStore.enqueue = async (request: Parameters<JobStoreContract['enqueue']>[0]) => {
      const enqueued = await base.enqueue(request)
      if (Result.isOk(enqueued) && !enqueued.value.duplicate) {
        const identity = 'identity' in request ? request.identity : request.job
        const claimed = await base.claim({
          queue: QueueName.make(identity.queue).unwrap(),
          accepted: [identity],
          limit: 1,
          workerId: makeWorkerId('execute-worker').unwrap(),
          leaseDurationMs: 100,
          now: request.now
        })
        if (Result.isOk(claimed) && claimed.value.jobs[0] !== undefined) {
          await base.settle({
            jobId: enqueued.value.job.id,
            leaseToken: claimed.value.jobs[0].leaseToken,
            outcome: { type: 'complete', result: 'executed' },
            now: request.now
          })
        }
      }
      return enqueued
    }
    const runtime = await Runtime.make(
      Layer.merge(Layer.succeed(JobStore, autoCompletingStore), Layer.succeed(Clock, clock))
    )

    try {
      const result = await runtime.run(() =>
        Effect.gen(async function* () {
          return Result.ok(yield* Send.execute({ id: 'execute' }, { pollIntervalMs: 0 }))
        })
      )

      expect(Result.isOk(result)).toBe(true)
      if (Result.isError(result)) return
      expect(result.value).toBe('executed')
    } finally {
      await runtime.dispose()
    }
  })

  test('awaitResult stops on caller abort without cancelling the Job', async () => {
    const { runtime, clock } = await makeTestRuntime()
    const controller = new AbortController()

    try {
      const pending = runtime.run(() =>
        Effect.gen(async function* () {
          const id = yield* Send.enqueue({ id: 'abort' })
          return Result.ok(
            yield* Send.awaitResult(id, { pollIntervalMs: 10, signal: controller.signal })
          )
        })
      )

      while (clock.pendingSleeps === 0) await Promise.resolve()
      controller.abort('caller stopped waiting')
      const result = await pending
      expect(Result.isError(result)).toBe(true)
      if (Result.isOk(result)) return
      expect(JobAwaitAbortedError.is(result.error)).toBe(true)
    } finally {
      await runtime.dispose()
    }
  })

  test('generic admin listing validates filters and preserves cursor pagination', async () => {
    const { runtime } = await makeTestRuntime()

    try {
      const pages = await runtime.run(() =>
        Effect.gen(async function* () {
          const admin = JobAdmin.for(JobStore)
          yield* Send.enqueue({ id: 'page-one' })
          yield* Send.enqueue({ id: 'page-two' })
          const first = yield* admin.list({ limit: 1 })
          if (first.nextCursor === undefined) return Result.err(new Error('missing page cursor'))
          const second = yield* admin.list({ limit: 1, cursor: first.nextCursor })
          return Result.ok({ first, second })
        })
      )
      expect(Result.isOk(pages)).toBe(true)
      if (Result.isError(pages)) return
      expect(pages.value.first.jobs).toHaveLength(1)
      expect(pages.value.second.jobs).toHaveLength(1)
      expect(pages.value.first.jobs[0]?.id).not.toBe(pages.value.second.jobs[0]?.id)

      const invalidFilter = await runtime.run(() =>
        Effect.gen(async function* () {
          const first = yield* JobAdmin.for(JobStore).list({ limit: 1 })
          if (first.nextCursor === undefined) return Result.err(new Error('missing page cursor'))
          return Result.ok(
            yield* JobAdmin.for(JobStore).list({
              limit: 1,
              queue: 'another-queue',
              cursor: first.nextCursor
            })
          )
        })
      )
      expect(Result.isError(invalidFilter)).toBe(true)
      if (Result.isOk(invalidFilter)) return
      expect(UnsupportedJobStoreOperationError.is(invalidFilter.error)).toBe(true)

      const unsupported = await runtime.run(() =>
        Effect.gen(async function* () {
          return Result.ok(yield* JobAdmin.for(JobStore).list({ version: 1 }))
        })
      )
      expect(Result.isError(unsupported)).toBe(true)
      if (Result.isOk(unsupported)) return
      expect(UnsupportedJobStoreOperationError.is(unsupported.error)).toBe(true)
    } finally {
      await runtime.dispose()
    }
  })

  test('named JobStore bindings route producer and generic admin programs', async () => {
    const token = JobStore.named('application-named')
    const namedQueue = Queue.define('application-named-tests')
    const namedJob = namedQueue.job('send', {
      version: 1,
      payload: Codec.string,
      store: token
    })
    const clock = new ClockTest(0)
    const runtime = await Runtime.make(
      Layer.merge(
        MemoryJobStore.layerFor(token, { clock, idGenerator: { next: () => 'named-application' } }),
        Layer.succeed(Clock, clock)
      )
    )

    try {
      const result = await runtime.run(() =>
        Effect.gen(async function* () {
          const id = yield* namedJob.enqueue('payload')
          const counts = yield* JobAdmin.for(token).counts(namedQueue.queue)
          return Result.ok({ id, counts })
        })
      )

      expect(Result.isOk(result)).toBe(true)
      if (Result.isError(result)) return
      expect(String(result.value.id)).toBe('named-application')
      expect(result.value.counts.waiting).toBe(1)
      expect(result.value.counts.total).toBe(1)
    } finally {
      await runtime.dispose()
    }
  })

  test('job-bound transitions use focused preconditions and preserve scheduling', async () => {
    const { runtime } = await makeTestRuntime()
    const failure = makeSerializedJobFailure({
      kind: 'defect',
      message: 'failed for transition test',
      retryable: false,
      recordedAt: 0
    }).unwrap()

    try {
      const ids = await runtime.run(() =>
        Effect.gen(async function* () {
          const retriedId = yield* Send.enqueue({ id: 'retry' })
          const redrivenId = yield* Send.enqueue({ id: 'redrive' })
          const store = yield* JobStore
          const claimed = yield* Result.await(
            Promise.resolve(
              store.claim({
                queue: QueueName.make(queue.queue).unwrap(),
                accepted: [Send.identity],
                limit: 2,
                workerId: makeWorkerId('transition-worker').unwrap(),
                leaseDurationMs: 100,
                now: 0
              })
            )
          )
          for (const id of [retriedId, redrivenId]) {
            const active = claimed.jobs.find((job) => job.id === id)
            if (active === undefined) return Result.err(new Error(`missing active Job ${id}`))
            yield* Result.await(
              Promise.resolve(
                store.settle({
                  jobId: id,
                  leaseToken: active.leaseToken,
                  outcome: { type: 'fail', failure },
                  now: 0
                })
              )
            )
          }
          const delayedId = yield* Send.enqueue({ id: 'promote' }, { delayMs: 10 })
          const cancelledId = yield* Send.enqueue({ id: 'cancel' })
          return Result.ok({ delayedId, cancelledId, retriedId, redrivenId })
        })
      )
      if (Result.isError(ids)) throw ids.error

      const promoted = await runtime.run(() =>
        Effect.gen(async function* () {
          return Result.ok(yield* Send.promote(ids.value.delayedId))
        })
      )
      expect(Result.isOk(promoted)).toBe(true)
      if (Result.isError(promoted)) return
      expect(promoted.value.state).toBe('waiting')
      expect(promoted.value.runAt).toBe(0)

      const cancelled = await runtime.run(() =>
        Effect.gen(async function* () {
          return Result.ok(yield* Send.cancel(ids.value.cancelledId))
        })
      )
      expect(Result.isOk(cancelled)).toBe(true)
      if (Result.isError(cancelled)) return
      expect(cancelled.value.state).toBe('cancelled')

      const retried = await runtime.run(() =>
        Effect.gen(async function* () {
          return Result.ok(yield* Send.retry(ids.value.retriedId, { delayMs: 10 }))
        })
      )
      expect(Result.isOk(retried)).toBe(true)
      if (Result.isError(retried)) return
      expect(retried.value.state).toBe('delayed')
      expect(retried.value.runAt).toBe(10)

      const redriven = await runtime.run(() =>
        Effect.gen(async function* () {
          return Result.ok(yield* Send.redrive(ids.value.redrivenId, { at: 20 }))
        })
      )
      expect(Result.isOk(redriven)).toBe(true)
      if (Result.isError(redriven)) return
      expect(redriven.value.state).toBe('delayed')
      expect(redriven.value.runAt).toBe(20)

      const invalidRetry = await runtime.run(() =>
        Effect.gen(async function* () {
          return Result.ok(yield* Send.retry(ids.value.delayedId))
        })
      )
      expect(Result.isError(invalidRetry)).toBe(true)
      if (Result.isOk(invalidRetry)) return
      expect(JobNotRetryableError.is(invalidRetry.error)).toBe(true)
    } finally {
      await runtime.dispose()
    }
  })

  test('admin mutations route through the selected store', async () => {
    const { runtime } = await makeTestRuntime()

    try {
      const result = await runtime.run(() =>
        Effect.gen(async function* () {
          const id = yield* Send.enqueue({ id: 'admin' })
          const admin = JobAdmin.for(JobStore)
          const paused = yield* admin.pause('application-tests')
          const queues = yield* admin.pausedQueues()
          const resumed = yield* admin.resume('application-tests')
          const queuesAfterResume = yield* admin.pausedQueues()
          const removed = yield* admin.remove(id, { expectedState: 'waiting' })
          const count = yield* admin.count('application-tests')
          return Result.ok({ paused, queues, resumed, queuesAfterResume, removed, count })
        })
      )

      expect(Result.isOk(result)).toBe(true)
      if (Result.isError(result)) return
      expect(result.value.paused.paused).toBe(true)
      expect(result.value.queues.map(String)).toEqual(['application-tests'])
      expect(result.value.resumed.paused).toBe(false)
      expect(result.value.queuesAfterResume).toEqual([])
      expect(result.value.removed.removed).toBe(true)
      expect(result.value.count).toBe(0)
    } finally {
      await runtime.dispose()
    }
  })
})
