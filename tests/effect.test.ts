import { describe, expect, mock, test } from 'bun:test'

import { Result, UnhandledException } from 'better-result'

import { Effect } from '../src/effect'
import { Service, ServiceRuntime } from '../src/service'
import { Scope, ScopeCloseError, ScopeRuntimeNotConfiguredError } from '../src/scope'

import type { ScopeOutcome } from '../src/scope'

import { TestServiceResolver } from './helpers/test-service-resolver'

class GreetingService extends Service<GreetingService>() {
  greet(name: string): string {
    return `Hello, ${name}!`
  }
}

const captureRejection = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (cause) => cause
  )

describe('Effect.gen', () => {
  test('supports synchronous Result generators', () => {
    const result = Effect.gen(function* () {
      const value = yield* Result.ok(41)

      return Result.ok(value + 1)
    })

    expect(result).toEqual(Result.ok(42))
  })

  test('delegates service resolution and Result control flow', async () => {
    const greeting = new GreetingService()
    const resolver = new TestServiceResolver().provide(GreetingService, greeting)

    const result = await ServiceRuntime.run(resolver, () =>
      Effect.gen(async function* () {
        const service = yield* GreetingService

        const suffix = yield* Result.await(Promise.resolve(Result.ok('welcome')))

        return Result.ok(service.greet(suffix))
      })
    )

    expect(resolver.calls).toEqual([GreetingService])
    expect(result).toEqual(Result.ok('Hello, welcome!'))
  })

  test('preserves Result errors', async () => {
    const result = await Effect.gen(async function* () {
      yield* Result.err('failed')

      return Result.ok('unreachable')
    })

    expect(result).toEqual(Result.err('failed'))
  })

  test('acquires and releases resources through the current Scope', async () => {
    let released = 0

    const result = await Scope.run(async () => {
      const result = await Effect.gen(async function* () {
        const resource = yield* Effect.acquireRelease(
          () => ({ value: 42 }),
          () => {
            released++
          }
        )

        expect(released).toBe(0)

        return Result.ok(resource.value)
      })

      expect(released).toBe(0)

      return result
    })

    expect(result).toEqual(Result.ok(42))
    expect(released).toBe(1)
  })

  test('releases resources when the Effect result is an error', async () => {
    const release = mock(() => undefined)

    const result = await Scope.run(async () =>
      Effect.gen(async function* () {
        yield* Effect.acquireRelease(() => ({ value: 42 }), release)

        return Result.err<number, 'failed'>('failed')
      })
    )

    expect(result).toEqual(Result.err('failed'))
    expect(release).toHaveBeenCalledTimes(1)
  })

  test('passes the final Scope outcome to acquireRelease releases', async () => {
    let observed: ScopeOutcome | undefined

    const result = await Scope.run(async () =>
      Effect.gen(async function* () {
        yield* Effect.acquireRelease(
          () => ({ value: 42 }),
          (_resource, outcome) => {
            observed = outcome
          }
        )

        return Result.err('failed')
      })
    )

    expect(result).toEqual(Result.err('failed'))
    expect(observed).toEqual({ status: 'success' })
  })

  test('releases resources when the surrounding program throws', async () => {
    const release = mock(() => undefined)
    const programFailure = new Error('program failed')

    const error = await captureRejection(
      Scope.run(async () => {
        await Effect.gen(async function* () {
          yield* Effect.acquireRelease(() => ({ value: 42 }), release)

          return Result.ok(true)
        })

        throw programFailure
      })
    )

    expect(error).toBe(programFailure)
    expect(release).toHaveBeenCalledTimes(1)
  })

  test('releases resources when the surrounding program rejects', async () => {
    const release = mock(() => undefined)
    const programFailure = new Error('program rejected')

    const error = await captureRejection(
      Scope.run(async () => {
        await Effect.gen(async function* () {
          yield* Effect.acquireRelease(() => ({ value: 42 }), release)

          return Result.ok(true)
        })

        return Promise.reject(programFailure)
      })
    )

    expect(error).toBe(programFailure)
    expect(release).toHaveBeenCalledTimes(1)
  })

  test('normalizes synchronous acquisition failures without releasing', async () => {
    const cause = new Error('acquire failed')
    const release = mock(() => undefined)

    const result = await Scope.run(async () =>
      Effect.gen(async function* () {
        const resource = yield* Effect.acquireRelease(() => {
          throw cause
        }, release)

        return Result.ok(resource)
      })
    )

    expect(Result.isError(result)).toBe(true)

    if (Result.isError(result)) {
      expect(result.error).toBeInstanceOf(UnhandledException)
      expect((result.error as UnhandledException).cause).toBe(cause)
    }

    expect(release).not.toHaveBeenCalled()
  })

  test('normalizes rejected acquisition failures without releasing', async () => {
    const cause = new Error('acquire rejected')
    const release = mock(() => undefined)

    const result = await Scope.run(async () =>
      Effect.gen(async function* () {
        const resource = yield* Effect.acquireRelease(async () => {
          throw cause
        }, release)

        return Result.ok(resource)
      })
    )

    expect(Result.isError(result)).toBe(true)

    if (Result.isError(result)) {
      expect(result.error).toBeInstanceOf(UnhandledException)
      expect((result.error as UnhandledException).cause).toBe(cause)
    }

    expect(release).not.toHaveBeenCalled()
  })

  test('preserves the existing missing Scope failure', async () => {
    const error = await captureRejection(
      Effect.gen(async function* () {
        const resource = yield* Effect.acquireRelease(
          () => ({ value: 42 }),
          () => undefined
        )

        return Result.ok(resource)
      })
    )

    expect((error as { cause?: unknown }).cause).toBeInstanceOf(ScopeRuntimeNotConfiguredError)
  })

  test('reports release failures through Scope cleanup', async () => {
    const releaseFailure = new Error('release failed')

    const error = await captureRejection(
      Scope.run(async () =>
        Effect.gen(async function* () {
          yield* Effect.acquireRelease(
            () => ({ value: 42 }),
            () => {
              throw releaseFailure
            }
          )

          return Result.ok(true)
        })
      )
    )

    expect(error).toBeInstanceOf(ScopeCloseError)

    if (error instanceof ScopeCloseError) {
      expect(error.causes).toEqual([releaseFailure])
    }
  })

  test('preserves program failure precedence over release failure', async () => {
    const programFailure = new Error('program failed')
    const releaseFailure = new Error('release failed')

    const error = await captureRejection(
      Scope.run(async () => {
        await Effect.gen(async function* () {
          yield* Effect.acquireRelease(
            () => ({ value: 42 }),
            () => {
              throw releaseFailure
            }
          )

          return Result.ok(true)
        })

        throw programFailure
      })
    )

    expect(error).toBe(programFailure)
  })
})
