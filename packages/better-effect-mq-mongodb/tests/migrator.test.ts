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
        const id = filter._id
        return typeof id === 'string' ? (documents.get(`${name}:${id}`) ?? null) : null
      },
      findOneAndUpdate: async (filter, update) => {
        const id = String(filter._id)
        const current = documents.get(`${name}:${id}`) ?? { _id: id }
        const next = {
          ...current,
          ...(update.$setOnInsert as Document | undefined),
          ...(update.$set as Document | undefined)
        }
        documents.set(`${name}:${id}`, next)
        return { value: next }
      },
      updateOne: async (filter, update) => {
        const id = String(filter._id)
        const current = documents.get(`${name}:${id}`) ?? { _id: id }
        const next = { ...current, ...(update.$set as Document | undefined) }
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

test('MongoDB migration creates the durable outbox layout at version 3', async () => {
  const fake = makeDatabase()

  const result = await MongoJobStoreMigrator.migrate({ db: fake.db })

  expect(result).toEqual({ version: 3, applied: true })
  expect(fake.created).toContain('better_effect_mq_outbox')
  expect(fake.indexed.some((value) => value.startsWith('better_effect_mq_outbox:'))).toBe(true)
  expect(fake.documents.get('better_effect_mq_migrations:layout')).toMatchObject({
    protocolVersion: 1,
    layoutVersion: 3
  })
})
