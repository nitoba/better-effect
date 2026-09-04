// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- test injects unsupported JavaScript fields at the public boundary.

import { describe, expect, test } from 'bun:test'
import { MongoJobStoreConfigurationError, normalizeMongoJobStoreConfig } from '../src/index'

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
  admin: () => ({ command: async () => ({}) }),
  client: {
    startSession: () => ({
      withTransaction: async <T>(run: () => Promise<T>) => run(),
      endSession: () => undefined
    }),
    close: async () => undefined
  }
}

describe('MongoDB configuration', () => {
  test('uses isolated defaults', () => {
    expect(normalizeMongoJobStoreConfig({ db })).toMatchObject({
      namespace: 'default',
      collectionPrefix: 'better_effect_mq',
      validateLayout: true,
      notifications: 'auto'
    })
  })
  test('rejects unsafe or unknown config fields', () => {
    expect(() => normalizeMongoJobStoreConfig({ db, namespace: '' })).toThrow(
      MongoJobStoreConfigurationError
    )
    expect(() => normalizeMongoJobStoreConfig({ db, collectionPrefix: 'bad-name' })).toThrow(
      MongoJobStoreConfigurationError
    )
    expect(() => normalizeMongoJobStoreConfig({ db, unexpected: true } as never)).toThrow(
      MongoJobStoreConfigurationError
    )
  })
})
