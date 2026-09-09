// oxlint-disable anti-slop/no-runtime-typeof -- the fake Mongo boundary models untyped BSON values.
// oxlint-disable anti-slop/no-unknown-parameters -- the fake accepts MongoDB filter and update documents.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- test-only BSON documents are intentionally open.
// oxlint-disable anti-slop/no-known-value-widening -- test-only BSON envelopes are intentionally erased.
// oxlint-disable anti-slop/no-object-parameters -- the fake models the driver's broad options boundary.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- test casts follow the fake Mongo boundary.
// oxlint-disable anti-slop/no-chained-type-assertions -- test-only decoded boundary values are deliberately erased.
// oxlint-disable typescript/no-base-to-string -- the fake sorts arbitrary BSON scalar values.
// oxlint-disable typescript/await-thenable -- OutboxOperation may be a Result or PromiseLike at runtime.

import { expect, test } from 'bun:test'
import { Layer, Runtime, ServiceRuntime } from 'better-effect'
import { Result } from 'better-result'
import {
  OutboxConflictError,
  OutboxId,
  OutboxLeaseToken,
  OutboxStore,
  OutboxWorkerId,
  makeOutboxRecord,
  makeSerializedOutboxFailure,
  validatePreparedEnqueue,
  type OutboxAppendResult,
  type OutboxOperation,
  type OutboxRecordInput,
  type OutboxRecord,
  type OutboxStoreError
} from 'better-effect-mq-outbox'
import type { MongoCollection, MongoDb, MongoSession } from '../src/config'
import { MongoOutbox } from '../src/MongoOutbox'
import { MongoOutboxStore } from '../src/MongoOutboxStore'

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

const record = (
  id = 'invoice:inv-1',
  payload = prepared.payload,
  options: Partial<Pick<OutboxRecordInput, 'attemptsMax' | 'runAtMs' | 'nowMs'>> = {}
): OutboxRecord =>
  makeOutboxRecord({
    id: OutboxId.make(id).unwrap(),
    target: 'jobs-mongodb',
    request: validatePreparedEnqueue({ ...prepared, payload }).unwrap(),
    nowMs: 0,
    ...options
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

const makeTransactionBoundary = (reply: Record<string, unknown>) => {
  const events: string[] = []
  let transactionOptions: object | undefined
  const collection: MongoCollection = {
    find: () => ({ toArray: async () => [] }),
    findOne: async () => null,
    findOneAndUpdate: async (_filter, _update, _options) => {
      events.push('append')
      return reply
    },
    updateOne: async () => ({ matchedCount: 1 }),
    insertOne: async () => {
      events.push('domain')
    },
    deleteOne: async () => ({ deletedCount: 1 }),
    deleteMany: async () => undefined,
    createIndexes: async () => undefined,
    aggregate: () => ({ toArray: async () => [] })
  }
  const session: MongoSession = {
    withTransaction: async <Value>(callback: () => Promise<Value>, options: object | undefined) => {
      transactionOptions = options
      events.push('transaction')
      try {
        const value = await callback()
        events.push('commit')
        return value
      } catch (cause) {
        events.push('abort')
        throw cause
      }
    },
    endSession: () => {
      events.push('end')
    }
  }
  const client = {
    startSession: () => {
      events.push('start')
      return session
    },
    close: async () => undefined
  }
  const db: MongoDb = {
    collection: () => collection,
    admin: () => ({ command: async () => ({}) }),
    client
  }
  return {
    db,
    events,
    session,
    get transactionOptions() {
      return transactionOptions
    }
  }
}

type Filter = Record<string, unknown>

const matches = (document: Record<string, unknown>, filter: Filter): boolean => {
  for (const [key, expected] of Object.entries(filter)) {
    if (key === '$or') {
      if (!Array.isArray(expected) || !expected.some((value) => matches(document, value as Filter)))
        return false
      continue
    }
    if (key === '$expr') {
      const expression = expected as Filter
      const comparison = expression.$lt
      if (!Array.isArray(comparison) || comparison.length !== 2) return false
      const [left, right] = comparison
      const leftValue =
        typeof left === 'string' && left.startsWith('$') ? document[left.slice(1)] : left
      const rightValue =
        typeof right === 'string' && right.startsWith('$') ? document[right.slice(1)] : right
      if (
        !(typeof leftValue === 'number' && typeof rightValue === 'number' && leftValue < rightValue)
      )
        return false
      continue
    }
    const actual = document[key]
    if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
      const operators = expected as Filter
      for (const [operator, value] of Object.entries(operators)) {
        if (operator === '$lte' && !(typeof actual === 'number' && actual <= (value as number)))
          return false
        if (operator === '$lt' && !(typeof actual === 'number' && actual < (value as number)))
          return false
        if (operator === '$gt' && !(typeof actual === 'number' && actual > (value as number)))
          return false
        if (operator === '$in' && (!Array.isArray(value) || !value.includes(actual))) return false
        if (operator === '$exists' && (value === true) !== (actual !== undefined)) return false
      }
      continue
    }
    if (actual !== expected) return false
  }
  return true
}

const apply = (
  document: Record<string, unknown>,
  update: Record<string, unknown>,
  inserting: boolean
): Record<string, unknown> => {
  const next = { ...document }
  if (inserting && update.$setOnInsert !== undefined)
    Object.assign(next, update.$setOnInsert as Record<string, unknown>)
  if (update.$set !== undefined) Object.assign(next, update.$set as Record<string, unknown>)
  if (update.$inc !== undefined)
    for (const [key, value] of Object.entries(update.$inc as Record<string, number>))
      next[key] = (typeof next[key] === 'number' ? next[key] : 0) + value
  if (update.$max !== undefined)
    for (const [key, value] of Object.entries(update.$max as Record<string, number>))
      if (typeof next[key] !== 'number' || next[key] < value) next[key] = value
  if (update.$unset !== undefined)
    for (const key of Object.keys(update.$unset as Record<string, unknown>)) delete next[key]
  return next
}

const ordered = (
  documents: readonly Record<string, unknown>[],
  options: object | undefined
): Record<string, unknown>[] => {
  const sort = (options as { readonly sort?: Record<string, number> } | undefined)?.sort
  if (sort === undefined) return [...documents]
  return [...documents].sort((left, right) => {
    for (const [key, direction] of Object.entries(sort)) {
      const first = left[key]
      const second = right[key]
      if (first === second) continue
      const comparison =
        first === undefined
          ? -1
          : second === undefined
            ? 1
            : typeof first === 'number' && typeof second === 'number'
              ? first - second
              : String(first).localeCompare(String(second))
      return Math.sign(comparison) * direction
    }
    return 0
  })
}

const makeStoreDatabase = () => {
  const documents = new Map<string, Record<string, unknown>>()
  const handles = new Map<string, MongoCollection>()
  const collection = (name: string): MongoCollection => {
    const existing = handles.get(name)
    if (existing !== undefined) return existing
    const handle: MongoCollection = {
      find: (filter = {}, options) => ({
        toArray: async () => {
          const found = ordered(
            [...documents.values()].filter(
              (document) => document.__collection === name && matches(document, filter as Filter)
            ),
            options
          )
          const limit = (options as { readonly limit?: number } | undefined)?.limit
          return found.slice(0, limit)
        }
      }),
      findOne: async (filter, options) => {
        const found = ordered(
          [...documents.values()].filter(
            (document) => document.__collection === name && matches(document, filter as Filter)
          ),
          options
        )[0]
        return found === undefined ? null : { ...found }
      },
      findOneAndUpdate: async (filter, update, options) => {
        const candidates = ordered(
          [...documents.entries()]
            .filter(
              ([, document]) =>
                document.__collection === name && matches(document, filter as Filter)
            )
            .map(([key, document]) => ({ key, document, ...document })),
          options
        )
        const selected = candidates[0]
        const isInsert = selected === undefined
        const operationOptions = options as { readonly upsert?: boolean } | undefined
        if (isInsert && operationOptions?.upsert !== true) return null
        const source = (selected?.document as Record<string, unknown> | undefined) ?? {
          ...(filter as Filter)
        }
        const next = apply(source, update as Record<string, unknown>, isInsert)
        next.__collection = name
        const key = String(selected?.key ?? next._id)
        documents.set(key, next)
        return {
          value: { ...next },
          lastErrorObject: { updatedExisting: !isInsert }
        }
      },
      updateOne: async (filter, update) => {
        const entry = [...documents.entries()].find(
          ([, document]) => document.__collection === name && matches(document, filter as Filter)
        )
        if (entry === undefined) return { matchedCount: 0 }
        const next = apply(entry[1], update as Record<string, unknown>, false)
        next.__collection = name
        documents.set(entry[0], next)
        return { matchedCount: 1 }
      },
      insertOne: async (document) => {
        const next: Record<string, unknown> = {
          ...(document as Record<string, unknown>),
          __collection: name
        }
        documents.set(String(next._id), next)
      },
      deleteOne: async (filter) => {
        const entry = [...documents.entries()].find(
          ([, document]) => document.__collection === name && matches(document, filter as Filter)
        )
        if (entry === undefined) return { deletedCount: 0 }
        documents.delete(entry[0])
        return { deletedCount: 1 }
      },
      deleteMany: async (filter) => {
        for (const [key, document] of documents)
          if (document.__collection === name && matches(document, filter as Filter))
            documents.delete(key)
      },
      createIndexes: async () => undefined,
      aggregate: (pipeline) => ({
        toArray: async () => {
          const match = pipeline.find((stage) => '$match' in stage)?.$match
          const matching = [...documents.values()].filter(
            (document) =>
              document.__collection === name &&
              (match === undefined || matches(document, match as Filter))
          )
          const grouped = new Map<string, number>()
          for (const document of matching) {
            const state = document.state
            if (typeof state === 'string') grouped.set(state, (grouped.get(state) ?? 0) + 1)
          }
          return [...grouped].map(([state, count]) => ({ _id: state, count }))
        }
      })
    }
    handles.set(name, handle)
    return handle
  }
  const client = {
    startSession: (): MongoSession => ({
      withTransaction: async <Value>(callback: () => Promise<Value>) => callback(),
      endSession: () => undefined
    }),
    close: async () => undefined
  }
  const db: MongoDb = {
    collection,
    admin: () => ({ command: async () => ({ logicalSessionTimeoutMinutes: 30, setName: 'rs0' }) }),
    client
  }
  return db
}

const resolve = async <Value, Failure extends OutboxStoreError>(
  operation: OutboxOperation<Value, Failure>
): Promise<Value> => {
  const result = await operation
  if (Result.isError(result)) throw result.error
  return result.value
}

const layerConfig = (db: MongoDb) => ({ db, namespace: 'billing', validateLayout: false as const })

const runtimeStore = async (db: MongoDb) => {
  const runtime = await Runtime.make(MongoOutboxStore.layer(layerConfig(db)))
  const store = await runtime.run(() => ServiceRuntime.resolve(OutboxStore))
  return { runtime, store }
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

test('MongoOutbox.transaction commits domain writes and append results together', async () => {
  const value = record('managed-success')
  const fake = makeTransactionBoundary({
    value: storedDocument(value),
    lastErrorObject: { updatedExisting: false }
  })

  const result = await MongoOutbox.transaction(
    async (session) => {
      await fake.db.collection('orders').insertOne({ _id: 'order-1' }, { session })
      const appended = await MongoOutbox.appendIn(session, value, {
        db: fake.db,
        namespace: 'billing'
      })
      if (Result.isError(appended)) return Result.err(appended.error)
      return Result.ok(appended.value.record.id)
    },
    { db: fake.db, namespace: 'billing' }
  )

  expect(Result.isOk(result)).toBe(true)
  expect(fake.events).toEqual(['start', 'transaction', 'domain', 'append', 'commit', 'end'])
  expect(fake.transactionOptions).toEqual({
    readConcern: { level: 'snapshot' },
    writeConcern: { w: 'majority' }
  })
})

test('MongoOutbox.transaction aborts a nominal Result.err from the domain callback', async () => {
  const fake = makeTransactionBoundary({})
  const failure = new Error('domain rejected')

  const result = await MongoOutbox.transaction(async () => Result.err(failure), {
    db: fake.db,
    namespace: 'billing'
  })

  expect(Result.isError(result)).toBe(true)
  if (Result.isOk(result)) return
  expect(result.error).toBe(failure)
  expect(fake.events).toEqual(['start', 'transaction', 'abort', 'end'])
})

test('MongoOutbox.transaction aborts when appendIn returns a failure Result', async () => {
  const value = record('managed-append-failure')
  const fake = makeTransactionBoundary({ value: null })

  const result = await MongoOutbox.transaction(
    async (session) => MongoOutbox.appendIn(session, value, { db: fake.db, namespace: 'billing' }),
    { db: fake.db, namespace: 'billing' }
  )

  expect(Result.isError(result)).toBe(true)
  expect(fake.events).toEqual(['start', 'transaction', 'append', 'abort', 'end'])
})

test('MongoOutbox.transaction aborts thrown failures and always ends its session', async () => {
  const fake = makeTransactionBoundary({})
  const failure = new Error('domain defect')

  await expect(
    MongoOutbox.transaction(
      async () => {
        throw failure
      },
      { db: fake.db, namespace: 'billing' }
    )
  ).rejects.toBe(failure)

  expect(fake.events).toEqual(['start', 'transaction', 'abort', 'end'])
})

test('MongoOutboxStore provides the canonical default and named Layer tokens', async () => {
  const db = makeStoreDatabase()
  const named = OutboxStore.named('billing-events')
  const runtime = await Runtime.make(
    Layer.merge(
      MongoOutboxStore.layer(layerConfig(db)),
      MongoOutboxStore.layerFor(named, layerConfig(db))
    )
  )
  try {
    const defaultStore = await runtime.run(() => ServiceRuntime.resolve(OutboxStore))
    const namedStore = await runtime.run(() => ServiceRuntime.resolve(named))
    expect(defaultStore.descriptor.adapter).toBe('mongodb')
    expect(namedStore.descriptor.adapter).toBe('mongodb')
  } finally {
    await runtime.dispose()
  }
})

test('MongoOutboxStore fences leases and converges settlements', async () => {
  const db = makeStoreDatabase()
  const { runtime, store } = await runtimeStore(db)
  const appendable = store as typeof store & {
    append(input: OutboxRecordInput): OutboxOperation<OutboxAppendResult>
  }
  try {
    await resolve(appendable.append(record('lease-1')))
    const first = (
      await resolve(
        store.claim({
          owner: OutboxWorkerId.make('worker-1').unwrap(),
          limit: 1,
          leaseDurationMs: 10,
          nowMs: 0
        })
      )
    )[0]
    if (first === undefined) throw new Error('missing first claim')

    const heartbeat = await resolve(
      store.heartbeat({
        id: first.id,
        leaseToken: first.leaseToken,
        leaseDurationMs: 20,
        nowMs: 1
      })
    )
    expect(heartbeat.leaseExpiresAtMs).toBe(21)

    const stale = await store.markPublished({
      id: first.id,
      leaseToken: OutboxLeaseToken.make('stale').unwrap(),
      nowMs: 2
    })
    expect(Result.isError(await stale)).toBe(true)

    const redelivered = (
      await resolve(
        store.claim({
          owner: OutboxWorkerId.make('worker-2').unwrap(),
          limit: 1,
          leaseDurationMs: 10,
          nowMs: 22
        })
      )
    )[0]
    expect(redelivered?.id).toBe(first.id)
    expect(redelivered?.attemptsMade).toBe(2)
    if (redelivered === undefined) throw new Error('missing redelivered claim')
    expect(
      Result.isError(
        await store.markPublished({
          id: first.id,
          leaseToken: first.leaseToken,
          nowMs: 22
        })
      )
    ).toBe(true)
    expect(
      (
        await resolve(
          store.markPublished({ id: redelivered.id, leaseToken: redelivered.leaseToken, nowMs: 23 })
        )
      ).status
    ).toBe('applied')
    expect(
      (
        await resolve(
          store.markPublished({
            id: redelivered.id,
            leaseToken: OutboxLeaseToken.make('lost-response').unwrap(),
            nowMs: 24
          })
        )
      ).status
    ).toBe('already-applied')
  } finally {
    await runtime.dispose()
  }
})

test('MongoOutboxStore supports retry, failure, release, recovery, and inspection', async () => {
  const db = makeStoreDatabase()
  const { runtime, store } = await runtimeStore(db)
  const appendable = store as typeof store & {
    append(input: OutboxRecordInput): OutboxOperation<OutboxAppendResult>
  }
  const failure = makeSerializedOutboxFailure({
    kind: 'store-transient',
    message: 'temporary failure',
    retryable: true,
    recordedAtMs: 1
  }).unwrap()
  try {
    await resolve(appendable.append(record('retry-1')))
    const retryClaim = (
      await resolve(
        store.claim({
          owner: OutboxWorkerId.make('worker-retry').unwrap(),
          limit: 1,
          leaseDurationMs: 10,
          nowMs: 0
        })
      )
    )[0]
    if (retryClaim === undefined) throw new Error('missing retry claim')
    const retried = await resolve(
      store.markRetry({
        id: retryClaim.id,
        leaseToken: retryClaim.leaseToken,
        nowMs: 1,
        runAtMs: 10,
        failure
      })
    )
    expect(retried.state).toBe('pending')
    expect(retried.runAtMs).toBe(10)
    expect(retried.failure).toEqual(failure)

    const failedClaim = (
      await resolve(
        store.claim({
          owner: OutboxWorkerId.make('worker-failed').unwrap(),
          limit: 1,
          leaseDurationMs: 10,
          nowMs: 10
        })
      )
    )[0]
    if (failedClaim === undefined) throw new Error('missing failed claim')
    const failedRecord = await resolve(
      store.markFailed({
        id: failedClaim.id,
        leaseToken: failedClaim.leaseToken,
        nowMs: 11,
        failure
      })
    )
    expect(failedRecord.state).toBe('failed')

    await resolve(appendable.append(record('release-1')))
    const releaseClaim = (
      await resolve(
        store.claim({
          owner: OutboxWorkerId.make('worker-release').unwrap(),
          limit: 1,
          leaseDurationMs: 10,
          nowMs: 0
        })
      )
    )[0]
    if (releaseClaim === undefined) throw new Error('missing release claim')
    const released = await resolve(
      store.release({ id: releaseClaim.id, leaseToken: releaseClaim.leaseToken, nowMs: 1 })
    )
    expect(released.state).toBe('pending')
    expect(released.attemptsMade).toBe(1)

    await resolve(appendable.append(record('recovery-1', prepared.payload, { attemptsMax: 1 })))
    const recoveryClaim = (
      await resolve(
        store.claim({
          owner: OutboxWorkerId.make('worker-recovery').unwrap(),
          limit: 1,
          leaseDurationMs: 5,
          nowMs: 0
        })
      )
    )[0]
    if (recoveryClaim === undefined) throw new Error('missing recovery claim')
    const recovered = await resolve(store.recoverStalled({ maxCount: 1, nowMs: 5 }))
    expect(recovered).toHaveLength(1)
    expect(recovered[0]?.state).toBe('failed')

    expect((await resolve(store.get('retry-1' as OutboxId)))?.state).toBe('failed')
    expect(
      (await resolve(store.list({ state: ['failed'], target: 'jobs-mongodb', limit: 10 }))).map(
        (item) => item.id
      )
    ).toEqual([OutboxId.make('recovery-1').unwrap(), OutboxId.make('retry-1').unwrap()])
    const counts = await resolve(store.counts())
    expect(counts).toEqual({ pending: 1, active: 0, published: 0, failed: 2, total: 3 })
  } finally {
    await runtime.dispose()
  }
})
