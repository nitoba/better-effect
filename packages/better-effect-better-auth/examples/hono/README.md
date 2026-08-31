# Hono example

This development-only example exercises the optional public
`better-effect-better-auth/hono` subpath. Better Auth still owns its Web
handler, while `BetterAuthHono.session(...)` provides a lazy,
request-scoped current session to `HonoEffect`:

```ts
import { Hono } from 'hono'
import { HonoEffect } from 'better-effect/hono'
import { BetterAuthHono } from 'better-effect-better-auth/hono'

const CurrentSession = BetterAuthHono.session('@app/CurrentSession', Auth)
const http = HonoEffect.make(runtime, {
  requestLayer: CurrentSession.requestLayer
})

// rawAuth is configured with basePath: '/api/auth'. Register it before catch-alls.
app.all('/api/auth/*', (context) => rawAuth.handler(context.req.raw))
app.use('*', http.middleware())
app.use('/protected/*', http.guard(CurrentSession.guard))
app.get(
  '/protected/me',
  http.gen(async function* () {
    return Result.ok(yield* CurrentSession.require())
  })
)
```

The session is loaded only when `get()` or `require()` is yielded. Multiple
reads in one request share the same successful value, missing-session result,
or failure, including the `http.guard(CurrentSession.guard)` route. A
sign-in/sign-out after the first read does not refresh that request snapshot;
use the original request with `auth.session.get(request)` for a deliberate fresh
read. `require()` converts only a missing session into `Unauthenticated`; thrown
or rejected defects become `UnhandledException` with the original value only in
its `cause`, and the HonoEffect `onFailure` policy decides the response.

Install Hono in the application when using this `/hono` example; it is not
needed by the framework-neutral `.` entry point or the `/hooks` subpath. Run the
example from this package with:

```bash
bun add hono
bun examples/hono/app.ts
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
