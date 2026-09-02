import { KyselyEffect, KyselyQueryError, KyselyTransactionError } from 'better-effect-kysely'
import type {
  KyselyExecutionOptions,
  KyselyOperation,
  KyselyServiceToken,
  KyselyTransactionOptions
} from 'better-effect-kysely'

const executionOptions: KyselyExecutionOptions = {
  inflightQueryAbortStrategy: 'ignore query'
}
const transactionOptions: KyselyTransactionOptions = {
  isolationLevel: 'serializable',
  accessMode: 'read write'
}

type ExpectedToken = KyselyServiceToken<'@import/Database', { users: { id: number } }>
declare const operation: KyselyOperation<number, KyselyQueryError>
declare const token: ExpectedToken

void KyselyEffect
void KyselyQueryError
void KyselyTransactionError
void executionOptions
void transactionOptions
void operation
void token
