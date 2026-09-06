// oxlint-disable anti-slop/no-unknown-parameters -- outbox records are persistence boundaries.
// oxlint-disable anti-slop/no-runtime-typeof -- record validation inspects untrusted storage data.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- canonical digest traversal owns this JSON boundary.
// oxlint-disable anti-slop/no-unknown-returns -- digest normalization is internal to the persistence boundary.
// oxlint-disable anti-slop/no-known-value-widening -- canonical digest traversal handles arbitrary JSON values.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- record fields are validated before reconstruction.

import { Result, type Result as ResultType } from 'better-result'
import { makePreparedEnqueue, type PreparedEnqueue } from 'better-effect-mq'

import { OutboxDefinitionError } from './errors'
import {
  makeOutboxId,
  makeOutboxLeaseToken,
  makeOutboxWorkerId,
  type OutboxId,
  type OutboxLeaseToken,
  type OutboxWorkerId
} from './identity'

export const outboxProtocolVersion = 1 as const
export type OutboxProtocolVersion = typeof outboxProtocolVersion

export type OutboxState = 'pending' | 'active' | 'published' | 'failed'

export type OutboxFailureKind =
  | 'target-missing'
  | 'request-invalid'
  | 'store-transient'
  | 'store-permanent'
  | 'settlement-uncertain'

export interface SerializedOutboxFailure {
  readonly kind: OutboxFailureKind
  readonly code?: string
  readonly message: string
  readonly retryable: boolean
  readonly recordedAtMs: number
}

export interface OutboxRecord {
  readonly id: OutboxId
  readonly protocolVersion: OutboxProtocolVersion
  readonly target: string
  readonly state: OutboxState
  readonly request: PreparedEnqueue
  readonly requestDigest: string
  readonly attemptsMax: number
  readonly attemptsMade: number
  readonly runAtMs: number
  readonly createdAtMs: number
  readonly updatedAtMs: number
  readonly publishedAtMs: number | undefined
  readonly leaseOwner: OutboxWorkerId | undefined
  readonly leaseToken: OutboxLeaseToken | undefined
  readonly leaseExpiresAtMs: number | undefined
  readonly failure: SerializedOutboxFailure | undefined
}

export interface OutboxRecordInput {
  readonly id: OutboxId
  readonly target: string
  readonly request: PreparedEnqueue
  readonly attemptsMax?: number
  readonly runAtMs?: number
  readonly nowMs?: number
}

const recordFields = [
  'id',
  'protocolVersion',
  'target',
  'state',
  'request',
  'requestDigest',
  'attemptsMax',
  'attemptsMade',
  'runAtMs',
  'createdAtMs',
  'updatedAtMs',
  'publishedAtMs',
  'leaseOwner',
  'leaseToken',
  'leaseExpiresAtMs',
  'failure'
] as const

const invalid = <Value>(field: string, message: string): ResultType<Value, OutboxDefinitionError> =>
  Result.err(new OutboxDefinitionError({ field, message }))

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

const stableValue = (value: unknown): unknown => {
  if (value === undefined) return null
  if (Array.isArray(value)) return value.map(stableValue)
  if (!isPlainObject(value)) return value

  const output: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) output[key] = stableValue(value[key])
  return output
}

/** Stable, storage-neutral request identity used for OutboxId conflict checks. */
export const preparedEnqueueDigest = (request: PreparedEnqueue): string =>
  JSON.stringify(
    stableValue({
      protocolVersion: request.protocolVersion,
      identity: request.identity,
      id: request.id,
      idempotencyKey: request.idempotencyKey,
      payload: request.payload,
      metadata: request.metadata,
      priority: request.priority,
      runAt: request.runAt,
      attemptsMax: request.attemptsMax,
      backoff: request.backoff,
      timeoutMs: request.timeoutMs,
      now: request.now
    })
  )

const validateTarget = (value: unknown): ResultType<string, OutboxDefinitionError> => {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\u0000')) {
    return invalid('target', 'must be a non-empty string without NUL')
  }
  return Result.ok(value)
}

const validateCount = (
  value: unknown,
  field: string,
  minimum: number
): ResultType<number, OutboxDefinitionError> => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    return invalid(field, `must be a safe integer greater than or equal to ${minimum}`)
  }
  return Result.ok(value)
}

const validateTimestamp = (
  value: unknown,
  field: string
): ResultType<number, OutboxDefinitionError> => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return invalid(field, 'must be a non-negative safe integer epoch millisecond timestamp')
  }
  return Result.ok(value)
}

const validateOptionalTimestamp = (
  value: unknown,
  field: string
): ResultType<number | undefined, OutboxDefinitionError> =>
  value === undefined ? Result.ok(undefined) : validateTimestamp(value, field)

const readRecord = (
  value: unknown
): ResultType<Readonly<Record<string, unknown>>, OutboxDefinitionError> => {
  if (!isPlainObject(value)) return invalid('record', 'must be a plain object')
  try {
    for (const key of Object.keys(value)) {
      if (!recordFields.includes(key as (typeof recordFields)[number])) {
        return invalid(key, 'is not a recognized OutboxRecord field')
      }
    }
    for (const field of recordFields) {
      if (!Object.prototype.hasOwnProperty.call(value, field)) {
        return invalid(field, 'is required')
      }
    }
    return Result.ok(value)
  } catch {
    return invalid('record', 'could not be read safely')
  }
}

const freezeFailure = (
  failure: SerializedOutboxFailure | undefined
): SerializedOutboxFailure | undefined =>
  failure === undefined ? undefined : Object.freeze({ ...failure })

/** Create the initial pending OutboxRecord snapshot. */
export const makeOutboxRecord = (
  input: OutboxRecordInput
): ResultType<OutboxRecord, OutboxDefinitionError> => {
  const id = makeOutboxId(input.id)
  if (Result.isError(id)) return id
  const target = validateTarget(input.target)
  if (Result.isError(target)) return target
  const request = makePreparedEnqueue(input.request)
  if (Result.isError(request)) return invalid('request', request.error.message)

  const attemptsMax = validateCount(input.attemptsMax ?? 10, 'attemptsMax', 1)
  const nowMs = validateTimestamp(input.nowMs ?? request.value.now, 'nowMs')
  if (Result.isError(attemptsMax)) return attemptsMax
  if (Result.isError(nowMs)) return nowMs
  const runAtMs = validateTimestamp(input.runAtMs ?? nowMs.value, 'runAtMs')
  if (Result.isError(runAtMs)) return runAtMs

  return Result.ok(
    Object.freeze({
      id: id.value,
      protocolVersion: outboxProtocolVersion,
      target: target.value,
      state: 'pending' as const,
      request: request.value,
      requestDigest: preparedEnqueueDigest(request.value),
      attemptsMax: attemptsMax.value,
      attemptsMade: 0,
      runAtMs: runAtMs.value,
      createdAtMs: nowMs.value,
      updatedAtMs: nowMs.value,
      publishedAtMs: undefined,
      leaseOwner: undefined,
      leaseToken: undefined,
      leaseExpiresAtMs: undefined,
      failure: undefined
    })
  )
}

/** Validate and snapshot a complete persisted OutboxRecord. */
export const validateOutboxRecord = (
  value: unknown
): ResultType<OutboxRecord, OutboxDefinitionError> => {
  const checked = readRecord(value)
  if (Result.isError(checked)) return checked

  const id = makeOutboxId(checked.value.id)
  const request = makePreparedEnqueue(checked.value.request)
  const target = validateTarget(checked.value.target)
  const state = checked.value.state
  if (Result.isError(id)) return id
  if (Result.isError(request)) return invalid('request', request.error.message)
  if (Result.isError(target)) return target
  if (checked.value.protocolVersion !== outboxProtocolVersion) {
    return invalid('protocolVersion', `expected ${outboxProtocolVersion}`)
  }
  if (state !== 'pending' && state !== 'active' && state !== 'published' && state !== 'failed') {
    return invalid('state', 'must be pending, active, published, or failed')
  }

  const requestDigest = checked.value.requestDigest
  if (typeof requestDigest !== 'string' || requestDigest.length === 0) {
    return invalid('requestDigest', 'must be a non-empty string')
  }
  if (requestDigest !== preparedEnqueueDigest(request.value)) {
    return invalid('requestDigest', 'does not match request')
  }

  const attemptsMax = validateCount(checked.value.attemptsMax, 'attemptsMax', 1)
  const attemptsMade = validateCount(checked.value.attemptsMade, 'attemptsMade', 0)
  const runAtMs = validateTimestamp(checked.value.runAtMs, 'runAtMs')
  const createdAtMs = validateTimestamp(checked.value.createdAtMs, 'createdAtMs')
  const updatedAtMs = validateTimestamp(checked.value.updatedAtMs, 'updatedAtMs')
  if (Result.isError(attemptsMax)) return attemptsMax
  if (Result.isError(attemptsMade)) return attemptsMade
  if (Result.isError(runAtMs)) return runAtMs
  if (Result.isError(createdAtMs)) return createdAtMs
  if (Result.isError(updatedAtMs)) return updatedAtMs
  if (attemptsMade.value > attemptsMax.value) {
    return invalid('attemptsMade', 'must not exceed attemptsMax')
  }
  if (updatedAtMs.value < createdAtMs.value) {
    return invalid('updatedAtMs', 'must not precede createdAtMs')
  }

  const publishedAtMs = validateOptionalTimestamp(checked.value.publishedAtMs, 'publishedAtMs')
  const leaseExpiresAtMs = validateOptionalTimestamp(
    checked.value.leaseExpiresAtMs,
    'leaseExpiresAtMs'
  )
  const leaseOwner =
    checked.value.leaseOwner === undefined
      ? Result.ok<OutboxWorkerId | undefined>(undefined)
      : makeOutboxWorkerId(checked.value.leaseOwner)
  const leaseToken =
    checked.value.leaseToken === undefined
      ? Result.ok<OutboxLeaseToken | undefined>(undefined)
      : makeOutboxLeaseToken(checked.value.leaseToken)
  if (Result.isError(publishedAtMs)) return publishedAtMs
  if (Result.isError(leaseExpiresAtMs)) return leaseExpiresAtMs
  if (Result.isError(leaseOwner)) return leaseOwner
  if (Result.isError(leaseToken)) return leaseToken

  const failure =
    checked.value.failure === undefined
      ? Result.ok<SerializedOutboxFailure | undefined>(undefined)
      : makeSerializedOutboxFailure(checked.value.failure as SerializedOutboxFailure)
  if (Result.isError(failure)) return failure

  const isActiveLease =
    leaseOwner.value !== undefined &&
    leaseToken.value !== undefined &&
    leaseExpiresAtMs.value !== undefined
  if (state === 'active' && !isActiveLease)
    return invalid('lease', 'active records require a lease')
  if (state !== 'active' && isActiveLease) {
    return invalid('lease', 'only active records may retain a lease')
  }
  if (state === 'published' && publishedAtMs.value === undefined) {
    return invalid('publishedAtMs', 'published records require a timestamp')
  }

  return Result.ok(
    Object.freeze({
      id: id.value,
      protocolVersion: outboxProtocolVersion,
      target: target.value,
      state,
      request: request.value,
      requestDigest,
      attemptsMax: attemptsMax.value,
      attemptsMade: attemptsMade.value,
      runAtMs: runAtMs.value,
      createdAtMs: createdAtMs.value,
      updatedAtMs: updatedAtMs.value,
      publishedAtMs: publishedAtMs.value,
      leaseOwner: leaseOwner.value,
      leaseToken: leaseToken.value,
      leaseExpiresAtMs: leaseExpiresAtMs.value,
      failure: failure.value
    })
  )
}

export const makeSerializedOutboxFailure = (input: {
  readonly kind: OutboxFailureKind
  readonly code?: string
  readonly message: string
  readonly retryable: boolean
  readonly recordedAtMs: number
}): ResultType<SerializedOutboxFailure, OutboxDefinitionError> => {
  const failureKinds: readonly OutboxFailureKind[] = [
    'target-missing',
    'request-invalid',
    'store-transient',
    'store-permanent',
    'settlement-uncertain'
  ]
  if (!failureKinds.includes(input.kind)) return invalid('failure.kind', 'is not supported')
  if (!input.message || typeof input.message !== 'string')
    return invalid('failure.message', 'must be a string')
  if (
    input.code !== undefined &&
    (typeof input.code !== 'string' || input.code.length === 0 || input.code.includes('\u0000'))
  ) {
    return invalid('failure.code', 'must be a non-empty string without NUL')
  }
  if (typeof input.retryable !== 'boolean') return invalid('failure.retryable', 'must be a boolean')
  const recordedAtMs = validateTimestamp(input.recordedAtMs, 'failure.recordedAtMs')
  if (Result.isError(recordedAtMs)) return recordedAtMs
  return Result.ok(Object.freeze({ ...input, recordedAtMs: recordedAtMs.value }))
}

export const cloneOutboxRecord = (record: OutboxRecord): OutboxRecord =>
  Object.freeze({
    ...record,
    request: record.request,
    failure: freezeFailure(record.failure)
  })
