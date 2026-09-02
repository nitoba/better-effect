import { expect, test } from 'bun:test'
import { Effect, Layer, Runtime } from 'better-effect'
import { Result } from 'better-result'

import { IdGeneratorTest } from 'better-effect/standard-services'

import { Codec, JobStore, Queue, QueueName, WorkerId } from '../src'
import type { EnqueueResult, JobId } from '../src'
import { TestJobStore } from '../src/testing'

type TestOperation<Value> = Result<Value, unknown> | PromiseLike<Result<Value, unknown>>

const unwrap = async <Value>(operation: TestOperation<Value>): Promise<Value> => {
  const result = await operation
  if (Result.isError(result)) throw result.error
  return result.value
}

test('TestJobStore queries one isolated store and decodes payloads', async () => {
  const harness = TestJobStore.make()
  const jobs = Queue.define('test-job-store')
  const definition = jobs.job('send', { version: 1, payload: Codec.json<{ value: number }>() })
  const observed = harness.observe(definition)

  const jobId = await unwrap<JobId>(
    Runtime.run(Layer.merge(harness.layer, harness.clockLayer), () =>
      Effect.gen(async function* () {
        const id = yield* observed.enqueue({ value: 42 })
        return Result.ok(id)
      })
    )
  )

  expect((await harness.enqueued(definition)).map((job) => job.id)).toEqual([jobId])
  expect(await harness.enqueuedPayloads(definition)).toEqual([{ value: 42 }])
  expect((await harness.counts('test-job-store')).waiting).toBe(1)
  expect(harness.observer.events).toHaveLength(1)

  harness.clearObserver()
  expect(harness.observer.events).toHaveLength(0)
})

test('TestJobStore rejects ambiguous ID options', () => {
  const ids = IdGeneratorTest.from((index) => `test-${index}`)

  expect(() => TestJobStore.make({ ids, idGenerator: ids })).toThrow(
    'TestJobStore accepts either ids or idGenerator, not both'
  )
})

test('TestJobStore supports isolated named stores', async () => {
  const token = JobStore.named('named-test-store')
  const harness = TestJobStore.makeFor(token)
  const definition = Queue.define('named-test-queue').job('work', {
    version: 1,
    payload: Codec.string,
    store: token
  })

  const jobId = await unwrap<JobId>(
    Runtime.run(Layer.merge(harness.layer, harness.clockLayer), () =>
      Effect.gen(async function* () {
        const id = yield* definition.enqueue('payload')
        return Result.ok(id)
      })
    )
  )

  expect((await harness.enqueued(definition)).map((job) => job.id)).toEqual([jobId])
  expect(await harness.enqueuedPayloads(definition)).toEqual(['payload'])
})

test('TestJobStore claim and release preserve explicit lease tokens', async () => {
  const harness = TestJobStore.make()
  const queue = Queue.define('test-job-store-lease')
  const definition = queue.job('work', { version: 1, payload: Codec.json<string>() })
  const created = await unwrap<EnqueueResult>(
    harness.store.enqueue({
      job: definition.identity,
      payload: 'payload',
      runAt: 0,
      attemptsMax: 3,
      now: 0
    })
  )
  const claimed = await harness.claim({
    queue: QueueName.make(queue.name).unwrap(),
    accepted: [definition.identity],
    limit: 1,
    workerId: WorkerId.make('worker').unwrap(),
    leaseDurationMs: 100
  })

  expect(claimed.jobs[0]?.id).toBe(created.job.id)
  const released = await harness.release({
    jobId: created.job.id,
    leaseToken: claimed.jobs[0]!.leaseToken
  })
  expect(released.record.state).toBe('waiting')
})
