import { Layer } from 'better-effect'
import { OutboxStore } from 'better-effect-mq-outbox'
import { FlowStore, JobScheduleStore, JobStore } from 'better-effect-mq'
import {
  SqliteFlowStore,
  SqliteJobScheduleStore,
  SqliteJobStore,
  SqliteOutboxStore,
  type SqliteDatabase
} from 'better-effect-mq-sqlite'

declare const database: SqliteDatabase
const storeLayer = SqliteJobStore.layer({ database, validateSchema: false })
const flowLayer = SqliteFlowStore.layer({ database, validateSchema: false })
const scheduleLayer = SqliteJobScheduleStore.layer({ database, validateSchema: false })
if (
  !(storeLayer instanceof Layer) ||
  !(flowLayer instanceof Layer) ||
  !(scheduleLayer instanceof Layer)
) {
  throw new Error('Expected SQLite adapter layers')
}
void FlowStore
const outboxLayer = SqliteOutboxStore.layer({ database, validateSchema: false })
const NamedOutbox = OutboxStore.named('durable')
const namedOutboxLayer = SqliteOutboxStore.layerFor(NamedOutbox, {
  database,
  validateSchema: false
})
if (!(outboxLayer instanceof Layer) || !(namedOutboxLayer instanceof Layer)) {
  throw new Error('Expected SQLite outbox layers')
}

const Durable = JobStore.named('durable')
const DurableSchedules = JobScheduleStore.for(Durable)
const namedScheduleLayer = SqliteJobScheduleStore.layerFor(DurableSchedules, {
  database,
  validateSchema: false
})
if (!(namedScheduleLayer instanceof Layer)) throw new Error('Expected named schedule layer')
