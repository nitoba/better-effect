// oxlint-disable anti-slop/no-unsafe-dictionary-type -- the test models untyped SQL rows.
// oxlint-disable anti-slop/no-known-value-widening -- the test row fixture is a driver-boundary DTO.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- fixture casts follow the generic QueryResult boundary.

import { expect, test } from 'bun:test'
import { Layer } from 'better-effect'
import { Result } from 'better-result'
import {
  OutboxConflictError,
  OutboxId,
  makeOutboxRecord,
  validatePreparedEnqueue
} from 'better-effect-mq-outbox'
import type { OutboxRecord } from 'better-effect-mq-outbox'
import {
  MYSQL_TABLES,
  MySqlOutbox,
  MySqlOutboxStore,
  OutboxStore,
  type Pool,
  type PoolConnection,
  type QueryResult
} from '../src'

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

const record = (id = 'invoice:inv-1'): OutboxRecord =>
  makeOutboxRecord({
    id: OutboxId.make(id).unwrap(),
    target: 'jobs-mysql',
    request: prepared,
    nowMs: 0
  }).unwrap()

const rowFor = (value: OutboxRecord): Record<string, unknown> => ({
  namespace: 'billing',
  id: value.id,
  protocol_version: value.protocolVersion,
  target: value.target,
  state: value.state,
  request: JSON.stringify(value.request),
  metadata: JSON.stringify(value.request.metadata),
  request_digest: value.requestDigest,
  attempts_max: value.attemptsMax,
  attempts_made: value.attemptsMade,
  run_at_ms: value.runAtMs,
  created_at_ms: value.createdAtMs,
  updated_at_ms: value.updatedAtMs,
  published_at_ms: value.publishedAtMs,
  lease_owner: value.leaseOwner,
  lease_token: value.leaseToken,
  lease_expires_at_ms: value.leaseExpiresAtMs,
  failure: value.failure === undefined ? null : JSON.stringify(value.failure),
  ordering_sequence: 1
})

type TransactionalConnectionOptions = Readonly<{
  failAppend?: boolean
  failDomain?: boolean
}>

const transactionalPool = (calls: string[], options: TransactionalConnectionOptions = {}): Pool => {
  const connection: PoolConnection = {
    query: async <Row = unknown>(
      sql: string,
      _values?: readonly unknown[]
    ): Promise<QueryResult<Row>> => {
      calls.push(sql)
      if (sql === 'INSERT DOMAIN' && options.failDomain) throw new Error('domain failed')
      if (sql.startsWith('INSERT INTO') && options.failAppend) throw new Error('append failed')
      if (sql.startsWith('INSERT INTO')) return { rows: [] as Row[], rowCount: 1 }
      if (sql.startsWith('SELECT')) return { rows: [rowFor(record()) as Row], rowCount: 1 }
      return { rows: [] as Row[], rowCount: 1 }
    },
    execute: async <Row = unknown>(
      sql: string,
      values?: readonly unknown[]
    ): Promise<QueryResult<Row>> => connection.query(sql, values),
    beginTransaction: async () => {
      calls.push('BEGIN')
    },
    commit: async () => {
      calls.push('COMMIT')
    },
    rollback: async () => {
      calls.push('ROLLBACK')
    },
    release: () => {
      calls.push('RELEASE')
    }
  }
  return { getConnection: async () => connection }
}

test('MySqlOutbox.transaction commits a domain write and outbox append', async () => {
  const calls: string[] = []
  const result = await MySqlOutbox.transaction(transactionalPool(calls), async (connection) => {
    await connection.query('INSERT DOMAIN')
    const appended = await MySqlOutbox.appendIn(connection, record(), { namespace: 'billing' })
    if (Result.isError(appended)) return Result.err(appended.error)
    return Result.ok('saved')
  })

  expect(Result.isOk(result)).toBe(true)
  expect(calls).toEqual([
    'BEGIN',
    'INSERT DOMAIN',
    expect.stringContaining('INSERT INTO'),
    expect.stringContaining('SELECT'),
    'COMMIT',
    'RELEASE'
  ])
})

test('MySqlOutbox.transaction commits ordinary status-shaped callback values', async () => {
  const calls: string[] = []
  const result = await MySqlOutbox.transaction(transactionalPool(calls), () => ({
    status: 'error' as const
  }))

  expect(result).toEqual({ status: 'error' })
  expect(calls).toEqual(['BEGIN', 'COMMIT', 'RELEASE'])
})

test('MySqlOutbox.transaction rolls back a nominal domain Result.err', async () => {
  const calls: string[] = []
  const failure = new Error('domain failed')
  const result = await MySqlOutbox.transaction(transactionalPool(calls), async (connection) => {
    await connection.query('INSERT DOMAIN')
    return Result.err(failure)
  })

  expect(Result.isError(result)).toBe(true)
  if (Result.isOk(result)) return
  expect(result.error).toBe(failure)
  expect(calls).toEqual(['BEGIN', 'INSERT DOMAIN', 'ROLLBACK', 'RELEASE'])
})

test('MySqlOutbox.transaction rolls back when appending returns Result.err', async () => {
  const calls: string[] = []
  const result = await MySqlOutbox.transaction(
    transactionalPool(calls, { failAppend: true }),
    async (connection) => {
      await connection.query('INSERT DOMAIN')
      return MySqlOutbox.appendIn(connection, record(), { namespace: 'billing' })
    }
  )

  expect(Result.isError(result)).toBe(true)
  expect(calls).toEqual([
    'BEGIN',
    'INSERT DOMAIN',
    expect.stringContaining('INSERT INTO'),
    'ROLLBACK',
    'RELEASE'
  ])
})

test('MySqlOutbox.transaction rolls back and releases after a rejected callback', async () => {
  const calls: string[] = []
  const failure = new Error('callback failed')

  const rejected = MySqlOutbox.transaction(transactionalPool(calls), async () => {
    throw failure
  }).catch((cause) => cause)
  expect(await rejected).toBe(failure)
  expect(calls).toEqual(['BEGIN', 'ROLLBACK', 'RELEASE'])
})

test('MySqlOutbox.appendIn uses the caller transaction and returns a typed record', async () => {
  const statements: string[] = []
  const connection: PoolConnection = {
    query: async <Row = unknown>(
      sql: string,
      _values?: readonly unknown[]
    ): Promise<QueryResult<Row>> => {
      statements.push(sql)
      if (sql.startsWith('INSERT INTO')) return { rows: [] as Row[], rowCount: 1 }
      return { rows: [rowFor(record()) as Row], rowCount: 1 }
    },
    execute: async <Row = unknown>(
      sql: string,
      _values?: readonly unknown[]
    ): Promise<QueryResult<Row>> => {
      statements.push(sql)
      return { rows: [rowFor(record()) as Row], rowCount: 1 }
    },
    beginTransaction: async () => {
      throw new Error('appendIn must not begin a transaction')
    },
    commit: async () => {
      throw new Error('appendIn must not commit a transaction')
    },
    rollback: async () => {
      throw new Error('appendIn must not rollback a transaction')
    },
    release: () => {
      throw new Error('appendIn must not release a transaction connection')
    }
  }

  const result = await MySqlOutbox.appendIn(connection, record(), { namespace: 'billing' })
  expect(Result.isOk(result)).toBe(true)
  if (Result.isError(result)) return
  expect(result.value.duplicate).toBe(false)
  expect(String(result.value.record.id)).toBe('invoice:inv-1')
  expect(statements.some((sql) => sql.includes(MYSQL_TABLES.outbox))).toBe(true)
  expect(statements.some((sql) => sql.includes('FOR UPDATE'))).toBe(true)
})

test('MySqlOutboxStore exposes default and named Layer-first tokens', () => {
  const named = OutboxStore.named('billing')
  expect(named.serviceTag).toBe('@better-effect/mq/OutboxStore/billing')
  expect(MySqlOutboxStore.layer({ pool: { getConnection: async () => undefined } })).toBeInstanceOf(
    Layer
  )
  expect(
    MySqlOutboxStore.layerFor(named, { pool: { getConnection: async () => undefined } })
  ).toBeInstanceOf(Layer)
})

test('MySqlOutbox.appendIn converges duplicates and reports a digest conflict', async () => {
  const existing = record()
  const connection: PoolConnection = {
    query: async <Row = unknown>(sql: string): Promise<QueryResult<Row>> =>
      sql.startsWith('INSERT INTO')
        ? ({ rows: [] as Row[], rowCount: 0 } as QueryResult<Row>)
        : ({ rows: [rowFor(existing) as Row], rowCount: 1 } as QueryResult<Row>),
    execute: async <Row = unknown>(): Promise<QueryResult<Row>> => ({
      rows: [],
      rowCount: 0
    }),
    beginTransaction: async () => undefined,
    commit: async () => undefined,
    rollback: async () => undefined,
    release: () => undefined
  }

  const duplicate = await MySqlOutbox.appendIn(connection, existing, { namespace: 'billing' })
  expect(Result.isOk(duplicate)).toBe(true)
  if (Result.isError(duplicate)) return
  expect(duplicate.value.duplicate).toBe(true)

  const conflicting = makeOutboxRecord({
    id: OutboxId.make('invoice:inv-1').unwrap(),
    target: existing.target,
    request: validatePreparedEnqueue({ ...prepared, payload: { invoiceId: 'other' } }).unwrap(),
    nowMs: 0
  }).unwrap()
  const conflict = await MySqlOutbox.appendIn(connection, conflicting, { namespace: 'billing' })
  expect(Result.isError(conflict)).toBe(true)
  if (Result.isOk(conflict)) return
  expect(OutboxConflictError.is(conflict.error)).toBe(true)
})
