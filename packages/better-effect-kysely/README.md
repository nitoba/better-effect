# better-effect-kysely

**Experimental server-side integration between `better-effect` and Kysely.**

`better-effect-kysely` adapts Kysely's native database instance to a
better-effect Service. Kysely remains the query builder, compiler, executor,
dialect boundary, and driver integration; this package does not become an ORM
or replace any native Kysely API.

## Installation

```bash
bun add better-effect-kysely better-effect better-result kysely
```

Drivers such as `better-sqlite3`, `pg`, `mysql2`, or PGlite remain explicit
application choices. They are not bundled or required by this package.

## Service and ownership

Declare a token for one database schema and choose ownership explicitly:

```ts
import { Kysely } from 'kysely'
import { KyselyEffect } from 'better-effect-kysely'

interface DatabaseSchema {
  users: {
    id: number
    email: string
  }
}

const Database = KyselyEffect.service<DatabaseSchema>()('@app/Database')

// The Runtime acquires this instance lazily and calls db.destroy() at shutdown.
const DatabaseLive = Database.layer(() => new Kysely<DatabaseSchema>({ dialect }))

// Existing instances are borrowed and are never destroyed by the Runtime.
const DatabaseTest = Database.succeed(existingDatabase)
```

The Service token is yieldable, but intentionally has no public constructible
constructor. `yield* Database` returns the original `Kysely<DatabaseSchema>`
reference with its complete native API and type inference intact. There is no
wrapper, clone, subclass, Proxy, prototype patch, or phantom property added to
the database instance.

```ts
import { Effect, Runtime } from 'better-effect'
import { Result } from 'better-result'

const program = Effect.fn(async function* () {
  const db = yield* Database
  const users = yield* db.selectFrom('users').selectAll().$call(KyselyEffect.execute)

  return Result.ok(users)
})

const runtime = await Runtime.make(DatabaseLive)
const result = await runtime.run(program)
await runtime.dispose()
```

`Database.layer` accepts synchronous or asynchronous acquisition. A provider
is acquired once per Runtime, and owned cleanup follows the normal better-effect
Scope lifecycle, including failed executions and shutdown diagnostics.

## Design boundary

The integration adapts Kysely's Promise-based execution boundary without
changing Kysely itself. Use the native `$call(...)` terminal helpers when a
query belongs in an Effect program:

- `KyselyEffect.execute` preserves the complete result of any executable query.
- `KyselyEffect.executeWith(options)` adds Kysely's non-signal options.
- `KyselyEffect.executeTakeFirst` preserves an optional first row.
- `KyselyEffect.executeTakeFirstWith(options)` is its configured form.
- `KyselyEffect.executeTakeFirstOrFail(makeError)` maps only `undefined` to a
  caller-owned typed error; its configured form is
  `executeTakeFirstOrFailWith(options, makeError)`.
- `KyselyEffect.executeQuery(database, query, options?)` executes a raw or
  compiled query and preserves the complete `QueryResult`.

Each terminal is lazy, calls the native Kysely method once, preserves its
receiver, and returns the original result reference. The terminal functions are
members of the frozen `KyselyEffect` namespace rather than prototype methods or
builder wrappers. Transaction helpers remain a separate follow-up change.

Inside an Effect generator:

```ts
import { Effect } from 'better-effect'
import { Result } from 'better-result'
import { sql } from 'kysely'

const program = Effect.fn(async function* () {
  const db = yield* Database
  const userQuery = db.selectFrom('users').selectAll()
  const missingUser = KyselyEffect.executeTakeFirstOrFail(() => new Error('user not found'))
  const user = yield* userQuery.$call(missingUser)

  const executeWithCancellation = KyselyEffect.executeWith({
    inflightQueryAbortStrategy: 'cancel query'
  })
  const users = yield* userQuery.$call(executeWithCancellation)

  const rawQuery = sql<{ id: number }>`select id from users`
  const raw = yield* KyselyEffect.executeQuery(db, rawQuery)

  return Result.ok({ user, users, raw })
})
```

There are deliberately no prototype patches, recursive Proxies, global module
augmentations, driver choices, connection creation, or import-time database
side effects.

## Operations, cancellation, and errors

The package's internal Promise boundary is represented publicly by
`KyselyOperation<A, E, R>`. Query operations use the default `R = never`; the
third channel lets a future transaction operation retain the Services required
by its lazy body without creating a nested Runtime.

`KyselyExecutionOptions` exposes Kysely's
`inflightQueryAbortStrategy` (`ignore query`, `cancel query`, or `kill session`)
but intentionally does not accept a `signal`. The active Runtime supplies the
signal at operation execution time, so callers do not create a second
controller or listener graph. Cancellation behavior remains dialect-dependent:
stopping the caller from waiting does not necessarily stop a server-side query,
and writes may already have been applied.

Promise and native transaction failures are represented by `KyselyQueryError`
and `KyselyTransactionError`. Both preserve the original `cause` in memory
while keeping it out of normal enumeration and JSON serialization. Their
messages contain no SQL, parameters, credentials, or driver-specific details;
explicit application code can inspect `cause` when that is appropriate.

## Public type aliases

The package exports `KyselyServiceInstance<Tag, DB>` and
`KyselyServiceToken<Tag, DB>`. The same aliases are available through the
`KyselyEffect` namespace as `KyselyEffect.ServiceInstance<Tag, DB>` and
`KyselyEffect.ServiceToken<Tag, DB>`; `KyselyEffect.Service<DB>` is the native
`Kysely<DB>` contract.

`KyselyOperation<A, E, R>` and `KyselyExecutionOptions` are also exported,
with the corresponding `KyselyEffect.Operation<A, E, R>` and
`KyselyEffect.ExecutionOptions` namespace aliases. `KyselyExecutable<A>` and
`KyselyTakeFirstExecutable<A>` describe the structural native terminals. The
`KyselyQueryOperation` type is the closed union of supported query boundary
names.

## License

MIT
