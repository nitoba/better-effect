import { Hono } from 'hono'
import { Runtime } from 'better-effect'
import { HonoEffect } from 'better-effect/hono'
import { Result } from 'better-result'

import { BetterAuthHono } from 'better-effect-better-auth/hono'
import { Auth, rawAuth } from './auth'

const runtime = await Runtime.make(Auth.layer)
const CurrentSession = BetterAuthHono.session('@example/CurrentSession', Auth)
const http = HonoEffect.make(runtime, {
  requestLayer: CurrentSession.requestLayer,
  onFailure: (_error, context) => context.json({ error: 'Internal Server Error' }, 500)
})
const app = new Hono()

// rawAuth is configured with basePath: '/api/auth'; register it before catch-alls.
app.all('/api/auth/*', (context) => rawAuth.handler(context.req.raw))
app.use('*', http.middleware())
app.use('/protected/*', http.guard(CurrentSession.guard))

app.get(
  '/protected/me',
  http.gen(async function* () {
    const session = yield* CurrentSession.require()
    return Result.ok(session)
  })
)

const main = async (): Promise<void> => {
  try {
    const authResponse = await app.request('/api/auth/get-session')
    const protectedResponse = await app.request('/protected/me')

    if (authResponse.status !== 200 || protectedResponse.status !== 200) {
      throw new Error('Hono routes did not return the expected responses')
    }

    console.log(
      JSON.stringify({
        authStatus: authResponse.status,
        protectedStatus: protectedResponse.status
      })
    )
  } finally {
    await runtime.dispose()
  }
}

await main()
