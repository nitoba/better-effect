# better-effect-better-auth

**Server-side Better Auth integration for `better-effect`.**

`better-effect-better-auth` is an independent package in the `better-effect`
monorepo. Better Auth remains responsible for authentication, sessions,
cookies, OAuth, plugins, database adapters, migrations, origin checks, and its
Web-standard handler. This package adapts those public server APIs to the
`better-result` and `better-effect` programming model without adding Better
Auth to the core package.

The v0.1 API adapts an existing Better Auth instance with
`BetterAuth.service(...)`. Its generated Service exposes yieldable
`auth.api.*` endpoints, session helpers, and the Web-standard handler while
retaining the original instance as `auth.raw`.

## Installation

```bash
bun add better-effect-better-auth better-auth better-effect better-result
```

The package is ESM-only. Its v0.1 peer matrix is `better-auth` `^1.7.0`,
`better-effect` `>=0.12.0 <0.14.0`, `better-result` `^3.0.0`, and TypeScript
`>=5.7.0`. These dependencies remain owned by the application.

## Effectful Better Auth service

Create a Service token from an existing Better Auth instance and provide its
immutable Layer to a `better-effect` Runtime:

```ts
import { betterAuth } from 'better-auth'
import { Effect, Runtime } from 'better-effect'
import { BetterAuth } from 'better-effect-better-auth'
import { Result } from 'better-result'

const rawAuth = betterAuth({
  emailAndPassword: { enabled: true }
})
const Auth = BetterAuth.service('@app/Auth', rawAuth)
const request = new Request('https://example.test/api/auth/session')

const program = Effect.fn(async function* () {
  const auth = yield* Auth
  const session = yield* auth.session.get(request)
  const response = yield* auth.api.getSession.asResponse({
    headers: request.headers
  })

  return Result.ok({ session, response })
})

const runtime = await Runtime.make(Auth.layer)
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

Create and configure plugins on the Better Auth instance as usual. When
`BetterAuth.service` receives the concrete instance, plugin endpoints, plugin
user/session fields, and plugin `$ERROR_CODES` remain visible to TypeScript:

```ts
import { admin } from 'better-auth/plugins'

const auth = betterAuth({
  // ...database and normal Better Auth options
  plugins: [admin()]
})
const Auth = BetterAuth.service('@app/Auth', auth)

const listUsers = Effect.fn(async function* () {
  const service = yield* Auth
  return Result.ok(yield* service.api.listUsers({ query: { limit: 10 } }))
})
```

The adapter does not create plugin configuration or add framework-specific
helpers. Keep Better Auth's plugins, database adapter, cookies, and handler in
the application.

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

## Handler and testing boundaries

Better Auth's Web-standard handler can remain on a conventional framework route:

```ts
app.all('/api/auth/*', (context) => rawAuth.handler(context.req.raw))
```

When the handler belongs inside a Program, use `yield* auth.handle(request)`;
the returned `Response` is not eagerly consumed. The package does not publish a
Hono adapter or require a framework dependency.

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

## v0.1 non-goals

- server-side only in v0.1;
- no client hooks or React/Vue/Svelte/Solid adapters;
- no framework middleware helpers or framework subpaths;
- no implicit `CurrentAuthSession` or request-scoped session integration;
- no roles, policy, or authorization engine;
- no automatic conversion to application-domain failures;
- no retry, timeout, or circuit-breaker policies;
- no database adapter;
- no database migrations;
- no environment or configuration ownership;
- no Runtime or dependency-container ownership;
- no official Better Auth-maintained integration or compatibility guarantee.

The package adapts an existing Better Auth instance and does not create or own
Better Auth, database, environment, Runtime, or dependency-container
lifecycle. Better Auth remains responsible for its public server APIs and
plugin compatibility.

## License

MIT
