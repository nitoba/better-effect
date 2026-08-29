import { Result, type Result as ResultType } from 'better-result'

import { cloneJsonValue, isJsonValue } from '../internal/json'
import {
  validateCounterValue,
  validateOptionalDurationValue,
  validateOptionalTimestampValue,
  validatePositiveIntegerValue,
  validatePriorityValue,
  validateTextValue,
  validateTimestampValue
} from '../internal/validation'

import { makeJobId, makeJobName, makeLeaseToken, makeQueueName, makeWorkerId } from './brands'
import type { JobId, JobName, LeaseToken, QueueName, WorkerId } from './brands'
import { validatePersistedBackoff } from './backoff'
import { JobDefinitionError } from './errors'
import { validateSerializedJobFailure } from './failures'
import type { AttemptRecord, JobRecord, SerializedJobFailure } from './types'

const invalidRecord = (field: string, message: string): ResultType<JobRecord, JobDefinitionError> =>
  Result.err(new JobDefinitionError({ field, message }))

const invalidAttempt = (
  field: string,
  message: string
): ResultType<AttemptRecord, JobDefinitionError> =>
  Result.err(new JobDefinitionError({ field, message }))

const validateFailure = (
  failure: SerializedJobFailure | undefined
): ResultType<SerializedJobFailure | undefined, JobDefinitionError> =>
  failure === undefined ? Result.ok(undefined) : validateSerializedJobFailure(failure)

const validateMetadata = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- metadata is decoded from untrusted persistence data.
  metadata: unknown
): ResultType<Readonly<Record<string, string>>, JobDefinitionError> => {
  if (!isJsonValue(metadata) || metadata === null || Array.isArray(metadata)) {
    return Result.err(
      new JobDefinitionError({ field: 'metadata', message: 'must be a JSON object' })
    )
  }

  const safeMetadata: Record<string, string> = {}

  for (const [key, value] of Object.entries(metadata)) {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- metadata values must remain strings.
    if (typeof value !== 'string') {
      return Result.err(
        new JobDefinitionError({ field: `metadata.${key}`, message: 'must be a string' })
      )
    }

    Object.defineProperty(safeMetadata, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true
    })
  }

  return Result.ok(Object.freeze(safeMetadata))
}

const isObjectRecord = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- records arrive from an untyped persistence boundary.
  value: unknown
): value is object => {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- reject non-object records before field validation.
  return typeof value === 'object' && value !== null
}

const validateState = (
  state: JobRecord['state']
): ResultType<JobRecord['state'], JobDefinitionError> => {
  switch (state) {
    case 'waiting':
    case 'delayed':
    case 'active':
    case 'completed':
    case 'failed':
    case 'cancelled':
      return Result.ok(state)
    default:
      return Result.err(
        new JobDefinitionError({ field: 'state', message: 'unsupported job state' })
      )
  }
}

const freezeRecord = (record: JobRecord): JobRecord =>
  Object.freeze({
    ...record,
    metadata: Object.freeze({ ...record.metadata }),
    payload: cloneJsonValue(record.payload),
    backoff: record.backoff === undefined ? undefined : Object.freeze({ ...record.backoff }),
    result: record.result === undefined ? undefined : cloneJsonValue(record.result),
    failure: record.failure === undefined ? undefined : Object.freeze({ ...record.failure })
  })

const hasLease = (record: JobRecord): boolean =>
  record.leaseOwner !== undefined ||
  record.leaseToken !== undefined ||
  record.leaseExpiresAt !== undefined

const validateLeaseConsistency = (record: JobRecord): ResultType<void, JobDefinitionError> => {
  const complete =
    record.leaseOwner !== undefined &&
    record.leaseToken !== undefined &&
    record.leaseExpiresAt !== undefined

  if (record.state === 'active' && !complete) {
    return Result.err(
      new JobDefinitionError({
        field: 'lease',
        message: 'active jobs must contain an owner, token, and expiry timestamp'
      })
    )
  }

  if (record.state !== 'active' && hasLease(record)) {
    return Result.err(
      new JobDefinitionError({
        field: 'lease',
        message: 'non-active jobs must not contain lease fields'
      })
    )
  }

  if (record.state !== 'active' && record.cancellationRequestedAt !== undefined) {
    return Result.err(
      new JobDefinitionError({
        field: 'cancellationRequestedAt',
        message: 'only active jobs may carry a cancellation request'
      })
    )
  }

  return Result.ok()
}

const validateAttemptOutcome = (
  outcome: AttemptRecord['outcome']
): ResultType<AttemptRecord['outcome'], JobDefinitionError> => {
  switch (outcome) {
    case 'completed':
    case 'retried':
    case 'failed':
    case 'cancelled':
    case 'stalled':
    case 'released':
      return Result.ok(outcome)
    default:
      return Result.err(
        new JobDefinitionError({ field: 'outcome', message: 'unsupported attempt outcome' })
      )
  }
}

/** Validate a complete storage-neutral job snapshot and return an immutable copy. */
const validateJobRecordInternal = (
  record: JobRecord
): ResultType<JobRecord, JobDefinitionError> => {
  const id = makeJobId(record.id)
  const name = makeJobName(record.name)
  const queue = makeQueueName(record.queue)
  const state = validateState(record.state)
  const metadata = validateMetadata(record.metadata)

  if (Result.isError(id)) return invalidRecord('id', id.error.message)
  if (Result.isError(name)) return invalidRecord('name', name.error.message)
  if (Result.isError(queue)) return invalidRecord('queue', queue.error.message)
  if (Result.isError(state)) return invalidRecord('state', state.error.message)
  if (Result.isError(metadata)) return invalidRecord('metadata', metadata.error.message)

  const leaseOwner =
    record.leaseOwner === undefined
      ? Result.ok<WorkerId | undefined>(undefined)
      : makeWorkerId(record.leaseOwner)
  const leaseToken =
    record.leaseToken === undefined
      ? Result.ok<LeaseToken | undefined>(undefined)
      : makeLeaseToken(record.leaseToken)

  if (Result.isError(leaseOwner)) return invalidRecord('leaseOwner', leaseOwner.error.message)
  if (Result.isError(leaseToken)) return invalidRecord('leaseToken', leaseToken.error.message)

  const version = validateCounterValue(record.version, 'version')
  const priority = validatePriorityValue(record.priority, 'priority')
  const runAt = validateTimestampValue(record.runAt, 'runAt')
  const orderingSequence = validateCounterValue(record.orderingSequence, 'orderingSequence')
  const attemptsMax = validatePositiveIntegerValue(record.attemptsMax, 'attemptsMax')
  const attemptsMade = validateCounterValue(record.attemptsMade, 'attemptsMade')
  const deliveryCount = validateCounterValue(record.deliveryCount, 'deliveryCount')
  const stalledCount = validateCounterValue(record.stalledCount, 'stalledCount')
  const createdAt = validateTimestampValue(record.createdAt, 'createdAt')
  const updatedAt = validateTimestampValue(record.updatedAt, 'updatedAt')

  const numericChecks = [
    version,
    priority,
    runAt,
    orderingSequence,
    attemptsMax,
    attemptsMade,
    deliveryCount,
    stalledCount,
    createdAt,
    updatedAt
  ]

  for (const check of numericChecks) {
    if (Result.isError(check)) {
      return invalidRecord(check.error.field, check.error.message)
    }
  }

  if (record.attemptsMade > record.attemptsMax) {
    return invalidRecord('attemptsMade', 'must not exceed attemptsMax')
  }

  if (record.updatedAt < record.createdAt) {
    return invalidRecord('updatedAt', 'must not be earlier than createdAt')
  }

  const idempotencyKey =
    record.idempotencyKey === undefined
      ? Result.ok<string | undefined>(undefined)
      : validateTextValue(record.idempotencyKey, 'idempotencyKey')
  const timeout = validateOptionalDurationValue(record.timeoutMs, 'timeoutMs')
  const processedAt = validateOptionalTimestampValue(record.processedAt, 'processedAt')
  const finishedAt = validateOptionalTimestampValue(record.finishedAt, 'finishedAt')
  const cancellationRequestedAt = validateOptionalTimestampValue(
    record.cancellationRequestedAt,
    'cancellationRequestedAt'
  )
  const leaseExpiresAt = validateOptionalTimestampValue(record.leaseExpiresAt, 'leaseExpiresAt')

  if (Result.isError(idempotencyKey)) {
    return invalidRecord('idempotencyKey', idempotencyKey.error.message)
  }

  for (const check of [timeout, processedAt, finishedAt, cancellationRequestedAt, leaseExpiresAt]) {
    if (Result.isError(check)) {
      return invalidRecord(check.error.field, check.error.message)
    }
  }

  if (
    record.cancellationRequestedAt !== undefined &&
    record.cancellationRequestedAt > record.updatedAt
  ) {
    return invalidRecord('cancellationRequestedAt', 'must not be later than updatedAt')
  }

  const leaseConsistency = validateLeaseConsistency(record)

  if (Result.isError(leaseConsistency)) {
    return invalidRecord(leaseConsistency.error.field, leaseConsistency.error.message)
  }

  if (!isJsonValue(record.payload)) {
    return invalidRecord('payload', 'must be JSON-safe')
  }

  if (record.result !== undefined && !isJsonValue(record.result)) {
    return invalidRecord('result', 'must be JSON-safe')
  }

  const failure = validateFailure(record.failure)

  if (Result.isError(failure)) {
    return invalidRecord(failure.error.field, failure.error.message)
  }

  const backoff =
    record.backoff === undefined ? Result.ok(undefined) : validatePersistedBackoff(record.backoff)

  if (Result.isError(backoff)) {
    return invalidRecord(backoff.error.field, backoff.error.message)
  }

  return Result.ok(
    freezeRecord({
      ...record,
      id: id.value,
      name: name.value,
      queue: queue.value,
      metadata: metadata.value,
      idempotencyKey: idempotencyKey.value,
      leaseOwner: leaseOwner.value,
      leaseToken: leaseToken.value,
      backoff: backoff.value,
      failure: failure.value
    })
  )
}

export const validateJobRecord = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- records arrive from an untyped persistence boundary.
  record: unknown
): ResultType<JobRecord, JobDefinitionError> => {
  if (!isObjectRecord(record)) {
    return invalidRecord('record', 'must be an object')
  }

  // SAFETY: the internal validator checks every required field before returning a JobRecord.
  return validateJobRecordInternal(record as JobRecord)
}

export const makeJobRecord = validateJobRecord

const freezeAttempt = (attempt: AttemptRecord): AttemptRecord =>
  Object.freeze({
    ...attempt,
    result: attempt.result === undefined ? undefined : cloneJsonValue(attempt.result),
    failure: attempt.failure === undefined ? undefined : Object.freeze({ ...attempt.failure })
  })

/** Validate an attempt ledger entry without changing its storage representation. */
const validateAttemptRecordInternal = (
  attempt: AttemptRecord
): ResultType<AttemptRecord, JobDefinitionError> => {
  const attemptNumber = validateCounterValue(attempt.attempt, 'attempt')
  const delivery = validatePositiveIntegerValue(attempt.delivery, 'delivery')
  const finishedAt = validateTimestampValue(attempt.finishedAt, 'finishedAt')
  const startedAt = validateOptionalTimestampValue(attempt.startedAt, 'startedAt')
  const outcome = validateAttemptOutcome(attempt.outcome)

  for (const check of [attemptNumber, delivery, finishedAt, startedAt]) {
    if (Result.isError(check)) {
      return invalidAttempt(check.error.field, check.error.message)
    }
  }

  if (Result.isError(outcome)) {
    return invalidAttempt(outcome.error.field, outcome.error.message)
  }

  if (attempt.startedAt !== undefined && attempt.startedAt > attempt.finishedAt) {
    return invalidAttempt('startedAt', 'must not be later than finishedAt')
  }

  if (attempt.result !== undefined && !isJsonValue(attempt.result)) {
    return invalidAttempt('result', 'must be JSON-safe')
  }

  const failure = validateFailure(attempt.failure)

  if (Result.isError(failure)) {
    return invalidAttempt(failure.error.field, failure.error.message)
  }

  return Result.ok(
    freezeAttempt({
      ...attempt,
      outcome: outcome.value,
      failure: failure.value
    })
  )
}

export const validateAttemptRecord = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- attempts arrive from an untyped persistence boundary.
  attempt: unknown
): ResultType<AttemptRecord, JobDefinitionError> => {
  if (!isObjectRecord(attempt)) {
    return invalidAttempt('attempt', 'must be an object')
  }

  // SAFETY: the internal validator checks every required field before returning an AttemptRecord.
  return validateAttemptRecordInternal(attempt as AttemptRecord)
}

export type JobIdentityRecord = {
  readonly id: JobId
  readonly queue: QueueName
  readonly name: JobName
  readonly version: number
}

export type ActiveLease = {
  readonly leaseOwner: WorkerId
  readonly leaseToken: LeaseToken
  readonly leaseExpiresAt: number
}
