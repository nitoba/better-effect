import { expect, test } from 'bun:test'

import {
  JobStore,
  MemoryJobStore,
  Queue,
  QueueControls,
  makeJobId,
  makeQueueName,
  makeWorkerId
} from '../src'
import { Effect, Runtime } from 'better-effect'
import { ClockTest } from 'better-effect/standard-services'
import { Result } from 'better-result'
import type { JobStoreError, JobStoreOperation } from '../src'

const resolve = async <Value>(
  operation: JobStoreOperation<Value, JobStoreError>
): Promise<Value> => {
  const result = await operation
  if (Result.isError(result)) throw result.error
  return result.value
}

const identity = { queue: 'controlled', name: 'export', version: 1 } as const

test('MemoryJobStore claims with global, per-key, and fixed-window controls atomically', async () => {
  const queue = Queue.define('controlled')
  const controls = QueueControls.define(queue, {
    globalConcurrency: 1,
    concurrencyKey: { derive: (payload: { readonly tenant: string }) => payload.tenant, max: 1 },
    rateLimit: { max: 2, durationMs: 100 }
  })
  const registry = QueueControls.registry({ group: 'exports', controls: [controls] })
  const store = MemoryJobStore.make()

  const report = await resolve(store.reconcile(registry))
  expect(report.records[0]?.revision).toBe(1)

  const first = await resolve(
    store.enqueue({
      job: identity,
      payload: { tenant: 'a', value: 1 },
      dispatchKey: 'a',
      runAt: 0,
      attemptsMax: 1,
      now: 0
    })
  )
  const second = await resolve(
    store.enqueue({
      job: identity,
      payload: { tenant: 'b', value: 2 },
      dispatchKey: 'b',
      runAt: 0,
      attemptsMax: 1,
      now: 0
    })
  )

  const claimed = await resolve(
    store.claimControlled({
      queue: makeQueueName('controlled').unwrap(),
      accepted: [identity],
      limit: 2,
      workerId: makeWorkerId('worker').unwrap(),
      leaseDurationMs: 10,
      now: 0,
      controlsRevision: 1
    })
  )
  expect(claimed.jobs.map((job) => job.id)).toEqual([first.job.id])
  expect(claimed.reason).toBeUndefined()

  const empty = await resolve(
    store.claimControlled({
      queue: makeQueueName('controlled').unwrap(),
      accepted: [identity],
      limit: 2,
      workerId: makeWorkerId('worker-2').unwrap(),
      leaseDurationMs: 10,
      now: 0,
      controlsRevision: 1
    })
  )
  expect(empty.jobs).toHaveLength(0)
  expect(empty.reason).toBe('global-concurrency')
  expect(second.job.dispatchKey).toBe('b')
})

test('controlled limits include jobs claimed before controls were enabled', async () => {
  const queue = Queue.define('legacy-active')
  const store = MemoryJobStore.make()
  const acceptedIdentity = { queue: 'legacy-active', name: 'work', version: 1 } as const
  const accepted = [acceptedIdentity]
  const first = await resolve(
    store.enqueue({
      job: acceptedIdentity,
      payload: {},
      runAt: 0,
      attemptsMax: 1,
      now: 0
    })
  )
  const second = await resolve(
    store.enqueue({
      job: acceptedIdentity,
      payload: {},
      runAt: 0,
      attemptsMax: 1,
      now: 0
    })
  )
  const legacyClaim = await resolve(
    store.claim({
      queue: makeQueueName('legacy-active').unwrap(),
      accepted,
      limit: 1,
      workerId: makeWorkerId('legacy-worker').unwrap(),
      leaseDurationMs: 10,
      now: 0
    })
  )
  const controls = QueueControls.define(queue, { globalConcurrency: 1 })
  await resolve(store.reconcile(QueueControls.registry({ group: 'g', controls: [controls] })))

  const legacyBypass = await store.claim({
    queue: makeQueueName('legacy-active').unwrap(),
    accepted,
    limit: 1,
    workerId: makeWorkerId('legacy-worker-2').unwrap(),
    leaseDurationMs: 10,
    now: 0
  })
  expect(Result.isError(legacyBypass)).toBe(true)

  const blocked = await resolve(
    store.claimControlled({
      queue: makeQueueName('legacy-active').unwrap(),
      accepted,
      limit: 1,
      workerId: makeWorkerId('controlled-worker').unwrap(),
      leaseDurationMs: 10,
      now: 0,
      controlsRevision: 1
    })
  )
  expect(blocked.reason).toBe('global-concurrency')

  await resolve(
    store.settle({
      jobId: first.job.id,
      leaseToken: legacyClaim.jobs[0]!.leaseToken,
      outcome: { type: 'complete' },
      now: 1
    })
  )
  const claimed = await resolve(
    store.claimControlled({
      queue: makeQueueName('legacy-active').unwrap(),
      accepted,
      limit: 1,
      workerId: makeWorkerId('controlled-worker').unwrap(),
      leaseDurationMs: 10,
      now: 1,
      controlsRevision: 1
    })
  )
  expect(claimed.jobs[0]?.id).toBe(second.job.id)
})

test('controlled claims reject re-entry while generating a lease token', async () => {
  const queue = Queue.define('reentrant-controlled')
  let store: ReturnType<typeof MemoryJobStore.make> | undefined
  let generated = 0
  let nested: JobStoreOperation<unknown, JobStoreError> | undefined
  store = MemoryJobStore.make({
    idGenerator: () => {
      generated += 1
      if (generated === 2) {
        nested = store!.claimControlled({
          queue: makeQueueName('reentrant-controlled').unwrap(),
          accepted: [{ queue: 'reentrant-controlled', name: 'work', version: 1 }],
          limit: 1,
          workerId: makeWorkerId('nested-worker').unwrap(),
          leaseDurationMs: 10,
          now: 0,
          controlsRevision: 1
        })
      }
      return generated === 1 ? 'job-1' : 'lease-1'
    }
  })
  await resolve(
    store.enqueue({
      job: { queue: 'reentrant-controlled', name: 'work', version: 1 },
      payload: {},
      runAt: 0,
      attemptsMax: 1,
      now: 0
    })
  )
  await resolve(
    store.reconcile(QueueControls.registry({ group: 'g', controls: [QueueControls.define(queue)] }))
  )
  const claimed = await resolve(
    store.claimControlled({
      queue: makeQueueName('reentrant-controlled').unwrap(),
      accepted: [{ queue: 'reentrant-controlled', name: 'work', version: 1 }],
      limit: 1,
      workerId: makeWorkerId('worker').unwrap(),
      leaseDurationMs: 10,
      now: 0,
      controlsRevision: 1
    })
  )
  expect(nested).toBeDefined()
  if (nested !== undefined) expect(Result.isError(await nested)).toBe(true)
  expect(claimed.jobs).toHaveLength(1)
})

test('controlled settlement releases only its own permit and fixed windows do not refund', async () => {
  const queue = Queue.define('settlement')
  const controls = QueueControls.define(queue, {
    globalConcurrency: 1,
    rateLimit: { max: 1, durationMs: 10 }
  })
  const store = MemoryJobStore.make()
  const report = await resolve(
    store.reconcile(QueueControls.registry({ group: 'g', controls: [controls] }))
  )
  const created = await resolve(
    store.enqueue({
      job: { queue: 'settlement', name: 'work', version: 1 },
      payload: {},
      runAt: 0,
      attemptsMax: 1,
      now: 0
    })
  )
  const claim = await resolve(
    store.claimControlled({
      queue: makeQueueName('settlement').unwrap(),
      accepted: [{ queue: 'settlement', name: 'work', version: 1 }],
      limit: 1,
      workerId: makeWorkerId('worker').unwrap(),
      leaseDurationMs: 10,
      now: 0,
      controlsRevision: report.records[0]!.revision
    })
  )
  const active = claim.jobs[0]!
  await resolve(
    store.settleControlled({
      jobId: makeJobId(created.job.id).unwrap(),
      leaseToken: active.leaseToken,
      outcome: { type: 'complete' },
      now: 1,
      controlsRevision: 1
    })
  )

  const next = await resolve(
    store.enqueue({
      job: { queue: 'settlement', name: 'work', version: 1 },
      payload: {},
      runAt: 1,
      attemptsMax: 1,
      now: 1
    })
  )
  expect(next.job.dispatchKey).toBeUndefined()
  const blocked = await resolve(
    store.claimControlled({
      queue: makeQueueName('settlement').unwrap(),
      accepted: [{ queue: 'settlement', name: 'work', version: 1 }],
      limit: 1,
      workerId: makeWorkerId('worker').unwrap(),
      leaseDurationMs: 10,
      now: 1,
      controlsRevision: 1
    })
  )
  expect(blocked.reason).toBe('rate-limited')
})

test('QueueControls reconciliation is idempotent and revision mismatches fail closed', async () => {
  const queue = Queue.define('revision')
  const controls = QueueControls.define(queue, { globalConcurrency: 2 })
  const store = MemoryJobStore.make()
  const registry = QueueControls.registry({ group: 'g', controls: [controls] })
  expect((await resolve(store.reconcile(registry))).records[0]?.revision).toBe(1)
  expect((await resolve(store.reconcile(registry))).records[0]?.revision).toBe(1)

  const result = await store.claimControlled({
    queue: makeQueueName('revision').unwrap(),
    accepted: [],
    limit: 1,
    workerId: makeWorkerId('worker').unwrap(),
    leaseDurationMs: 10,
    now: 0,
    controlsRevision: 99
  })
  expect(result.isErr()).toBe(true)
})

test('named stores keep controlled state isolated', () => {
  const named = JobStore.named('controlled')
  expect(named.serviceTag).toBe('@better-effect/mq/JobStore/controlled')
  expect(MemoryJobStore.layerFor(named)).toBeDefined()
})

test('per-key permits are isolated, rotation skips a full key, and stale tokens are fenced', async () => {
  const queue = Queue.define('fairness')
  const controls = QueueControls.define(queue, {
    perKeyConcurrency: 1,
    concurrencyKey: { derive: (payload: { readonly key: string }) => payload.key, max: 1 }
  })
  const store = MemoryJobStore.make()
  await resolve(store.reconcile(QueueControls.registry({ group: 'g', controls: [controls] })))
  const enqueue = async (id: string, key: string) =>
    resolve(
      store.enqueue({
        id: makeJobId(id).unwrap(),
        job: { queue: 'fairness', name: 'work', version: 1 },
        payload: { key },
        dispatchKey: key,
        runAt: 0,
        attemptsMax: 2,
        now: 0
      })
    )
  const a1 = await enqueue('a-1', 'a')
  const a2 = await enqueue('a-2', 'a')
  const b1 = await enqueue('b-1', 'b')
  const first = await resolve(
    store.claimControlled({
      queue: makeQueueName('fairness').unwrap(),
      accepted: [{ queue: 'fairness', name: 'work', version: 1 }],
      limit: 3,
      workerId: makeWorkerId('worker').unwrap(),
      leaseDurationMs: 10,
      now: 0,
      controlsRevision: 1
    })
  )
  expect(first.jobs.map((job) => job.id)).toEqual([a1.job.id, b1.job.id])
  await resolve(
    store.settleControlled({
      jobId: a1.job.id,
      leaseToken: first.jobs.find((job) => job.id === a1.job.id)!.leaseToken,
      outcome: { type: 'retry', runAt: 0 },
      now: 0,
      controlsRevision: 1
    })
  )
  const second = await resolve(
    store.claimControlled({
      queue: makeQueueName('fairness').unwrap(),
      accepted: [{ queue: 'fairness', name: 'work', version: 1 }],
      limit: 1,
      workerId: makeWorkerId('worker-2').unwrap(),
      leaseDurationMs: 10,
      now: 0,
      controlsRevision: 1
    })
  )
  expect(second.jobs[0]?.id).toBe(a2.job.id)
  const stale = await store.releaseControlled({
    jobId: a1.job.id,
    leaseToken: first.jobs.find((job) => job.id === a1.job.id)!.leaseToken,
    now: 0,
    controlsRevision: 1
  })
  expect(Result.isError(stale)).toBe(true)
  expect(a2.job.dispatchKey).toBe('a')
})

test('controlled pause and cancellation retain the permit until settlement', async () => {
  const queue = Queue.define('pause')
  const controls = QueueControls.define(queue, { globalConcurrency: 1 })
  const store = MemoryJobStore.make()
  await resolve(store.reconcile(QueueControls.registry({ group: 'g', controls: [controls] })))
  const created = await resolve(
    store.enqueue({
      job: { queue: 'pause', name: 'work', version: 1 },
      payload: {},
      runAt: 0,
      attemptsMax: 1,
      now: 0
    })
  )
  const claimed = await resolve(
    store.claimControlled({
      queue: makeQueueName('pause').unwrap(),
      accepted: [{ queue: 'pause', name: 'work', version: 1 }],
      limit: 1,
      workerId: makeWorkerId('worker').unwrap(),
      leaseDurationMs: 10,
      now: 0,
      controlsRevision: 1
    })
  )
  const active = claimed.jobs[0]!
  await resolve(store.cancelControlled({ jobId: created.job.id, now: 1, controlsRevision: 1 }))
  const stillBlocked = await resolve(
    store.claimControlled({
      queue: makeQueueName('pause').unwrap(),
      accepted: [{ queue: 'pause', name: 'work', version: 1 }],
      limit: 1,
      workerId: makeWorkerId('worker-2').unwrap(),
      leaseDurationMs: 10,
      now: 1,
      controlsRevision: 1
    })
  )
  expect(stillBlocked.reason).toBe('global-concurrency')
  await resolve(
    store.settleControlled({
      jobId: active.id,
      leaseToken: active.leaseToken,
      outcome: { type: 'complete' },
      now: 2,
      controlsRevision: 1
    })
  )
  await resolve(store.pause({ queue: makeQueueName('pause').unwrap(), now: 2 }))
  const paused = await resolve(
    store.claimControlled({
      queue: makeQueueName('pause').unwrap(),
      accepted: [{ queue: 'pause', name: 'work', version: 1 }],
      limit: 1,
      workerId: makeWorkerId('worker-3').unwrap(),
      leaseDurationMs: 10,
      now: 2,
      controlsRevision: 1
    })
  )
  expect(paused.reason).toBe('paused')
})

test('QueueControls.reconcile is a yieldable operation supplied by a Layer', async () => {
  const queue = Queue.define('layered-controls')
  const controls = QueueControls.define(queue, { globalConcurrency: 1 })
  const store = MemoryJobStore.make()
  const runtimeResult = await Runtime.run(
    QueueControls.layer(() => store),
    () =>
      Effect.gen(async function* () {
        const report = yield* QueueControls.reconcile(
          QueueControls.registry({ group: 'layer', controls: [controls] })
        )
        return Result.ok(report.records[0]?.revision)
      })
  )
  expect(runtimeResult.unwrap()).toBe(1)
})

test('stalled recovery releases its permit and a fixed window resets at the boundary', async () => {
  const clock = new ClockTest(0)
  const queue = Queue.define('recovery')
  const controls = QueueControls.define(queue, {
    globalConcurrency: 1,
    rateLimit: { max: 1, durationMs: 10 }
  })
  const store = MemoryJobStore.make({ clock })
  await resolve(store.reconcile(QueueControls.registry({ group: 'g', controls: [controls] })))
  const created = await resolve(
    store.enqueue({
      job: { queue: 'recovery', name: 'work', version: 1 },
      payload: {},
      runAt: 0,
      attemptsMax: 2,
      now: 0
    })
  )
  const claim = await resolve(
    store.claimControlled({
      queue: makeQueueName('recovery').unwrap(),
      accepted: [{ queue: 'recovery', name: 'work', version: 1 }],
      limit: 1,
      workerId: makeWorkerId('worker').unwrap(),
      leaseDurationMs: 10,
      now: 0,
      controlsRevision: 1
    })
  )
  expect(claim.jobs[0]?.id).toBe(created.job.id)
  clock.setTime(10)
  const recovery = await resolve(
    store.recoverStalledControlled({
      queue: makeQueueName('recovery').unwrap(),
      maxStalledCount: 1,
      now: 10,
      controlsRevision: 1
    })
  )
  expect(recovery.recovered).toBe(1)
  const redelivery = await resolve(
    store.claimControlled({
      queue: makeQueueName('recovery').unwrap(),
      accepted: [{ queue: 'recovery', name: 'work', version: 1 }],
      limit: 1,
      workerId: makeWorkerId('worker-2').unwrap(),
      leaseDurationMs: 10,
      now: 10,
      controlsRevision: 1
    })
  )
  expect(redelivery.jobs[0]?.id).toBe(created.job.id)
})
