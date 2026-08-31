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

`better-effect-better-auth` is implemented in this source tree, but its first
npm release is pending: it is not published and
`better-effect-better-auth-v0.1.0` has not been tagged. Until the approved
package-qualified release is published, run this example from a source
checkout/workspace. From the repository root:

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
workspace installs it for this example. After the package-qualified npm release,
a standalone application can install the package with:

```bash
# After the approved package-qualified npm release is published:
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
