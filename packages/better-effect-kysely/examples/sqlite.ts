import { Effect, Runtime } from 'better-effect'
import { Result } from 'better-result'
import { KyselyEffect } from 'better-effect-kysely'

import { makeSqliteDatabase, type ExampleSchema } from './sqlite-support'

const Database = KyselyEffect.service<ExampleSchema>()('@example/sqlite/Database')
const { database, native } = makeSqliteDatabase()
const runtime = await Runtime.make(Database.layer(() => database))

try {
  const result = await runtime.run(
    Effect.fn(async function* () {
      const resolved = yield* Database
      yield* resolved.schema
        .createTable('users')
        .addColumn('id', 'integer', (column) => column.primaryKey())
        .addColumn('email', 'text', (column) => column.notNull())
        .$call(KyselyEffect.execute)
      const inserted = yield* resolved
        .insertInto('users')
        .values({ id: 1, email: 'ada@example.test' })
        .returningAll()
        .$call(KyselyEffect.execute)
      const users = yield* resolved.selectFrom('users').selectAll().$call(KyselyEffect.execute)

      return Result.ok({ inserted, users })
    })
  )

  if (!Result.isOk(result)) throw result.error
  console.log(JSON.stringify(result.value))
} finally {
  await runtime.dispose()
}

if (!native.closed) throw new Error('The owned SQLite database was not closed')
