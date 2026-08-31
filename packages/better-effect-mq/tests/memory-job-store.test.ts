import { expect, test } from 'bun:test'

import { Effect, Layer, Runtime } from 'better-effect'
import { ClockTest, IdGeneratorTest } from 'better-effect/standard-services'
import { Result } from 'better-result'

import {
  JobName,
  JobStore,
  JobStoreWakeAbortedError,
  MemoryJobStore,
  QueueName,
  WorkerId,
  makeJobId,
  makeLeaseToken,
  type EnqueueRequest,
  type JobStoreError,
  type JobStoreOperation
} from '../src'

const resolve = async <Value>(
  operation: JobStoreOperation<Value, JobStoreError>
): Promise<Value> => {
  const result = await operation
  if (Result.isError(result)) throw result.error
  return result.value
}

const identity = (queue = 'jobs', name = 'work', version = 1) => ({
  queue: QueueName.make(queue).unwrap(),
  name: JobName.make(name).unwrap(),
  version
})

const enqueueRequest = (
  label: string,
  now = 1,
  overrides: Partial<Pick<EnqueueRequest, 'id' | 'runAt' | 'priority'>> = {}
): EnqueueRequest => ({
  job: identity(),
  payload: { label },
  runAt: now,
  attemptsMax: 3,
  now,
  ...overrides
})

test('MemoryJobStore instances and snapshots are isolated and detached', async () => {
  const first = MemoryJobStore.make()
  const second = MemoryJobStore.make()
  const created = await resolve(first.enqueue(enqueueRequest('first')))
  const read = await resolve(first.getJob({ jobId: created.job.id }))

  expect(read).not.toBeUndefined()
  expect(read).not.toBe(created.job)
  expect(Object.isFrozen(created.job)).toBe(true)
  expect(Object.isFrozen(created.job.payload)).toBe(true)
  expect((await resolve(second.counts())).total).toBe(0)
  expect((await resolve(first.counts())).total).toBe(1)
})

test('MemoryJobStore accepts deterministic Clock and IdGenerator sources', async () => {
  const current = 100
  const clock = new ClockTest(current)
  const idGenerator = new IdGeneratorTest(['job-one', 'lease-one'])
  const store = MemoryJobStore.make({ clock, idGenerator })

  const created = await resolve(store.enqueue(enqueueRequest('deterministic', current)))
  const claimed = await resolve(
    store.claim({
      queue: QueueName.make('jobs').unwrap(),
      accepted: [identity()],
      limit: 1,
      workerId: WorkerId.make('worker-one').unwrap(),
      leaseDurationMs: 10,
      now: current
    })
  )

  expect(created.job.id).toBe(makeJobId('job-one').unwrap())
  expect(claimed.jobs[0]?.leaseToken).toBe(makeLeaseToken('lease-one').unwrap())
  clock.setTime(101)
  const mismatch = await store.getJob({ jobId: created.job.id })
  expect(Result.isOk(mismatch)).toBe(true)
  const invalid = await store.claim({
    queue: QueueName.make('jobs').unwrap(),
    accepted: [identity()],
    limit: 1,
    workerId: WorkerId.make('worker-one').unwrap(),
    leaseDurationMs: 10,
    now: 100
  })
  expect(Result.isError(invalid)).toBe(true)
})

test('MemoryJobStore layers provide fresh default and named stores', async () => {
  const Named = JobStore.named('memory-layer-test')
  const layer = Layer.merge(MemoryJobStore.layer, MemoryJobStore.layerFor(Named))
  const runtime = await Runtime.make(layer)
  const result = await runtime.run(() =>
    Effect.gen(async function* () {
      const defaultStore = yield* JobStore
      const namedStore = yield* Named
      return Result.ok(!Object.is(defaultStore, namedStore))
    })
  )

  expect(Result.isOk(result) && result.value).toBe(true)
  await runtime.dispose()
})

test('MemoryJobStore rejects malformed input before mutating state', async () => {
  const store = MemoryJobStore.make()
  const valid = enqueueRequest('valid')
  const malformed = { ...enqueueRequest('invalid'), attemptsMax: 0 }
  const batchResult = await store.enqueueMany([valid, malformed])

  expect(Result.isError(batchResult)).toBe(true)
  expect((await resolve(store.counts())).total).toBe(0)
})

test('MemoryJobStore wake waiters abort with cleanup-safe typed errors', async () => {
  const store = MemoryJobStore.make()
  const controller = new AbortController()
  const empty = await resolve(
    store.claim({
      queue: QueueName.make('jobs').unwrap(),
      accepted: [identity()],
      limit: 1,
      workerId: WorkerId.make('worker-one').unwrap(),
      leaseDurationMs: 10,
      now: 1
    })
  )
  const waiting = store.awaitWake({
    queues: [QueueName.make('jobs').unwrap()],
    wakeToken: empty.wakeToken,
    signal: controller.signal
  })
  controller.abort()
  const result = await waiting

  expect(Result.isError(result)).toBe(true)
  if (Result.isError(result)) expect(JobStoreWakeAbortedError.is(result.error)).toBe(true)
})

test('MemoryJobStore claims and lists a large equal-timestamp set deterministically', async () => {
  const store = MemoryJobStore.make()
  const requests = Array.from({ length: 1_500 }, (_, index) => ({
    ...enqueueRequest(`job-${index}`, 1),
    id: makeJobId(`stress-${index}`).unwrap()
  }))
  const inserted = await resolve(store.enqueueMany(requests))
  const claimed = await resolve(
    store.claim({
      queue: QueueName.make('jobs').unwrap(),
      accepted: [identity()],
      limit: requests.length,
      workerId: WorkerId.make('worker-one').unwrap(),
      leaseDurationMs: 10,
      now: 1
    })
  )
  const page = await resolve(store.list({ queue: QueueName.make('jobs').unwrap(), limit: 700 }))
  if (page.nextCursor === undefined) throw new Error('stress page did not produce a cursor')
  const rest = await resolve(
    store.list({
      queue: QueueName.make('jobs').unwrap(),
      limit: 700,
      cursor: page.nextCursor
    })
  )
  if (rest.nextCursor === undefined) throw new Error('stress second page did not produce a cursor')
  const final = await resolve(
    store.list({
      queue: QueueName.make('jobs').unwrap(),
      limit: 700,
      cursor: rest.nextCursor
    })
  )

  expect(inserted).toHaveLength(requests.length)
  expect(claimed.jobs).toHaveLength(requests.length)
  expect(claimed.jobs[0]?.id).toBe(makeJobId('stress-0').unwrap())
  expect(page.jobs.length + rest.jobs.length + final.jobs.length).toBe(requests.length)
  expect(new Set([...page.jobs, ...rest.jobs, ...final.jobs].map((job) => job.id)).size).toBe(
    requests.length
  )
})
