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
  readonly returned: unknown
  readonly newSession: unknown
  readonly responseHeaders: Headers | undefined
}

describe('BetterAuthHooks with Better Auth', () => {
  test('runs global and plugin middleware flows with the original request context', async () => {
    const runtime = await Runtime.make(Layer.empty)
    const hooks = BetterAuthHooks.make('@integration/BetterAuthHookContext', runtime)
    const observations: HookObservation[] = []
    const pluginResponse = new Response('plugin hook response', {
      status: 202,
      headers: { 'x-hook-response': 'yes' }
    })

    const observe = (phase: string) => (context: BetterAuthMiddlewareContext) =>
      Effect.fn(async function* () {
        const scoped = yield* hooks.Context
        const signal = yield* CurrentAbortSignal
        const authContext = scoped.context.context
        observations.push({
          phase,
          context,
          signal,
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
          returned: authContext.returned,
          newSession: authContext.newSession,
          responseHeaders: authContext.responseHeaders
        })
        return Result.ok(pluginResponse)
      })
    )

    const plugin = {
      id: 'hooks-integration',
      endpoints: {
        echo: createAuthEndpoint('/hooks-integration/echo', { method: 'GET' }, async (context) =>
          context.json({ source: 'endpoint' })
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
      const controller = new AbortController()
      const echoRequest = new Request(`${baseURL}/api/auth/hooks-integration/echo`, {
        signal: controller.signal
      })
      const echoResponse = await auth.handler(echoRequest)

      expect(echoResponse.status).toBe(202)
      expect(echoResponse.headers.get('x-hook-response')).toBe('yes')
      expect(await echoResponse.text()).toBe('plugin hook response')

      const signUpResponse = await auth.handler(
        new Request(`${baseURL}/api/auth/sign-up/email`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            email: 'hooks@example.com',
            name: 'Hooks Integration',
            password: 'a-valid-password-123'
          })
        })
      )

      expect(signUpResponse.status).toBe(200)

      const echoObservations = observations.filter(
        (observation) => observation.context.path === '/hooks-integration/echo'
      )
      expect(echoObservations.map((observation) => observation.phase)).toEqual([
        'plugin-middleware',
        'before',
        'global-after',
        'plugin-after'
      ])
      expect(
        echoObservations.every((observation) => observation.context.request === echoRequest)
      ).toBe(true)
      expect(
        echoObservations.every((observation) => observation.signal === echoRequest.signal)
      ).toBe(true)
      expect(echoObservations[2]?.returned).toBeDefined()
      expect(echoObservations[2]?.responseHeaders).toBeInstanceOf(Headers)

      const signUpObservation = observations.find(
        (observation) =>
          observation.context.path === '/sign-up/email' && observation.phase === 'global-after'
      )
      expect(signUpObservation).toBeDefined()
      expect(signUpObservation?.returned).toBeDefined()
      expect(signUpObservation?.newSession).toBeTruthy()
      expect(signUpObservation?.responseHeaders).toBeInstanceOf(Headers)
    } finally {
      await runtime.dispose()
    }
  })
})
