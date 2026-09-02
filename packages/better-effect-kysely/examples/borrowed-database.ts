import { Effect, Runtime } from 'better-effect'
import { Result } from 'better-result'
import { KyselyEffect } from 'better-effect-kysely'

import { makeSqliteDatabase, type ExampleSchema } from './sqlite-support'

const Database = KyselyEffect.service<ExampleSchema>()('@example/borrowed/Database')
const { database, native } = makeSqliteDatabase()
const runtime = await Runtime.make(Database.succeed(database))

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
