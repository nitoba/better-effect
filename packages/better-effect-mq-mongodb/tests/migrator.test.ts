// oxlint-disable anti-slop/no-unsafe-dictionary-type -- this fake stores untyped BSON documents.
// oxlint-disable anti-slop/no-runtime-typeof -- the fake narrows driver-shaped values.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- casts are confined to the fake Mongo boundary.
// oxlint-disable anti-slop/no-known-value-widening -- test-only BSON documents are intentionally erased.

import { expect, test } from 'bun:test'

import { MongoJobStoreMigrator } from '../src/migrator'
import type { MongoCollection, MongoDb } from '../src/config'

type Document = Record<string, unknown>

const makeDatabase = () => {
  const created: string[] = []
  const indexed: string[] = []
  const documents = new Map<string, Document>()
  const collections = new Map<string, MongoCollection>()
  const collection = (name: string): MongoCollection => {
    const existing = collections.get(name)
    if (existing !== undefined) return existing
    const handle: MongoCollection = {
      find: () => ({ toArray: async () => [] }),
      findOne: async (filter) => {
        const id = (filter as Document)._id
        return typeof id === 'string' ? (documents.get(`${name}:${id}`) ?? null) : null
      },
      findOneAndUpdate: async (filter, update) => {
        const id = String((filter as Document)._id)
        const current = documents.get(`${name}:${id}`) ?? { _id: id }
        const next = {
          ...current,
          ...((update as Document).$setOnInsert as Document | undefined),
          ...((update as Document).$set as Document | undefined)
        }
        documents.set(`${name}:${id}`, next)
        return { value: next }
      },
      updateOne: async (filter, update) => {
        const id = String((filter as Document)._id)
        const current = documents.get(`${name}:${id}`) ?? { _id: id }
        const next = { ...current, ...((update as Document).$set as Document | undefined) }
        documents.set(`${name}:${id}`, next)
        return { matchedCount: 1 }
      },
      insertOne: async () => undefined,
      deleteOne: async () => ({ deletedCount: 1 }),
      deleteMany: async () => undefined,
      createIndexes: async (indexes) => {
        indexed.push(`${name}:${indexes.length}`)
      },
      aggregate: () => ({ toArray: async () => [] })
    }
    collections.set(name, handle)
    return handle
  }
  const db: MongoDb = {
    collection,
    admin: () => ({ command: async () => ({}) }),
    createCollection: async (name) => {
      created.push(name)
    },
    command: async () => undefined
  }
  return { db, created, indexed, documents }
}

test('MongoDB migration creates the durable controls and outbox layout at version 4', async () => {
  const fake = makeDatabase()

  const result = await MongoJobStoreMigrator.migrate({ db: fake.db })

  expect(result).toEqual({ version: 4, applied: true })
  expect(fake.created).toContain('better_effect_mq_outbox')
  expect(fake.created).toContain('better_effect_mq_controls')
  expect(fake.created).toContain('better_effect_mq_controlled_permits')
  expect(fake.created).toContain('better_effect_mq_controlled_rate_windows')
  expect(fake.created).toContain('better_effect_mq_controlled_cursors')
  expect(fake.indexed.some((value) => value.startsWith('better_effect_mq_outbox:'))).toBe(true)
  expect(fake.indexed.some((value) => value.startsWith('better_effect_mq_controls:'))).toBe(true)
  expect(fake.documents.get('better_effect_mq_migrations:layout')).toMatchObject({
    protocolVersion: 1,
    layoutVersion: 4
  })
})
