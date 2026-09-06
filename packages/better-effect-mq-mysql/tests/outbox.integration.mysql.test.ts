// oxlint-disable typescript/await-thenable -- Bun's rejection matchers are thenable at runtime.

import { createPool, type Pool as MySqlPool } from 'mysql2/promise'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { Layer, Runtime, ServiceRuntime } from 'better-effect'
import { Result } from 'better-result'
import {
  OutboxConflictError,
  OutboxId,
  OutboxWorkerId,
  makeOutboxRecord,
  validatePreparedEnqueue,
  type OutboxOperation,
  type OutboxStoreError
} from 'better-effect-mq-outbox'
import { MYSQL_TABLES, MySqlClient, MySqlOutbox, MySqlOutboxStore, OutboxStore } from '../src'

const uri = process.env.MYSQL_URL
const namespace = `mysql_outbox_${process.pid}`
let pool: MySqlPool | undefined

const resolve = async <Value, Failure extends OutboxStoreError>(
  operation: OutboxOperation<Value, Failure>
): Promise<Value> => {
  const result = await operation
  if (Result.isError(result)) throw result.error
  return result.value
}

const request = validatePreparedEnqueue({
  protocolVersion: 1,
  identity: { queue: 'billing', name: 'invoice', version: 1 },
  payload: { invoiceId: 'integration' },
  metadata: { tenant: 'acme' },
  priority: 0,
  runAt: 0,
  attemptsMax: 3,
  now: 0
}).unwrap()

const record = (id: string, payload = request.payload) =>
  makeOutboxRecord({
    id: OutboxId.make(id).unwrap(),
    target: 'jobs-mysql',
    request: validatePreparedEnqueue({ ...request, payload }).unwrap(),
    nowMs: 0
  }).unwrap()

const configuredPool = (): MySqlPool => {
  if (pool === undefined) throw new Error('MYSQL_URL did not initialize a pool')
  return pool
}

const appendCommitted = async (value: ReturnType<typeof record>): Promise<void> => {
  const connection = await configuredPool().getConnection()
  try {
    await connection.beginTransaction()
    const result = await MySqlOutbox.appendIn(connection, value, { namespace })
    if (Result.isError(result)) throw result.error
    await connection.commit()
  } catch (cause) {
    await connection.rollback()
    throw cause
  } finally {
    connection.release()
  }
}

const integration = uri === undefined ? test.skip : test

describe('MySQL durable outbox on MySQL 8.0.16+', () => {
  beforeAll(async () => {
    if (uri === undefined) return
    pool = createPool({ uri, connectionLimit: 8 })
    await MySqlClient.fromPool({ pool: configuredPool(), namespace }).migrate()
  }, 30_000)

  afterAll(async () => {
    if (pool === undefined) return
    await pool.end()
  })
  afterEach(async () => {
    if (pool !== undefined)
      await pool.query(`DELETE FROM ${MYSQL_TABLES.outbox} WHERE namespace=?`, [namespace])
  })

  integration(
    'appends atomically and converges duplicate/conflicting records',
    async () => {
      const first = record(`invoice:${process.pid}:first`)
      await appendCommitted(first)

      const duplicateConnection = await configuredPool().getConnection()
      await duplicateConnection.beginTransaction()
      const duplicateResult = await MySqlOutbox.appendIn(duplicateConnection, first, { namespace })
      await duplicateConnection.commit()
      duplicateConnection.release()
      expect(Result.isOk(duplicateResult)).toBe(true)
      if (Result.isError(duplicateResult)) return
      expect(duplicateResult.value.duplicate).toBe(true)

      const conflicting = record(first.id, { invoiceId: 'conflict' })
      const connection = await configuredPool().getConnection()
      try {
        await connection.beginTransaction()
        const conflict = await MySqlOutbox.appendIn(connection, conflicting, { namespace })
        expect(Result.isError(conflict)).toBe(true)
        if (Result.isOk(conflict)) return
        expect(OutboxConflictError.is(conflict.error)).toBe(true)
        await connection.rollback()
      } finally {
        connection.release()
      }

      const rolledBack = record(`invoice:${process.pid}:rollback`)
      const rollbackConnection = await configuredPool().getConnection()
      await rollbackConnection.beginTransaction()
      const appended = await MySqlOutbox.appendIn(rollbackConnection, rolledBack, { namespace })
      expect(Result.isOk(appended)).toBe(true)
      await rollbackConnection.rollback()
      rollbackConnection.release()

      const runtime = await Runtime.make(
        MySqlOutboxStore.layer({ pool: configuredPool(), namespace, validateSchema: false })
      )
      try {
        const store = await runtime.run(() => ServiceRuntime.resolve(OutboxStore))
        expect(await resolve(store.get(rolledBack.id))).toBeUndefined()
      } finally {
        await runtime.dispose()
      }
    },
    30_000
  )

  integration(
    'fences old workers and supports heartbeat, recovery, settlement, and admin reads',
    async () => {
      const first = record(`invoice:${process.pid}:fenced`)
      const second = record(`invoice:${process.pid}:recovery`)
      await appendCommitted(first)
      await appendCommitted(second)

      const runtime = await Runtime.make(
        Layer.merge(
          MySqlOutboxStore.layer({ pool: configuredPool(), namespace, validateSchema: false }),
          MySqlOutboxStore.layerFor(OutboxStore.named('named'), {
            pool: configuredPool(),
            namespace,
            validateSchema: false
          })
        )
      )
      try {
        const store = await runtime.run(() => ServiceRuntime.resolve(OutboxStore))
        const owner1 = OutboxWorkerId.make('mysql-owner-1').unwrap()
        const owner2 = OutboxWorkerId.make('mysql-owner-2').unwrap()
        const firstLease = (
          await resolve(store.claim({ owner: owner1, limit: 1, leaseDurationMs: 10, nowMs: 0 }))
        )[0]
        if (firstLease === undefined) throw new Error('missing first lease')
        const heartbeat = await resolve(
          store.heartbeat({
            id: firstLease.id,
            leaseToken: firstLease.leaseToken,
            leaseDurationMs: 20,
            nowMs: 1
          })
        )
        expect(heartbeat.leaseExpiresAtMs).toBe(21)

        const redelivered = (
          await resolve(store.claim({ owner: owner2, limit: 1, leaseDurationMs: 10, nowMs: 22 }))
        )[0]
        if (redelivered === undefined) throw new Error('missing redelivery')
        expect(redelivered.id).toBe(firstLease.id)
        await expect(
          resolve(
            store.markPublished({ id: firstLease.id, leaseToken: firstLease.leaseToken, nowMs: 22 })
          )
        ).rejects.toBeInstanceOf(Error)
        expect(
          (
            await resolve(
              store.markPublished({
                id: redelivered.id,
                leaseToken: redelivered.leaseToken,
                nowMs: 22
              })
            )
          ).status
        ).toBe('applied')

        const secondLease = (
          await resolve(store.claim({ owner: owner1, limit: 1, leaseDurationMs: 1, nowMs: 0 }))
        )[0]
        if (secondLease === undefined) throw new Error('missing second lease')
        const recovered = await resolve(store.recoverStalled({ maxCount: 1, nowMs: 2 }))
        expect(
          recovered.some((value) => value.id === secondLease.id && value.state === 'pending')
        ).toBe(true)
        const counts = await resolve(store.counts())
        expect(counts.total).toBe(2)
        expect(
          (await resolve(store.list({ state: 'published' }))).map((value) => value.id)
        ).toContain(first.id)
      } finally {
        await runtime.dispose()
      }
    },
    30_000
  )
})
