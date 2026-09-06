import { expectTypeOf } from 'bun:test'
import { Layer } from 'better-effect'
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
  type Pool
} from '../../src'

const pool: Pool = {
  getConnection: async () => {
    throw new Error('type-only pool')
  }
}
const named = OutboxStore.named('types')
const defaultLayer = MySqlOutboxStore.layer({ pool, validateSchema: false })
const namedLayer = MySqlOutboxStore.layerFor(named, { pool, validateSchema: false })

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

void defaultLayer
void namedLayer
