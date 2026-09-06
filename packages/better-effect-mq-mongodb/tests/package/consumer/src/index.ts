// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- the consumer uses a type-only MongoDB placeholder.

import { Layer } from 'better-effect'
import {
  MongoOutboxStore,
  OutboxStore,
  type MongoDb,
  type MongoJobStoreConfig
} from 'better-effect-mq-mongodb'

const db = {} as MongoDb
const config: MongoJobStoreConfig = { db, validateLayout: false }
const layer = MongoOutboxStore.layerFor(OutboxStore.named('external'), config)
if (!(layer instanceof Layer)) throw new Error('Expected a MongoDB outbox Layer')
