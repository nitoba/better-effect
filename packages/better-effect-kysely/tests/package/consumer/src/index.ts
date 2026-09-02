import { Effect, Layer, Runtime, ServiceRuntime } from 'better-effect'
import { Result } from 'better-result'
import { Kysely } from 'kysely'
import type { CompiledQuery, QueryResult } from 'kysely'
import { KyselyEffect } from 'better-effect-kysely'
import type {
  KyselyOperation,
  KyselyQueryError,
  KyselyServiceInstance,
  KyselyServiceToken,
  KyselyTransactionError
} from 'better-effect-kysely'

interface DatabaseSchema {
  users: {
    id: number
    email: string
  }
}

const Database = KyselyEffect.service<DatabaseSchema>()('@external/Database')
declare const database: Kysely<DatabaseSchema>

type ExpectedInstance = KyselyServiceInstance<'@external/Database', DatabaseSchema>
expectToken(Database)
expectInstance(Database.of(database))
expectLayer(Database.layer(() => database))
expectLayer(Database.succeed(database))
const query = database.selectFrom('users').selectAll()
const executeOperation: KyselyOperation<DatabaseSchema['users'][], KyselyQueryError> = query.$call(
  KyselyEffect.execute
)
const firstOperation: KyselyOperation<DatabaseSchema['users'] | undefined, KyselyQueryError> =
  query.$call(KyselyEffect.executeTakeFirst)
declare const rawQuery: CompiledQuery<DatabaseSchema['users']>
const rawOperation: KyselyOperation<
  QueryResult<DatabaseSchema['users']>,
  KyselyQueryError
> = KyselyEffect.executeQuery(database, rawQuery)
const transactionOperation: KyselyOperation<number, KyselyTransactionError> =
  KyselyEffect.transaction(database, (_transaction) =>
    // oxlint-disable-next-line require-yield -- This consumer fixture checks a pure transaction Program type.
    Effect.fn(async function* () {
      return Result.ok(1)
    })
  )

void KyselyEffect.service
void KyselyEffect.transaction
void transactionOperation
void executeOperation
void firstOperation
void rawOperation

function expectToken(token: KyselyServiceToken<'@external/Database', DatabaseSchema>): void {
  void token
}

function expectInstance(instance: ExpectedInstance): void {
  void instance
}

function expectLayer(layer: Layer<ExpectedInstance, never>): void {
  void layer
}

const program = async () => ServiceRuntime.resolve(Database)
void Runtime.make(Database.succeed(database)).then((runtime) => runtime.run(program))
