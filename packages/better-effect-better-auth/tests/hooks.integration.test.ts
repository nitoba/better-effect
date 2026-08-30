import { describe, expect, test } from 'bun:test'
import { betterAuth, type BetterAuthPlugin } from 'better-auth'
import { createAuthEndpoint } from 'better-auth/api'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { CurrentAbortSignal, Effect, Layer, Runtime } from 'better-effect'
import { Result } from 'better-result'

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

describe('BetterAuthHooks with Better Auth', () => {
  test('dispatches global and plugin hooks through rawAuth.api while plugin middleware stays request-only', async () => {
    const runtime = await Runtime.make(Layer.empty)
    const hooks = BetterAuthHooks.make('@integration/BetterAuthHookContext', runtime)
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

    const before = hooks.middleware(observe('before'))
    const globalAfter = hooks.middleware(observe('global-after'))
    const pluginMiddleware = hooks.middleware(observe('plugin-middleware'))
    const pluginAfter = hooks.middleware(() =>
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

    const auth = betterAuth({
      baseURL,
      database: memoryAdapter(makeDatabase()),
      emailAndPassword: { enabled: true },
      hooks: { before, after: globalAfter },
      plugins: [plugin],
      secret: 'hooks-integration-secret-not-for-production-use'
    })

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
    const runtime = await Runtime.make(Layer.empty)
    const hooks = BetterAuthHooks.make('@integration/BetterAuthBackgroundHooks', runtime)
    const backgroundTasks: Promise<unknown>[] = []
    const observedPaths: string[] = []
    const backgroundHook = hooks.middleware(() =>
      Effect.fn(async function* () {
        const hook = yield* hooks.Context
        hook.context.context.runInBackground(
          Promise.resolve().then(() => observedPaths.push(hook.context.path ?? 'unknown'))
        )
        return Result.ok()
      })
    )
    const auth = betterAuth({
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
