import type { Layer } from 'better-effect'
import { JobScheduleStore, JobStore } from 'better-effect-mq'

import { SqliteJobScheduleStore, type SqliteDatabase, type SqliteJobStoreConfig } from '../../src'

declare const database: SqliteDatabase
const config: SqliteJobStoreConfig = { database }
const Durable = JobStore.named('durable')
const DurableSchedules = JobScheduleStore.for(Durable)

const defaultLayer = SqliteJobScheduleStore.layer(config)
const namedLayer = SqliteJobScheduleStore.layerFor(DurableSchedules, config)

const defaultContract: Layer<
  InstanceType<typeof JobScheduleStore>,
  InstanceType<typeof JobStore>
> = defaultLayer
const namedContract: Layer<
  InstanceType<typeof DurableSchedules>,
  InstanceType<typeof Durable>
> = namedLayer

void defaultContract
void namedContract
