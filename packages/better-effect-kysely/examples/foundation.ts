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
