import { betterAuth } from 'better-auth'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { Hono } from 'hono'
import { Effect, Layer, Runtime } from 'better-effect'
import { HonoEffect } from 'better-effect/hono'
import { BetterAuth, Unauthenticated } from 'better-effect-better-auth'
import { BetterAuthHono } from 'better-effect-better-auth/hono'
import { Result } from 'better-result'

const baseURL = 'http://localhost:3000'
const credentials = {
  email: 'hono-consumer@example.com',
  name: 'Hono Consumer',
  password: 'a-valid-password-123'
}
const makeDatabase = () => ({ account: [], session: [], user: [], verification: [] })
const cookieHeaderFromSetCookie = (headers) =>
  headers
    .getSetCookie()
    .map((setCookie) => setCookie.split(';', 1)[0])
    .join('; ')
const rawAuth = betterAuth({
  baseURL,
  basePath: '/api/auth',
  database: memoryAdapter(makeDatabase()),
  emailAndPassword: { enabled: true },
  secret: 'external-hono-consumer-secret-not-for-production-use'
})
const Auth = BetterAuth.service('@hono-consumer/Auth', rawAuth)
const execute = (operation) =>
  Result.gen(async function* () {
    return Result.ok(yield* operation)
  })
const CurrentSession = BetterAuthHono.session('@hono-consumer/CurrentSession', Auth, {
  disableCookieCache: true
})
const HonoApp = HonoEffect.app(
  '@hono-consumer/HonoApp',
  {
    requestLayer: CurrentSession.requestLayer,
    onFailure: (error) => {
      if (!(error instanceof Unauthenticated)) throw error
      return new Response('hono failure', { status: 500 })
    }
  },
  async function* (http) {
    const app = new Hono()
    // Match rawAuth's basePath and register its handler before catch-all middleware.
    app.all('/api/auth/*', (context) => rawAuth.handler(context.req.raw))
    app.use('*', yield* http.middleware())
    app.use('/private/*', yield* http.guard(CurrentSession.guard))
    app.get(
      '/hono-session',
      yield* http.gen(async function* () {
        const session = yield* CurrentSession.require()
        return Result.ok({ email: session.user.email })
      })
    )
    app.get(
      '/private/me',
      yield* http.gen(async function* () {
        const session = yield* CurrentSession.require()
        return Result.ok({ email: session.user.email })
      })
    )
    app.get(
      '/same-request',
      yield* http.gen(async function* (context) {
        const snapshot = yield* CurrentSession.get()
        const auth = yield* Auth
        yield* auth.api.signOut({ headers: context.req.raw.headers })
        const fresh = yield* auth.session.get(context.req.raw)
        const cached = yield* CurrentSession.get()
        return Result.ok({
          cachedEmail: cached?.user.email ?? null,
          freshEmail: fresh?.user.email ?? null,
          snapshotEmail: snapshot?.user.email ?? null
        })
      })
    )
    return app
  }
)

const honoRuntime = await Runtime.make(Layer.merge(Auth.layer, HonoApp.layer))
let response
let loggedOut
let sameRequest
let rawAuthResponse
let guardedResponse
try {
  const authResult = await honoRuntime.run(
    Effect.fn(async function* () {
      return Result.ok(yield* Auth)
    })
  )
  if (!Result.isOk(authResult)) {
    throw new Error(`Hono fixture Auth acquisition failed: ${String(authResult.error)}`)
  }
  const auth = authResult.value
  await execute(auth.api.signUpEmail({ body: credentials }))
  const signIn = await execute(
    auth.api.signInEmail.withHeaders({
      body: { email: credentials.email, password: credentials.password }
    })
  )
  if (!Result.isOk(signIn)) throw new Error(`Hono fixture sign-in failed: ${String(signIn.error)}`)

  const appResult = await honoRuntime.run(
    Effect.fn(async function* () {
      return Result.ok(yield* HonoApp)
    })
  )
  if (!Result.isOk(appResult)) {
    throw new Error(`Hono fixture app acquisition failed: ${String(appResult.error)}`)
  }
  const app = appResult.value
  const headers = new Headers({ cookie: cookieHeaderFromSetCookie(signIn.value.headers) })
  rawAuthResponse = await app.request(new Request(`${baseURL}/api/auth/get-session`, { headers }))
  guardedResponse = await app.request(new Request(`${baseURL}/private/me`, { headers }))
  response = await app.request(new Request(`${baseURL}/hono-session`, { headers }))
  sameRequest = await app.request(new Request(`${baseURL}/same-request`, { headers }))
  loggedOut = await app.request(new Request(`${baseURL}/hono-session`))
} finally {
  await honoRuntime.dispose()
}
if (
  rawAuthResponse.status !== 200 ||
  guardedResponse.status !== 200 ||
  response.status !== 200 ||
  (await response.json()).data.email !== credentials.email ||
  sameRequest.status !== 200 ||
  JSON.stringify(await sameRequest.json()) !==
    JSON.stringify({
      data: {
        cachedEmail: credentials.email,
        freshEmail: null,
        snapshotEmail: credentials.email
      }
    }) ||
  loggedOut.status !== 500
) {
  throw new Error('External Better Auth Hono session behavior did not pass')
}
