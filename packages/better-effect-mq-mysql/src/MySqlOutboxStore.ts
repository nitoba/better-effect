// oxlint-disable anti-slop/no-runtime-typeof -- driver rows and public DTOs are untyped boundaries.
// oxlint-disable anti-slop/no-unknown-parameters -- store requests are validated before SQL.
// oxlint-disable anti-slop/no-unknown-returns -- JSON rows are decoded through OutboxRecord validation.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- SQL rows are decoded through the OutboxRecord validator.
// oxlint-disable anti-slop/no-chained-type-assertions -- validated SQL rows restore branded DTOs.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- assertions stay at validated persistence boundaries.

import { randomUUID } from 'node:crypto'
import { Layer } from 'better-effect'
import { Result, type Result as ResultType } from 'better-result'
import {
  OutboxDefinitionError,
  OutboxLeaseLostError,
  OutboxNotFoundError,
  OutboxStoreFailure,
  makeOutboxId,
  makeSerializedOutboxFailure,
  makeOutboxLeaseToken,
  makeOutboxWorkerId,
  outboxProtocolVersion,
  type LeasedOutboxRecord,
  type OutboxClaimError,
  type OutboxClaimOptions,
  type OutboxCounts,
  type OutboxEffect,
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
  type OutboxRetryRequest,
  type OutboxSettlementError,
  type OutboxSettlementResult,
  type OutboxStore as OutboxStoreContract,
  type OutboxStoreDescriptor,
  type SerializedOutboxFailure,
  type OutboxState
} from 'better-effect-mq-outbox'

import {
  decodeOutboxRow,
  isMySqlRetryable,
  isOutboxStoreError,
  mySqlFailure,
  namespaceForOutboxToken,
  outboxColumnNames,
  outboxTable
} from './MySqlOutbox'
import { MySqlClient } from './client'
import {
  normalizeMySqlJobStoreConfig,
  normalizeMySqlJobStoreConnectionConfig,
  type MySqlJobStoreConfig,
  type MySqlJobStoreConnectionConfig,
  type PoolConnection
} from './config'
import { OutboxStore, type AnyOutboxStoreToken } from './outbox-token'

type Row = Record<string, unknown>
type StoreResult<Value> = OutboxEffect<Value>
type Tx = PoolConnection

const succeeded = <Value>(value: Value): OutboxEffect<Value, never> =>
  Result.ok(value) as unknown as OutboxEffect<Value, never>
const failed = (error: import('better-effect-mq-outbox').OutboxStoreError): StoreResult<never> =>
  Result.err(error) as unknown as StoreResult<never>
const json = (value: unknown): string => JSON.stringify(value)
const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const invalid = <Value>(field: string, message: string): ResultType<Value, OutboxDefinitionError> =>
  Result.err(new OutboxDefinitionError({ field, message }))

const positive = (value: unknown, field: string): ResultType<number, OutboxDefinitionError> => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    return Result.err(
      new OutboxDefinitionError({ field, message: 'must be a positive safe integer' })
    )
  return Result.ok(value)
}
const timestamp = (value: unknown, field: string): ResultType<number, OutboxDefinitionError> => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    return Result.err(
      new OutboxDefinitionError({ field, message: 'must be a non-negative safe integer' })
    )
  return Result.ok(value)
}
const target = (value: unknown): ResultType<string, OutboxDefinitionError> => {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\u0000'))
    return Result.err(
      new OutboxDefinitionError({
        field: 'target',
        message: 'must be a non-empty string without NUL'
      })
    )
  return Result.ok(value)
}

const validateClaim = (
  value: OutboxClaimOptions
): ResultType<OutboxClaimOptions, OutboxDefinitionError> => {
  if (!isObjectRecord(value)) return invalid('options', 'must be an object')
  const owner = makeOutboxWorkerId(value.owner)
  const limit = positive(value.limit, 'limit')
  const leaseDurationMs = positive(value.leaseDurationMs, 'leaseDurationMs')
  const nowMs = timestamp(value.nowMs, 'nowMs')
  if (Result.isError(owner)) return owner
  if (Result.isError(limit)) return limit
  if (Result.isError(leaseDurationMs)) return leaseDurationMs
  if (Result.isError(nowMs)) return nowMs
  if (nowMs.value > Number.MAX_SAFE_INTEGER - leaseDurationMs.value)
    return Result.err(
      new OutboxDefinitionError({
        field: 'leaseDurationMs',
        message: 'lease expiry exceeds safe integer range'
      })
    )
  return Result.ok({
    owner: owner.value,
    limit: limit.value,
    leaseDurationMs: leaseDurationMs.value,
    nowMs: nowMs.value
  })
}

const validateLease = (
  value: OutboxLeaseRequest | OutboxHeartbeatRequest
): ResultType<
  OutboxLeaseRequest & Partial<Pick<OutboxHeartbeatRequest, 'leaseDurationMs'>>,
  OutboxDefinitionError
> => {
  if (!isObjectRecord(value)) return invalid('request', 'must be an object')
  const nowMs = timestamp(value.nowMs, 'nowMs')
  const token = makeOutboxLeaseToken(value.leaseToken)
  const id = makeOutboxId(value.id)
  if (Result.isError(nowMs)) return nowMs
  if (Result.isError(token)) return token
  if (Result.isError(id)) return id
  if ('leaseDurationMs' in value) {
    const duration = positive(value.leaseDurationMs, 'leaseDurationMs')
    if (Result.isError(duration)) return duration
    if (nowMs.value > Number.MAX_SAFE_INTEGER - duration.value)
      return Result.err(
        new OutboxDefinitionError({
          field: 'leaseDurationMs',
          message: 'lease expiry exceeds safe integer range'
        })
      )
    return Result.ok({
      id: id.value,
      leaseToken: token.value,
      nowMs: nowMs.value,
      leaseDurationMs: duration.value
    })
  }
  return Result.ok({ id: id.value, leaseToken: token.value, nowMs: nowMs.value })
}

const failureValue = (
  value: SerializedOutboxFailure
): ResultType<SerializedOutboxFailure, OutboxDefinitionError> => {
  try {
    return makeSerializedOutboxFailure(value)
  } catch {
    return Result.err(new OutboxDefinitionError({ field: 'failure', message: 'is invalid' }))
  }
}

const states = (
  value: OutboxListOptions['state']
): ResultType<readonly OutboxState[] | undefined, OutboxDefinitionError> => {
  if (value === undefined) return Result.ok(undefined)
  const values = typeof value === 'string' ? [value] : value
  if (!Array.isArray(values) || values.length === 0)
    return Result.err(new OutboxDefinitionError({ field: 'state', message: 'must not be empty' }))
  if (
    values.some(
      (state) =>
        state !== 'pending' && state !== 'active' && state !== 'published' && state !== 'failed'
    )
  )
    return Result.err(
      new OutboxDefinitionError({ field: 'state', message: 'contains an unsupported state' })
    )
  return Result.ok(Object.freeze([...new Set(values)] as OutboxState[]))
}

const descriptor: OutboxStoreDescriptor = Object.freeze({
  protocolVersion: outboxProtocolVersion,
  adapter: 'mysql',
  adapterVersion: '0.1.0'
})

class MySqlOutboxStoreImplementation implements OutboxStoreContract {
  readonly descriptor = descriptor
  private closed = false
  private disposal: Promise<void> | undefined

  constructor(private readonly client: MySqlClient) {}

  private async withTx<Value>(
    operation: string,
    body: (tx: Tx) => Promise<Value>
  ): Promise<StoreResult<Value>> {
    if (this.closed) return failed(mySqlFailure(operation, new Error('store is closed'), false))
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let tx: Tx | undefined
      let result: Value | undefined
      let primary: unknown
      let cleanup: unknown
      let committed = false
      let commitStarted = false
      try {
        tx = await this.client.pool.getConnection()
        await tx.beginTransaction()
        result = await body(tx)
        commitStarted = true
        await tx.commit()
        committed = true
      } catch (cause) {
        primary = cause
      }
      if (!committed && tx !== undefined) {
        try {
          await tx.rollback()
        } catch (cause) {
          cleanup = cause
        }
      }
      if (tx !== undefined) {
        try {
          tx.release()
        } catch (cause) {
          cleanup = cleanup === undefined ? cause : new AggregateError([cleanup, cause])
        }
      }
      if (primary !== undefined) {
        if (!commitStarted && isMySqlRetryable(primary) && attempt < 2) continue
        if (isOutboxStoreError(primary)) return failed(primary)
        return failed(mySqlFailure(operation, primary, isMySqlRetryable(primary)))
      }
      if (cleanup !== undefined) return failed(mySqlFailure(`${operation} cleanup`, cleanup, false))
      return succeeded(result as Value)
    }
    return failed(mySqlFailure(operation, new Error('transaction retry budget exhausted'), true))
  }

  private async row(tx: Tx, id: string, lock = false): Promise<OutboxRecord | undefined> {
    const result = await tx.query<Row>(
      `SELECT ${outboxColumnNames.join(',')} FROM ${outboxTable} WHERE namespace=? AND id=?${lock ? ' FOR UPDATE' : ''}`,
      [this.client.namespace, id]
    )
    const raw = result.rows[0]
    return raw === undefined ? undefined : decodeOutboxRow(raw)
  }

  private ensureLease(
    record: OutboxRecord | undefined,
    id: string,
    token: string,
    nowMs: number
  ): LeasedOutboxRecord {
    if (record === undefined) throw new OutboxNotFoundError({ id })
    if (record.state !== 'active')
      throw new OutboxLeaseLostError({ id, leaseToken: token, reason: 'not-active' })
    if (record.leaseToken === undefined)
      throw new OutboxLeaseLostError({ id, leaseToken: token, reason: 'missing-token' })
    if (record.leaseToken !== token)
      throw new OutboxLeaseLostError({ id, leaseToken: token, reason: 'mismatched-token' })
    if (record.leaseExpiresAtMs === undefined || record.leaseExpiresAtMs <= nowMs)
      throw new OutboxLeaseLostError({ id, leaseToken: token, reason: 'expired-lease' })
    return record as LeasedOutboxRecord
  }

  private async recoverExpiredInTx(tx: Tx, nowMs: number, limit: number): Promise<OutboxRecord[]> {
    const selected = await tx.query<Row>(
      `SELECT ${outboxColumnNames.join(',')} FROM ${outboxTable} WHERE namespace=? AND state='active' AND lease_expires_at_ms <= ? ORDER BY lease_expires_at_ms,ordering_sequence,id COLLATE utf8mb4_bin LIMIT ? FOR UPDATE SKIP LOCKED`,
      [this.client.namespace, nowMs, limit]
    )
    const recovered: OutboxRecord[] = []
    for (const raw of selected.rows) {
      const current = decodeOutboxRow(raw)
      const terminal = current.attemptsMade >= current.attemptsMax
      const failure = terminal
        ? makeSerializedOutboxFailure({
            kind: 'store-permanent',
            message: 'Outbox lease expired after the attempt limit was reached',
            retryable: false,
            recordedAtMs: nowMs
          }).unwrap()
        : undefined
      await tx.query(
        `UPDATE ${outboxTable} SET state=?,run_at_ms=?,updated_at_ms=?,lease_owner=NULL,lease_token=NULL,lease_expires_at_ms=NULL,failure=? WHERE namespace=? AND id=? AND state='active' AND lease_token=?`,
        [
          terminal ? 'failed' : 'pending',
          current.runAtMs,
          nowMs,
          failure === undefined
            ? current.failure === undefined
              ? null
              : json(current.failure)
            : json(failure),
          this.client.namespace,
          current.id,
          current.leaseToken
        ]
      )
      const updated = await this.row(tx, current.id, true)
      if (updated === undefined)
        throw new OutboxStoreFailure({
          operation: 'recoverStalled',
          retryable: false,
          message: 'recovered row disappeared'
        })
      recovered.push(updated)
    }
    return recovered
  }

  claim(
    options: OutboxClaimOptions
  ): OutboxOperation<readonly LeasedOutboxRecord[], OutboxClaimError> {
    const checked = validateClaim(options)
    if (Result.isError(checked)) return failed(checked.error) as never
    return this.withTx('claim', async (tx) => {
      await this.recoverExpiredInTx(tx, checked.value.nowMs, checked.value.limit)
      const selected = await tx.query<Row>(
        `SELECT ${outboxColumnNames.join(',')} FROM ${outboxTable} WHERE namespace=? AND state='pending' AND run_at_ms <= ? AND attempts_made < attempts_max ORDER BY run_at_ms,ordering_sequence,id COLLATE utf8mb4_bin LIMIT ? FOR UPDATE SKIP LOCKED`,
        [this.client.namespace, checked.value.nowMs, checked.value.limit]
      )
      const leased: LeasedOutboxRecord[] = []
      for (const raw of selected.rows) {
        const current = decodeOutboxRow(raw)
        const token = makeOutboxLeaseToken(`mysql-${randomUUID()}`)
        if (Result.isError(token)) throw token.error
        const expiresAtMs = checked.value.nowMs + checked.value.leaseDurationMs
        const updated = await tx.query(
          `UPDATE ${outboxTable} SET state='active',attempts_made=attempts_made+1,updated_at_ms=?,lease_owner=?,lease_token=?,lease_expires_at_ms=? WHERE namespace=? AND id=? AND state='pending' AND attempts_made < attempts_max`,
          [
            checked.value.nowMs,
            checked.value.owner,
            token.value,
            expiresAtMs,
            this.client.namespace,
            current.id
          ]
        )
        if (updated.rowCount !== 1) continue
        const active = await this.row(tx, current.id, true)
        if (active === undefined)
          throw new OutboxStoreFailure({
            operation: 'claim',
            retryable: false,
            message: 'claimed row disappeared'
          })
        leased.push(active as LeasedOutboxRecord)
      }
      return Object.freeze(leased)
    }) as never
  }

  heartbeat(
    request: OutboxHeartbeatRequest
  ): OutboxOperation<LeasedOutboxRecord, OutboxLeaseError> {
    const checked = validateLease(request)
    if (Result.isError(checked) || checked.value.leaseDurationMs === undefined)
      return failed(
        Result.isError(checked)
          ? checked.error
          : new OutboxDefinitionError({ field: 'leaseDurationMs', message: 'is required' })
      ) as never
    const leaseDurationMs = checked.value.leaseDurationMs
    return this.withTx('heartbeat', async (tx) => {
      const current = await this.row(tx, String(checked.value.id), true)
      const active = this.ensureLease(
        current,
        String(checked.value.id),
        checked.value.leaseToken,
        checked.value.nowMs
      )
      const updated = await tx.query(
        `UPDATE ${outboxTable} SET lease_expires_at_ms=?,updated_at_ms=? WHERE namespace=? AND id=? AND state='active' AND lease_token=? AND lease_expires_at_ms > ?`,
        [
          checked.value.nowMs + leaseDurationMs,
          checked.value.nowMs,
          this.client.namespace,
          active.id,
          checked.value.leaseToken,
          checked.value.nowMs
        ]
      )
      if (updated.rowCount !== 1)
        throw new OutboxLeaseLostError({
          id: active.id,
          leaseToken: checked.value.leaseToken,
          reason: 'expired-lease'
        })
      const result = await this.row(tx, active.id, true)
      if (result === undefined) throw new OutboxNotFoundError({ id: active.id })
      return result as LeasedOutboxRecord
    }) as never
  }

  markPublished(
    request: OutboxLeaseRequest
  ): OutboxOperation<OutboxSettlementResult, OutboxSettlementError> {
    const checked = validateLease(request)
    if (Result.isError(checked)) return failed(checked.error) as never
    return this.withTx('markPublished', async (tx) => {
      const current = await this.row(tx, String(checked.value.id), true)
      if (current?.state === 'published')
        return { record: current, status: 'already-applied' as const }
      const active = this.ensureLease(
        current,
        String(checked.value.id),
        checked.value.leaseToken,
        checked.value.nowMs
      )
      const updated = await tx.query(
        `UPDATE ${outboxTable} SET state='published',published_at_ms=?,updated_at_ms=?,lease_owner=NULL,lease_token=NULL,lease_expires_at_ms=NULL WHERE namespace=? AND id=? AND state='active' AND lease_token=? AND lease_expires_at_ms > ?`,
        [
          checked.value.nowMs,
          checked.value.nowMs,
          this.client.namespace,
          active.id,
          checked.value.leaseToken,
          checked.value.nowMs
        ]
      )
      if (updated.rowCount !== 1)
        throw new OutboxLeaseLostError({
          id: active.id,
          leaseToken: checked.value.leaseToken,
          reason: 'expired-lease'
        })
      const published = await this.row(tx, active.id, true)
      if (published === undefined) throw new OutboxNotFoundError({ id: active.id })
      return { record: published, status: 'applied' as const }
    }) as never
  }

  markRetry(request: OutboxRetryRequest): OutboxOperation<OutboxRecord, OutboxSettlementError> {
    const checked = validateLease(request)
    if (Result.isError(checked)) return failed(checked.error) as never
    const runAtMs = timestamp(request.runAtMs, 'runAtMs')
    const failure = failureValue(request.failure)
    if (Result.isError(runAtMs)) return failed(runAtMs.error) as never
    if (Result.isError(failure)) return failed(failure.error) as never
    return this.requeue(
      'markRetry',
      checked.value,
      'pending',
      runAtMs.value,
      failure.value
    ) as never
  }

  markFailed(request: OutboxFailureRequest): OutboxOperation<OutboxRecord, OutboxSettlementError> {
    const checked = validateLease(request)
    if (Result.isError(checked)) return failed(checked.error) as never
    const failure = failureValue(request.failure)
    if (Result.isError(failure)) return failed(failure.error) as never
    return this.requeue('markFailed', checked.value, 'failed', undefined, failure.value) as never
  }

  private requeue(
    operation: string,
    request: OutboxLeaseRequest,
    state: 'pending' | 'failed',
    runAtMs: number | undefined,
    failure: SerializedOutboxFailure
  ): OutboxOperation<OutboxRecord, OutboxSettlementError> {
    return this.withTx(operation, async (tx) => {
      const current = await this.row(tx, String(request.id), true)
      const active = this.ensureLease(
        current,
        String(request.id),
        request.leaseToken,
        request.nowMs
      )
      const updated = await tx.query(
        `UPDATE ${outboxTable} SET state=?,run_at_ms=?,updated_at_ms=?,failure=?,lease_owner=NULL,lease_token=NULL,lease_expires_at_ms=NULL WHERE namespace=? AND id=? AND state='active' AND lease_token=? AND lease_expires_at_ms > ?`,
        [
          state,
          runAtMs ?? active.runAtMs,
          request.nowMs,
          json(failure),
          this.client.namespace,
          active.id,
          request.leaseToken,
          request.nowMs
        ]
      )
      if (updated.rowCount !== 1)
        throw new OutboxLeaseLostError({
          id: active.id,
          leaseToken: request.leaseToken,
          reason: 'expired-lease'
        })
      const result = await this.row(tx, active.id, true)
      if (result === undefined) throw new OutboxNotFoundError({ id: active.id })
      return result
    }) as never
  }

  release(request: OutboxLeaseRequest): OutboxOperation<OutboxRecord, OutboxSettlementError> {
    const checked = validateLease(request)
    if (Result.isError(checked)) return failed(checked.error) as never
    return this.withTx('release', async (tx) => {
      const current = await this.row(tx, String(checked.value.id), true)
      const active = this.ensureLease(
        current,
        String(checked.value.id),
        checked.value.leaseToken,
        checked.value.nowMs
      )
      const updated = await tx.query(
        `UPDATE ${outboxTable} SET state='pending',updated_at_ms=?,lease_owner=NULL,lease_token=NULL,lease_expires_at_ms=NULL WHERE namespace=? AND id=? AND state='active' AND lease_token=? AND lease_expires_at_ms > ?`,
        [
          checked.value.nowMs,
          this.client.namespace,
          active.id,
          checked.value.leaseToken,
          checked.value.nowMs
        ]
      )
      if (updated.rowCount !== 1)
        throw new OutboxLeaseLostError({
          id: active.id,
          leaseToken: checked.value.leaseToken,
          reason: 'expired-lease'
        })
      const result = await this.row(tx, active.id, true)
      if (result === undefined) throw new OutboxNotFoundError({ id: active.id })
      return result
    }) as never
  }

  recoverStalled(
    options: OutboxRecoveryOptions
  ): OutboxOperation<readonly OutboxRecord[], OutboxRecoveryError> {
    if (!isObjectRecord(options))
      return failed(
        new OutboxDefinitionError({ field: 'options', message: 'must be an object' })
      ) as never
    const maxCount = positive(options.maxCount, 'maxCount')
    const nowMs = timestamp(options.nowMs, 'nowMs')
    if (Result.isError(maxCount)) return failed(maxCount.error) as never
    if (Result.isError(nowMs)) return failed(nowMs.error) as never
    return this.withTx('recoverStalled', (tx) =>
      this.recoverExpiredInTx(tx, nowMs.value, maxCount.value)
    ) as never
  }

  get(
    id: import('better-effect-mq-outbox').OutboxId
  ): OutboxOperation<OutboxRecord | undefined, OutboxReadError> {
    const checked = makeOutboxId(id)
    if (Result.isError(checked)) return failed(checked.error) as never
    return this.withTx('get', (tx) => this.row(tx, String(checked.value))) as never
  }

  list(options: OutboxListOptions = {}): OutboxOperation<readonly OutboxRecord[], OutboxReadError> {
    if (!isObjectRecord(options))
      return failed(
        new OutboxDefinitionError({ field: 'options', message: 'must be an object' })
      ) as never
    const input = options as OutboxListOptions
    const checkedStates = states(input.state)
    if (Result.isError(checkedStates)) return failed(checkedStates.error) as never
    const limit = input.limit === undefined ? Result.ok(100) : positive(input.limit, 'limit')
    const checkedTarget = input.target === undefined ? Result.ok(undefined) : target(input.target)
    if (Result.isError(limit)) return failed(limit.error) as never
    if (Result.isError(checkedTarget)) return failed(checkedTarget.error) as never
    return this.withTx('list', async (tx) => {
      const where = ['namespace=?']
      const values: unknown[] = [this.client.namespace]
      if (checkedStates.value !== undefined) {
        where.push(`state IN (${checkedStates.value.map(() => '?').join(',')})`)
        values.push(...checkedStates.value)
      }
      if (checkedTarget.value !== undefined) {
        where.push('target=?')
        values.push(checkedTarget.value)
      }
      values.push(limit.value)
      const result = await tx.query<Row>(
        `SELECT ${outboxColumnNames.join(',')} FROM ${outboxTable} WHERE ${where.join(' AND ')} ORDER BY created_at_ms,ordering_sequence,id COLLATE utf8mb4_bin LIMIT ?`,
        values
      )
      return Object.freeze(result.rows.map(decodeOutboxRow))
    }) as never
  }

  counts(): OutboxOperation<OutboxCounts, OutboxReadError> {
    return this.withTx('counts', async (tx) => {
      const result = await tx.query<Row>(
        `SELECT state,count(*) AS count FROM ${outboxTable} WHERE namespace=? GROUP BY state`,
        [this.client.namespace]
      )
      const counts = { pending: 0, active: 0, published: 0, failed: 0, total: 0 }
      for (const row of result.rows) {
        const state = row.state
        const count = typeof row.count === 'bigint' ? Number(row.count) : Number(row.count)
        if (
          state !== 'pending' &&
          state !== 'active' &&
          state !== 'published' &&
          state !== 'failed'
        )
          throw new OutboxStoreFailure({
            operation: 'counts',
            retryable: false,
            message: 'database returned an unsupported outbox state'
          })
        if (!Number.isSafeInteger(count) || count < 0)
          throw new OutboxStoreFailure({
            operation: 'counts',
            retryable: false,
            message: 'database returned an invalid outbox count'
          })
        counts[state] += count
        counts.total += count
      }
      return Object.freeze(counts)
    }) as never
  }

  async dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.closed = true
    this.disposal = (async () => {
      if (this.client.ownsPool) await this.client.dispose()
    })()
    return this.disposal
  }
}

export type MySqlOutboxStoreConfig = MySqlJobStoreConfig
export type MySqlOutboxStoreConnectionConfig = MySqlJobStoreConnectionConfig

const borrowedClient = (
  token: AnyOutboxStoreToken,
  config: MySqlOutboxStoreConfig
): (() => Promise<MySqlClient>) => {
  const normalized = normalizeMySqlJobStoreConfig(config)
  return async () =>
    MySqlClient.fromPool({
      ...normalized,
      namespace: namespaceForOutboxToken(token, normalized.namespace)
    })
}

const ownedClient = (
  token: AnyOutboxStoreToken,
  config: MySqlOutboxStoreConnectionConfig
): (() => Promise<MySqlClient>) => {
  const normalized = normalizeMySqlJobStoreConnectionConfig(config)
  return () =>
    MySqlClient.fromConfig({
      ...normalized,
      namespace: namespaceForOutboxToken(token, normalized.namespace)
    })
}

const makeStoreLayer = <Token extends AnyOutboxStoreToken>(
  token: Token,
  acquire: () => Promise<MySqlClient>,
  ownsClient: boolean
): Layer<InstanceType<Token>, never> =>
  Layer.scoped(
    token,
    async () => {
      const client = await acquire()
      let implementation: MySqlOutboxStoreImplementation | undefined
      try {
        if (client.validateSchema) await client.validate()
        else await client.compatibility()
        implementation = new MySqlOutboxStoreImplementation(client)
        return OutboxStore.of(
          implementation as never
        ) as unknown as import('better-effect').ServiceContract<InstanceType<Token>>
      } catch (cause) {
        let cleanup: unknown
        try {
          if (implementation !== undefined) await implementation.dispose()
          else if (ownsClient) await client.dispose()
        } catch (failure) {
          cleanup = failure
        }
        if (cleanup !== undefined)
          throw new AggregateError([cause, cleanup], 'MySQL outbox acquisition cleanup failed')
        throw cause
      }
    },
    async (store) => {
      await (store as unknown as MySqlOutboxStoreImplementation).dispose()
    }
  ) as Layer<InstanceType<Token>, never>

export const MySqlOutboxStore = Object.freeze({
  layer(config: MySqlOutboxStoreConfig) {
    return makeStoreLayer(OutboxStore, borrowedClient(OutboxStore, config), false)
  },
  layerFor<Token extends AnyOutboxStoreToken>(token: Token, config: MySqlOutboxStoreConfig) {
    return makeStoreLayer(token, borrowedClient(token, config), false)
  },
  layerFromConfig(config: MySqlOutboxStoreConnectionConfig) {
    return makeStoreLayer(OutboxStore, ownedClient(OutboxStore, config), true)
  },
  layerFromConfigFor<Token extends AnyOutboxStoreToken>(
    token: Token,
    config: MySqlOutboxStoreConnectionConfig
  ) {
    return makeStoreLayer(token, ownedClient(token, config), true)
  }
})

export type MySqlOutboxStoreContract = OutboxStoreContract
