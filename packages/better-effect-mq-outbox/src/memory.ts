// oxlint-disable anti-slop/no-unknown-parameters -- the Memory adapter validates public DTOs.
// oxlint-disable anti-slop/no-runtime-typeof -- option validation is a runtime boundary.
// oxlint-disable anti-slop/no-chained-type-assertions -- casts are confined to the Effect/Result facade boundary.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- validated records preserve the narrowed state invariant.

import { Result, type Result as ResultType } from 'better-result'

import {
  cloneOutboxRecord,
  makeOutboxRecord,
  makeSerializedOutboxFailure,
  outboxProtocolVersion,
  type OutboxRecord,
  type OutboxRecordInput,
  type OutboxState
} from './OutboxRecord'
import {
  OutboxDefinitionError,
  OutboxConflictError,
  OutboxLeaseLostError,
  OutboxNotFoundError
} from './errors'
import type { OutboxStoreError } from './errors'
import {
  makeOutboxLeaseToken,
  makeOutboxWorkerId,
  type OutboxId,
  type OutboxLeaseToken
} from './identity'
import type {
  LeasedOutboxRecord,
  OutboxAppendResult,
  OutboxAppendStore,
  OutboxAppendError,
  OutboxClaimOptions,
  OutboxClaimError,
  OutboxCounts,
  OutboxFailureRequest,
  OutboxHeartbeatRequest,
  OutboxLeaseError,
  OutboxLeaseRequest,
  OutboxReadError,
  OutboxListOptions,
  OutboxOperation,
  OutboxRecoveryOptions,
  OutboxRecoveryError,
  OutboxRetryRequest,
  OutboxSettlementResult,
  OutboxSettlementError,
  OutboxStore,
  OutboxStoreDescriptor,
  OutboxEffect
} from './OutboxStore'

const memoryDescriptor: OutboxStoreDescriptor = Object.freeze({
  protocolVersion: outboxProtocolVersion,
  adapter: 'memory',
  adapterVersion: '0.1'
})

const failedOperation = <Failure extends OutboxStoreError>(result: {
  readonly error: Failure
}): OutboxEffect<never, Failure> =>
  Result.err(result.error) as unknown as OutboxEffect<never, Failure>

const ok = <Value>(value: Value): OutboxEffect<Value, never> =>
  Result.ok(value) as unknown as OutboxEffect<Value, never>
const fail = <Failure extends OutboxStoreError>(error: Failure): OutboxEffect<never, Failure> =>
  Result.err(error) as unknown as OutboxEffect<never, Failure>

const resultOk = <Value>(value: Value): ResultType<Value, never> => Result.ok(value)
const resultFail = <Value, Failure>(error: Failure): ResultType<Value, Failure> => Result.err(error)

const invalid = <Value>(field: string, message: string): ResultType<Value, OutboxDefinitionError> =>
  resultFail(new OutboxDefinitionError({ field, message }))

const validateTimestamp = (
  value: unknown,
  field: string
): ResultType<number, OutboxDefinitionError> => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return invalid(field, 'must be a non-negative safe integer')
  }
  return resultOk(value)
}

const validatePositive = (
  value: unknown,
  field: string
): ResultType<number, OutboxDefinitionError> => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    return invalid(field, 'must be a positive safe integer')
  }
  return resultOk(value)
}

const validateClaim = (
  options: OutboxClaimOptions
): ResultType<OutboxClaimOptions, OutboxDefinitionError> => {
  const owner = makeOutboxWorkerId(options.owner)
  const limit = validatePositive(options.limit, 'limit')
  const leaseDurationMs = validatePositive(options.leaseDurationMs, 'leaseDurationMs')
  const nowMs = validateTimestamp(options.nowMs, 'nowMs')
  if (Result.isError(owner)) return owner
  if (Result.isError(limit)) return limit
  if (Result.isError(leaseDurationMs)) return leaseDurationMs
  if (Result.isError(nowMs)) return nowMs
  return resultOk({
    owner: owner.value,
    limit: limit.value,
    leaseDurationMs: leaseDurationMs.value,
    nowMs: nowMs.value
  })
}

const validateLeaseInput = (
  request: OutboxLeaseRequest | OutboxHeartbeatRequest
): ResultType<
  OutboxLeaseRequest & Partial<Pick<OutboxHeartbeatRequest, 'leaseDurationMs'>>,
  OutboxDefinitionError
> => {
  const token = makeOutboxLeaseToken(request.leaseToken)
  const nowMs = validateTimestamp(request.nowMs, 'nowMs')
  if (Result.isError(token)) return token
  if (Result.isError(nowMs)) return nowMs
  if ('leaseDurationMs' in request) {
    const duration = validatePositive(request.leaseDurationMs, 'leaseDurationMs')
    if (Result.isError(duration)) return duration
    return resultOk({
      id: request.id,
      leaseToken: token.value,
      nowMs: nowMs.value,
      leaseDurationMs: duration.value
    })
  }
  return resultOk({ id: request.id, leaseToken: token.value, nowMs: nowMs.value })
}

const statesFor = (state: OutboxListOptions['state']): readonly OutboxState[] | undefined => {
  if (state === undefined) return undefined
  return typeof state === 'string' ? [state] : state
}

class MemoryOutboxStoreImplementation implements OutboxStore, OutboxAppendStore {
  readonly descriptor = memoryDescriptor

  private readonly records = new Map<string, OutboxRecord>()
  private nextLease = 0

  append(input: OutboxRecordInput): OutboxOperation<OutboxAppendResult, OutboxAppendError> {
    const created = makeOutboxRecord(input)
    if (Result.isError(created)) return failedOperation(created)

    const existing = this.records.get(created.value.id)
    if (existing !== undefined) {
      if (existing.requestDigest !== created.value.requestDigest) {
        return fail(
          new OutboxConflictError({
            id: created.value.id,
            existingDigest: existing.requestDigest,
            incomingDigest: created.value.requestDigest
          })
        )
      }
      return ok({ record: cloneOutboxRecord(existing), duplicate: true })
    }

    this.records.set(created.value.id, created.value)
    return ok({ record: cloneOutboxRecord(created.value), duplicate: false })
  }

  claim(
    options: OutboxClaimOptions
  ): OutboxOperation<readonly LeasedOutboxRecord[], OutboxClaimError> {
    const checked = validateClaim(options)
    if (Result.isError(checked)) return failedOperation(checked)
    this.recoverExpired(checked.value.nowMs)

    const candidates = [...this.records.values()]
      .filter(
        (record) =>
          record.state === 'pending' &&
          record.runAtMs <= checked.value.nowMs &&
          record.attemptsMade < record.attemptsMax
      )
      .sort(
        (first, second) =>
          first.runAtMs - second.runAtMs ||
          first.createdAtMs - second.createdAtMs ||
          first.id.localeCompare(second.id)
      )
      .slice(0, checked.value.limit)

    const leased: LeasedOutboxRecord[] = []
    for (const record of candidates) {
      const token = makeOutboxLeaseToken(`memory-lease-${this.nextLease++}`)
      if (Result.isError(token)) return failedOperation(token)
      const active = this.update(record, {
        state: 'active',
        attemptsMade: record.attemptsMade + 1,
        updatedAtMs: checked.value.nowMs,
        leaseOwner: checked.value.owner,
        leaseToken: token.value,
        leaseExpiresAtMs: checked.value.nowMs + checked.value.leaseDurationMs
      }) as unknown as LeasedOutboxRecord
      leased.push(cloneOutboxRecord(active) as unknown as LeasedOutboxRecord)
    }
    return ok(Object.freeze(leased))
  }

  heartbeat(
    request: OutboxHeartbeatRequest
  ): OutboxOperation<LeasedOutboxRecord, OutboxLeaseError> {
    const checked = validateLeaseInput(request)
    if (Result.isError(checked)) return failedOperation(checked)
    const record = this.records.get(String(request.id))
    const leased = this.requireLease(
      record,
      request.id,
      checked.value.leaseToken,
      checked.value.nowMs
    )
    if (Result.isError(leased)) return failedOperation(leased)
    const updated = this.update(leased.value, {
      updatedAtMs: checked.value.nowMs,
      leaseExpiresAtMs: checked.value.nowMs + (checked.value.leaseDurationMs ?? 0)
    }) as unknown as LeasedOutboxRecord
    return ok(cloneOutboxRecord(updated) as unknown as LeasedOutboxRecord)
  }

  markPublished(
    request: OutboxLeaseRequest
  ): OutboxOperation<OutboxSettlementResult, OutboxSettlementError> {
    const checked = validateLeaseInput(request)
    if (Result.isError(checked)) return failedOperation(checked)
    const record = this.records.get(String(request.id))
    if (record?.state === 'published') {
      return ok<OutboxSettlementResult>({
        record: cloneOutboxRecord(record),
        status: 'already-applied'
      })
    }
    const leased = this.requireLease(
      record,
      request.id,
      checked.value.leaseToken,
      checked.value.nowMs
    )
    if (Result.isError(leased)) return failedOperation(leased)
    const published = this.update(leased.value, {
      state: 'published',
      updatedAtMs: checked.value.nowMs,
      publishedAtMs: checked.value.nowMs,
      leaseOwner: undefined,
      leaseToken: undefined,
      leaseExpiresAtMs: undefined
    })
    return ok<OutboxSettlementResult>({ record: cloneOutboxRecord(published), status: 'applied' })
  }

  markRetry(request: OutboxRetryRequest): OutboxOperation<OutboxRecord, OutboxSettlementError> {
    const checked = validateLeaseInput(request)
    if (Result.isError(checked)) return failedOperation(checked)
    const runAtMs = validateTimestamp(request.runAtMs, 'runAtMs')
    if (Result.isError(runAtMs)) return failedOperation(runAtMs)
    const failure = makeSerializedOutboxFailure(request.failure)
    if (Result.isError(failure)) return failedOperation(failure)
    const record = this.records.get(String(request.id))
    const leased = this.requireLease(
      record,
      request.id,
      checked.value.leaseToken,
      checked.value.nowMs
    )
    if (Result.isError(leased)) return failedOperation(leased)
    const pending = this.update(leased.value, {
      state: 'pending',
      runAtMs: runAtMs.value,
      updatedAtMs: checked.value.nowMs,
      failure: failure.value,
      leaseOwner: undefined,
      leaseToken: undefined,
      leaseExpiresAtMs: undefined
    })
    return ok(cloneOutboxRecord(pending))
  }

  markFailed(request: OutboxFailureRequest): OutboxOperation<OutboxRecord, OutboxSettlementError> {
    const checked = validateLeaseInput(request)
    if (Result.isError(checked)) return failedOperation(checked)
    const failure = makeSerializedOutboxFailure(request.failure)
    if (Result.isError(failure)) return failedOperation(failure)
    const record = this.records.get(String(request.id))
    const leased = this.requireLease(
      record,
      request.id,
      checked.value.leaseToken,
      checked.value.nowMs
    )
    if (Result.isError(leased)) return failedOperation(leased)
    const failed = this.update(leased.value, {
      state: 'failed',
      updatedAtMs: checked.value.nowMs,
      failure: failure.value,
      leaseOwner: undefined,
      leaseToken: undefined,
      leaseExpiresAtMs: undefined
    })
    return ok(cloneOutboxRecord(failed))
  }

  release(request: OutboxLeaseRequest): OutboxOperation<OutboxRecord, OutboxSettlementError> {
    const checked = validateLeaseInput(request)
    if (Result.isError(checked)) return failedOperation(checked)
    const record = this.records.get(String(request.id))
    const leased = this.requireLease(
      record,
      request.id,
      checked.value.leaseToken,
      checked.value.nowMs
    )
    if (Result.isError(leased)) return failedOperation(leased)
    const pending = this.update(leased.value, {
      state: 'pending',
      updatedAtMs: checked.value.nowMs,
      leaseOwner: undefined,
      leaseToken: undefined,
      leaseExpiresAtMs: undefined
    })
    return ok(cloneOutboxRecord(pending))
  }

  recoverStalled(
    options: OutboxRecoveryOptions
  ): OutboxOperation<readonly OutboxRecord[], OutboxRecoveryError> {
    const maxCount = validatePositive(options.maxCount, 'maxCount')
    const nowMs = validateTimestamp(options.nowMs, 'nowMs')
    if (Result.isError(maxCount)) return failedOperation(maxCount)
    if (Result.isError(nowMs)) return failedOperation(nowMs)
    const recovered = this.recoverExpired(nowMs.value, maxCount.value)
    return ok(Object.freeze(recovered.map(cloneOutboxRecord)))
  }

  get(id: OutboxId): OutboxOperation<OutboxRecord | undefined, OutboxReadError> {
    const record = this.records.get(String(id))
    return ok(record === undefined ? undefined : cloneOutboxRecord(record))
  }

  list(options: OutboxListOptions = {}): OutboxOperation<readonly OutboxRecord[], OutboxReadError> {
    const states = statesFor(options.state)
    if (options.limit !== undefined) {
      const limit = validatePositive(options.limit, 'limit')
      if (Result.isError(limit)) return failedOperation(limit)
    }
    const records = [...this.records.values()]
      .filter((record) => states === undefined || states.includes(record.state))
      .filter((record) => options.target === undefined || record.target === options.target)
      .sort(
        (first, second) =>
          first.createdAtMs - second.createdAtMs || first.id.localeCompare(second.id)
      )
      .slice(0, options.limit)
      .map(cloneOutboxRecord)
    return ok(Object.freeze(records))
  }

  counts(): OutboxOperation<OutboxCounts, OutboxReadError> {
    const counts = { pending: 0, active: 0, published: 0, failed: 0, total: this.records.size }
    for (const record of this.records.values()) counts[record.state] += 1
    return ok(Object.freeze(counts))
  }

  private update(record: OutboxRecord, changes: Partial<OutboxRecord>): OutboxRecord {
    const updated = Object.freeze({ ...record, ...changes })
    this.records.set(record.id, updated)
    return updated
  }

  private requireLease(
    record: OutboxRecord | undefined,
    id: OutboxId,
    token: OutboxLeaseToken,
    nowMs: number
  ): ResultType<LeasedOutboxRecord, OutboxLeaseError> {
    if (record === undefined) return resultFail(new OutboxNotFoundError({ id }))
    if (record.state !== 'active') {
      return resultFail(new OutboxLeaseLostError({ id, leaseToken: token, reason: 'not-active' }))
    }
    if (record.leaseToken === undefined) {
      return resultFail(
        new OutboxLeaseLostError({ id, leaseToken: token, reason: 'missing-token' })
      )
    }
    if (record.leaseToken !== token) {
      return resultFail(
        new OutboxLeaseLostError({ id, leaseToken: token, reason: 'mismatched-token' })
      )
    }
    if (record.leaseExpiresAtMs === undefined || record.leaseExpiresAtMs <= nowMs) {
      return resultFail(
        new OutboxLeaseLostError({ id, leaseToken: token, reason: 'expired-lease' })
      )
    }
    return resultOk(record as LeasedOutboxRecord)
  }

  private recoverExpired(nowMs: number, limit = Number.MAX_SAFE_INTEGER): OutboxRecord[] {
    const recovered: OutboxRecord[] = []
    for (const record of this.records.values()) {
      if (
        recovered.length >= limit ||
        record.state !== 'active' ||
        record.leaseExpiresAtMs === undefined ||
        record.leaseExpiresAtMs > nowMs
      ) {
        continue
      }
      const next =
        record.attemptsMade >= record.attemptsMax
          ? this.update(record, {
              state: 'failed',
              updatedAtMs: nowMs,
              failure: makeSerializedOutboxFailure({
                kind: 'store-permanent',
                message: 'Outbox lease expired after the attempt limit was reached',
                retryable: false,
                recordedAtMs: nowMs
              }).unwrap(),
              leaseOwner: undefined,
              leaseToken: undefined,
              leaseExpiresAtMs: undefined
            })
          : this.update(record, {
              state: 'pending',
              updatedAtMs: nowMs,
              runAtMs: Math.max(record.runAtMs, nowMs),
              leaseOwner: undefined,
              leaseToken: undefined,
              leaseExpiresAtMs: undefined
            })
      recovered.push(next)
    }
    return recovered
  }
}

export type MemoryOutboxStore = OutboxStore & OutboxAppendStore

export const MemoryOutboxStore = Object.freeze({
  make(): MemoryOutboxStore {
    return new MemoryOutboxStoreImplementation()
  }
})
