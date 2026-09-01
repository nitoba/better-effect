import { Layer } from 'better-effect'
import type { Kysely } from 'kysely'
import { KyselyEffect, KyselyQueryError, KyselyTransactionError } from 'better-effect-kysely'
import type {
  KyselyExecutionOptions,
  KyselyOperation,
  KyselyQueryOperation,
  KyselyServiceInstance,
  KyselyServiceToken
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
