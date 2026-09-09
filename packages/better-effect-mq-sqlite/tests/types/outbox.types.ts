import { expectTypeOf } from 'bun:test'
import { Layer } from 'better-effect'
import { OutboxStore, type OutboxAppendError } from 'better-effect-mq-outbox'
import { Result, type Result as ResultType } from 'better-result'
import {
  SqliteOutboxStore,
  SqliteOutboxTransactions,
  type SqliteDatabase,
  type SqliteTransaction
} from '../../src'

declare const database: SqliteDatabase
declare const input: Parameters<typeof SqliteOutboxTransactions.appendIn>[1]

const defaultLayer = SqliteOutboxStore.layer({ database, validateSchema: false })
expectTypeOf(defaultLayer).toMatchTypeOf<Layer<OutboxStore.Instance, never>>()

const named = OutboxStore.named('billing')
const namedLayer = SqliteOutboxStore.layerFor(named, { database, validateSchema: false })
expectTypeOf(namedLayer).toMatchTypeOf<Layer<OutboxStore.Instance<'billing'>, never>>()

const transaction: SqliteTransaction = database
const append = SqliteOutboxTransactions.appendIn(transaction, input)
expectTypeOf(append).toHaveProperty('isOk')

const transactionOperation = SqliteOutboxTransactions.transaction(
  database,
  input,
  (callbackDatabase) => {
    expectTypeOf(callbackDatabase).toEqualTypeOf<SqliteTransaction>()
    return Result.ok(1)
  }
)
expectTypeOf(transactionOperation).toEqualTypeOf<Promise<ResultType<number, OutboxAppendError>>>()
