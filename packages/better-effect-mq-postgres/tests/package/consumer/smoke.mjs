import { Layer } from 'better-effect'
import { OutboxId, validatePreparedEnqueue } from 'better-effect-mq-outbox'
import { JobScheduleStore, JobStore } from 'better-effect-mq'
import {
  PostgresJobScheduleStore,
  PostgresJobStore,
  PostgresOutbox,
  loadPostgresMigrations,
  migrationSql,
  quoteIdentifier
} from 'better-effect-mq-postgres'

const migrations = await loadPostgresMigrations()
if (migrations.length !== 5) throw new Error('Expected the shipped migrations')
if (!migrationSql(migrations[0], 'public').includes('"public"')) {
  throw new Error('Migration schema placeholder was not rendered')
}
if (quoteIdentifier('billing') !== '"billing"') throw new Error('Identifier quoting failed')

const pool = {
  connect: async () => ({
    query: async () => ({ rows: [], rowCount: 0 }),
    release: () => undefined
  })
}
const layer = PostgresJobStore.layer({ pool, validateSchema: false })
if (!(layer instanceof Layer)) throw new Error('Expected a better-effect Layer')
const Durable = JobStore.named('durable')
const DurableSchedules = JobScheduleStore.for(Durable)
const schedulesLayer = PostgresJobScheduleStore.layerFor(DurableSchedules, {
  pool,
  validateSchema: false
})
if (!(schedulesLayer instanceof Layer)) throw new Error('Expected a schedule Layer')
const request = validatePreparedEnqueue({
  protocolVersion: 1,
  identity: { queue: 'billing', name: 'send', version: 1 },
  payload: { id: 1 },
  metadata: {},
  priority: 0,
  runAt: 0,
  attemptsMax: 1,
  now: 0
}).unwrap()
if (OutboxId.make('outbox-1').isErr()) throw new Error('Outbox ID validation failed')
if (!(PostgresOutbox.named('named') && request)) throw new Error('Expected outbox API')
