import { Effect, Layer, Runtime, Service } from 'better-effect'
import { Result } from 'better-result'
import type { Kysely } from 'kysely'
import { KyselyEffect } from 'better-effect-kysely'

import { makeSqliteDatabase, type ExampleSchema } from './sqlite-support'

const Database = KyselyEffect.service<ExampleSchema>()('@example/borrowed/Database')
const { database, native } = makeSqliteDatabase()

class DatabasePool extends Service<DatabasePool>()('@example/borrowed/DatabasePool') {
  constructor(readonly database: Kysely<ExampleSchema>) {
    super()
  }
}

const pool = new DatabasePool(database)
const runtime = await Runtime.make(
  Layer.complete(
    Layer.merge(
      Layer.succeed(DatabasePool, pool),
      Database.borrowed(function* () {
        const shared = yield* DatabasePool
        return shared.database
      })
    )
  )
)

const result = await runtime.run(
  Effect.fn(async function* () {
    const resolved = yield* Database
    yield* resolved.schema
      .createTable('users')
      .addColumn('id', 'integer', (column) => column.primaryKey())
      .addColumn('email', 'text', (column) => column.notNull())
      .$call(KyselyEffect.execute)
    return Result.ok(undefined)
  })
)

if (!Result.isOk(result)) throw result.error
await runtime.dispose()

if (native.closed) throw new Error('Runtime destroyed a borrowed database')
const rows = await database.selectFrom('users').selectAll().execute()
console.log(JSON.stringify(rows))

await database.destroy()
if (!native.closed) throw new Error('The caller did not destroy the borrowed database')
