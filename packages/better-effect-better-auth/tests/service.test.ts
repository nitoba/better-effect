import { describe, expect, test } from 'bun:test'
import { APIError } from 'better-auth/api'
import { Effect, Layer, Runtime, Service } from 'better-effect'
import { Result, UnhandledException } from 'better-result'

import { BetterAuth, BetterAuthApiError, Unauthenticated, type BetterAuthOperation } from '../src'

type FakeSession = {
  readonly session: {
    readonly id: string
  }
  readonly user: {
    readonly id: string
    readonly role: 'user'
  }
}

type FakeSessionInput = {
  readonly headers: Headers
  readonly request?: Request
  readonly query?: {
    readonly disableCookieCache?: boolean
    readonly disableRefresh?: boolean
  }
  readonly asResponse?: boolean
  readonly returnHeaders?: boolean
  readonly returnStatus?: boolean
}

type FakeSessionOutput =
  | FakeSession
  | null
  | Response
  | {
      readonly headers: Headers
      readonly response: FakeSession | null
    }

const authenticatedSession: FakeSession = {
  session: {
    id: 'session-1'
  },
  user: {
    id: 'user-1',
    role: 'user'
  }
}

const execute = <A, E>(operation: BetterAuthOperation<A, E>) =>
  Result.gen(async function* () {
    const value = yield* operation
    return Result.ok(value)
  })

class FakeAuth {
  readonly $ERROR_CODES = {
    INVALID_SESSION: {
      code: 'INVALID_SESSION',
      message: 'Invalid session'
    }
  } as const

  declare readonly $Infer: {
    readonly Session: FakeSession
  }

  readonly sessionInputs: FakeSessionInput[] = []
  readonly handlerRequests: Request[] = []
  readonly handlerDefect = new Error('handler defect')
  lastResponse: Response | undefined

  readonly api = {
    getSession: async (input: FakeSessionInput): Promise<FakeSessionOutput> => {
      this.sessionInputs.push({
        ...input
      })

      const authorization = input.headers.get('authorization')

      if (authorization === 'Bearer api-error') {
        throw new APIError('UNAUTHORIZED', {
          code: 'INVALID_SESSION',
          message: 'Invalid session'
        })
      }

      if (authorization === 'Bearer defect') {
        throw new Error('session storage unavailable')
      }

      const session = authorization === 'Bearer valid' ? authenticatedSession : null

      if (input.asResponse === true) {
        return Response.json(session)
      }

      if (input.returnHeaders === true) {
        const headers = new Headers()
        headers.append('set-cookie', 'session=refreshed; Path=/')
        return {
          headers,
          response: session
        }
      }

      return session
    },
    ping: async (input?: {
      readonly value?: string
      readonly asResponse?: boolean
      readonly returnHeaders?: boolean
      readonly returnStatus?: boolean
    }) => ({
      value: input?.value ?? 'pong'
    })
  }

  async handler(request: Request): Promise<Response> {
    this.handlerRequests.push(request)
    const pathname = new URL(request.url).pathname

    if (pathname.endsWith('/api-error')) {
      throw new APIError('UNAUTHORIZED', {
        code: 'INVALID_SESSION',
        message: 'Invalid session'
      })
    }

    if (pathname.endsWith('/defect')) {
      throw this.handlerDefect
    }

    const headers = new Headers()
    headers.append('set-cookie', 'first=1; Path=/')
    headers.append('set-cookie', 'second=2; Path=/')

    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('streamed'))
        controller.close()
      }
    })

    const response = new Response(body, {
      status: 401,
      statusText: 'Unauthorized',
      headers
    })
    this.lastResponse = response
    return response
  }
}

describe('BetterAuth.service', () => {
  test('returns a yieldable Service token with an immutable Layer and exact raw reference', async () => {
    const raw = new FakeAuth()
    const Auth = BetterAuth.service('@test/Auth', raw)
    const descriptor = Object.getOwnPropertyDescriptor(Auth, 'layer')
    const runtime = await Runtime.make(Auth.layer)

    const result = await runtime.run(
      Effect.fn(async function* () {
        const auth = yield* Auth
        return Result.ok(auth)
      })
    )

    expect(Auth.serviceTag).toBe('@test/Auth')
    expect(descriptor).toMatchObject({
      enumerable: true,
      configurable: false,
      writable: false
    })
    expect(Reflect.set(Auth, 'layer', Layer.empty)).toBe(false)
    expect(Result.isOk(result)).toBe(true)

    if (Result.isOk(result)) {
      expect(result.value.raw).toBe(raw)
      expect(result.value.api).not.toBe(raw.api)
      expect(Object.isFrozen(result.value)).toBe(true)
      expect(Object.isFrozen(result.value.session)).toBe(true)
    }

    await runtime.dispose()
  })

  test('constructs a complete Service implementation usable through core Layers', async () => {
    const raw = new FakeAuth()
    const Auth = BetterAuth.service('@test/ConstructedAuth', raw)
    const constructed = new Auth()
    const direct = await execute(constructed.api.ping({ value: 'constructed' }))

    expect(constructed.raw).toBe(raw)
    expect(Object.isFrozen(constructed)).toBe(true)
    expect(direct).toEqual(Result.ok({ value: 'constructed' }))

    const runtime = await Runtime.make(Layer.succeed(Auth, constructed))

    try {
      const result = await runtime.run(
        Effect.fn(async function* () {
          const auth = yield* Auth
          const session = yield* auth.session.get(new Headers())
          const response = yield* auth.handle(new Request('https://example.test/constructed'))

          return Result.ok({ auth, session, response })
        })
      )

      expect(Result.isOk(result)).toBe(true)

      if (Result.isOk(result)) {
        expect(result.value.auth).toBe(constructed)
        expect(result.value.session).toBe(null)
        expect(raw.lastResponse).toBeDefined()

        if (raw.lastResponse !== undefined) {
          expect(result.value.response).toBe(raw.lastResponse)
        }
      }
    } finally {
      await runtime.dispose()
    }
  })

  test('keeps multiple Better Auth instances and Proxy caches isolated', async () => {
    const firstRaw = new FakeAuth()
    const secondRaw = new FakeAuth()
    const FirstAuth = BetterAuth.service('@test/FirstAuth', firstRaw)
    const SecondAuth = BetterAuth.service('@test/SecondAuth', secondRaw)
    const runtime = await Runtime.make(Layer.merge(FirstAuth.layer, SecondAuth.layer))

    const result = await runtime.run(
      Effect.fn(async function* () {
        const first = yield* FirstAuth
        const second = yield* SecondAuth
        return Result.ok({ first, second })
      })
    )

    expect(Result.isOk(result)).toBe(true)

    if (Result.isOk(result)) {
      expect(result.value.first.raw).toBe(firstRaw)
      expect(result.value.second.raw).toBe(secondRaw)
      expect(result.value.first.api).not.toBe(result.value.second.api)
      expect(result.value.first.api.ping).not.toBe(result.value.second.api.ping)
    }

    await runtime.dispose()
  })

  test('supports structural overrides through Auth.of and Layer.succeed', async () => {
    const raw = new FakeAuth()
    const Auth = BetterAuth.service('@test/OverrideAuth', raw)
    const liveRuntime = await Runtime.make(Auth.layer)
    const live = await liveRuntime.run(
      Effect.fn(async function* () {
        return Result.ok(yield* Auth)
      })
    )

    expect(Result.isOk(live)).toBe(true)

    if (Result.isError(live)) {
      await liveRuntime.dispose()
      throw new Error('Live Auth Service did not resolve')
    }

    const replacementRaw = new FakeAuth()
    const replacement = Auth.of({
      api: live.value.api,
      session: live.value.session,
      handle: live.value.handle,
      raw: replacementRaw
    })
    const overrideRuntime = await Runtime.make(Layer.succeed(Auth, replacement))
    const overridden = await overrideRuntime.run(
      Effect.fn(async function* () {
        return Result.ok(yield* Auth)
      })
    )

    expect(Result.isOk(overridden)).toBe(true)

    if (Result.isOk(overridden)) {
      expect(overridden.value).toBe(replacement)
      expect(overridden.value.raw).toBe(replacementRaw)
    }

    await overrideRuntime.dispose()
    await liveRuntime.dispose()
  })
})

describe('BetterAuth.make', () => {
  test('forwards contextual Services through a synchronous generator factory', async () => {
    class AuthConfig extends Service<AuthConfig>()('@test/SyncAuthConfig') {
      readonly auth = new FakeAuth()
    }

    class AuthLabel extends Service<AuthLabel>()('@test/SyncAuthLabel') {
      readonly value = 'sync'
    }

    let factoryCalls = 0
    const Auth = BetterAuth.make('@test/SyncFactoryAuth', function* () {
      const config = yield* AuthConfig
      const label = yield* AuthLabel
      factoryCalls += 1
      if (label.value !== 'sync') {
        throw new Error('Unexpected contextual label')
      }
      return config.auth
    })
    const config = new AuthConfig()
    const label = new AuthLabel()
    const runtime = await Runtime.make(
      Layer.merge(Layer.succeed(AuthConfig, config), Layer.succeed(AuthLabel, label), Auth.layer)
    )

    try {
      expect(factoryCalls).toBe(0)

      const result = await runtime.run(
        Effect.fn(async function* () {
          const auth = yield* Auth
          return Result.ok(auth)
        })
      )

      expect(factoryCalls).toBe(1)
      expect(Result.isOk(result)).toBe(true)

      if (Result.isOk(result)) {
        expect(result.value.raw).toBe(config.auth)
      }
    } finally {
      await runtime.dispose()
    }
  })
})

describe('BetterAuth.make and BetterAuth.from', () => {
  test('keeps generator factories lazy and acquires one raw instance per Runtime', async () => {
    class AuthConfig extends Service<AuthConfig>()('@test/AuthConfig') {
      readonly baseURL = 'https://auth.example.test'
    }

    let factoryCalls = 0
    let configuredURL: string | undefined
    const Auth = BetterAuth.make('@test/LazyAuth', async function* () {
      const config = yield* AuthConfig
      factoryCalls += 1
      configuredURL = config.baseURL
      return new FakeAuth()
    })
    const layer = Layer.merge(Layer.make(AuthConfig), Auth.layer)

    expect(factoryCalls).toBe(0)
    expect(() => Reflect.construct(Auth, [])).toThrow('factory-backed Better Auth Service')

    const firstRuntime = await Runtime.make(layer)
    const first = await Promise.all([
      firstRuntime.run(
        Effect.fn(async function* () {
          return Result.ok(yield* Auth)
        })
      ),
      firstRuntime.run(
        Effect.fn(async function* () {
          return Result.ok(yield* Auth)
        })
      )
    ])

    expect(factoryCalls).toBe(1)
    expect(configuredURL).toBe('https://auth.example.test')
    expect(Result.isOk(first[0])).toBe(true)
    expect(Result.isOk(first[1])).toBe(true)

    const secondRuntime = await Runtime.make(layer)
    const second = await secondRuntime.run(
      Effect.fn(async function* () {
        return Result.ok(yield* Auth)
      })
    )

    expect(factoryCalls).toBe(2)
    expect(Result.isOk(second)).toBe(true)

    if (Result.isOk(first[0]) && Result.isOk(first[1]) && Result.isOk(second)) {
      expect(first[0].value.raw).toBe(first[1].value.raw)
      expect(first[0].value.raw).not.toBe(second.value.raw)
    }

    await firstRuntime.dispose()
    await secondRuntime.dispose()
  })

  test('adapts caller-owned instances through from without changing ownership', async () => {
    const raw = new FakeAuth()
    const Auth = BetterAuth.from('@test/FromAuth', raw)
    const runtime = await Runtime.make(Auth.layer)

    const result = await runtime.run(
      Effect.fn(async function* () {
        return Result.ok(yield* Auth)
      })
    )

    expect(Result.isOk(result)).toBe(true)

    if (Result.isOk(result)) {
      expect(result.value.raw).toBe(raw)
    }

    await runtime.dispose()
  })

  test('allows Layer.override test doubles for factory-backed tokens', async () => {
    const raw = new FakeAuth()
    // oxlint-disable-next-line require-yield -- this factory intentionally has no external requirements.
    const Auth = BetterAuth.make('@test/OverrideFactoryAuth', async function* () {
      return raw
    })
    const liveRuntime = await Runtime.make(Auth.layer)
    const live = await liveRuntime.run(
      Effect.fn(async function* () {
        return Result.ok(yield* Auth)
      })
    )

    expect(Result.isOk(live)).toBe(true)

    if (Result.isError(live)) {
      await liveRuntime.dispose()
      throw new Error('Factory-backed Auth Service did not resolve')
    }

    const replacementRaw = new FakeAuth()
    const replacement = Auth.of({
      api: live.value.api,
      session: live.value.session,
      handle: live.value.handle,
      raw: replacementRaw
    })
    const overrideRuntime = await Runtime.make(
      Layer.override(Auth.layer, Layer.succeed(Auth, replacement))
    )
    const overridden = await overrideRuntime.run(
      Effect.fn(async function* () {
        return Result.ok(yield* Auth)
      })
    )

    expect(Result.isOk(overridden)).toBe(true)

    if (Result.isOk(overridden)) {
      expect(overridden.value).toBe(replacement)
      expect(overridden.value.raw).toBe(replacementRaw)
    }

    await overrideRuntime.dispose()
    await liveRuntime.dispose()
  })

  test('fails acquisition when a lazy factory throws', async () => {
    const defect = new Error('invalid Better Auth configuration')
    // oxlint-disable-next-line require-yield -- this factory terminates with the acquisition defect.
    const Auth = BetterAuth.make('@test/ThrowingAuth', async function* () {
      throw defect
    })
    const runtime = await Runtime.make(Auth.layer)

    let failure: unknown

    try {
      await runtime.run(
        Effect.fn(async function* () {
          return Result.ok(yield* Auth)
        })
      )
    } catch (cause) {
      failure = cause
    }

    expect(failure).toBeDefined()

    await runtime.dispose()
  })
})

describe('Better Auth session helpers', () => {
  test('forwards Request and Headers sources with exact session query options', async () => {
    const raw = new FakeAuth()
    const Auth = BetterAuth.service('@test/SessionAuth', raw)
    const runtime = await Runtime.make(Auth.layer)
    const serviceResult = await runtime.run(
      Effect.fn(async function* () {
        return Result.ok(yield* Auth)
      })
    )

    if (Result.isError(serviceResult)) {
      await runtime.dispose()
      throw new Error('Auth Service did not resolve')
    }

    const directHeaders = new Headers({
      authorization: 'Bearer valid',
      cookie: 'session=direct'
    })
    const request = new Request('https://example.test/protected', {
      headers: {
        authorization: 'Bearer valid',
        cookie: 'session=request'
      }
    })
    const options = {
      disableCookieCache: true,
      disableRefresh: true
    }

    const direct = await execute(serviceResult.value.session.get(directHeaders, options))
    const fromRequest = await execute(serviceResult.value.session.get(request))

    expect(Result.isOk(direct)).toBe(true)
    expect(Result.isOk(fromRequest)).toBe(true)
    expect(raw.sessionInputs[0]?.headers).toBe(directHeaders)
    expect(raw.sessionInputs[0]?.query).toBe(options)
    expect(raw.sessionInputs[0]).toMatchObject({
      asResponse: false,
      returnHeaders: false,
      returnStatus: false
    })
    expect(raw.sessionInputs[1]?.request).toBe(request)
    expect(raw.sessionInputs[1]?.headers).toBe(request.headers)
    expect(raw.sessionInputs[1]?.request?.signal).toBe(request.signal)
    expect(raw.sessionInputs[1]?.headers.get('cookie')).toBe('session=request')

    await runtime.dispose()
  })

  test('preserves null in get and produces Unauthenticated only from require', async () => {
    const raw = new FakeAuth()
    const Auth = BetterAuth.service('@test/RequiredSessionAuth', raw)
    const runtime = await Runtime.make(Auth.layer)
    const serviceResult = await runtime.run(
      Effect.fn(async function* () {
        return Result.ok(yield* Auth)
      })
    )

    if (Result.isError(serviceResult)) {
      await runtime.dispose()
      throw new Error('Auth Service did not resolve')
    }

    const missing = new Headers()
    const valid = new Headers({
      authorization: 'Bearer valid'
    })
    const optional = await execute(serviceResult.value.session.get(missing))
    const requiredMissing = await execute(serviceResult.value.session.require(missing))
    const requiredValid = await execute(serviceResult.value.session.require(valid))

    expect(optional).toEqual(Result.ok(null))
    expect(Result.isError(requiredMissing)).toBe(true)
    expect(requiredValid).toEqual(Result.ok(authenticatedSession))

    if (Result.isError(requiredMissing)) {
      expect(requiredMissing.error).toBeInstanceOf(Unauthenticated)
      expect(requiredMissing.error.message).toBe('Authentication is required')
    }

    await runtime.dispose()
  })

  test('does not mask Better Auth API errors or infrastructure defects as unauthenticated', async () => {
    const raw = new FakeAuth()
    const Auth = BetterAuth.service('@test/SessionFailureAuth', raw)
    const runtime = await Runtime.make(Auth.layer)
    const serviceResult = await runtime.run(
      Effect.fn(async function* () {
        return Result.ok(yield* Auth)
      })
    )

    if (Result.isError(serviceResult)) {
      await runtime.dispose()
      throw new Error('Auth Service did not resolve')
    }

    const apiError = await execute(
      serviceResult.value.session.require(
        new Headers({
          authorization: 'Bearer api-error'
        })
      )
    )
    const defect = await execute(
      serviceResult.value.session.require(
        new Headers({
          authorization: 'Bearer defect'
        })
      )
    )

    expect(Result.isError(apiError)).toBe(true)
    expect(Result.isError(defect)).toBe(true)

    if (Result.isError(apiError)) {
      expect(apiError.error).toBeInstanceOf(BetterAuthApiError)
      expect(apiError.error).not.toBeInstanceOf(Unauthenticated)
    }

    if (Result.isError(defect)) {
      expect(defect.error).toBeInstanceOf(UnhandledException)
      expect(defect.error).not.toBeInstanceOf(Unauthenticated)
    }

    await runtime.dispose()
  })

  test('isolates concurrent session headers', async () => {
    const raw = new FakeAuth()
    const Auth = BetterAuth.service('@test/ConcurrentSessionAuth', raw)
    const runtime = await Runtime.make(Auth.layer)
    const serviceResult = await runtime.run(
      Effect.fn(async function* () {
        return Result.ok(yield* Auth)
      })
    )

    if (Result.isError(serviceResult)) {
      await runtime.dispose()
      throw new Error('Auth Service did not resolve')
    }

    const first = new Headers({
      authorization: 'Bearer valid',
      'x-request-id': 'first'
    })
    const second = new Headers({
      'x-request-id': 'second'
    })

    const [firstResult, secondResult] = await Promise.all([
      execute(serviceResult.value.session.get(first)),
      execute(serviceResult.value.session.get(second))
    ])

    expect(firstResult).toEqual(Result.ok(authenticatedSession))
    expect(secondResult).toEqual(Result.ok(null))
    expect(raw.sessionInputs.map((input) => input.headers.get('x-request-id'))).toEqual([
      'first',
      'second'
    ])

    await runtime.dispose()
  })
})

describe('Better Auth Web handler', () => {
  test('returns the exact non-2xx Response without consuming headers or streaming body', async () => {
    const raw = new FakeAuth()
    const Auth = BetterAuth.service('@test/HandlerAuth', raw)
    const runtime = await Runtime.make(Auth.layer)
    const serviceResult = await runtime.run(
      Effect.fn(async function* () {
        return Result.ok(yield* Auth)
      })
    )

    if (Result.isError(serviceResult)) {
      await runtime.dispose()
      throw new Error('Auth Service did not resolve')
    }

    const request = new Request('https://example.test/api/auth/session')
    const result = await execute(serviceResult.value.handle(request))

    expect(Result.isOk(result)).toBe(true)
    expect(raw.handlerRequests).toEqual([request])

    if (Result.isOk(result)) {
      const expectedResponse = raw.lastResponse
      expect(expectedResponse).toBeDefined()

      if (expectedResponse !== undefined) {
        expect(result.value).toBe(expectedResponse)
      }

      expect(result.value.status).toBe(401)
      expect(result.value.statusText).toBe('Unauthorized')
      expect(result.value.headers.getSetCookie()).toEqual(['first=1; Path=/', 'second=2; Path=/'])
      expect(result.value.bodyUsed).toBe(false)
      expect(await result.value.text()).toBe('streamed')
    }

    await runtime.dispose()
  })

  test('normalizes thrown API errors and defects while preserving the original causes', async () => {
    const raw = new FakeAuth()
    const Auth = BetterAuth.service('@test/HandlerFailureAuth', raw)
    const runtime = await Runtime.make(Auth.layer)
    const serviceResult = await runtime.run(
      Effect.fn(async function* () {
        return Result.ok(yield* Auth)
      })
    )

    if (Result.isError(serviceResult)) {
      await runtime.dispose()
      throw new Error('Auth Service did not resolve')
    }

    const apiError = await execute(
      serviceResult.value.handle(new Request('https://example.test/api/auth/api-error'))
    )
    const defect = await execute(
      serviceResult.value.handle(new Request('https://example.test/api/auth/defect'))
    )

    expect(Result.isError(apiError)).toBe(true)
    expect(Result.isError(defect)).toBe(true)

    if (Result.isError(apiError)) {
      expect(apiError.error).toBeInstanceOf(BetterAuthApiError)

      if (apiError.error instanceof BetterAuthApiError) {
        expect(apiError.error.code).toBe('INVALID_SESSION')
      }
    }

    if (Result.isError(defect)) {
      expect(defect.error).toBeInstanceOf(UnhandledException)
      expect(defect.error.cause).toBe(raw.handlerDefect)
    }

    await runtime.dispose()
  })
})
