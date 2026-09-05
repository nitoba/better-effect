# better-effect-better-auth

**Server-side Better Auth integration for `better-effect`.**

`better-effect-better-auth` is an independent package in the `better-effect`
monorepo. Better Auth remains responsible for authentication, sessions,
cookies, OAuth, plugins, database adapters, migrations, origin checks, and its
Web-standard handler. This package adapts those public server APIs to the
`better-result` and `better-effect` programming model without adding Better
Auth to the core package.

The framework-neutral API starts with `BetterAuth.make(...)` when Better Auth
depends on contextual Services. Its generated Service exposes yieldable
`auth.api.*` endpoints, session helpers, and the Web-standard handler while
retaining the concrete instance as `auth.raw`. Use `BetterAuth.from(...)` for
an already-created, caller-owned instance.

## Installation

```bash
bun add better-effect-better-auth better-auth better-effect better-result
# Add Hono only when importing the optional /hono subpath:
bun add hono
```

The package is ESM-only. Its framework-neutral `.` entry point has these peer
requirements: `better-auth` `^1.7.0`, `better-effect` `>=0.12.0 <0.14.0`,
`better-result` `^3.0.0`, and TypeScript `>=5.7.0`. The package also exposes
optional public `/hooks` and `/hono` subpaths. Hono is an optional peer required
only when importing `/hono` (`>=4.0.0`); it is not needed by `.` or `/hooks`.
These dependencies remain owned by the application.

## Effectful Better Auth service

Declare a lazy Better Auth Service and provide its immutable Layer to a
`better-effect` Runtime:

```ts
import { betterAuth } from 'better-auth'
import { Effect, Layer, Runtime, Service } from 'better-effect'
import { BetterAuth } from 'better-effect-better-auth'
import { Result } from 'better-result'

class AppConfig extends Service<AppConfig>()('@app/AppConfig') {
  readonly baseURL = 'https://example.test'
}

const Auth = BetterAuth.make('@app/Auth', async function* () {
  const config = yield* AppConfig

  return betterAuth({
    baseURL: config.baseURL,
    basePath: '/api/auth',
    emailAndPassword: { enabled: true }
  })
})
const request = new Request('https://example.test/api/auth/session')

const program = Effect.fn(async function* () {
  const auth = yield* Auth
  const session = yield* auth.session.get(request)
  const response = yield* auth.api.getSession.asResponse({
    headers: request.headers
  })

  return Result.ok({ session, response })
})

const runtime = await Runtime.make(
  Layer.merge(Layer.succeed(AppConfig, new AppConfig()), Auth.layer)
)
const result = await runtime.run(program)
await runtime.dispose()
```

Every endpoint has normal, `.asResponse`, and `.withHeaders` transport modes.
The normal mode returns endpoint data, `.asResponse` returns the Web `Response`,
and `.withHeaders` returns `{ response, headers }`. Transport choices are
methods rather than Better Auth's `asResponse`, `returnHeaders`, or
`returnStatus` input flags, so the generated input type stays schema-defined.
Response bodies, status codes, redirects, and repeated `set-cookie` headers are
preserved.
The generated `Auth.layer` provides the Service, and `Auth.of` accepts a
structural replacement for tests or intentional Layer overrides. The original
Better Auth instance and its unadapted transport options remain available as
`auth.raw`. `auth.handle(request)` adapts Better Auth's Web-standard handler to
the same Result-oriented operation boundary.

## Plugins and inferred fields

Create and configure plugins inside the lazy factory as usual. Plugin
endpoints, plugin user/session fields, and plugin `$ERROR_CODES` remain visible
to TypeScript:

```ts
import { admin } from 'better-auth/plugins'

const Auth = BetterAuth.make('@app/Auth', async function* () {
  return betterAuth({
    // ...database and normal Better Auth options
    plugins: [admin()]
  })
})

const listUsers = Effect.fn(async function* () {
  const service = yield* Auth
  return Result.ok(yield* service.api.listUsers({ query: { limit: 10 } }))
})
```

## Prebuilt and caller-owned instances

`BetterAuth.from(tag, rawAuth)` adapts an instance that the application has
already created. It uses `Layer.succeed`, returns the exact same `auth.raw`
reference, and never closes, reconfigures, or otherwise owns the instance or
resources captured by its options:

```ts
const rawAuth = betterAuth({ emailAndPassword: { enabled: true } })
const Auth = BetterAuth.from('@app/Auth', rawAuth)
```

`BetterAuth.service(tag, rawAuth)` remains as a deprecated compatibility alias
for `BetterAuth.from`. New Layer-first code should use `make`; use `from` when
the raw instance is intentionally constructed outside the Layer.

The adapter does not create plugin configuration or add framework-specific
helpers. Keep Better Auth's plugins, database adapter, cookies, and handler in
the application.

## Hooks and plugin middleware

The optional public `better-effect-better-auth/hooks` subpath adapts Better Auth's
public `createAuthMiddleware` contract to a caller-owned `Runtime`. The bridge
never creates or disposes that Runtime:

```ts
import { betterAuth } from 'better-auth'
import { APIError } from 'better-auth/api'
import { Effect, Layer, Runtime } from 'better-effect'
import { BetterAuth } from 'better-effect-better-auth'
import { BetterAuthHooks } from 'better-effect-better-auth/hooks'
import { Result, TaggedError } from 'better-result'

class RegistrationDenied extends TaggedError('@app/RegistrationDenied')<{
  readonly message: string
}> {}

// Database and RegistrationPolicy are application Services. These values are
// created and owned by the application, not acquired by either Runtime.
const database = createApplicationDatabase()
const registrationPolicy = createRegistrationPolicy(database)
const coreValues = Layer.merge(
  Layer.succeed(Database, database),
  Layer.succeed(RegistrationPolicy, registrationPolicy)
)
const coreRuntime = await Runtime.make(coreValues)
const AuthHooks = BetterAuthHooks.make('@app/BetterAuthHookContext', coreRuntime)

const rawAuth = betterAuth({
  hooks: {
    before: AuthHooks.middleware(
      (context) =>
        Effect.fn(async function* () {
          const policy = yield* RegistrationPolicy
          const allowed = yield* policy.canRegister(context.body?.email)

          return allowed
            ? Result.ok()
            : Result.err(new RegistrationDenied({ message: 'Registration is not allowed' }))
        }),
      {
        onFailure: (failure) =>
          new APIError('FORBIDDEN', {
            code: failure._tag,
            message: failure.message
          })
      }
    )
  }
})
const Auth = BetterAuth.from('@app/Auth', rawAuth)
const appRuntime = await Runtime.make(Layer.merge(coreValues, Auth.layer))
```

`coreValues` is deliberately a value Layer: both Runtimes receive the same
application-owned Service instances. Do not pass an acquiring or scoped
`CoreLive` to multiple Runtimes, because each Runtime would own a separate
acquisition and release. Keep hook Programs dependent on core services rather
than the Better Auth Service itself; this avoids an Auth hook → Runtime → Auth
cycle. The bridge does not create, replace, or dispose either caller-owned
Runtime, and it does not own the Better Auth instance. A hook callback receives
the exact Better Auth context, and
deeper Programs can access the same reference through the execution-scoped
`AuthHooks.Context` Service:

```ts
const audit = AuthHooks.middleware(() =>
  Effect.fn(async function* () {
    const hook = yield* AuthHooks.Context
    // hook.context is the original Better Auth middleware context.
    void hook.context.path
    return Result.ok()
  })
)
```

`Result.ok(...)` values cross the bridge unchanged, including `undefined`,
`{ context: ... }` replacements, and `Response` values. A typed failure must
provide an explicit `onFailure` mapper returning `APIError`, `Response`, or a
promise of either. A `Response` keeps its identity, headers, cookies, redirect,
status, and body; an `APIError` is thrown for Better Auth to process. Program,
Runtime, and mapper defects are not guessed or converted to auth failures.

The original `context.request.signal` is retained unchanged on
`hook.context.request.signal` and is passed to the `better-effect` execution as
its caller signal. `CurrentAbortSignal` exposes the execution signal, which may
be a Runtime-linked signal when shutdown coordination is also active, so code
must not rely on that capability having the request signal's object identity.
Cancellation remains cooperative; cleanup still belongs to the execution
Scope. Direct server-side calls without a request run without an invented
request signal.

Shutdown ordering is application-owned too: stop accepting requests, then close
the Runtime that serves Better Auth, close the core Runtime, and only then close
the shared live resource. `Layer.succeed` does not register a disposer for that
value:

```ts
await appRuntime.dispose()
await coreRuntime.dispose()
await database.close()
```

This ordering prevents either Runtime or an in-flight hook from observing a
closed shared resource.

A middleware may also install a typed Layer for one Better Auth invocation. The
factory runs once per invocation, receives the original context, and its Layer
is merged with the hook Context Layer. Any scoped resources are owned by that
execution and released before the middleware completes; the bridge still does
not own the Runtime:

```ts
import { Effect, Layer, Service } from 'better-effect'
import { Result } from 'better-result'

class RequestMetadata extends Service<RequestMetadata>()('@app/RequestMetadata') {
  readonly path!: string
}

const requestAware = AuthHooks.middleware(
  () =>
    Effect.fn(async function* () {
      const metadata = yield* RequestMetadata
      return Result.ok({ context: { path: metadata.path } })
    }),
  {
    layer: (context) => Layer.succeed(RequestMetadata, RequestMetadata.of({ path: context.path }))
  }
)
```

The same middleware value can be used for global `before`/`after` hooks, plugin
hooks, or plugin `middlewares` without reimplementing matchers:

```ts
import type { BetterAuthPlugin } from 'better-auth'

const auditMiddleware = AuthHooks.middleware(() =>
  Effect.fn(async function* () {
    const hook = yield* AuthHooks.Context
    hook.context.context.runInBackground(Promise.resolve())
    return Result.ok()
  })
)

const auditPlugin = {
  id: 'audit-plugin',
  hooks: {
    after: [{ matcher: (context) => context.path === '/sign-in/email', handler: auditMiddleware }]
  },
  middlewares: [{ path: '/audit/*', middleware: auditMiddleware }]
} satisfies BetterAuthPlugin
```

Better Auth still decides when hooks and request-only plugin middlewares run,
and owns background-task semantics. Its public `auth.api.*` dispatch invokes
configured global and plugin hooks, including for requestless server-side
calls; plugin `middlewares` run only through a request handled by
`auth.handler`. The bridge does not store contexts, create a global controller,
run detached Runtime work, or provide framework adapters.

## Sessions

Use the explicit session helpers inside a Program. The optional helper keeps a
missing session as `null`; the required helper changes only that absence into
`Unauthenticated`:

```ts
const readSessions = (request: Request) =>
  Effect.fn(async function* () {
    const auth = yield* Auth
    const optional = yield* auth.session.get(request)
    const required = yield* auth.session.require(request)

    return Result.ok({ optional, required })
  })

const sessionRuntime = await Runtime.make(Auth.layer)
const sessionResult = await sessionRuntime.run(
  readSessions(new Request('https://example.test/api/auth/get-session'))
)
await sessionRuntime.dispose()
```

## Typed Better Auth API failures

Better Auth server APIs report expected failures with its public `APIError`.
`BetterAuthApiError` preserves that error for application code while providing
a stable `better-result` tag:

```ts
import { APIError } from 'better-auth/api'
import { BetterAuthApiError, Unauthenticated } from 'better-effect-better-auth'

const source = new APIError('UNAUTHORIZED', {
  code: 'INVALID_EMAIL_OR_PASSWORD',
  message: 'Invalid email or password'
})

const failure = BetterAuthApiError.from(source)

failure._tag // 'BetterAuthApiError'
failure.status // 'UNAUTHORIZED'
failure.statusCode // 401
failure.code // 'INVALID_EMAIL_OR_PASSWORD'
failure.cause === source // true

const toDomainFailure = (value: BetterAuthApiError | Unauthenticated) => {
  if (value._tag === 'Unauthenticated') {
    return { _tag: 'LoginRequired' as const }
  }

  if (
    value._tag === 'BetterAuthApiError' &&
    value.code === 'INVALID_EMAIL_OR_PASSWORD' &&
    value.statusCode === 401
  ) {
    return { _tag: 'InvalidCredentials' as const }
  }

  return {
    _tag: 'AuthProviderFailure' as const,
    code: value.code,
    statusCode: value.statusCode
  }
}

void toDomainFailure(failure)
```

The original `headers`, `body`, and `cause` remain available in memory for
explicit diagnostics. They are non-enumerable and excluded from `toJSON()` and
`JSON.stringify(...)` because they can contain cookies, tokens, request data,
or adapter details. Applications should still avoid logging these fields
indiscriminately.

Failures that are not Better Auth `APIError` values are represented by
`better-result`'s `UnhandledException` in the internal Promise adapter. They
are not guessed from messages or converted into authentication failures.

## Error-code inference

`BetterAuthErrorCode<TAuth>` derives the known code literals from the concrete
Better Auth instance. Core and plugin codes remain visible to TypeScript:

```ts
import { betterAuth } from 'better-auth'
import { admin } from 'better-auth/plugins'
import { type BetterAuthErrorCode, type BetterAuthFailure } from 'better-effect-better-auth'

const auth = betterAuth({
  plugins: [admin()]
})

type AuthCode = BetterAuthErrorCode<typeof auth>
// Includes core codes and admin-plugin codes such as
// 'YOU_ARE_NOT_ALLOWED_TO_LIST_USERS'.
```

`BetterAuthFailure<TAuth>` is the generic server-operation failure union:

```ts
type AuthFailure = BetterAuthFailure<typeof auth>
// BetterAuthApiError<BetterAuthErrorCode<typeof auth>> | UnhandledException
```

Known literals improve autocomplete, while `BetterAuthApiError.code` can still
preserve a future or dynamically supplied runtime string that is not present in
the configured `$ERROR_CODES` type.

## Hono request-scoped sessions

The optional public `better-effect-better-auth/hono` subpath composes with
`better-effect/hono`. It creates a typed current-session Service
whose request Layer is responsible only for that request's session value; the
matching Auth Service remains in the application Runtime:

```ts
import { Hono } from 'hono'
import { Effect, Runtime } from 'better-effect'
import { HonoEffect } from 'better-effect/hono'
import { BetterAuthHono } from 'better-effect-better-auth/hono'
import { Result } from 'better-result'

const CurrentSession = BetterAuthHono.session('@app/CurrentSession', Auth, {
  disableCookieCache: true
})
const runtime = await Runtime.make(Auth.layer)
const http = HonoEffect.make(runtime, {
  requestLayer: CurrentSession.requestLayer,
  onFailure: (_error, context) => context.json({ error: 'Request failed' }, 500)
})
const app = new Hono()

// Match Better Auth's configured basePath and register it before catch-all middleware.
app.all('/api/auth/*', async (context) => {
  const result = await runtime.run(
    Effect.fn(async function* () {
      const auth = yield* Auth
      return Result.ok(yield* auth.handle(context.req.raw))
    })
  )

  return Result.isOk(result) ? result.value : new Response(null, { status: 500 })
})
app.use('*', http.middleware())
app.use('/private/*', http.guard(CurrentSession.guard))
app.get(
  '/private/me',
  http.gen(async function* () {
    const session = yield* CurrentSession.require()
    return Result.ok({ userId: session.user.id })
  })
)
```

`CurrentSession.get()` returns the plugin-inferred session or `null`.
`CurrentSession.require()` maps only `null` to `Unauthenticated`; Better Auth
API failures remain `BetterAuthApiError`, while unexpected throws and rejections
become a new `UnhandledException` whose `.cause` is the original defect (the
defect itself is not returned as the failure). The first read is lazy and each
request caches one settlement, so guards and route handlers can share a lookup
without an implicit retry or refresh. If code signs in or signs out after that
first read, the request snapshot intentionally remains stale. For a consciously
fresh read, resolve the Auth Service and use the original request directly:

```ts
const readFreshSession = (request: Request) =>
  Effect.fn(async function* () {
    const auth = yield* Auth
    const fresh = yield* auth.session.get(request)
    return Result.ok(fresh)
  })
```

HonoEffect's `onFailure` callback owns the HTTP response policy. Configure
Better Auth with `basePath: '/api/auth'` when using the route above, and keep
its handler before conflicting catch-alls so the original Web `Request` and
`Response` semantics, including cookies and streaming bodies, remain untouched.

## Handler and testing boundaries

Better Auth's Web-standard handler can remain on a conventional framework route:

```ts
app.all('/api/auth/*', (context) => rawAuth.handler(context.req.raw))
```

When the handler belongs inside a Program, use `yield* auth.handle(request)`;
the returned `Response` is not eagerly consumed. The optional public
`better-effect-better-auth/hono` subpath provides the Hono integration. Hono is
not required by the framework-neutral `.` entry point or the `/hooks` subpath.

For tests, replace only the boundary you want to control with `Auth.of(...)`
and provide it through a normal `Layer.succeed`. This keeps the replacement
local to the test and does not rely on module mocking, singleton resets, or
global state:

```ts
import { Layer } from 'better-effect'

const liveRuntime = await Runtime.make(Auth.layer)
const liveResult = await liveRuntime.run(
  Effect.fn(async function* () {
    return Result.ok(yield* Auth)
  })
)
await liveRuntime.dispose()

if (Result.isError(liveResult)) throw liveResult.error

const AuthTest = Layer.succeed(
  Auth,
  Auth.of({
    ...liveResult.value,
    handle: async function* () {
      return new Response(JSON.stringify({ source: 'test' }), {
        headers: { 'content-type': 'application/json' }
      })
    }
  })
)
const testRuntime = await Runtime.make(AuthTest)
const testResult = await testRuntime.run(
  Effect.fn(async function* () {
    const auth = yield* Auth
    const response = yield* auth.handle(new Request('https://example.test'))
    return Result.ok(await response.json())
  })
)
await testRuntime.dispose()

void testResult
```

`auth.raw` is an escape hatch for Better Auth's `$context`, `$ERROR_CODES`,
options, endpoint metadata, or other APIs that the adapter intentionally does
not reinterpret.

## Explicit missing-session failure

`Unauthenticated` is reserved for an explicit “session required” helper. A
missing optional session remains `null`; it is not automatically converted into
an API or infrastructure failure.

```ts
import { Unauthenticated } from 'better-effect-better-auth'

const failure = new Unauthenticated({
  message: 'Authentication is required'
})
```

## License

MIT
