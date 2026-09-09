import { Layer } from 'better-effect'
import {
  MySqlOutbox,
  MySqlOutboxStore,
  MySqlJobEventStore,
  MySqlJobScheduleStore,
  MySqlJobStore,
  loadMySqlMigrations,
  OutboxStore,
  quoteIdentifier
} from 'better-effect-mq-mysql'

const migrations = await loadMySqlMigrations()
if (
  migrations.length !== 7 ||
  !migrations[0]!.sql.includes('ENGINE=InnoDB') ||
  !migrations[1]!.sql.includes('dedupe_hash') ||
  !migrations[2]!.sql.includes('better_effect_mq_schedules') ||
  !migrations[3]!.sql.includes('better_effect_mq_outbox') ||
  !migrations[4]!.sql.includes('better_effect_mq_flow_children') ||
  !migrations[6]!.sql.includes('better_effect_mq_job_events')
) {
  throw new Error('Expected the initial InnoDB migration and forward-only upgrades')
}
if (quoteIdentifier('billing') !== '`billing`') throw new Error('Identifier quoting failed')

const pool = {
  getConnection: async () => ({
    query: async () => ({ rows: [], rowCount: 0 }),
    execute: async () => ({ rows: [], rowCount: 0 }),
    beginTransaction: async () => undefined,
    commit: async () => undefined,
    rollback: async () => undefined,
    release: () => undefined
  })
}
const layer = MySqlJobStore.layer({ pool, validateSchema: false })
if (!(layer instanceof Layer)) throw new Error('Expected a better-effect Layer')
const scheduleLayer = MySqlJobScheduleStore.layer({ pool, validateSchema: false })
if (!(scheduleLayer instanceof Layer)) throw new Error('Expected a schedule Layer')
const outboxLayer = MySqlOutboxStore.layerFor(OutboxStore.named('billing'), {
  pool,
  validateSchema: false
})
if (!(outboxLayer instanceof Layer)) throw new Error('Expected an outbox Layer')
await MySqlOutbox.transaction(pool, async () => 'managed transaction export')
const eventLayer = MySqlJobEventStore.layer({ pool, validateSchema: false })
if (!(eventLayer instanceof Layer)) throw new Error('Expected an event Layer')
