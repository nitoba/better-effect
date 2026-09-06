// oxlint-disable anti-slop/no-runtime-typeof -- MySQL JSON and driver rows are untyped boundaries.
// oxlint-disable anti-slop/no-unknown-parameters -- persisted records are validated at this boundary.
// oxlint-disable anti-slop/no-unknown-returns -- driver JSON values are narrowed before decoding.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- SQL row values are decoded through the OutboxRecord validator.
// oxlint-disable anti-slop/no-known-value-widening -- the driver boundary is intentionally represented by a row dictionary.
// oxlint-disable anti-slop/no-conditional-empty-object-spread -- optional driver diagnostics are copied without exposing them in errors.
// oxlint-disable anti-slop/no-chained-type-assertions -- Result facade casts are localized at the adapter boundary.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- assertions follow record validation.

import { createHash } from 'node:crypto'
import { Result } from 'better-result'
import type { PoolConnection as DriverPoolConnection } from 'mysql2/promise'
import {
  OutboxConflictError,
  OutboxDefinitionError,
  OutboxProtocolMismatchError,
  OutboxStoreFailure,
  outboxProtocolVersion,
  validateOutboxRecord,
  type OutboxAppendError,
  type OutboxAppendResult,
  type OutboxEffect,
  type OutboxRecord,
  type OutboxStoreError
} from 'better-effect-mq-outbox'

import { normalizeMySqlJobStoreConfig, type PoolConnection, type QueryResult } from './config'
import { isOutboxStoreToken, OutboxStore, type AnyOutboxStoreToken } from './outbox-token'
import { MYSQL_TABLES, quoteIdentifier } from './schema'

export type MySqlOutboxAppendOptions = Readonly<{
  namespace?: string
  token?: AnyOutboxStoreToken
}>
export type MySqlOutboxTransaction = PoolConnection | DriverPoolConnection
export type MySqlOutboxRow = Record<string, unknown>

export const outboxColumnNames = [
  'id',
  'protocol_version',
  'target',
  'state',
  'request',
  'metadata',
  'request_digest',
  'attempts_max',
  'attempts_made',
  'run_at_ms',
  'created_at_ms',
  'updated_at_ms',
  'published_at_ms',
  'lease_owner',
  'lease_token',
  'lease_expires_at_ms',
  'failure',
  'ordering_sequence'
] as const

export const outboxTable = quoteIdentifier(MYSQL_TABLES.outbox)

const json = (value: unknown): string => JSON.stringify(value)
const parsedJson = (value: unknown): unknown => {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value
  return parsed
}
const integer = (value: unknown, field: string): number => {
  const number =
    typeof value === 'bigint' ? Number(value) : typeof value === 'string' ? Number(value) : value
  if (typeof number !== 'number' || !Number.isSafeInteger(number))
    throw new Error(`unsafe ${field}`)
  return number
}
const optionalInteger = (value: unknown, field: string): number | undefined =>
  value == null ? undefined : integer(value, field)

const isQueryResult = <Row>(value: unknown): value is QueryResult<Row> =>
  typeof value === 'object' && value !== null && 'rows' in value && 'rowCount' in value
const query = async <Row>(
  connection: MySqlOutboxTransaction,
  sql: string,
  values?: readonly unknown[]
): Promise<QueryResult<Row>> => {
  const run = connection.query as unknown as (
    statement: string,
    parameters?: readonly unknown[]
  ) => PromiseLike<unknown>
  const output = await run(sql, values)
  if (isQueryResult<Row>(output)) return output
  const rows = Array.isArray(output) ? output[0] : undefined
  const info = Array.isArray(rows) ? undefined : rows
  return {
    rows: (Array.isArray(rows) ? rows : []) as readonly Row[],
    rowCount:
      typeof info === 'object' && info !== null && 'affectedRows' in info
        ? Number((info as { readonly affectedRows?: unknown }).affectedRows) || 0
        : 0
  }
}

const taggedErrors = new Set([
  'OutboxDefinitionError',
  'OutboxConflictError',
  'OutboxStoreFailure',
  'OutboxNotFoundError',
  'OutboxLeaseLostError',
  'OutboxProtocolMismatchError'
])
export const isOutboxStoreError = (value: unknown): value is OutboxStoreError => {
  try {
    return (
      typeof value === 'object' &&
      value !== null &&
      typeof (value as { readonly _tag?: unknown })._tag === 'string' &&
      taggedErrors.has((value as { readonly _tag: string })._tag)
    )
  } catch {
    return false
  }
}

type DriverDetails = { code?: string; errno?: number }
const driverDetails = (cause: unknown): DriverDetails => {
  const details: DriverDetails = {}
  if (typeof cause !== 'object' || cause === null) return details
  const error = cause as { readonly code?: unknown; readonly errno?: unknown }
  if (typeof error.code === 'string') details.code = error.code
  if (typeof error.errno === 'number') details.errno = error.errno
  return details
}

export const isMySqlRetryable = (cause: unknown): boolean => {
  const error = driverDetails(cause)
  return (
    error.code === 'ER_LOCK_DEADLOCK' ||
    error.code === 'ER_LOCK_WAIT_TIMEOUT' ||
    error.errno === 1213 ||
    error.errno === 1205
  )
}

export const mySqlFailure = (
  operation: string,
  cause: unknown,
  retryable = isMySqlRetryable(cause)
): OutboxStoreFailure => {
  const details = driverDetails(cause)
  const suffix = details.code === undefined ? '' : ` (${details.code})`
  return new OutboxStoreFailure({
    operation,
    retryable,
    message: `MySQL ${operation} failed${suffix}`
  })
}

const failed = <Failure extends OutboxStoreError>(error: Failure): OutboxEffect<never, Failure> =>
  Result.err(error) as unknown as OutboxEffect<never, Failure>
const succeeded = <Value>(value: Value): OutboxEffect<Value, never> =>
  Result.ok(value) as unknown as OutboxEffect<Value, never>

export const encodeOutboxRecord = (record: OutboxRecord): readonly unknown[] => [
  record.id,
  record.protocolVersion,
  record.target,
  record.state,
  json(record.request),
  json(record.request.metadata),
  record.requestDigest,
  record.attemptsMax,
  record.attemptsMade,
  record.runAtMs,
  record.createdAtMs,
  record.updatedAtMs,
  record.publishedAtMs ?? null,
  record.leaseOwner ?? null,
  record.leaseToken ?? null,
  record.leaseExpiresAtMs ?? null,
  record.failure === undefined ? null : json(record.failure)
]

export const decodeOutboxRow = (row: MySqlOutboxRow): OutboxRecord => {
  const protocolVersion = integer(row.protocol_version, 'protocol_version')
  if (protocolVersion !== outboxProtocolVersion)
    throw new OutboxProtocolMismatchError({ actual: protocolVersion })
  const checked = validateOutboxRecord({
    id: row.id,
    protocolVersion,
    target: row.target,
    state: row.state,
    request: parsedJson(row.request),
    requestDigest: row.request_digest,
    attemptsMax: integer(row.attempts_max, 'attempts_max'),
    attemptsMade: integer(row.attempts_made, 'attempts_made'),
    runAtMs: integer(row.run_at_ms, 'run_at_ms'),
    createdAtMs: integer(row.created_at_ms, 'created_at_ms'),
    updatedAtMs: integer(row.updated_at_ms, 'updated_at_ms'),
    publishedAtMs: optionalInteger(row.published_at_ms, 'published_at_ms'),
    leaseOwner: row.lease_owner == null ? undefined : row.lease_owner,
    leaseToken: row.lease_token == null ? undefined : row.lease_token,
    leaseExpiresAtMs: optionalInteger(row.lease_expires_at_ms, 'lease_expires_at_ms'),
    failure: row.failure == null ? undefined : parsedJson(row.failure)
  })
  if (Result.isError(checked)) throw checked.error
  return checked.value
}

export const namespaceForOutboxToken = (token: AnyOutboxStoreToken, namespace: string): string =>
  token.serviceTag === OutboxStore.serviceTag
    ? namespace
    : `${namespace}:outbox-${createHash('sha256').update(token.serviceTag).digest('hex').slice(0, 48)}`

const normalizedNamespace = (options: MySqlOutboxAppendOptions | undefined): string => {
  const namespace = normalizeMySqlJobStoreConfig({
    pool: { getConnection: async () => undefined },
    namespace: options?.namespace,
    validateSchema: false
  }).namespace
  if (options?.token === undefined) return namespace
  if (!isOutboxStoreToken(options.token))
    throw new OutboxDefinitionError({ field: 'token', message: 'must be an OutboxStore token' })
  return namespaceForOutboxToken(options.token, namespace)
}

/**
 * Append an outbox record using a caller-owned MySQL transaction.
 * This method never begins, commits, rolls back, or releases the connection.
 */
export const MySqlOutbox = Object.freeze({
  async appendIn(
    connection: MySqlOutboxTransaction,
    input: OutboxRecord,
    options?: MySqlOutboxAppendOptions
  ): Promise<OutboxEffect<OutboxAppendResult, OutboxAppendError>> {
    const checked = validateOutboxRecord(input)
    if (Result.isError(checked)) return failed(checked.error)
    const record = checked.value
    let namespace: string
    try {
      namespace = normalizedNamespace(options)
    } catch (cause) {
      return failed(
        cause instanceof OutboxDefinitionError
          ? cause
          : new OutboxDefinitionError({ field: 'namespace', message: 'is invalid' })
      )
    }
    try {
      const inserted = await query(
        connection,
        `INSERT INTO ${outboxTable} (namespace,${outboxColumnNames.slice(0, -1).join(',')}) VALUES (?,${outboxColumnNames
          .slice(0, -1)
          .map(() => '?')
          .join(',')}) ON DUPLICATE KEY UPDATE id=id`,
        [namespace, ...encodeOutboxRecord(record)]
      )
      const existing = await query<MySqlOutboxRow>(
        connection,
        `SELECT ${outboxColumnNames.join(',')} FROM ${outboxTable} WHERE namespace=? AND id=? FOR UPDATE`,
        [namespace, record.id]
      )
      const row = existing.rows[0]
      if (row === undefined)
        return failed(mySqlFailure('append', new Error('inserted outbox row is missing'), false))
      const persisted = decodeOutboxRow(row)
      if (persisted.requestDigest !== record.requestDigest)
        return failed(
          new OutboxConflictError({
            id: record.id,
            existingDigest: persisted.requestDigest,
            incomingDigest: record.requestDigest
          })
        )
      return succeeded({ record: persisted, duplicate: inserted.rowCount !== 1 })
    } catch (cause) {
      if (isOutboxStoreError(cause)) return failed(cause as OutboxAppendError)
      return failed(mySqlFailure('append', cause))
    }
  }
})
