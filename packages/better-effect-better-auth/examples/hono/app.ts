import { Hono } from 'hono'
import { Effect, Runtime } from 'better-effect'
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
const runtime = await Runtime.make(Auth.layer)
const rawResult = await runtime.run(
  Effect.fn(async function* () {
    const auth = yield* Auth
    return Result.ok(auth.raw)
  })
)

if (Result.isError(rawResult)) {
  throw new Error(`Better Auth acquisition failed: ${String(rawResult.error)}`)
}

const rawAuth = rawResult.value
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
