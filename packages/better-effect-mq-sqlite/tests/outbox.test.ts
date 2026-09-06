import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { Layer, Runtime, ServiceRuntime } from 'better-effect'
import { Result } from 'better-result'
import {
  OutboxId,
  OutboxLeaseToken,
  OutboxStore,
  OutboxWorkerId,
  makeOutboxRecord,
  validatePreparedEnqueue,
  type OutboxOperation,
  type OutboxRecord
} from 'better-effect-mq-outbox'
import { SqliteMigrator, SqliteOutboxStore, SqliteOutboxTransactions } from '../src'

const databases: Database[] = []
const files: string[] = []

const resolve = async <Value>(operation: OutboxOperation<Value>): Promise<Value> => {
  const result = await operation
  if (Result.isError(result)) throw result.error
  return result.value
}

const request = validatePreparedEnqueue({
  protocolVersion: 1,
  identity: { queue: 'jobs', name: 'send', version: 1 },
  payload: { message: 'hello' },
  metadata: { tenant: 'acme' },
  priority: 0,
  runAt: 0,
  attemptsMax: 3,
  now: 0
}).unwrap()

const record = (id: string, overrides: Partial<OutboxRecord> = {}) =>
  makeOutboxRecord({
    id: OutboxId.make(id).unwrap(),
    target: 'jobs-sqlite',
    request,
    nowMs: 0,
    ...overrides
  }).unwrap()

const open = (): Database => {
  const database = new Database(':memory:')
  databases.push(database)
  SqliteMigrator.migrate({ database })
  return database
}

afterEach(async () => {
  for (const database of databases.splice(0)) database.close()
  await Promise.all(
    files
      .splice(0)
      .flatMap((path) => [path, `${path}-shm`, `${path}-wal`])
      .map((path) =>
        Bun.file(path)
          .delete()
          .catch(() => undefined)
      )
  )
})

test('appendIn participates in the caller transaction and does not commit it', async () => {
  const database = open()
  const store = SqliteOutboxStore.make({ database })

  database.exec('BEGIN IMMEDIATE')
  const inserted = SqliteOutboxTransactions.appendIn(database, record('rollback-me'))
  expect(inserted.isOk()).toBe(true)
  database.exec('ROLLBACK')

  expect(await resolve(store.get(OutboxId.make('rollback-me').unwrap()))).toBeUndefined()

  database.exec('BEGIN IMMEDIATE')
  const committed = SqliteOutboxStore.appendIn(database, record('commit-me'))
  expect(committed.isOk()).toBe(true)
  database.exec('COMMIT')
  expect((await resolve(store.get(OutboxId.make('commit-me').unwrap())))?.state).toBe('pending')
})

test('SQLite outbox append is idempotent and rejects a digest conflict', async () => {
  const database = open()
  const store = SqliteOutboxStore.make({ database })

  const first = await resolve(store.append(record('same-id')))
  const duplicate = await resolve(store.append(record('same-id')))
  expect(first.duplicate).toBe(false)
  expect(duplicate.duplicate).toBe(true)

  const conflicting = await store.append(
    makeOutboxRecord({
      id: OutboxId.make('same-id').unwrap(),
      target: 'jobs-sqlite',
      request: validatePreparedEnqueue({ ...request, payload: { message: 'different' } }).unwrap(),
      nowMs: 0
    }).unwrap()
  )
  expect(Result.isError(conflicting)).toBe(true)
})

test('SQLite outbox layers resolve default and named Service tokens', async () => {
  const database = open()
  const named = OutboxStore.named('billing')
  const runtime = await Runtime.make(
    Layer.merge(
      SqliteOutboxStore.layer({ database }),
      SqliteOutboxStore.layerFor(named, { database })
    )
  )
  try {
    const defaultStore = await runtime.run(() => ServiceRuntime.resolve(OutboxStore))
    const namedStore = await runtime.run(() => ServiceRuntime.resolve(named))
    expect(defaultStore.descriptor.adapter).toBe('sqlite')
    expect(namedStore.descriptor.adapter).toBe('sqlite')
    expect(await resolve(defaultStore.list())).toHaveLength(0)
    expect(await resolve(namedStore.list())).toHaveLength(0)
  } finally {
    await runtime.dispose()
  }
})

test('SQLite outbox fences heartbeat and settlement, and recovers stalled leases', async () => {
  const database = open()
  const store = SqliteOutboxStore.make({ database })
  await resolve(store.append(record('lease')))

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
  if (first === undefined) throw new Error('missing claim')

  const heartbeated = await resolve(
    store.heartbeat({
      id: first.id,
      leaseToken: first.leaseToken,
      leaseDurationMs: 20,
      nowMs: 5
    })
  )
  expect(heartbeated.leaseExpiresAtMs).toBe(25)

  const stale = await store.markPublished({
    id: first.id,
    leaseToken: OutboxLeaseToken.make('stale').unwrap(),
    nowMs: 6
  })
  expect(Result.isError(stale)).toBe(true)

  const published = await resolve(
    store.markPublished({ id: first.id, leaseToken: first.leaseToken, nowMs: 7 })
  )
  expect(published.status).toBe('applied')
  expect(
    (
      await resolve(
        store.markPublished({
          id: first.id,
          leaseToken: OutboxLeaseToken.make('response-retry').unwrap(),
          nowMs: 8
        })
      )
    ).status
  ).toBe('already-applied')

  await resolve(store.append(record('stalled')))
  const stalled = (
    await resolve(
      store.claim({
        owner: OutboxWorkerId.make('worker-2').unwrap(),
        limit: 1,
        leaseDurationMs: 10,
        nowMs: 0
      })
    )
  )[0]
  if (stalled === undefined) throw new Error('missing stalled claim')

  const recovered = await resolve(store.recoverStalled({ maxCount: 1, nowMs: 11 }))
  expect(recovered).toHaveLength(1)
  expect(recovered[0]?.state).toBe('pending')
  expect(recovered[0]?.leaseToken).toBeUndefined()

  await resolve(store.append(record('retry')))
  const retryClaim = (
    await resolve(
      store.claim({
        owner: OutboxWorkerId.make('worker-3').unwrap(),
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
      runAtMs: 20,
      nowMs: 1,
      failure: {
        kind: 'store-transient',
        message: 'temporary failure',
        retryable: true,
        recordedAtMs: 1
      }
    })
  )
  expect(retried.state).toBe('pending')
  expect(retried.failure?.kind).toBe('store-transient')

  const failedClaim = (
    await resolve(
      store.claim({
        owner: OutboxWorkerId.make('worker-3b').unwrap(),
        limit: 1,
        leaseDurationMs: 10,
        nowMs: 20
      })
    )
  )[0]
  if (failedClaim === undefined) throw new Error('missing failed claim')
  const failed = await resolve(
    store.markFailed({
      id: failedClaim.id,
      leaseToken: failedClaim.leaseToken,
      nowMs: 21,
      failure: {
        kind: 'store-permanent',
        message: 'permanent failure',
        retryable: false,
        recordedAtMs: 21
      }
    })
  )
  expect(failed.state).toBe('failed')

  await resolve(store.append(record('release')))
  const releaseClaim = (
    await resolve(
      store.claim({
        owner: OutboxWorkerId.make('worker-4').unwrap(),
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
})

test('two SQLite connections cannot claim the same outbox record', async () => {
  const path = `${Bun.env.TMPDIR ?? '/tmp'}/better-effect-mq-sqlite-outbox-${Bun.randomUUIDv7()}.sqlite`
  files.push(path)
  const firstDatabase = new Database(path)
  const secondDatabase = new Database(path)
  databases.push(firstDatabase, secondDatabase)
  SqliteMigrator.migrate({ database: firstDatabase })

  const first = SqliteOutboxStore.make({ database: firstDatabase })
  const second = SqliteOutboxStore.make({ database: secondDatabase })
  await resolve(first.append(record('cross-connection')))

  const [left, right] = await Promise.all([
    resolve(
      first.claim({
        owner: OutboxWorkerId.make('left').unwrap(),
        limit: 1,
        leaseDurationMs: 100,
        nowMs: 0
      })
    ),
    resolve(
      second.claim({
        owner: OutboxWorkerId.make('right').unwrap(),
        limit: 1,
        leaseDurationMs: 100,
        nowMs: 0
      })
    )
  ])
  expect(left.length + right.length).toBe(1)
})

describe('SQLite outbox administrative operations', () => {
  test('lists and counts records by state and target', async () => {
    const database = open()
    const store = SqliteOutboxStore.make({ database })
    await resolve(store.append(record('one')))
    await resolve(store.append({ ...record('two'), target: 'other-target' }))

    expect(
      (await resolve(store.list({ target: 'other-target' }))).map((item) => String(item.id))
    ).toEqual(['two'])
    expect(await resolve(store.counts())).toEqual({
      pending: 2,
      active: 0,
      published: 0,
      failed: 0,
      total: 2
    })
  })
})
