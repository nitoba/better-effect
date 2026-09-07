import type { Layer } from 'better-effect'
import { JobEventStore, JobStore } from 'better-effect-mq'
import {
  MongoJobEventStore,
  MongoJobStore,
  type MongoDb,
  type MongoJobEventStoreConfig
} from '../../src'

// SAFETY: this placeholder is used only to assert the public Layer types.
const db = {} as MongoDb
const config: MongoJobEventStoreConfig = { db, validateLayout: false }
const eventLayer: Layer<InstanceType<typeof JobEventStore>, never> = MongoJobEventStore.layer(
  config
)
const combinedLayer: Layer<
  InstanceType<typeof JobStore> | InstanceType<typeof JobEventStore>,
  never
> = MongoJobStore.layerWithEvents(config)
const named = JobStore.named('durable')
const namedEvents = JobEventStore.for(named)
const namedLayer: Layer<InstanceType<typeof namedEvents>, never> = MongoJobEventStore.layerFor(
  namedEvents,
  config
)

void eventLayer
void combinedLayer
void namedLayer
