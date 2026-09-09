// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- placeholders are type-only contract values.

import { expectTypeOf } from 'bun:test'
import type { Layer } from 'better-effect'
import type {
  OutboxAppendError,
  OutboxAppendResult,
  OutboxEffect,
  OutboxRecord
} from 'better-effect-mq-outbox'

import {
  MongoOutbox,
  MongoOutboxStore,
  OutboxStore,
  type MongoClient,
  type MongoDb,
  type MongoOutboxAppendOptions,
  type MongoOutboxTransactionBody,
  type MongoOutboxTransactionOptions,
  type MongoOutboxTransaction,
  type MongoJobStoreConfig
} from '../../src'

const db = {} as MongoDb
const config: MongoJobStoreConfig = { db, validateLayout: false }
const named = OutboxStore.named('types')

const defaultLayer = MongoOutboxStore.layer(config)
const namedLayer = MongoOutboxStore.layerFor(named, config)

expectTypeOf(defaultLayer).toMatchTypeOf<Layer<OutboxStore.Instance, never>>()
expectTypeOf(namedLayer).toMatchTypeOf<Layer<OutboxStore.Instance<'types'>, never>>()
expectTypeOf(MongoOutbox.appendIn).toMatchTypeOf<
  (
    session: MongoOutboxTransaction,
    record: OutboxRecord,
    options: MongoOutboxAppendOptions
  ) => Promise<OutboxEffect<OutboxAppendResult, OutboxAppendError>>
>()
expectTypeOf(MongoOutbox.transaction).toMatchTypeOf<
  <Value>(
    clientOrDb: MongoClient | MongoDb,
    record: OutboxRecord,
    body: MongoOutboxTransactionBody<Value>,
    options?: MongoOutboxTransactionOptions
  ) => Promise<Value>
>()

void defaultLayer
void namedLayer
