// oxlint-disable anti-slop/no-object-parameters -- the fake driver preserves the erased MongoDB update boundary.
// oxlint-disable typescript/await-thenable -- Bun's resolved matcher is Promise-compatible at runtime.

import { describe, expect, test } from 'bun:test'
import { MONGODB_LAYOUT_VERSION, MongoJobStore } from '../src/index'

const collection = (layoutWrites: object[]) => ({
  find: () => ({ toArray: async () => [] }),
  findOne: async (filter: { _id: string }) =>
    filter._id === 'layout' ? { protocolVersion: 1, layoutVersion: 1 } : null,
  findOneAndUpdate: async () => ({ value: { owner: 'unit' } }),
  updateOne: async (filter: { _id: string }, update: object) => {
    if (filter._id === 'layout') layoutWrites.push(update)
    return { matchedCount: 1 }
  },
  insertOne: async () => undefined,
  deleteOne: async () => ({ deletedCount: 1 }),
  deleteMany: async () => undefined,
  createIndexes: async () => undefined,
  aggregate: () => ({ toArray: async () => [] })
})

describe('MongoDB layout migration', () => {
  test('upgrades a protocol-v1 layout marker to the strict validator layout', async () => {
    const writes: object[] = []
    const db = {
      collection: () => collection(writes),
      admin: () => ({ command: async () => ({}) }),
      createCollection: async () => undefined,
      command: async () => undefined
    }
    await expect(MongoJobStore.migrate({ db })).resolves.toEqual({ version: 1, applied: true })
    expect(writes).toContainEqual({
      $set: expect.objectContaining({ protocolVersion: 1, layoutVersion: MONGODB_LAYOUT_VERSION })
    })
  })
})
