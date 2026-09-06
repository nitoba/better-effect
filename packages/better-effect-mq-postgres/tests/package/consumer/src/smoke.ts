import { Effect } from 'better-effect'
import type { Layer } from 'better-effect'
import { Result } from 'better-result'
import type { OutboxAppendResult, OutboxRecord } from 'better-effect-mq-outbox'
import type { PoolClient } from 'better-effect-mq-postgres'
import { PostgresOutbox } from 'better-effect-mq-postgres'
import type {
  PostgresOutboxInstance,
  PostgresOutboxStore,
  PostgresOutboxTag,
  PostgresOutboxToken
} from 'better-effect-mq-postgres'

declare const pool: Parameters<typeof PostgresOutbox.layer>[0]['pool']
declare const transaction: PoolClient
declare const record: OutboxRecord
declare const store: PostgresOutboxStore

const named = PostgresOutbox.named('emails')
const namedToken: PostgresOutboxToken<'emails'> = named
const namedTag: PostgresOutboxTag<'emails'> = named.serviceTag
const defaultLayer: Layer<InstanceType<typeof PostgresOutbox>, never> = PostgresOutbox.layer({
  pool,
  validateSchema: false
})
const namedLayer: Layer<InstanceType<typeof named>, never> = PostgresOutbox.layerFor(named, {
  pool,
  validateSchema: false
})
const appended: Promise<OutboxAppendResult> = PostgresOutbox.appendIn(transaction, record)
const defaultProgram = Effect.gen(async function* () {
  const resolved = yield* PostgresOutbox
  const exact: PostgresOutboxStore = resolved
  return Result.ok(exact)
})
const namedProgram = Effect.gen(async function* () {
  const resolved = yield* named
  const exact: PostgresOutboxInstance<'emails'> = resolved
  return Result.ok(exact)
})

void namedToken
void namedTag
void defaultLayer
void namedLayer
void appended
void defaultProgram
void namedProgram
void store
