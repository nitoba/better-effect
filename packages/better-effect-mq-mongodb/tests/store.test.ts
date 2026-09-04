// oxlint-disable anti-slop/no-chained-type-assertions -- source-only tests install a deliberately minimal Mongo driver facade.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- the facade is structurally constrained by each test assertion.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- the fake BSON driver intentionally accepts dynamic query documents.
// oxlint-disable anti-slop/no-object-parameters -- the fake driver mirrors the optional peer's erased query boundary.
// oxlint-disable typescript/await-thenable -- Bun's rejection matcher is Promise-compatible at runtime.

import { describe, expect, test } from 'bun:test'
import { makeJobId, makeLeaseToken, makeQueueName, makeWorkerId } from 'better-effect-mq'
import { MongoJobStoreImplementation } from '../src/store'

const namespace = 'unit'
const jobId = makeJobId('unit-job').unwrap()
const token = makeLeaseToken('11111111-1111-4111-8111-111111111111').unwrap()
const queue = makeQueueName('unit').unwrap()
type UpdateDocument = { readonly $set?: { readonly processedAtMs?: unknown } }

const job = (overrides: Record<string, unknown> = {}) => ({
  _id: `${namespace}\0${jobId}`,
  namespace,
  id: jobId,
  identity: JSON.stringify([queue, 'unitJob', 1]),
  queue,
  name: 'unitJob',
  version: 1,
  state: 'active',
  payload: {},
  metadataEntries: [],
  priority: 0,
  runAtMs: 0,
  orderSequence: 1,
  attemptsMax: 1,
  attemptsMade: 0,
  attemptSequence: 0,
  deliveryCount: 1,
  stalledCount: 0,
  createdAtMs: 0,
  updatedAtMs: 0,
  leaseOwner: 'worker',
  leaseToken: token,
  leaseExpiresAtMs: 10,
  cancelRequested: false,
  ledgerCount: 0,
  ...overrides
})

const implementation = (collections: Record<string, object>, ownsClient = false) =>
  new MongoJobStoreImplementation({
    namespace,
    collectionPrefix: 'better_effect_mq',
    ownsClient,
    dispose: async () => undefined,
    client: {
      startSession: () => ({
        withTransaction: async <T>(run: () => Promise<T>) => run(),
        endSession: async () => undefined
      })
    },
    db: { collection: (name: string) => collections[name] },
    validateLayout: false,
    notifications: 'poll'
  } as never)

const unused = {
  find: () => ({ toArray: async () => [] }),
  findOne: async () => null,
  findOneAndUpdate: async () => null,
  updateOne: async () => ({ matchedCount: 1 }),
  insertOne: async () => undefined,
  deleteOne: async () => ({ deletedCount: 1 }),
  deleteMany: async () => undefined,
  createIndexes: async () => undefined,
  aggregate: () => ({ toArray: async () => [] })
}

describe('MongoDB document-store regressions', () => {
  test('rejects heartbeat lease-expiry overflow before issuing an update', async () => {
    let updates = 0
    const store = implementation({
      better_effect_mq_jobs: { ...unused, findOneAndUpdate: async () => (updates += 1) },
      better_effect_mq_attempts: unused,
      better_effect_mq_queues: unused,
      better_effect_mq_counters: unused,
      better_effect_mq_migrations: unused
    })
    const result = await store.heartbeat({
      leases: [{ jobId, leaseToken: token }],
      leaseDurationMs: 1,
      now: Number.MAX_SAFE_INTEGER
    })
    expect(result.isErr()).toBe(true)
    expect(updates).toBe(0)
  })

  test('reports an expired cancelled lease as lost', async () => {
    const expired = job({
      cancellationRequestedAtMs: 1,
      cancelRequested: true,
      leaseExpiresAtMs: 10,
      updatedAtMs: 1
    })
    const store = implementation({
      better_effect_mq_jobs: {
        ...unused,
        findOneAndUpdate: async () => null,
        findOne: async () => expired
      },
      better_effect_mq_attempts: unused,
      better_effect_mq_queues: unused,
      better_effect_mq_counters: unused,
      better_effect_mq_migrations: unused
    })
    const result = await store.heartbeat({
      leases: [{ jobId, leaseToken: token }],
      leaseDurationMs: 1,
      now: 10
    })
    if (result.isErr()) throw result.error
    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value.cancellationRequested).toEqual([])
      expect(result.value.lost).toEqual([{ jobId, leaseToken: token, reason: 'expired-lease' }])
    }
  })

  test('propagates a candidate stalled-recovery transition failure', async () => {
    const invalidNow = job({ leaseExpiresAtMs: 5, updatedAtMs: 6 })
    const store = implementation({
      better_effect_mq_jobs: {
        ...unused,
        find: () => ({ toArray: async () => [invalidNow] }),
        findOne: async () => invalidNow
      },
      better_effect_mq_attempts: unused,
      better_effect_mq_queues: unused,
      better_effect_mq_counters: unused,
      better_effect_mq_migrations: unused
    })
    const result = await store.recoverStalled({ maxStalledCount: 1, limit: 1, now: 5 })
    expect(result.isErr()).toBe(true)
  })

  test('uses the claim reducer instead of writing processedAt directly', async () => {
    let candidateReads = 0
    let update: UpdateDocument | undefined
    const waiting = job({
      state: 'waiting',
      deliveryCount: 0,
      leaseOwner: undefined,
      leaseToken: undefined,
      leaseExpiresAtMs: undefined,
      processedAtMs: undefined
    })
    const store = implementation({
      better_effect_mq_jobs: {
        ...unused,
        findOne: async (filter: Record<string, unknown>) => {
          if ('_id' in filter) return waiting
          candidateReads += 1
          return candidateReads === 1 ? waiting : null
        },
        updateOne: async (_filter: object, value: UpdateDocument) => {
          update = value
          return { matchedCount: 1 }
        }
      },
      better_effect_mq_attempts: unused,
      better_effect_mq_queues: {
        ...unused,
        findOne: async () => ({ _id: `${namespace}\0${queue}`, wakeVersion: 1, paused: false }),
        updateOne: async () => ({ matchedCount: 1 })
      },
      better_effect_mq_counters: {
        ...unused,
        findOneAndUpdate: async () => ({ value: { value: 2 } })
      },
      better_effect_mq_migrations: unused
    })
    const result = await store.claim({
      queue,
      accepted: [{ queue, name: 'unitJob', version: 1 }],
      limit: 1,
      workerId: makeWorkerId('worker').unwrap(),
      leaseDurationMs: 10,
      now: 1
    })
    expect(result.isOk()).toBe(true)
    expect(update).toBeDefined()
    if (update === undefined) throw new Error('claim did not persist a document update')
    expect(update.$set?.processedAtMs).toBeUndefined()
  })

  test('resolves a duplicate enqueue only after its transaction aborts', async () => {
    let reads = 0
    let inserts = 0
    let inTransaction = false
    const existing = job({
      state: 'waiting',
      deliveryCount: 0,
      leaseOwner: undefined,
      leaseToken: undefined,
      leaseExpiresAtMs: undefined
    })
    const store = implementation({
      better_effect_mq_jobs: {
        ...unused,
        findOne: async () => {
          reads += 1
          if (reads === 2) expect(inTransaction).toBe(false)
          return reads === 1 ? null : existing
        },
        insertOne: async () => {
          inserts += 1
          throw { code: 11000 }
        }
      },
      better_effect_mq_attempts: unused,
      better_effect_mq_queues: unused,
      better_effect_mq_counters: {
        ...unused,
        findOneAndUpdate: async () => ({ value: { value: 2 } })
      },
      better_effect_mq_migrations: unused
    })
    const raw = store as unknown as {
      client: {
        client: { startSession(): { withTransaction<T>(run: () => Promise<T>): Promise<T> } }
      }
    }
    raw.client.client.startSession = () => ({
      withTransaction: async <T>(run: () => Promise<T>) => {
        inTransaction = true
        try {
          return await run()
        } finally {
          inTransaction = false
        }
      },
      endSession: async () => undefined
    })
    const result = await store.enqueue({
      id: jobId,
      job: { queue, name: 'unitJob', version: 1 },
      payload: {},
      runAt: 0,
      attemptsMax: 1,
      now: 0
    })
    expect(result.isOk()).toBe(true)
    if (result.isOk()) expect(result.value.duplicate).toBe(true)
    expect(inserts).toBe(1)
  })

  test('attempts owned-client disposal after change-stream close fails', async () => {
    let clientClosed = false
    const store = implementation(
      {
        better_effect_mq_jobs: unused,
        better_effect_mq_attempts: unused,
        better_effect_mq_queues: unused,
        better_effect_mq_counters: unused,
        better_effect_mq_migrations: unused
      },
      true
    )
    const raw = store as unknown as {
      client: { dispose(): Promise<void> }
      stream: { close(): Promise<void> }
    }
    raw.client.dispose = async () => {
      clientClosed = true
    }
    raw.stream = { close: async () => Promise.reject(new Error('stream close failed')) }
    await expect(store.dispose()).rejects.toThrow('stream close failed')
    expect(clientClosed).toBe(true)
  })
})
