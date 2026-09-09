// oxlint-disable typescript/await-thenable -- PGlite and Bun declarations are Promise-compatible at runtime.

import { PGlite } from '@electric-sql/pglite'
import { expect, test } from 'bun:test'
import { Runtime, ServiceRuntime } from 'better-effect'
import { Result } from 'better-result'
import {
  makeOutboxRecord,
  OutboxConflictError,
  OutboxId,
  OutboxLeaseToken,
  OutboxWorkerId,
  validatePreparedEnqueue,
  type OutboxOperation,
  type OutboxStoreError
} from 'better-effect-mq-outbox'
import {
  PostgresClient,
  PostgresOutbox,
  type Pool,
  type PoolClient,
  type QueryResult
} from '../src'

type PGliteDatabase = Awaited<ReturnType<typeof PGlite.create>>

const makePool = async (): Promise<{ readonly database: PGliteDatabase; readonly pool: Pool }> => {
  const database = await PGlite.create('memory://')
  return {
    database,
    pool: {
      connect: async (): Promise<PoolClient> => ({
        query: async <Row>(
          text: string,
          values?: readonly unknown[]
        ): Promise<QueryResult<Row>> => {
          // SAFETY: PGlite returns rows and affectedRows for this PoolClient bridge.
          const result = (
            values === undefined && !/^\s*(SELECT|WITH)/iu.test(text)
              ? await database.exec(text).then(() => ({ rows: [] }))
              : values === undefined
                ? await database.query(text)
                : await database.query(text, [...values])
          ) as { readonly rows: readonly Row[]; readonly affectedRows?: number }
          return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length }
        },
        release: () => undefined
      })
    }
  }
}

const prepared = validatePreparedEnqueue({
  protocolVersion: 1,
  identity: { queue: 'jobs', name: 'send', version: 1 },
  payload: { value: 'first' },
  metadata: { source: 'test' },
  priority: 0,
  runAt: 0,
  attemptsMax: 3,
  now: 0
}).unwrap()

const makeRecord = (id: string, payload = prepared.payload) =>
  makeOutboxRecord({
    id: OutboxId.make(id).unwrap(),
    target: 'jobs-postgres',
    request: validatePreparedEnqueue({ ...prepared, payload }).unwrap(),
    nowMs: 0
  }).unwrap()

const resolve = async <Value, Failure extends OutboxStoreError>(
  operation: OutboxOperation<Value, Failure>
): Promise<Value> => {
  const result = await operation
  if (Result.isError(result)) throw result.error
  return result.value
}

test('PostgresOutbox.appendIn uses the caller transaction and is digest-idempotent', async () => {
  const { database, pool } = await makePool()
  const client = PostgresClient.fromPool({ pool, schema: 'outbox_atomicity' })
  await client.migrate({ appliedAtMs: 1 })
  const tx = await pool.connect()
  const first = makeRecord('order-1')
  try {
    await tx.query('BEGIN')
    await tx.query('CREATE TABLE domain_rows (id text PRIMARY KEY)')
    await tx.query('INSERT INTO domain_rows (id) VALUES ($1)', ['rollback'])
    await PostgresOutbox.appendIn(tx, first, { namespace: 'billing', schema: 'outbox_atomicity' })
    await tx.query('ROLLBACK')

    const rolledBack = await database.query(
      'SELECT count(*)::int AS count FROM "outbox_atomicity".better_effect_mq_outbox WHERE namespace = $1',
      ['billing']
    )
    expect(rolledBack.rows[0]?.count).toBe(0)

    await tx.query('BEGIN')
    const inserted = await PostgresOutbox.appendIn(tx, first, {
      namespace: 'billing',
      schema: 'outbox_atomicity'
    })
    const duplicate = await PostgresOutbox.appendIn(tx, first, {
      namespace: 'billing',
      schema: 'outbox_atomicity'
    })
    expect(inserted.duplicate).toBe(false)
    expect(duplicate.duplicate).toBe(true)
    await tx.query('COMMIT')

    await tx.query('BEGIN')
    await expect(
      PostgresOutbox.appendIn(tx, makeRecord('order-1', { value: 'changed' }), {
        namespace: 'billing',
        schema: 'outbox_atomicity'
      })
    ).rejects.toBeInstanceOf(OutboxConflictError)
    await tx.query('ROLLBACK')
  } finally {
    tx.release()
    await client.dispose()
    await database.close()
  }
})

test('PostgresOutbox.transaction commits the domain write and outbox record together', async () => {
  const { database, pool } = await makePool()
  const schema = 'outbox_transaction_success'
  const options = { namespace: 'billing', schema }
  const client = PostgresClient.fromPool({ pool, schema })
  await client.migrate({ appliedAtMs: 1 })
  await database.exec('CREATE TABLE domain_rows (id text PRIMARY KEY)')

  try {
    const result = await PostgresOutbox.transaction(
      pool,
      makeRecord('transaction-success'),
      async (tx) => {
        await tx.query('INSERT INTO domain_rows (id) VALUES ($1)', ['order-1'])
        return Result.ok('committed')
      },
      options
    )

    expect(Result.isError(result)).toBe(false)
    if (!Result.isError(result)) expect(result.value).toBe('committed')
    const domainRows = await database.query('SELECT count(*)::int AS count FROM domain_rows')
    const outboxRows = await database.query(
      'SELECT count(*)::int AS count FROM "outbox_transaction_success".better_effect_mq_outbox WHERE namespace = $1',
      ['billing']
    )
    expect(domainRows.rows[0]?.count).toBe(1)
    expect(outboxRows.rows[0]?.count).toBe(1)
  } finally {
    await client.dispose()
    await database.close()
  }
})

test('PostgresOutbox.transaction rolls back the domain write for a nominal Result.err', async () => {
  const { database, pool } = await makePool()
  const schema = 'outbox_transaction_domain_failure'
  const options = { namespace: 'billing', schema }
  const client = PostgresClient.fromPool({ pool, schema })
  await client.migrate({ appliedAtMs: 1 })
  await database.exec('CREATE TABLE domain_rows (id text PRIMARY KEY)')
  const domainFailure = new Error('domain rejected')

  try {
    const result = await PostgresOutbox.transaction(
      pool,
      makeRecord('transaction-domain-failure'),
      async (tx) => {
        await tx.query('INSERT INTO domain_rows (id) VALUES ($1)', ['order-2'])
        return Result.err(domainFailure)
      },
      options
    )

    expect(Result.isError(result)).toBe(true)
    if (Result.isError(result)) expect(result.error).toBe(domainFailure)
    const domainRows = await database.query('SELECT count(*)::int AS count FROM domain_rows')
    const outboxRows = await database.query(
      'SELECT count(*)::int AS count FROM "outbox_transaction_domain_failure".better_effect_mq_outbox WHERE namespace = $1',
      ['billing']
    )
    expect(domainRows.rows[0]?.count).toBe(0)
    expect(outboxRows.rows[0]?.count).toBe(0)
  } finally {
    await client.dispose()
    await database.close()
  }
})

test('PostgresOutbox.transaction rolls back when appending the outbox record fails', async () => {
  const { database, pool } = await makePool()
  const schema = 'outbox_transaction_append_failure'
  const options = { namespace: 'billing', schema }
  const client = PostgresClient.fromPool({ pool, schema })
  await client.migrate({ appliedAtMs: 1 })
  await database.exec('CREATE TABLE domain_rows (id text PRIMARY KEY)')

  try {
    await PostgresOutbox.transaction(
      pool,
      makeRecord('transaction-conflict'),
      async () => undefined,
      options
    )
    await expect(
      PostgresOutbox.transaction(
        pool,
        makeRecord('transaction-conflict', { value: 'changed' }),
        async (tx) => {
          await tx.query('INSERT INTO domain_rows (id) VALUES ($1)', ['order-3'])
          return Result.ok(undefined)
        },
        options
      )
    ).rejects.toBeInstanceOf(OutboxConflictError)

    const domainRows = await database.query('SELECT count(*)::int AS count FROM domain_rows')
    expect(domainRows.rows[0]?.count).toBe(0)
  } finally {
    await client.dispose()
    await database.close()
  }
})

test('PostgresOutbox.transaction always releases its client after callback failure', async () => {
  const { database, pool } = await makePool()
  const schema = 'outbox_transaction_cleanup'
  const client = PostgresClient.fromPool({ pool, schema })
  await client.migrate({ appliedAtMs: 1 })
  let releases = 0
  const trackedPool: Pool = {
    connect: async () => {
      const connection = await pool.connect()
      return {
        query: <Row>(text: string, values?: readonly unknown[]) =>
          connection.query<Row>(text, values),
        release: (error?: Error) => {
          releases += 1
          connection.release(error)
        }
      }
    }
  }
  const failure = new Error('callback failed')

  try {
    await expect(
      PostgresOutbox.transaction(
        trackedPool,
        makeRecord('transaction-cleanup'),
        async () => {
          throw failure
        },
        { namespace: 'billing', schema }
      )
    ).rejects.toBe(failure)
    expect(releases).toBe(1)
  } finally {
    await client.dispose()
    await database.close()
  }
})

test('PostgresOutbox redelivers expired leases during claim', async () => {
  const { database, pool } = await makePool()
  const client = PostgresClient.fromPool({ pool, schema: 'outbox_redelivery' })
  await client.migrate({ appliedAtMs: 1 })
  const store = PostgresOutbox.make({ pool, schema: 'outbox_redelivery', namespace: 'billing' })
  try {
    await resolve(store.append(makeRecord('order-redelivery')))
    const first = (
      await resolve(
        store.claim({
          owner: OutboxWorkerId.make('publisher-1').unwrap(),
          limit: 1,
          leaseDurationMs: 10,
          nowMs: 0
        })
      )
    )[0]
    if (first === undefined) throw new Error('missing first claim')

    const second = (
      await resolve(
        store.claim({
          owner: OutboxWorkerId.make('publisher-2').unwrap(),
          limit: 1,
          leaseDurationMs: 10,
          nowMs: 11
        })
      )
    )[0]
    expect(second?.id).toBe(first.id)
    expect(second?.attemptsMade).toBe(2)
    expect(second?.leaseToken).not.toBe(first.leaseToken)
  } finally {
    await store.dispose()
    await client.dispose()
    await database.close()
  }
})

test('PostgresOutbox conforms to the claim, lease, settlement, and inspection contract', async () => {
  const { database, pool } = await makePool()
  const client = PostgresClient.fromPool({ pool, schema: 'outbox_store' })
  await client.migrate({ appliedAtMs: 1 })
  const store = PostgresOutbox.make({ pool, schema: 'outbox_store', namespace: 'billing' })
  try {
    await resolve(store.append(makeRecord('order-2')))
    const first = (
      await resolve(
        store.claim({
          owner: OutboxWorkerId.make('publisher-1').unwrap(),
          limit: 1,
          leaseDurationMs: 10,
          nowMs: 0
        })
      )
    )[0]
    if (first === undefined) throw new Error('missing first claim')

    await expect(
      resolve(
        store.markPublished({
          id: first.id,
          leaseToken: OutboxLeaseToken.make('stale').unwrap(),
          nowMs: 1
        })
      )
    ).rejects.toThrow()

    await resolve(
      store.heartbeat({
        id: first.id,
        leaseToken: first.leaseToken,
        leaseDurationMs: 20,
        nowMs: 1
      })
    )
    const recovered = await resolve(store.recoverStalled({ maxCount: 1, nowMs: 30 }))
    expect(recovered[0]?.state).toBe('pending')

    const second = (
      await resolve(
        store.claim({
          owner: OutboxWorkerId.make('publisher-2').unwrap(),
          limit: 1,
          leaseDurationMs: 10,
          nowMs: 30
        })
      )
    )[0]
    if (second === undefined) throw new Error('missing recovered claim')
    const published = await resolve(
      store.markPublished({ id: second.id, leaseToken: second.leaseToken, nowMs: 31 })
    )
    const acknowledged = await resolve(
      store.markPublished({
        id: second.id,
        leaseToken: OutboxLeaseToken.make('lost-response').unwrap(),
        nowMs: 32
      })
    )
    expect(published.status).toBe('applied')
    expect(acknowledged.status).toBe('already-applied')
    expect((await resolve(store.get(second.id)))?.state).toBe('published')
    expect((await resolve(store.counts())).published).toBe(1)
    expect((await resolve(store.list({ state: 'published' }))).map((record) => record.id)).toEqual([
      second.id
    ])

    await resolve(store.append(makeRecord('order-3')))
    const retried = (
      await resolve(
        store.claim({
          owner: OutboxWorkerId.make('publisher-3').unwrap(),
          limit: 1,
          leaseDurationMs: 10,
          nowMs: 31
        })
      )
    )[0]
    if (retried === undefined) throw new Error('missing retry claim')
    const retryFailure = {
      kind: 'target-missing' as const,
      message: 'target unavailable',
      retryable: true,
      recordedAtMs: 31
    }
    await resolve(
      store.markRetry({
        id: retried.id,
        leaseToken: retried.leaseToken,
        nowMs: 32,
        runAtMs: 40,
        failure: retryFailure
      })
    )
    const failed = (
      await resolve(
        store.claim({
          owner: OutboxWorkerId.make('publisher-4').unwrap(),
          limit: 1,
          leaseDurationMs: 10,
          nowMs: 40
        })
      )
    )[0]
    if (failed === undefined) throw new Error('missing failed claim')
    await resolve(
      store.markFailed({
        id: failed.id,
        leaseToken: failed.leaseToken,
        nowMs: 41,
        failure: { ...retryFailure, retryable: false }
      })
    )
    expect((await resolve(store.counts())).failed).toBe(1)
  } finally {
    await store.dispose()
    await client.dispose()
    await database.close()
  }
})

test('PostgresOutbox layers provide only the requested default or named token', async () => {
  const { database, pool } = await makePool()
  const client = PostgresClient.fromPool({ pool, schema: 'outbox_layers' })
  await client.migrate({ appliedAtMs: 1 })
  const Named = PostgresOutbox.named('named')
  const runtime = await Runtime.make(
    PostgresOutbox.layer({ pool, schema: 'outbox_layers', namespace: 'billing' })
  )
  const namedRuntime = await Runtime.make(
    PostgresOutbox.layerFor(Named, { pool, schema: 'outbox_layers', namespace: 'billing' })
  )
  try {
    const defaultStore = await runtime.run(() => ServiceRuntime.resolve(PostgresOutbox))
    const namedStore = await namedRuntime.run(() => ServiceRuntime.resolve(Named))
    expect(defaultStore.descriptor.adapter).toBe('postgres')
    expect(namedStore.descriptor.adapter).toBe('postgres')
    await expect(namedRuntime.run(() => ServiceRuntime.resolve(PostgresOutbox))).rejects.toThrow()
    await expect(runtime.run(() => ServiceRuntime.resolve(Named))).rejects.toThrow()
  } finally {
    await runtime.dispose()
    await namedRuntime.dispose()
    await client.dispose()
    await database.close()
  }
})
