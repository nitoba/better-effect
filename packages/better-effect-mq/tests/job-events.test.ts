import { expect, test } from 'bun:test'
import { Effect, Layer, Runtime, Scope } from 'better-effect'
import type { CloseableScope } from 'better-effect'
import { ClockLive } from 'better-effect/standard-services'
import { Result } from 'better-result'

import {
  JobEventStore,
  JobEventStoreFailure,
  JobEvents,
  JobId,
  JobName,
  MemoryJobEventStore,
  MemoryJobStore,
  QueueName,
  type JobEventStoreContract,
  type JobEventStoreOperation
} from '../src'

const queue = QueueName.make('job-events').unwrap()
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
  // SAFETY: the test only calls unwrap with synchronous Memory adapter operations.
  const result = value as Result<Value, Failure>
  if (Result.isError(result)) throw result.error
  return result.value
}

const makeRuntime = async (events: JobEventStoreContract, clock = ClockLive) =>
  await Runtime.make(Layer.merge(Layer.succeed(JobEventStore, JobEventStore.of(events)), clock))

test('JobEvents.page is finite, lazy, yieldable, and keeps the caller cursor contract', async () => {
  const events = MemoryJobEventStore.make()
  const jobs = MemoryJobStore.make({ eventStore: events })
  const initial = unwrap(events.tailCursor())
  unwrap(jobs.enqueue(request('page-1')))
  unwrap(jobs.enqueue(request('page-2')))

  const runtime = await makeRuntime(events)
  try {
    const page = JobEvents.page(JobEventStore, { after: initial, limit: 1 })
    const result = await runtime.run(() =>
      Effect.gen(async function* () {
        return Result.ok(yield* page)
      })
    )

    expect(Result.isOk(result)).toBe(true)
    if (Result.isError(result)) return
    expect(result.value.events).toHaveLength(1)
    expect(result.value.nextCursor).toBe(result.value.events[0]!.cursor)
    expect(initial).not.toBe(result.value.events[0]!.cursor)
  } finally {
    await runtime.dispose()
  }
})

test('JobEvents.forEach is at-least-once and a handler failure does not mutate the caller cursor', async () => {
  const events = MemoryJobEventStore.make()
  const jobs = MemoryJobStore.make({ eventStore: events })
  const initial = unwrap(events.tailCursor())
  unwrap(jobs.enqueue(request('retry-me')))

  const runtime = await makeRuntime(events)
  try {
    const failed = await runtime.run(() =>
      Effect.gen(async function* () {
        return Result.ok(
          yield* JobEvents.forEach(
            { store: JobEventStore, after: initial, pageSize: 1, pollIntervalMs: 1 },
            () =>
              Effect.fn(function* () {
                yield* Result.ok(undefined)
                return Result.err('handler-failed' as const)
              })
          )
        )
      })
    )

    expect(Result.isError(failed)).toBe(true)
    if (Result.isOk(failed)) return
    expect(failed.error).toBe('handler-failed')

    const seen: string[] = []
    const controller = new AbortController()
    const retried = await runtime.run(() =>
      Effect.gen(async function* () {
        return Result.ok(
          yield* JobEvents.forEach(
            {
              store: JobEventStore,
              after: initial,
              pageSize: 1,
              signal: controller.signal
            },
            (event) =>
              Effect.fn(function* () {
                yield* Result.ok(undefined)
                seen.push(event.cursor)
                controller.abort()
                return Result.ok(undefined)
              })
          )
        )
      })
    )

    expect(Result.isError(retried)).toBe(true)
    expect(seen).toHaveLength(1)
    expect(initial).not.toBe(seen[0])
  } finally {
    await runtime.dispose()
  }
})

test('JobEvents.forEach wakes through awaitEvents and falls back to polling', async () => {
  const source = MemoryJobEventStore.make()
  const jobs = MemoryJobStore.make({ eventStore: source })
  const initial = unwrap(source.tailCursor())
  const brokenNotifications: JobEventStoreContract = {
    descriptor: source.descriptor,
    tailCursor: () => source.tailCursor(),
    activation: () => source.activation(),
    readiness: (writer) => source.readiness(writer),
    activate: (options) => source.activate(options),
    read: (options) => source.read(options),
    // SAFETY: the fixture deliberately supplies the typed Result shape required by the adapter contract.
    awaitEvents: () =>
      Result.err(
        new JobEventStoreFailure({
          operation: 'awaitEvents',
          message: 'notification unavailable'
        })
      ) as JobEventStoreOperation<void, JobEventStoreFailure>
  }

  const runtime = await makeRuntime(brokenNotifications)
  try {
    const controller = new AbortController()
    const seen: string[] = []
    const pending = runtime.run(() =>
      Effect.gen(async function* () {
        return Result.ok(
          yield* JobEvents.forEach(
            {
              store: JobEventStore,
              after: initial,
              pageSize: 1,
              pollIntervalMs: 5,
              signal: controller.signal
            },
            (event) =>
              Effect.fn(function* () {
                yield* Result.ok(undefined)
                seen.push(event.type)
                controller.abort()
                return Result.ok(undefined)
              })
          )
        )
      })
    )

    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    unwrap(jobs.enqueue(request('poll-fallback')))

    const result = await pending
    expect(Result.isError(result)).toBe(true)
    expect(seen).toEqual(['job-enqueued'])
  } finally {
    await runtime.dispose()
  }
})

test('JobEvents.forEach stops when Runtime disposal closes its Scope', async () => {
  const events = MemoryJobEventStore.make()
  const initial = unwrap(events.tailCursor())
  const runtime = await makeRuntime(events)
  let executionScope: CloseableScope | undefined

  const pending = runtime.run(() =>
    Effect.gen(async function* () {
      // SAFETY: Runtime execution scopes are closeable at runtime; the public Scope view intentionally hides close().
      executionScope = (yield* Scope) as CloseableScope
      return Result.ok(
        yield* JobEvents.forEach(
          { store: JobEventStore, after: initial, pollIntervalMs: 60_000 },
          () =>
            Effect.fn(function* () {
              yield* Result.ok(undefined)
              return Result.ok(undefined)
            })
        )
      )
    })
  )

  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  await executionScope?.close({ status: 'failure', cause: new Error('scope closed') })
  const result = await pending
  expect(Result.isError(result)).toBe(true)
  await runtime.dispose()
})
