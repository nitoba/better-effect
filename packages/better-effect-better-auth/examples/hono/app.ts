import { Hono } from 'hono'
import { Effect, Layer, Runtime } from 'better-effect'
import { HonoEffect } from 'better-effect/hono'
import { Result } from 'better-result'

import { BetterAuthHono } from 'better-effect-better-auth/hono'
import { Auth, credentials } from './auth'

const baseURL = 'http://localhost:3000'
const cookieHeaderFromSetCookie = (headers: Headers): string =>
  headers
    .getSetCookie()
    .map((setCookie) => setCookie.split(';', 1)[0])
    .join('; ')
const CurrentSession = BetterAuthHono.session('@example/CurrentSession', Auth)
const App = HonoEffect.app(
  '@example/HonoApp',
  {
    requestLayer: CurrentSession.requestLayer,
    onFailure: (_error, context) => context.json({ error: 'Internal Server Error' }, 500)
  },
  async function* (http) {
    const auth = yield* Auth
    const app = new Hono()

    // rawAuth is configured with basePath: '/api/auth'; register it before catch-alls.
    app.all('/api/auth/*', (context) => auth.raw.handler(context.req.raw))
    app.use('*', yield* http.middleware())
    app.use('/protected/*', yield* http.guard(CurrentSession.guard))

    app.get(
      '/protected/me',
      yield* http.gen(async function* () {
        const session = yield* CurrentSession.require()
        return Result.ok(session)
      })
    )

    return app
  }
)
const runtime = await Runtime.make(Layer.merge(Auth.layer, App.layer))
const appResult = await runtime.run(
  Effect.fn(async function* () {
    const app = yield* App
    const auth = yield* Auth
    return Result.ok({ app, rawAuth: auth.raw })
  })
)

if (Result.isError(appResult)) {
  throw new Error(`Better Auth Hono app acquisition failed: ${String(appResult.error)}`)
}

const { app, rawAuth } = appResult.value

const main = async (): Promise<void> => {
  try {
    await rawAuth.api.signUpEmail({ body: credentials })
    const signedIn = await rawAuth.api.signInEmail({
      body: {
        email: credentials.email,
        password: credentials.password
      },
      returnHeaders: true
    })
    const headers = new Headers({
      cookie: cookieHeaderFromSetCookie(signedIn.headers)
    })
    const authResponse = await app.request(
      new Request(`${baseURL}/api/auth/get-session`, { headers })
    )
    const protectedResponse = await app.request(new Request(`${baseURL}/protected/me`, { headers }))
    const protectedBody = await protectedResponse.json()

    if (
      authResponse.status !== 200 ||
      protectedResponse.status !== 200 ||
      protectedBody.data?.user?.email !== credentials.email
    ) {
      throw new Error('Authenticated Hono routes did not return the expected responses')
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
