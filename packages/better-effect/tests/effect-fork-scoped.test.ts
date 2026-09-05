import { describe, expect, test } from 'bun:test'

import { Result } from 'better-result'

import type { Result as ResultType } from 'better-result'

import {
  CurrentAbortSignal,
  Effect,
  Layer,
  Program,
  Runtime,
  ScopeCloseError,
  Service
} from '../src'
import { RecordedRuntimeObserver } from '../src/testing'

import type { ScopedTask } from '../src'

class TaskService extends Service<TaskService>()('TaskService') {
  readonly value = 'task-service'
}

class RequestTaskService extends Service<RequestTaskService>()('RequestTaskService') {
  readonly value = 'request-task-service'
}

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (cause?: unknown) => void

  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })

  return { promise, resolve, reject }
}

const waitForAbort = (signal: AbortSignal): Promise<never> =>
  new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }

    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })

describe('Effect.forkScoped', () => {
  test('returns a task before the child Program settles and preserves its Result', async () => {
    const started = deferred()
    const release = deferred()
    let observedChildResult: unknown
    const child = Effect.fn(async function* () {
      yield* []
      started.resolve()
      await release.promise

      return Result.ok(42)
    })
    const runtime = await Runtime.make(Layer.empty)

    try {
      const result = await runtime.run(
        Effect.fn(async function* () {
          const task = yield* Effect.forkScoped(child)
          await started.promise

          expect(task.state).toBe('running')
          expect(Object.isFrozen(task)).toBe(true)
          release.resolve()
          observedChildResult = await task.await()

          return Result.ok(task.state)
        })
      )

      expect(Result.isOk(result)).toBe(true)
      expect(observedChildResult).toEqual(Result.ok(42))
      if (Result.isOk(result)) {
        expect(result.value).toBe('succeeded')
      }
    } finally {
      await runtime.dispose()
    }
  })

  test('reports active task lineage without creating a child execution span', async () => {
    const started = deferred()
    const release = deferred()
    const recorder = RecordedRuntimeObserver.make()
    const runtime = await Runtime.make(Layer.empty, { observers: [recorder] })
    const child = Program.named(
      'fork-scoped.child',
      Effect.fn(async function* () {
        yield* []
        started.resolve()
        await release.promise
        return Result.ok('done')
      })
    )

    try {
      const parent = runtime.run(
        Program.named(
          'fork-scoped.parent',
          Effect.fn(async function* () {
            const task = yield* Effect.forkScoped(child)
            await started.promise

            return Result.ok(await task.await())
          })
        )
      )

      await started.promise

      const inspection = runtime.inspect()
      const taskInspection = inspection.tasks[0]

      expect(inspection.activeTasks).toBe(1)
      expect(taskInspection).toMatchObject({
        state: 'running',
        name: 'fork-scoped.child',
        parentExecutionId: recorder.executionStarts[0]?.executionId
      })
      expect(Object.isFrozen(taskInspection)).toBe(true)
      expect(recorder.executionStarts).toHaveLength(1)
      expect(recorder.taskStarts).toHaveLength(1)
      expect(recorder.taskStarts[0]?.parentExecutionId).toBe(
        recorder.executionStarts[0]?.executionId
      )

      release.resolve()
      const result = await parent

      expect(Result.isOk(result)).toBe(true)
      expect(runtime.inspect().activeTasks).toBe(0)
      expect(recorder.taskEnds).toHaveLength(1)
      expect(recorder.taskEnds[0]).toMatchObject({
        taskId: recorder.taskStarts[0]?.taskId,
        name: 'fork-scoped.child',
        state: 'succeeded',
        parentExecutionId: recorder.executionStarts[0]?.executionId
      })
      expect(recorder.executionStarts).toHaveLength(1)
      expect(recorder.executionEnds).toHaveLength(1)
    } finally {
      release.resolve()
      await runtime.dispose()
    }
  })

  test('preserves a typed Result.err by identity', async () => {
    const error = { code: 'task-failed' }
    let expectedChildResult!: ResultType<never, { code: string }>
    const runtime = await Runtime.make(Layer.empty)

    try {
      const result = await runtime.run(
        Effect.fn(async function* () {
          const task = yield* Effect.forkScoped(
            Effect.fn(async function* () {
              yield* []
              const childResult = Result.err(error)
              expectedChildResult = childResult
              return childResult
            })
          )
          const childResult = await task.await()

          expect(task.state).toBe('failed')
          return Result.ok(childResult)
        })
      )

      expect(Result.isOk(result)).toBe(true)
      if (Result.isOk(result)) {
        expect(result.value).toBe(expectedChildResult)
        if (Result.isError(result.value)) {
          expect(result.value.error).toBe(error)
        }
      }
    } finally {
      await runtime.dispose()
    }
  })

  test('interrupts idempotently and keeps the first reason', async () => {
    const started = deferred()
    const firstReason = new Error('first interruption')
    const secondReason = new Error('second interruption')
    const runtime = await Runtime.make(Layer.empty)

    try {
      const result = await runtime.run(
        Effect.fn(async function* () {
          const task = yield* Effect.forkScoped(
            Effect.fn(async function* () {
              const signal = yield* CurrentAbortSignal
              started.resolve()
              await waitForAbort(signal)
              return Result.ok('unreachable')
            })
          )

          await started.promise
          await Promise.all([task.interrupt(firstReason), task.interrupt(secondReason)])

          return Result.ok(await task.awaitExit())
        })
      )

      expect(Result.isOk(result)).toBe(true)
      if (Result.isOk(result)) {
        expect(result.value).toMatchObject({ status: 'interrupted', reason: firstReason })
      }
    } finally {
      await runtime.dispose()
    }
  })

  test('gives sibling tasks independent cooperative-cancellation signals', async () => {
    const firstStarted = deferred()
    const secondStarted = deferred()
    const releaseSecond = deferred()
    let firstSignal!: AbortSignal
    let secondSignal!: AbortSignal
    const runtime = await Runtime.make(Layer.empty)

    try {
      const result = await runtime.run(
        Effect.fn(async function* () {
          const first = yield* Effect.forkScoped(
            Effect.fn(async function* () {
              firstSignal = yield* CurrentAbortSignal
              firstStarted.resolve()
              await waitForAbort(firstSignal)
              return Result.ok('first')
            })
          )
          const second = yield* Effect.forkScoped(
            Effect.fn(async function* () {
              secondSignal = yield* CurrentAbortSignal
              secondStarted.resolve()
              await releaseSecond.promise
              return Result.ok('second')
            })
          )

          await Promise.all([firstStarted.promise, secondStarted.promise])
          await first.interrupt(new Error('interrupt first'))

          expect(second.state).toBe('running')
          releaseSecond.resolve()

          return Result.ok([(await first.awaitExit()).status, (await second.awaitExit()).status])
        })
      )

      expect(firstSignal).not.toBe(secondSignal)
      expect(Result.isOk(result)).toBe(true)
      if (Result.isOk(result)) {
        expect(result.value).toEqual(['interrupted', 'succeeded'])
      }
    } finally {
      releaseSecond.resolve()
      await runtime.dispose()
    }
  })

  test('inherits request-local Services and releases them after task cleanup', async () => {
    const started = deferred()
    const cleanupStarted = deferred()
    const cleanupFinished = deferred()
    const events: string[] = []
    const runtime = await Runtime.make(Layer.empty)

    try {
      const execution = runtime.runWith(
        Layer.scoped(
          RequestTaskService,
          () => new RequestTaskService(),
          () => {
            events.push('request-service-release')
          }
        ),
        Effect.fn(async function* () {
          yield* Effect.forkScoped(
            Effect.fn(async function* () {
              const service = yield* RequestTaskService
              const signal = yield* CurrentAbortSignal

              yield* Effect.acquireRelease(
                () => ({ owned: true }),
                async () => {
                  cleanupStarted.resolve()
                  await cleanupFinished.promise
                }
              )

              started.resolve()
              await waitForAbort(signal)
              return Result.ok(service.value)
            })
          )

          await started.promise
          return Result.ok(undefined)
        })
      )

      await started.promise
      await cleanupStarted.promise
      expect(events).toEqual([])

      cleanupFinished.resolve()
      await execution
      expect(events).toEqual(['request-service-release'])
    } finally {
      cleanupFinished.resolve()
      await runtime.dispose()
    }
  })

  test('starts already-aborted tasks as interrupted without running the Program', async () => {
    const controller = new AbortController()
    const reason = new Error('already aborted')
    let ran = false
    controller.abort(reason)
    const runtime = await Runtime.make(Layer.empty)

    try {
      const result = await runtime.run(
        Effect.fn(async function* () {
          const task = yield* Effect.forkScoped(
            Effect.fn(async function* () {
              yield* []
              ran = true
              return Result.ok('unexpected')
            })
          )

          return Result.ok(await task.awaitExit())
        }),
        { signal: controller.signal }
      )

      expect(ran).toBe(false)
      expect(Result.isOk(result)).toBe(true)
      if (Result.isOk(result)) {
        expect(result.value).toMatchObject({ status: 'interrupted', reason })
      }
    } finally {
      await runtime.dispose()
    }
  })

  test('reports child cleanup failures without changing interruption precedence', async () => {
    const started = deferred()
    const cleanupFailure = new Error('task cleanup failed')
    const interruption = new Error('stop task')
    const diagnostics: unknown[] = []
    const recorder = RecordedRuntimeObserver.make()
    const runtime = await Runtime.make(Layer.empty, {
      observers: [recorder],
      onCleanupFailure: (diagnostic) => {
        diagnostics.push(diagnostic)
      }
    })

    try {
      const result = await runtime.run(
        Effect.fn(async function* () {
          const task = yield* Effect.forkScoped(
            Effect.fn(async function* () {
              const signal = yield* CurrentAbortSignal

              yield* Effect.acquireRelease(
                () => ({ owned: true }),
                () => {
                  throw cleanupFailure
                }
              )

              started.resolve()
              await waitForAbort(signal)
              return Result.ok('unreachable')
            })
          )

          await started.promise
          await task.interrupt(interruption)
          return Result.ok(await task.awaitExit())
        })
      )

      expect(Result.isOk(result)).toBe(true)
      if (Result.isOk(result)) {
        const exit = result.value

        expect(exit.status).toBe('interrupted')
        if (exit.status === 'interrupted') {
          expect(exit.reason).toBe(interruption)
          expect(exit.cleanupFailure).toBeInstanceOf(ScopeCloseError)
          const taskCleanupFailure = exit.cleanupFailure

          if (taskCleanupFailure instanceof ScopeCloseError) {
            expect(taskCleanupFailure.causes).toEqual([cleanupFailure])
          }
        }
      }

      expect(diagnostics).toHaveLength(1)
      expect(recorder.taskEnds[0]?.cleanupFailure?.causes).toEqual([cleanupFailure])
    } finally {
      await runtime.dispose()
    }
  })

  test('interrupts and awaits the child before releasing parent Services', async () => {
    const started = deferred()
    const cleanupStarted = deferred()
    const cleanupFinished = deferred()
    const events: string[] = []

    const child = Effect.fn(async function* () {
      const service = yield* TaskService
      const signal = yield* CurrentAbortSignal

      yield* Effect.acquireRelease(
        () => ({ owned: true }),
        async () => {
          cleanupStarted.resolve()
          await cleanupFinished.promise
        }
      )

      started.resolve()
      await waitForAbort(signal)
      return Result.ok(service.value)
    })

    let task!: ScopedTask<string, unknown>
    const runtime = await Runtime.make(
      Layer.merge(
        Layer.scoped(
          TaskService,
          () => new TaskService(),
          () => {
            events.push('service-release')
          }
        ),
        Layer.effectDiscard(
          Effect.fn(async function* () {
            task = yield* Effect.forkScoped(child)
            return Result.ok(undefined)
          })
        )
      )
    )

    await started.promise
    const disposal = runtime.dispose()

    await cleanupStarted.promise
    expect(events).toEqual([])
    cleanupFinished.resolve()
    await disposal

    expect(task.state).toBe('interrupted')
    expect(events).toEqual(['service-release'])
  })

  test('stops a Scope-owned outbox loop before Runtime root release', async () => {
    const firstCycle = deferred()
    const cycles: string[] = []
    const events: string[] = []
    let task!: ScopedTask<undefined, unknown>
    const runtime = await Runtime.make(
      Layer.merge(
        Layer.scoped(
          TaskService,
          () => new TaskService(),
          () => {
            events.push('service-release')
          }
        ),
        Layer.effectDiscard(
          Effect.fn(async function* () {
            task = yield* Effect.forkScoped(
              Effect.fn(async function* () {
                const service = yield* TaskService
                const signal = yield* CurrentAbortSignal

                yield* Effect.acquireRelease(
                  () => ({ owned: true }),
                  () => {
                    events.push('cycle-release')
                  }
                )

                while (!signal.aborted) {
                  cycles.push(service.value)
                  firstCycle.resolve()
                  await waitForAbort(signal)
                }

                return Result.ok(undefined)
              })
            )

            return Result.ok(undefined)
          })
        )
      )
    )

    await firstCycle.promise
    expect(task.state).toBe('running')
    const cycleCount = cycles.length

    await runtime.dispose()
    await Promise.resolve()

    expect(task.state).toBe('interrupted')
    expect(cycles).toHaveLength(cycleCount)
    expect(events).toEqual(['cycle-release', 'service-release'])
  })

  test('resolves Services in a child task and keeps the parent signal separate', async () => {
    const observedSignal = deferred<AbortSignal>()
    let observedServiceValue = ''
    let observedChildSignal!: AbortSignal
    let observedParentSignal!: AbortSignal
    const runtime = await Runtime.make(Layer.make(TaskService))
    const parentController = new AbortController()

    try {
      const result = await runtime.run(
        Effect.fn(async function* () {
          const parentSignal = yield* CurrentAbortSignal
          const task = yield* Effect.forkScoped(
            Effect.fn(async function* () {
              const service = yield* TaskService
              const signal = yield* CurrentAbortSignal
              observedSignal.resolve(signal)
              observedServiceValue = service.value
              observedChildSignal = signal
              observedParentSignal = parentSignal
              return Result.ok(undefined)
            })
          )
          await task.await()

          return Result.ok(undefined)
        }),
        { signal: parentController.signal }
      )

      expect(Result.isOk(result)).toBe(true)

      if (!Result.isOk(result)) {
        return
      }

      const signal = await observedSignal.promise
      expect(signal).not.toBe(parentController.signal)
      if (Result.isOk(result)) {
        expect(result.value).toBeUndefined()
      }
      expect(observedServiceValue).toBe('task-service')
      expect(observedChildSignal).toBe(signal)
      expect(observedParentSignal).not.toBe(signal)
    } finally {
      await runtime.dispose()
    }
  })

  test('does not surface the child defect as an unhandled rejection', async () => {
    const defect = new Error('task defect')
    const runtime = await Runtime.make(Layer.empty)

    try {
      const result = await runtime.run(
        Effect.fn(async function* () {
          const task = yield* Effect.forkScoped(
            Effect.fn(async function* () {
              yield* []
              throw defect
            })
          )
          const exit = await task.awaitExit()

          return Result.ok(exit)
        })
      )

      expect(Result.isOk(result)).toBe(true)

      if (Result.isOk(result)) {
        expect(result.value).toMatchObject({ status: 'defected', cause: defect })
      }
    } finally {
      await runtime.dispose()
    }
  })
})
