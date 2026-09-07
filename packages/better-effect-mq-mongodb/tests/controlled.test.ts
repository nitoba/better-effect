// oxlint-disable anti-slop/no-runtime-typeof -- this test fake narrows BSON values at its boundary.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- the fake intentionally stores erased BSON.
// oxlint-disable anti-slop/no-unknown-returns -- the fake returns intentionally erased BSON.
// oxlint-disable anti-slop/no-known-value-widening -- the fake models open BSON update documents.
// oxlint-disable anti-slop/no-object-parameters -- the fake models the driver's broad options boundary.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- assertions stay inside the fake driver.

import { afterEach, expect, test } from 'bun:test'
import { Runtime, ServiceRuntime } from 'better-effect'
import {
  JobStore,
  Queue,
  QueueControls,
  type ControlledJobStoreContract,
  type JobStoreOperation
} from 'better-effect-mq'
import { Result } from 'better-result'
import type { MongoCollection, MongoDb, MongoSession } from '../src/config'
import { MongoJobStore, mongoCollections } from '../src/index'

type Document = Record<string, unknown>
type Filter = Record<string, unknown>

const valueAt = (document: Document, path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>(
      (value, part) =>
        value !== null && typeof value === 'object' ? (value as Document)[part] : undefined,
      document
    )

const matches = (document: Document, filter: Filter): boolean => {
  for (const [field, expected] of Object.entries(filter)) {
    if (field === '$or') {
      if (!Array.isArray(expected) || !expected.some((item) => matches(document, item as Filter)))
        return false
      continue
    }
    const actual = valueAt(document, field)
    if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
      for (const [operator, operand] of Object.entries(expected as Filter)) {
        if (operator === '$in' && (!Array.isArray(operand) || !operand.includes(actual)))
          return false
        if (operator === '$lt' && !(typeof actual === 'number' && actual < (operand as number)))
          return false
        if (operator === '$lte' && !(typeof actual === 'number' && actual <= (operand as number)))
          return false
        if (operator === '$gt' && !(typeof actual === 'number' && actual > (operand as number)))
          return false
        if (operator === '$exists' && (operand === true) !== (actual !== undefined)) return false
      }
      continue
    }
    if (actual !== expected) return false
  }
  return true
}

const applyUpdate = (source: Document, update: Document, inserting: boolean): Document => {
  const next = { ...source }
  if (inserting && update.$setOnInsert !== undefined)
    Object.assign(next, update.$setOnInsert as Document)
  if (update.$set !== undefined) Object.assign(next, update.$set as Document)
  if (update.$inc !== undefined)
    for (const [field, amount] of Object.entries(update.$inc as Record<string, number>))
      next[field] = (typeof next[field] === 'number' ? next[field] : 0) + amount
  if (update.$unset !== undefined)
    for (const field of Object.keys(update.$unset as Document)) delete next[field]
  return next
}

const makeDatabase = (): MongoDb => {
  const documents = new Map<string, Document>()
  const handles = new Map<string, MongoCollection>()
  const collection = (name: string): MongoCollection => {
    const existing = handles.get(name)
    if (existing !== undefined) return existing
    const rows = () =>
      [...documents.entries()].filter(([, document]) => document.__collection === name)
    const handle: MongoCollection = {
      find: (filter = {}, options) => ({
        toArray: async () => {
          const sort = (options as { readonly sort?: Record<string, number> } | undefined)?.sort
          const sorted = rows()
            .map(([, document]) => document)
            .filter((document) => matches(document, filter as Filter))
            .sort((left, right) => {
              for (const [field, direction] of Object.entries(sort ?? {})) {
                const first = valueAt(left, field)
                const second = valueAt(right, field)
                if (first === second) continue
                return (first as number) < (second as number) ? -direction : direction
              }
              return 0
            })
          const limit = (options as { readonly limit?: number } | undefined)?.limit
          return limit === undefined ? sorted : sorted.slice(0, limit)
        }
      }),
      findOne: async (filter, options) => {
        const result = await handle.find(filter, options).toArray()
        return result[0] ?? null
      },
      findOneAndUpdate: async (filter, update, options) => {
        const selected = rows().find(([, document]) => matches(document, filter as Filter))
        const inserting = selected === undefined
        if (inserting && (options as { readonly upsert?: boolean } | undefined)?.upsert !== true)
          return null
        const equality = Object.fromEntries(
          Object.entries(filter as Filter).filter(
            ([, value]) => value === null || typeof value !== 'object'
          )
        )
        const next = applyUpdate(selected?.[1] ?? equality, update as Document, inserting)
        next.__collection = name
        if (next._id === undefined) next._id = String((filter as Filter)._id)
        if (selected !== undefined) documents.delete(selected[0])
        documents.set(`${name}:${String(next._id)}`, next)
        return { ...next }
      },
      updateOne: async (filter, update, options) => {
        const selected = rows().find(([, document]) => matches(document, filter as Filter))
        if (selected === undefined) {
          if ((options as { readonly upsert?: boolean } | undefined)?.upsert !== true)
            return { matchedCount: 0 }
          const equality = Object.fromEntries(
            Object.entries(filter as Filter).filter(
              ([, value]) => value === null || typeof value !== 'object'
            )
          )
          const next = applyUpdate(equality, update as Document, true)
          next.__collection = name
          if (next._id === undefined) next._id = String((filter as Filter)._id)
          documents.set(`${name}:${String(next._id)}`, next)
          return { matchedCount: 0 }
        }
        const next = applyUpdate(selected[1], update as Document, false)
        next.__collection = name
        documents.set(selected[0], next)
        return { matchedCount: 1 }
      },
      insertOne: async (document) => {
        const key = `${name}:${String((document as Document)._id)}`
        if (documents.has(key)) throw Object.assign(new Error('duplicate'), { code: 11000 })
        documents.set(key, { ...(document as Document), __collection: name })
      },
      deleteOne: async (filter) => {
        const selected = rows().find(([, document]) => matches(document, filter as Filter))
        if (selected === undefined) return { deletedCount: 0 }
        documents.delete(selected[0])
        return { deletedCount: 1 }
      },
      deleteMany: async (filter) => {
        for (const [key, document] of rows())
          if (matches(document, filter as Filter)) documents.delete(key)
      },
      createIndexes: async () => undefined,
      aggregate: () => ({ toArray: async () => [] })
    }
    handles.set(name, handle)
    return handle
  }
  const session: MongoSession = {
    withTransaction: async (callback) => callback(),
    endSession: () => undefined
  }
  return {
    collection,
    admin: () => ({ command: async () => ({ logicalSessionTimeoutMinutes: 30, setName: 'rs0' }) }),
    createCollection: async () => undefined,
    command: async () => undefined,
    client: { startSession: () => session, close: async () => undefined }
  }
}

const resolve = async <Value>(operation: JobStoreOperation<Value>): Promise<Value> => {
  const result = await operation
  if (Result.isError(result)) throw result.error
  return result.value
}

let runtime: Awaited<ReturnType<typeof Runtime.make>> | undefined

afterEach(async () => {
  await runtime?.dispose()
  runtime = undefined
})

test('MongoDB controls persist dispatch keys and enforce v3 lifecycle semantics', async () => {
  const db = makeDatabase()
  const namespace = `controlled-${Math.random().toString(36).slice(2)}`
  await MongoJobStore.migrate({ db })
  runtime = await Runtime.make(
    MongoJobStore.layer({ db, namespace, validateLayout: false, notifications: 'poll' })
  )
  const store = await runtime.run(() => ServiceRuntime.resolve(JobStore))
  const controlled = store as typeof store & ControlledJobStoreContract
  expect(store.descriptor.capabilities.globalConcurrency).toBe(true)
  expect(store.descriptor.capabilities.rateLimiting).toBe(true)
  const queue = Queue.define('controlled-mongodb')
  const controls = QueueControls.define(queue, {
    globalConcurrency: 2,
    concurrencyKey: { derive: (payload: { readonly tenant: string }) => payload.tenant, max: 1 },
    rateLimit: { max: 2, durationMs: 100 }
  })
  const registry = QueueControls.registry({ group: 'mongodb-tests', controls: [controls] })
  const report = await resolve(controlled.reconcile(registry))
  expect(report.created[0]?.revision).toBe(1)

  const identity = { queue: 'controlled-mongodb', name: 'work', version: 1 } as const
  const first = await resolve(
    store.enqueue({
      job: identity,
      payload: { tenant: 'a' },
      dispatchKey: 'a',
      runAt: 0,
      attemptsMax: 1,
      now: 0
    })
  )
  const second = await resolve(
    store.enqueue({
      job: identity,
      payload: { tenant: 'b' },
      dispatchKey: 'b',
      runAt: 0,
      attemptsMax: 1,
      now: 0
    })
  )
  expect((await resolve(store.getJob({ jobId: first.job.id })))?.dispatchKey).toBe('a')

  const claimed = await resolve(
    controlled.claimControlled({
      queue: 'controlled-mongodb' as never,
      accepted: [identity],
      limit: 2,
      workerId: 'worker-a' as never,
      leaseDurationMs: 10,
      now: 0,
      controlsRevision: 1
    })
  )
  expect(claimed.jobs.map((job) => job.id)).toEqual([first.job.id, second.job.id])

  const blocked = await resolve(
    controlled.claimControlled({
      queue: 'controlled-mongodb' as never,
      accepted: [identity],
      limit: 1,
      workerId: 'worker-b' as never,
      leaseDurationMs: 10,
      now: 0,
      controlsRevision: 1
    })
  )
  expect(blocked.reason).toBe('global-concurrency')

  const collections = mongoCollections(db, 'better_effect_mq')
  expect(await collections.permits.find({ namespace }).toArray()).toHaveLength(2)

  const stale = await controlled.releaseControlled({
    jobId: first.job.id,
    leaseToken: 'stale-token' as never,
    now: 1,
    controlsRevision: 1
  })
  expect(Result.isError(stale)).toBe(true)

  const settled = await resolve(
    controlled.settleControlled({
      jobId: first.job.id,
      leaseToken: claimed.jobs[0]!.leaseToken,
      outcome: { type: 'complete' },
      now: 2,
      controlsRevision: 1
    })
  )
  expect(settled.status).toBe('applied')
  expect(await collections.permits.find({ namespace, jobId: first.job.id }).toArray()).toHaveLength(
    0
  )

  await resolve(
    controlled.settleControlled({
      jobId: second.job.id,
      leaseToken: claimed.jobs[1]!.leaseToken,
      outcome: { type: 'complete' },
      now: 3,
      controlsRevision: 1
    })
  )
  const third = await resolve(
    store.enqueue({
      job: identity,
      payload: { tenant: 'c' },
      dispatchKey: 'c',
      runAt: 0,
      attemptsMax: 1,
      now: 3
    })
  )
  const rateLimited = await resolve(
    controlled.claimControlled({
      queue: 'controlled-mongodb' as never,
      accepted: [identity],
      limit: 1,
      workerId: 'worker-c' as never,
      leaseDurationMs: 10,
      now: 3,
      controlsRevision: 1
    })
  )
  expect(rateLimited.reason).toBe('rate-limited')
  expect(rateLimited.nextEligibleAtMs).toBe(100)

  const windowClaim = await resolve(
    controlled.claimControlled({
      queue: 'controlled-mongodb' as never,
      accepted: [identity],
      limit: 1,
      workerId: 'worker-c' as never,
      leaseDurationMs: 10,
      now: 100,
      controlsRevision: 1
    })
  )
  expect(windowClaim.jobs[0]?.id).toBe(third.job.id)
  const recovered = await resolve(
    controlled.recoverStalledControlled({
      queue: 'controlled-mongodb' as never,
      maxStalledCount: 1,
      limit: 1,
      now: 111,
      controlsRevision: 1
    })
  )
  expect(recovered.recovered).toBe(1)
  expect(await collections.permits.find({ namespace }).toArray()).toHaveLength(0)

  const changedControls = QueueControls.define(queue, {
    globalConcurrency: 1,
    concurrencyKey: { derive: (payload: { readonly tenant: string }) => payload.tenant, max: 1 },
    rateLimit: { max: 2, durationMs: 100 }
  })
  const changed = await resolve(
    controlled.reconcile(
      QueueControls.registry({ group: 'mongodb-tests', controls: [changedControls] })
    )
  )
  expect(changed.updated[0]?.revision).toBe(2)
  const staleRevision = await controlled.claimControlled({
    queue: 'controlled-mongodb' as never,
    accepted: [identity],
    limit: 1,
    workerId: 'worker-d' as never,
    leaseDurationMs: 10,
    now: 111,
    controlsRevision: 1
  })
  expect(Result.isError(staleRevision)).toBe(true)

  const legacy = await store.claim({
    queue: 'controlled-mongodb' as never,
    accepted: [identity],
    limit: 1,
    workerId: 'legacy' as never,
    leaseDurationMs: 10,
    now: 2
  })
  expect(Result.isError(legacy)).toBe(true)

  const revision = await resolve(controlled.getControls({ queue: 'controlled-mongodb' as never }))
  expect(revision?.revision).toBe(2)
  expect(second.job.dispatchKey).toBe('b')
})
