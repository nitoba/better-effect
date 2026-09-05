import { describe, expect, test } from 'bun:test'
import { APIError } from 'better-auth/api'
import {
  CurrentAbortSignal,
  Effect,
  Layer,
  Runtime,
  ServiceAcquisitionError,
  ServiceRuntime,
  ScopeCloseError,
  Service
} from 'better-effect'
import { Result, TaggedError } from 'better-result'

import {
  BetterAuthHooks,
  type BetterAuthMiddleware,
  type BetterAuthMiddlewareContext
} from '../src/hooks'

class Denied extends TaggedError('@hooks/Denied')<{
  readonly message: string
}> {}

class RequestMetadata extends Service<RequestMetadata>()('@hooks/RequestMetadata') {
  constructor(readonly id: string) {
    super()
  }
}

class FailingService extends Service<FailingService>()('@hooks/FailingService') {}

class CapturedAuth extends Service<CapturedAuth>()('@hooks/CapturedAuth') {
  constructor(readonly middleware: BetterAuthMiddleware) {
    super()
  }
}

class CapturedMiddlewares extends Service<CapturedMiddlewares>()('@hooks/CapturedMiddlewares') {
  constructor(
    readonly programSync: BetterAuthMiddleware,
    readonly programRejected: BetterAuthMiddleware,
    readonly mapperSync: BetterAuthMiddleware,
    readonly mapperRejected: BetterAuthMiddleware
  ) {
    super()
  }
}

// oxlint-disable-next-line anti-slop/no-unknown-returns -- tests need to inspect arbitrary rejection causes.
const captureRejection = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (cause) => cause
  )

const acquireMiddleware = async (layer: Layer.Any) => {
  const runtime = await Runtime.make(layer)
  const captured = await runtime.run(() => ServiceRuntime.resolve(CapturedAuth))
  return { middleware: captured.middleware, runtime }
}

describe('BetterAuthHooks', () => {
  test('define captures the active Runtime executor during Layer acquisition', async () => {
    const hooks = BetterAuthHooks.define('@test/DefinedHookContext')
    let programCalls = 0
    let capturedContext: BetterAuthMiddlewareContext | undefined

    const authLayer = Layer.gen(CapturedAuth, async function* () {
      const middleware = yield* hooks.gen(async function* () {
        const hook = yield* hooks.Context
        programCalls += 1
        capturedContext = hook.context
        return Result.ok({ context: { defined: true } })
      })

      return CapturedAuth.of({ middleware })
    })
    const runtime = await Runtime.make(authLayer)

    try {
      expect(Object.isFrozen(hooks)).toBe(true)
      expect(programCalls).toBe(0)

      const auth = await runtime.run(() => ServiceRuntime.resolve(CapturedAuth))
      expect(programCalls).toBe(0)

      const context = {}
      expect(await auth.middleware(context)).toEqual({ context: { defined: true } })
      expect(programCalls).toBe(1)
      expect(capturedContext).toBeDefined()
      expect(capturedContext?.request).toBeUndefined()
    } finally {
      await runtime.dispose()
    }
  })

  test('runs each middleware call in an isolated Context scope without owning the Runtime', async () => {
    const hooks = BetterAuthHooks.define('@test/HookContext')
    const contexts: BetterAuthMiddlewareContext[] = []
    let programCalls = 0
    let release!: () => void
    let resolveStarted!: () => void
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })
    const ready = new Promise<void>((resolve) => {
      release = resolve
    })

    const operation = hooks.middleware((context) =>
      Effect.fn(async function* () {
        const scoped = yield* hooks.Context
        programCalls += 1
        contexts.push(scoped.context)
        resolveStarted()
        await ready
        expect(scoped.context).toBe(context)
        return Result.ok({ context: { hook: true } })
      })
    )
    const { middleware, runtime } = await acquireMiddleware(
      Layer.gen(CapturedAuth, async function* () {
        return CapturedAuth.of({ middleware: yield* operation })
      })
    )

    const request = new Request('https://example.test/hooks')
    const pending = middleware({ request })
    await started
    expect(runtime.inspect().state).toBe('active')
    release()

    const output = await pending
    expect(output).toEqual({ context: { hook: true } })
    expect(programCalls).toBe(1)
    expect(contexts).toHaveLength(1)
    expect(contexts[0]?.request).toBe(request)
    expect(runtime.inspect().state).toBe('active')
    let outsideResolution: unknown
    try {
      await ServiceRuntime.resolve(hooks.Context)
    } catch (cause) {
      outsideResolution = cause
    }
    expect(outsideResolution).toBeDefined()

    await runtime.dispose()
  })

  test('keeps concurrent invocation Context values separate', async () => {
    const hooks = BetterAuthHooks.define('@test/ConcurrentHookContext')
    const contexts: BetterAuthMiddlewareContext[] = []
    const releases: (() => void)[] = []
    let resolveBoth!: () => void
    const bothSeen = new Promise<void>((resolve) => {
      resolveBoth = resolve
    })

    const operation = hooks.middleware((_context) =>
      Effect.fn(async function* () {
        const scoped = yield* hooks.Context
        contexts.push(scoped.context)

        if (contexts.length === 2) {
          resolveBoth()
        }

        await new Promise<void>((resolve) => {
          releases.push(resolve)
        })
        return Result.ok({ context: { path: scoped.context.path } })
      })
    )
    const { middleware, runtime } = await acquireMiddleware(
      Layer.gen(CapturedAuth, async function* () {
        return CapturedAuth.of({ middleware: yield* operation })
      })
    )

    const firstRequest = new Request('https://example.test/first')
    const secondRequest = new Request('https://example.test/second')
    const first = middleware({ request: firstRequest })
    const second = middleware({ request: secondRequest })

    await bothSeen
    expect(contexts[0]).not.toBe(contexts[1])
    expect(new Set(contexts.map((context) => context.request))).toEqual(
      new Set([firstRequest, secondRequest])
    )

    for (const release of releases) {
      release()
    }
    await Promise.all([first, second])
    await runtime.dispose()
  })

  test('creates per-invocation Layers from the Better Auth context and releases them', async () => {
    const hooks = BetterAuthHooks.define('@test/RequestLayerContext')
    const acquired: string[] = []
    const released: string[] = []

    const operation = hooks.middleware(
      (context) =>
        Effect.fn(async function* () {
          const metadata = yield* RequestMetadata
          expect((yield* hooks.Context).context).toBe(context)
          return Result.ok({ context: { path: metadata.id } })
        }),
      {
        layer: (context) =>
          Layer.scopedGen(
            RequestMetadata,
            async function* () {
              const scoped = yield* hooks.Context
              const id = context.request?.url ?? 'requestless'
              expect(scoped.context).toBe(context)
              acquired.push(id)
              return RequestMetadata.of({ id })
            },
            (metadata, outcome) => {
              released.push(`${metadata.id}:${outcome.status}`)
            }
          )
      }
    )
    const { middleware, runtime } = await acquireMiddleware(
      Layer.gen(CapturedAuth, async function* () {
        return CapturedAuth.of({ middleware: yield* operation })
      })
    )

    try {
      const firstRequest = new Request('https://example.test/first')
      const secondRequest = new Request('https://example.test/second')
      const [first, second] = await Promise.all([
        middleware({ request: firstRequest }),
        middleware({ request: secondRequest })
      ])

      expect(first).toEqual({ context: { path: firstRequest.url } })
      expect(second).toEqual({ context: { path: secondRequest.url } })
      expect(acquired).toEqual([firstRequest.url, secondRequest.url])
      expect(released).toHaveLength(2)
      expect(released.every((value) => value.endsWith(':success'))).toBe(true)
    } finally {
      await runtime.dispose()
    }
  })

  test('does not invent a Better Auth request for requestless middleware', async () => {
    const hooks = BetterAuthHooks.define('@test/RequestlessHookContext')
    let observed: BetterAuthMiddlewareContext | undefined

    const operation = hooks.middleware((context) =>
      Effect.fn(async function* () {
        observed = (yield* hooks.Context).context
        expect(context.request).toBeUndefined()
        return Result.ok()
      })
    )
    const { middleware, runtime } = await acquireMiddleware(
      Layer.gen(CapturedAuth, async function* () {
        return CapturedAuth.of({ middleware: yield* operation })
      })
    )

    try {
      expect(await middleware({})).toBeUndefined()
      expect(observed?.request).toBeUndefined()
    } finally {
      await runtime.dispose()
    }
  })

  test('preserves per-invocation Layer acquisition and cleanup failures', async () => {
    const hooks = BetterAuthHooks.define('@test/RequestLayerFailures')
    const acquisitionFailure = new Error('request layer acquisition failed')
    const acquisitionOperation = hooks.middleware(
      () =>
        Effect.fn(async function* () {
          yield* FailingService
          return Result.ok()
        }),
      {
        layer: () => Layer.make(FailingService, () => Promise.reject(acquisitionFailure))
      }
    )

    const { middleware: acquisitionMiddleware, runtime } = await acquireMiddleware(
      Layer.gen(CapturedAuth, async function* () {
        return CapturedAuth.of({ middleware: yield* acquisitionOperation })
      })
    )

    try {
      let acquisitionCause: unknown
      try {
        await acquisitionMiddleware({})
      } catch (cause) {
        acquisitionCause = cause
      }

      expect(acquisitionCause).toHaveProperty('cause')
      // SAFETY: toHaveProperty above establishes the wrapped error shape for this test fixture.
      const acquisitionError = (acquisitionCause as { readonly cause: unknown }).cause
      expect(acquisitionError).toBeInstanceOf(ServiceAcquisitionError)
      if (!(acquisitionError instanceof ServiceAcquisitionError)) {
        throw new Error('expected a ServiceAcquisitionError')
      }

      expect(acquisitionError.cause).toBe(acquisitionFailure)

      const cleanupFailure = new Error('request layer cleanup failed')
      const cleanupOperation = hooks.middleware(
        () =>
          Effect.fn(async function* () {
            yield* RequestMetadata
            return Result.ok()
          }),
        {
          layer: () =>
            Layer.scoped(
              RequestMetadata,
              () => RequestMetadata.of({ id: 'cleanup' }),
              () => Promise.reject(cleanupFailure)
            )
        }
      )

      const cleanupRuntime = await Runtime.make(
        Layer.gen(CapturedAuth, async function* () {
          return CapturedAuth.of({ middleware: yield* cleanupOperation })
        })
      )
      const cleanupMiddleware = (
        await cleanupRuntime.run(() => ServiceRuntime.resolve(CapturedAuth))
      ).middleware

      let cleanupCause: unknown
      try {
        await cleanupMiddleware({})
      } catch (cause) {
        cleanupCause = cause
      }

      expect(cleanupCause).toBeInstanceOf(ScopeCloseError)
      if (!(cleanupCause instanceof ScopeCloseError)) {
        throw new Error('expected a ScopeCloseError')
      }

      expect(cleanupCause.causes).toContain(cleanupFailure)
      await cleanupRuntime.dispose()
    } finally {
      await runtime.dispose()
    }
  })

  test('forwards the request cancellation signal to the Runtime execution', async () => {
    const hooks = BetterAuthHooks.define('@test/CancellationHookContext')
    let resolveStarted!: () => void
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })

    const operation = hooks.middleware((context) =>
      Effect.fn(async function* () {
        const signal = yield* CurrentAbortSignal
        const hookContext = yield* hooks.Context
        expect(context.request).toBeDefined()
        expect(hookContext.context).toBe(context)
        expect(hookContext.context.request).toBe(context.request)
        expect(hookContext.context.request?.signal).toBe(context.request?.signal)
        expect(signal).not.toBe(context.request!.signal)
        resolveStarted()
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
        return Result.ok({ context: { cancelled: signal.aborted } })
      })
    )
    const { middleware, runtime } = await acquireMiddleware(
      Layer.gen(CapturedAuth, async function* () {
        return CapturedAuth.of({ middleware: yield* operation })
      })
    )

    const controller = new AbortController()
    const pending = middleware({
      request: new Request('https://example.test/cancel', {
        signal: controller.signal
      })
    })
    await started
    controller.abort(new Error('request cancelled'))

    const output = await pending
    expect(output).toEqual({ context: { cancelled: true } })
    await runtime.dispose()
  })

  test('preserves program and failure-mapper defect identity', async () => {
    const hooks = BetterAuthHooks.define('@test/DefectIdentity')
    const programSyncDefect = new Error('program sync defect')
    const programRejectedDefect = new Error('program rejected defect')
    const mapperSyncDefect = new Error('mapper sync defect')
    const mapperRejectedDefect = new Error('mapper rejected defect')
    const unsafeProgram = (run: () => void | Promise<never>) => {
      const unchecked: unknown = run
      // SAFETY: This intentionally models a JavaScript caller supplying a Program whose body defects before Result runs.
      // oxlint-disable-next-line anti-slop/no-widen-then-assert -- tests intentionally cross the nominal Program boundary.
      return unchecked as Effect.Program<void, never, never>
    }

    const programSyncOperation = hooks.middleware(() =>
      unsafeProgram(() => {
        throw programSyncDefect
      })
    )
    const programRejectedOperation = hooks.middleware(() =>
      unsafeProgram(() => Promise.reject(programRejectedDefect))
    )
    const typedFailureProgram = () =>
      Effect.fn(async function* () {
        yield* []
        return Result.err(new Denied({ message: 'mapper failure' }))
      })
    const mapperSyncOperation = hooks.middleware(() => typedFailureProgram(), {
      onFailure: () => {
        throw mapperSyncDefect
      }
    })
    const mapperRejectedOperation = hooks.middleware(() => typedFailureProgram(), {
      onFailure: () => Promise.reject(mapperRejectedDefect)
    })

    const runtime = await Runtime.make(
      Layer.gen(CapturedMiddlewares, async function* () {
        return CapturedMiddlewares.of({
          programSync: yield* programSyncOperation,
          programRejected: yield* programRejectedOperation,
          mapperSync: yield* mapperSyncOperation,
          mapperRejected: yield* mapperRejectedOperation
        })
      })
    )
    const captured = await runtime.run(() => ServiceRuntime.resolve(CapturedMiddlewares))

    try {
      expect(await captureRejection(captured.programSync({}))).toBe(programSyncDefect)
      expect(await captureRejection(captured.programRejected({}))).toBe(programRejectedDefect)
      expect(await captureRejection(captured.mapperSync({}))).toBe(mapperSyncDefect)
      expect(await captureRejection(captured.mapperRejected({}))).toBe(mapperRejectedDefect)
    } finally {
      await runtime.dispose()
    }
  })

  test('preserves an already-aborted request signal reason and identity', async () => {
    const hooks = BetterAuthHooks.define('@test/AlreadyAbortedSignal')
    const reason = new Error('request already cancelled')
    const controller = new AbortController()
    controller.abort(reason)
    let observedSignal: AbortSignal | undefined

    const operation = hooks.middleware(() =>
      Effect.fn(async function* () {
        const signal = yield* CurrentAbortSignal
        observedSignal = signal
        return Result.ok({
          context: {
            aborted: signal.aborted,
            reason: signal.reason
          }
        })
      })
    )
    const { middleware, runtime } = await acquireMiddleware(
      Layer.gen(CapturedAuth, async function* () {
        return CapturedAuth.of({ middleware: yield* operation })
      })
    )
    const request = new Request('https://example.test/already-cancelled', {
      signal: controller.signal
    })

    try {
      const output = await middleware({ request })
      expect(output).toEqual({ context: { aborted: true, reason } })
      expect(observedSignal).not.toBe(request.signal)
      expect(observedSignal?.reason).toBe(reason)
    } finally {
      await runtime.dispose()
    }
  })

  test('cancels active hooks on Runtime shutdown and closes their execution Scope', async () => {
    const hooks = BetterAuthHooks.define('@test/ShutdownCancellation')
    let resolveStarted!: () => void
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })
    let releaseStatus: string | undefined

    const operation = hooks.middleware(
      () =>
        Effect.fn(async function* () {
          yield* RequestMetadata
          const shutdownSignal = yield* CurrentAbortSignal
          resolveStarted()
          await new Promise<void>((resolve) => {
            shutdownSignal.addEventListener('abort', () => resolve(), { once: true })
          })
          return Result.ok({ context: { shutdown: shutdownSignal.aborted } })
        }),
      {
        layer: () =>
          Layer.scoped(
            RequestMetadata,
            () => RequestMetadata.of({ id: 'shutdown' }),
            (_metadata, outcome) => {
              releaseStatus = outcome.status
            }
          )
      }
    )
    const { middleware, runtime } = await acquireMiddleware(
      Layer.gen(CapturedAuth, async function* () {
        return CapturedAuth.of({ middleware: yield* operation })
      })
    )

    const pending = middleware({})
    await started
    await runtime.dispose({ gracePeriod: 0, abortAfterGracePeriod: true })

    expect(await pending).toEqual({ context: { shutdown: true } })
    expect(releaseStatus).toBe('success')
  })

  test('closes the execution Scope before resolving the middleware', async () => {
    const hooks = BetterAuthHooks.define('@test/LifecycleHookContext')
    let released = false
    const disposable = {
      [Symbol.dispose]: () => {
        released = true
      }
    }

    const operation = hooks.middleware(
      () =>
        Effect.fn(async function* () {
          yield* Effect.add(disposable)
          return Result.ok()
        }),
      {
        onFailure: () => new Response(null, { status: 500 })
      }
    )
    const { middleware, runtime } = await acquireMiddleware(
      Layer.gen(CapturedAuth, async function* () {
        return CapturedAuth.of({ middleware: yield* operation })
      })
    )

    const value = await middleware({})
    expect(value).toBeUndefined()
    expect(released).toBe(true)
    await runtime.dispose()
  })

  test('maps typed failures to Better Auth APIError or preserves a Response identity', async () => {
    const hooks = BetterAuthHooks.define('@test/FailureHookContext')
    let mappedFailure: Denied | undefined
    let mappedContext: BetterAuthMiddlewareContext | undefined

    const apiErrorOperation = hooks.middleware(
      () =>
        Effect.fn(async function* () {
          yield* []
          return Result.err(new Denied({ message: 'denied' }))
        }),
      {
        onFailure: (failure, context) => {
          mappedFailure = failure
          mappedContext = context
          return new APIError('FORBIDDEN', {
            code: 'DENIED',
            message: failure.message
          })
        }
      }
    )

    const response = new Response('denied', { status: 403 })
    let mapperFinished = false
    const responseOperation = hooks.middleware(
      () =>
        Effect.fn(async function* () {
          yield* []
          return Result.err(new Denied({ message: 'denied' }))
        }),
      {
        onFailure: async () => {
          await Promise.resolve()
          mapperFinished = true
          return response
        }
      }
    )

    const runtime = await Runtime.make(
      Layer.gen(CapturedMiddlewares, async function* () {
        return CapturedMiddlewares.of({
          programSync: yield* apiErrorOperation,
          programRejected: yield* responseOperation,
          mapperSync: yield* apiErrorOperation,
          mapperRejected: yield* responseOperation
        })
      })
    )
    const captured = await runtime.run(() => ServiceRuntime.resolve(CapturedMiddlewares))
    const apiErrorMiddleware = captured.programSync
    const responseMiddleware = captured.programRejected

    let thrown: unknown
    try {
      await apiErrorMiddleware({})
    } catch (cause) {
      thrown = cause
    }

    expect(thrown).toBeInstanceOf(APIError)
    expect(mappedFailure?.message).toBe('denied')
    expect(mappedContext).toBeDefined()

    const mappedResponse = await responseMiddleware({})
    expect(mappedResponse).toBe(response)
    expect(mapperFinished).toBe(true)
    await runtime.dispose()
  })

  test('propagates a disposed Runtime failure instead of creating a replacement Runtime', async () => {
    const hooks = BetterAuthHooks.define('@test/DisposedHookContext')
    const operation = hooks.middleware(() =>
      Effect.fn(async function* () {
        yield* []
        return Result.ok()
      })
    )
    const { middleware, runtime } = await acquireMiddleware(
      Layer.gen(CapturedAuth, async function* () {
        return CapturedAuth.of({ middleware: yield* operation })
      })
    )

    await runtime.dispose()
    let runtimeFailure: unknown
    try {
      await middleware({})
    } catch (cause) {
      runtimeFailure = cause
    }
    expect(runtimeFailure).toBeDefined()
  })
})
