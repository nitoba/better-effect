# better-effect-better-auth

**Server-side Better Auth integration foundations for `better-effect`.**

`better-effect-better-auth` is an independent package in the `better-effect`
monorepo. Better Auth remains responsible for authentication, sessions,
cookies, OAuth, plugins, database adapters, migrations, origin checks, and its
Web-standard handler. This package adapts those public server APIs to the
`better-result` and `better-effect` programming model without adding Better
Auth to the core package.

The current foundation release establishes the package boundary and the typed
error model used by the upcoming effectful endpoint integration. It does not
yet expose the `BetterAuth.service(...)`, `auth.api.*`, or session helpers
planned for subsequent issues.

## Installation

```bash
bun add better-effect-better-auth better-auth better-effect better-result
```

The package is ESM-only and follows the Node.js, Bun, and TypeScript support
matrix of `better-effect`. Better Auth, `better-effect`, `better-result`, and
TypeScript are peer dependencies and remain owned by the application.

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

The initial release is server-side and framework-neutral. It does not:

- create or configure a Better Auth instance;
- expose the effectful `auth.api.*` Proxy yet;
- create the `BetterAuth.service(...)` factory yet;
- choose a database adapter or run migrations;
- read environment variables;
- provide React, Vue, Svelte, or Solid client hooks;
- create a router, roles system, or authorization framework;
- map Better Auth codes automatically to application-domain failures;
- add Better Auth or framework dependencies to the `better-effect` core.

## License

MIT
