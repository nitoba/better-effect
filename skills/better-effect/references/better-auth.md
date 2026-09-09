# Better Auth integration

Package: `better-effect-better-auth`; optional `/hooks` and `/hono` entrypoints.
Reference: [package README](https://github.com/nitoba/better-effect/blob/main/packages/better-effect-better-auth/README.md).
Better Auth still owns authentication, plugins, sessions, cookies, database
adapters/migrations, origin checks, and its Web handler.

## Construct or borrow explicitly

`BetterAuth.make(tag, generator)` lazily constructs the raw Better Auth instance
inside the application's Layer graph. Resolve contextual configuration/database
capabilities with `yield*` in that factory and **return the raw instance**.
The generated Service has `.layer` and `.of` for deliberate structural overrides.

```ts
import { betterAuth } from 'better-auth'
import { BetterAuth } from 'better-effect-better-auth'

const Auth = BetterAuth.make('@app/Auth', async function* () {
  return betterAuth({
    basePath: '/api/auth',
    emailAndPassword: { enabled: true }
  })
})
```

This shows the factory contract, not a production auth configuration. Supply
the application's database adapter, secret, origins, and plugin options using
Better Auth's own API. Compose Auth.layer with its dependencies in one Runtime.
Do not create an auxiliary Runtime to inspect registration policy or run hooks.

`BetterAuth.from(tag, rawAuth)` borrows an already-created instance through a
value Layer. It preserves identity and never closes/reconfigures resources
captured by the caller. `auth.raw` exposes that original instance unchanged.
A pool shared with Kysely/MQ has one owner; keep other facades borrowed.

## Endpoint modes are methods, not input flags

Inside an Effect Program resolving `const auth = yield* Auth`:

| Call | Success value |
| --- | --- |
| `yield* auth.api.getSession({ headers: request.headers })` | Typed endpoint data |
| `yield* auth.api.getSession.asResponse({ headers: request.headers })` | Native Response |
| `yield* auth.api.getSession.withHeaders({ headers: request.headers })` | `{ response, headers }` |
| `yield* auth.session.get(request)` | Optional session using the original request |
| `yield* auth.handle(request)` | Adapted Web handler response |

The same modes apply to inferred endpoints, including plugins. Keep the concrete
Better Auth type so plugin endpoints, fields, and error codes survive inference.
Do not pass native `asResponse`, `returnHeaders`, or `returnStatus` flags into
the adapted input. Use the mode method, or use `auth.raw` deliberately for an
unadapted native API. Preserve status, redirects, and repeated Set-Cookie headers;
do not rebuild an auth Response with an object spread or lossy JSON conversion.

Expected adapted failures use Result. Respect the integration's documented
API-error/UnhandledException normalization instead of assuming that every
rejection has the same domain tag or exposing its cause to a client.

## Hooks in the same Runtime

`BetterAuthHooks.define(tag)` from `/hooks` is inert. Create the bridge before
the raw instance, then **yield** `Hooks.gen(...)` during Auth Layer acquisition.
It captures the existing executor and supplies `Hooks.Context` per invocation.
The Program may yield ordinary application Services, not resolve Auth again
through a bootstrap cycle.

The hook generator returns Result. When its error channel is non-never, supply
an explicit `onFailure` mapper returning a Better Auth `APIError` or a Response
(or their Promise). An APIError is intentionally thrown at the Better Auth
middleware boundary; this is not a recommendation to throw expected failures
inside domain Programs. Hook/mapper defects are not guessed as authentication
failures. Successful undefined/context replacements/Responses pass through.

Per-invocation Layers are execution-owned. Preserve the original request on the
hook context and pass cancellation to cooperative work; `CurrentAbortSignal`
may be Runtime-linked rather than the identical request signal object.
Stop ingress, drain/dispose the serving Runtime, then close caller-owned pools.

## Hono sessions

With Auth declared, create a typed lazy request snapshot:

```ts
import { BetterAuthHono } from 'better-effect-better-auth/hono'

const CurrentSession = BetterAuthHono.session('@app/CurrentSession', Auth)
```

Set `requestLayer: CurrentSession.requestLayer` in `HonoEffect.app` options.
Inside its factory, install the captured middleware before protected routes:

```ts
app.use('*', yield* http.middleware())
app.use('/protected/*', yield* http.guard(CurrentSession.guard))
app.get('/protected/me', yield* http.gen(async function* () {
  const session = yield* CurrentSession.require()
  return Result.ok(session)
}))
```

`get()` and `require()` lazily share one snapshot per request, including missing
session or failure. `require()` maps a genuinely missing session to
`Unauthenticated`; a storage/provider error is not silently a missing session.
A sign-in/out after the first read does not refresh the snapshot. Use
`auth.session.get(originalRequest)` for an intentional fresh read.

Mount the original Better Auth handler at its configured basePath before
conflicting catch-alls, forwarding `c.req.raw` unchanged. Resolve Auth once
inside the application factory rather than keeping a second raw configuration.
Use a deliberate failure policy for public 401 responses; do not send every
auth infrastructure failure as 401 or leak native exception messages.
The [Hono example](https://github.com/nitoba/better-effect/tree/main/packages/better-effect-better-auth/examples/hono)
shows the complete application boundary.
