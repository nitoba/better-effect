// oxlint-disable anti-slop/no-unsafe-dictionary-type -- this fake stores untyped BSON documents.
// oxlint-disable anti-slop/no-runtime-typeof -- the fake narrows driver-shaped values.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- casts are confined to the fake Mongo boundary.
// oxlint-disable anti-slop/no-known-value-widening -- test-only BSON documents are intentionally erased.

import { expect, test } from 'bun:test'
import { Runtime, ServiceRuntime } from 'better-effect'
import { JobEventCursorExpiredError, JobEventStore } from 'better-effect-mq'
import { MongoJobEventStore } from '../src'
import { mongoCollections } from '../src/collections'
import { appendMongoJobEvent } from '../src/event-store'
import type { MongoCollection, MongoDb } from '../src/config'

type Document = Record<string, unknown>

const makeDatabase = (): MongoDb => {
  const documents = new Map<string, Document[]>()
  const collection = (name: string): MongoCollection => {
    const rows = () => {
      const current = documents.get(name)
      if (current !== undefined) return current
      const created: Document[] = []
      documents.set(name, created)
      return created
    }
    const matches = (row: Document, filter: Document): boolean =>
      Object.entries(filter).every(([key, value]) => {
        if (key === '$or' && Array.isArray(value)) return value.some((item) => matches(row, item))
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          const query = value as Document
          if ('$gt' in query) return (row[key] as number) > (query.$gt as number)
          if ('$lt' in query) return (row[key] as number) < (query.$lt as number)
          if ('$in' in query && Array.isArray(query.$in)) return query.$in.includes(row[key])
        }
        return row[key] === value
      })
    return {
      find: (filter = {}, options = {}) => ({
        toArray: async () => {
          let output = rows().filter((row) => matches(row, filter as Document))
          const sort = (options as Document).sort as Document | undefined
          if (sort !== undefined) {
            const [field, direction] = Object.entries(sort)[0]!
            output = [...output].sort(
              (left, right) =>
                ((left[field] as number) - (right[field] as number)) * (direction as number)
            )
          }
          const limit = (options as Document).limit
          return limit === undefined ? output : output.slice(0, limit as number)
        }
      }),
      findOne: async (filter) => rows().find((row) => matches(row, filter as Document)) ?? null,
      findOneAndUpdate: async (filter, update, options = {}) => {
        const current = rows().find((row) => matches(row, filter as Document))
        const row = current ?? { ...((update as Document).$setOnInsert as Document), ...filter }
        if (current === undefined && (options as Document).upsert === true) rows().push(row)
        const set = (update as Document).$set as Document | undefined
        const inc = (update as Document).$inc as Document | undefined
        if (set !== undefined) Object.assign(row, set)
        if (inc !== undefined)
          for (const [key, value] of Object.entries(inc))
            row[key] = ((row[key] as number) ?? 0) + (value as number)
        return { value: row }
      },
      updateOne: async () => ({ matchedCount: 1 }),
      insertOne: async (document) => {
        rows().push({ ...(document as Document) })
      },
      deleteOne: async () => ({ deletedCount: 1 }),
      deleteMany: async (filter) => {
        const kept = rows().filter((row) => !matches(row, filter as Document))
        documents.set(name, kept)
      },
      createIndexes: async () => undefined,
      aggregate: () => ({ toArray: async () => [] })
    }
  }
  return {
    collection,
    admin: () => ({ command: async () => ({ logicalSessionTimeoutMinutes: 30, setName: 'rs0' }) }),
    client: {
      startSession: () => ({
        withTransaction: async <Value>(run: () => Promise<Value>) => run(),
        startTransaction: () => undefined,
        commitTransaction: async () => undefined,
        abortTransaction: async () => undefined,
        endSession: () => undefined
      }),
      close: async () => undefined
    }
  }
}

test('MongoJobEventStore exposes an empty opaque tail cursor', async () => {
  const runtime = await Runtime.make(
    MongoJobEventStore.layer({ db: makeDatabase(), validateLayout: false, notifications: 'poll' })
  )
  try {
    const result = await runtime.run(async () => {
      const store = await ServiceRuntime.resolve(JobEventStore)
      return store.tailCursor()
    })
    expect(result.isOk()).toBe(true)
    if (result.isOk()) expect(result.value).toMatch(/^mongo1_[a-z0-9]+_0$/u)
  } finally {
    await runtime.dispose()
  }
})

test('MongoJobEventStore wakes by polling and reports count-retained cursors as expired', async () => {
  const db = makeDatabase()
  const session = db.client!.startSession()
  const collections = mongoCollections(db, 'better_effect_mq')
  const append = (recordedAtMs: number) =>
    appendMongoJobEvent(session, collections, 'default', {
      type: 'job-enqueued',
      recordedAtMs,
      jobId: `job-${recordedAtMs}` as never,
      queue: 'events' as never,
      name: 'send',
      version: 1,
      state: 'waiting',
      attempt: undefined,
      delivery: undefined,
      workerId: undefined,
      outcome: undefined,
      failureKind: undefined,
      duplicate: undefined,
      attributes: Object.freeze({})
    })
  const runtime = await Runtime.make(
    MongoJobEventStore.layer({
      db,
      validateLayout: false,
      notifications: 'poll',
      retention: { count: 2 }
    })
  )
  try {
    const result = await runtime.run(async () => {
      const store = await ServiceRuntime.resolve(JobEventStore)
      const before = await store.tailCursor()
      if (before.isErr()) throw before.error
      const waiting = store.awaitEvents({
        after: before.value,
        signal: new AbortController().signal
      })
      await new Promise((resolve) => setTimeout(resolve, 10))
      await append(1)
      const woke = await waiting
      await append(2)
      await append(3)
      const expired = await store.read({ after: before.value })
      return { woke, expired }
    })
    expect(result.woke.isOk()).toBe(true)
    expect(result.expired.isErr()).toBe(true)
    if (result.expired.isErr())
      expect(result.expired.error).toBeInstanceOf(JobEventCursorExpiredError)
  } finally {
    await runtime.dispose()
  }
})

test('MongoJobEventStore reads caller-appended events exclusively and advances pages', async () => {
  const db = makeDatabase()
  const session = db.client!.startSession()
  const collections = mongoCollections(db, 'better_effect_mq')
  await appendMongoJobEvent(session, collections, 'default', {
    type: 'job-enqueued',
    recordedAtMs: 1,
    jobId: 'job-1' as never,
    queue: 'events' as never,
    name: 'send',
    version: 1,
    state: 'waiting',
    attempt: undefined,
    delivery: undefined,
    workerId: undefined,
    outcome: undefined,
    failureKind: undefined,
    duplicate: undefined,
    attributes: Object.freeze({})
  })
  await appendMongoJobEvent(session, collections, 'default', {
    type: 'job-completed',
    recordedAtMs: 2,
    jobId: 'job-1' as never,
    queue: 'events' as never,
    name: 'send',
    version: 1,
    state: 'completed',
    attempt: undefined,
    delivery: undefined,
    workerId: undefined,
    outcome: undefined,
    failureKind: undefined,
    duplicate: undefined,
    attributes: Object.freeze({})
  })
  const runtime = await Runtime.make(
    MongoJobEventStore.layer({ db, validateLayout: false, notifications: 'poll' })
  )
  try {
    const result = await runtime.run(async () => {
      const store = await ServiceRuntime.resolve(JobEventStore)
      const first = await store.read({ limit: 1 })
      if (first.isErr() || first.value.nextCursor === undefined) return first
      return store.read({ after: first.value.nextCursor, limit: 1 })
    })
    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value.events).toHaveLength(1)
      expect(result.value.events[0]?.type).toBe('job-completed')
    }
  } finally {
    await runtime.dispose()
  }
})
