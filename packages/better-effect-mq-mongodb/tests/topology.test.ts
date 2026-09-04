// oxlint-disable typescript/await-thenable -- Bun's rejection matchers are Promise-compatible at runtime.

import { describe, expect, test } from 'bun:test'
import { Runtime, ServiceRuntime } from 'better-effect'
import { JobStore } from 'better-effect-mq'
import { MongoJobStore, MongoJobStoreTopologyError } from '../src/index'

const db = {
  collection: () => ({
    find: () => ({ toArray: async () => [] }),
    findOne: async () => null,
    findOneAndUpdate: async () => null,
    updateOne: async () => ({ matchedCount: 1 }),
    deleteMany: async () => undefined,
    insertMany: async () => undefined,
    createIndexes: async () => undefined
  }),
  admin: () => ({ command: async () => ({ logicalSessionTimeoutMinutes: 30 }) }),
  client: {
    startSession: () => ({
      withTransaction: async <T>(run: () => Promise<T>) => run(),
      endSession: () => undefined
    }),
    close: async () => undefined
  }
}

describe('MongoDB topology handshake', () => {
  test('rejects standalone MongoDB before accepting work', async () => {
    const runtime = await Runtime.make(MongoJobStore.layer({ db, validateLayout: false }))
    try {
      await expect(runtime.run(() => ServiceRuntime.resolve(JobStore))).rejects.toMatchObject({
        cause: expect.any(MongoJobStoreTopologyError)
      })
    } finally {
      await runtime.dispose()
    }
  })
})
