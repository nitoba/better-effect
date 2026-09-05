import { describe, expect, test } from 'bun:test'
import { APIError } from 'better-auth/api'
import { Hono } from 'hono'
import { Effect, Layer, Runtime, Service } from 'better-effect'
import { HonoEffect } from 'better-effect/hono'
import { Result, UnhandledException } from 'better-result'

import {
  BetterAuth,
  BetterAuthApiError,
  type BetterAuthOperation,
  type BetterAuthSessionReadOptions,
  Unauthenticated
} from '../src'
import {
  BetterAuthHono,
  type BetterAuthHonoSessionOptions,
  type BetterAuthHonoSessionValue
} from '../src/hono'

const wait = async (milliseconds: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, milliseconds))
}

type Session = {
  readonly session: {
    readonly id: string
  }
  readonly user: {
    readonly id: string
    readonly plan: 'pro'
  }
}

type SessionInput = {
  readonly headers: Headers
  readonly request?: Request
  readonly query?: BetterAuthSessionReadOptions
}

type SessionBehavior = (input: SessionInput) => Promise<Session | null>
type FakeInfer = { readonly Session: Session }

const execute = <A, E>(operation: BetterAuthOperation<A, E>) =>
  Result.gen(async function* () {
    return Result.ok(yield* operation)
  })

const makeAuth = (behavior: SessionBehavior) => {
  const calls: SessionInput[] = []
  const rawAuth = {
    $ERROR_CODES: {
      SESSION_FAILURE: {
        code: 'SESSION_FAILURE',
        message: 'The session lookup failed'
      }
    },
    // SAFETY: the fake Better Auth instance exposes the concrete fixture session through $Infer.
    $Infer: {} as FakeInfer,
    api: {
      getSession: async (input: SessionInput) => {
        calls.push(input)
        return await behavior(input)
      }
    },
    handler: async (_request: Request) => new Response('auth')
  }
  const Auth = BetterAuth.service('@hono-test/Auth', rawAuth)

  return { Auth, calls, rawAuth }
}

const successSession = (id: string): Session => ({
  session: { id: `session-${id}` },
  user: { id, plan: 'pro' }
})

describe('BetterAuthHono', () => {
  test('keeps session lookup lazy, memoizes success, and forwards the request headers/options', async () => {
    const fixture = makeAuth(async (input) => {
      await wait(2)
      return successSession(input.headers.get('x-user') ?? 'anonymous')
    })
    const options = {
      disableCookieCache: true,
      disableRefresh: false
    } satisfies BetterAuthHonoSessionOptions
    const CurrentSession = BetterAuthHono.session(
      '@hono-test/CurrentSession',
      fixture.Auth,
      options
    )
    const app = new Hono()
    const HonoApp = HonoEffect.app(
      '@hono-test/CurrentSessionApp',
      {
        requestLayer: CurrentSession.requestLayer,
        onFailure: () => new Response('failure', { status: 500 })
      },
      async function* (http) {
        app.use('*', yield* http.middleware())
        app.get(
          '/unused',
          yield* http.gen(async function* () {
            yield* Result.ok(undefined)
            return Result.ok('unused')
          })
        )
        app.get(
          '/session',
          yield* http.gen(async function* () {
            const current = yield* CurrentSession
            const readOptional = Effect.fn(async function* () {
              return Result.ok(yield* current.get())
            })
            const readRequired = Effect.fn(async function* () {
              return Result.ok(yield* current.require())
            })
            const [optionalResult, requiredResult] = await Promise.all([
              readOptional(),
              readRequired()
            ])

            if (Result.isError(optionalResult)) {
              return Result.err(optionalResult.error)
            }

            if (Result.isError(requiredResult)) {
              return Result.err(requiredResult.error)
            }

            return Result.ok({
              optional: optionalResult.value,
              required: requiredResult.value
            })
          })
        )
        return app
      }
    )
    const runtime = await Runtime.make(Layer.merge(fixture.Auth.layer, HonoApp.layer))
    const appResult = await runtime.run(
      Effect.fn(async function* () {
        return Result.ok(yield* HonoApp)
      })
    )
    if (Result.isError(appResult)) throw new Error(String(appResult.error))

    try {
      const unused = await app.request('https://example.test/unused')
      expect(unused.status).toBe(200)
      expect(fixture.calls).toHaveLength(0)

      const controller = new AbortController()
      const request = new Request('https://example.test/session', {
        headers: { 'x-user': 'alice' },
        signal: controller.signal
      })
      const response = await app.request(request)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        data: {
          optional: successSession('alice'),
          required: successSession('alice')
        }
      })
      expect(fixture.calls).toHaveLength(1)
      expect(fixture.calls[0]?.request).toBe(request)
      expect(fixture.calls[0]?.headers).toBe(request.headers)
      expect(fixture.calls[0]?.request?.signal).toBe(request.signal)
      expect(fixture.calls[0]?.query).toBe(options)

      const second = await app.request('/session', {
        headers: { 'x-user': 'bob' }
      })
      expect(second.status).toBe(200)
      expect(fixture.calls).toHaveLength(2)
    } finally {
      await runtime.dispose()
    }
  })

  test('declares CurrentSession from a lazy Auth token before its raw instance exists', async () => {
    const fixture = makeAuth(async (input) =>
      successSession(input.headers.get('x-user') ?? 'anonymous')
    )
    let factoryCalls = 0
    // oxlint-disable-next-line require-yield -- this factory intentionally has no external requirements.
    const Auth = BetterAuth.make('@hono-test/LazyAuth', async function* () {
      factoryCalls += 1
      return fixture.rawAuth
    })
    const CurrentSession = BetterAuthHono.session('@hono-test/LazyCurrentSession', Auth)
    const app = new Hono()
    const HonoApp = HonoEffect.app(
      '@hono-test/LazySessionApp',
      {
        requestLayer: CurrentSession.requestLayer,
        onFailure: () => new Response('failure', { status: 500 })
      },
      async function* (http) {
        app.use('*', yield* http.middleware())
        app.get(
          '/lazy-session',
          yield* http.gen(async function* () {
            return Result.ok(yield* CurrentSession.get())
          })
        )
        return app
      }
    )
    const runtime = await Runtime.make(Layer.merge(Auth.layer, HonoApp.layer))
    const appResult = await runtime.run(
      Effect.fn(async function* () {
        return Result.ok(yield* HonoApp)
      })
    )
    if (Result.isError(appResult)) throw new Error(String(appResult.error))

    try {
      expect(factoryCalls).toBe(0)
      const response = await app.request('/lazy-session', {
        headers: { 'x-user': 'lazy' }
      })

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ data: successSession('lazy') })
      expect(factoryCalls).toBe(1)
      expect(fixture.calls).toHaveLength(1)
    } finally {
      await runtime.dispose()
    }
  })

  test('memoizes a missing session before require and later get calls', async () => {
    const fixture = makeAuth(async () => null)
    const CurrentSession = BetterAuthHono.session('@hono-test/NullSnapshot', fixture.Auth)
    let optional: Session | null | undefined
    let repeated: Session | null | undefined
    let requiredError: unknown
    const app = new Hono()
    const HonoApp = HonoEffect.app(
      '@hono-test/NullSnapshotApp',
      {
        requestLayer: CurrentSession.requestLayer,
        onFailure: () => new Response('failure', { status: 500 })
      },
      async function* (http) {
        app.use('*', yield* http.middleware())
        app.get(
          '/session',
          yield* http.gen(async function* () {
            const current = yield* CurrentSession
            const optionalResult = await execute(current.get())
            if (Result.isError(optionalResult)) {
              throw new Error('Optional session lookup unexpectedly failed')
            }
            optional = optionalResult.value

            const requiredResult = await execute(current.require())
            if (Result.isOk(requiredResult)) {
              throw new Error('Required session unexpectedly succeeded')
            }
            requiredError = requiredResult.error

            const repeatedResult = await execute(current.get())
            if (Result.isError(repeatedResult)) {
              throw new Error('Repeated optional session lookup unexpectedly failed')
            }
            repeated = repeatedResult.value

            return Result.ok('observed')
          })
        )
        return app
      }
    )
    const runtime = await Runtime.make(Layer.merge(fixture.Auth.layer, HonoApp.layer))
    const appResult = await runtime.run(
      Effect.fn(async function* () {
        return Result.ok(yield* HonoApp)
      })
    )
    if (Result.isError(appResult)) throw new Error(String(appResult.error))

    try {
      const response = await app.request('/session')
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ data: 'observed' })
      expect(optional).toBe(null)
      expect(repeated).toBe(null)
      expect(requiredError).toBeInstanceOf(Unauthenticated)
      expect(fixture.calls).toHaveLength(1)
    } finally {
      await runtime.dispose()
    }
  })

  test('memoizes a Better Auth API error for repeated session calls', async () => {
    const apiCause = new APIError('SERVICE_UNAVAILABLE', {
      code: 'SESSION_FAILURE',
      message: 'Session API failed'
    })
    const fixture = makeAuth(async () => {
      throw apiCause
    })
    const CurrentSession = BetterAuthHono.session('@hono-test/ApiSnapshot', fixture.Auth)
    const errors: unknown[] = []
    const app = new Hono()
    const HonoApp = HonoEffect.app(
      '@hono-test/ApiSnapshotApp',
      {
        requestLayer: CurrentSession.requestLayer,
        onFailure: () => new Response('failure', { status: 500 })
      },
      async function* (http) {
        app.use('*', yield* http.middleware())
        app.get(
          '/session',
          yield* http.gen(async function* () {
            const current = yield* CurrentSession
            const first = await execute(current.get())
            const second = await execute(current.require())
            const repeated = await execute(current.get())

            for (const result of [first, second, repeated]) {
              if (Result.isOk(result)) {
                throw new Error('Failed session lookup unexpectedly succeeded')
              }
              errors.push(result.error)
            }

            return Result.ok('observed')
          })
        )
        return app
      }
    )
    const runtime = await Runtime.make(Layer.merge(fixture.Auth.layer, HonoApp.layer))
    const appResult = await runtime.run(
      Effect.fn(async function* () {
        return Result.ok(yield* HonoApp)
      })
    )
    if (Result.isError(appResult)) throw new Error(String(appResult.error))

    try {
      const response = await app.request('/session')
      expect(response.status).toBe(200)
      expect(errors).toHaveLength(3)
      expect(errors[0]).toBeInstanceOf(BetterAuthApiError)
      expect(errors[0]).toBe(errors[1])
      expect(errors[1]).toBe(errors[2])
      if (errors[0] instanceof BetterAuthApiError) {
        expect(errors[0].cause).toBe(apiCause)
      }
      expect(fixture.calls).toHaveLength(1)
    } finally {
      await runtime.dispose()
    }
  })

  test('memoizes an UnhandledException for repeated session calls', async () => {
    const defect = new Error('session storage failed')
    const fixture = makeAuth(async () => {
      throw defect
    })
    const CurrentSession = BetterAuthHono.session('@hono-test/DefectSnapshot', fixture.Auth)
    const errors: unknown[] = []
    const app = new Hono()
    const HonoApp = HonoEffect.app(
      '@hono-test/DefectSnapshotApp',
      {
        requestLayer: CurrentSession.requestLayer,
        onFailure: () => new Response('failure', { status: 500 })
      },
      async function* (http) {
        app.use('*', yield* http.middleware())
        app.get(
          '/session',
          yield* http.gen(async function* () {
            const current = yield* CurrentSession
            const first = await execute(current.get())
            const repeated = await execute(current.require())
            const repeatedAgain = await execute(current.get())

            for (const result of [first, repeated, repeatedAgain]) {
              if (Result.isOk(result)) {
                throw new Error('Defect session lookup unexpectedly succeeded')
              }
              errors.push(result.error)
            }

            return Result.ok('observed')
          })
        )
        return app
      }
    )
    const runtime = await Runtime.make(Layer.merge(fixture.Auth.layer, HonoApp.layer))
    const appResult = await runtime.run(
      Effect.fn(async function* () {
        return Result.ok(yield* HonoApp)
      })
    )
    if (Result.isError(appResult)) throw new Error(String(appResult.error))

    try {
      const response = await app.request('/session')
      expect(response.status).toBe(200)
      expect(errors).toHaveLength(3)
      expect(errors[0]).toBeInstanceOf(UnhandledException)
      expect(errors[0]).toBe(errors[1])
      expect(errors[1]).toBe(errors[2])
      if (errors[0] instanceof UnhandledException) {
        expect(errors[0]).not.toBe(defect)
        expect(errors[0].cause).toBe(defect)
      }
      expect(fixture.calls).toHaveLength(1)
    } finally {
      await runtime.dispose()
    }
  })

  test('closes a retained current-session value with the request boundary', async () => {
    const fixture = makeAuth(async () => successSession('closed'))
    const CurrentSession = BetterAuthHono.session('@hono-test/ClosedSnapshot', fixture.Auth)
    const released: unknown[] = []
    let retained: BetterAuthHonoSessionValue<typeof fixture.rawAuth> | undefined
    const app = new Hono()
    const HonoApp = HonoEffect.app(
      '@hono-test/ClosedSnapshotApp',
      {
        requestLayer: CurrentSession.requestLayer,
        onFailure: () => new Response('failure', { status: 500 })
      },
      async function* (http) {
        app.use('*', yield* http.middleware())
        app.get(
          '/session',
          yield* http.gen(async function* () {
            const current = yield* CurrentSession
            retained = current
            return Result.ok(yield* current.get())
          })
        )
        return app
      }
    )
    const runtime = await Runtime.make(Layer.merge(fixture.Auth.layer, HonoApp.layer), {
      observers: [
        {
          onResourceRelease: ({ service }) => {
            if (service === CurrentSession) {
              released.push(service)
            }
          }
        }
      ]
    })
    const appResult = await runtime.run(
      Effect.fn(async function* () {
        return Result.ok(yield* HonoApp)
      })
    )
    if (Result.isError(appResult)) throw new Error(String(appResult.error))

    try {
      const response = await app.request('/session')
      expect(response.status).toBe(200)
      expect(released).toHaveLength(1)
      expect(fixture.calls).toHaveLength(1)

      const retainedValue = retained
      expect(retainedValue).toBeDefined()
      if (retainedValue === undefined) {
        return
      }

      expect(retainedValue).not.toHaveProperty('close')
      expect(retainedValue).not.toHaveProperty('clear')

      const afterDispose = await execute(retainedValue.get())
      const afterDisposeAgain = await execute(retainedValue.get())
      expect(Result.isError(afterDispose)).toBe(true)
      expect(Result.isError(afterDisposeAgain)).toBe(true)
      if (Result.isError(afterDispose) && Result.isError(afterDisposeAgain)) {
        expect(afterDispose.error).toBeInstanceOf(UnhandledException)
        expect(afterDisposeAgain.error).toBeInstanceOf(UnhandledException)
      }
      expect(fixture.calls).toHaveLength(1)
      expect(released).toHaveLength(1)
    } finally {
      await runtime.dispose()
    }
  })

  test('closes each current-session acquisition when one request Layer is shared concurrently', async () => {
    const fixture = makeAuth(async () => successSession('shared'))
    const CurrentSession = BetterAuthHono.session('@hono-test/SharedLayer', fixture.Auth)
    const retained: BetterAuthHonoSessionValue<typeof fixture.rawAuth>[] = []
    let sharedLayer: ReturnType<typeof CurrentSession.requestLayer> | undefined
    let acquiredCount = 0
    let releasePrograms!: () => void
    const programsReleased = new Promise<void>((resolve) => {
      releasePrograms = resolve
    })
    let resolveBothAcquired!: () => void
    const bothAcquired = new Promise<void>((resolve) => {
      resolveBothAcquired = resolve
    })
    const app = new Hono()
    const HonoApp = HonoEffect.app(
      '@hono-test/SharedLayerApp',
      {
        requestLayer: (context) => {
          sharedLayer ??= CurrentSession.requestLayer(context)
          return sharedLayer
        },
        onFailure: () => new Response('failure', { status: 500 })
      },
      async function* (http) {
        app.use('*', yield* http.middleware())
        app.get(
          '/session',
          yield* http.gen(async function* () {
            retained.push(yield* CurrentSession)
            acquiredCount += 1

            if (acquiredCount === 2) {
              resolveBothAcquired()
            }

            await programsReleased
            return Result.ok('held')
          })
        )
        return app
      }
    )
    const runtime = await Runtime.make(Layer.merge(fixture.Auth.layer, HonoApp.layer))
    const appResult = await runtime.run(
      Effect.fn(async function* () {
        return Result.ok(yield* HonoApp)
      })
    )
    if (Result.isError(appResult)) throw new Error(String(appResult.error))

    try {
      const requests = Promise.all([app.request('/session'), app.request('/session')])
      await bothAcquired
      releasePrograms()

      const responses = await requests
      expect(responses.every((response) => response.status === 200)).toBe(true)
      expect(retained).toHaveLength(2)
      expect(fixture.calls).toHaveLength(0)

      const afterDispose = await Promise.all(retained.map((current) => execute(current.get())))
      for (const result of afterDispose) {
        expect(Result.isError(result)).toBe(true)
        if (Result.isError(result)) {
          expect(result.error).toBeInstanceOf(UnhandledException)
        }
      }
      expect(fixture.calls).toHaveLength(0)
    } finally {
      releasePrograms()
      await runtime.dispose()
    }
  })

  test('keeps snapshots stale after mutation and supports an explicit fresh read', async () => {
    let currentSession: Session | null = successSession('before')
    const fixture = makeAuth(async () => currentSession)
    const CurrentSession = BetterAuthHono.session('@hono-test/StaleSnapshot', fixture.Auth)
    const app = new Hono()
    const HonoApp = HonoEffect.app(
      '@hono-test/StaleSnapshotApp',
      {
        requestLayer: CurrentSession.requestLayer,
        onFailure: () => new Response('failure', { status: 500 })
      },
      async function* (http) {
        app.use('*', yield* http.middleware())
        app.get(
          '/session',
          yield* http.gen(async function* (context) {
            const snapshot = yield* CurrentSession.get()
            currentSession = null
            const auth = yield* fixture.Auth
            const fresh = yield* auth.session.get(context.req.raw)
            const cached = yield* CurrentSession.get()

            return Result.ok({
              cached: cached?.user.id ?? null,
              fresh: fresh?.user.id ?? null,
              snapshot: snapshot?.user.id ?? null
            })
          })
        )
        return app
      }
    )
    const runtime = await Runtime.make(Layer.merge(fixture.Auth.layer, HonoApp.layer))
    const appResult = await runtime.run(
      Effect.fn(async function* () {
        return Result.ok(yield* HonoApp)
      })
    )
    if (Result.isError(appResult)) throw new Error(String(appResult.error))

    try {
      const response = await app.request('/session')
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        data: {
          cached: 'before',
          fresh: null,
          snapshot: 'before'
        }
      })
      expect(fixture.calls).toHaveLength(2)
    } finally {
      await runtime.dispose()
    }
  })

  test('isolates concurrent requests and never retries a failed snapshot', async () => {
    let calls = 0
    const failure = new Error('database unavailable')
    const fixture = makeAuth(async (input) => {
      calls += 1
      await wait(input.headers.get('x-user') === 'slow' ? 10 : 1)
      if (input.headers.get('x-user') === 'broken') {
        throw failure
      }
      return successSession(input.headers.get('x-user') ?? 'anonymous')
    })
    const CurrentSession = BetterAuthHono.session('@hono-test/Concurrent', fixture.Auth)
    const app = new Hono()
    const HonoApp = HonoEffect.app(
      '@hono-test/ConcurrentApp',
      {
        requestLayer: CurrentSession.requestLayer,
        onFailure: (error) => {
          if (error instanceof UnhandledException) {
            return new Response('defect', { status: 503 })
          }
          return new Response('failure', { status: 500 })
        }
      },
      async function* (http) {
        app.use('*', yield* http.middleware())
        app.get(
          '/session',
          yield* http.gen(async function* () {
            return Result.ok(yield* CurrentSession.get())
          })
        )
        return app
      }
    )
    const runtime = await Runtime.make(Layer.merge(fixture.Auth.layer, HonoApp.layer))
    const appResult = await runtime.run(
      Effect.fn(async function* () {
        return Result.ok(yield* HonoApp)
      })
    )
    if (Result.isError(appResult)) throw new Error(String(appResult.error))

    try {
      const [slow, fast] = await Promise.all([
        app.request('/session', { headers: { 'x-user': 'slow' } }),
        app.request('/session', { headers: { 'x-user': 'fast' } })
      ])
      expect(await slow.json()).toEqual({ data: successSession('slow') })
      expect(await fast.json()).toEqual({ data: successSession('fast') })
      expect(calls).toBe(2)

      const failedRequest = new Request('https://example.test/session', {
        headers: { 'x-user': 'broken' }
      })
      const failed = await app.request(failedRequest)
      expect(failed.status).toBe(503)
      const failedAgain = await app.request('/session', { headers: { 'x-user': 'broken' } })
      expect(failedAgain.status).toBe(503)
      expect(calls).toBe(4)
      expect(fixture.calls.at(-1)?.headers.get('x-user')).toBe('broken')
    } finally {
      await runtime.dispose()
    }
  })

  test('maps only null to Unauthenticated and preserves API errors and defects', async () => {
    let mode: 'null' | 'api' | 'defect' = 'null'
    const apiCause = new APIError('UNAUTHORIZED', {
      code: 'SESSION_FAILURE',
      message: 'Session API failed'
    })
    const defect = new Error('session database failed')
    const fixture = makeAuth(async () => {
      if (mode === 'api') throw apiCause
      if (mode === 'defect') throw defect
      return null
    })
    const CurrentSession = BetterAuthHono.session('@hono-test/Failures', fixture.Auth)
    const observed: unknown[] = []
    const app = new Hono()
    const HonoApp = HonoEffect.app(
      '@hono-test/FailuresApp',
      {
        requestLayer: CurrentSession.requestLayer,
        onFailure: (error) => {
          observed.push(error)
          if (error instanceof Unauthenticated) return new Response('login', { status: 401 })
          if (error instanceof BetterAuthApiError) return new Response('api', { status: 502 })
          return new Response('defect', { status: 503 })
        }
      },
      async function* (http) {
        app.use('*', yield* http.middleware())
        app.get(
          '/optional',
          yield* http.gen(async function* () {
            return Result.ok(yield* CurrentSession.get())
          })
        )
        app.get(
          '/required',
          yield* http.gen(async function* () {
            return Result.ok(yield* CurrentSession.require())
          })
        )
        return app
      }
    )
    const runtime = await Runtime.make(Layer.merge(fixture.Auth.layer, HonoApp.layer))
    const appResult = await runtime.run(
      Effect.fn(async function* () {
        return Result.ok(yield* HonoApp)
      })
    )
    if (Result.isError(appResult)) throw new Error(String(appResult.error))

    try {
      const optional = await app.request('/optional')
      expect(optional.status).toBe(200)
      expect(await optional.json()).toEqual({ data: null })
      const required = await app.request('/required')
      expect(required.status).toBe(401)
      expect(observed.at(-1)).toBeInstanceOf(Unauthenticated)

      mode = 'api'
      const api = await app.request('/optional')
      expect(api.status).toBe(502)
      expect(observed.at(-1)).toBeInstanceOf(BetterAuthApiError)
      const requiredApi = await app.request('/required')
      expect(requiredApi.status).toBe(502)
      expect(observed.at(-1)).toBeInstanceOf(BetterAuthApiError)

      mode = 'defect'
      const defectResponse = await app.request('/required')
      expect(defectResponse.status).toBe(503)
      const observedDefect = observed.at(-1)
      expect(observedDefect).toBeInstanceOf(UnhandledException)
      if (observedDefect instanceof UnhandledException) {
        expect(observedDefect).not.toBe(defect)
        expect(observedDefect.cause).toBe(defect)
      }
    } finally {
      await runtime.dispose()
    }
  })

  test('shares one read between guard and handler while leaving response policy to HonoEffect', async () => {
    let authenticated = true
    const fixture = makeAuth(async () => (authenticated ? successSession('guarded') : null))
    const CurrentSession = BetterAuthHono.session('@hono-test/Guard', fixture.Auth)
    const policyCalls: unknown[] = []
    const app = new Hono()
    const HonoApp = HonoEffect.app(
      '@hono-test/GuardApp',
      {
        requestLayer: CurrentSession.requestLayer,
        onFailure: (error) => {
          policyCalls.push(error)
          return new Response('not authenticated', { status: 418 })
        }
      },
      async function* (http) {
        app.use('*', yield* http.middleware())
        app.use('/private/*', yield* http.guard(CurrentSession.guard))
        app.get(
          '/private/profile',
          yield* http.gen(async function* () {
            const session = yield* CurrentSession.require()
            return Result.ok(session.user.id)
          })
        )
        return app
      }
    )
    const runtime = await Runtime.make(Layer.merge(fixture.Auth.layer, HonoApp.layer))
    const appResult = await runtime.run(
      Effect.fn(async function* () {
        return Result.ok(yield* HonoApp)
      })
    )
    if (Result.isError(appResult)) throw new Error(String(appResult.error))

    try {
      const response = await app.request('/private/profile')
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ data: 'guarded' })
      expect(fixture.calls).toHaveLength(1)
      expect(policyCalls).toHaveLength(0)

      authenticated = false
      const rejected = await app.request('/private/profile')
      expect(rejected.status).toBe(418)
      expect(await rejected.text()).toBe('not authenticated')
      expect(fixture.calls).toHaveLength(2)
      expect(policyCalls.at(-1)).toBeInstanceOf(Unauthenticated)
    } finally {
      await runtime.dispose()
    }
  })

  test('releases composed request Layers after each request and preserves raw handler Responses', async () => {
    class RequestResource extends Service<RequestResource>()('@hono-test/RequestResource') {
      declare readonly path: string
    }
    const fixture = makeAuth(async () => successSession('resource'))
    const CurrentSession = BetterAuthHono.session('@hono-test/ResourceSession', fixture.Auth)
    const released: string[] = []
    const resourceLayer = (context: { readonly req: { readonly path: string } }) =>
      Layer.scoped(
        RequestResource,
        () => ({ path: context.req.path }),
        (resource) => {
          released.push(resource.path)
        }
      )
    const rawResponse = new Response('streamed', {
      headers: [
        ['location', '/target'],
        ['set-cookie', 'a=1'],
        ['set-cookie', 'b=2']
      ],
      status: 302
    })
    const rawAuth = {
      ...fixture.rawAuth,
      handler: async (_request: Request) => rawResponse
    }
    const app = new Hono()
    app.all('/api/auth/*', (context) => rawAuth.handler(context.req.raw))
    const HonoApp = HonoEffect.app(
      '@hono-test/ResourceApp',
      {
        requestLayer: (context) =>
          Layer.merge(CurrentSession.requestLayer(context), resourceLayer(context))
      },
      async function* (http) {
        app.use('*', yield* http.middleware())
        app.get(
          '/resource',
          yield* http.gen(async function* () {
            const resource = yield* RequestResource
            const session = yield* CurrentSession.get()
            return Result.ok({ path: resource.path, session: session?.user.id })
          })
        )
        return app
      }
    )
    const runtime = await Runtime.make(Layer.merge(fixture.Auth.layer, HonoApp.layer))
    const appResult = await runtime.run(
      Effect.fn(async function* () {
        return Result.ok(yield* HonoApp)
      })
    )
    if (Result.isError(appResult)) throw new Error(String(appResult.error))

    try {
      const raw = await app.request('/api/auth/redirect')
      expect(raw).toBe(rawResponse)
      expect(raw.status).toBe(302)
      expect(raw.headers.get('location')).toBe('/target')
      expect(raw.headers.getSetCookie()).toEqual(['a=1', 'b=2'])

      const response = await app.request('/resource')
      expect(response.status).toBe(200)
      expect(released).toEqual(['/resource'])
    } finally {
      await runtime.dispose()
    }
  })

  test('keeps separate Auth instances and session tags independent', async () => {
    const first = makeAuth(async (input) => successSession(`first-${input.headers.get('x-id')}`))
    const second = makeAuth(async (input) => successSession(`second-${input.headers.get('x-id')}`))
    const FirstAuth = BetterAuth.service('@hono-test/FirstAuth', first.rawAuth)
    const SecondAuth = BetterAuth.service('@hono-test/SecondAuth', second.rawAuth)
    const FirstSession = BetterAuthHono.session('@hono-test/FirstSession', FirstAuth)
    const SecondSession = BetterAuthHono.session('@hono-test/SecondSession', SecondAuth)
    const app = new Hono()
    const HonoApp = HonoEffect.app(
      '@hono-test/BothAuthApp',
      {
        requestLayer: (context) =>
          Layer.merge(FirstSession.requestLayer(context), SecondSession.requestLayer(context))
      },
      async function* (http) {
        app.use('*', yield* http.middleware())
        app.get(
          '/both',
          yield* http.gen(async function* () {
            const firstSession = yield* FirstSession.require()
            const secondSession = yield* SecondSession.require()
            return Result.ok({ first: firstSession.user.id, second: secondSession.user.id })
          })
        )
        return app
      }
    )
    const runtime = await Runtime.make(
      Layer.merge(FirstAuth.layer, SecondAuth.layer, HonoApp.layer)
    )
    const appResult = await runtime.run(
      Effect.fn(async function* () {
        return Result.ok(yield* HonoApp)
      })
    )
    if (Result.isError(appResult)) throw new Error(String(appResult.error))

    try {
      const response = await app.request('/both', { headers: { 'x-id': 'request' } })
      expect(await response.json()).toEqual({
        data: { first: 'first-request', second: 'second-request' }
      })
      expect(first.calls).toHaveLength(1)
      expect(second.calls).toHaveLength(1)
    } finally {
      await runtime.dispose()
    }
  })
})
