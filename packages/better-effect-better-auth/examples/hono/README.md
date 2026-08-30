# Hono example

This development-only example uses the optional
`better-effect-better-auth/hono` entry point. Better Auth still owns its Web
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

app.all('/api/auth/*', (context) => rawAuth.handler(context.req.raw))
app.use('*', http.middleware())
app.get(
  '/protected',
  http.gen(async function* () {
    return Result.ok(yield* CurrentSession.get())
  })
)
```

The session is loaded only when `get()` or `require()` is yielded. Multiple
reads in one request share the same successful value, missing-session result,
or failure. `require()` converts only a missing session into
`Unauthenticated`; the HonoEffect `onFailure` policy decides the response.

Install Hono in the application and run the example from this package with:

```bash
bun add hono
bun examples/hono/app.ts
```

Better Auth's handler remains a conventional route and receives the original
Hono `Request`:

```ts
app.all('/api/auth/*', (context) => rawAuth.handler(context.req.raw))
```
