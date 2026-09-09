// oxlint-disable anti-slop/no-runtime-typeof -- SQLite rows and driver errors are untyped boundaries.
// oxlint-disable anti-slop/no-unknown-parameters -- public persistence DTOs are validated at entry.
// oxlint-disable anti-slop/no-unknown-returns -- JSON row decoding is confined to this adapter.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- JSON row snapshots are validated before use.
// oxlint-disable anti-slop/no-chained-type-assertions -- casts are confined to validated SQLite rows and Service erasure.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- validators guard every row reconstruction.

import { Layer } from 'better-effect'
import type { ServiceContract } from 'better-effect'
import { Err, Result, type Result as ResultType } from 'better-result'
import {
  cloneOutboxRecord,
  makeOutboxRecord,
  makeSerializedOutboxFailure,
  OutboxConflictError,
  OutboxDefinitionError,
  OutboxId,
  OutboxLeaseLostError,
  OutboxLeaseToken,
  OutboxNotFoundError,
  OutboxStoreFailure,
  OutboxStore as OutboxStoreToken,
  OutboxWorkerId,
  validateOutboxRecord,
  type AnyOutboxStoreToken,
  type LeasedOutboxRecord,
  type OutboxAppendError,
  type OutboxAppendResult,
  type OutboxAppendStore,
  type OutboxClaimError,
  type OutboxClaimOptions,
  type OutboxCounts,
  type OutboxFailureRequest,
  type OutboxHeartbeatRequest,
  type OutboxLeaseError,
  type OutboxLeaseRequest,
  type OutboxListOptions,
  type OutboxOperation,
  type OutboxReadError,
  type OutboxRecoveryError,
  type OutboxRecoveryOptions,
  type OutboxRecord,
  type OutboxRecordInput,
  type OutboxRetryRequest,
  type OutboxSettlementError,
  type OutboxSettlementResult,
  type OutboxState,
  type OutboxStore as OutboxStoreContract,
  type OutboxStoreError
} from 'better-effect-mq-outbox'
import { DEFAULT_NAMESPACE, normalizeSqliteJobStoreConfig, validateNamespace } from './config'
import type { SqliteDatabase, SqliteJobStoreConfig } from './config'
import { SqliteMigrator } from './migrator'
import type { SqliteMigrationOptions } from './migrator'
import { withSqliteTransaction } from './internal/transactions'
import { SQLITE_TABLES } from './schema'

export interface SqliteOutboxStoreConfig extends SqliteJobStoreConfig {}

/** SQLite uses the database connection itself as its transaction handle. */
export type SqliteTransaction = SqliteDatabase

export interface SqliteOutboxAppendOptions {
  readonly namespace?: string
}

export type SqliteOutboxStoreContract = OutboxStoreContract & OutboxAppendStore

type Operation<Success, Failure extends OutboxStoreError = OutboxStoreError> = OutboxOperation<
  Success,
  Failure
>
type SyncResult<Success, Failure extends OutboxStoreError = OutboxStoreError> = ResultType<
  Success,
  Failure
>
type SqliteRow = Readonly<Record<string, unknown>> | undefined | null

const outboxDescriptor = Object.freeze({
  protocolVersion: 1 as const,
  adapter: 'sqlite',
  adapterVersion: '0.1.0'
})

const validStates = new Set<OutboxState>(['pending', 'active', 'published', 'failed'])

const fail = <Value, Failure extends OutboxStoreError>(error: Failure): Operation<Value, Failure> =>
  Result.err(error) as unknown as Operation<Value, Failure>

const syncFail = <Value, Failure extends OutboxStoreError>(
  error: Failure
): SyncResult<Value, Failure> => Result.err(error)

const errorCode = (cause: unknown): string | undefined => {
  if (cause === null || (typeof cause !== 'object' && typeof cause !== 'function')) return undefined
  const code = (cause as { readonly code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

const isOutboxError = (cause: unknown): cause is OutboxStoreError =>
  cause !== null && typeof cause === 'object' && '_tag' in cause

const storeFailure = (
  operation: string,
  cause: unknown,
  retryable = /BUSY|LOCKED/u.test(errorCode(cause) ?? '')
): OutboxStoreFailure =>
  new OutboxStoreFailure({
    operation,
    retryable,
    message: `SQLite outbox ${operation} failed: ${errorMessage(cause)}`,
    cause
  })

const safeInteger = (value: unknown, field: string): ResultType<number, OutboxDefinitionError> => {
  const number = typeof value === 'bigint' ? Number(value) : value
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0) {
    return Result.err(
      new OutboxDefinitionError({ field, message: 'must be a non-negative safe integer' })
    )
  }
  return Result.ok(number)
}

const positiveInteger = (
  value: unknown,
  field: string
): ResultType<number, OutboxDefinitionError> => {
  const checked = safeInteger(value, field)
  if (Result.isError(checked)) return checked
  if (checked.value < 1) {
    return Result.err(
      new OutboxDefinitionError({ field, message: 'must be a positive safe integer' })
    )
  }
  return checked
}

const nullableString = (value: unknown, field: string): string | undefined => {
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string or null`)
  return value
}

const nullableInteger = (value: unknown, field: string): number | undefined => {
  if (value === null || value === undefined) return undefined
  const checked = safeInteger(value, field)
  if (Result.isError(checked)) throw checked.error
  return checked.value
}

const parseJson = (value: unknown, field: string): unknown => {
  if (typeof value !== 'string') throw new TypeError(`${field} must be JSON text`)
  return JSON.parse(value)
}

const rowToRecord = (row: SqliteRow): SyncResult<OutboxRecord, OutboxStoreFailure> => {
  if (row === undefined || row === null) {
    return syncFail(
      new OutboxStoreFailure({
        operation: 'read',
        retryable: false,
        message: 'SQLite outbox row is missing'
      })
    )
  }
  try {
    const candidate = {
      id: row.id,
      protocolVersion: Number(row.protocol_version),
      target: row.target,
      state: row.state,
      request: parseJson(row.request_json, 'request_json'),
      requestDigest: row.request_digest,
      attemptsMax: Number(row.attempts_max),
      attemptsMade: Number(row.attempts_made),
      runAtMs: Number(row.run_at_ms),
      createdAtMs: Number(row.created_at_ms),
      updatedAtMs: Number(row.updated_at_ms),
      publishedAtMs: nullableInteger(row.published_at_ms, 'published_at_ms'),
      leaseOwner: nullableString(row.lease_owner, 'lease_owner'),
      leaseToken: nullableString(row.lease_token, 'lease_token'),
      leaseExpiresAtMs: nullableInteger(row.lease_expires_at_ms, 'lease_expires_at_ms'),
      failure:
        row.failure === null || row.failure === undefined
          ? undefined
          : parseJson(row.failure, 'failure')
    }
    const checked = validateOutboxRecord(candidate)
    return Result.isError(checked)
      ? syncFail(storeFailure('read', checked.error, false))
      : Result.ok(checked.value)
  } catch (cause) {
    return syncFail(storeFailure('read', cause, false))
  }
}

const rowToRecordOrThrow = (row: SqliteRow): OutboxRecord => {
  const result = rowToRecord(row)
  if (Result.isError(result)) throw result.error
  return result.value
}

const recordToValues = (namespace: string, record: OutboxRecord): readonly unknown[] => [
  namespace,
  record.id,
  record.target,
  record.state,
  record.protocolVersion,
  JSON.stringify(record.request),
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
  record.failure === undefined ? null : JSON.stringify(record.failure)
]

const rowById = (database: SqliteDatabase, namespace: string, id: string): SqliteRow =>
  database
    .prepare(
      `SELECT id, target, state, request_json, request_digest, protocol_version, attempts_max, attempts_made, run_at_ms, created_at_ms, updated_at_ms, published_at_ms, lease_owner, lease_token, lease_expires_at_ms, failure FROM ${SQLITE_TABLES.outbox} WHERE namespace = ? AND id = ?`
    )
    .get(namespace, id)

const insertRecord = (
  database: SqliteDatabase,
  namespace: string,
  record: OutboxRecord
): OutboxAppendResult => {
  const existing = rowById(database, namespace, record.id)
  if (existing !== undefined && existing !== null) {
    const current = rowToRecordOrThrow(existing)
    if (current.requestDigest !== record.requestDigest) {
      throw new OutboxConflictError({
        id: record.id,
        existingDigest: current.requestDigest,
        incomingDigest: record.requestDigest
      })
    }
    return { record: cloneOutboxRecord(current), duplicate: true }
  }

  database
    .prepare(
      `INSERT INTO ${SQLITE_TABLES.outbox}(namespace, id, target, state, protocol_version, request_json, request_digest, attempts_max, attempts_made, run_at_ms, created_at_ms, updated_at_ms, published_at_ms, lease_owner, lease_token, lease_expires_at_ms, failure, ordering_sequence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(ordering_sequence), 0) + 1 FROM ${SQLITE_TABLES.outbox} WHERE namespace = ?))`
    )
    .run(...recordToValues(namespace, record), namespace)
  return { record: cloneOutboxRecord(record), duplicate: false }
}

const validateClaim = (
  options: OutboxClaimOptions
): SyncResult<OutboxClaimOptions, OutboxDefinitionError> => {
  const owner = OutboxWorkerId.make(options.owner)
  const limit = positiveInteger(options.limit, 'limit')
  const leaseDurationMs = positiveInteger(options.leaseDurationMs, 'leaseDurationMs')
  const nowMs = safeInteger(options.nowMs, 'nowMs')
  if (Result.isError(owner)) return owner
  if (Result.isError(limit)) return limit
  if (Result.isError(leaseDurationMs)) return leaseDurationMs
  if (Result.isError(nowMs)) return nowMs
  if (nowMs.value > Number.MAX_SAFE_INTEGER - leaseDurationMs.value) {
    return Result.err(
      new OutboxDefinitionError({
        field: 'leaseDurationMs',
        message: 'lease expiry exceeds safe integer range'
      })
    )
  }
  return Result.ok({
    owner: owner.value,
    limit: limit.value,
    leaseDurationMs: leaseDurationMs.value,
    nowMs: nowMs.value
  })
}

const validateLease = (
  request: OutboxLeaseRequest | OutboxHeartbeatRequest
): SyncResult<
  OutboxLeaseRequest & Partial<Pick<OutboxHeartbeatRequest, 'leaseDurationMs'>>,
  OutboxDefinitionError
> => {
  const id = OutboxId.make(request.id)
  const token = OutboxLeaseToken.make(request.leaseToken)
  const nowMs = safeInteger(request.nowMs, 'nowMs')
  if (Result.isError(id)) return id
  if (Result.isError(token)) return token
  if (Result.isError(nowMs)) return nowMs
  if ('leaseDurationMs' in request) {
    const duration = positiveInteger(request.leaseDurationMs, 'leaseDurationMs')
    if (Result.isError(duration)) return duration
    if (nowMs.value > Number.MAX_SAFE_INTEGER - duration.value) {
      return Result.err(
        new OutboxDefinitionError({
          field: 'leaseDurationMs',
          message: 'lease expiry exceeds safe integer range'
        })
      )
    }
    return Result.ok({
      id: id.value,
      leaseToken: token.value,
      nowMs: nowMs.value,
      leaseDurationMs: duration.value
    })
  }
  return Result.ok({ id: id.value, leaseToken: token.value, nowMs: nowMs.value })
}

const statesFor = (
  state: OutboxListOptions['state']
): SyncResult<readonly OutboxState[] | undefined, OutboxDefinitionError> => {
  if (state === undefined) return Result.ok(undefined)
  const values = typeof state === 'string' ? [state] : state
  if (!values.every((value): value is OutboxState => validStates.has(value))) {
    return Result.err(
      new OutboxDefinitionError({ field: 'state', message: 'contains an unsupported state' })
    )
  }
  return Result.ok(values)
}

const asLeased = (record: OutboxRecord): SyncResult<LeasedOutboxRecord, OutboxStoreFailure> => {
  if (
    record.state !== 'active' ||
    record.leaseOwner === undefined ||
    record.leaseToken === undefined ||
    record.leaseExpiresAtMs === undefined
  ) {
    return syncFail(storeFailure('read', new Error('active SQLite outbox row has no lease'), false))
  }
  // SAFETY: the branch above establishes the active-record lease invariant.
  return Result.ok(record as LeasedOutboxRecord)
}

class SqliteOutboxStoreImplementation implements OutboxStoreContract, OutboxAppendStore {
  readonly descriptor = outboxDescriptor
  private chain: Promise<void> = Promise.resolve()
  private closed = false

  constructor(private readonly config: ReturnType<typeof normalizeSqliteJobStoreConfig>) {}

  append(input: OutboxRecordInput): Operation<OutboxAppendResult, OutboxAppendError> {
    const created = makeOutboxRecord(input)
    if (Result.isError(created)) return fail(created.error)
    return this.execute('append', true, () => {
      try {
        return Result.ok(insertRecord(this.config.database, this.config.namespace, created.value))
      } catch (cause) {
        return Result.err(isOutboxError(cause) ? cause : storeFailure('append', cause))
      }
    }) as Operation<OutboxAppendResult, OutboxAppendError>
  }

  claim(options: OutboxClaimOptions): Operation<readonly LeasedOutboxRecord[], OutboxClaimError> {
    const checked = validateClaim(options)
    if (Result.isError(checked)) return fail(checked.error)
    return this.execute('claim', true, () => {
      try {
        this.recoverExpiredInTransaction(checked.value.nowMs)
        const rows = this.config.database
          .prepare(
            `SELECT id, target, state, request_json, request_digest, protocol_version, attempts_max, attempts_made, run_at_ms, created_at_ms, updated_at_ms, published_at_ms, lease_owner, lease_token, lease_expires_at_ms, failure FROM ${SQLITE_TABLES.outbox} WHERE namespace = ? AND state = 'pending' AND run_at_ms <= ? AND attempts_made < attempts_max ORDER BY run_at_ms, created_at_ms, ordering_sequence, id LIMIT ?`
          )
          .all(this.config.namespace, checked.value.nowMs, checked.value.limit)
        const leased: LeasedOutboxRecord[] = []
        for (const row of rows) {
          const current = rowToRecordOrThrow(row)
          const token = OutboxLeaseToken.make(`sqlite-lease-${globalThis.crypto.randomUUID()}`)
          if (Result.isError(token)) throw token.error
          const changed = this.config.database
            .prepare(
              `UPDATE ${SQLITE_TABLES.outbox} SET state = 'active', attempts_made = attempts_made + 1, updated_at_ms = ?, lease_owner = ?, lease_token = ?, lease_expires_at_ms = ?, failure = NULL WHERE namespace = ? AND id = ? AND state = 'pending'`
            )
            .run(
              checked.value.nowMs,
              checked.value.owner,
              token.value,
              checked.value.nowMs + checked.value.leaseDurationMs,
              this.config.namespace,
              current.id
            )
          if (changed.changes !== 1) throw new Error(`SQLite outbox claim lost row ${current.id}`)
          const updated = asLeased(
            rowToRecordOrThrow(rowById(this.config.database, this.config.namespace, current.id))
          )
          if (Result.isError(updated)) throw updated.error
          leased.push(updated.value)
        }
        return Result.ok(Object.freeze(leased))
      } catch (cause) {
        return Result.err(isOutboxError(cause) ? cause : storeFailure('claim', cause))
      }
    }) as Operation<readonly LeasedOutboxRecord[], OutboxClaimError>
  }

  heartbeat(request: OutboxHeartbeatRequest): Operation<LeasedOutboxRecord, OutboxLeaseError> {
    const checked = validateLease(request)
    if (Result.isError(checked)) return fail(checked.error)
    return this.execute('heartbeat', true, () => {
      try {
        const leased = this.requireLease(
          checked.value.id,
          checked.value.leaseToken,
          checked.value.nowMs
        )
        if (Result.isError(leased)) return leased
        const changed = this.config.database
          .prepare(
            `UPDATE ${SQLITE_TABLES.outbox} SET updated_at_ms = ?, lease_expires_at_ms = ? WHERE namespace = ? AND id = ? AND state = 'active' AND lease_token = ?`
          )
          .run(
            checked.value.nowMs,
            checked.value.nowMs + checked.value.leaseDurationMs!,
            this.config.namespace,
            checked.value.id,
            checked.value.leaseToken
          )
        if (changed.changes !== 1)
          return this.leaseLost(checked.value.id, checked.value.leaseToken, 'mismatched-token')
        return asLeased(
          rowToRecordOrThrow(rowById(this.config.database, this.config.namespace, checked.value.id))
        )
      } catch (cause) {
        return Result.err(isOutboxError(cause) ? cause : storeFailure('heartbeat', cause))
      }
    }) as Operation<LeasedOutboxRecord, OutboxLeaseError>
  }

  markPublished(
    request: OutboxLeaseRequest
  ): Operation<OutboxSettlementResult, OutboxSettlementError> {
    const checked = validateLease(request)
    if (Result.isError(checked)) return fail(checked.error)
    return this.execute('markPublished', true, () => {
      try {
        const existing = rowById(this.config.database, this.config.namespace, checked.value.id)
        if (existing === undefined || existing === null)
          return Result.err(new OutboxNotFoundError({ id: checked.value.id }))
        const current = rowToRecordOrThrow(existing)
        if (current.state === 'published') {
          return Result.ok({
            record: cloneOutboxRecord(current),
            status: 'already-applied' as const
          })
        }
        const leased = this.requireLease(
          checked.value.id,
          checked.value.leaseToken,
          checked.value.nowMs
        )
        if (Result.isError(leased)) return leased
        const changed = this.config.database
          .prepare(
            `UPDATE ${SQLITE_TABLES.outbox} SET state = 'published', updated_at_ms = ?, published_at_ms = ?, lease_owner = NULL, lease_token = NULL, lease_expires_at_ms = NULL WHERE namespace = ? AND id = ? AND state = 'active' AND lease_token = ?`
          )
          .run(
            checked.value.nowMs,
            checked.value.nowMs,
            this.config.namespace,
            checked.value.id,
            checked.value.leaseToken
          )
        if (changed.changes !== 1)
          return this.leaseLost(checked.value.id, checked.value.leaseToken, 'mismatched-token')
        return Result.ok({
          record: rowToRecordOrThrow(
            rowById(this.config.database, this.config.namespace, checked.value.id)
          ),
          status: 'applied' as const
        })
      } catch (cause) {
        return Result.err(isOutboxError(cause) ? cause : storeFailure('markPublished', cause))
      }
    }) as Operation<OutboxSettlementResult, OutboxSettlementError>
  }

  markRetry(request: OutboxRetryRequest): Operation<OutboxRecord, OutboxSettlementError> {
    const checked = validateLease(request)
    if (Result.isError(checked)) return fail(checked.error)
    const runAtMs = safeInteger(request.runAtMs, 'runAtMs')
    const failure = makeSerializedOutboxFailure(request.failure)
    if (Result.isError(runAtMs)) return fail(runAtMs.error)
    if (Result.isError(failure)) return fail(failure.error)
    return this.settle(
      'markRetry',
      checked.value,
      `state = 'pending', run_at_ms = ?, failure = ?`,
      [runAtMs.value, JSON.stringify(failure.value)]
    )
  }

  markFailed(request: OutboxFailureRequest): Operation<OutboxRecord, OutboxSettlementError> {
    const checked = validateLease(request)
    if (Result.isError(checked)) return fail(checked.error)
    const failure = makeSerializedOutboxFailure(request.failure)
    if (Result.isError(failure)) return fail(failure.error)
    return this.settle('markFailed', checked.value, `state = 'failed', failure = ?`, [
      JSON.stringify(failure.value)
    ])
  }

  release(request: OutboxLeaseRequest): Operation<OutboxRecord, OutboxSettlementError> {
    const checked = validateLease(request)
    if (Result.isError(checked)) return fail(checked.error)
    return this.settle('release', checked.value, `state = 'pending'`, [])
  }

  recoverStalled(
    options: OutboxRecoveryOptions
  ): Operation<readonly OutboxRecord[], OutboxRecoveryError> {
    const maxCount = positiveInteger(options.maxCount, 'maxCount')
    const nowMs = safeInteger(options.nowMs, 'nowMs')
    if (Result.isError(maxCount)) return fail(maxCount.error)
    if (Result.isError(nowMs)) return fail(nowMs.error)
    return this.execute('recoverStalled', true, () => {
      try {
        return Result.ok(
          Object.freeze(this.recoverExpiredInTransaction(nowMs.value, maxCount.value))
        )
      } catch (cause) {
        return Result.err(isOutboxError(cause) ? cause : storeFailure('recoverStalled', cause))
      }
    }) as Operation<readonly OutboxRecord[], OutboxRecoveryError>
  }

  get(id: OutboxRecord['id']): Operation<OutboxRecord | undefined, OutboxReadError> {
    return this.execute('get', false, () => {
      try {
        const checked = OutboxId.make(id)
        if (Result.isError(checked)) return checked
        const row = rowById(this.config.database, this.config.namespace, checked.value)
        return row === undefined || row === null ? Result.ok(undefined) : rowToRecord(row)
      } catch (cause) {
        return Result.err(storeFailure('get', cause, false))
      }
    }) as Operation<OutboxRecord | undefined, OutboxReadError>
  }

  list(options: OutboxListOptions = {}): Operation<readonly OutboxRecord[], OutboxReadError> {
    const states = statesFor(options.state)
    if (Result.isError(states)) return fail(states.error)
    if (
      options.target !== undefined &&
      (options.target.length === 0 || options.target.includes('\u0000'))
    ) {
      return fail(
        new OutboxDefinitionError({
          field: 'target',
          message: 'must be a non-empty string without NUL'
        })
      )
    }
    const limit = options.limit === undefined ? undefined : positiveInteger(options.limit, 'limit')
    if (limit !== undefined && Result.isError(limit)) return fail(limit.error)
    return this.execute('list', false, () => {
      try {
        const clauses = ['namespace = ?']
        const parameters: unknown[] = [this.config.namespace]
        if (states.value !== undefined && states.value.length > 0) {
          clauses.push(`state IN (${states.value.map(() => '?').join(', ')})`)
          parameters.push(...states.value)
        } else if (states.value?.length === 0) {
          return Result.ok(Object.freeze([]))
        }
        if (options.target !== undefined) {
          clauses.push('target = ?')
          parameters.push(options.target)
        }
        const suffix = limit === undefined ? '' : ' LIMIT ?'
        if (limit !== undefined) parameters.push(limit.value)
        const rows = this.config.database
          .prepare(
            `SELECT id, target, state, request_json, request_digest, protocol_version, attempts_max, attempts_made, run_at_ms, created_at_ms, updated_at_ms, published_at_ms, lease_owner, lease_token, lease_expires_at_ms, failure FROM ${SQLITE_TABLES.outbox} WHERE ${clauses.join(' AND ')} ORDER BY created_at_ms, ordering_sequence, id${suffix}`
          )
          .all(...parameters)
        return Result.ok(Object.freeze(rows.map((row) => rowToRecordOrThrow(row))))
      } catch (cause) {
        return Result.err(storeFailure('list', cause, false))
      }
    }) as Operation<readonly OutboxRecord[], OutboxReadError>
  }

  counts(): Operation<OutboxCounts, OutboxReadError> {
    return this.execute('counts', false, () => {
      try {
        const counts = { pending: 0, active: 0, published: 0, failed: 0, total: 0 }
        for (const row of this.config.database
          .prepare(
            `SELECT state, COUNT(*) AS count FROM ${SQLITE_TABLES.outbox} WHERE namespace = ? GROUP BY state`
          )
          .all(this.config.namespace)) {
          const state = row?.state
          const count = Number(row?.count)
          if (
            typeof state !== 'string' ||
            !validStates.has(state as OutboxState) ||
            !Number.isSafeInteger(count)
          ) {
            throw new Error('SQLite outbox counts row is invalid')
          }
          counts[state as OutboxState] = count
          counts.total += count
        }
        return Result.ok(Object.freeze(counts))
      } catch (cause) {
        return Result.err(storeFailure('counts', cause, false))
      }
    }) as Operation<OutboxCounts, OutboxReadError>
  }

  dispose(): Promise<void> {
    this.closed = true
    return this.chain
  }

  private execute<Value, Failure extends OutboxStoreError>(
    operation: string,
    mutating: boolean,
    callback: () => SyncResult<Value, Failure>
  ): Operation<Value, Failure> {
    if (this.closed) return fail(storeFailure(operation, new Error('store is closed')) as Failure)
    const run = (): SyncResult<Value, Failure> => {
      let transactionStarted = false
      try {
        if (mutating) {
          this.config.database.exec('BEGIN IMMEDIATE')
          transactionStarted = true
        }
        const result = callback()
        if (Result.isError(result)) {
          if (transactionStarted) {
            try {
              this.config.database.exec('ROLLBACK')
            } catch (rollbackCause) {
              return syncFail(
                storeFailure(
                  operation,
                  new AggregateError([result.error, rollbackCause], 'SQLite outbox rollback failed')
                ) as Failure
              )
            }
          }
          return result
        }
        if (transactionStarted) {
          try {
            this.config.database.exec('COMMIT')
            transactionStarted = false
          } catch (commitCause) {
            try {
              this.config.database.exec('ROLLBACK')
            } catch (rollbackCause) {
              return syncFail(
                storeFailure(
                  operation,
                  new AggregateError(
                    [commitCause, rollbackCause],
                    'SQLite outbox commit and rollback failed'
                  )
                ) as Failure
              )
            }
            return syncFail(storeFailure(operation, commitCause) as Failure)
          }
        }
        return result
      } catch (cause) {
        if (transactionStarted) {
          try {
            this.config.database.exec('ROLLBACK')
          } catch (rollbackCause) {
            return syncFail(
              storeFailure(
                operation,
                new AggregateError(
                  [cause, rollbackCause],
                  'SQLite outbox operation and rollback failed'
                )
              ) as Failure
            )
          }
        }
        return syncFail(storeFailure(operation, cause) as Failure)
      }
    }
    const queued = this.chain.then(run, run)
    this.chain = queued.then(
      () => undefined,
      () => undefined
    )
    return queued as unknown as Operation<Value, Failure>
  }

  private settle(
    operation: string,
    request: OutboxLeaseRequest,
    assignments: string,
    values: readonly unknown[]
  ): Operation<OutboxRecord, OutboxSettlementError> {
    return this.execute(operation, true, () => {
      try {
        const leased = this.requireLease(request.id, request.leaseToken, request.nowMs)
        if (Result.isError(leased)) return leased
        const changed = this.config.database
          .prepare(
            `UPDATE ${SQLITE_TABLES.outbox} SET ${assignments}, updated_at_ms = ?, lease_owner = NULL, lease_token = NULL, lease_expires_at_ms = NULL WHERE namespace = ? AND id = ? AND state = 'active' AND lease_token = ?`
          )
          .run(...values, request.nowMs, this.config.namespace, request.id, request.leaseToken)
        if (changed.changes !== 1)
          return this.leaseLost(request.id, request.leaseToken, 'mismatched-token')
        return Result.ok(
          rowToRecordOrThrow(rowById(this.config.database, this.config.namespace, request.id))
        )
      } catch (cause) {
        return Result.err(isOutboxError(cause) ? cause : storeFailure(operation, cause))
      }
    }) as Operation<OutboxRecord, OutboxSettlementError>
  }

  private requireLease(
    id: OutboxRecord['id'],
    token: OutboxLeaseRequest['leaseToken'],
    nowMs: number
  ): SyncResult<LeasedOutboxRecord, OutboxLeaseError> {
    const row = rowById(this.config.database, this.config.namespace, id)
    if (row === undefined || row === null) return Result.err(new OutboxNotFoundError({ id }))
    const record = rowToRecord(row)
    if (Result.isError(record)) return record
    if (record.value.state !== 'active') return this.leaseLost(id, token, 'not-active')
    if (record.value.leaseToken === undefined) return this.leaseLost(id, token, 'missing-token')
    if (record.value.leaseToken !== token) return this.leaseLost(id, token, 'mismatched-token')
    if (record.value.leaseExpiresAtMs === undefined || record.value.leaseExpiresAtMs <= nowMs) {
      return this.leaseLost(id, token, 'expired-lease')
    }
    return asLeased(record.value)
  }

  private leaseLost(
    id: OutboxRecord['id'],
    token: OutboxLeaseRequest['leaseToken'],
    reason: 'missing-token' | 'mismatched-token' | 'expired-lease' | 'not-active'
  ): SyncResult<never, OutboxLeaseError> {
    return Result.err(new OutboxLeaseLostError({ id, leaseToken: token, reason }))
  }

  private recoverExpiredInTransaction(
    nowMs: number,
    maxCount = Number.MAX_SAFE_INTEGER
  ): OutboxRecord[] {
    const rows = this.config.database
      .prepare(
        `SELECT id, target, state, request_json, request_digest, protocol_version, attempts_max, attempts_made, run_at_ms, created_at_ms, updated_at_ms, published_at_ms, lease_owner, lease_token, lease_expires_at_ms, failure FROM ${SQLITE_TABLES.outbox} WHERE namespace = ? AND state = 'active' AND lease_expires_at_ms <= ? ORDER BY lease_expires_at_ms, ordering_sequence, id LIMIT ?`
      )
      .all(this.config.namespace, nowMs, maxCount)
    const recovered: OutboxRecord[] = []
    for (const row of rows) {
      const current = rowToRecordOrThrow(row)
      const terminal = current.attemptsMade >= current.attemptsMax
      const failure = terminal
        ? makeSerializedOutboxFailure({
            kind: 'store-permanent',
            message: 'Outbox lease expired after the attempt limit was reached',
            retryable: false,
            recordedAtMs: nowMs
          }).unwrap()
        : undefined
      this.config.database
        .prepare(
          `UPDATE ${SQLITE_TABLES.outbox} SET state = ?, run_at_ms = ?, updated_at_ms = ?, failure = ?, lease_owner = NULL, lease_token = NULL, lease_expires_at_ms = NULL WHERE namespace = ? AND id = ? AND state = 'active' AND lease_expires_at_ms <= ?`
        )
        .run(
          terminal ? 'failed' : 'pending',
          terminal ? current.runAtMs : Math.max(current.runAtMs, nowMs),
          nowMs,
          failure === undefined ? null : JSON.stringify(failure),
          this.config.namespace,
          current.id,
          nowMs
        )
      recovered.push(
        rowToRecordOrThrow(rowById(this.config.database, this.config.namespace, current.id))
      )
    }
    return recovered
  }
}

const namespaceFor = (token: AnyOutboxStoreToken, namespace: string): string =>
  token.serviceTag === OutboxStoreToken.serviceTag
    ? namespace
    : `${namespace}:${encodeURIComponent(token.serviceTag)}`

const normalizedConfig = (config: SqliteOutboxStoreConfig) => normalizeSqliteJobStoreConfig(config)

const configureDatabase = (config: ReturnType<typeof normalizedConfig>): void => {
  if (config.configurePragmas) {
    config.database.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${config.busyTimeoutMs};`)
  }
}

const makeStore = (config: SqliteOutboxStoreConfig): SqliteOutboxStoreImplementation => {
  const normalized = normalizedConfig(config)
  if (normalized.validateSchema) SqliteMigrator.validate(normalized.database)
  return new SqliteOutboxStoreImplementation(normalized)
}

const appendIn = (
  database: SqliteTransaction,
  input: OutboxRecordInput,
  options: SqliteOutboxAppendOptions = {}
): SyncResult<OutboxAppendResult, OutboxAppendError> => {
  try {
    const namespace = validateNamespace(options.namespace ?? DEFAULT_NAMESPACE)
    const record = makeOutboxRecord(input)
    if (Result.isError(record)) return record
    return Result.ok(insertRecord(database, namespace, record.value))
  } catch (cause) {
    const error: OutboxAppendError = isOutboxError(cause)
      ? (cause as OutboxAppendError)
      : storeFailure('appendIn', cause)
    return syncFail(error)
  }
}

type TransactionCallback<Value, Failure> = (
  database: SqliteTransaction
) => ResultType<Value, Failure> | PromiseLike<ResultType<Value, Failure>>

/**
 * Run a domain write and its outbox append in one serialized SQLite transaction.
 *
 * The callback returns a nominal `better-result` Result. An `Err` rolls back and
 * is returned unchanged; an `Ok` is followed by the adapter-owned append and
 * commit. Callback defects are rethrown after rollback.
 */
export const transaction = async <Value, Failure>(
  database: SqliteTransaction,
  input: OutboxRecordInput,
  callback: TransactionCallback<Value, Failure>,
  options: SqliteOutboxAppendOptions = {}
): Promise<ResultType<Value, Failure | OutboxAppendError>> =>
  withSqliteTransaction(database, async () => {
    let started = false
    const rollback = (primary: unknown): void => {
      if (!started) return
      started = false
      try {
        database.exec('ROLLBACK')
      } catch (cause) {
        throw new AggregateError([primary, cause], 'SQLite outbox transaction cleanup failed')
      }
    }

    try {
      database.exec('BEGIN IMMEDIATE')
      started = true
      const result = await callback(database)
      if (result instanceof Err) {
        rollback(result.error)
        return result as ResultType<Value, Failure | OutboxAppendError>
      }

      const appended = appendIn(database, input, options)
      if (appended instanceof Err) {
        rollback(appended.error)
        return appended as ResultType<Value, Failure | OutboxAppendError>
      }

      database.exec('COMMIT')
      started = false
      return result as ResultType<Value, Failure | OutboxAppendError>
    } catch (cause) {
      rollback(cause)
      throw cause
    }
  })

const makeLayer = <Token extends AnyOutboxStoreToken>(
  token: Token,
  config: SqliteOutboxStoreConfig
): Layer<InstanceType<Token>, never> => {
  const normalized = normalizedConfig(config)
  const scopedConfig = Object.freeze({
    ...normalized,
    namespace: namespaceFor(token, normalized.namespace)
  })
  return Layer.scoped(
    token,
    () => {
      configureDatabase(scopedConfig)
      if (scopedConfig.validateSchema) SqliteMigrator.validate(scopedConfig.database)
      const store = new SqliteOutboxStoreImplementation(scopedConfig)
      return token.of(store as never) as unknown as ServiceContract<InstanceType<Token>>
    },
    (store) => (store as unknown as SqliteOutboxStoreImplementation).dispose()
  )
}

export const SqliteOutboxTransactions = Object.freeze({ appendIn, transaction })

interface SqliteOutboxStoreApi {
  readonly migrate: typeof SqliteMigrator.migrate
  readonly make: (config: SqliteOutboxStoreConfig) => SqliteOutboxStoreContract
  readonly appendIn: typeof appendIn
  readonly transaction: typeof transaction
  readonly layer: (
    config: SqliteOutboxStoreConfig
  ) => Layer<InstanceType<typeof OutboxStoreToken>, never>
  readonly layerFor: <Token extends AnyOutboxStoreToken>(
    token: Token,
    config: SqliteOutboxStoreConfig
  ) => Layer<InstanceType<Token>, never>
}

export const SqliteOutboxStore: SqliteOutboxStoreApi = Object.freeze({
  migrate: (options: SqliteMigrationOptions) => SqliteMigrator.migrate(options),
  make(config: SqliteOutboxStoreConfig): SqliteOutboxStoreContract {
    return makeStore(config)
  },
  appendIn,
  transaction,
  layer(config: SqliteOutboxStoreConfig) {
    return makeLayer(OutboxStoreToken, config)
  },
  layerFor<Token extends AnyOutboxStoreToken>(token: Token, config: SqliteOutboxStoreConfig) {
    return makeLayer(token, config)
  }
})

export const SqliteOutbox: SqliteOutboxStoreApi = SqliteOutboxStore
