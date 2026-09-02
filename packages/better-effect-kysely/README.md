# better-effect-kysely

`better-effect-kysely` is a small, server-side integration between
[`better-effect`](https://github.com/nitoba/better-effect) and
[Kysely](https://kysely.dev/). Kysely remains the type-safe SQL query builder,
compiler, executor and dialect boundary. This package is not an ORM,
repository framework or replacement for Kysely.

## What it is

The integration turns Kysely's Promise-based query terminals into lazy
`better-effect` Operations while preserving the native Kysely instance,
builders, plugins, logging and driver behavior:

```text
Kysely builder
    ↓ .$call(KyselyEffect.execute)
Kysely operation
    ↓ Runtime executes one lazy Promise
better-result Result
    ↓
Effect Program with typed Service requirements
```

The package adds no driver. Install the dialect and driver your application
chooses. The release validation uses Bun's built-in SQLite adapter and PGlite;
that evidence validates the Kysely boundary, but does not certify every
PostgreSQL, MySQL or SQLite driver combination.

## Why this design

Kysely builders are deliberately not Effects. They are immutable query
expressions with native Promise terminals, so `$call` is the explicit place
where a Program crosses into asynchronous execution. Keeping that boundary
small preserves Kysely's receiver, private state, plugins, logging and dialect
behavior. The package therefore avoids Proxy wrappers, prototype patches,
module augmentation and a second query instruction tree.

## Installation

Install the integration, its peers and one Kysely dialect driver:

```bash
bun add better-effect-kysely better-effect better-result kysely
# Add the driver selected by your dialect, for example:
bun add better-sqlite3
```

`better-effect-kysely` has no runtime dependencies. Its peer requirements are:

| Peer            | Supported range    |
| --------------- | ------------------ |
| `better-effect` | `>=0.13.0 <0.14.0` |
| `better-result` | `^3.0.0`           |
| `kysely`        | `>=0.29.5 <0.30.0` |
| TypeScript      | `>=5.7.0`          |

Drivers are application dependencies, not package dependencies. The package
entrypoint can be imported without installing a database driver.

## Define a database Service

`KyselyEffect.service` creates a yieldable Service token for one database
schema. The value resolved from the token is the original `Kysely<DB>` object;
there is no wrapper, clone, subclass, Proxy, prototype patch or module
augmentation.

```ts
import { KyselyEffect } from 'better-effect-kysely'

interface AppDatabase {
  users: {
    id: number
    email: string
  }
}

const Database = KyselyEffect.service<AppDatabase>()('@app/Database')
```

Use the token in a `better-effect` Program:

```ts
import { Effect } from 'better-effect'
import { Result } from 'better-result'

const listUsers = Effect.fn(async function* () {
  const database = yield* Database
  const users = yield* database
    .selectFrom('users')
    .select(['id', 'email'])
    .$call(KyselyEffect.execute)

  return Result.ok(users)
})
```

The `Database` token retains the exact schema inference. A query is not itself
yieldable: use one of the explicit `$call` terminals described below.

## Owned and borrowed lifecycle

Choose ownership when defining the Layer:

| Helper                           | Runtime behavior                                              | Who calls `destroy()`?       |
| -------------------------------- | ------------------------------------------------------------- | ---------------------------- |
| `Database.layer(() => database)` | Acquires lazily and owns the Kysely instance                  | Runtime root during shutdown |
| `Database.succeed(database)`     | Provides an existing instance without acquiring or closing it | The caller                   |

An owned Layer is useful when the application creates the database as part of
its composition root. A borrowed Layer is useful for tests, a host-managed
pool, or an instance shared by another subsystem. Do not use `succeed` for a
resource the Runtime must close, and do not use `layer` when the caller still
owns the resource.

```ts
import { Runtime } from 'better-effect'

const ownedRuntime = await Runtime.make(Database.layer(() => database))
await ownedRuntime.dispose() // calls database.destroy()

const borrowedRuntime = await Runtime.make(Database.succeed(database))
await borrowedRuntime.dispose() // leaves database usable
await database.destroy() // caller cleanup
```

`layer` acquisition is lazy and occurs once per Runtime. Cleanup follows the
normal root `Scope`, including shutdown after failed executions. The native
Kysely instance and its private state remain untouched.

## Execute queries

The public terminal namespace is frozen and its functions are intended for
Kysely's native `$call` method:

| Terminal                                                      | Success value                                    |
| ------------------------------------------------------------- | ------------------------------------------------ |
| `KyselyEffect.execute`                                        | Complete array returned by `query.execute()`     |
| `KyselyEffect.executeWith(options)`                           | Same, with Kysely execution options              |
| `KyselyEffect.executeTakeFirst`                               | First row or `undefined`                         |
| `KyselyEffect.executeTakeFirstWith(options)`                  | First row or `undefined`, configured             |
| `KyselyEffect.executeTakeFirstOrFail(makeError)`              | First row, or the caller's error for `undefined` |
| `KyselyEffect.executeTakeFirstOrFailWith(options, makeError)` | Configured first-row-or-fail                     |

All terminals are lazy, invoke the native terminal once and preserve the
native receiver and result reference:

```ts
const users = yield * database.selectFrom('users').selectAll().$call(KyselyEffect.execute)

const optionalUser =
  yield *
  database
    .selectFrom('users')
    .selectAll()
    .where('id', '=', userId)
    .$call(KyselyEffect.executeTakeFirst)

const user =
  yield *
  database
    .selectFrom('users')
    .selectAll()
    .where('id', '=', userId)
    .$call(KyselyEffect.executeTakeFirstOrFail(() => new UserNotFound(userId)))
```

The `executeTakeFirstOrFail` helpers map only strict `undefined` to
`makeError`. A nullable row value remains a successful row.

DDL and mutations use the same terminal. `returningAll()` retains the
native dialect result:

```ts
yield *
  database.schema
    .createTable('users')
    .addColumn('id', 'integer', (column) => column.primaryKey())
    .addColumn('email', 'text', (column) => column.notNull())
    .$call(KyselyEffect.execute)

const inserted =
  yield *
  database
    .insertInto('users')
    .values({ id: 1, email: 'ada@example.test' })
    .returningAll()
    .$call(KyselyEffect.execute)
```

`KyselyExecutionOptions` exposes Kysely's
`inflightQueryAbortStrategy` (`ignore query`, `cancel query` or `kill session`).
It intentionally has no `signal`: the active Runtime supplies one fresh
linked signal for each execution.

## Read one row

`executeTakeFirst` returns `A | undefined` without inventing an application
error. Use `executeTakeFirstOrFail` when absence is a domain failure:

```ts
class UserNotFound extends Error {
  constructor(readonly userId: number) {
    super(`User ${userId} was not found`)
  }
}

const user =
  yield *
  database
    .selectFrom('users')
    .selectAll()
    .where('id', '=', userId)
    .$call(KyselyEffect.executeTakeFirstOrFail(() => new UserNotFound(userId)))
```

This is different from Kysely's `executeTakeFirstOrThrow`: the failure is an
Effect/Result error and can be handled by the caller without turning the
absence into an uncaught defect.

## Raw and compiled queries

`KyselyEffect.executeQuery(database, query, options?)` accepts a native
`RawBuilder`, a structural `Compilable` or a `CompiledQuery` and returns the
complete Kysely `QueryResult`, including rows and dialect metadata:

```ts
import { sql } from 'kysely'

const raw =
  yield * KyselyEffect.executeQuery(database, sql<{ value: number }>`select ${1} as value`)

const compiled = database
  .selectFrom('users')
  .select(['id', 'email'])
  .where('id', '=', userId)
  .compile()
const result = yield * KyselyEffect.executeQuery(database, compiled)
```

Genuine RawBuilders use Kysely's native RawBuilder executor, so raw-builder
plugins and result transformation still run once. Compiled queries retain
their original SQL and parameters; the bridge does not compile them again.
The overload also accepts a native `Transaction<DB>` as the executor.

## Transactions

`KyselyEffect.transaction` takes a Kysely instance and a lazy Program factory.
Kysely begins the native transaction before invoking the factory, and the
factory receives the native `Transaction<DB>` instance. The transaction does
not replace the outer Database Service and does not create a nested Runtime.

```ts
const createUser = Effect.fn(async function* () {
  const database = yield* Database

  const user = yield* KyselyEffect.transaction(database, (transaction) =>
    Effect.fn(async function* () {
      const created = yield* transaction
        .insertInto('users')
        .values({ id: 1, email: 'ada@example.test' })
        .returningAll()
        .$call(KyselyEffect.executeTakeFirstOrFail(() => new Error('insert returned no row')))

      return Result.ok(created)
    })
  )

  return Result.ok(user)
})
```

The body result determines the native transaction outcome:

| Body outcome                         | Native action       | Caller observes                                                                                       |
| ------------------------------------ | ------------------- | ----------------------------------------------------------------------------------------------------- |
| `Result.ok(value)`                   | Commit              | The original `value`                                                                                  |
| `Result.err(error)`                  | Roll back           | The same typed `error` if rollback succeeds; otherwise a `KyselyTransactionError` with `.bodyFailure` |
| Thrown/rejected defect               | Roll back           | The original defect, or an aggregate with cleanup failure                                             |
| Aborted Runtime signal               | Roll back           | The original abort reason, or an aggregate with cleanup failure                                       |
| Native begin/commit/rollback failure | Best-effort cleanup | `KyselyTransactionError` when no more primary failure exists                                          |

Every `Result.err` from the body rolls back, including a query operation error.
When rollback succeeds, the exact typed error is restored. If rollback itself
fails, the result is a `KyselyTransactionError` and the original body failure
is retained as its non-enumerable `.bodyFailure`. Defects and abort reasons are
re-thrown (with body-first aggregate composition when cleanup also fails). The
body may yield other Services from the existing Runtime. Optional
`KyselyTransactionOptions` forwards Kysely's native `isolationLevel` and
`accessMode` only.

Cancellation is checked before transaction creation, after the body succeeds
and immediately before returning success. The public Kysely callback API still
has an unavoidable final check-to-commit race. There is no automatic retry,
savepoint or controlled-transaction policy.

## Cancellation

Runtime cancellation is cooperative. Pass an `AbortSignal` to the Runtime
execution; the query operation receives the linked signal through Kysely's
native options:

```ts
const result = await runtime.run(listUsers, { signal: request.signal })
```

`cancel query` and `kill session` are driver/dialect capabilities, not
universal guarantees. `ignore query` stops waiting according to Kysely's
policy but does not necessarily stop server-side work. A write may have been
applied before cancellation is observed. Inspect `KyselyQueryError.cause`
when an application needs driver-specific cancellation details.

## Errors and security

The bridge exposes two safe boundary errors:

- `KyselyQueryError` for Promise/query failures;
- `KyselyTransactionError` for native transaction or cleanup failures.

The original cause is available in memory as `.cause`, but is non-enumerable
and excluded from `toJSON()`. Messages and serialized fields do not include SQL,
parameters, credentials or driver-specific details. Applications should map
`cause` deliberately at a trusted diagnostic boundary rather than adding it to
HTTP responses or structured logs by default.

Typed domain errors returned by `executeTakeFirstOrFail` or a transaction body
remain application errors. When cleanup succeeds, they remain the primary
failure. A typed body failure plus rollback failure is represented by
`KyselyTransactionError.bodyFailure`; defects and abort reasons are composed
body-first with the native cleanup failure. A successful operation exposes a
cleanup failure instead of its value.

## Multiple databases

Give separate database schemas distinct literal tags, then compose their
Layers. The resolved values retain independent Kysely identities:

```ts
const PrimaryDatabase = KyselyEffect.service<PrimarySchema>()('@app/PrimaryDatabase')
const AnalyticsDatabase = KyselyEffect.service<AnalyticsSchema>()('@app/AnalyticsDatabase')

const AppLive = Layer.merge(
  PrimaryDatabase.layer(createPrimaryDatabase),
  AnalyticsDatabase.layer(createAnalyticsDatabase)
)
```

A duplicate tag is rejected by Layer composition. Use distinct tags even when
two schemas happen to have the same shape.

## Testing

Use a borrowed in-memory database when the test owns setup and cleanup:

```ts
const database = makeTestDatabase()
const runtime = await Runtime.make(Database.succeed(database))

try {
  const result = await runtime.run(listUsers)
  // Assert Result and native Kysely rows here.
} finally {
  await runtime.dispose()
  await database.destroy()
}
```

Prefer a real dialect for integration coverage. Use `Layer.override` to replace
only the database Service when testing a larger application composition. The
package's own validation covers Bun SQLite and PGlite, while PostgreSQL,
MySQL and SQLite Kysely type surfaces are checked without external servers.
Do not mock every Kysely builder when the behavior under test is the native
query compiler or driver boundary.

## Compatibility

The `0.1.x` line is tested with:

- Bun `1.3.14` and Node.js `24`;
- TypeScript `5.7.2` and the current repository compiler;
- Kysely `0.29.5` (the minimum and current tested version in this release);
- Bun's built-in SQLite adapter and PGlite `0.5.8` for real database tests;
- `better-sqlite3` `12.4.1` in the external Node.js consumer cell (the Bun
  consumer cell uses Bun's built-in adapter because `better-sqlite3` is not
  supported by Bun).

The package is dialect-agnostic at runtime and has no bundled driver. The
validation matrix does not mean that every external driver, server version or
cancellation mechanism has identical behavior.

## Non-goals and roadmap

The `0.1.x` integration intentionally does not provide:

- migrations or schema management beyond using Kysely's own schema builder;
- streaming or cursor abstractions;
- controlled transactions, savepoints or automatic retries;
- OpenTelemetry/RuntimeObserver integration;
- schema codecs or runtime result validation;
- a repository, ORM or data-access framework;
- directly yieldable Kysely builders.

Use native Kysely APIs or a focused application adapter for those concerns.

## API reference

| Export                      | Kind              | Contract                                                                   |
| --------------------------- | ----------------- | -------------------------------------------------------------------------- |
| `KyselyEffect`              | runtime namespace | Service factory, lazy `$call` terminals, `executeQuery` and `transaction`  |
| `KyselyOperation`           | type              | `better-effect` Operation carrying a value, error and Service requirements |
| `KyselyExecutionOptions`    | type              | Kysely query abort-strategy options, without `signal`                      |
| `KyselyTransactionOptions`  | type              | Native `isolationLevel` and `accessMode` options                           |
| `KyselyQueryOperation`      | type              | Supported query boundary names for diagnostics                             |
| `KyselyServiceInstance`     | type              | Branded native `Kysely<DB>` instance contract                              |
| `KyselyServiceToken`        | type              | Service token for a tagged Kysely schema                                   |
| `KyselyService`             | type              | Native `Kysely<DB>` service contract                                       |
| `KyselyExecutable`          | type              | Structural native execute terminal                                         |
| `KyselyTakeFirstExecutable` | type              | Structural native first-row terminal                                       |
| `KyselyQueryError`          | runtime class     | Safe query failure with an in-memory `cause`                               |
| `KyselyTransactionError`    | runtime class     | Safe transaction/cleanup failure with an in-memory `cause`                 |

Runtime helpers are namespaced under `KyselyEffect` so the package has one
explicit integration boundary. Type aliases are also exported at the root for
consumer signatures and are mirrored under `KyselyEffect` where useful.

See the executable examples in [`examples/`](./examples) and the deeper
integration guide at [`/docs/kysely`](https://better-effect.nitodev.com.br/docs/kysely).

## License

MIT
