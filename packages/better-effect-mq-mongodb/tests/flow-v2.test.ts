// oxlint-disable anti-slop/no-unsafe-dictionary-type -- this file models the MongoDB BSON boundary.
// oxlint-disable anti-slop/no-runtime-typeof -- the fake driver narrows untyped test documents.
// oxlint-disable anti-slop/no-unknown-returns -- the fake driver is intentionally opaque at the BSON boundary.
// oxlint-disable anti-slop/no-object-parameters -- the fake accepts MongoDB's broad driver options.
// oxlint-disable anti-slop/no-known-value-widening -- fake BSON updates are owned by this test driver.
// oxlint-disable anti-slop/no-conditional-empty-object-spread -- optional fake BSON fields model omission.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- casts stay inside the fake driver.
// oxlint-disable typescript/await-thenable -- Bun's rejection matcher is Promise-compatible at runtime.

import { expect, test } from 'bun:test'
import { Runtime, ServiceRuntime } from 'better-effect'
import { Result } from 'better-result'
import { flowStoreContract } from 'better-effect-mq/testing'
import {
  JobStore,
  makeFlowChildId,
  makeJobId,
  makeLeaseToken,
  makePreparedEnqueue,
  protocolVersion
} from 'better-effect-mq'
import type { MongoCollection, MongoDb, MongoSession } from '../src/config'
import * as MongoAdapter from '../src/index'

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

const sortDocuments = (documents: readonly Document[], options?: object): Document[] => {
  const sort = (options as { readonly sort?: Record<string, number> } | undefined)?.sort
  if (sort === undefined) return [...documents]
  return [...documents].sort((left, right) => {
    for (const [field, direction] of Object.entries(sort)) {
      const first = valueAt(left, field)
      const second = valueAt(right, field)
      if (first === second) continue
      const comparison = String(first).localeCompare(String(second))
      return Math.sign(comparison) * direction
    }
    return 0
  })
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
    const handle: MongoCollection = {
      find: (filter = {}, options) => ({
        toArray: async () => {
          const rows = sortDocuments(
            [...documents.values()].filter(
              (document) => document.__collection === name && matches(document, filter as Filter)
            ),
            options
          )
          const limit = (options as { readonly limit?: number } | undefined)?.limit
          return limit === undefined ? rows : rows.slice(0, limit)
        }
      }),
      findOne: async (filter, options) =>
        sortDocuments(
          [...documents.values()].filter(
            (document) => document.__collection === name && matches(document, filter as Filter)
          ),
          options
        )[0] ?? null,
      findOneAndUpdate: async (filter, update, options) => {
        const selected = sortDocuments(
          [...documents.values()].filter(
            (document) => document.__collection === name && matches(document, filter as Filter)
          ),
          options
        )[0]
        const inserting = selected === undefined
        if (inserting && (options as { readonly upsert?: boolean } | undefined)?.upsert !== true)
          return null
        const equality = Object.fromEntries(
          Object.entries(filter as Filter).filter(
            ([, value]) => value === null || typeof value !== 'object'
          )
        )
        const next = applyUpdate(selected ?? equality, update as Document, inserting)
        next.__collection = name
        if (next._id === undefined) next._id = String((filter as Filter)._id)
        documents.set(`${name}:${String(next._id)}`, next)
        return { ...next }
      },
      updateOne: async (filter, update, options) => {
        const entry = [...documents.entries()].find(
          ([, document]) => document.__collection === name && matches(document, filter as Filter)
        )
        if (entry === undefined) {
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
        const next = applyUpdate(entry[1], update as Document, false)
        next.__collection = name
        documents.set(entry[0], next)
        return { matchedCount: 1 }
      },
      insertOne: async (document) => {
        const key = `${name}:${String((document as Document)._id)}`
        if (documents.has(key)) throw Object.assign(new Error('duplicate'), { code: 11000 })
        documents.set(key, { ...(document as Document), __collection: name })
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

const seedParent = (
  db: MongoDb,
  namespace: string,
  flowId: string,
  leaseToken: string,
  parent?: Document,
  options: {
    readonly state?: 'active' | 'waiting'
    readonly stalledCount?: number
    readonly leaseExpiresAtMs?: number
  } = {}
): void => {
  const state = options.state ?? 'active'
  void db.collection('better_effect_mq_jobs').insertOne({
    _id: `${namespace}\u0000${flowId}`,
    namespace,
    id: flowId,
    identity: 'flow\u0000parent\u00001',
    queue: 'flow',
    name: 'parent',
    version: 1,
    state,
    payload: {},
    metadataEntries: [],
    priority: 0,
    runAtMs: 0,
    orderSequence: 1,
    attemptsMax: 2,
    attemptsMade: 0,
    attemptSequence: 0,
    deliveryCount: 1,
    stalledCount: options.stalledCount ?? 0,
    createdAtMs: 0,
    updatedAtMs: 0,
    ...(state === 'active'
      ? {
          leaseOwner: 'worker',
          leaseToken,
          leaseExpiresAtMs: options.leaseExpiresAtMs ?? 100
        }
      : {}),
    cancelRequested: false,
    ledgerCount: 0,
    ...(parent === undefined ? {} : { parent })
  })
}

test('exports the MongoDB FlowStore v2 surface and passes shared conformance', async () => {
  expect(typeof MongoAdapter.MongoFlowStore).toBe('object')
  const db = makeDatabase()
  const namespace = 'flow-contract'
  const suite = flowStoreContract({
    prefix: 'mongodb',
    makeStore: async (scenario) => {
      const store = await MongoAdapter.MongoFlowStore.make({
        db,
        namespace,
        validateLayout: false
      })
      if (scenario.id !== 'outbox-delivery') {
        const flowId = `flow-contract-${scenario.id}`
        const leaseToken = `lease-${scenario.id}`
        seedParent(db, namespace, flowId, leaseToken)
      }
      return store
    },
    dispose: async (store) => {
      await (store as typeof store & { dispose(): Promise<void> }).dispose()
    },
    createFlow: (_store, scenario, _input) => ({
      flowId: `flow-contract-${scenario.id}`,
      leaseToken: `lease-${scenario.id}`
    })
  })
  for (const scenario of suite) await scenario.run()
  expect(suite.report().failed).toEqual([])
})

test('MongoDB flow migration is additive and records an independent v2 marker', async () => {
  const db = makeDatabase()
  await MongoAdapter.MongoJobStore.migrate({ db })
  const result = await MongoAdapter.MongoFlowStore.migrate({ db })
  expect(result).toEqual({ version: 1, applied: true })
  expect(MongoAdapter.MONGODB_FLOW_PROTOCOL_VERSION).toBe(2)
  expect(MongoAdapter.MONGODB_FLOW_LAYOUT_VERSION).toBe(1)
})

test('MongoDB flow migration rejects an incompatible persisted marker', async () => {
  const db = makeDatabase()
  await MongoAdapter.MongoJobStore.migrate({ db })
  await db
    .collection('better_effect_mq_migrations')
    .updateOne(
      { _id: 'flow-layout' },
      { $set: { protocolVersion: 1, layoutVersion: 1 } },
      { upsert: true }
    )
  await expect(MongoAdapter.MongoFlowStore.migrate({ db })).rejects.toBeInstanceOf(
    MongoAdapter.MongoFlowProtocolMismatchError
  )
})

test('MongoDB FlowStore appends an atomic fan-out event once across an idempotent retry', async () => {
  const db = makeDatabase()
  const namespace = 'flow-events'
  const flowId = 'flow-events-parent'
  const leaseToken = 'flow-events-lease'
  seedParent(db, namespace, flowId, leaseToken)
  const writer = { id: 'mongodb-test', version: '1', canAppend: true } as const
  const store = await MongoAdapter.MongoFlowStore.make({
    db,
    namespace,
    validateLayout: false,
    eventWriter: writer
  })
  try {
    const childJobId = makeFlowChildId({
      parentStoreKey: 'flow-events-store',
      flowId: makeJobId(flowId).unwrap(),
      childKey: 'one'
    }).unwrap()
    const child = makePreparedEnqueue({
      protocolVersion,
      identity: { queue: 'flow-events', name: 'child', version: 1 },
      id: childJobId,
      payload: { child: 'one' },
      metadata: {},
      priority: 0,
      runAt: 0,
      attemptsMax: 1,
      now: 0
    }).unwrap()
    const request = {
      flowId: makeJobId(flowId).unwrap(),
      flowName: 'flow-events',
      parentStoreKey: 'flow-events-store',
      depth: 1,
      leaseToken: makeLeaseToken(leaseToken).unwrap(),
      failFast: false,
      children: [
        {
          childKey: 'one',
          name: 'child',
          version: 1,
          storeKey: 'flow-events-child-store',
          childJobId,
          request: child
        }
      ],
      now: 1
    }
    const applied = await store.fanOut(request)
    if (Result.isError(applied)) throw applied.error
    const retried = await store.fanOut(request)
    if (Result.isError(retried)) throw retried.error
    expect(retried.value.status).toBe('already-applied')
    const events = await db.collection('better_effect_mq_events').find({ namespace }).toArray()
    expect(events.map((event) => event.eventType)).toEqual(['flow-fan-out'])
  } finally {
    await store.dispose()
  }
})

test('MongoDB flow decoders reject malformed persisted child BSON', async () => {
  const db = makeDatabase()
  const namespace = 'codec-flow'
  const flowId = 'codec-parent'
  seedParent(db, namespace, flowId, 'codec-lease')
  await db.collection('better_effect_mq_jobs').updateOne(
    { _id: `${namespace}\u0000${flowId}` },
    {
      $set: {
        state: 'waiting-children',
        flow: {
          flowName: 'codec-flow',
          failFast: false,
          pending: 1,
          completed: 0,
          failed: 0,
          cancelled: 0
        },
        flowManifestDigest: 'codec-digest',
        flowLeaseToken: 'codec-lease',
        flowName: 'codec-flow',
        flowParentStoreKey: 'codec-parent-store',
        flowDepth: 1
      }
    }
  )
  await db.collection('better_effect_mq_flow_children').insertOne({
    _id: `${namespace}\u0000${flowId}\u0000one`,
    namespace,
    flowId,
    childKey: 'one',
    name: 'codec-child',
    version: 1,
    storeKey: 'codec-child-store',
    childJobId: 'codec-child-id',
    request: {},
    status: 'corrupt',
    cascaded: false,
    pendingSinceMs: 0
  })
  const store = await MongoAdapter.MongoFlowStore.make({ db, namespace, validateLayout: false })
  try {
    const result = await store.getFlow({ flowId: makeJobId(flowId).unwrap() })
    expect(Result.isError(result)).toBe(true)
  } finally {
    await store.dispose()
  }
})

test('MongoDB JobStore appends terminal child reports in the settlement transaction', async () => {
  const db = makeDatabase()
  await MongoAdapter.MongoJobStore.migrate({ db })
  await MongoAdapter.MongoFlowStore.migrate({ db })
  const namespace = 'runtime-flow'
  const flowId = 'runtime-parent'
  const childId = 'runtime-child'
  const leaseToken = 'runtime-child-lease'
  seedParent(db, namespace, childId, leaseToken, {
    flowName: 'runtime-flow',
    flowId,
    childKey: 'one',
    parentStoreKey: 'runtime-parent-store',
    depth: 1
  })
  const runtime = await Runtime.make(
    MongoAdapter.MongoJobStore.layer({
      db,
      namespace,
      validateLayout: true,
      notifications: 'poll'
    })
  )
  try {
    const store = await runtime.run(() => ServiceRuntime.resolve(JobStore))
    const settled = await store.settle({
      jobId: makeJobId(childId).unwrap(),
      leaseToken: makeLeaseToken(leaseToken).unwrap(),
      outcome: { type: 'complete', result: { value: 42 } },
      now: 1
    })
    if (Result.isError(settled)) throw settled.error
    expect(settled.value.status).toBe('applied')
    const outbox = await db
      .collection('better_effect_mq_flow_outbox')
      .findOne({ _id: `${namespace}\u0000flow-report/${childId}/1` })
    expect(outbox?.report).toMatchObject({
      flowId,
      childKey: 'one',
      outcome: 'completed'
    })

    const waitingId = 'runtime-waiting'
    const stalledId = 'runtime-stalled'
    seedParent(
      db,
      namespace,
      waitingId,
      'waiting-lease',
      {
        flowName: 'runtime-flow',
        flowId,
        childKey: 'waiting',
        parentStoreKey: 'runtime-parent-store',
        depth: 1
      },
      { state: 'waiting' }
    )
    seedParent(
      db,
      namespace,
      stalledId,
      'stalled-lease',
      {
        flowName: 'runtime-flow',
        flowId,
        childKey: 'stalled',
        parentStoreKey: 'runtime-parent-store',
        depth: 1
      },
      { stalledCount: 1, leaseExpiresAtMs: 0 }
    )
    const cancelled = await store.cancel({
      jobId: makeJobId(waitingId).unwrap(),
      now: 2
    })
    if (Result.isError(cancelled)) throw cancelled.error
    const recovered = await store.recoverStalled({ maxStalledCount: 1, now: 2 })
    if (Result.isError(recovered)) throw recovered.error
    expect(recovered.value.recovered).toBe(1)
    const reports = await db
      .collection('better_effect_mq_flow_outbox')
      .find({ namespace })
      .toArray()
    expect(reports.map((entry) => (entry.report as Document).outcome)).toEqual([
      'completed',
      'cancelled',
      'failed'
    ])
  } finally {
    await runtime.dispose()
  }
})
