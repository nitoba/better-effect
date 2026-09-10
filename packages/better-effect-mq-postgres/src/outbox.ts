// oxlint-disable anti-slop/no-unknown-parameters -- PostgreSQL rows and JSON are validated at this boundary.
// oxlint-disable anti-slop/no-unknown-returns -- untrusted database values are decoded before returning.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- JSON values are confined to the persistence boundary.
// oxlint-disable anti-slop/no-runtime-typeof -- driver and JSON boundaries require runtime narrowing.
// oxlint-disable anti-slop/no-chained-type-assertions -- casts stay at Result and Service erasure boundaries.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- casts are confined to validated driver and Service boundaries.

import { randomUUID } from 'node:crypto'

import { Layer, Service } from 'better-effect'
import type { ServiceClass, ServiceContract, ServiceRequirement } from 'better-effect'
import { Result } from 'better-result'
import type { Result as ResultType } from 'better-result'
import {
  makeOutboxLeaseToken,
  makeOutboxRecord,
  makeSerializedOutboxFailure,
  outboxProtocolVersion,
  validateOutboxRecord
} from 'better-effect-mq-outbox'
import type {
  OutboxAppendError,
  OutboxAppendResult,
  OutboxAppendStore,
  OutboxClaimError,
  OutboxClaimOptions,
  OutboxCounts,
  OutboxEffect,
  OutboxFailureRequest,
  OutboxHeartbeatRequest,
  OutboxLeaseError,
  OutboxLeaseRequest,
  OutboxListOptions,
  OutboxOperation,
  OutboxReadError,
  OutboxRecoveryError,
  OutboxRecoveryOptions,
  OutboxRetryRequest,
  OutboxSettlementError,
  OutboxSettlementResult,
  OutboxStore,
  OutboxStoreDescriptor,
  LeasedOutboxRecord
} from 'better-effect-mq-outbox'
import {
  normalizePostgresJobStoreConfig,
  normalizePostgresJobStoreConnectionConfig,
  validateNamespace,
  validateSchema,
  type Pool,
  type PoolClient,
  type PostgresJobStoreConfig,
  type PostgresJobStoreConnectionConfig
} from './config'
import { PostgresClient } from './client'
import { quoteIdentifier, POSTGRES_TABLES } from './schema'
import {
  normalizePostgresLayerFactory,
  type PostgresLayerFactory,
  type PostgresLayerFactoryRequirements,
  type PostgresLayerGenerator,
  type PostgresLayerRequirements,
  type PostgresLayerValueFactory
} from './layer-factory'
import {
  OutboxConflictError,
  OutboxDefinitionError,
  OutboxLeaseLostError,
  OutboxNotFoundError,
  OutboxStoreFailure
} from 'better-effect-mq-outbox'

export const postgresOutboxTag = '@better-effect/mq-outbox/OutboxStore' as const
const postgresOutboxTypeId = Symbol.for('better-effect-mq-postgres/OutboxStore')
const maxRetries = 3
const maxEpochMs = Number.MAX_SAFE_INTEGER

type Row = Record<string, unknown>
type Tx = PoolClient

const rowColumns = [
  'id',
  'target',
  'protocol_version',
  'state',
  'request',
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
  'failure'
] as const
const selectedColumns = rowColumns.join(',')

const ok = <Value, Failure extends import('better-effect-mq-outbox').OutboxStoreError = never>(
  value: Value
): OutboxEffect<Value, Failure> => Result.ok(value) as unknown as OutboxEffect<Value, Failure>

const errorTag = (cause: unknown): unknown => {
  try {
    return typeof cause === 'object' && cause !== null
      ? (cause as { readonly _tag?: unknown })._tag
      : undefined
  } catch {
    return undefined
  }
}

const isOutboxError = (cause: unknown): boolean =>
  new Set([
    'OutboxDefinitionError',
    'OutboxConflictError',
    'OutboxLeaseLostError',
    'OutboxNotFoundError',
    'OutboxProtocolMismatchError',
    'OutboxStoreFailure'
  ]).has(String(errorTag(cause)))

const postgresErrorCode = (cause: unknown): unknown => {
  try {
    return typeof cause === 'object' && cause !== null
      ? (cause as { readonly code?: unknown }).code
      : undefined
  } catch {
    return undefined
  }
}

const retryable = (cause: unknown): boolean => {
  const code = postgresErrorCode(cause)
  return code === '40001' || code === '40P01'
}

const fail = <Value, Failure extends import('better-effect-mq-outbox').OutboxStoreError>(
  operation: string,
  cause: unknown
): OutboxEffect<Value, Failure> => {
  if (isOutboxError(cause)) return Result.err(cause) as unknown as OutboxEffect<Value, Failure>
  const failure = new OutboxStoreFailure({ operation, retryable: retryable(cause) })
  Object.defineProperty(failure, 'cause', {
    configurable: true,
    enumerable: false,
    value: cause,
    writable: false
  })
  return Result.err(failure) as unknown as OutboxEffect<Value, Failure>
}

const combineFailures = (primary: unknown, cleanup: unknown): unknown =>
  primary === undefined
    ? cleanup
    : cleanup === undefined
      ? primary
      : new AggregateError([primary, cleanup], 'PostgreSQL outbox cleanup failed')

const isResultError = (value: unknown): value is ResultType<unknown, unknown> => {
  try {
    // SAFETY: Result.isError is used only as a nominal runtime predicate for callback values.
    return Result.isError(value as ResultType<unknown, unknown>)
  } catch {
    return false
  }
}

const table = (schema: string): string =>
  `${quoteIdentifier(schema)}.${quoteIdentifier(POSTGRES_TABLES.outbox)}`

const json = (value: unknown): string => JSON.stringify(value)

const parseJson = (value: unknown, field: string): unknown => {
  try {
    return typeof value === 'string' ? JSON.parse(value) : value
  } catch {
    throw new OutboxStoreFailure({ operation: `decode ${field}`, retryable: false })
  }
}

const text = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\u0000')) {
    throw new OutboxStoreFailure({ operation: `decode ${field}`, retryable: false })
  }
  return value
}

const integer = (value: unknown, field: string, minimum = 0): number => {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isSafeInteger(number) || number < minimum || number > maxEpochMs) {
    throw new OutboxStoreFailure({ operation: `decode ${field}`, retryable: false })
  }
  return number
}

const optionalInteger = (value: unknown, field: string): number | undefined =>
  value === null || value === undefined ? undefined : integer(value, field)

const optionalText = (value: unknown, field: string): string | undefined =>
  value === null || value === undefined ? undefined : text(value, field)

const optionalJson = (value: unknown, field: string): unknown =>
  value === null || value === undefined ? undefined : parseJson(value, field)

const decode = (row: Row): import('better-effect-mq-outbox').OutboxRecord => {
  const result = validateOutboxRecord({
    id: text(row.id, 'id'),
    protocolVersion: integer(row.protocol_version, 'protocol_version'),
    target: text(row.target, 'target'),
    state: text(row.state, 'state'),
    request: parseJson(row.request, 'request'),
    requestDigest: text(row.request_digest, 'request_digest'),
    attemptsMax: integer(row.attempts_max, 'attempts_max', 1),
    attemptsMade: integer(row.attempts_made, 'attempts_made'),
    runAtMs: integer(row.run_at_ms, 'run_at_ms'),
    createdAtMs: integer(row.created_at_ms, 'created_at_ms'),
    updatedAtMs: integer(row.updated_at_ms, 'updated_at_ms'),
    publishedAtMs: optionalInteger(row.published_at_ms, 'published_at_ms'),
    leaseOwner: optionalText(row.lease_owner, 'lease_owner'),
    leaseToken: optionalText(row.lease_token, 'lease_token'),
    leaseExpiresAtMs: optionalInteger(row.lease_expires_at_ms, 'lease_expires_at_ms'),
    failure: optionalJson(row.failure, 'failure')
  })
  if (Result.isError(result)) throw result.error
  return result.value
}

const definition = (field: string, message: string): OutboxDefinitionError =>
  new OutboxDefinitionError({ field, message })

const validateTimestamp = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw definition(field, 'must be a non-negative safe integer')
  }
  return value
}

const validatePositive = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw definition(field, 'must be a positive safe integer')
  }
  return value
}

const validateRecordForAppend = (value: import('better-effect-mq-outbox').OutboxRecord) => {
  const checked = validateOutboxRecord(value)
  if (Result.isError(checked)) throw checked.error
  if (
    checked.value.state !== 'pending' ||
    checked.value.attemptsMade !== 0 ||
    checked.value.publishedAtMs !== undefined ||
    checked.value.leaseToken !== undefined ||
    checked.value.failure !== undefined
  ) {
    throw definition('record', 'append requires an initial pending record')
  }
  return checked.value
}

const normalizeAppendOptions = (options: PostgresOutboxAppendOptions = {}) => {
  return {
    namespace: validateNamespace(options.namespace === undefined ? 'default' : options.namespace),
    schema: validateSchema(options.schema === undefined ? 'public' : options.schema)
  }
}

export interface PostgresOutboxAppendOptions {
  readonly namespace?: string
  readonly schema?: string
}

export interface PostgresOutboxStore extends OutboxStore, OutboxAppendStore {
  appendIn(
    transaction: PoolClient,
    record: import('better-effect-mq-outbox').OutboxRecord
  ): Promise<OutboxAppendResult>
  dispose(): Promise<void>
}

const appendRecordIn = async (
  transaction: PoolClient,
  schema: string,
  namespace: string,
  input: import('better-effect-mq-outbox').OutboxRecord
): Promise<OutboxAppendResult> => {
  const record = validateRecordForAppend(input)
  const target = table(schema)
  const inserted = await transaction.query<Row>(
    `INSERT INTO ${target} (namespace,id,target,protocol_version,state,request,request_digest,attempts_max,attempts_made,run_at_ms,created_at_ms,updated_at_ms) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$11) ON CONFLICT (namespace,id) DO NOTHING RETURNING ${selectedColumns}`,
    [
      namespace,
      record.id,
      record.target,
      record.protocolVersion,
      record.state,
      json(record.request),
      record.requestDigest,
      record.attemptsMax,
      record.attemptsMade,
      record.runAtMs,
      record.createdAtMs
    ]
  )
  const created = inserted.rows[0]
  if (created !== undefined) return { record: decode(created), duplicate: false }

  const existingResult = await transaction.query<Row>(
    `SELECT ${selectedColumns} FROM ${target} WHERE namespace=$1 AND id=$2 FOR UPDATE`,
    [namespace, record.id]
  )
  const existing = existingResult.rows[0]
  if (existing === undefined) {
    throw new OutboxStoreFailure({ operation: 'append', retryable: true })
  }
  const current = decode(existing)
  if (current.requestDigest !== record.requestDigest) {
    throw new OutboxConflictError({
      id: record.id,
      existingDigest: current.requestDigest,
      incomingDigest: record.requestDigest
    })
  }
  return { record: current, duplicate: true }
}

const makeLeaseToken = (): import('better-effect-mq-outbox').OutboxLeaseToken => {
  const result = makeOutboxLeaseToken(randomUUID())
  if (Result.isError(result)) throw result.error
  return result.value
}

const expiredLeaseFailure = (nowMs: number) =>
  makeSerializedOutboxFailure({
    kind: 'store-permanent',
    message: 'Outbox lease expired after the attempt limit was reached',
    retryable: false,
    recordedAtMs: nowMs
  }).unwrap()

class PostgresOutboxStoreImplementation implements PostgresOutboxStore {
  readonly descriptor: OutboxStoreDescriptor = Object.freeze({
    protocolVersion: outboxProtocolVersion,
    adapter: 'postgres',
    adapterVersion: '0.1.0'
  })
  private closed = false
  private disposal: Promise<void> | undefined

  constructor(private readonly client: PostgresClient) {}

  append(
    input: import('better-effect-mq-outbox').OutboxRecordInput
  ): OutboxOperation<OutboxAppendResult, OutboxAppendError> {
    let record: import('better-effect-mq-outbox').OutboxRecord
    try {
      const created = makeOutboxRecord(input)
      if (Result.isError(created))
        return fail<OutboxAppendResult, OutboxAppendError>('append', created.error)
      record = created.value
    } catch (cause) {
      return fail<OutboxAppendResult, OutboxAppendError>('append', cause)
    }
    return this.withTx<OutboxAppendResult, OutboxAppendError>('append', (tx) =>
      this.appendIn(tx, record)
    )
  }

  appendIn(
    transaction: PoolClient,
    record: import('better-effect-mq-outbox').OutboxRecord
  ): Promise<OutboxAppendResult> {
    return appendRecordIn(transaction, this.client.schema, this.client.namespace, record)
  }

  claim(
    options: OutboxClaimOptions
  ): OutboxOperation<readonly LeasedOutboxRecord[], OutboxClaimError> {
    try {
      const owner = validateWorker(options.owner)
      const limit = validatePositive(options.limit, 'limit')
      const leaseDurationMs = validatePositive(options.leaseDurationMs, 'leaseDurationMs')
      const nowMs = validateTimestamp(options.nowMs, 'nowMs')
      if (nowMs > maxEpochMs - leaseDurationMs)
        throw definition('leaseDurationMs', 'lease expiry exceeds safe integer range')
      return this.withTx<readonly LeasedOutboxRecord[], OutboxClaimError>('claim', async (tx) => {
        await tx.query(
          `UPDATE ${table(this.client.schema)} SET state=CASE WHEN attempts_made >= attempts_max THEN 'failed' ELSE 'pending' END,run_at_ms=CASE WHEN attempts_made >= attempts_max THEN run_at_ms ELSE GREATEST(run_at_ms,$2) END,updated_at_ms=$2,failure=CASE WHEN attempts_made >= attempts_max THEN $3::jsonb ELSE failure END,lease_owner=NULL,lease_token=NULL,lease_expires_at_ms=NULL WHERE namespace=$1 AND state='active' AND lease_expires_at_ms <= $2`,
          [this.client.namespace, nowMs, json(expiredLeaseFailure(nowMs))]
        )
        const candidates = await tx.query<Row>(
          `SELECT ${selectedColumns} FROM ${table(this.client.schema)} WHERE namespace=$1 AND state='pending' AND run_at_ms <= $2 AND attempts_made < attempts_max ORDER BY run_at_ms ASC,created_at_ms ASC,sequence ASC,id COLLATE "C" ASC LIMIT $3 FOR UPDATE SKIP LOCKED`,
          [this.client.namespace, nowMs, limit]
        )
        const leased: LeasedOutboxRecord[] = []
        for (const candidate of candidates.rows) {
          const current = decode(candidate)
          const leaseToken = makeLeaseToken()
          const result = await tx.query<Row>(
            `UPDATE ${table(this.client.schema)} SET state='active',attempts_made=attempts_made+1,updated_at_ms=$3,lease_owner=$4,lease_token=$5,lease_expires_at_ms=$6 WHERE namespace=$1 AND id=$2 AND state='pending' RETURNING ${selectedColumns}`,
            [this.client.namespace, current.id, nowMs, owner, leaseToken, nowMs + leaseDurationMs]
          )
          const row = result.rows[0]
          if (row !== undefined) leased.push(decode(row) as LeasedOutboxRecord)
        }
        return Object.freeze(leased)
      })
    } catch (cause) {
      return fail<readonly LeasedOutboxRecord[], OutboxClaimError>('claim', cause)
    }
  }

  heartbeat(
    request: OutboxHeartbeatRequest
  ): OutboxOperation<LeasedOutboxRecord, OutboxLeaseError> {
    try {
      const nowMs = validateTimestamp(request.nowMs, 'nowMs')
      const leaseDurationMs = validatePositive(request.leaseDurationMs, 'leaseDurationMs')
      const token = text(request.leaseToken, 'leaseToken')
      if (nowMs > maxEpochMs - leaseDurationMs)
        throw definition('leaseDurationMs', 'lease expiry exceeds safe integer range')
      return this.withTx<LeasedOutboxRecord, OutboxLeaseError>('heartbeat', async (tx) => {
        const result = await tx.query<Row>(
          `UPDATE ${table(this.client.schema)} SET updated_at_ms=$4,lease_expires_at_ms=$5 WHERE namespace=$1 AND id=$2 AND state='active' AND lease_token=$3 AND lease_expires_at_ms > $4 RETURNING ${selectedColumns}`,
          [this.client.namespace, text(request.id, 'id'), token, nowMs, nowMs + leaseDurationMs]
        )
        const row = result.rows[0]
        if (row === undefined) throw await this.leaseFailure(tx, request.id, token, nowMs)
        return decode(row) as LeasedOutboxRecord
      })
    } catch (cause) {
      return fail<LeasedOutboxRecord, OutboxLeaseError>('heartbeat', cause)
    }
  }

  markPublished(
    request: OutboxLeaseRequest
  ): OutboxOperation<OutboxSettlementResult, OutboxSettlementError> {
    return this.settle<OutboxSettlementResult, OutboxSettlementError>(
      'markPublished',
      request,
      async (tx, id, token, nowMs) => {
        const result = await tx.query<Row>(
          `UPDATE ${table(this.client.schema)} SET state='published',published_at_ms=$4,updated_at_ms=$4,lease_owner=NULL,lease_token=NULL,lease_expires_at_ms=NULL WHERE namespace=$1 AND id=$2 AND state='active' AND lease_token=$3 AND lease_expires_at_ms > $4 RETURNING ${selectedColumns}`,
          [this.client.namespace, id, token, nowMs]
        )
        if (result.rows[0] !== undefined) {
          return { record: decode(result.rows[0]), status: 'applied' }
        }
        const current = await this.find(tx, id)
        if (current?.state === 'published') return { record: current, status: 'already-applied' }
        throw await this.leaseFailure(tx, id, token, nowMs)
      }
    )
  }

  markRetry(
    request: OutboxRetryRequest
  ): OutboxOperation<import('better-effect-mq-outbox').OutboxRecord, OutboxSettlementError> {
    try {
      validateTimestamp(request.runAtMs, 'runAtMs')
      return this.settle<import('better-effect-mq-outbox').OutboxRecord, OutboxSettlementError>(
        'markRetry',
        request,
        async (tx, id, token, nowMs) => {
          const failure = makeSerializedOutboxFailure(request.failure)
          if (Result.isError(failure)) throw failure.error
          const result = await tx.query<Row>(
            `UPDATE ${table(this.client.schema)} SET state='pending',run_at_ms=$4,updated_at_ms=$5,failure=$6::jsonb,lease_owner=NULL,lease_token=NULL,lease_expires_at_ms=NULL WHERE namespace=$1 AND id=$2 AND state='active' AND lease_token=$3 AND lease_expires_at_ms > $5 RETURNING ${selectedColumns}`,
            [this.client.namespace, id, token, request.runAtMs, nowMs, json(failure.value)]
          )
          if (result.rows[0] === undefined) throw await this.leaseFailure(tx, id, token, nowMs)
          return decode(result.rows[0])
        }
      )
    } catch (cause) {
      return fail<import('better-effect-mq-outbox').OutboxRecord, OutboxSettlementError>(
        'markRetry',
        cause
      )
    }
  }

  markFailed(
    request: OutboxFailureRequest
  ): OutboxOperation<import('better-effect-mq-outbox').OutboxRecord, OutboxSettlementError> {
    return this.settle<import('better-effect-mq-outbox').OutboxRecord, OutboxSettlementError>(
      'markFailed',
      request,
      async (tx, id, token, nowMs) => {
        const failure = makeSerializedOutboxFailure(request.failure)
        if (Result.isError(failure)) throw failure.error
        const result = await tx.query<Row>(
          `UPDATE ${table(this.client.schema)} SET state='failed',updated_at_ms=$4,failure=$5::jsonb,lease_owner=NULL,lease_token=NULL,lease_expires_at_ms=NULL WHERE namespace=$1 AND id=$2 AND state='active' AND lease_token=$3 AND lease_expires_at_ms > $4 RETURNING ${selectedColumns}`,
          [this.client.namespace, id, token, nowMs, json(failure.value)]
        )
        if (result.rows[0] === undefined) throw await this.leaseFailure(tx, id, token, nowMs)
        return decode(result.rows[0])
      }
    )
  }

  release(
    request: OutboxLeaseRequest
  ): OutboxOperation<import('better-effect-mq-outbox').OutboxRecord, OutboxSettlementError> {
    return this.settle<import('better-effect-mq-outbox').OutboxRecord, OutboxSettlementError>(
      'release',
      request,
      async (tx, id, token, nowMs) => {
        const result = await tx.query<Row>(
          `UPDATE ${table(this.client.schema)} SET state='pending',updated_at_ms=$4,lease_owner=NULL,lease_token=NULL,lease_expires_at_ms=NULL WHERE namespace=$1 AND id=$2 AND state='active' AND lease_token=$3 AND lease_expires_at_ms > $4 RETURNING ${selectedColumns}`,
          [this.client.namespace, id, token, nowMs]
        )
        if (result.rows[0] === undefined) throw await this.leaseFailure(tx, id, token, nowMs)
        return decode(result.rows[0])
      }
    )
  }

  recoverStalled(
    options: OutboxRecoveryOptions
  ): OutboxOperation<
    readonly import('better-effect-mq-outbox').OutboxRecord[],
    OutboxRecoveryError
  > {
    try {
      const maxCount = validatePositive(options.maxCount, 'maxCount')
      const nowMs = validateTimestamp(options.nowMs, 'nowMs')
      return this.withTx<
        readonly import('better-effect-mq-outbox').OutboxRecord[],
        OutboxRecoveryError
      >('recoverStalled', async (tx) => {
        const candidates = await tx.query<Row>(
          `SELECT ${selectedColumns} FROM ${table(this.client.schema)} WHERE namespace=$1 AND state='active' AND lease_expires_at_ms <= $2 ORDER BY lease_expires_at_ms ASC,sequence ASC,id COLLATE "C" ASC LIMIT $3 FOR UPDATE SKIP LOCKED`,
          [this.client.namespace, nowMs, maxCount]
        )
        const recovered: import('better-effect-mq-outbox').OutboxRecord[] = []
        for (const candidate of candidates.rows) {
          const current = decode(candidate)
          const terminal = current.attemptsMade >= current.attemptsMax
          const failure = terminal ? expiredLeaseFailure(nowMs) : undefined
          const result = await tx.query<Row>(
            `UPDATE ${table(this.client.schema)} SET state=$3,run_at_ms=$4,updated_at_ms=$5,failure=CASE WHEN $6::jsonb IS NULL THEN failure ELSE $6::jsonb END,lease_owner=NULL,lease_token=NULL,lease_expires_at_ms=NULL WHERE namespace=$1 AND id=$2 AND state='active' RETURNING ${selectedColumns}`,
            [
              this.client.namespace,
              current.id,
              terminal ? 'failed' : 'pending',
              terminal ? current.runAtMs : Math.max(current.runAtMs, nowMs),
              nowMs,
              failure === undefined ? null : json(failure)
            ]
          )
          if (result.rows[0] !== undefined) recovered.push(decode(result.rows[0]))
        }
        return Object.freeze(recovered)
      })
    } catch (cause) {
      return fail<readonly import('better-effect-mq-outbox').OutboxRecord[], OutboxRecoveryError>(
        'recoverStalled',
        cause
      )
    }
  }

  get(
    id: import('better-effect-mq-outbox').OutboxId
  ): OutboxOperation<import('better-effect-mq-outbox').OutboxRecord | undefined, OutboxReadError> {
    return this.read<import('better-effect-mq-outbox').OutboxRecord | undefined, OutboxReadError>(
      'get',
      async (client) => {
        const result = await client.query<Row>(
          `SELECT ${selectedColumns} FROM ${table(this.client.schema)} WHERE namespace=$1 AND id=$2`,
          [this.client.namespace, text(id, 'id')]
        )
        return result.rows[0] === undefined ? undefined : decode(result.rows[0])
      }
    )
  }

  list(
    options: OutboxListOptions = {}
  ): OutboxOperation<readonly import('better-effect-mq-outbox').OutboxRecord[], OutboxReadError> {
    try {
      const limit = options.limit === undefined ? 100 : validatePositive(options.limit, 'limit')
      const states =
        options.state === undefined
          ? undefined
          : typeof options.state === 'string'
            ? [options.state]
            : options.state
      if (
        states !== undefined &&
        states.some((state) => !['pending', 'active', 'published', 'failed'].includes(state))
      )
        throw definition('state', 'contains an unsupported state')
      if (options.target !== undefined) text(options.target, 'target')
      return this.read<readonly import('better-effect-mq-outbox').OutboxRecord[], OutboxReadError>(
        'list',
        async (client) => {
          const predicates = ['namespace=$1']
          const values: unknown[] = [this.client.namespace]
          if (states !== undefined) {
            predicates.push(`state = ANY($${values.length + 1}::text[])`)
            values.push(states)
          }
          if (options.target !== undefined) {
            predicates.push(`target=$${values.length + 1}`)
            values.push(options.target)
          }
          values.push(limit)
          const result = await client.query<Row>(
            `SELECT ${selectedColumns} FROM ${table(this.client.schema)} WHERE ${predicates.join(' AND ')} ORDER BY created_at_ms ASC,sequence ASC,id COLLATE "C" ASC LIMIT $${values.length}`,
            values
          )
          return Object.freeze(result.rows.map(decode))
        }
      )
    } catch (cause) {
      return fail<readonly import('better-effect-mq-outbox').OutboxRecord[], OutboxReadError>(
        'list',
        cause
      )
    }
  }

  counts(): OutboxOperation<OutboxCounts, OutboxReadError> {
    return this.read<OutboxCounts, OutboxReadError>('counts', async (client) => {
      const result = await client.query<{
        readonly state: string
        readonly count: number | string
      }>(
        `SELECT state,count(*)::bigint AS count FROM ${table(this.client.schema)} WHERE namespace=$1 GROUP BY state`,
        [this.client.namespace]
      )
      const counts = { pending: 0, active: 0, published: 0, failed: 0, total: 0 }
      for (const row of result.rows) {
        if (!(row.state in counts) || row.state === 'total') continue
        const count = integer(row.count, 'count')
        counts[row.state as keyof Omit<OutboxCounts, 'total'>] = count
        counts.total += count
      }
      return Object.freeze(counts)
    })
  }

  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.closed = true
    this.disposal = this.client.dispose()
    return this.disposal
  }

  private async find(
    tx: Tx,
    id: import('better-effect-mq-outbox').OutboxId
  ): Promise<import('better-effect-mq-outbox').OutboxRecord | undefined> {
    const result = await tx.query<Row>(
      `SELECT ${selectedColumns} FROM ${table(this.client.schema)} WHERE namespace=$1 AND id=$2 FOR UPDATE`,
      [this.client.namespace, text(id, 'id')]
    )
    return result.rows[0] === undefined ? undefined : decode(result.rows[0])
  }

  private async leaseFailure(
    tx: Tx,
    id: import('better-effect-mq-outbox').OutboxId,
    token: string,
    nowMs: number
  ): Promise<never> {
    const current = await this.find(tx, id)
    if (current === undefined) throw new OutboxNotFoundError({ id })
    if (current.state !== 'active')
      throw new OutboxLeaseLostError({ id, leaseToken: token, reason: 'not-active' })
    if (current.leaseToken === undefined)
      throw new OutboxLeaseLostError({ id, leaseToken: token, reason: 'missing-token' })
    if (current.leaseToken !== token)
      throw new OutboxLeaseLostError({ id, leaseToken: token, reason: 'mismatched-token' })
    if (current.leaseExpiresAtMs === undefined || current.leaseExpiresAtMs <= nowMs)
      throw new OutboxLeaseLostError({ id, leaseToken: token, reason: 'expired-lease' })
    throw new OutboxLeaseLostError({ id, leaseToken: token, reason: 'not-active' })
  }

  private async settle<Value, Failure extends import('better-effect-mq-outbox').OutboxStoreError>(
    operation: string,
    request: OutboxLeaseRequest,
    body: (
      tx: Tx,
      id: import('better-effect-mq-outbox').OutboxId,
      token: string,
      nowMs: number
    ) => Promise<Value>
  ): Promise<OutboxEffect<Value, Failure>> {
    try {
      const id = text(request.id, 'id') as import('better-effect-mq-outbox').OutboxId
      const token = text(request.leaseToken, 'leaseToken')
      const nowMs = validateTimestamp(request.nowMs, 'nowMs')
      return this.withTx<Value, Failure>(operation, (tx) => body(tx, id, token, nowMs))
    } catch (cause) {
      return fail<Value, Failure>(operation, cause)
    }
  }

  private async read<Value, Failure extends import('better-effect-mq-outbox').OutboxStoreError>(
    operation: string,
    body: (client: Tx) => Promise<Value>
  ): Promise<OutboxEffect<Value, Failure>> {
    if (this.closed) return fail<Value, Failure>(operation, new Error('store is closed'))
    let client: PoolClient | undefined
    let value: Value | undefined
    let primary: unknown
    try {
      client = await this.client.pool.connect()
      value = await body(client)
    } catch (cause) {
      primary = cause
    }
    let releaseFailure: unknown
    if (client !== undefined) {
      try {
        client.release()
      } catch (cause) {
        releaseFailure = cause
      }
    }
    const failure = combineFailures(primary, releaseFailure)
    if (failure !== undefined) return fail<Value, Failure>(operation, failure)
    return ok<Value, Failure>(value as Value)
  }

  private async withTx<Value, Failure extends import('better-effect-mq-outbox').OutboxStoreError>(
    operation: string,
    body: (tx: Tx) => Promise<Value>
  ): Promise<OutboxEffect<Value, Failure>> {
    if (this.closed) return fail<Value, Failure>(operation, new Error('store is closed'))
    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
      let tx: PoolClient | undefined
      let value: Value | undefined
      let primary: unknown
      let cleanup: unknown
      let committed = false
      try {
        tx = await this.client.pool.connect()
        await tx.query('BEGIN')
        value = await body(tx)
        await tx.query('COMMIT')
        committed = true
      } catch (cause) {
        primary = cause
      }
      if (!committed && tx !== undefined) {
        try {
          await tx.query('ROLLBACK')
        } catch (cause) {
          cleanup = cause
        }
      }
      if (tx !== undefined) {
        try {
          tx.release()
        } catch (cause) {
          cleanup = combineFailures(cleanup, cause)
        }
      }
      if (primary !== undefined) {
        if (cleanup === undefined && retryable(primary) && attempt + 1 < maxRetries) continue
        return fail<Value, Failure>(operation, combineFailures(primary, cleanup))
      }
      if (cleanup !== undefined) return fail<Value, Failure>(operation, cleanup)
      return ok<Value, Failure>(value as Value)
    }
    return fail<Value, Failure>(operation, new Error('retry budget exhausted'))
  }
}

const validateWorker = (value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\u0000'))
    throw definition('owner', 'must be a non-empty string without NUL')
  return value
}

export type PostgresOutboxInstance<Name extends string | undefined = undefined> =
  PostgresOutboxStore & Service.Identity<PostgresOutboxTag<Name>>

export type PostgresOutboxTag<Name extends string | undefined = undefined> = [Name] extends [
  undefined
]
  ? typeof postgresOutboxTag
  : `${typeof postgresOutboxTag}/${Extract<Name, string>}`

export type PostgresOutboxToken<Name extends string | undefined = undefined> = ServiceClass<
  PostgresOutboxTag<Name>,
  PostgresOutboxInstance<Name>
> &
  (new () => PostgresOutboxInstance<Name>) & {
    readonly [Symbol.asyncIterator]: () => AsyncGenerator<
      ServiceRequirement<PostgresOutboxInstance<Name>>,
      PostgresOutboxInstance<Name>,
      unknown
    >
  }

export type DefaultPostgresOutboxToken = PostgresOutboxToken<undefined> & {
  readonly named: <const Name extends string>(name: Name) => PostgresOutboxToken<Name>
}

export type AnyPostgresOutboxToken = DefaultPostgresOutboxToken | PostgresOutboxToken<string>

const makeToken = <Name extends string | undefined>(name: Name): PostgresOutboxToken<Name> => {
  const tag = (
    name === undefined ? postgresOutboxTag : `${postgresOutboxTag}/${name}`
  ) as PostgresOutboxTag<Name>
  const token = Service<PostgresOutboxInstance<Name>>()(tag as never)
  Object.defineProperty(token, postgresOutboxTypeId, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false
  })
  return token as unknown as PostgresOutboxToken<Name>
}

const namedOutbox = <const Name extends string>(name: Name): PostgresOutboxToken<Name> => {
  if (typeof name !== 'string' || name.length === 0 || name.includes('\u0000'))
    throw new TypeError('PostgresOutbox.named requires a non-empty string name')
  return makeToken(name)
}

const makeStore = (config: PostgresJobStoreConfig): PostgresOutboxStore =>
  new PostgresOutboxStoreImplementation(PostgresClient.fromPool(config))

const makeLayer = <
  Token extends AnyPostgresOutboxToken,
  Yield extends ServiceRequirement<unknown> = never
>(
  token: Token,
  acquire: PostgresLayerFactory<PostgresClient, Yield>,
  ownsClient: boolean
): Layer<InstanceType<Token>, PostgresLayerRequirements<Yield>> =>
  Layer.scopedGen(
    token,
    async function* () {
      const client = yield* normalizePostgresLayerFactory(acquire)()
      let implementation: PostgresOutboxStoreImplementation | undefined
      try {
        if (client.validateSchema) await client.validate()
        implementation = new PostgresOutboxStoreImplementation(client)
        return implementation as unknown as ServiceContract<InstanceType<Token>>
      } catch (cause) {
        let cleanup: unknown
        if (implementation !== undefined) {
          try {
            await implementation.dispose()
          } catch (failure) {
            cleanup = failure
          }
        } else if (ownsClient) {
          try {
            await client.dispose()
          } catch (failure) {
            cleanup = failure
          }
        }
        throw combineFailures(cause, cleanup)
      }
    },
    async (store) => {
      await (store as unknown as PostgresOutboxStoreImplementation).dispose()
    }
  ) as Layer<InstanceType<Token>, PostgresLayerRequirements<Yield>>

const namespaceForToken = (token: AnyPostgresOutboxToken, namespace: string): string =>
  token.serviceTag === postgresOutboxTag
    ? namespace
    : `${namespace}:outbox-${token.serviceTag.slice(`${postgresOutboxTag}/`.length)}`

const borrowedClient = (token: AnyPostgresOutboxToken, config: PostgresJobStoreConfig) => {
  const normalized = normalizePostgresJobStoreConfig(config)
  return async () =>
    PostgresClient.fromPool({
      ...normalized,
      namespace: namespaceForToken(token, normalized.namespace)
    })
}

const borrowedClientFromFactory = <Yield extends ServiceRequirement<unknown>>(
  token: AnyPostgresOutboxToken,
  factory: PostgresLayerFactory<PostgresJobStoreConfig, Yield>
): PostgresLayerFactory<PostgresClient, Yield> =>
  async function* () {
    const config = yield* normalizePostgresLayerFactory(factory)()
    const normalized = normalizePostgresJobStoreConfig(config)
    return PostgresClient.fromPool({
      ...normalized,
      namespace: namespaceForToken(token, normalized.namespace)
    })
  }

const ownedClient = (token: AnyPostgresOutboxToken, config: PostgresJobStoreConnectionConfig) => {
  const normalized = normalizePostgresJobStoreConnectionConfig(config)
  return () =>
    PostgresClient.fromConfig({
      ...normalized,
      namespace: namespaceForToken(token, normalized.namespace)
    })
}

const ownedClientFromFactory = <Yield extends ServiceRequirement<unknown>>(
  token: AnyPostgresOutboxToken,
  factory: PostgresLayerFactory<PostgresJobStoreConnectionConfig, Yield>
): PostgresLayerFactory<PostgresClient, Yield> =>
  async function* () {
    const config = yield* normalizePostgresLayerFactory(factory)()
    const normalized = normalizePostgresJobStoreConnectionConfig(config)
    return await PostgresClient.fromConfig({
      ...normalized,
      namespace: namespaceForToken(token, normalized.namespace)
    })
  }

const defaultToken = makeToken(undefined) as unknown as DefaultPostgresOutboxToken

/** Append through a caller-owned transaction; the advanced escape hatch. */
const staticAppendIn = async (
  transaction: PoolClient,
  record: import('better-effect-mq-outbox').OutboxRecord,
  options: PostgresOutboxAppendOptions = {}
): Promise<OutboxAppendResult> => {
  const normalized = normalizeAppendOptions(options)
  return appendRecordIn(transaction, normalized.schema, normalized.namespace, record)
}

/** Run a domain callback and append its outbox record in one adapter-owned transaction. */
const staticTransaction = async <Value>(
  pool: Pool,
  record: import('better-effect-mq-outbox').OutboxRecord,
  callback: (transaction: PoolClient) => Value | PromiseLike<Value>,
  options: PostgresOutboxAppendOptions = {}
): Promise<Value> => {
  const normalized = normalizeAppendOptions(options)
  let transaction: PoolClient | undefined
  let value: Value | undefined
  let primary: unknown
  let cleanup: unknown
  let failed = false
  let nominalResultFailure = false
  let committed = false

  try {
    transaction = await pool.connect()
    await transaction.query('BEGIN')
    value = await callback(transaction)
    if (isResultError(value)) {
      failed = true
      nominalResultFailure = true
    } else {
      await appendRecordIn(transaction, normalized.schema, normalized.namespace, record)
      await transaction.query('COMMIT')
      committed = true
    }
  } catch (cause) {
    failed = true
    primary = cause
  }

  if (!committed && transaction !== undefined) {
    try {
      await transaction.query('ROLLBACK')
    } catch (cause) {
      cleanup = cause
    }
  }

  if (transaction !== undefined) {
    try {
      transaction.release()
    } catch (cause) {
      cleanup = combineFailures(cleanup, cause)
    }
  }

  if (failed) {
    if (nominalResultFailure && cleanup === undefined) return value as Value
    throw combineFailures(primary, cleanup) ?? primary
  }
  if (cleanup !== undefined) throw cleanup
  return value as Value
}

type PostgresOutboxApi = {
  readonly named: typeof namedOutbox
  readonly appendIn: typeof staticAppendIn
  readonly transaction: typeof staticTransaction
  readonly make: typeof makeStore
  readonly layer: (config: PostgresJobStoreConfig) => Layer<PostgresOutboxInstance, never>
  readonly layerFor: <Token extends AnyPostgresOutboxToken>(
    token: Token,
    config: PostgresJobStoreConfig
  ) => Layer<InstanceType<Token>, never>
  readonly layerWith: {
    <Factory extends PostgresLayerGenerator<PostgresJobStoreConfig, ServiceRequirement<unknown>>>(
      factory: Factory
    ): Layer<PostgresOutboxInstance, PostgresLayerFactoryRequirements<Factory>>
    (
      factory: PostgresLayerValueFactory<PostgresJobStoreConfig>
    ): Layer<PostgresOutboxInstance, never>
  }
  readonly layerWithFor: {
    <
      Token extends AnyPostgresOutboxToken,
      Factory extends PostgresLayerGenerator<PostgresJobStoreConfig, ServiceRequirement<unknown>>
    >(
      token: Token,
      factory: Factory
    ): Layer<InstanceType<Token>, PostgresLayerFactoryRequirements<Factory>>
    <Token extends AnyPostgresOutboxToken>(
      token: Token,
      factory: PostgresLayerValueFactory<PostgresJobStoreConfig>
    ): Layer<InstanceType<Token>, never>
  }
  readonly layerFromConfig: (
    config: PostgresJobStoreConnectionConfig
  ) => Layer<PostgresOutboxInstance, never>
  readonly layerFromConfigFor: <Token extends AnyPostgresOutboxToken>(
    token: Token,
    config: PostgresJobStoreConnectionConfig
  ) => Layer<InstanceType<Token>, never>
  readonly layerFromConfigWith: {
    <
      Factory extends PostgresLayerGenerator<
        PostgresJobStoreConnectionConfig,
        ServiceRequirement<unknown>
      >
    >(
      factory: Factory
    ): Layer<PostgresOutboxInstance, PostgresLayerFactoryRequirements<Factory>>
    (
      factory: PostgresLayerValueFactory<PostgresJobStoreConnectionConfig>
    ): Layer<PostgresOutboxInstance, never>
  }
  readonly layerFromConfigWithFor: {
    <
      Token extends AnyPostgresOutboxToken,
      Factory extends PostgresLayerGenerator<
        PostgresJobStoreConnectionConfig,
        ServiceRequirement<unknown>
      >
    >(
      token: Token,
      factory: Factory
    ): Layer<InstanceType<Token>, PostgresLayerFactoryRequirements<Factory>>
    <Token extends AnyPostgresOutboxToken>(
      token: Token,
      factory: PostgresLayerValueFactory<PostgresJobStoreConnectionConfig>
    ): Layer<InstanceType<Token>, never>
  }
}

const api: PostgresOutboxApi = {
  named: namedOutbox,
  appendIn: staticAppendIn,
  transaction: staticTransaction,
  make: makeStore,
  layer: (config: PostgresJobStoreConfig) => {
    return makeLayer(defaultToken, borrowedClient(defaultToken, config), false)
  },
  layerFor: <Token extends AnyPostgresOutboxToken>(
    token: Token,
    config: PostgresJobStoreConfig
  ) => {
    return makeLayer(token, borrowedClient(token, config), false)
  },
  layerWith: <Yield extends ServiceRequirement<unknown>>(
    factory: PostgresLayerFactory<PostgresJobStoreConfig, Yield>
  ) => makeLayer(defaultToken, borrowedClientFromFactory(defaultToken, factory), false),
  layerWithFor: <Token extends AnyPostgresOutboxToken, Yield extends ServiceRequirement<unknown>>(
    token: Token,
    factory: PostgresLayerFactory<PostgresJobStoreConfig, Yield>
  ) => makeLayer(token, borrowedClientFromFactory(token, factory), false),
  layerFromConfig: (config: PostgresJobStoreConnectionConfig) => {
    return makeLayer(defaultToken, ownedClient(defaultToken, config), true)
  },
  layerFromConfigFor: <Token extends AnyPostgresOutboxToken>(
    token: Token,
    config: PostgresJobStoreConnectionConfig
  ) => {
    return makeLayer(token, ownedClient(token, config), true)
  },
  layerFromConfigWith: <Yield extends ServiceRequirement<unknown>>(
    factory: PostgresLayerFactory<PostgresJobStoreConnectionConfig, Yield>
  ) => makeLayer(defaultToken, ownedClientFromFactory(defaultToken, factory), true),
  layerFromConfigWithFor: <
    Token extends AnyPostgresOutboxToken,
    Yield extends ServiceRequirement<unknown>
  >(
    token: Token,
    factory: PostgresLayerFactory<PostgresJobStoreConnectionConfig, Yield>
  ) => makeLayer(token, ownedClientFromFactory(token, factory), true)
}

Object.defineProperties(defaultToken, {
  named: { configurable: false, enumerable: true, value: api.named, writable: false },
  appendIn: { configurable: false, enumerable: true, value: api.appendIn, writable: false },
  transaction: { configurable: false, enumerable: true, value: api.transaction, writable: false },
  make: { configurable: false, enumerable: true, value: api.make, writable: false },
  layer: { configurable: false, enumerable: true, value: api.layer, writable: false },
  layerFor: { configurable: false, enumerable: true, value: api.layerFor, writable: false },
  layerWith: { configurable: false, enumerable: true, value: api.layerWith, writable: false },
  layerWithFor: {
    configurable: false,
    enumerable: true,
    value: api.layerWithFor,
    writable: false
  },
  layerFromConfig: {
    configurable: false,
    enumerable: true,
    value: api.layerFromConfig,
    writable: false
  },
  layerFromConfigFor: {
    configurable: false,
    enumerable: true,
    value: api.layerFromConfigFor,
    writable: false
  },
  layerFromConfigWith: {
    configurable: false,
    enumerable: true,
    value: api.layerFromConfigWith,
    writable: false
  },
  layerFromConfigWithFor: {
    configurable: false,
    enumerable: true,
    value: api.layerFromConfigWithFor,
    writable: false
  }
})

export const PostgresOutbox = defaultToken as DefaultPostgresOutboxToken & typeof api
export const PostgresOutboxStore = Object.freeze(api)

export const isPostgresOutboxToken = (value: unknown): value is AnyPostgresOutboxToken => {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false
  try {
    const marker = Object.getOwnPropertyDescriptor(value, postgresOutboxTypeId)
    const candidate = value as {
      readonly serviceTag?: unknown
      readonly [Symbol.asyncIterator]?: unknown
    }
    return (
      marker !== undefined &&
      'value' in marker &&
      marker.value === true &&
      typeof candidate.serviceTag === 'string' &&
      (candidate.serviceTag === postgresOutboxTag ||
        candidate.serviceTag.startsWith(`${postgresOutboxTag}/`)) &&
      typeof candidate[Symbol.asyncIterator] === 'function'
    )
  } catch {
    return false
  }
}
