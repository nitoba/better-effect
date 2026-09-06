import { Layer } from 'better-effect'
import { JobScheduleStore, JobStore } from 'better-effect-mq'
import {
  SqliteJobScheduleStore,
  SqliteJobStore,
  type SqliteDatabase
} from 'better-effect-mq-sqlite'

declare const database: SqliteDatabase
const storeLayer = SqliteJobStore.layer({ database, validateSchema: false })
const scheduleLayer = SqliteJobScheduleStore.layer({ database, validateSchema: false })
if (!(storeLayer instanceof Layer) || !(scheduleLayer instanceof Layer)) {
  throw new Error('Expected SQLite adapter layers')
}

const Durable = JobStore.named('durable')
const DurableSchedules = JobScheduleStore.for(Durable)
const namedScheduleLayer = SqliteJobScheduleStore.layerFor(DurableSchedules, {
  database,
  validateSchema: false
})
if (!(namedScheduleLayer instanceof Layer)) throw new Error('Expected named schedule layer')
