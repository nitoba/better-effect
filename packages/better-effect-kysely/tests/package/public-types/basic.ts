import { Effect, Layer } from 'better-effect'
import { sql } from 'kysely'
import type { CompiledQuery, Kysely, QueryResult, Transaction } from 'kysely'
import { KyselyEffect, KyselyQueryError, KyselyTransactionError } from 'better-effect-kysely'
import { Result } from 'better-result'
import type {
  KyselyExecutionOptions,
  KyselyOperation,
  KyselyQueryOperation,
  KyselyServiceInstance,
  KyselyServiceToken,
  KyselyTransactionOptions
} from 'better-effect-kysely'

type Assert<Condition extends true> = Condition
type Equal<Left, Right> =
  (<Type>() => Type extends Left ? 1 : 2) extends <Type>() => Type extends Right ? 1 : 2
    ? true
    : false

interface UserTable {
  id: number
  email: string
}

interface DatabaseSchema {
  users: UserTable
}

const Database = KyselyEffect.service<DatabaseSchema>()('@consumer/Database')
declare const database: Kysely<DatabaseSchema>

type Instance = KyselyServiceInstance<'@consumer/Database', DatabaseSchema>
type _PublicToken = Assert<
  Equal<typeof Database, KyselyEffect.ServiceToken<'@consumer/Database', DatabaseSchema>>
>
type _NamedToken = Assert<
  Equal<typeof Database, KyselyServiceToken<'@consumer/Database', DatabaseSchema>>
>
type _ServiceContract = Assert<Equal<KyselyEffect.Service<DatabaseSchema>, Kysely<DatabaseSchema>>>
type _OfInstance = Assert<Equal<ReturnType<typeof Database.of>, Instance>>
type _LayerProvided = Assert<Equal<Layer.Provided<ReturnType<typeof Database.layer>>, Instance>>
type _LayerRequired = Assert<Equal<Layer.Required<ReturnType<typeof Database.layer>>, never>>
type _BorrowedProvided = Assert<
  Equal<Layer.Provided<ReturnType<typeof Database.succeed>>, Instance>
>
type _BorrowedRequired = Assert<Equal<Layer.Required<ReturnType<typeof Database.succeed>>, never>>

const query = database.selectFrom('users').select(['id', 'email'])
type Rows = Awaited<ReturnType<typeof query.execute>>
type _Rows = Assert<Equal<Rows, Array<{ id: number; email: string }>>>
const executeOperation = query.$call(KyselyEffect.execute)
const executeWithOperation = query.$call(
  KyselyEffect.executeWith({ inflightQueryAbortStrategy: 'cancel query' })
)
const firstOperation = query.$call(KyselyEffect.executeTakeFirst)
class MissingUser extends Error {}
const firstOrFailOperation = query.$call(
  KyselyEffect.executeTakeFirstOrFail(() => new MissingUser())
)
declare const compiledQuery: CompiledQuery<UserTable>
const rawOperation = KyselyEffect.executeQuery(database, compiledQuery)
const rawBuilderOperation = KyselyEffect.executeQuery(
  database,
  sql<{ value: number }>`select 1 as value`
)
declare const nativeTransaction: Transaction<DatabaseSchema>
const transactionRawOperation = KyselyEffect.executeQuery(nativeTransaction, compiledQuery)
type _Execute = Assert<Equal<typeof executeOperation, KyselyOperation<Rows, KyselyQueryError>>>
type _ExecuteWith = Assert<
  Equal<typeof executeWithOperation, KyselyOperation<Rows, KyselyQueryError>>
>
type _First = Assert<
  Equal<typeof firstOperation, KyselyOperation<UserTable | undefined, KyselyQueryError>>
>
type _FirstOrFail = Assert<
  Equal<typeof firstOrFailOperation, KyselyOperation<UserTable, MissingUser | KyselyQueryError>>
>
type _Raw = Assert<
  Equal<typeof rawOperation, KyselyOperation<QueryResult<UserTable>, KyselyQueryError>>
>
type _RawBuilder = Assert<
  Equal<
    typeof rawBuilderOperation,
    KyselyOperation<QueryResult<{ value: number }>, KyselyQueryError>
  >
>
type _TransactionRaw = Assert<
  Equal<typeof transactionRawOperation, KyselyOperation<QueryResult<UserTable>, KyselyQueryError>>
>
const assertTransaction = (transaction: Transaction<DatabaseSchema>): void => {
  void transaction
}
const transactionOperation = KyselyEffect.transaction(database, (transaction) => {
  assertTransaction(transaction)
  // oxlint-disable-next-line require-yield -- This fixture checks a pure transaction Program type.
  return Effect.fn(async function* () {
    const rows = yield* transaction.selectFrom('users').selectAll().$call(KyselyEffect.execute)
    return Result.ok(rows)
  })
})
type _Transaction = Assert<
  Equal<
    typeof transactionOperation,
    KyselyOperation<UserTable[], KyselyQueryError | KyselyTransactionError>
  >
>
const configuredTransaction = KyselyEffect.transaction(
  database,
  { isolationLevel: 'serializable', accessMode: 'read write' } satisfies KyselyTransactionOptions,
  (_transaction) =>
    // oxlint-disable-next-line require-yield -- This fixture checks a pure transaction Program type.
    Effect.fn(async function* () {
      return Result.ok(1)
    })
)
type _ConfiguredTransaction = Assert<
  Equal<typeof configuredTransaction, KyselyOperation<number, KyselyTransactionError>>
>
type _TransactionOptions = Assert<Equal<KyselyEffect.TransactionOptions, KyselyTransactionOptions>>
type _Operation = Assert<
  Equal<KyselyEffect.Operation<number, KyselyQueryError>, KyselyOperation<number, KyselyQueryError>>
>
type _Strategy = Assert<
  Equal<
    NonNullable<KyselyExecutionOptions['inflightQueryAbortStrategy']>,
    'ignore query' | 'cancel query' | 'kill session'
  >
>
type _QueryOperation = Assert<
  Equal<KyselyQueryOperation, 'execute' | 'executeTakeFirst' | 'executeQuery'>
>

const queryError = new KyselyQueryError({
  cause: new Error('driver failure'),
  operation: 'execute'
})
const transactionError = new KyselyTransactionError({ cause: new Error('native failure') })

type _QueryErrorJson = Assert<
  Equal<
    ReturnType<typeof queryError.toJSON>,
    {
      readonly _tag: 'KyselyQueryError'
      readonly name: 'KyselyQueryError'
      readonly message: string
      readonly operation: KyselyQueryOperation
    }
  >
>
type _TransactionErrorJson = Assert<
  Equal<
    ReturnType<typeof transactionError.toJSON>,
    {
      readonly _tag: 'KyselyTransactionError'
      readonly name: 'KyselyTransactionError'
      readonly message: string
    }
  >
>

// @ts-expect-error the generated token has no public constructor
new Database()

const SameNamedToken = KyselyEffect.service<DatabaseSchema>()('@consumer/Database')
type _LiteralTag = Assert<Equal<typeof SameNamedToken.serviceTag, '@consumer/Database'>>

void database
void query
void SameNamedToken
void transactionRawOperation
