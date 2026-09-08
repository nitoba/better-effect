// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- runtime fixtures erase typed Layer boundaries deliberately.
// oxlint-disable anti-slop/no-chained-type-assertions -- test-only casts restore the known fixture result shape.
// oxlint-disable anti-slop/no-reflect-get -- the Proxy models an adapter with one failing operation.
// oxlint-disable require-yield -- Effect.fn generators are the public Program fixtures under test.

import { expect, test } from 'bun:test'
import { Effect, Layer, Runtime, Service } from 'better-effect'
import { ClockLive } from 'better-effect/standard-services'
import { Result } from 'better-result'
import type { Result as ResultType } from 'better-result'

import {
  JobEventConsumer,
  JobEventStore,
  JobEventStoreFailure,
  JobId,
  JobName,
  JobStore,
  MemoryJobEventStore,
  MemoryJobStore,
  QueueName,
  type DurableJobEvent,
  type JobEventStoreContract
} from '../src'

const queue = QueueName.make('job-event-consumer').unwrap()
const name = JobName.make('publish').unwrap()
const identity = { queue, name, version: 1 } as const

const request = (id: string) => ({
  id: JobId.make(id).unwrap(),
  job: identity,
  payload: { id },
  runAt: 0,
  attemptsMax: 1,
  now: 0
})

const unwrap = <Value, Failure>(
  value: Result<Value, Failure> | PromiseLike<Result<Value, Failure>>
): Value => {
  const result = value as Result<Value, Failure>
  if (Result.isError(result)) throw result.error
  return result.value
}

class HandlerDependency extends Service<HandlerDependency>()('JobEventConsumerRuntimeDependency') {
  readonly suffix!: string
}

const makeRuntime = async (
  events: ReturnType<typeof MemoryJobEventStore.make>,
  consumerLayer: Layer.Any
) =>
  Runtime.make(
    Layer.merge(
      Layer.succeed(JobEventStore, JobEventStore.of(events)),
      Layer.succeed(HandlerDependency, HandlerDependency.of({ suffix: 'ok' })),
      ClockLive,
      consumerLayer
    ) as never
  )

test('JobEventConsumer is lazy and starts only when its Layer provider is acquired', async () => {
  const events = MemoryJobEventStore.make()
  let factoryCalls = 0
  const consumer = JobEventConsumer.service('@runtime/LazyConsumer')
  const layer = consumer.layer(async function* () {
    factoryCalls += 1
    return {
      eventStore: JobEventStore,
      pollIntervalMs: 1,
      handler: () =>
        Effect.fn(function* () {
          return Result.ok(undefined)
        })
    }
  })
  const runtime = await makeRuntime(events, layer)

  try {
    expect(factoryCalls).toBe(0)

    const resolved = (await runtime.run((() =>
      Effect.gen(async function* () {
        return Result.ok(yield* consumer)
      })) as never)) as ResultType<import('../src').JobEventConsumer.Handle, unknown>

    expect(Result.isOk(resolved)).toBe(true)
    expect(factoryCalls).toBe(1)
  } finally {
    await runtime.dispose()
  }
})

test('JobEventConsumer factory failure is an acquisition failure without starting a loop', async () => {
  const events = MemoryJobEventStore.make()
  let started = false
  const consumer = JobEventConsumer.service('@runtime/FailedFactoryConsumer')
  const layer = consumer.layer(async function* () {
    started = true
    throw new Error('factory failed')
  })
  const runtime = await makeRuntime(events, layer)

  try {
    const failure = await runtime
      .run((() =>
        Effect.gen(async function* () {
          return Result.ok(yield* consumer)
        })) as never)
      .then(
        () => undefined,
        (cause) => cause as Error & { readonly cause?: Error & { readonly cause?: Error } }
      )
    expect(failure).toBeInstanceOf(Error)
    expect(failure?.cause?.cause?.message).toBe('factory failed')
    expect(started).toBe(true)
  } finally {
    await runtime.dispose()
  }
})

test('JobEventConsumer preserves the caller cursor after handler failure for at-least-once retry', async () => {
  const events = MemoryJobEventStore.make()
  const jobs = MemoryJobStore.make({ eventStore: events })
  const initial = unwrap(events.tailCursor())
  unwrap(jobs.enqueue(request('retry-consumer')))

  const failedConsumer = JobEventConsumer.service('@runtime/FailedConsumer')
  const failedLayer = failedConsumer.layer(() => ({
    eventStore: JobEventStore,
    after: initial,
    handler: () =>
      Effect.fn(function* () {
        return Result.err('handler-failed' as const)
      })
  }))
  const failedRuntime = await makeRuntime(events, failedLayer)

  try {
    const resolved = (await failedRuntime.run((() =>
      Effect.gen(async function* () {
        return Result.ok(yield* failedConsumer)
      })) as never)) as ResultType<import('../src').JobEventConsumer.Handle, unknown>
    if (Result.isError(resolved)) throw resolved.error

    // oxlint-disable-next-line typescript/await-thenable -- Bun's rejection matcher is thenable at runtime.
    await expect(resolved.value.awaitStopped()).rejects.toBe('handler-failed')
    expect(initial).not.toBe(unwrap(events.tailCursor()))
  } finally {
    await failedRuntime.dispose()
  }

  const seen: string[] = []
  const controller = new AbortController()
  let retried!: () => void
  const retriedDone = new Promise<void>((resolve) => {
    retried = resolve
  })
  const retriedConsumer = JobEventConsumer.service('@runtime/RetriedConsumer')
  const retriedLayer = retriedConsumer.layer(() => ({
    eventStore: JobEventStore,
    after: initial,
    signal: controller.signal,
    handler: (event: DurableJobEvent) =>
      Effect.fn(function* () {
        seen.push(event.cursor)
        controller.abort()
        retried()
        return Result.ok(undefined)
      })
  }))
  const retriedRuntime = await makeRuntime(events, retriedLayer)

  try {
    const resolved = (await retriedRuntime.run((() =>
      Effect.gen(async function* () {
        return Result.ok(yield* retriedConsumer)
      })) as never)) as ResultType<import('../src').JobEventConsumer.Handle, unknown>
    if (Result.isError(resolved)) throw resolved.error
    await retriedDone
    await retriedRuntime.dispose()
    expect(seen).toHaveLength(1)
    expect(seen[0]).not.toBe(initial)
  } finally {
    if (retriedRuntime.inspect().state !== 'disposed') await retriedRuntime.dispose()
  }
})

test('JobEventConsumer quiesces new callbacks and drains an admitted callback before release', async () => {
  const events = MemoryJobEventStore.make()
  const jobs = MemoryJobStore.make({ eventStore: events })
  const initial = unwrap(events.tailCursor())
  unwrap(jobs.enqueue(request('drain-consumer')))
  unwrap(jobs.enqueue(request('drain-consumer-second')))

  let releaseHandler!: () => void
  const handlerReleased = new Promise<void>((resolve) => {
    releaseHandler = resolve
  })
  let started = false
  let completed = false
  let calls = 0
  const consumer = JobEventConsumer.service('@runtime/DrainConsumer')
  const layer = consumer.layer(() => ({
    eventStore: JobEventStore,
    after: initial,
    handler: () =>
      Effect.fn(async function* () {
        calls += 1
        started = true
        await handlerReleased
        completed = true
        return Result.ok(undefined)
      })
  }))
  const runtime = await makeRuntime(events, layer)

  const resolved = (await runtime.run((() =>
    Effect.gen(async function* () {
      return Result.ok(yield* consumer)
    })) as never)) as ResultType<import('../src').JobEventConsumer.Handle, unknown>
  if (Result.isError(resolved)) throw resolved.error

  try {
    while (!started) await new Promise((resolve) => setTimeout(resolve, 0))

    const disposal = runtime.dispose()
    expect(runtime.inspect().state).toBe('quiescing')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(completed).toBe(false)

    releaseHandler()
    await disposal
    expect(completed).toBe(true)
    expect(calls).toBe(1)
    expect(runtime.inspect().activeExecutions).toBe(0)
  } finally {
    if (runtime.inspect().state !== 'disposed') {
      releaseHandler()
      await runtime.dispose()
    }
  }
})

test('named JobEventConsumers keep stores, cursors, and callbacks isolated', async () => {
  const firstStore = MemoryJobEventStore.make()
  const secondStore = MemoryJobEventStore.make()
  const firstJobStore = MemoryJobStore.make({ eventStore: firstStore })
  const secondJobStore = MemoryJobStore.make({ eventStore: secondStore })
  const firstToken = JobStore.named('consumer-first')
  const secondToken = JobStore.named('consumer-second')
  const firstEvents = JobEventStore.for(firstToken)
  const secondEvents = JobEventStore.for(secondToken)
  const firstCursor = unwrap(firstStore.tailCursor())
  const secondCursor = unwrap(secondStore.tailCursor())
  unwrap(firstJobStore.enqueue(request('first')))
  unwrap(secondJobStore.enqueue(request('second')))

  const firstSeen: string[] = []
  const secondSeen: string[] = []
  let markFirstHandled!: () => void
  const firstHandled = new Promise<void>((resolve) => {
    markFirstHandled = resolve
  })
  let markSecondHandled!: () => void
  const secondHandled = new Promise<void>((resolve) => {
    markSecondHandled = resolve
  })
  const firstConsumer = JobEventConsumer.service('@runtime/FirstNamedConsumer')
  const secondConsumer = JobEventConsumer.service('@runtime/SecondNamedConsumer')
  const firstLayer = firstConsumer.layer(() => ({
    eventStore: firstEvents,
    after: firstCursor,
    handler: (event: DurableJobEvent) =>
      Effect.fn(function* () {
        firstSeen.push(event.jobId ?? event.type)
        markFirstHandled()
        return Result.ok(undefined)
      })
  }))
  const secondLayer = secondConsumer.layer(() => ({
    eventStore: secondEvents,
    after: secondCursor,
    handler: (event: DurableJobEvent) =>
      Effect.fn(function* () {
        secondSeen.push(event.jobId ?? event.type)
        markSecondHandled()
        return Result.ok(undefined)
      })
  }))
  const runtime = await Runtime.make(
    Layer.merge(
      Layer.succeed(firstEvents, firstEvents.of(firstStore)),
      Layer.succeed(secondEvents, secondEvents.of(secondStore)),
      ClockLive,
      firstLayer,
      secondLayer
    ) as never
  )

  try {
    const resolved = (await runtime.run((() =>
      Effect.gen(async function* () {
        const first = yield* firstConsumer
        const second = yield* secondConsumer
        return Result.ok({ first, second })
      })) as never)) as ResultType<
      {
        readonly first: import('../src').JobEventConsumer.Handle
        readonly second: import('../src').JobEventConsumer.Handle
      },
      unknown
    >
    if (Result.isError(resolved)) throw resolved.error

    await Promise.all([firstHandled, secondHandled])
    await Promise.allSettled([resolved.value.first.stop(), resolved.value.second.stop()])
    expect(firstSeen).toEqual(['first'])
    expect(secondSeen).toEqual(['second'])
  } finally {
    await runtime.dispose()
  }
})

test('JobEventConsumer rejects unsupported concurrency and does not leak a failed store wait', async () => {
  const events = MemoryJobEventStore.make()
  const consumer = JobEventConsumer.service('@runtime/StoreFailureConsumer')
  const failingStore = new Proxy(events, {
    get(target, property, receiver) {
      if (property === 'awaitEvents') {
        return () =>
          Result.err(new JobEventStoreFailure({ operation: 'awaitEvents', message: 'closed' }))
      }
      if (property === 'tailCursor') {
        return () =>
          Result.err(new JobEventStoreFailure({ operation: 'tailCursor', message: 'closed' }))
      }
      return Reflect.get(target, property, receiver)
    }
  }) as JobEventStoreContract
  const layer = consumer.layer(() => ({
    eventStore: JobEventStore,
    handler: () =>
      Effect.fn(function* () {
        return Result.ok(undefined)
      })
  }))
  const runtime = await Runtime.make(
    Layer.complete(
      Layer.merge(Layer.succeed(JobEventStore, JobEventStore.of(failingStore)), ClockLive, layer)
    )
  )

  try {
    const resolved = (await runtime.run((() =>
      Effect.gen(async function* () {
        return Result.ok(yield* consumer)
      })) as never)) as ResultType<import('../src').JobEventConsumer.Handle, unknown>
    if (Result.isError(resolved)) throw resolved.error
    // oxlint-disable-next-line typescript/await-thenable -- Bun's rejection matcher is thenable at runtime.
    await expect(resolved.value.awaitStopped()).rejects.toBeInstanceOf(JobEventStoreFailure)
  } finally {
    await runtime.dispose()
  }
})

test('JobEventConsumer rejects unsupported concurrency during Layer acquisition', async () => {
  const events = MemoryJobEventStore.make()
  const consumer = JobEventConsumer.service('@runtime/UnsupportedConcurrencyConsumer')
  const layer = consumer.layer(() => ({
    eventStore: JobEventStore,
    concurrency: 2,
    handler: () =>
      Effect.fn(function* () {
        return Result.ok(undefined)
      })
  }))
  const runtime = await Runtime.make(
    Layer.complete(
      Layer.merge(Layer.succeed(JobEventStore, JobEventStore.of(events)), ClockLive, layer)
    )
  )

  try {
    const failure = await runtime
      .run((() =>
        Effect.gen(async function* () {
          return Result.ok(yield* consumer)
        })) as never)
      .then(
        () => undefined,
        (cause) => cause as Error & { readonly cause?: Error & { readonly cause?: Error } }
      )
    expect(failure).toBeInstanceOf(Error)
    expect(failure?.cause?.cause?.message).toContain('only supports concurrency: 1')
  } finally {
    await runtime.dispose()
  }
})
