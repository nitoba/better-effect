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
