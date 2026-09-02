import { Effect } from 'better-effect'
import { Kysely } from 'kysely'
import { Result } from 'better-result'
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
declare const validDatabase: Kysely<ValidSchema>

Database.succeed(invalidDatabase)
Database.layer(() => invalidDatabase)
KyselyEffect.service<string>()('')
KyselyEffect.transaction(validDatabase, { isolationLevel: 'invalid' }, (_transaction) =>
  // oxlint-disable-next-line require-yield -- This negative fixture only exercises transaction option types.
  Effect.fn(async function* () {
    return Result.ok(1)
  })
)
KyselyEffect.transaction(validDatabase, (_transaction) => Promise.resolve(Result.ok(1)))
