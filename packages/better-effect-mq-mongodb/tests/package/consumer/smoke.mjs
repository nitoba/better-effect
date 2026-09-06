// oxlint-disable anti-slop/no-runtime-typeof -- the smoke test only checks the optional exported factory.

import { Layer } from 'better-effect'
import { MongoOutboxStore, OutboxStore } from 'better-effect-mq-mongodb'

const db = {
  collection() {
    throw new Error('consumer smoke must not connect to MongoDB')
  },
  admin() {
    return { command: async () => ({}) }
  }
}
const layer = MongoOutboxStore.layerFor(OutboxStore.named('external'), {
  db,
  validateLayout: false
})
if (!(layer instanceof Layer)) throw new Error('Expected a MongoDB outbox Layer')
if (MongoOutboxStore.layerFromConfig === undefined)
  throw new Error('Missing connection Layer factory')
