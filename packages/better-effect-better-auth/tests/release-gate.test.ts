import { describe, expect, test } from 'bun:test'
import { betterAuth, type BetterAuthPlugin } from 'better-auth'
import { APIError, createAuthEndpoint } from 'better-auth/api'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { admin } from 'better-auth/plugins'
import { Effect, Layer, Runtime } from 'better-effect'
import { Result, UnhandledException } from 'better-result'

import { BetterAuth, BetterAuthApiError, Unauthenticated, type BetterAuthOperation } from '../src'

const baseURL = 'http://localhost:3000'
const credentials = {
  email: 'admin@example.com',
  name: 'Release Gate Admin',
  password: 'a-valid-password-123'
} as const

/* oxlint-disable anti-slop/no-unsafe-dictionary-type -- Better Auth's public memory adapter accepts opaque persisted rows in this runtime fixture. */
type MemoryDatabase = {
  readonly account: Record<string, unknown>[]
  readonly session: Record<string, unknown>[]
  readonly user: Record<string, unknown>[]
  readonly verification: Record<string, unknown>[]
}
/* oxlint-enable anti-slop/no-unsafe-dictionary-type */

const makeDatabase = (): MemoryDatabase => ({
  account: [],
  session: [],
  user: [],
  verification: []
})

const cookieHeaderFromSetCookie = (headers: Headers): string =>
  headers
    .getSetCookie()
    .map((setCookie) => setCookie.split(';', 1)[0]!)
    .join('; ')

const execute = <A, E>(operation: BetterAuthOperation<A, E>) =>
  Result.gen(async function* () {
    const value = yield* operation
    return Result.ok(value)
  })

const makeReleaseGatePlugin = (signals: AbortSignal[]) =>
  ({
    id: 'release-gate',
    endpoints: {
      releaseGateEcho: createAuthEndpoint(
        '/release-gate/echo',
        { method: 'GET' },
        async (context) => context.json({ value: context.query?.value ?? null })
      ),
      releaseGateFailure: createAuthEndpoint(
        '/release-gate/failure',
        { method: 'GET' },
        async () => {
          throw new APIError(
            'TOO_MANY_REQUESTS',
            {
              code: 'CUSTOM_PLUGIN_FAILURE',
              message: 'The release-gate plugin failed'
            },
            new Headers({
              'retry-after': '7',
              'set-cookie': 'plugin-secret=do-not-serialize'
            })
          )
        }
      ),
      releaseGateForbidden: createAuthEndpoint(
        '/release-gate/forbidden',
        { method: 'GET' },
        async () => {
          throw new APIError('FORBIDDEN', {
            code: 'CUSTOM_FORBIDDEN',
            message: 'The release-gate request is forbidden'
          })
        }
      ),
      releaseGateHello: createAuthEndpoint(
        '/release-gate/hello',
        { method: 'GET' },
        async (context) => context.json({ hello: 'release-gate' })
      ),
      releaseGateRedirect: createAuthEndpoint(
        '/release-gate/redirect',
        { method: 'GET' },
        async (context) => {
          throw context.redirect(`${baseURL}/release-gate/target`)
        }
      ),
      releaseGateSignal: createAuthEndpoint(
        '/release-gate/signal',
        { method: 'GET', requireRequest: true },
        async (context) => {
          signals.push(context.request.signal)
          return context.json({ aborted: context.request.signal.aborted })
        }
      ),
      releaseGateStream: createAuthEndpoint(
        '/release-gate/stream',
        { method: 'GET' },
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('release-gate-stream'))
                controller.close()
              }
            }),
            {
              headers: {
                'content-type': 'text/plain'
              }
            }
          )
      )
    },
    schema: {
      session: {
        fields: {
          tenantId: {
            required: false,
            type: 'string'
          }
        }
      },
      user: {
        fields: {
          plan: {
            required: false,
            type: 'string'
          }
        }
      }
    },
    $ERROR_CODES: {
      CUSTOM_PLUGIN_FAILURE: {
        code: 'CUSTOM_PLUGIN_FAILURE',
        message: 'The release-gate plugin failed'
      }
    }
  }) satisfies BetterAuthPlugin

const makeReleaseGateAuth = (
  options: { readonly onAPIError?: { readonly throw?: boolean } } = {}
) => {
  const signals: AbortSignal[] = []
  const rawAuth = betterAuth({
    baseURL,
    database: memoryAdapter(makeDatabase()),
    emailAndPassword: {
      enabled: true
    },
    plugins: [admin({ defaultRole: 'admin' }), makeReleaseGatePlugin(signals)],
    secret: 'release-gate-secret-not-for-production-use',
    ...options
  })

  return { rawAuth, signals }
}

const makePlainAuth = () =>
  betterAuth({
    baseURL,
    database: memoryAdapter(makeDatabase()),
    emailAndPassword: {
      enabled: true
    },
    secret: 'plain-auth-secret-not-for-production-use'
  })

describe('Better Auth v0.1 release gate', () => {
  test('runs real email, session, plugin, transport, handler, and error flows', async () => {
    const { rawAuth, signals } = makeReleaseGateAuth()
    const Auth = BetterAuth.service('@release-gate/Auth', rawAuth)
    const runtime = await Runtime.make(Auth.layer)
    const signInInput = {
      body: {
        email: credentials.email,
        password: credentials.password
      }
    }

    try {
      const flow = await runtime.run(
        Effect.fn(async function* () {
          const auth = yield* Auth
          const created = yield* auth.api.signUpEmail({
            body: credentials
          })
          const signedIn = yield* auth.api.signInEmail.withHeaders(signInInput)
          const cookies = signedIn.headers.getSetCookie()
          const headers = new Headers({
            cookie: cookieHeaderFromSetCookie(signedIn.headers)
          })
          const request = new Request(`${baseURL}/protected`, {
            headers,
            signal: AbortSignal.timeout(5_000)
          })
          const optional = yield* auth.session.get(request)
          const required = yield* auth.session.require(request)
          const users = yield* auth.api.listUsers({
            headers,
            query: {
              limit: 5
            }
          })
          const pluginData = yield* auth.api.releaseGateHello({ headers })
          const pluginResponse = yield* auth.api.releaseGateHello.asResponse({ headers })
          const pluginWithHeaders = yield* auth.api.releaseGateHello.withHeaders({ headers })
          const signalController = new AbortController()
          const signalRequest = new Request(`${baseURL}/release-gate/signal`, {
            signal: signalController.signal
          })
          const signalResult = yield* auth.api.releaseGateSignal({
            request: signalRequest
          })
          const abortedController = new AbortController()
          abortedController.abort()
          const abortedRequest = new Request(`${baseURL}/api/auth/release-gate/signal`, {
            signal: abortedController.signal
          })
          const abortedResponse = yield* auth.handle(abortedRequest)
          const streamResponse = yield* auth.handle(
            new Request(`${baseURL}/api/auth/release-gate/stream`)
          )
          const invalidResponse = yield* auth.api.signInEmail.asResponse({
            body: {
              email: credentials.email,
              password: 'not-the-password'
            }
          })
          const badRequestResponse = yield* auth.api.signInEmail.asResponse({
            body: {
              email: 'not-an-email',
              password: 'not-a-password'
            }
          })
          const invalidHandlerResponse = yield* auth.handle(
            new Request(`${baseURL}/api/auth/sign-in/email`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                email: credentials.email,
                password: 'not-the-password'
              })
            })
          )
          const badRequestHandlerResponse = yield* auth.handle(
            new Request(`${baseURL}/api/auth/sign-in/email`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                email: 'not-an-email',
                password: 'not-a-password'
              })
            })
          )
          const signOut = yield* auth.api.signOut.withHeaders({ headers })
          const handlerResponse = yield* auth.handle(
            new Request(`${baseURL}/api/auth/get-session`, {
              headers
            })
          )
          const rawHandlerResponse = await rawAuth.handler(
            new Request(`${baseURL}/api/auth/get-session`, {
              headers
            })
          )

          return Result.ok({
            abortedRequest,
            abortedResponse,
            auth,
            badRequestHandlerResponse,
            badRequestResponse,
            created,
            cookies,
            handlerResponse,
            invalidHandlerResponse,
            invalidResponse,
            optional,
            pluginData,
            pluginResponse,
            pluginWithHeaders,
            rawHandlerResponse,
            required,
            signOut,
            signalRequest,
            signalResult,
            signals,
            streamResponse,
            users
          })
        })
      )

      expect(Result.isOk(flow)).toBe(true)
      expect(signInInput).toEqual({
        body: {
          email: credentials.email,
          password: credentials.password
        }
      })

      if (Result.isError(flow)) {
        return
      }

      expect(flow.value.created.user.role).toBe('admin')
      expect(flow.value.cookies.length).toBeGreaterThan(0)
      expect(flow.value.pluginData).toEqual({ hello: 'release-gate' })
      expect(flow.value.pluginResponse.status).toBe(200)
      expect(flow.value.pluginResponse.bodyUsed).toBe(false)
      expect(await flow.value.pluginResponse.text()).toBe('{"hello":"release-gate"}')
      expect(flow.value.pluginWithHeaders.response).toEqual({ hello: 'release-gate' })
      expect(flow.value.pluginWithHeaders.headers).toBeInstanceOf(Headers)
      expect(flow.value.signalResult).toEqual({ aborted: false })
      expect(flow.value.abortedResponse.status).toBe(200)
      expect(flow.value.abortedResponse.bodyUsed).toBe(false)
      expect(await flow.value.abortedResponse.json()).toEqual({ aborted: true })
      expect(flow.value.streamResponse.status).toBe(200)
      expect(flow.value.streamResponse.bodyUsed).toBe(false)
      expect(await flow.value.streamResponse.text()).toBe('release-gate-stream')
      expect(signals).toHaveLength(2)
      expect(signals[0]).toBe(flow.value.signalRequest.signal)
      expect(signals[1]).toBe(flow.value.abortedRequest.signal)
      expect(flow.value.invalidResponse.status).toBe(401)
      expect(flow.value.invalidResponse.bodyUsed).toBe(false)
      expect(flow.value.badRequestResponse.status).toBe(400)
      expect(flow.value.badRequestResponse.bodyUsed).toBe(false)
      expect(flow.value.invalidHandlerResponse.status).toBe(401)
      expect(flow.value.invalidHandlerResponse.bodyUsed).toBe(false)
      expect(flow.value.badRequestHandlerResponse.status).toBe(400)
      expect(flow.value.badRequestHandlerResponse.bodyUsed).toBe(false)
      expect(flow.value.signOut.response.success).toBe(true)
      expect(flow.value.signOut.headers.getSetCookie().length).toBeGreaterThan(0)
      expect(flow.value.handlerResponse.status).toBe(200)
      expect(flow.value.handlerResponse.bodyUsed).toBe(false)
      expect(flow.value.rawHandlerResponse.status).toBe(200)
      expect(flow.value.rawHandlerResponse.bodyUsed).toBe(false)
      expect(flow.value.optional).toEqual(flow.value.required)
      expect(flow.value.required.user.email).toBe(credentials.email)
      expect('plan' in flow.value.required.user).toBe(true)
      expect('tenantId' in flow.value.required.session).toBe(true)
      expect(flow.value.users.users).toHaveLength(1)
      expect(flow.value.users.total).toBe(1)
      expect(rawAuth.api.signInEmail).not.toHaveProperty('asResponse')
      expect(signals[0]).toBeInstanceOf(AbortSignal)

      const loggedOutHeaders = new Headers({
        cookie: cookieHeaderFromSetCookie(flow.value.signOut.headers)
      })
      const loggedOutRequest = new Request(`${baseURL}/protected`, {
        headers: loggedOutHeaders
      })
      const loggedOut = await execute(flow.value.auth.session.get(loggedOutRequest))
      const loggedOutRequired = await execute(flow.value.auth.session.require(loggedOutRequest))
      const missing = await execute(flow.value.auth.session.get(new Headers()))
      const requiredMissing = await execute(flow.value.auth.session.require(new Headers()))
      const invalidCredentials = await execute(
        flow.value.auth.api.signInEmail({
          body: {
            email: credentials.email,
            password: 'not-the-password'
          }
        })
      )
      // SAFETY: This intentionally bypasses the public input type to exercise the runtime conflict guard at the JavaScript boundary.
      const conflictingTransport = await execute(
        flow.value.auth.api.signInEmail({
          body: {
            email: credentials.email,
            password: credentials.password
          },
          asResponse: true
        } as never)
      )
      const pluginFailure = await execute(flow.value.auth.api.releaseGateFailure())
      const redirect = await execute(
        flow.value.auth.handle(new Request(`${baseURL}/api/auth/release-gate/redirect`))
      )
      const failedHandler = await execute(
        flow.value.auth.handle(new Request(`${baseURL}/api/auth/release-gate/failure`))
      )
      const forbiddenHandler = await execute(
        flow.value.auth.handle(new Request(`${baseURL}/api/auth/release-gate/forbidden`))
      )
      const notFound = await execute(
        flow.value.auth.handle(new Request(`${baseURL}/api/auth/not-a-real-endpoint`))
      )

      expect(loggedOut).toEqual(Result.ok(null))
      expect(Result.isError(loggedOutRequired)).toBe(true)
      if (Result.isError(loggedOutRequired)) {
        expect(loggedOutRequired.error).toBeInstanceOf(Unauthenticated)
      }
      expect(missing).toEqual(Result.ok(null))
      expect(Result.isError(requiredMissing)).toBe(true)
      expect(Result.isError(invalidCredentials)).toBe(true)
      expect(Result.isError(conflictingTransport)).toBe(true)
      expect(Result.isError(pluginFailure)).toBe(true)
      expect(Result.isOk(forbiddenHandler)).toBe(true)
      expect(Result.isOk(redirect)).toBe(true)
      expect(Result.isOk(failedHandler)).toBe(true)
      expect(Result.isOk(notFound)).toBe(true)

      if (Result.isError(requiredMissing)) {
        expect(requiredMissing.error).toBeInstanceOf(Unauthenticated)
      }
      if (Result.isError(invalidCredentials)) {
        expect(invalidCredentials.error).toBeInstanceOf(BetterAuthApiError)
        if (invalidCredentials.error instanceof BetterAuthApiError) {
          expect(invalidCredentials.error.code).toBe('INVALID_EMAIL_OR_PASSWORD')
        }
      }
      if (Result.isError(conflictingTransport)) {
        expect(conflictingTransport.error).toBeInstanceOf(UnhandledException)
      }
      if (Result.isError(pluginFailure)) {
        expect(pluginFailure.error).toBeInstanceOf(BetterAuthApiError)
        if (pluginFailure.error instanceof BetterAuthApiError) {
          expect(pluginFailure.error.statusCode).toBe(429)
          expect(pluginFailure.error.code).toBe('CUSTOM_PLUGIN_FAILURE')
          expect(new Headers(pluginFailure.error.headers).get('retry-after')).toBe('7')
          expect(JSON.stringify(pluginFailure.error)).not.toContain('plugin-secret')
        }
      }
      if (Result.isOk(forbiddenHandler)) {
        expect(forbiddenHandler.value.status).toBe(403)
        expect(forbiddenHandler.value.bodyUsed).toBe(false)
      }
      if (Result.isOk(redirect)) {
        expect(redirect.value.status).toBe(302)
        expect(redirect.value.headers.get('location')).toBe(`${baseURL}/release-gate/target`)
        expect(redirect.value.bodyUsed).toBe(false)
      }
      if (Result.isOk(failedHandler)) {
        expect(failedHandler.value.status).toBe(429)
        expect(failedHandler.value.headers.get('retry-after')).toBe('7')
        expect(failedHandler.value.headers.getSetCookie()).toEqual([
          'plugin-secret=do-not-serialize'
        ])
        expect(failedHandler.value.bodyUsed).toBe(false)
      }
      if (Result.isOk(notFound)) {
        expect(notFound.value.status).toBe(404)
        expect(await notFound.value.text()).toBe('')
      }
    } finally {
      await runtime.dispose()
    }
  })

  test('keeps plugin surfaces and concurrent requests isolated across Service instances', async () => {
    const first = makeReleaseGateAuth()
    const firstAuth = BetterAuth.service('@release-gate/FirstAuth', first.rawAuth)
    const secondRaw = makePlainAuth()
    const secondAuth = BetterAuth.service('@release-gate/SecondAuth', secondRaw)
    const runtime = await Runtime.make(Layer.merge(firstAuth.layer, secondAuth.layer))

    try {
      const result = await runtime.run(
        Effect.fn(async function* () {
          const firstService = yield* firstAuth
          const secondService = yield* secondAuth
          return Result.ok({ firstService, secondService })
        })
      )

      expect(Result.isOk(result)).toBe(true)
      if (Result.isError(result)) {
        return
      }

      expect(result.value.firstService.raw).toBe(first.rawAuth)
      expect(result.value.secondService.raw).toBe(secondRaw)
      expect(result.value.firstService.api.getSession).not.toBe(
        result.value.secondService.api.getSession
      )
      expect(
        Object.prototype.hasOwnProperty.call(result.value.secondService.raw.api, 'releaseGateEcho')
      ).toBe(false)
      expect(
        Object.prototype.hasOwnProperty.call(result.value.secondService.raw.api, 'listUsers')
      ).toBe(false)

      const [slow, fast] = await Promise.all([
        execute(result.value.firstService.api.releaseGateEcho({ query: { value: 'slow' } })),
        execute(result.value.firstService.api.releaseGateEcho({ query: { value: 'fast' } }))
      ])

      expect(slow).toEqual(Result.ok({ value: 'slow' }))
      expect(fast).toEqual(Result.ok({ value: 'fast' }))
    } finally {
      await runtime.dispose()
    }

    const afterDispose = await first.rawAuth.handler(new Request(`${baseURL}/api/auth/get-session`))
    expect(afterDispose.status).toBe(200)
  })

  test('normalizes defects and honors public onAPIError.throw configuration', async () => {
    const rawApi = {
      syncThrow: (): Promise<never> => {
        throw new Error('synchronous defect')
      },
      async rejection() {
        throw new Error('rejected defect')
      }
    }
    type DefectAuthInfer = { readonly Session: never }
    // SAFETY: The fake Better Auth instance intentionally supplies only the minimal public inference contract needed by this boundary test.
    const defectInfer = {} as DefectAuthInfer
    const DefectAuth = BetterAuth.service('@release-gate/DefectAuth', {
      $ERROR_CODES: {},
      $Infer: defectInfer,
      api: {
        getSession: async () => null,
        ...rawApi
      },
      handler: async () => new Response(null)
    })
    const { rawAuth: throwingRawAuth } = makeReleaseGateAuth({
      onAPIError: { throw: true }
    })
    const ThrowingAuth = BetterAuth.service('@release-gate/ThrowingAuth', throwingRawAuth)
    const runtime = await Runtime.make(Layer.merge(DefectAuth.layer, ThrowingAuth.layer))

    try {
      const result = await runtime.run(
        Effect.fn(async function* () {
          const defectAuth = yield* DefectAuth
          const throwingAuth = yield* ThrowingAuth
          const sync = await execute(defectAuth.api.syncThrow())
          const rejection = await execute(defectAuth.api.rejection())
          const throwingApiError = await execute(throwingAuth.api.releaseGateFailure())
          return Result.ok({ rejection, sync, throwingApiError })
        })
      )

      expect(Result.isOk(result)).toBe(true)
      if (Result.isOk(result)) {
        expect(Result.isError(result.value.sync)).toBe(true)
        expect(Result.isError(result.value.rejection)).toBe(true)
        expect(Result.isError(result.value.throwingApiError)).toBe(true)
        if (Result.isError(result.value.sync)) {
          expect(result.value.sync.error).toBeInstanceOf(UnhandledException)
        }
        if (Result.isError(result.value.rejection)) {
          expect(result.value.rejection.error).toBeInstanceOf(UnhandledException)
        }
        if (Result.isError(result.value.throwingApiError)) {
          expect(result.value.throwingApiError.error).toBeInstanceOf(BetterAuthApiError)
          if (result.value.throwingApiError.error instanceof BetterAuthApiError) {
            expect(result.value.throwingApiError.error.code).toBe('CUSTOM_PLUGIN_FAILURE')
            expect(result.value.throwingApiError.error.statusCode).toBe(429)
          }
        }
      }
    } finally {
      await runtime.dispose()
    }
  })

  test('retains unknown APIError codes while redacting sensitive serialization', () => {
    const source = new APIError(
      'BAD_REQUEST',
      {
        code: 'FUTURE_PLUGIN_CODE',
        message: 'Future plugin failure',
        secret: 'sensitive-body-value'
      },
      new Headers({
        'set-cookie': 'session=secret'
      })
    )
    const normalized = BetterAuthApiError.from<'KNOWN_CODE'>(source)

    expect(normalized.code?.toString()).toBe('FUTURE_PLUGIN_CODE')
    expect(normalized.headers).toBe(source.headers)
    expect(normalized.cause).toBe(source)
    expect(JSON.stringify(normalized)).not.toContain('sensitive-body-value')
    expect(JSON.stringify(normalized)).not.toContain('session=secret')
  })
})
