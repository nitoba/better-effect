# Hono example

This development-only example exercises the optional public
`better-effect-better-auth/hono` subpath. Better Auth still owns its Web
handler, while `BetterAuthHono.session(...)` provides a lazy,
request-scoped current session to `HonoEffect`:

```ts
import { Hono } from 'hono'
import { Effect, Layer, Runtime } from 'better-effect'
import { HonoEffect } from 'better-effect/hono'
import { BetterAuthHono } from 'better-effect-better-auth/hono'
import { Result } from 'better-result'

const CurrentSession = BetterAuthHono.session('@app/CurrentSession', Auth)
const App = HonoEffect.app(
  '@app/HonoApp',
  {
    requestLayer: CurrentSession.requestLayer
  },
  async function* (http) {
    const app = new Hono()

    // rawAuth is configured with basePath: '/api/auth'. Register it before catch-alls.
    app.all('/api/auth/*', (context) => rawAuth.handler(context.req.raw))
    app.use('*', yield* http.middleware())
    app.use('/protected/*', yield* http.guard(CurrentSession.guard))
    app.get(
      '/protected/me',
      yield* http.gen(async function* () {
        return Result.ok(yield* CurrentSession.require())
      })
    )

    return app
  }
)

const runtime = await Runtime.make(Layer.merge(Auth.layer, App.layer))
const result = await runtime.run(
  Effect.fn(async function* () {
    return Result.ok(yield* App)
  })
)
if (Result.isError(result)) throw result.error
const app = result.value
```

The session is loaded only when `get()` or `require()` is yielded. Multiple
reads in one request share the same successful value, missing-session result,
or failure, including the `http.guard(CurrentSession.guard)` route. A
sign-in/sign-out after the first read does not refresh that request snapshot;
use the original request with `auth.session.get(request)` for a deliberate fresh
read. `require()` converts only a missing session into `Unauthenticated`; thrown
or rejected defects become `UnhandledException` with the original value only in
its `cause`, and the HonoEffect `onFailure` policy decides the response.

This example can be run from a source checkout/workspace. From the repository
root:

```bash
bun install
bun run build
cd packages/better-effect-better-auth
bun examples/hono/app.ts
```

The authenticated smoke test prints:

```text
{"authStatus":200,"protectedStatus":200}
```

Hono is an optional peer required only by the `/hono` subpath; the repository
workspace installs it for this example. A standalone application can install
the package with:

```bash
bun add better-effect-better-auth better-auth better-effect better-result hono
```

Better Auth's configuration must use the same base path as its conventional
route, and the route must be registered before conflicting catch-alls. It
receives the original Hono `Request`:

```ts
const rawAuth = betterAuth({
  basePath: '/api/auth'
  // ...the rest of the configuration
})
app.all('/api/auth/*', (context) => rawAuth.handler(context.req.raw))
```
