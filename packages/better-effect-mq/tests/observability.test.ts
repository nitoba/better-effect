// oxlint-disable require-yield -- generator fixtures exercise the public Effect handler shape.
// oxlint-disable anti-slop/no-chained-type-assertions -- event fixtures cross the branded test boundary.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- assertions model intentionally erased test fixtures.
import { expect, test } from 'bun:test'
import { CurrentAbortSignal, Effect, Layer, Runtime } from 'better-effect'
import type { RuntimeExecutionStartEvent, RuntimeObserver } from 'better-effect'
import { Clock, ClockTest } from 'better-effect/standard-services'
import { Result } from 'better-result'

import {
  Codec,
  Job,
  JobAdmin,
  JobMetricNames,
  JobObserver,
  makeJobDepthSampler,
  JobStore,
  JobDefinitionError,
  MemoryJobStore,
  Queue,
  Worker
} from '../src'
import { RecordedJobObserver } from '../src/testing'
import type {
  JobEvent,
  JobLogEvent,
  JobMetricsSink,
  JobStoreError,
  JobStoreOperation
} from '../src'

const queue = Queue.define('observability-tests')
const payload = Codec.json<{ readonly value: number }>()
const successJob = queue.job('success', { version: 1, payload, result: Codec.number })
const failureJob = queue.job('failure', {
  version: 1,
  payload,
  result: Codec.number,
  failure: Codec.json<{ readonly code: string }>(),
  retryable: () => true,
  defaults: { attempts: 2 }
})

const resolve = async <Value, Failure extends JobStoreError>(
  operation: JobStoreOperation<Value, Failure>
): Promise<Value> => {
  const result = await operation
  if (Result.isError(result)) throw result.error
  return result.value
}

const makeRuntime = async (
  store: ReturnType<typeof MemoryJobStore.make>,
  observers: readonly RuntimeObserver[] = []
) => {
  const clock = new ClockTest(0)
  return Runtime.make(
    Layer.merge(Layer.succeed(JobStore, JobStore.of(store)), Layer.succeed(Clock, clock)),
    { observers }
  )
}

const enqueue = async (
  store: ReturnType<typeof MemoryJobStore.make>,
  job: typeof successJob | typeof failureJob,
  value = 1,
  attemptsMax = 1
) =>
  resolve(
    store.enqueue({
      job: job.identity,
      payload: { value },
      runAt: 0,
      attemptsMax,
      metadata: { tenant: 'acme' },
      now: 0
    })
  ).then(({ job: record }) => record)

const eventTypes = (observer: RecordedJobObserver): string[] =>
  observer.events.map((event) => event.type)

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let index = 0; index < 200 && !predicate(); index += 1) {
    await Promise.resolve()
  }
  if (!predicate()) throw new Error('condition was not reached')
}

test('JobObserver composes in order, isolates failures, and exposes immutable snapshots', async () => {
  const calls: string[] = []
  const first = {
    onEvent: () => {
      calls.push('first')
      throw new Error('observer failure')
    }
  }
  const second = {
    onEvent: () => {
      calls.push('second')
      return Promise.reject(new Error('async observer failure'))
    }
  }
  const third = {
    onEvent: () => {
      calls.push('third')
    }
  }
  const composed = JobObserver.compose(first, second, third)
  const event = { type: 'worker-started', recordedAt: 1, workerId: 'worker' as never } as JobEvent

  expect(() => composed.onEvent(event)).not.toThrow()
  expect(calls).toEqual(['first', 'second', 'third'])
  expect(Object.isFrozen(composed)).toBe(true)
  expect(JobObserver.compose().onEvent).toBeDefined()

  const recorded = RecordedJobObserver.make()
  recorded.onEvent(event)
  const snapshot = recorded.snapshot()
  expect(Object.isFrozen(snapshot)).toBe(true)
  expect(Object.isFrozen(snapshot[0])).toBe(true)
  expect(() => (snapshot as JobEvent[]).pop()).toThrow()
  recorded.clear()
  expect(snapshot).toHaveLength(1)
  expect(recorded.events).toHaveLength(0)
})

test('Job.observe and JobAdmin.observe isolate bindings and emit producer/admin events', async () => {
  const store = MemoryJobStore.make()
  const jobObserver = RecordedJobObserver.make()
  const adminObserver = RecordedJobObserver.make()
  const observedJob = Job.observe(successJob, jobObserver)
  const runtime = await makeRuntime(store)

  try {
    const id = await runtime.run(() =>
      Effect.gen(async function* () {
        return Result.ok(yield* observedJob.enqueue({ value: 3 }))
      })
    )
    expect(Result.isOk(id)).toBe(true)
    if (Result.isError(id)) return
    const cancelled = await runtime.run(() =>
      Effect.gen(async function* () {
        return Result.ok(yield* observedJob.cancel(String(id.value)))
      })
    )
    expect(Result.isOk(cancelled)).toBe(true)
    const admin = JobAdmin.observe(adminObserver).for(JobStore)
    const counts = await runtime.run(() =>
      Effect.gen(async function* () {
        return Result.ok(yield* admin.counts('observability-tests'))
      })
    )
    expect(Result.isOk(counts)).toBe(true)
    expect(eventTypes(jobObserver)).toEqual(['enqueued', 'cancelled'])
    expect(eventTypes(adminObserver)).toEqual([])
    const listed = await runtime.run(() =>
      Effect.gen(async function* () {
        return Result.ok(yield* admin.list({ queue: 'observability-tests' }))
      })
    )
    expect(Result.isOk(listed)).toBe(true)
    expect(eventTypes(adminObserver)).toEqual([])
  } finally {
    await runtime.dispose()
  }
})

test('observability validates public observer constraints', () => {
  expect(() => Job.observe(successJob, null as never)).toThrow(JobDefinitionError)
  expect(() => JobAdmin.observe({} as never)).toThrow(JobDefinitionError)
  expect(() => JobObserver.metrics({} as never)).not.toThrow()
})

test('RecordedJobObserver records a detached timeline and freezes direct payloads', () => {
  const observer = RecordedJobObserver.make()
  const event = { type: 'worker-stopped', recordedAt: 2, workerId: 'worker' as never } as JobEvent
  observer.onEvent(event)
  const first = observer.events
  const second = observer.events
  expect(first).not.toBe(second)
  expect(first).toEqual(second)
  expect(Object.isFrozen(first)).toBe(true)
  expect(Object.isFrozen(event)).toBe(true)
})

test('Worker success lifecycle emits completion only after start', async () => {
  const store = MemoryJobStore.make()
  const observer = RecordedJobObserver.make()
  const runtime = await makeRuntime(store)
  await enqueue(store, successJob)
  const worker = await Worker.startWith(runtime.executor, {
    handlers: [
      Worker.handle(successJob, (value) =>
        Effect.fn(async function* () {
          return Result.ok(value.value)
        })
      )
    ],
    observer,
    pollIntervalMs: 1
  })

  try {
    await worker.awaitIdle({ timeoutMs: 2_000 })
    await worker.stop()
    const types = eventTypes(observer)
    if (!types.includes('completed')) throw new Error(`success events: ${types.join(',')}`)
    expect(types[0]).toBe('worker-started')
    expect(types).toContain('claimed')
    expect(types).toContain('started')
    expect(types.indexOf('started')).toBeLessThan(types.indexOf('completed'))
    expect(types).not.toContain('released')
    expect(types.at(-2)).toBe('worker-stopping')
    expect(types.at(-1)).toBe('worker-stopped')
    const forbidden = [
      'payload',
      'result',
      'metadata',
      'idempotencyKey',
      'leaseToken',
      'cause',
      'failure',
      'data'
    ]
    expect(observer.events.every((event) => forbidden.every((key) => !(key in event)))).toBe(true)
  } finally {
    await runtime.dispose()
  }
})

test('Worker preserves per-job event ordering for concurrent attempts', async () => {
  const store = MemoryJobStore.make()
  const observer = RecordedJobObserver.make()
  const runtime = await makeRuntime(store)
  const jobs = await Promise.all([enqueue(store, successJob, 1), enqueue(store, successJob, 2)])
  const releases = new Map<number, () => void>()
  let enteredCount = 0
  let allEntered!: () => void
  const allEnteredPromise = new Promise<void>((resolve) => {
    allEntered = resolve
  })
  const worker = await Worker.startWith(runtime.executor, {
    handlers: [
      Worker.handle(successJob, (value) =>
        Effect.fn(async function* () {
          enteredCount += 1
          const gate = new Promise<void>((resolve) => {
            releases.set(value.value, resolve)
          })
          if (enteredCount === jobs.length) allEntered()
          await gate
          return Result.ok(value.value)
        })
      )
    ],
    observer,
    concurrency: 2,
    pollIntervalMs: 1
  })

  try {
    await allEnteredPromise
    for (const value of [1, 2]) releases.get(value)?.()
    await worker.awaitIdle({ timeoutMs: 2_000 })
    for (const job of jobs) {
      expect(
        observer.events.filter((event) => event.jobId === job.id).map((event) => event.type)
      ).toEqual(['claimed', 'started', 'completed'])
    }
  } finally {
    await worker.stop()
    await runtime.dispose()
  }
})

test('Worker retry and terminal failure events carry attempt outcome ordering', async () => {
  const store = MemoryJobStore.make()
  const observer = RecordedJobObserver.make()
  const runtime = await makeRuntime(store)
  await enqueue(store, failureJob, 1, 2)
  let attempts = 0
  const worker = await Worker.startWith(runtime.executor, {
    handlers: [
      Worker.handle(failureJob, () =>
        Effect.fn(async function* () {
          attempts += 1
          return Result.err(attempts === 1 ? { code: 'retry' } : { code: 'failed' })
        })
      )
    ],
    observer,
    pollIntervalMs: 1
  })

  try {
    await worker.awaitIdle({ timeoutMs: 2_000 })
    const types = eventTypes(observer)
    if (!types.includes('failed')) throw new Error(`failure events: ${types.join(',')}`)
    expect(types.filter((type) => type === 'started')).toHaveLength(2)
    expect(types.filter((type) => type === 'retry-scheduled')).toHaveLength(1)
    expect(types.filter((type) => type === 'failed')).toHaveLength(1)
    expect(types.indexOf('retry-scheduled')).toBeLessThan(types.lastIndexOf('started'))
    expect(types.indexOf('started')).toBeLessThan(types.indexOf('failed'))
  } finally {
    await worker.stop()
    await runtime.dispose()
  }
})

test('Worker does not await slow observers', async () => {
  const store = MemoryJobStore.make()
  const runtime = await makeRuntime(store)
  await enqueue(store, successJob)
  const seen: JobEvent[] = []
  const observer = {
    onEvent: (event: JobEvent) => {
      seen.push(event)
      return new Promise<void>(() => undefined)
    }
  }
  const worker = await Worker.startWith(runtime.executor, {
    handlers: [
      Worker.handle(successJob, (value) =>
        Effect.fn(async function* () {
          return Result.ok(value.value)
        })
      )
    ],
    observer,
    pollIntervalMs: 1
  })

  try {
    await worker.awaitIdle({ timeoutMs: 2_000 })
    expect(seen.some((event) => event.type === 'completed')).toBe(true)
  } finally {
    await worker.stop()
    await runtime.dispose()
  }
})

test('Worker reports uncertain settlement without a false completion event', async () => {
  const store = MemoryJobStore.make()
  const originalSettle = store.settle.bind(store)
  let settleStarted!: () => void
  const started = new Promise<void>((resolve) => {
    settleStarted = resolve
  })
  Object.defineProperty(store, 'settle', {
    value: (_request: Parameters<typeof store.settle>[0]) => {
      settleStarted()
      // SAFETY: this fault fixture deliberately models an adapter call that never settles.
      return new Promise<never>(() => undefined) as ReturnType<typeof originalSettle>
    }
  })
  const runtime = await makeRuntime(store)
  const created = await enqueue(store, successJob)
  const observer = RecordedJobObserver.make()
  const worker = await Worker.startWith(runtime.executor, {
    handlers: [
      Worker.handle(successJob, (value) =>
        Effect.fn(async function* () {
          return Result.ok(value.value)
        })
      )
    ],
    observer,
    leaseDurationMs: 20,
    heartbeatIntervalMs: 1,
    stalledIntervalMs: 100,
    pollIntervalMs: 1
  })

  try {
    await started
    await worker.awaitIdle({ timeoutMs: 2_000 })
    const types = eventTypes(observer)
    expect(types).toContain('store-operation-failed')
    expect(types).not.toContain('completed')
    expect(types).not.toContain('retry-scheduled')
    expect(types).not.toContain('failed')
    const record = await resolve(store.getJob({ jobId: created.id }))
    expect(record?.state).toBe('active')
    expect(observer.events.find((event) => event.type === 'store-operation-failed')).toMatchObject({
      operation: 'settle',
      retryable: false
    })
  } finally {
    await worker.stop()
    await runtime.dispose()
  }
})

test('Worker abort lifecycle emits release before worker stop', async () => {
  const store = MemoryJobStore.make()
  const observer = RecordedJobObserver.make()
  const runtime = await makeRuntime(store)
  await enqueue(store, successJob)
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const worker = await Worker.startWith(runtime.executor, {
    handlers: [
      Worker.handle(successJob, () =>
        Effect.fn(async function* () {
          const signal = yield* CurrentAbortSignal
          entered()
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve(), { once: true })
          })
          return Result.ok(1)
        })
      )
    ],
    observer,
    pollIntervalMs: 1
  })

  try {
    await started
    await worker.stop({ abortActive: true })
    const types = eventTypes(observer)
    expect(types).toContain('released')
    expect(types.indexOf('started')).toBeLessThan(types.indexOf('released'))
    expect(types.indexOf('released')).toBeLessThan(types.indexOf('worker-stopped'))
  } finally {
    await runtime.dispose()
  }
})

test('Worker programs preserve stable Program metadata attributes for Runtime observers', async () => {
  const store = MemoryJobStore.make()
  const starts: Array<Pick<RuntimeExecutionStartEvent, 'name' | 'attributes'>> = []
  const runtime = await makeRuntime(store, [
    {
      onExecutionStart: (event) => {
        starts.push(event)
      }
    }
  ])
  await enqueue(store, successJob)
  const worker = await Worker.startWith(runtime.executor, {
    handlers: [
      Worker.handle(successJob, (value) =>
        Effect.fn(async function* () {
          return Result.ok(value.value)
        })
      )
    ],
    pollIntervalMs: 1
  })

  try {
    await worker.awaitIdle({ timeoutMs: 2_000 })
    const program = starts.find((event) => event.name?.startsWith('better-effect-mq/'))
    expect(program?.name).toBe('better-effect-mq/observability-tests/success@1')
    expect(program?.attributes).toMatchObject({
      'mq.job.name': 'success',
      'mq.job.queue': 'observability-tests',
      'mq.job.version': 1,
      'mq.job.attempt': 1
    })
  } finally {
    await worker.stop()
    await runtime.dispose()
  }
})

test('logger and metrics adapters use stable messages and low-cardinality attributes', () => {
  const logs: JobLogEvent[] = []
  const logger = JobObserver.logger((event) => {
    logs.push(event)
  })
  const event = {
    type: 'failed',
    recordedAt: 1,
    workerId: 'w',
    jobId: 'j',
    queue: 'q',
    name: 'name',
    version: 1,
    attempt: 1,
    delivery: 1,
    willRetry: false,
    failureKind: 'typed',
    failureCode: 'bad'
  } as JobEvent
  logger.onEvent(event)
  expect(logs).toEqual([{ level: 'error', message: 'MQ job failed', data: expect.any(Object) }])
  expect(Object.keys(logs[0]?.data ?? {})).not.toContain('payload')
  expect(Object.keys(logs[0]?.data ?? {})).not.toContain('metadata')
  expect(Object.keys(logs[0]?.data ?? {})).toEqual([
    'type',
    'queue',
    'name',
    'version',
    'workerId',
    'jobId',
    'attempt',
    'failureKind',
    'failureCode'
  ])

  const metrics: Array<{
    operation: string
    name: string
    attributes: Record<string, string | number | boolean>
  }> = []
  const sink: JobMetricsSink = {
    increment: (name, _value, attributes) => {
      metrics.push({ operation: 'increment', name, attributes })
    },
    observe: (name, _value, attributes) => {
      metrics.push({ operation: 'observe', name, attributes })
    },
    gauge: (name, _value, attributes) => {
      metrics.push({ operation: 'gauge', name, attributes })
    }
  }
  const adapter = JobObserver.metrics(sink)
  adapter.onEvent({
    type: 'claimed',
    recordedAt: 1,
    workerId: 'w' as never,
    jobId: 'j' as never,
    queue: 'q' as never,
    name: 'name' as never,
    version: 1,
    attempt: 1,
    delivery: 1,
    waitDurationMs: 4
  })
  expect(metrics.map((metric) => metric.name)).toEqual([
    JobMetricNames.jobsInFlight,
    JobMetricNames.claims,
    JobMetricNames.jobWaitDuration
  ])
  expect(
    metrics.every((metric) => !('jobId' in metric.attributes) && !('workerId' in metric.attributes))
  ).toBe(true)

  adapter.onEvent({
    type: 'store-operation-failed',
    recordedAt: 2,
    workerId: 'w' as never,
    jobId: 'j' as never,
    queue: 'q' as never,
    name: 'name',
    version: 1,
    attempt: 1,
    delivery: 1,
    operation: 'settle',
    retryable: false
  })
  expect(metrics.slice(3).map((metric) => metric.name)).toEqual([
    JobMetricNames.jobsInFlight,
    JobMetricNames.storeFailures
  ])
})

test('queue-depth sampling is opt-in and stops without publishing stale samples', async () => {
  const measurements: Array<{
    name: string
    value: number
    attributes: Record<string, string | number | boolean>
  }> = []
  let calls = 0
  const store = {
    counts: () => {
      calls += 1
      return Result.ok({
        total: 4,
        waiting: 2,
        delayed: 1,
        active: 1,
        completed: 0,
        failed: 0,
        cancelled: 0
      })
    }
  }
  const sink: JobMetricsSink = {
    increment: () => undefined,
    observe: () => undefined,
    gauge: (name, value, attributes) => {
      measurements.push({ name, value, attributes: { ...attributes } })
    }
  }
  const sampler = makeJobDepthSampler(store as never, sink, {
    queues: ['observability-tests' as never],
    intervalMs: 1
  })

  expect(sampler.running).toBe(false)
  sampler.start()
  await waitFor(() => measurements.length === 1)
  expect(calls).toBe(1)
  expect(measurements[0]).toEqual({
    name: JobMetricNames.queueDepth,
    value: 3,
    attributes: { queue: 'observability-tests' }
  })

  sampler.stop()
  expect(sampler.running).toBe(false)
  const countAfterStop = measurements.length
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(measurements).toHaveLength(countAfterStop)
  expect(() => makeJobDepthSampler(store as never, sink, { queues: [], intervalMs: 1 })).toThrow(
    TypeError
  )
  expect(() =>
    makeJobDepthSampler(store as never, sink, {
      queues: ['observability-tests' as never],
      intervalMs: 0
    })
  ).toThrow(TypeError)
})

test('runtime observer composition is isolated from rejected callbacks', async () => {
  const calls: string[] = []
  const composed = [
    {
      onExecutionStart: async () => {
        calls.push('first')
        throw new Error('ignored')
      }
    },
    {
      onExecutionStart: () => {
        calls.push('second')
      }
    }
  ]
  const runtime = await Runtime.make(Layer.empty, { observers: composed })
  try {
    const result = await runtime.run(() =>
      Effect.fn(async function* () {
        return Result.ok(1)
      })()
    )
    expect(Result.isOk(result)).toBe(true)
    await waitFor(() => calls.length === 2)
    expect(calls).toEqual(['first', 'second'])
  } finally {
    await runtime.dispose()
  }
})
