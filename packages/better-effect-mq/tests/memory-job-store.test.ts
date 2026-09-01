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
  UnsupportedJobStoreOperationError,
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
  overrides: Partial<
    Pick<EnqueueRequest, 'id' | 'idempotencyKey' | 'runAt' | 'priority' | 'metadata' | 'job'>
  > = {}
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

test('MemoryJobStore gives explicit IDs precedence over idempotency keys', async () => {
  const store = MemoryJobStore.make()
  const keyed = await resolve(
    store.enqueue(enqueueRequest('keyed', 1, { idempotencyKey: 'shared-key' }))
  )
  const explicitId = makeJobId('explicit-precedence').unwrap()
  const explicit = await resolve(
    store.enqueue(enqueueRequest('explicit', 1, { id: explicitId, idempotencyKey: 'shared-key' }))
  )

  expect(explicit.job.id).toBe(explicitId)
  expect(explicit.job.id).not.toBe(keyed.job.id)

  const explicitSecond = await resolve(
    store.enqueue(
      enqueueRequest('explicit-second', 1, { id: explicitId, idempotencyKey: 'other-key' })
    )
  )
  expect(explicitSecond.duplicate).toBe(true)
  expect(explicitSecond.job.id).toBe(explicitId)
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

test('MemoryJobStore counts the terminal stalled recovery', async () => {
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
  expect(terminalRecovery.transitions[0]?.record.stalledCount).toBe(2)
  expect(terminalRecovery.transitions[0]?.attempt?.outcome).toBe('stalled')
  expect(current?.stalledCount).toBe(2)
  expect(attempts).toHaveLength(2)
  expect(attempts[1]?.outcome).toBe('stalled')
  expect(attempts[1]?.attempt).toBe(0)
})

test('MemoryJobStore counts terminal stalled cancellation in the ledger', async () => {
  const store = MemoryJobStore.make()
  const created = await resolve(
    store.enqueue(
      enqueueRequest('stalled-cancellation', 1, {
        id: makeJobId('stalled-cancellation-job').unwrap()
      })
    )
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
  const requested = await resolve(store.requestCancellation({ jobId: created.job.id, now: 11 }))
  const terminalRecovery = await resolve(store.recoverStalled({ maxStalledCount: 1, now: 21 }))
  const current = await resolve(store.getJob({ jobId: created.job.id }))
  const attempts = await resolve(store.getAttempts({ jobId: created.job.id }))

  expect(firstClaim.jobs).toHaveLength(1)
  expect(firstRecovery.transitions[0]?.record.stalledCount).toBe(1)
  expect(secondClaim.jobs).toHaveLength(1)
  expect(requested.record.state).toBe('active')
  expect(terminalRecovery.transitions[0]?.record.state).toBe('cancelled')
  expect(terminalRecovery.transitions[0]?.record.stalledCount).toBe(2)
  expect(terminalRecovery.transitions[0]?.record.attemptsMade).toBe(0)
  expect(terminalRecovery.transitions[0]?.record.deliveryCount).toBe(2)
  expect(terminalRecovery.transitions[0]?.attempt).toMatchObject({
    attempt: 0,
    delivery: 2,
    outcome: 'cancelled'
  })
  expect(current?.stalledCount).toBe(2)
  expect(attempts).toHaveLength(2)
  expect(attempts.map((attempt) => attempt.outcome)).toEqual(['stalled', 'cancelled'])
  expect(attempts[1]?.attempt).toBe(0)
  expect(attempts[1]?.delivery).toBe(2)
})

test('MemoryJobStore retry accepts cancelled and non-retryable failed jobs', async () => {
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
  const retriedFailed = await resolve(store.retry({ jobId: failed.job.id, runAt: 1, now: 1 }))

  const cancelled = await resolve(
    store.enqueue(enqueueRequest('cancelled', 1, { id: makeJobId('cancelled-job').unwrap() }))
  )
  await resolve(store.cancel({ jobId: cancelled.job.id, now: 1 }))
  const retriedCancelled = await resolve(store.retry({ jobId: cancelled.job.id, runAt: 1, now: 1 }))

  expect(retriedFailed.record.state).toBe('waiting')
  expect(retriedCancelled.record.state).toBe('waiting')
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

test('MemoryJobStore lists supported filters and orderings with null cursors', async () => {
  const store = MemoryJobStore.make()
  const queue = QueueName.make('jobs').unwrap()
  const work = JobName.make('work').unwrap()
  const acceptedIdentity = { queue, name: work, version: 1 }

  const finished = await resolve(
    store.enqueue(
      enqueueRequest('finished', 1, {
        id: makeJobId('finished').unwrap(),
        job: acceptedIdentity,
        metadata: { group: 'done' },
        priority: 10,
        runAt: 1
      })
    )
  )
  const unfinished = await resolve(
    store.enqueue(
      enqueueRequest('unfinished', 2, {
        id: makeJobId('unfinished').unwrap(),
        job: acceptedIdentity,
        metadata: { group: 'open' },
        runAt: 1
      })
    )
  )
  const versionTwo = await resolve(
    store.enqueue(
      enqueueRequest('version-two', 3, {
        id: makeJobId('version-two').unwrap(),
        job: { queue, name: work, version: 2 },
        metadata: { group: 'two' },
        runAt: 3
      })
    )
  )
  const otherQueue = await resolve(
    store.enqueue(
      enqueueRequest('other-queue', 4, {
        id: makeJobId('other-queue').unwrap(),
        job: {
          queue: QueueName.make('other').unwrap(),
          name: JobName.make('alt').unwrap(),
          version: 1
        },
        metadata: { group: 'other' },
        runAt: 4
      })
    )
  )

  const claimed = await resolve(
    store.claim({
      queue,
      accepted: [acceptedIdentity],
      limit: 1,
      workerId: WorkerId.make('list-worker').unwrap(),
      leaseDurationMs: 100,
      now: 5
    })
  )
  const active = claimed.jobs[0]
  if (active?.leaseToken === undefined) throw new Error('finished fixture was not claimed')
  await resolve(
    store.settle({
      jobId: active.id,
      leaseToken: active.leaseToken,
      now: 10,
      outcome: { type: 'complete', result: { done: true } }
    })
  )

  const listIds = async (request: Parameters<typeof store.list>[0]): Promise<string[]> =>
    (await resolve(store.list(request))).jobs.map((job) => String(job.id))
  const allAscending = await listIds({ limit: 10 })
  expect(allAscending).toEqual([
    String(finished.job.id),
    String(unfinished.job.id),
    String(versionTwo.job.id),
    String(otherQueue.job.id)
  ])
  expect(await listIds({ limit: 10, order: 'desc' })).toEqual([...allAscending].reverse())
  expect(await listIds({ limit: 10, orderBy: 'runAt' })).toEqual([
    String(finished.job.id),
    String(unfinished.job.id),
    String(versionTwo.job.id),
    String(otherQueue.job.id)
  ])
  expect(await listIds({ limit: 10, orderBy: 'runAt', order: 'desc' })).toEqual([
    String(otherQueue.job.id),
    String(versionTwo.job.id),
    String(unfinished.job.id),
    String(finished.job.id)
  ])
  expect(await listIds({ limit: 10, orderBy: 'finishedAt' })).toEqual([
    String(finished.job.id),
    String(unfinished.job.id),
    String(versionTwo.job.id),
    String(otherQueue.job.id)
  ])

  const finishedDescending = await resolve(
    store.list({ limit: 1, orderBy: 'finishedAt', order: 'desc' })
  )
  expect(finishedDescending.jobs[0]?.id).toBe(otherQueue.job.id)
  expect(finishedDescending.nextCursor?.value).toBeNull()
  if (finishedDescending.nextCursor === undefined) throw new Error('missing finishedAt cursor')
  const finishedDescendingPageTwo = await resolve(
    store.list({
      limit: 1,
      orderBy: 'finishedAt',
      order: 'desc',
      cursor: finishedDescending.nextCursor
    })
  )
  expect(finishedDescendingPageTwo.jobs[0]?.id).toBe(versionTwo.job.id)

  expect(await listIds({ queue, limit: 10 })).toEqual([
    String(finished.job.id),
    String(unfinished.job.id),
    String(versionTwo.job.id)
  ])
  expect(await listIds({ name: work, limit: 10 })).toHaveLength(3)
  expect(await listIds({ version: 2, limit: 10 })).toEqual([String(versionTwo.job.id)])
  expect(await listIds({ state: 'completed', limit: 10 })).toEqual([String(finished.job.id)])
  expect(await listIds({ metadata: { group: 'done' }, limit: 10 })).toEqual([
    String(finished.job.id)
  ])
  expect(await listIds({ metadata: { group: 'done', extra: 'nope' }, limit: 10 })).toEqual([])

  const mismatchedOrder = await store.list({
    limit: 1,
    orderBy: 'runAt',
    cursor: finishedDescending.nextCursor
  })
  expect(Result.isError(mismatchedOrder)).toBe(true)
  if (Result.isError(mismatchedOrder)) {
    expect(UnsupportedJobStoreOperationError.is(mismatchedOrder.error)).toBe(true)
  }
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
