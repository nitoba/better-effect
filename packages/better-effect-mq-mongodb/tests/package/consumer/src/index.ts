// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- the consumer uses a type-only MongoDB placeholder.

import { Layer } from 'better-effect'
import { JobEventStore, JobStore } from 'better-effect-mq'
import {
  MongoJobEventStore,
  MongoJobStore,
  MongoOutboxStore,
  OutboxStore,
  type MongoDb,
  type MongoJobStoreConfig
} from 'better-effect-mq-mongodb'

const db = {} as MongoDb
const config: MongoJobStoreConfig = { db, validateLayout: false }
const layer = MongoOutboxStore.layerFor(OutboxStore.named('external'), config)
if (!(layer instanceof Layer)) throw new Error('Expected a MongoDB outbox Layer')
const events = MongoJobEventStore.layer(config)
const combined = MongoJobStore.layerWithEvents(config)
const eventContract: Layer<InstanceType<typeof JobEventStore>, never> = events
const combinedContract: Layer<
  InstanceType<typeof JobStore> | InstanceType<typeof JobEventStore>,
  never
> = combined
void eventContract
void combinedContract
