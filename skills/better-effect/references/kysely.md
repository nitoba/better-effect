# Kysely integration

Package: `better-effect-kysely`. Reference:
[Kysely package](https://github.com/nitoba/better-effect/tree/main/packages/better-effect-kysely).
Kysely remains the query builder/compiler/driver boundary, not an Effect ORM.
The integration has no bundled driver.

## Native Service and explicit ownership

```ts
import { Effect } from 'better-effect'
import { Result } from 'better-result'
import { KyselyEffect } from 'better-effect-kysely'

interface AppDatabase {
  users: { id: number; email: string }
}

const Database = KyselyEffect.service<AppDatabase>()('@app/Database')
const listUsers = Effect.fn(async function* () {
  const database = yield* Database
  const users = yield* database
    .selectFrom('users')
    .select(['id', 'email'])
    .$call(KyselyEffect.execute)
  return Result.ok(users)
})
```

Provide Database using the appropriate native Kysely instance/factory:

| Provider | Owner |
| --- | --- |
| `Database.scoped(factory)` | Layer owns the created instance and calls destroy exactly once |
| `Database.borrowed(factory)` | Factory constructs/borrows a facade over externally owned resources; no destroy |
| `Database.succeed(database)` | Existing caller-owned instance; no destroy |

Factories may be contextual sync/async generators, yielding Services and
returning a **native Kysely value**. Requirements become Layer.Required.
There is no generic legacy ownership alias to guess. Keep a shared pool owned
by its own Layer if Better Auth, Kysely, and MQ all depend on it; borrowed
facades must not independently close it.

## Queries are not directly yieldable

Kysely builders stay native: no Proxy, subclass, prototype patch, or module
augmentation. Use `$call` at the terminal, preserving schema inference, native
receiver/private state, plugins, and result identity.

| Terminal | Result |
| --- | --- |
| `KyselyEffect.execute` | Complete native row array/result |
| `executeWith(options)` | Same terminal with explicit execution options |
| `executeTakeFirst` / `executeTakeFirstWith(options)` | First row or undefined |
| `executeTakeFirstOrFail(makeError)` | Map only undefined to a domain failure |
| `executeTakeFirstOrFailWith(options, makeError)` | Configured first-or-fail terminal |

Operations are lazy and invoke the native terminal once. Do not add
`Result.tryPromise`/`Result.await` around an already adapted Operation. Do not
use `executeTakeFirstOrThrow` to model expected absence. Null and undefined
have different semantics; a nullable row must not be treated as missing.
DDL and mutation builders use the same explicit terminal boundary.

`yield* KyselyEffect.executeQuery(database, query, options?)` accepts a native
RawBuilder, Compilable, or CompiledQuery and returns the complete QueryResult,
including metadata. Parameterize native SQL; keep the driver and dialect's
actual capabilities instead of interpolating unchecked input.

## Transactions do not replace the Database token

A continuation of the Database declaration above:

```ts
const createUser = (id: number, email: string) =>
  Effect.fn(async function* () {
    const database = yield* Database
    const created = yield* KyselyEffect.transaction(database, (transaction) =>
      Effect.fn(async function* () {
        const result = yield* transaction
          .insertInto('users')
          .values({ id, email })
          .$call(KyselyEffect.execute)
        return Result.ok(result)
      })
    )
    return Result.ok(created)
  })
```

Use the callback's native `transaction` for all writes intended to be atomic.
Yielding Database again still resolves the outer database. The bridge does not
install an ambient transaction or create a nested Runtime. Other application
Services remain available through the existing execution.

Result.ok commits; Result.err rolls back and preserves the same typed error
when rollback succeeds. Rollback failure is a KyselyTransactionError retaining
`.bodyFailure`. Defects and aborts retain their primary cause with documented
cleanup aggregation. Begin/commit/native transaction failures have their own
transaction error boundary. Do not collapse all cases into successful absence.

Transaction options expose native isolationLevel/accessMode. There is no
automatic retry/savepoint/controlled-transaction framework. Do not put external
HTTP/email work inside a transaction and assume rollback undoes it; use an
[outbox](mq-storage-outbox.md) with the actual native transaction resource.
A Kysely Transaction is not automatically a pg/mysql2 outbox transaction handle.

## Cancellation, tests, and security

KyselyExecutionOptions intentionally omits signal: the current Runtime supplies
one linked AbortSignal. `inflightQueryAbortStrategy` is a native driver policy
(ignore query, cancel query, kill session), not proof a server-side write did
not execute. Cancellation is cooperative and transaction commit still has a
native final-check race.

KyselyQueryError and KyselyTransactionError expose safe public fields; causes
and bodyFailure are diagnostic values, not HTTP payloads. Do not serialize
SQL, parameters, credentials, or driver errors by spreading arbitrary errors.

Test against a real selected dialect when native builder/transaction behavior
matters. Borrow a test database if the fixture owns setup and destroy; use
Layer.override for larger application tests. The package's SQLite/PGlite
coverage does not certify every MySQL/Postgres/SQLite driver combination.
Migrations, cursors/streaming, result codecs, and automatic tracing are not
added by this integration; use their actual native or focused integration APIs.
