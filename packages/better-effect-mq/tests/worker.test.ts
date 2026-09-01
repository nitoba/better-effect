import { expect, test } from 'bun:test'

import { CurrentAbortSignal, Effect, Layer, Runtime, Scope, Service } from 'better-effect'
import { Result } from 'better-result'

import {
  Codec,
  JobStore,
  type JobStoreError,
  MemoryJobStore,
  Queue,
  Worker,
  JobContext,
  JobName,
  makeJobId,
  WorkerAwaitIdleError,
  type JobRecord,
  type WorkerHandle
} from '../src'
import type { AnyJobDefinition, JobStoreOperation } from '../src'

class WorkerRoot extends Service<WorkerRoot>()('WorkerTestRoot') {
  readonly prefix!: string
}

const queue = Queue.define('worker-tests')
const payload = Codec.json<{ readonly value: number }>()
const numberResult = Codec.number
const voidResult = Codec.void
const failure = Codec.json<{ readonly code: string }>()

const successfulJob = queue.job('success', {
  version: 1,
  payload,
  result: numberResult
})

const voidJob = queue.job('void', {
  version: 1,
  payload,
  result: voidResult
})

const resolve = async <Value>(
  operation: JobStoreOperation<Value, JobStoreError>
): Promise<Value> => {
  const result = await operation

  if (Result.isError(result)) {
    throw result.error
  }

  return result.value
}

const enqueue = async (
  store: ReturnType<typeof MemoryJobStore.make>,
  job: AnyJobDefinition,
  value: number,
  now = Date.now(),
  metadata: Readonly<Record<string, string>> = {}
): Promise<JobRecord> =>
  (
    await resolve(
      store.enqueue({
        job: job.identity,
        payload: { value },
        runAt: now,
        attemptsMax: 1,
        metadata,
        now
      })
    )
  ).job

const runtimeFor = async (store: ReturnType<typeof MemoryJobStore.make>): Promise<Runtime<any>> =>
  Runtime.make(Layer.succeed(JobStore, JobStore.of(store)))

const idleWaiterCount = (worker: WorkerHandle): number => {
  // SAFETY: tests inspect the supervisor's private waiter set to verify prompt cleanup.
  const supervisor = worker as WorkerHandle & { readonly idleWaiters: Set<unknown> }
  return supervisor.idleWaiters.size
}

const makeTrackedSignal = (initialAborted = false) => {
  let aborted = initialAborted
  let reason: unknown
  const listeners = new Set<() => void>()
  let additions = 0
  let removals = 0

  const signal = {
    get aborted() {
      return aborted
    },
    get reason() {
      return reason
    },
    addEventListener(_type: string, listener: () => void) {
      additions += 1
      listeners.add(listener)
    },
    removeEventListener(_type: string, listener: () => void) {
      removals += 1
      listeners.delete(listener)
    }
  }

  return {
    // SAFETY: this object implements the AbortSignal members used by awaitIdle.
    signal: signal as AbortSignal,
    get additions() {
      return additions
    },
    get removals() {
      return removals
    },
    abort(nextReason: Error = new Error('tracked abort')) {
      reason = nextReason
      aborted = true
      for (const listener of listeners) {
        listener()
      }
    }
  }
}

const makeRejectedListenerSignal = (rejectAdd: boolean, rejectRemove: boolean) => {
  let additions = 0
  let removals = 0
  const listeners = new Set<() => void>()
  const signal = {
    aborted: false,
    addEventListener(_type: string, listener: () => void) {
      additions += 1
      if (rejectAdd) {
        return Promise.reject(new Error('add listener rejected'))
      }
      listeners.add(listener)
    },
    removeEventListener(_type: string, listener: () => void) {
      removals += 1
      if (rejectRemove) {
        return Promise.reject(new Error('remove listener rejected'))
      }
      listeners.delete(listener)
    }
  }

  return {
    // SAFETY: this object implements the AbortSignal members used by awaitIdle.
    signal: signal as AbortSignal,
    get additions() {
      return additions
    },
    get removals() {
      return removals
    }
  }
}

test('Worker executes a handler with root Services, JobContext, and CurrentAbortSignal', async () => {
  const store = MemoryJobStore.make()
  const runtime = await Runtime.make(
    Layer.merge(
      Layer.succeed(JobStore, JobStore.of(store)),
      Layer.succeed(WorkerRoot, WorkerRoot.of({ prefix: 'root' }))
    )
  )
  const created = await enqueue(store, successfulJob, 7, Date.now(), { tenant: 'acme' })
  let observed:
    | {
        readonly prefix: string
        readonly jobId: string
        readonly attempt: number
        readonly delivery: number
        readonly metadata: Readonly<Record<string, string>>
        readonly signal: AbortSignal
      }
    | undefined

  const handler = Worker.handle(successfulJob, (value) =>
    Effect.fn(async function* () {
      const root = yield* WorkerRoot
      const context = yield* JobContext
      const signal = yield* CurrentAbortSignal
      observed = {
        prefix: root.prefix,
        jobId: context.jobId,
        attempt: context.attempt,
        delivery: context.delivery,
        metadata: context.metadata,
        signal
      }
      return Result.ok(value.value * 2)
    })
  )

  const worker = await Worker.start(runtime, {
    handlers: [handler],
    pollIntervalMs: 1
  })

  try {
    await worker.awaitIdle({ timeoutMs: 2_000 })
    const record = await resolve(store.getJob({ jobId: created.id }))

    expect(record?.state).toBe('completed')
    expect(record?.result).toBe(14)
    expect(observed).toMatchObject({
      prefix: 'root',
      jobId: created.id,
      attempt: 1,
      delivery: 1,
      metadata: { tenant: 'acme' }
    })
    expect(observed?.signal).toBeInstanceOf(AbortSignal)
  } finally {
    await worker.stop()
    await runtime.dispose()
  }
})

test('Worker.awaitIdle validates options before installing wait resources', async () => {
  const store = MemoryJobStore.make()
  const runtime = await runtimeFor(store)
  await enqueue(store, voidJob, 1)
  let started!: () => void
  const entered = new Promise<void>((resolve) => {
    started = resolve
  })
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const handler = Worker.handle(voidJob, () =>
    // oxlint-disable-next-line require-yield -- the generator shape is part of the Effect API contract.
    Effect.fn(async function* () {
      started()
      await gate
      return Result.ok(undefined)
    })
  )
  const worker = await Worker.start(runtime, { handlers: [handler], pollIntervalMs: 1 })

  try {
    await entered
    // SAFETY: this intentionally malformed value tests the runtime validation boundary.
    expect(() => worker.awaitIdle({ signal: {} as AbortSignal })).toThrow(WorkerAwaitIdleError)
    expect(() => worker.awaitIdle({ timeoutMs: -1 })).toThrow(WorkerAwaitIdleError)
    expect(idleWaiterCount(worker)).toBe(0)

    const alreadyAborted = makeTrackedSignal(true)
    // oxlint-disable-next-line typescript/await-thenable -- Bun's rejection matcher is thenable at runtime.
    await expect(worker.awaitIdle({ signal: alreadyAborted.signal })).rejects.toBeInstanceOf(
      WorkerAwaitIdleError
    )
    expect(alreadyAborted.additions).toBe(0)
    expect(alreadyAborted.removals).toBe(0)
    expect(idleWaiterCount(worker)).toBe(0)

    const aborting = makeTrackedSignal()
    const aborted = worker.awaitIdle({ signal: aborting.signal })
    expect(aborting.additions).toBe(1)
    aborting.abort()
    // oxlint-disable-next-line typescript/await-thenable -- Bun's rejection matcher is thenable at runtime.
    await expect(aborted).rejects.toBeInstanceOf(WorkerAwaitIdleError)
    expect(aborting.removals).toBe(1)
    expect(idleWaiterCount(worker)).toBe(0)
  } finally {
    release()
    await worker.stop({ abortActive: true })
    await runtime.dispose()
  }
})

test('Worker.awaitIdle handles rejected listener thenables without retaining waiters', async () => {
  const store = MemoryJobStore.make()
  const runtime = await runtimeFor(store)
  await enqueue(store, voidJob, 1)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const handler = Worker.handle(voidJob, () =>
    // oxlint-disable-next-line require-yield -- the generator shape is part of the Effect API contract.
    Effect.fn(async function* () {
      await gate
      return Result.ok(undefined)
    })
  )
  const worker = await Worker.start(runtime, { handlers: [handler], pollIntervalMs: 1 })

  try {
    const addRejected = makeRejectedListenerSignal(true, false)
    const registration = worker.awaitIdle({ signal: addRejected.signal, timeoutMs: 2_000 })
    // oxlint-disable-next-line typescript/await-thenable -- Bun's rejection matcher is thenable at runtime.
    await expect(registration).rejects.toMatchObject({
      name: 'WorkerAwaitIdleError',
      reason: 'invalid-signal'
    })
    expect(addRejected.additions).toBe(1)
    expect(addRejected.removals).toBe(1)
    expect(idleWaiterCount(worker)).toBe(0)

    const removeRejected = makeRejectedListenerSignal(false, true)
    const timedOut = worker.awaitIdle({ signal: removeRejected.signal, timeoutMs: 0 })
    // oxlint-disable-next-line typescript/await-thenable -- Bun's rejection matcher is thenable at runtime.
    await expect(timedOut).rejects.toMatchObject({
      name: 'WorkerAwaitIdleError',
      reason: 'timeout'
    })
    expect(removeRejected.additions).toBe(1)
    expect(removeRejected.removals).toBe(1)
    expect(idleWaiterCount(worker)).toBe(0)
  } finally {
    release()
    await worker.stop({ abortActive: true })
    await runtime.dispose()
  }
})

test('Worker.awaitIdle cleans timed-out and successful waiters', async () => {
  const store = MemoryJobStore.make()
  const runtime = await runtimeFor(store)
  await enqueue(store, voidJob, 1)
  let started!: () => void
  const entered = new Promise<void>((resolve) => {
    started = resolve
  })
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const handler = Worker.handle(voidJob, () =>
    // oxlint-disable-next-line require-yield -- the generator shape is part of the Effect API contract.
    Effect.fn(async function* () {
      started()
      await gate
      return Result.ok(undefined)
    })
  )
  const worker = await Worker.start(runtime, { handlers: [handler], pollIntervalMs: 1 })

  try {
    await entered
    const timedOutSignal = makeTrackedSignal()
    const timedOut = worker.awaitIdle({ signal: timedOutSignal.signal, timeoutMs: 0 })
    // oxlint-disable-next-line typescript/await-thenable -- Bun's rejection matcher is thenable at runtime.
    await expect(timedOut).rejects.toMatchObject({
      name: 'WorkerAwaitIdleError',
      reason: 'timeout'
    })
    expect(timedOutSignal.additions).toBe(1)
    expect(timedOutSignal.removals).toBe(1)
    expect(idleWaiterCount(worker)).toBe(0)

    const successfulSignal = makeTrackedSignal()
    const idle = worker.awaitIdle({ signal: successfulSignal.signal, timeoutMs: 2_000 })
    release()
    await idle
    expect(successfulSignal.additions).toBe(1)
    expect(successfulSignal.removals).toBe(1)
    expect(idleWaiterCount(worker)).toBe(0)
    expect(worker.activeCount).toBe(0)
  } finally {
    release()
    await worker.stop()
    await runtime.dispose()
  }
})

test('Worker keeps active attempts within global concurrency', async () => {
  const store = MemoryJobStore.make()
  const runtime = await runtimeFor(store)
  const jobs = await Promise.all(
    Array.from({ length: 20 }, (_, index) => enqueue(store, voidJob, index))
  )
  let active = 0
  let maximum = 0

  const handler = Worker.handle(voidJob, () =>
    // oxlint-disable-next-line require-yield -- the generator shape is part of the Effect API contract.
    Effect.fn(async function* () {
      active += 1
      maximum = Math.max(maximum, active)
      await new Promise((resolve) => setTimeout(resolve, 4))
      active -= 1
      return Result.ok(undefined)
    })
  )
  const worker = await Worker.start(runtime, {
    handlers: [handler],
    concurrency: 3,
    pollIntervalMs: 1
  })

  try {
    await worker.awaitIdle({ timeoutMs: 3_000 })
    expect(maximum).toBeLessThanOrEqual(3)
    expect((await resolve(store.counts())).completed).toBe(jobs.length)
  } finally {
    await worker.stop()
    await runtime.dispose()
  }
})

test('Worker supplies an isolated JobContext to overlapping attempts', async () => {
  const store = MemoryJobStore.make()
  const runtime = await runtimeFor(store)
  await Promise.all([enqueue(store, successfulJob, 1), enqueue(store, successfulJob, 2)])
  const contexts: JobContext[] = []
  let resolveBoth!: () => void
  const both = new Promise<void>((resolve) => {
    resolveBoth = resolve
  })
  let entered = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })

  const handler = Worker.handle(successfulJob, () =>
    Effect.fn(async function* () {
      const context = yield* JobContext
      contexts.push(context)
      entered += 1
      if (entered === 2) resolveBoth()
      await gate
      return Result.ok(0)
    })
  )
  const worker = await Worker.start(runtime, {
    handlers: [handler],
    concurrency: 2,
    pollIntervalMs: 1
  })

  try {
    await Promise.race([
      both,
      new Promise((_, reject) => setTimeout(() => reject(new Error('overlap timeout')), 2_000))
    ])
    expect(contexts).toHaveLength(2)
    expect(contexts[0]).not.toBe(contexts[1])
    expect(new Set(contexts.map((context) => context.jobId)).size).toBe(2)
    release()
    await worker.awaitIdle({ timeoutMs: 2_000 })
  } finally {
    release()
    await worker.stop({ abortActive: true })
    await runtime.dispose()
  }
})

test('Worker settles success, typed Err, and defects after per-attempt cleanup', async () => {
  const store = MemoryJobStore.make()
  const runtime = await runtimeFor(store)
  const success = queue.job('cleanup-success', { version: 1, payload, result: voidResult, failure })
  const error = queue.job('cleanup-error', { version: 1, payload, result: voidResult, failure })
  const defect = queue.job('cleanup-defect', { version: 1, payload, result: voidResult, failure })
  await Promise.all([
    enqueue(store, success, 1),
    enqueue(store, error, 2),
    enqueue(store, defect, 3)
  ])
  const releases: Array<{ readonly name: string; readonly status: string }> = []
  const makeHandler = (job: typeof success | typeof error | typeof defect) =>
    Worker.handle(job, () =>
      Effect.fn(async function* () {
        const context = yield* JobContext
        Scope.current().addFinalizer((outcome) => {
          releases.push({ name: context.name, status: outcome.status })
        })

        if (context.name === error.name) {
          return Result.err({ code: 'typed' })
        }

        if (context.name === defect.name) {
          throw new Error('defect')
        }

        return Result.ok(undefined)
      })
    )
  const worker = await Worker.start(runtime, {
    handlers: [makeHandler(success), makeHandler(error), makeHandler(defect)],
    concurrency: 3,
    pollIntervalMs: 1
  })

  try {
    await worker.awaitIdle({ timeoutMs: 2_000 })
    const records = await Promise.all(
      [success, error, defect].map((job) =>
        resolve(store.list({ name: JobName.make(job.name).unwrap(), limit: 10 }))
      )
    )

    expect(records.map((page) => page.jobs[0]?.state)).toEqual(['completed', 'failed', 'failed'])
    expect(records[1]?.jobs[0]?.failure?.kind).toBe('typed')
    expect(records[2]?.jobs[0]?.failure?.kind).toBe('defect')
    expect(releases).toHaveLength(3)
    expect(
      releases.every((release) => release.status === 'success' || release.status === 'failure')
    ).toBe(true)
  } finally {
    await worker.stop()
    await runtime.dispose()
  }
})

test('Worker validates reliability options before starting supervision', async () => {
  const store = MemoryJobStore.make()
  const runtime = await runtimeFor(store)
  const handler = Worker.handle(voidJob, () =>
    Effect.fn(async function* () {
      yield* JobContext
      return Result.ok(undefined)
    })
  )

  // oxlint-disable-next-line typescript/await-thenable -- Bun's rejection matcher is thenable at runtime.
  await expect(
    Promise.resolve(
      Worker.start(runtime, {
        handlers: [handler],
        leaseDurationMs: 10,
        heartbeatIntervalMs: 10
      })
    )
  ).rejects.toThrow(/less than leaseDurationMs/)

  const worker = await Worker.start(runtime, {
    handlers: [handler],
    leaseDurationMs: 10,
    heartbeatIntervalMs: 1,
    stalledIntervalMs: 10,
    maxStalledCount: 0,
    pollIntervalMs: 0
  })
  await worker.stop()
  await runtime.dispose()
})

test('Worker validates duplicate handlers and repeated disposal', async () => {
  const store = MemoryJobStore.make()
  const runtime = await runtimeFor(store)
  const handler = Worker.handle(voidJob, () =>
    // oxlint-disable-next-line require-yield -- the generator shape is part of the Effect API contract.
    Effect.fn(async function* () {
      return Result.ok(undefined)
    })
  )

  // oxlint-disable-next-line typescript/await-thenable -- Bun's rejection matcher is thenable at runtime.
  await expect(Worker.start(runtime, { handlers: [handler, handler] })).rejects.toThrow(
    /duplicate handler/
  )

  const worker = await Worker.start(runtime, { handlers: [handler], pollIntervalMs: 1 })
  const first = worker.stop()
  const second = worker.stop()

  expect(first).toBe(second)
  await Promise.all([first, second, worker[Symbol.asyncDispose]()])
  expect(worker.state).toBe('stopped')
  await runtime.dispose()
})

test('Worker.use stops the Worker when its callback fails', async () => {
  const store = MemoryJobStore.make()
  const runtime = await runtimeFor(store)
  const handler = Worker.handle(voidJob, () =>
    // oxlint-disable-next-line require-yield -- the generator shape is part of the Effect API contract.
    Effect.fn(async function* () {
      return Result.ok(undefined)
    })
  )
  let worker: WorkerHandle | undefined
  const cause = new Error('owner failed')

  // oxlint-disable-next-line typescript/await-thenable -- Bun's rejection matcher is thenable at runtime.
  await expect(
    Worker.use(runtime, { handlers: [handler], pollIntervalMs: 1 }, async (started) => {
      worker = started
      throw cause
    })
  ).rejects.toBe(cause)

  expect(worker?.state).toBe('stopped')
  await runtime.dispose()
})

test('Worker bounds multi-handler claims by actually startable slots', async () => {
  const base = MemoryJobStore.make()
  const claimLimits: number[] = []
  const originalClaim = base.claim.bind(base)
  Object.defineProperty(base, 'claim', {
    value: (request: Parameters<typeof base.claim>[0]) => {
      claimLimits.push(request.limit)
      return originalClaim(request)
    }
  })
  const runtime = await Runtime.make(Layer.succeed(JobStore, JobStore.of(base)))
  const claimQueue = Queue.define('worker-claim-limits')
  const first = claimQueue.job('first', { version: 1, payload, result: voidResult })
  const second = claimQueue.job('second', { version: 1, payload, result: voidResult })

  await Promise.all([
    ...Array.from({ length: 10 }, (_, index) => enqueue(base, first, index)),
    ...Array.from({ length: 10 }, (_, index) => enqueue(base, second, index))
  ])

  const handler = (job: typeof first | typeof second) =>
    Worker.handle(
      job,
      () =>
        // oxlint-disable-next-line require-yield -- the generator shape is part of the Effect API contract.
        Effect.fn(async function* () {
          await new Promise((resolve) => setTimeout(resolve, 2))
          return Result.ok(undefined)
        }),
      { concurrency: 1 }
    )
  const worker = await Worker.start(runtime, {
    handlers: [handler(first), handler(second)],
    concurrency: 4,
    pollIntervalMs: 1
  })

  try {
    await worker.awaitIdle({ timeoutMs: 3_000 })
    expect(claimLimits.length).toBeGreaterThan(0)
    expect(Math.max(...claimLimits)).toBeLessThanOrEqual(2)
    expect((await resolve(base.counts())).completed).toBe(20)
  } finally {
    await worker.stop()
    await runtime.dispose()
  }
})

test('Workers for named stores share one Runtime without cross-store claims', async () => {
  const firstStore = MemoryJobStore.make()
  const secondStore = MemoryJobStore.make()
  const firstToken = JobStore.named('worker-store-a')
  const secondToken = JobStore.named('worker-store-b')
  const runtime = await Runtime.make(
    Layer.merge(
      Layer.succeed(firstToken, firstToken.of(firstStore)),
      Layer.succeed(secondToken, secondToken.of(secondStore))
    )
  )
  const firstQueue = Queue.define('worker-store-a-queue')
  const secondQueue = Queue.define('worker-store-b-queue')
  const firstJob = firstQueue.job('run', {
    version: 1,
    payload,
    result: Codec.string,
    store: firstToken
  })
  const secondJob = secondQueue.job('run', {
    version: 1,
    payload,
    result: Codec.string,
    store: secondToken
  })
  const [firstRecord, secondRecord] = await Promise.all([
    enqueue(firstStore, firstJob, 1),
    enqueue(secondStore, secondJob, 2)
  ])
  const makeHandler = (job: typeof firstJob | typeof secondJob) =>
    Worker.handle(job, () =>
      Effect.fn(async function* () {
        const context = yield* JobContext
        return Result.ok(context.name)
      })
    )
  const firstWorker = await Worker.start(runtime, {
    handlers: [makeHandler(firstJob)],
    pollIntervalMs: 1
  })
  const secondWorker = await Worker.start(runtime, {
    handlers: [makeHandler(secondJob)],
    pollIntervalMs: 1
  })

  try {
    await Promise.all([
      firstWorker.awaitIdle({ timeoutMs: 2_000 }),
      secondWorker.awaitIdle({ timeoutMs: 2_000 })
    ])
    expect((await resolve(firstStore.getJob({ jobId: firstRecord.id })))?.result).toBe('run')
    expect((await resolve(secondStore.getJob({ jobId: secondRecord.id })))?.result).toBe('run')
  } finally {
    await Promise.all([firstWorker.stop(), secondWorker.stop()])
    await runtime.dispose()
  }
})

test('Worker scopes heartbeat loss by store, job ID, and lease token', async () => {
  const firstStore = MemoryJobStore.make()
  const secondStore = MemoryJobStore.make()
  const firstToken = JobStore.named('heartbeat-store-a')
  const secondToken = JobStore.named('heartbeat-store-b')
  let firstHeartbeat!: () => void
  const firstHeartbeatSeen = new Promise<void>((resolve) => {
    firstHeartbeat = resolve
  })
  let releaseHeartbeat!: () => void
  const heartbeatResponseGate = new Promise<void>((resolve) => {
    releaseHeartbeat = resolve
  })
  const originalHeartbeat = firstStore.heartbeat.bind(firstStore)
  let secondSettledResolve!: () => void
  const secondSettled = new Promise<void>((resolveSettled) => {
    secondSettledResolve = resolveSettled
  })
  const originalSecondSettle = secondStore.settle.bind(secondStore)
  Object.defineProperty(secondStore, 'settle', {
    value: async (request: Parameters<typeof secondStore.settle>[0]) => {
      const result = await originalSecondSettle(request)
      secondSettledResolve()
      return result
    }
  })
  Object.defineProperty(firstStore, 'heartbeat', {
    value: async (request: Parameters<typeof firstStore.heartbeat>[0]) => {
      const result = await originalHeartbeat(request)
      firstHeartbeat()
      await heartbeatResponseGate
      if (Result.isError(result)) return result
      const lease = request.leases[0]
      return Result.ok({
        renewed: [],
        lost:
          lease === undefined
            ? []
            : [
                {
                  jobId: lease.jobId,
                  leaseToken: lease.leaseToken,
                  reason: 'mismatched-token' as const
                }
              ],
        cancellationRequested: []
      })
    }
  })
  const runtime = await Runtime.make(
    Layer.merge(
      Layer.succeed(firstToken, firstToken.of(firstStore)),
      Layer.succeed(secondToken, secondToken.of(secondStore))
    )
  )
  const firstJob = Queue.define('heartbeat-a').job('same-id-a', {
    version: 1,
    payload,
    result: voidResult,
    store: firstToken
  })
  const secondJob = Queue.define('heartbeat-b').job('same-id-b', {
    version: 1,
    payload,
    result: voidResult,
    store: secondToken
  })
  const sameId = makeJobId('heartbeat-same-id').unwrap()
  await Promise.all([
    resolve(
      firstStore.enqueue({
        id: sameId,
        job: firstJob.identity,
        payload: { value: 1 },
        runAt: Date.now(),
        attemptsMax: 1,
        now: Date.now()
      })
    ),
    resolve(
      secondStore.enqueue({
        id: sameId,
        job: secondJob.identity,
        payload: { value: 2 },
        runAt: Date.now(),
        attemptsMax: 1,
        now: Date.now()
      })
    )
  ])
  let entered = 0
  let enteredResolve!: () => void
  const enteredBoth = new Promise<void>((resolveEntered) => {
    enteredResolve = resolveEntered
  })
  let release!: () => void
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate
  })
  const makeHandler = (job: typeof firstJob | typeof secondJob) =>
    Worker.handle(job, () =>
      Effect.fn(async function* () {
        const signal = yield* CurrentAbortSignal
        signal.addEventListener('abort', () => {})
        entered += 1
        if (entered === 2) enteredResolve()
        await gate
        return Result.ok(undefined)
      })
    )
  const worker = await Worker.start(runtime, {
    handlers: [makeHandler(firstJob), makeHandler(secondJob)],
    concurrency: 2,
    leaseDurationMs: 100,
    heartbeatIntervalMs: 10,
    stalledIntervalMs: 1_000,
    pollIntervalMs: 1
  })

  try {
    await enteredBoth
    await firstHeartbeatSeen
    releaseHeartbeat()
    await Promise.resolve()
    release()
    await secondSettled
  } finally {
    release()
    await worker.stop()
    expect((await resolve(firstStore.getAttempts({ jobId: sameId }))).length).toBeGreaterThan(0)
    expect((await resolve(secondStore.getAttempts({ jobId: sameId }))).length).toBeGreaterThan(0)
    await runtime.dispose()
  }
})

test('Worker validates all stores before starting any claim loop', async () => {
  const base = MemoryJobStore.make()
  let claims = 0
  const originalClaim = base.claim.bind(base)
  Object.defineProperty(base, 'claim', {
    value: (request: Parameters<typeof base.claim>[0]) => {
      claims += 1
      return originalClaim(request)
    }
  })
  const runtime = await Runtime.make(Layer.succeed(JobStore, JobStore.of(base)))
  const uncheckedRuntime: Runtime<any> = runtime
  const missingToken = JobStore.named('worker-missing-store')
  const availableJob = Queue.define('worker-partial-available').job('run', {
    version: 1,
    payload,
    result: voidResult
  })
  const missingJob = Queue.define('worker-partial-missing').job('run', {
    version: 1,
    payload,
    result: voidResult,
    store: missingToken
  })
  const makeHandler = (job: typeof availableJob | typeof missingJob) =>
    Worker.handle(job, () =>
      // oxlint-disable-next-line require-yield -- the generator shape is part of the Effect API contract.
      Effect.fn(async function* () {
        return Result.ok(undefined)
      })
    )

  // oxlint-disable-next-line typescript/await-thenable -- Bun's rejection matcher is thenable at runtime.
  await expect(
    Worker.start(uncheckedRuntime, {
      handlers: [makeHandler(availableJob), makeHandler(missingJob)],
      pollIntervalMs: 1
    })
  ).rejects.toThrow()
  expect(claims).toBe(0)
  await runtime.dispose()
})

test('Worker shares global slots across independent store and queue groups', async () => {
  const firstStore = MemoryJobStore.make()
  const secondStore = MemoryJobStore.make()
  const firstToken = JobStore.named('worker-global-a')
  const secondToken = JobStore.named('worker-global-b')
  const runtime = await Runtime.make(
    Layer.merge(
      Layer.succeed(firstToken, firstToken.of(firstStore)),
      Layer.succeed(secondToken, secondToken.of(secondStore))
    )
  )
  const firstJob = Queue.define('worker-global-a-queue').job('run', {
    version: 1,
    payload,
    result: voidResult,
    store: firstToken
  })
  const secondJob = Queue.define('worker-global-b-queue').job('run', {
    version: 1,
    payload,
    result: voidResult,
    store: secondToken
  })
  await Promise.all([
    ...Array.from({ length: 6 }, (_, index) => enqueue(firstStore, firstJob, index)),
    ...Array.from({ length: 6 }, (_, index) => enqueue(secondStore, secondJob, index))
  ])
  let active = 0
  let maximum = 0
  const makeHandler = (job: typeof firstJob | typeof secondJob) =>
    Worker.handle(job, () =>
      // oxlint-disable-next-line require-yield -- the generator shape is part of the Effect API contract.
      Effect.fn(async function* () {
        active += 1
        maximum = Math.max(maximum, active)
        await new Promise((resolve) => setTimeout(resolve, 2))
        active -= 1
        return Result.ok(undefined)
      })
    )
  const worker = await Worker.start(runtime, {
    handlers: [makeHandler(firstJob), makeHandler(secondJob)],
    concurrency: 2,
    pollIntervalMs: 1
  })

  try {
    await worker.awaitIdle({ timeoutMs: 3_000 })
    expect(maximum).toBeLessThanOrEqual(2)
    expect((await resolve(firstStore.counts())).completed).toBe(6)
    expect((await resolve(secondStore.counts())).completed).toBe(6)
  } finally {
    await worker.stop()
    await runtime.dispose()
  }
})

test('Worker observer attributes identify exactly one Runtime attempt per job', async () => {
  const store = MemoryJobStore.make()
  const starts: Array<{ readonly id: unknown; readonly name: unknown }> = []
  const ends: Array<{ readonly id: unknown; readonly name: unknown }> = []
  const runtime = await Runtime.make(Layer.succeed(JobStore, JobStore.of(store)), {
    observers: [
      {
        onExecutionStart: (event) => {
          if (event.attributes?.jobId !== undefined) {
            starts.push({ id: event.attributes.jobId, name: event.attributes.name })
          }
        },
        onExecutionEnd: (event) => {
          if (event.attributes?.jobId !== undefined) {
            ends.push({ id: event.attributes.jobId, name: event.attributes.name })
          }
        }
      }
    ]
  })
  const jobs = await Promise.all(
    Array.from({ length: 3 }, (_, index) => enqueue(store, successfulJob, index))
  )
  const handler = Worker.handle(successfulJob, (value) =>
    // oxlint-disable-next-line require-yield -- the generator shape is part of the Effect API contract.
    Effect.fn(async function* () {
      return Result.ok(value.value)
    })
  )
  const worker = await Worker.start(runtime, {
    handlers: [handler],
    concurrency: 2,
    pollIntervalMs: 1
  })

  try {
    await worker.awaitIdle({ timeoutMs: 2_000 })
    expect(starts).toHaveLength(jobs.length)
    expect(ends).toHaveLength(jobs.length)
    expect(new Set(starts.map((execution) => execution.id)).size).toBe(jobs.length)
    expect(new Set(ends.map((execution) => execution.id)).size).toBe(jobs.length)
    expect(starts.every((execution) => execution.name === successfulJob.name)).toBe(true)
    expect(ends.every((execution) => execution.name === successfulJob.name)).toBe(true)
  } finally {
    await worker.stop()
    await runtime.dispose()
  }
})
