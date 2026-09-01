import { Kysely } from 'kysely'
import { KyselyEffect } from 'better-effect-kysely'

interface ValidSchema {
  users: {
    id: number
  }
}

interface InvalidSchema {
  events: {
    id: string
  }
}

const Database = KyselyEffect.service<ValidSchema>()('@invalid/Database')
declare const invalidDatabase: Kysely<InvalidSchema>

Database.succeed(invalidDatabase)
Database.layer(() => invalidDatabase)
KyselyEffect.service<string>()('')
