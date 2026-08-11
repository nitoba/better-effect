import { describe, expect, test } from 'bun:test'

import { Result } from 'better-result'

import { Effect } from '../src/effect'
import {
  ResourceNotDisposableError,
  Scope,
  ScopeCloseError,
  ScopeClosedError,
  ScopeRuntimeNotConfiguredError
} from '../src/scope'

const captureRejection = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (cause) => cause
  )

describe('Scope', () => {
  test('provides the current scope', async () => {
    await Scope.run(async (expected) => {
      expect(Scope.current()).toBe(expected)
    })
  })

  test('is available through yield*', async () => {
    await Scope.run(async (expected) => {
      const result = await Effect.gen(async function* () {
        const scope = yield* Scope

        return Result.ok(scope)
      })

      expect(Result.isOk(result)).toBe(true)

      if (Result.isOk(result)) {
        expect(result.value).toBe(expected)
      }
    })
  })

  test('throws outside a scope context', () => {
    expect(() => Scope.current()).toThrow(ScopeRuntimeNotConfiguredError)
  })

  test('runs finalizers in reverse order', async () => {
    const events: string[] = []
    const scope = Scope.make()

    scope.addFinalizer(() => {
      events.push('first')
    })

    scope.addFinalizer(() => {
      events.push('second')
    })

    scope.addFinalizer(() => {
      events.push('third')
    })

    await scope.close()

    expect(events).toEqual(['third', 'second', 'first'])
  })

  test('close is idempotent and shared by concurrent callers', async () => {
    let releases = 0
    const scope = Scope.make()

    scope.addFinalizer(async () => {
      await Promise.resolve()
      releases++
    })

    await Promise.all([scope.close(), scope.close()])

    expect(releases).toBe(1)
  })

  test('rejects additions after close', async () => {
    const scope = Scope.make()

    await scope.close()

    expect(() => scope.addFinalizer(() => undefined)).toThrow(ScopeClosedError)
    const error = await captureRejection(scope.add({ [Symbol.dispose]: () => undefined }))

    expect(error).toBeInstanceOf(ScopeClosedError)
  })

  test('acquires and releases resources', async () => {
    let released = false
    const scope = Scope.make()

    const resource = await scope.acquire(
      () => ({ value: 42 }),
      () => {
        released = true
      }
    )

    expect(resource.value).toBe(42)
    expect(released).toBe(false)

    await scope.close()

    expect(released).toBe(true)
  })

  test('releases an acquired resource if the scope closes during acquisition', async () => {
    let resolveAcquire: ((value: { value: 42 }) => void) | undefined
    let released = false
    const scope = Scope.make()

    const acquisition = scope.acquire(
      () =>
        new Promise<{ value: 42 }>((resolve) => {
          resolveAcquire = resolve
        }),
      () => {
        released = true
      }
    )

    await scope.close()
    resolveAcquire?.({ value: 42 })

    const error = await captureRejection(acquisition)

    expect(error).toBeInstanceOf(ScopeClosedError)
    expect(released).toBe(true)
  })

  test('automatically registers disposable resources', async () => {
    let disposed = false
    const scope = Scope.make()

    const resource = await scope.add({
      [Symbol.dispose]() {
        disposed = true
      }
    })

    expect(resource[Symbol.dispose]).toBeFunction()

    await scope.close()

    expect(disposed).toBe(true)
  })

  test('rejects resources without a disposer', async () => {
    const scope = Scope.make()

    const error = await captureRejection(scope.add({}))

    expect(error).toBeInstanceOf(ResourceNotDisposableError)
  })

  test('prefers Symbol.asyncDispose', async () => {
    const events: string[] = []
    const scope = Scope.make()

    await scope.add({
      [Symbol.dispose]() {
        events.push('dispose')
      },

      async [Symbol.asyncDispose]() {
        events.push('asyncDispose')
      }
    })

    await scope.close()

    expect(events).toEqual(['asyncDispose'])
  })

  test('runs every finalizer when one fails', async () => {
    const events: string[] = []
    const scope = Scope.make()

    scope.addFinalizer(() => {
      events.push('first')
    })

    scope.addFinalizer(() => {
      events.push('second')
      throw new Error('boom')
    })

    scope.addFinalizer(() => {
      events.push('third')
    })

    const error = await captureRejection(scope.close())

    expect(error).toBeInstanceOf(ScopeCloseError)
    expect(events).toEqual(['third', 'second', 'first'])
  })

  test('closes the scope after a successful run', async () => {
    let released = false

    await Scope.run(async (scope) => {
      await scope.acquire(
        () => ({ value: 42 }),
        () => {
          released = true
        }
      )

      expect(released).toBe(false)
    })

    expect(released).toBe(true)
  })

  test('closes the scope after a failed run', async () => {
    let released = false
    const failure = new Error('program failed')

    const error = await captureRejection(
      Scope.run(async (scope) => {
        await scope.acquire(
          () => ({ value: 42 }),
          () => {
            released = true
          }
        )

        throw failure
      })
    )

    expect(error).toBe(failure)

    expect(released).toBe(true)
  })
})
