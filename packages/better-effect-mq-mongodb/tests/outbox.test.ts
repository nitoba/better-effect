import { expect, test } from 'bun:test'
import { Result } from 'better-result'
import {
  OutboxConflictError,
  OutboxId,
  makeOutboxRecord,
  validatePreparedEnqueue,
  type OutboxRecord
} from 'better-effect-mq-outbox'
import type { MongoCollection, MongoDb, MongoSession } from '../src/config'
import { MongoOutbox } from '../src/MongoOutbox'

const prepared = validatePreparedEnqueue({
  protocolVersion: 1,
  identity: { queue: 'billing', name: 'invoice', version: 1 },
  payload: { invoiceId: 'inv-1' },
  metadata: { tenant: 'acme' },
  priority: 0,
  runAt: 0,
  attemptsMax: 3,
  now: 0
}).unwrap()

const record = (id = 'invoice:inv-1', payload = prepared.payload): OutboxRecord =>
  makeOutboxRecord({
    id: OutboxId.make(id).unwrap(),
    target: 'jobs-mongodb',
    request: validatePreparedEnqueue({ ...prepared, payload }).unwrap(),
    nowMs: 0
  }).unwrap()

const storedDocument = (value: OutboxRecord): Record<string, unknown> => ({
  _id: `billing\u0000${value.id}`,
  namespace: 'billing',
  id: value.id,
  protocolVersion: value.protocolVersion,
  target: value.target,
  state: value.state,
  request: value.request,
  requestDigest: value.requestDigest,
  attemptsMax: value.attemptsMax,
  attemptsMade: value.attemptsMade,
  runAtMs: value.runAtMs,
  createdAtMs: value.createdAtMs,
  updatedAtMs: value.updatedAtMs,
  publishedAtMs: value.publishedAtMs,
  leaseOwner: value.leaseOwner,
  leaseToken: value.leaseToken,
  leaseExpiresAtMs: value.leaseExpiresAtMs,
  failure: value.failure
})

const makeAppendBoundary = (reply: Record<string, unknown>) => {
  const calls: { readonly options: object | undefined; readonly update: object }[] = []
  const collection: MongoCollection = {
    find: () => ({ toArray: async () => [] }),
    findOne: async () => null,
    findOneAndUpdate: async (_filter, update, options) => {
      calls.push({ options, update })
      return reply
    },
    updateOne: async () => ({ matchedCount: 1 }),
    insertOne: async () => undefined,
    deleteOne: async () => ({ deletedCount: 1 }),
    deleteMany: async () => undefined,
    createIndexes: async () => undefined,
    aggregate: () => ({ toArray: async () => [] })
  }
  const db: MongoDb = {
    collection: () => collection,
    admin: () => ({ command: async () => ({}) })
  }
  const session: MongoSession = {
    withTransaction: async () => {
      throw new Error('appendIn must not start a transaction')
    },
    endSession: () => {
      throw new Error('appendIn must not end the caller session')
    }
  }
  return { db, session, calls }
}

test('MongoOutbox.appendIn uses the caller session without owning its transaction', async () => {
  const value = record()
  const fake = makeAppendBoundary({
    value: storedDocument(value),
    lastErrorObject: { updatedExisting: false }
  })

  const result = await MongoOutbox.appendIn(fake.session, value, {
    db: fake.db,
    namespace: 'billing'
  })

  expect(Result.isOk(result)).toBe(true)
  if (Result.isError(result)) return
  expect(result.value.duplicate).toBe(false)
  expect(result.value.record.id).toBe(value.id)
  expect(fake.calls).toHaveLength(1)
  expect(fake.calls[0]?.options).toMatchObject({ session: fake.session })
  expect(fake.calls[0]?.update).toHaveProperty('$setOnInsert')
})

test('MongoOutbox.appendIn reports digest duplicates and conflicts', async () => {
  const value = record()
  const duplicateFake = makeAppendBoundary({
    value: storedDocument(value),
    lastErrorObject: { updatedExisting: true }
  })
  const duplicate = await MongoOutbox.appendIn(duplicateFake.session, value, {
    db: duplicateFake.db,
    namespace: 'billing'
  })
  expect(Result.isOk(duplicate)).toBe(true)
  if (Result.isError(duplicate)) return
  expect(duplicate.value.duplicate).toBe(true)

  const conflicting = record(value.id, { invoiceId: 'different' })
  const conflictFake = makeAppendBoundary({
    value: storedDocument(value),
    lastErrorObject: { updatedExisting: true }
  })
  const conflict = await MongoOutbox.appendIn(conflictFake.session, conflicting, {
    db: conflictFake.db,
    namespace: 'billing'
  })
  expect(Result.isError(conflict)).toBe(true)
  if (Result.isOk(conflict)) return
  expect(OutboxConflictError.is(conflict.error)).toBe(true)
})

test('MongoOutbox.appendIn validates the prepared request before writing', async () => {
  const value = record()
  const fake = makeAppendBoundary({ value: storedDocument(value) })
  const invalid = {
    ...value,
    request: { ...value.request, protocolVersion: 99 }
  } as unknown as OutboxRecord

  const result = await MongoOutbox.appendIn(fake.session, invalid, {
    db: fake.db,
    namespace: 'billing'
  })

  expect(Result.isError(result)).toBe(true)
  expect(fake.calls).toHaveLength(0)
})
