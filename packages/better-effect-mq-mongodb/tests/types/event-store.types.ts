// SAFETY: the type-only contract test never executes the placeholder database.
import type { Layer } from 'better-effect'
import { JobEventStore, JobStore } from 'better-effect-mq'

import {
  MongoJobEventStore,
  type MongoDb,
  type MongoJobEventStoreConfig,
  type MongoJobEventStoreInstance
} from '../../src/index'

// SAFETY: the placeholder is used only to instantiate a type-level Layer expression.
const db = {} as MongoDb
const config: MongoJobEventStoreConfig = {
  db,
  validateLayout: false,
  retention: { count: 100 }
}
const Durable = JobStore.named('durable')
const DurableEvents = JobEventStore.for(Durable)

const defaultLayer = MongoJobEventStore.layer(config)
const namedLayer = MongoJobEventStore.layerFor(DurableEvents, config)
const namedFromConfigLayer = MongoJobEventStore.layerFromConfigFor(DurableEvents, {
  uri: 'mongodb://localhost:27017',
  database: 'application'
})

const defaultContract: Layer<InstanceType<typeof JobEventStore>, never> = defaultLayer
const namedContract: Layer<InstanceType<typeof DurableEvents>, never> = namedLayer
const namedFromConfigContract: Layer<
  InstanceType<typeof DurableEvents>,
  never
> = namedFromConfigLayer
// SAFETY: this erased placeholder is never evaluated; it only checks the public instance alias.
const storeContract: MongoJobEventStoreInstance = {} as MongoJobEventStoreInstance

void defaultContract
void namedContract
void namedFromConfigContract
void storeContract
