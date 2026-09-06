import { expectTypeOf } from 'bun:test'
import { Layer } from 'better-effect'
import { OutboxStore } from 'better-effect-mq-outbox'
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
