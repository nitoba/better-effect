import { Effect, Runtime } from 'better-effect'
import { Result, TaggedError } from 'better-result'
import { KyselyEffect } from 'better-effect-kysely'

import { makeSqliteDatabase, type ExampleSchema } from './sqlite-support'

class RollbackRequested extends TaggedError('RollbackRequested')<{
  readonly message: string
}> {}

const Database = KyselyEffect.service<ExampleSchema>()('@example/transactions/Database')
const { database, native } = makeSqliteDatabase()
const runtime = await Runtime.make(Database.layer(() => database))

try {
  const committed = await runtime.run(
    Effect.fn(async function* () {
      const resolved = yield* Database
      yield* resolved.schema
        .createTable('users')
        .addColumn('id', 'integer', (column) => column.primaryKey())
        .addColumn('email', 'text', (column) => column.notNull())
        .$call(KyselyEffect.execute)

      const inserted = yield* KyselyEffect.transaction(resolved, (transaction) =>
        Effect.fn(async function* () {
          const rows = yield* transaction
            .insertInto('users')
            .values({ id: 1, email: 'committed@example.test' })
            .returningAll()
            .$call(KyselyEffect.execute)
          return Result.ok(rows)
        })
      )

      return Result.ok(inserted)
    })
  )

  if (!Result.isOk(committed)) throw committed.error

  const rolledBack = await runtime.run(
    Effect.fn(async function* () {
      const resolved = yield* Database
      yield* KyselyEffect.transaction(resolved, (transaction) =>
        Effect.fn(async function* () {
          yield* transaction
            .insertInto('users')
            .values({ id: 2, email: 'rolled-back@example.test' })
            .$call(KyselyEffect.execute)
          return Result.err(new RollbackRequested({ message: 'the caller requested a rollback' }))
        })
      )
      return Result.ok('unreachable')
    })
  )

  if (!Result.isError(rolledBack) || !(rolledBack.error instanceof RollbackRequested)) {
    throw new Error('The transaction did not preserve the typed rollback error')
  }

  const users = await database.selectFrom('users').selectAll().execute()
  if (users.length !== 1 || users[0]?.email !== 'committed@example.test') {
    throw new Error('The transaction example did not roll back the failed write')
  }
  console.log(JSON.stringify({ committed: committed.value, users }))
} finally {
  await runtime.dispose()
}

if (!native.closed) throw new Error('The owned transaction database was not closed')
