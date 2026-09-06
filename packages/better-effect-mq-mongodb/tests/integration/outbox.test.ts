// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- test-only driver boundary casts are validated by the fixture types.
// oxlint-disable typescript/await-thenable -- Bun matcher declarations are synchronous while runtime matchers await.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Runtime, ServiceRuntime } from 'better-effect'
import { Result } from 'better-result'
import { MongoClient } from 'mongodb'
import {
  OutboxId,
  OutboxStore,
  OutboxWorkerId,
  makeOutboxRecord,
  makeSerializedOutboxFailure,
  validatePreparedEnqueue,
  type OutboxAppendResult,
  type OutboxOperation,
  type OutboxRecord,
  type OutboxRecordInput,
  type OutboxStoreError
} from 'better-effect-mq-outbox'
import { MongoJobStore, MongoOutbox, MongoOutboxStore, type MongoDb } from '../../src/index'

const uri = process.env.MONGODB_URL
const integration = uri === undefined ? test.skip : test
const databaseName = process.env.MONGODB_DATABASE ?? `better_effect_mq_outbox_${process.pid}`
const collectionPrefix = `better_effect_mq_outbox_${process.pid}`
const namespace = `outbox_integration_${process.pid}`
let client: MongoClient | undefined

const database = (): MongoDb => {
  if (client === undefined) throw new Error('MongoDB integration client is not initialized')
  return client.db(databaseName)
}

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

const makeRecord = (
  id: string,
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

const resolve = async <Value, Failure extends OutboxStoreError>(
  operation: OutboxOperation<Value, Failure>
): Promise<Value> => {
  const result = await operation
  if (Result.isError(result)) throw result.error
  return result.value
}

const appendInTransaction = async (record: OutboxRecord): Promise<void> => {
  const current = client
  if (current === undefined) throw new Error('MongoDB integration client is not initialized')
  const session = current.startSession()
  try {
    await session.withTransaction(async () => {
      const result = await MongoOutbox.appendIn(session, record, {
        db: database(),
        namespace,
        collectionPrefix
      })
      if (Result.isError(result)) throw result.error
    })
  } finally {
    await session.endSession()
  }
}

describe('MongoDB durable outbox on a replica set', () => {
  beforeAll(async () => {
    if (uri === undefined) return
    client = new MongoClient(uri, { directConnection: true })
    await client.connect()
    await MongoJobStore.migrate({ db: database(), collectionPrefix })
  }, 30_000)

  afterAll(async () => {
    if (client === undefined) return
    await client.db(databaseName).collection(`${collectionPrefix}_outbox`).deleteMany({ namespace })
    await client.close()
  }, 30_000)

  integration(
    'supports transactional append, fencing, recovery, settlement, and inspection',
    async () => {
      await database().collection(`${collectionPrefix}_outbox`).deleteMany({ namespace })
      const first = makeRecord('first')
      await appendInTransaction(first)

      const current = client
      if (current === undefined) throw new Error('MongoDB integration client is not initialized')
      const rollback = makeRecord('rollback')
      const rollbackSession = current.startSession()
      try {
        await expect(
          rollbackSession.withTransaction(async () => {
            const result = await MongoOutbox.appendIn(rollbackSession, rollback, {
              db: database(),
              namespace,
              collectionPrefix
            })
            if (Result.isError(result)) throw result.error
            throw new Error('rollback append')
          })
        ).rejects.toThrow('rollback append')
      } finally {
        await rollbackSession.endSession()
      }

      const runtime = await Runtime.make(
        MongoOutboxStore.layer({ db: database(), namespace, collectionPrefix })
      )
      try {
        const store = await runtime.run(() => ServiceRuntime.resolve(OutboxStore))
        expect(await resolve(store.get(rollback.id))).toBeUndefined()

        const duplicateSession = current.startSession()
        try {
          const duplicate = await duplicateSession.withTransaction(async () =>
            MongoOutbox.appendIn(duplicateSession, first, {
              db: database(),
              namespace,
              collectionPrefix
            })
          )
          expect(Result.isOk(duplicate)).toBe(true)
          if (Result.isError(duplicate)) throw duplicate.error
          expect(duplicate.value.duplicate).toBe(true)
        } finally {
          await duplicateSession.endSession()
        }

        const appendable = store as typeof store & {
          append(input: OutboxRecordInput): OutboxOperation<OutboxAppendResult>
        }
        await resolve(appendable.append(makeRecord('retry')))
        await resolve(
          appendable.append(
            makeRecord('z-recover', prepared.payload, { attemptsMax: 1, runAtMs: 20 })
          )
        )

        const claimed = (
          await resolve(
            store.claim({
              owner: OutboxWorkerId.make('integration-worker').unwrap(),
              limit: 1,
              leaseDurationMs: 10,
              nowMs: 0
            })
          )
        )[0]
        if (claimed === undefined) throw new Error('missing integration claim')
        const heartbeat = await resolve(
          store.heartbeat({
            id: claimed.id,
            leaseToken: claimed.leaseToken,
            leaseDurationMs: 20,
            nowMs: 1
          })
        )
        expect(heartbeat.leaseExpiresAtMs).toBe(21)
        expect(
          (
            await resolve(
              store.markPublished({
                id: claimed.id,
                leaseToken: heartbeat.leaseToken,
                nowMs: 2
              })
            )
          ).status
        ).toBe('applied')

        const retryClaim = (
          await resolve(
            store.claim({
              owner: OutboxWorkerId.make('retry-worker').unwrap(),
              limit: 1,
              leaseDurationMs: 10,
              nowMs: 0
            })
          )
        )[0]
        if (retryClaim === undefined) throw new Error('missing retry integration claim')
        const failure = makeSerializedOutboxFailure({
          kind: 'store-transient',
          message: 'temporary failure',
          retryable: true,
          recordedAtMs: 1
        }).unwrap()
        await resolve(
          store.markRetry({
            id: retryClaim.id,
            leaseToken: retryClaim.leaseToken,
            nowMs: 1,
            runAtMs: 10,
            failure
          })
        )
        const failedClaim = (
          await resolve(
            store.claim({
              owner: OutboxWorkerId.make('failed-worker').unwrap(),
              limit: 1,
              leaseDurationMs: 10,
              nowMs: 10
            })
          )
        )[0]
        if (failedClaim === undefined) throw new Error('missing failed integration claim')
        await resolve(
          store.markFailed({
            id: failedClaim.id,
            leaseToken: failedClaim.leaseToken,
            nowMs: 11,
            failure
          })
        )

        const recoveryClaim = (
          await resolve(
            store.claim({
              owner: OutboxWorkerId.make('recovery-worker').unwrap(),
              limit: 1,
              leaseDurationMs: 5,
              nowMs: 20
            })
          )
        )[0]
        if (recoveryClaim === undefined) throw new Error('missing recovery integration claim')
        const recovered = await resolve(store.recoverStalled({ maxCount: 1, nowMs: 25 }))
        expect(recovered).toHaveLength(1)
        expect(recovered[0]?.state).toBe('failed')

        const counts = await resolve(store.counts())
        expect(counts).toEqual({ pending: 0, active: 0, published: 1, failed: 2, total: 3 })
        expect((await resolve(store.list({ state: 'published' }))).map((item) => item.id)).toEqual([
          first.id
        ])
      } finally {
        await runtime.dispose()
      }
    }
  )
})
