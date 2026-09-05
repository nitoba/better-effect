// This fixture mirrors the Better Auth Hono setup documented in apps/docs/content/docs/hono.mdx.

import { betterAuth } from 'better-auth'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { Hono } from 'hono'
import { Layer, Runtime, Service } from 'better-effect'
import { HonoEffect } from 'better-effect/hono'
import type { HonoEffectOptions } from 'better-effect/hono'
import { BetterAuth } from '../../src'
import { BetterAuthHono } from '../../src/hono'
import { Result } from 'better-result'

class AppService extends Service<AppService>()('@docs/AppService') {}
const AppLive = Layer.make(AppService)
const rawAuth = betterAuth({
  basePath: '/api/auth',
  database: memoryAdapter({
    account: [],
    session: [],
    user: [],
    verification: []
  }),
  emailAndPassword: { enabled: true },
  secret: 'replace-this-example-secret'
})
const Auth = BetterAuth.from('@docs/Auth', rawAuth)
const CurrentSession = BetterAuthHono.session('@docs/CurrentSession', Auth, {
  disableCookieCache: true
})
const honoOptions = {
  requestLayer: CurrentSession.requestLayer,
  onFailure: (_, context: import('better-effect/hono').HonoContext) =>
    context.json({ error: 'Request failed' }, 500)
} satisfies HonoEffectOptions<unknown, ReturnType<typeof CurrentSession.requestLayer>>
const App = HonoEffect.app('@docs/HonoApp', honoOptions, async function* (http) {
  const app = new Hono()

  app.all('/api/auth/*', (context) => rawAuth.handler(context.req.raw))
  app.use('*', yield* http.middleware())
  app.use('/api/private/*', yield* http.guard(CurrentSession.guard))
  app.get(
    '/api/private/me',
    yield* http.gen(async function* () {
      const session = yield* CurrentSession.require()
      return Result.ok({ userId: session.user.id })
    })
  )

  return app
})

const runtime = await Runtime.make(Layer.merge(AppLive, Auth.layer, App.layer))
void runtime
