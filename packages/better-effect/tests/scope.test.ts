import { describe, expect, test } from 'bun:test'

import { Result } from 'better-result'

import { Effect } from '../src/effect'
import { RuntimeContextNotConfiguredError } from '../src/runtime'
import {
  ResourceNotDisposableError,
  Scope,
  ScopeCloseError,
  ScopeClosedError,
  ScopeRuntimeNotConfiguredError
} from '../src/scope'

import type { RuntimeContextStorage } from '../src/runtime'
import type { DisposableResource, ScopeOutcome } from '../src/scope'

import { ScopeRuntime } from '../src/scope/runtime'

const captureRejection = async (promise: Promise<unknown>) =>
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

  test('closes children and finalizers after synchronous context storage failure', async () => {
    const parent = Scope.make()
    const child = parent.fork()
    const storageFailure = new Error('storage failed')
    const finalizerFailure = new Error('finalizer failed')
    const events: string[] = []
    const storage: RuntimeContextStorage = {
      run: () => {
        throw storageFailure
      },
      current: () => {
        throw new RuntimeContextNotConfiguredError()
      }
    }

    child.addFinalizer(() => {
      events.push('child')
    })
    parent.addFinalizer(() => {
      events.push('first')
      throw finalizerFailure
    })
    parent.addFinalizer(() => {
      events.push('second')
    })
    ScopeRuntime.bind(parent, storage)

    const firstClose = parent.close()
    const secondClose = parent.close({ status: 'failure', cause: finalizerFailure })

    expect(secondClose).toBe(firstClose)

    const error = await captureRejection(firstClose)

    expect(error).toBeInstanceOf(ScopeCloseError)

    if (error instanceof ScopeCloseError) {
      expect(error.causes).toEqual([storageFailure, finalizerFailure])
    }

    expect(events).toEqual(['child', 'second', 'first'])
    expect(() => parent.addFinalizer(() => undefined)).toThrow(ScopeClosedError)
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

  test('automatically registers async-only disposable resources', async () => {
    let disposed = false
    const scope = Scope.make()

    const resource = await scope.add({
      async [Symbol.asyncDispose]() {
        await Promise.resolve()
        disposed = true
      }
    })

    expect(resource[Symbol.asyncDispose]).toBeFunction()

    await scope.close()

    expect(disposed).toBe(true)
  })

  test('rejects resources without a disposer', async () => {
    const scope = Scope.make()

    // SAFETY: This cast deliberately simulates an invalid runtime resource to verify Scope.add rejects it.
    const invalid = {} as DisposableResource
    const error = await captureRejection(scope.add(invalid))

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

  test('disposes a resource immediately when adding to a closing Scope', async () => {
    let releaseClosingScope!: () => void
    let closingStarted = false
    let disposed = false
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
        disposed = true
      }
    }

    const error = await captureRejection(scope.add(resource))

    expect(error).toBeInstanceOf(ScopeClosedError)
    expect(disposed).toBe(true)

    releaseClosingScope()
    await closing
  })

  test('preserves registration and immediate disposal failures', async () => {
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

    const error = await captureRejection(
      scope.add({
        [Symbol.dispose]() {
          throw disposalFailure
        }
      })
    )

    expect(error).toBeInstanceOf(AggregateError)

    if (error instanceof AggregateError) {
      expect(error.errors).toEqual(
        expect.arrayContaining([expect.any(ScopeClosedError), disposalFailure])
      )
    }

    releaseClosingScope()
    await closing
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

  test('forks child scopes and detaches them after close', async () => {
    let releases = 0
    const parent = Scope.make()
    const child = parent.fork()

    child.addFinalizer(() => {
      releases++
    })

    await child.close()
    await parent.close()

    expect(releases).toBe(1)
  })

  test('does not retry a child finalizer after a failed child close', async () => {
    let attempts = 0
    const parent = Scope.make()
    const child = parent.fork()

    child.addFinalizer(() => {
      attempts++
      throw new Error('child failed')
    })

    await captureRejection(child.close())
    await parent.close()

    expect(attempts).toBe(1)
  })

  test('rejects forking after the parent starts closing', async () => {
    const parent = Scope.make()
    const closing = parent.close()

    expect(() => parent.fork()).toThrow(ScopeClosedError)

    await closing
  })

  test('closes children before parent finalizers in reverse order', async () => {
    const events: string[] = []
    const parent = Scope.make()
    const first = parent.fork()
    const second = parent.fork()

    first.addFinalizer(() => {
      events.push('first-child')
    })

    second.addFinalizer(() => {
      events.push('second-child')
    })

    parent.addFinalizer(() => {
      events.push('parent')
    })

    await parent.close()

    expect(events).toEqual(['second-child', 'first-child', 'parent'])
  })

  test('continues parent cleanup when a child close fails', async () => {
    const events: string[] = []
    const parent = Scope.make()
    const failingChild = parent.fork()
    const succeedingChild = parent.fork()

    failingChild.addFinalizer(() => {
      events.push('failing-child')
      throw new Error('child failed')
    })

    succeedingChild.addFinalizer(() => {
      events.push('succeeding-child')
    })

    parent.addFinalizer(() => {
      events.push('parent')
    })

    const error = await captureRejection(parent.close())

    expect(error).toBeInstanceOf(ScopeCloseError)
    expect(events).toEqual(['succeeding-child', 'failing-child', 'parent'])
  })

  test('provides an existing scope without closing it', async () => {
    let released = false
    const scope = Scope.make()

    await Scope.provide(scope, async () => {
      expect(Scope.current()).toBe(scope)

      await scope.acquire(
        () => ({ value: 42 }),
        () => {
          released = true
        }
      )
    })

    expect(released).toBe(false)

    await scope.close()

    expect(released).toBe(true)
  })

  test('restores the parent context after providing a child scope', async () => {
    await Scope.run(async (parent) => {
      const child = parent.fork()

      expect(Scope.current()).toBe(parent)

      await Scope.provide(child, async () => {
        expect(Scope.current()).toBe(child)
      })

      expect(Scope.current()).toBe(parent)

      await child.close()
    })
  })

  test('passes success and failure outcomes to finalizers', async () => {
    const successOutcomes: ScopeOutcome[] = []
    const successScope = Scope.make()

    successScope.addFinalizer((outcome) => {
      successOutcomes.push(outcome)
    })

    await successScope.close()

    const failure = new Error('scope failed')
    const failureOutcomes: ScopeOutcome[] = []
    const failureScope = Scope.make()

    failureScope.addFinalizer((outcome) => {
      failureOutcomes.push(outcome)
    })

    await failureScope.close({ status: 'failure', cause: failure })

    expect(successOutcomes).toEqual([{ status: 'success' }])
    expect(failureOutcomes).toEqual([{ status: 'failure', cause: failure }])
  })

  test('first close outcome wins', async () => {
    const scope = Scope.make()
    const firstFailure = new Error('first close')
    let observed: ScopeOutcome | undefined

    scope.addFinalizer((outcome) => {
      observed = outcome
    })

    const first = scope.close({ status: 'failure', cause: firstFailure })
    const second = scope.close()

    expect(second).toBe(first)

    await first

    expect(observed).toEqual({ status: 'failure', cause: firstFailure })
  })

  test('propagates parent outcomes and preserves a child outcome already in progress', async () => {
    const parent = Scope.make()
    const child = parent.fork()
    const parentFailure = new Error('parent failed')
    const childOutcomes: ScopeOutcome[] = []
    const parentOutcomes: ScopeOutcome[] = []

    child.addFinalizer((outcome) => {
      childOutcomes.push(outcome)
    })

    parent.addFinalizer((outcome) => {
      parentOutcomes.push(outcome)
    })

    await child.close()
    await parent.close({ status: 'failure', cause: parentFailure })

    expect(childOutcomes).toEqual([{ status: 'success' }])
    expect(parentOutcomes).toEqual([{ status: 'failure', cause: parentFailure }])
  })

  test('flattens child close errors in the parent close error', async () => {
    const parent = Scope.make()
    const first = parent.fork()
    const second = parent.fork()
    const firstFailure = new Error('first child failed')
    const secondFailure = new Error('second child failed')
    const parentFailure = new Error('parent failed')

    first.addFinalizer(() => {
      throw firstFailure
    })

    second.addFinalizer(() => {
      throw secondFailure
    })

    parent.addFinalizer(() => {
      throw parentFailure
    })

    const error = await captureRejection(parent.close())

    expect(error).toBeInstanceOf(ScopeCloseError)

    if (error instanceof ScopeCloseError) {
      expect(error.causes).toEqual([secondFailure, firstFailure, parentFailure])
      expect(error.causes.some((cause) => cause instanceof ScopeCloseError)).toBe(false)
    }
  })

  test('keeps generic Scope.run Result errors as successful Scope outcomes', async () => {
    let observed: ScopeOutcome | undefined
    const error = new Error('typed failure')

    const result = await Scope.run(async (scope) => {
      scope.addFinalizer((outcome) => {
        observed = outcome
      })

      return Result.err(error)
    })

    expect(Result.isError(result)).toBe(true)

    if (Result.isError(result)) {
      expect(result.error).toBe(error)
    }

    expect(observed).toEqual({ status: 'success' })
  })

  test('passes the close outcome to acquired resource releases', async () => {
    const scope = Scope.make()
    const failure = new Error('release outcome')
    let observed: ScopeOutcome | undefined

    await scope.acquire(
      () => ({ value: true }),
      (_resource, outcome) => {
        observed = outcome
      }
    )

    await scope.close({ status: 'failure', cause: failure })

    expect(observed).toEqual({ status: 'failure', cause: failure })
  })

  test('preserves program and cleanup failures from Scope.run', async () => {
    const programFailure = new Error('program failed')
    const cleanupFailure = new Error('cleanup failed')

    const error = await captureRejection(
      Scope.run(async (scope) => {
        scope.addFinalizer(() => {
          throw cleanupFailure
        })

        throw programFailure
      })
    )

    expect(error).toBe(programFailure)
  })
})
