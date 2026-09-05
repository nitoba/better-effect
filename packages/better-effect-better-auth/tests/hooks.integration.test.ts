import { describe, expect, test } from 'bun:test'
import { betterAuth, type BetterAuthPlugin } from 'better-auth'
import { createAuthEndpoint } from 'better-auth/api'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { CurrentAbortSignal, Effect, Layer, Runtime, Service, ServiceRuntime } from 'better-effect'
import { Result } from 'better-result'

import { BetterAuth } from '../src'
import { BetterAuthHooks, type BetterAuthMiddlewareContext } from '../src/hooks'

const baseURL = 'http://localhost:3000'

const makeDatabase = () => ({
  account: [],
  session: [],
  user: [],
  verification: []
})

type HookObservation = {
  readonly phase: string
  readonly context: BetterAuthMiddlewareContext
  readonly signal: AbortSignal
  readonly requestSignal: AbortSignal | undefined
  readonly returned: unknown
  readonly newSession: unknown
  readonly responseHeaders: Headers | undefined
}

class HookMarker extends Service<HookMarker>()('@integration/HookMarker') {}

describe('BetterAuthHooks with Better Auth', () => {
  test('define binds middleware to the Runtime that acquires BetterAuth.make', async () => {
    const hooks = BetterAuthHooks.define('@integration/DefinedHookContext')
    const marker = new HookMarker()
    let observedMarker: HookMarker | undefined
    let observedPath: string | undefined

    const Auth = BetterAuth.make('@integration/DefinedAuth', async function* () {
      const before = yield* hooks.gen(async function* () {
        const hook = yield* hooks.Context
        observedMarker = yield* HookMarker
        observedPath = hook.context.path
        return Result.ok()
      })

      return betterAuth({
        baseURL,
        database: memoryAdapter(makeDatabase()),
        hooks: { before },
        secret: 'hooks-defined-secret-not-for-production-use'
      })
    })
    const runtime = await Runtime.make(Layer.merge(Layer.succeed(HookMarker, marker), Auth.layer))

    try {
      const auth = await runtime.run(() => ServiceRuntime.resolve(Auth))
      expect(observedMarker).toBeUndefined()
      expect(await auth.raw.api.ok()).toEqual({ ok: true })
      expect(observedMarker).toBe(marker)
      expect(observedPath).toBe('/ok')
    } finally {
      await runtime.dispose()
    }
  })

  test('dispatches global and plugin hooks through rawAuth.api while plugin middleware stays request-only', async () => {
    const hooks = BetterAuthHooks.define('@integration/BetterAuthHookContext')
    const observations: HookObservation[] = []

    const observe = (phase: string) => (context: BetterAuthMiddlewareContext) =>
      Effect.fn(async function* () {
        const scoped = yield* hooks.Context
        const signal = yield* CurrentAbortSignal
        const authContext = scoped.context.context
        observations.push({
          phase,
          context,
          signal,
          requestSignal: scoped.context.request?.signal,
          returned: authContext.returned,
          newSession: authContext.newSession,
          responseHeaders: authContext.responseHeaders
        })
        return Result.ok()
      })

    const beforeOperation = hooks.middleware(observe('before'))
    const globalAfterOperation = hooks.middleware(observe('global-after'))
    const pluginMiddlewareOperation = hooks.middleware(observe('plugin-middleware'))
    const pluginAfterOperation = hooks.middleware(() =>
      Effect.fn(async function* () {
        const scoped = yield* hooks.Context
        const signal = yield* CurrentAbortSignal
        const authContext = scoped.context.context
        observations.push({
          phase: 'plugin-after',
          context: scoped.context,
          signal,
          requestSignal: scoped.context.request?.signal,
          returned: authContext.returned,
          newSession: authContext.newSession,
          responseHeaders: authContext.responseHeaders
        })
        return Result.ok(
          new Response('plugin hook response', {
            status: 202,
            headers: { 'x-hook-response': 'yes' }
          })
        )
      })
    )

    const Auth = BetterAuth.make('@integration/IntegratedAuth', async function* () {
      const before = yield* beforeOperation
      const globalAfter = yield* globalAfterOperation
      const pluginMiddleware = yield* pluginMiddlewareOperation
      const pluginAfter = yield* pluginAfterOperation
      const plugin = {
        id: 'hooks-integration',
        endpoints: {
          hooksEcho: createAuthEndpoint(
            '/hooks-integration/echo',
            { method: 'GET' },
            async (context) => context.json({ source: 'endpoint' })
          )
        },
        hooks: {
          after: [
            {
              matcher: (context) => context.path === '/hooks-integration/echo',
              handler: pluginAfter
            }
          ]
        },
        middlewares: [
          {
            path: '/hooks-integration/*',
            middleware: pluginMiddleware
          }
        ]
      } satisfies BetterAuthPlugin

      return betterAuth({
        baseURL,
        database: memoryAdapter(makeDatabase()),
        emailAndPassword: { enabled: true },
        hooks: { before, after: globalAfter },
        plugins: [plugin],
        secret: 'hooks-integration-secret-not-for-production-use'
      })
    })
    const runtime = await Runtime.make(Auth.layer)
    const auth = (await runtime.run(() => ServiceRuntime.resolve(Auth))).raw

    try {
      const directSignUp = await auth.api.signUpEmail({
        body: {
          email: 'hooks-direct@example.com',
          name: 'Hooks Direct',
          password: 'a-valid-password-123'
        }
      })
      expect(directSignUp.user.email).toBe('hooks-direct@example.com')

      const directEcho = await auth.api.hooksEcho({ asResponse: true })
      expect(directEcho.status).toBe(202)
      expect(directEcho.headers.get('x-hook-response')).toBe('yes')
      expect(await directEcho.text()).toBe('plugin hook response')

      const echoRequest = new Request(`${baseURL}/api/auth/hooks-integration/echo`)
      const echoResponse = await auth.handler(echoRequest)
      expect(echoResponse.status).toBe(202)
      expect(echoResponse.headers.get('x-hook-response')).toBe('yes')
      expect(await echoResponse.text()).toBe('plugin hook response')

      const directSignUpObservations = observations.filter(
        (observation) => observation.context.path === '/sign-up/email'
      )
      expect(directSignUpObservations.map((observation) => observation.phase)).toEqual([
        'before',
        'global-after'
      ])
      expect(
        directSignUpObservations.every((observation) => observation.context.request === undefined)
      ).toBe(true)
      expect(
        directSignUpObservations.every((observation) => observation.requestSignal === undefined)
      ).toBe(true)
      expect(directSignUpObservations[1]?.newSession).toBeTruthy()

      const directEchoObservations = observations.filter(
        (observation) =>
          observation.context.path === '/hooks-integration/echo' &&
          observation.requestSignal === undefined
      )
      expect(directEchoObservations.map((observation) => observation.phase)).toEqual([
        'before',
        'global-after',
        'plugin-after'
      ])
      expect(
        directEchoObservations.every((observation) => observation.context.request === undefined)
      ).toBe(true)

      const requestEchoObservations = observations.filter(
        (observation) =>
          observation.context.path === '/hooks-integration/echo' &&
          observation.requestSignal !== undefined
      )
      expect(requestEchoObservations.map((observation) => observation.phase)).toEqual([
        'plugin-middleware',
        'before',
        'global-after',
        'plugin-after'
      ])
      expect(
        requestEchoObservations.every((observation) => observation.context.request === echoRequest)
      ).toBe(true)
      expect(
        requestEchoObservations.every(
          (observation) => observation.requestSignal === echoRequest.signal
        )
      ).toBe(true)
      expect(
        requestEchoObservations.every((observation) => observation.signal !== echoRequest.signal)
      ).toBe(true)
      expect(requestEchoObservations[2]?.returned).toBeDefined()
      expect(requestEchoObservations[2]?.responseHeaders).toBeInstanceOf(Headers)
    } finally {
      await runtime.dispose()
    }
  })

  test('supports direct API dispatch and Better Auth background task hooks', async () => {
    const hooks = BetterAuthHooks.define('@integration/BetterAuthBackgroundHooks')
    const backgroundTasks: Promise<unknown>[] = []
    const observedPaths: string[] = []
    const backgroundHookOperation = hooks.middleware(() =>
      Effect.fn(async function* () {
        const hook = yield* hooks.Context
        hook.context.context.runInBackground(
          Promise.resolve().then(() => observedPaths.push(hook.context.path ?? 'unknown'))
        )
        return Result.ok()
      })
    )
    const Auth = BetterAuth.make('@integration/BackgroundAuth', async function* () {
      const backgroundHook = yield* backgroundHookOperation
      return betterAuth({
        advanced: {
          backgroundTasks: {
            handler: (task) => {
              backgroundTasks.push(task)
            }
          }
        },
        baseURL,
        database: memoryAdapter(makeDatabase()),
        hooks: { after: backgroundHook },
        secret: 'hooks-background-secret-not-for-production-use'
      })
    })
    const runtime = await Runtime.make(Auth.layer)
    const auth = (await runtime.run(() => ServiceRuntime.resolve(Auth))).raw

    try {
      expect(await auth.api.ok()).toEqual({ ok: true })
      expect(await auth.api.ok()).toEqual({ ok: true })
      expect(backgroundTasks).toHaveLength(2)

      await Promise.all(backgroundTasks)
      expect(observedPaths).toEqual(['/ok', '/ok'])
    } finally {
      await runtime.dispose()
    }
  })
})
