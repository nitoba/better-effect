import { expect, test } from 'bun:test'

import { Effect, Layer, Runtime, ServiceRuntime } from 'better-effect'
import { ClockTest, IdGeneratorTest } from 'better-effect/standard-services'
import { Result, type Result as ResultType } from 'better-result'

import {
  JobName,
  JobStore,
  JobStoreFailure,
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

const storeEnqueue = (
  store: ReturnType<typeof MemoryJobStore.make>,
  label: string,
  id: NonNullable<EnqueueRequest['id']>
) => store.enqueue(enqueueRequest(label, 1, { id }))

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

test('MemoryJobStore layers provide distinct default and named stores', async () => {
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

test('reusing MemoryJobStore.layer creates fresh state for every Runtime', async () => {
  const layer = MemoryJobStore.layer
  const first = await Runtime.make(layer)
  const second = await Runtime.make(layer)

  try {
    const firstStore = await first.run(() => ServiceRuntime.resolve(JobStore))
    const secondStore = await second.run(() => ServiceRuntime.resolve(JobStore))
    await resolve(firstStore.enqueue(enqueueRequest('first')))

    expect((await resolve(firstStore.counts())).total).toBe(1)
    expect((await resolve(secondStore.counts())).total).toBe(0)
  } finally {
    await Promise.all([first.dispose(), second.dispose()])
  }
})

test('reusing layerWith and layerFor creates fresh default and named state', async () => {
  const Named = JobStore.named('memory-reused-layer')
  const defaultLayer = MemoryJobStore.layerWith()
  const namedLayer = MemoryJobStore.layerFor(Named)
  const defaultFirst = await Runtime.make(defaultLayer)
  const defaultSecond = await Runtime.make(defaultLayer)
  const namedFirst = await Runtime.make(namedLayer)
  const namedSecond = await Runtime.make(namedLayer)

  try {
    const defaultStore = await defaultFirst.run(() => ServiceRuntime.resolve(JobStore))
    const defaultOther = await defaultSecond.run(() => ServiceRuntime.resolve(JobStore))
    const namedStore = await namedFirst.run(() => ServiceRuntime.resolve(Named))
    const namedOther = await namedSecond.run(() => ServiceRuntime.resolve(Named))

    await resolve(defaultStore.enqueue(enqueueRequest('default')))
    await resolve(namedStore.enqueue(enqueueRequest('named')))

    expect((await resolve(defaultStore.counts())).total).toBe(1)
    expect((await resolve(defaultOther.counts())).total).toBe(0)
    expect((await resolve(namedStore.counts())).total).toBe(1)
    expect((await resolve(namedOther.counts())).total).toBe(0)
  } finally {
    await Promise.all([
      defaultFirst.dispose(),
      defaultSecond.dispose(),
      namedFirst.dispose(),
      namedSecond.dispose()
    ])
  }
})

test('MemoryJobStore rejects reentrant claim generation without overwriting a lease', async () => {
  let store!: ReturnType<typeof MemoryJobStore.make>
  let nested: ResultType<unknown, JobStoreError> | undefined
  const queue = QueueName.make('jobs').unwrap()
  const idGenerator = {
    next: () => {
      // SAFETY: MemoryJobStore operations complete synchronously; the contract union has been narrowed for this reentrant fixture.
      nested = store.claim({
        queue,
        accepted: [identity()],
        limit: 1,
        workerId: WorkerId.make('nested-worker').unwrap(),
        leaseDurationMs: 10,
        now: 1
      }) as ResultType<unknown, JobStoreError>
      return 'outer-lease'
    }
  }
  store = MemoryJobStore.make({ idGenerator })

  const created = await resolve(
    store.enqueue(enqueueRequest('reentrant', 1, { id: makeJobId('reentrant-job').unwrap() }))
  )
  const outer = await resolve(
    store.claim({
      queue,
      accepted: [identity()],
      limit: 1,
      workerId: WorkerId.make('outer-worker').unwrap(),
      leaseDurationMs: 10,
      now: 1
    })
  )
  const current = await resolve(store.getJob({ jobId: created.job.id }))
  const attempts = await resolve(store.getAttempts({ jobId: created.job.id }))

  if (nested === undefined) throw new Error('reentrant claim was not attempted')
  expect(Result.isError(nested)).toBe(true)
  if (Result.isError(nested)) expect(JobStoreFailure.is(nested.error)).toBe(true)
  expect(outer.jobs).toHaveLength(1)
  expect(current?.state).toBe('active')
  expect(current?.leaseToken).toBe(outer.jobs[0]?.leaseToken)
  expect(attempts).toHaveLength(0)
})

test('MemoryJobStore records the bounded stalled count at the terminal threshold', async () => {
  const store = MemoryJobStore.make()
  const created = await resolve(
    store.enqueue(enqueueRequest('stalled', 1, { id: makeJobId('stalled-job').unwrap() }))
  )
  const firstClaim = await resolve(
    store.claim({
      queue: QueueName.make('jobs').unwrap(),
      accepted: [identity()],
      limit: 1,
      workerId: WorkerId.make('worker-one').unwrap(),
      leaseDurationMs: 10,
      now: 1
    })
  )
  const firstRecovery = await resolve(store.recoverStalled({ maxStalledCount: 1, now: 11 }))
  const secondClaim = await resolve(
    store.claim({
      queue: QueueName.make('jobs').unwrap(),
      accepted: [identity()],
      limit: 1,
      workerId: WorkerId.make('worker-two').unwrap(),
      leaseDurationMs: 10,
      now: 11
    })
  )
  const terminalRecovery = await resolve(store.recoverStalled({ maxStalledCount: 1, now: 21 }))
  const current = await resolve(store.getJob({ jobId: created.job.id }))
  const attempts = await resolve(store.getAttempts({ jobId: created.job.id }))

  expect(firstClaim.jobs).toHaveLength(1)
  expect(firstRecovery.transitions[0]?.record.stalledCount).toBe(1)
  expect(secondClaim.jobs).toHaveLength(1)
  expect(terminalRecovery.transitions[0]?.record.state).toBe('failed')
  expect(terminalRecovery.transitions[0]?.record.stalledCount).toBe(1)
  expect(terminalRecovery.transitions[0]?.attempt?.outcome).toBe('stalled')
  expect(current?.stalledCount).toBe(1)
  expect(attempts).toHaveLength(2)
  expect(attempts[1]?.outcome).toBe('stalled')
  expect(attempts[1]?.attempt).toBe(0)
})

test('MemoryJobStore redrive accepts cancelled and non-retryable failed jobs', async () => {
  const store = MemoryJobStore.make()
  const failed = await resolve(
    store.enqueue(enqueueRequest('failed', 1, { id: makeJobId('failed-job').unwrap() }))
  )
  const failedClaim = await resolve(
    store.claim({
      queue: QueueName.make('jobs').unwrap(),
      accepted: [identity()],
      limit: 1,
      workerId: WorkerId.make('failed-worker').unwrap(),
      leaseDurationMs: 10,
      now: 1
    })
  )
  const active = failedClaim.jobs[0]
  if (active === undefined) throw new Error('failed fixture was not claimed')
  await resolve(
    store.settle({
      jobId: active.id,
      leaseToken: active.leaseToken,
      now: 1,
      outcome: {
        type: 'fail',
        failure: {
          kind: 'typed',
          code: 'PERMANENT',
          message: 'permanent failure',
          retryable: false,
          recordedAt: 1
        }
      }
    })
  )
  const redrivenFailed = await resolve(store.redrive({ jobId: failed.job.id, runAt: 1, now: 1 }))

  const cancelled = await resolve(
    store.enqueue(enqueueRequest('cancelled', 1, { id: makeJobId('cancelled-job').unwrap() }))
  )
  await resolve(store.cancel({ jobId: cancelled.job.id, now: 1 }))
  const redrivenCancelled = await resolve(
    store.redrive({ jobId: cancelled.job.id, runAt: 1, now: 1 })
  )

  expect(redrivenFailed.record.state).toBe('waiting')
  expect(redrivenCancelled.record.state).toBe('waiting')
})

test('MemoryJobStore cursors carry their binding across collisions and stores', async () => {
  const firstStore = MemoryJobStore.make()
  const firstJobId = makeJobId('cursor-first').unwrap()
  const secondJobId = makeJobId('cursor-second').unwrap()
  await resolve(storeEnqueue(firstStore, 'first', firstJobId))
  await resolve(storeEnqueue(firstStore, 'second', secondJobId))

  const firstPage = await resolve(
    firstStore.list({ queue: QueueName.make('jobs').unwrap(), limit: 1 })
  )
  const collidingQuery = await resolve(
    firstStore.list({ name: JobName.make('work').unwrap(), limit: 1 })
  )
  if (firstPage.nextCursor === undefined || collidingQuery.nextCursor === undefined) {
    throw new Error('cursor fixtures did not produce cursors')
  }
  // SAFETY: JSON round-tripping a validated cursor preserves its canonical scalar fields.
  const cursor = JSON.parse(JSON.stringify(firstPage.nextCursor)) as typeof firstPage.nextCursor
  const resumed = await resolve(
    firstStore.list({ queue: QueueName.make('jobs').unwrap(), limit: 1, cursor })
  )

  const secondStore = MemoryJobStore.make()
  await resolve(storeEnqueue(secondStore, 'first', firstJobId))
  await resolve(storeEnqueue(secondStore, 'second', secondJobId))
  const resumedInFreshStore = await resolve(
    secondStore.list({ queue: QueueName.make('jobs').unwrap(), limit: 1, cursor })
  )

  expect(firstPage.nextCursor).toMatchObject({
    version: 1,
    ordering: 'createdAt,orderingSequence,id',
    direction: 'asc',
    filterSignature: expect.any(String)
  })
  expect(resumed.jobs[0]?.id).toBe(secondJobId)
  expect(resumedInFreshStore.jobs[0]?.id).toBe(secondJobId)
})

test('MemoryJobStore rejects a cursor with a mismatched binding', async () => {
  const store = MemoryJobStore.make()
  await resolve(store.enqueue(enqueueRequest('one')))
  await resolve(store.enqueue(enqueueRequest('two')))
  const page = await resolve(store.list({ queue: QueueName.make('jobs').unwrap(), limit: 1 }))
  if (page.nextCursor === undefined) throw new Error('cursor fixture did not produce a cursor')

  const result = await store.list({
    name: JobName.make('work').unwrap(),
    limit: 1,
    // SAFETY: JSON round-tripping a validated cursor preserves its canonical scalar fields.
    cursor: JSON.parse(JSON.stringify(page.nextCursor)) as typeof page.nextCursor
  })

  expect(Result.isError(result)).toBe(true)
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
