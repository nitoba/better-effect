import { Effect } from 'better-effect'
import { Result } from 'better-result'
import { Kysely } from 'kysely'
import { KyselyEffect } from 'better-effect-kysely'

interface DatabaseSchema {
  users: {
    id: number
    email: string
  }
}

export const Database = KyselyEffect.service<DatabaseSchema>()('@example/Database')

export const makeBorrowedLayer = (database: Kysely<DatabaseSchema>) => Database.succeed(database)

export const loadUsers = Effect.fn(async function* () {
  const database = yield* Database
  const users = yield* database.selectFrom('users').selectAll().$call(KyselyEffect.execute)

  return Result.ok(users)
})
