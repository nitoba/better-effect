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
  const users = yield* Result.await(db.selectFrom('users').selectAll().execute())

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
changing Kysely itself. Query terminal helpers using `$call(...)`, raw and
compiled query execution, cancellation, and transactions are introduced by
follow-up package changes.

There are deliberately no prototype patches, recursive Proxies, global module
augmentations, driver choices, connection creation, or import-time database
side effects.

## Public type aliases

The package exports `KyselyServiceInstance<Tag, DB>` and
`KyselyServiceToken<Tag, DB>`. The same aliases are available through the
`KyselyEffect` namespace as `KyselyEffect.ServiceInstance<Tag, DB>` and
`KyselyEffect.ServiceToken<Tag, DB>`; `KyselyEffect.Service<DB>` is the native
`Kysely<DB>` contract.

## License

MIT
