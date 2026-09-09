import { expectTypeOf } from 'bun:test'
import { Layer } from 'better-effect'
import { Result } from 'better-result'
import type { Result as ResultType } from 'better-result'
import type {
  OutboxAppendError,
  OutboxAppendResult,
  OutboxEffect,
  OutboxRecord
} from 'better-effect-mq-outbox'

import {
  MySqlOutbox,
  MySqlOutboxStore,
  OutboxStore,
  type MySqlOutboxAppendOptions,
  type MySqlOutboxTransaction,
  type Pool,
  type PoolConnection
} from '../../src'

const pool: Pool = {
  getConnection: async () => {
    throw new Error('type-only pool')
  }
}
const named = OutboxStore.named('types')
const defaultLayer = MySqlOutboxStore.layer({ pool, validateSchema: false })
const namedLayer = MySqlOutboxStore.layerFor(named, { pool, validateSchema: false })
declare const input: OutboxRecord

expectTypeOf(named.serviceTag).toEqualTypeOf<'@better-effect/mq/OutboxStore/types'>()
expectTypeOf(defaultLayer).toMatchTypeOf<Layer<OutboxStore.Instance, never>>()
expectTypeOf(namedLayer).toMatchTypeOf<Layer<OutboxStore.Instance<'types'>, never>>()
expectTypeOf(MySqlOutbox.appendIn).toMatchTypeOf<
  (
    connection: MySqlOutboxTransaction,
    input: OutboxRecord,
    options?: MySqlOutboxAppendOptions
  ) => Promise<OutboxEffect<OutboxAppendResult, OutboxAppendError>>
>()

const transactional = MySqlOutbox.transaction(pool, input, (connection) => {
  expectTypeOf(connection).toEqualTypeOf<PoolConnection>()
  return Result.ok('saved')
})

expectTypeOf(MySqlOutbox.transaction).toMatchTypeOf<
  (
    pool: Pool,
    input: OutboxRecord,
    callback: (connection: PoolConnection) => ResultType<string, never>,
    options?: MySqlOutboxAppendOptions
  ) => Promise<ResultType<string, OutboxAppendError>>
>()
expectTypeOf(transactional).toEqualTypeOf<Promise<ResultType<string, OutboxAppendError>>>()

void defaultLayer
void namedLayer
void transactional
