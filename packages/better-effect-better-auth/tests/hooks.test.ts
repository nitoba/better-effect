import { describe, expect, test } from 'bun:test'
import { APIError } from 'better-auth/api'
import { CurrentAbortSignal, Effect, Layer, Runtime, ServiceRuntime } from 'better-effect'
import { Result, TaggedError } from 'better-result'

import { BetterAuthHooks, type BetterAuthMiddlewareContext } from '../src/hooks'

class Denied extends TaggedError('@hooks/Denied')<{
  readonly message: string
}> {}

describe('BetterAuthHooks', () => {
  test('runs each middleware call in an isolated Context scope without owning the Runtime', async () => {
    const runtime = await Runtime.make(Layer.empty)
    const hooks = BetterAuthHooks.make('@test/HookContext', runtime)
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

    const middleware = hooks.middleware((context) =>
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
    const runtime = await Runtime.make(Layer.empty)
    const hooks = BetterAuthHooks.make('@test/ConcurrentHookContext', runtime)
    const contexts: BetterAuthMiddlewareContext[] = []
    const releases: (() => void)[] = []
    let resolveBoth!: () => void
    const bothSeen = new Promise<void>((resolve) => {
      resolveBoth = resolve
    })

    const middleware = hooks.middleware((_context) =>
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

  test('forwards the request cancellation signal to the Runtime execution', async () => {
    const runtime = await Runtime.make(Layer.empty)
    const hooks = BetterAuthHooks.make('@test/CancellationHookContext', runtime)
    let resolveStarted!: () => void
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })

    const middleware = hooks.middleware((_context) =>
      Effect.fn(async function* () {
        const signal = yield* CurrentAbortSignal
        resolveStarted()
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
        return Result.ok({ context: { cancelled: signal.aborted } })
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

  test('closes the execution Scope before resolving the middleware', async () => {
    const runtime = await Runtime.make(Layer.empty)
    const hooks = BetterAuthHooks.make('@test/LifecycleHookContext', runtime)
    let released = false
    const disposable = {
      [Symbol.dispose]: () => {
        released = true
      }
    }

    const middleware = hooks.middleware(
      () =>
        Effect.fn(async function* () {
          yield* Effect.add(disposable)
          return Result.ok()
        }),
      {
        onFailure: () => new Response(null, { status: 500 })
      }
    )

    const value = await middleware({})
    expect(value).toBeUndefined()
    expect(released).toBe(true)
    await runtime.dispose()
  })

  test('maps typed failures to Better Auth APIError or preserves a Response identity', async () => {
    const runtime = await Runtime.make(Layer.empty)
    const hooks = BetterAuthHooks.make('@test/FailureHookContext', runtime)
    let mappedFailure: Denied | undefined
    let mappedContext: BetterAuthMiddlewareContext | undefined

    const apiErrorMiddleware = hooks.middleware(
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

    let thrown: unknown
    try {
      await apiErrorMiddleware({})
    } catch (cause) {
      thrown = cause
    }

    expect(thrown).toBeInstanceOf(APIError)
    expect(mappedFailure?.message).toBe('denied')
    expect(mappedContext).toBeDefined()

    const response = new Response('denied', { status: 403 })
    let mapperFinished = false
    const responseMiddleware = hooks.middleware(
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

    const mappedResponse = await responseMiddleware({})
    expect(mappedResponse).toBe(response)
    expect(mapperFinished).toBe(true)
    await runtime.dispose()
  })

  test('propagates a disposed Runtime failure instead of creating a replacement Runtime', async () => {
    const runtime = await Runtime.make(Layer.empty)
    const hooks = BetterAuthHooks.make('@test/DisposedHookContext', runtime)
    const middleware = hooks.middleware(() =>
      Effect.fn(async function* () {
        yield* []
        return Result.ok()
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
