import type { Layer } from 'better-effect'
import { JobScheduleStore, JobStore } from 'better-effect-mq'

import { MongoJobScheduleStore, type MongoJobStoreConfig, type MongoDb } from '../../src/index'

// SAFETY: the type-only contract test never executes the placeholder database.
const db = {} as MongoDb
const config: MongoJobStoreConfig = { db, validateLayout: false }
const Durable = JobStore.named('durable')
const DurableSchedules = JobScheduleStore.for(Durable)

const defaultLayer = MongoJobScheduleStore.layer(config)
const namedLayer = MongoJobScheduleStore.layerFor(DurableSchedules, config)

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
