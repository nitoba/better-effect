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

The package is ESM-only and follows the Node.js, Bun, and TypeScript support
matrix of `better-effect`. Better Auth, `better-effect`, `better-result`, and
TypeScript are peer dependencies and remain owned by the application.

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
The generated `Auth.layer` provides the Service, and `Auth.of` accepts a
structural replacement for tests or intentional Layer overrides. The original
Better Auth instance and its unadapted transport options remain available as
`auth.raw`. `auth.handle(request)` adapts Better Auth's Web-standard handler to
the same Result-oriented operation boundary.

## Typed Better Auth API failures

Better Auth server APIs report expected failures with its public `APIError`.
`BetterAuthApiError` preserves that error for application code while providing
a stable `better-result` tag:

```ts
import { APIError } from 'better-auth/api'
import { BetterAuthApiError } from 'better-effect-better-auth'

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
import type { BetterAuthErrorCode } from 'better-effect-better-auth'

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

## Current scope

The package is server-side and framework-neutral. It adapts an existing Better
Auth instance but does not:

- create or configure the Better Auth instance;
- choose a database adapter or run migrations;
- read environment variables;
- own Runtime lifecycle or application dependency configuration;
- provide React, Vue, Svelte, or Solid client hooks;
- create a router, roles system, or authorization framework;
- map Better Auth codes automatically to application-domain failures;
- add Better Auth or framework dependencies to the `better-effect` core.

## License

MIT
