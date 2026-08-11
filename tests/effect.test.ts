import { describe, expect, mock, test } from 'bun:test'

import { Result, UnhandledException } from 'better-result'

import { Effect } from '../src/effect'
import { Service, ServiceRuntime } from '../src/service'
import {
  Scope,
  ScopeCloseError,
  ScopeClosedError,
  ScopeRuntimeNotConfiguredError
} from '../src/scope'

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

  test('adds an already-acquired resource and returns the exact value', async () => {
    let disposed = 0
    const resource = {
      value: 42,
      [Symbol.dispose]() {
        disposed++
      }
    }

    const result = await Scope.run(async () =>
      Effect.gen(async function* () {
        const added = yield* Effect.add(resource)

        expect(added).toBe(resource)

        return Result.ok(added)
      })
    )

    expect(result).toEqual(Result.ok(resource))
    expect(disposed).toBe(1)
  })

  test('awaits asynchronous disposal', async () => {
    let disposed = false
    const resource = {
      async [Symbol.asyncDispose]() {
        await Promise.resolve()
        disposed = true
      }
    }

    const result = await Scope.run(async () =>
      Effect.gen(async function* () {
        const added = yield* Effect.add(resource)

        return Result.ok(added)
      })
    )

    expect(result).toEqual(Result.ok(resource))
    expect(disposed).toBe(true)
  })

  test('prefers asynchronous disposal for dual-protocol resources', async () => {
    const events: string[] = []
    const resource = {
      [Symbol.dispose]() {
        events.push('dispose')
      },

      async [Symbol.asyncDispose]() {
        events.push('asyncDispose')
      }
    }

    await Scope.run(async () =>
      Effect.gen(async function* () {
        yield* Effect.add(resource)

        return Result.ok(true)
      })
    )

    expect(events).toEqual(['asyncDispose'])
  })

  test('disposes resources after a final Result error', async () => {
    let disposed = 0
    const resource = {
      [Symbol.dispose]() {
        disposed++
      }
    }

    const result = await Scope.run(async () =>
      Effect.gen(async function* () {
        yield* Effect.add(resource)

        return Result.err<number, 'failed'>('failed')
      })
    )

    expect(result).toEqual(Result.err('failed'))
    expect(disposed).toBe(1)
  })

  test('disposes resources when the surrounding program throws', async () => {
    let disposed = 0
    const programFailure = new Error('program failed')
    const resource = {
      [Symbol.dispose]() {
        disposed++
      }
    }

    const error = await captureRejection(
      Scope.run(async () => {
        await Effect.gen(async function* () {
          yield* Effect.add(resource)

          return Result.ok(true)
        })

        throw programFailure
      })
    )

    expect(error).toBe(programFailure)
    expect(disposed).toBe(1)
  })

  test('disposes resources when the surrounding program rejects', async () => {
    let disposed = 0
    const programFailure = new Error('program rejected')
    const resource = {
      [Symbol.dispose]() {
        disposed++
      }
    }

    const error = await captureRejection(
      Scope.run(async () => {
        await Effect.gen(async function* () {
          yield* Effect.add(resource)

          return Result.ok(true)
        })

        return Promise.reject(programFailure)
      })
    )

    expect(error).toBe(programFailure)
    expect(disposed).toBe(1)
  })

  test('reports add disposal failures as Scope cleanup failures', async () => {
    const disposalFailure = new Error('dispose failed')
    const resource = {
      [Symbol.dispose]() {
        throw disposalFailure
      }
    }

    const error = await captureRejection(
      Scope.run(async () =>
        Effect.gen(async function* () {
          yield* Effect.add(resource)

          return Result.ok(true)
        })
      )
    )

    expect(error).toBeInstanceOf(ScopeCloseError)

    if (error instanceof ScopeCloseError) {
      expect(error.causes).toEqual([disposalFailure])
    }
  })

  test('preserves a thrown program cause over add disposal failure', async () => {
    const programFailure = new Error('program failed')
    const disposalFailure = new Error('dispose failed')
    const resource = {
      [Symbol.dispose]() {
        throw disposalFailure
      }
    }

    const error = await captureRejection(
      Scope.run(async () => {
        await Effect.gen(async function* () {
          yield* Effect.add(resource)

          return Result.ok(true)
        })

        throw programFailure
      })
    )

    expect(error).toBe(programFailure)
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

  test('preserves the existing missing Scope failure for add', async () => {
    let disposed = 0
    const resource = {
      [Symbol.dispose]() {
        disposed++
      }
    }

    const error = await captureRejection(
      Effect.gen(async function* () {
        const added = yield* Effect.add(resource)

        return Result.ok(added)
      })
    )

    expect((error as { cause?: unknown }).cause).toBeInstanceOf(ScopeRuntimeNotConfiguredError)
    expect(disposed).toBe(0)
  })

  test('normalizes add registration races and disposes immediately', async () => {
    let releaseClosingScope!: () => void
    let closingStarted = false
    let disposed = 0
    const scope = Scope.make()

    scope.addFinalizer(
      () =>
        new Promise<void>((resolve) => {
          closingStarted = true
          releaseClosingScope = resolve
        })
    )

    const closing = scope.close()

    while (!closingStarted) {
      await Promise.resolve()
    }

    const resource = {
      [Symbol.dispose]() {
        disposed++
      }
    }

    const result = await Scope.provide(scope, () =>
      Effect.gen(async function* () {
        const added = yield* Effect.add(resource)

        return Result.ok(added)
      })
    )

    expect(Result.isError(result)).toBe(true)

    if (Result.isError(result)) {
      expect(result.error).toBeInstanceOf(UnhandledException)
      expect((result.error as UnhandledException).cause).toBeInstanceOf(ScopeClosedError)
    }

    expect(disposed).toBe(1)

    releaseClosingScope()
    await closing
  })

  test('preserves add registration and immediate disposal failures', async () => {
    let releaseClosingScope!: () => void
    let closingStarted = false
    const disposalFailure = new Error('dispose failed')
    const scope = Scope.make()

    scope.addFinalizer(
      () =>
        new Promise<void>((resolve) => {
          closingStarted = true
          releaseClosingScope = resolve
        })
    )

    const closing = scope.close()

    while (!closingStarted) {
      await Promise.resolve()
    }

    const result = await Scope.provide(scope, () =>
      Effect.gen(async function* () {
        const added = yield* Effect.add({
          [Symbol.dispose]() {
            throw disposalFailure
          }
        })

        return Result.ok(added)
      })
    )

    expect(Result.isError(result)).toBe(true)

    if (Result.isError(result)) {
      expect(result.error).toBeInstanceOf(UnhandledException)

      const cause = (result.error as UnhandledException).cause

      expect(cause).toBeInstanceOf(AggregateError)

      if (cause instanceof AggregateError) {
        expect(cause.errors).toEqual(
          expect.arrayContaining([expect.any(ScopeClosedError), disposalFailure])
        )
      }
    }

    releaseClosingScope()
    await closing
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
