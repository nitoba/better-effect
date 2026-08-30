import { Result, type Result as ResultType } from 'better-result'

import {
  cloneJsonValue,
  parseJsonValue,
  readObjectFields,
  type ParsedObjectFields
} from '../internal/json'
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
import type {
  AttemptRecord,
  JobRecord,
  JsonObject,
  JsonValue,
  PersistedBackoff,
  SerializedJobFailure
} from './types'

const jobRecordFields = [
  'id',
  'name',
  'version',
  'queue',
  'state',
  'payload',
  'metadata',
  'priority',
  'runAt',
  'orderingSequence',
  'attemptsMax',
  'attemptsMade',
  'deliveryCount',
  'stalledCount',
  'backoff',
  'timeoutMs',
  'idempotencyKey',
  'createdAt',
  'updatedAt',
  'processedAt',
  'finishedAt',
  'leaseOwner',
  'leaseToken',
  'leaseExpiresAt',
  'cancellationRequestedAt',
  'result',
  'failure'
] as const

const attemptRecordFields = [
  'attempt',
  'delivery',
  'startedAt',
  'finishedAt',
  'outcome',
  'result',
  'failure'
] as const

type MutableBackoffCopy = {
  type: PersistedBackoff['type']
  delayMs: number
  maxDelayMs?: number
}

type MutableFailureCopy = {
  kind: SerializedJobFailure['kind']
  message: string
  retryable: boolean
  recordedAt: number
  code?: string
  data?: JsonValue
}

const isJsonObject = (value: JsonValue): value is JsonObject => {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- metadata must be a non-null object, never a JSON primitive.
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const invalidRecord = (field: string, message: string): ResultType<JobRecord, JobDefinitionError> =>
  Result.err(new JobDefinitionError({ field, message }))

const invalidAttempt = (
  field: string,
  message: string
): ResultType<AttemptRecord, JobDefinitionError> =>
  Result.err(new JobDefinitionError({ field, message }))

const validateFailure = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- failure values are parsed immediately at this DTO boundary.
  failure: unknown
): ResultType<SerializedJobFailure | undefined, JobDefinitionError> =>
  failure === undefined ? Result.ok(undefined) : validateSerializedJobFailure(failure)

const validateMetadata = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- metadata is decoded from untrusted persistence data.
  metadata: unknown
): ResultType<Readonly<Record<string, string>>, JobDefinitionError> => {
  const parsed = parseJsonValue(metadata, 'metadata')

  if (Result.isError(parsed)) {
    return Result.err(parsed.error)
  }

  if (!isJsonObject(parsed.value)) {
    return Result.err(
      new JobDefinitionError({ field: 'metadata', message: 'must be a JSON object' })
    )
  }

  const safeMetadata: Record<string, string> = {}

  for (const [key, value] of Object.entries(parsed.value)) {
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

const cloneMetadata = (
  metadata: Readonly<Record<string, string>>
): Readonly<Record<string, string>> => {
  const copy: Record<string, string> = {}

  for (const [key, value] of Object.entries(metadata)) {
    Object.defineProperty(copy, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true
    })
  }

  return Object.freeze(copy)
}

const cloneBackoff = (backoff: PersistedBackoff | undefined): PersistedBackoff | undefined => {
  if (backoff === undefined) {
    return undefined
  }

  const copy: MutableBackoffCopy = {
    type: backoff.type,
    delayMs: backoff.delayMs
  }

  if (backoff.maxDelayMs !== undefined) {
    copy.maxDelayMs = backoff.maxDelayMs
  }

  return Object.freeze(copy)
}

const cloneFailure = (
  failure: SerializedJobFailure | undefined
): SerializedJobFailure | undefined => {
  if (failure === undefined) {
    return undefined
  }

  const copy: MutableFailureCopy = {
    kind: failure.kind,
    message: failure.message,
    retryable: failure.retryable,
    recordedAt: failure.recordedAt
  }

  if (failure.code !== undefined) {
    copy.code = failure.code
  }

  if (failure.data !== undefined) {
    copy.data = cloneJsonValue(failure.data)
  }

  return Object.freeze(copy)
}

const freezeRecord = (record: JobRecord): JobRecord =>
  Object.freeze({
    id: record.id,
    name: record.name,
    version: record.version,
    queue: record.queue,
    state: record.state,
    payload: cloneJsonValue(record.payload),
    metadata: cloneMetadata(record.metadata),
    priority: record.priority,
    runAt: record.runAt,
    orderingSequence: record.orderingSequence,
    attemptsMax: record.attemptsMax,
    attemptsMade: record.attemptsMade,
    deliveryCount: record.deliveryCount,
    stalledCount: record.stalledCount,
    backoff: cloneBackoff(record.backoff),
    timeoutMs: record.timeoutMs,
    idempotencyKey: record.idempotencyKey,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    processedAt: record.processedAt,
    finishedAt: record.finishedAt,
    leaseOwner: record.leaseOwner,
    leaseToken: record.leaseToken,
    leaseExpiresAt: record.leaseExpiresAt,
    cancellationRequestedAt: record.cancellationRequestedAt,
    result: record.result === undefined ? undefined : cloneJsonValue(record.result),
    failure: cloneFailure(record.failure)
  })

const hasLease = (
  record: Pick<JobRecord, 'leaseOwner' | 'leaseToken' | 'leaseExpiresAt'>
): boolean =>
  record.leaseOwner !== undefined ||
  record.leaseToken !== undefined ||
  record.leaseExpiresAt !== undefined

const validateLeaseConsistency = (
  record: Pick<
    JobRecord,
    'state' | 'leaseOwner' | 'leaseToken' | 'leaseExpiresAt' | 'cancellationRequestedAt'
  >
): ResultType<void, JobDefinitionError> => {
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

const validateState = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- state is decoded from untrusted persistence data.
  state: unknown
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

const validateAttemptOutcome = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- outcome is decoded from untrusted persistence data.
  outcome: unknown
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

const validateJobRecordInternal = (
  fields: ParsedObjectFields
): ResultType<JobRecord, JobDefinitionError> => {
  const id = makeJobId(fields.id)
  const name = makeJobName(fields.name)
  const queue = makeQueueName(fields.queue)
  const state = validateState(fields.state)
  const metadata = validateMetadata(fields.metadata)

  if (Result.isError(id)) return invalidRecord('id', id.error.message)
  if (Result.isError(name)) return invalidRecord('name', name.error.message)
  if (Result.isError(queue)) return invalidRecord('queue', queue.error.message)
  if (Result.isError(state)) return invalidRecord('state', state.error.message)
  if (Result.isError(metadata)) return invalidRecord('metadata', metadata.error.message)

  const leaseOwner =
    fields.leaseOwner === undefined
      ? Result.ok<WorkerId | undefined>(undefined)
      : makeWorkerId(fields.leaseOwner)
  const leaseToken =
    fields.leaseToken === undefined
      ? Result.ok<LeaseToken | undefined>(undefined)
      : makeLeaseToken(fields.leaseToken)

  if (Result.isError(leaseOwner)) return invalidRecord('leaseOwner', leaseOwner.error.message)
  if (Result.isError(leaseToken)) return invalidRecord('leaseToken', leaseToken.error.message)

  const version = validateCounterValue(fields.version, 'version')
  const priority = validatePriorityValue(fields.priority, 'priority')
  const runAt = validateTimestampValue(fields.runAt, 'runAt')
  const orderingSequence = validateCounterValue(fields.orderingSequence, 'orderingSequence')
  const attemptsMax = validatePositiveIntegerValue(fields.attemptsMax, 'attemptsMax')
  const attemptsMade = validateCounterValue(fields.attemptsMade, 'attemptsMade')
  const deliveryCount = validateCounterValue(fields.deliveryCount, 'deliveryCount')
  const stalledCount = validateCounterValue(fields.stalledCount, 'stalledCount')
  const createdAt = validateTimestampValue(fields.createdAt, 'createdAt')
  const updatedAt = validateTimestampValue(fields.updatedAt, 'updatedAt')
  if (Result.isError(version)) return invalidRecord(version.error.field, version.error.message)
  if (Result.isError(priority)) return invalidRecord(priority.error.field, priority.error.message)
  if (Result.isError(runAt)) return invalidRecord(runAt.error.field, runAt.error.message)
  if (Result.isError(orderingSequence)) {
    return invalidRecord(orderingSequence.error.field, orderingSequence.error.message)
  }
  if (Result.isError(attemptsMax)) {
    return invalidRecord(attemptsMax.error.field, attemptsMax.error.message)
  }
  if (Result.isError(attemptsMade)) {
    return invalidRecord(attemptsMade.error.field, attemptsMade.error.message)
  }
  if (Result.isError(deliveryCount)) {
    return invalidRecord(deliveryCount.error.field, deliveryCount.error.message)
  }
  if (Result.isError(stalledCount)) {
    return invalidRecord(stalledCount.error.field, stalledCount.error.message)
  }
  if (Result.isError(createdAt))
    return invalidRecord(createdAt.error.field, createdAt.error.message)
  if (Result.isError(updatedAt))
    return invalidRecord(updatedAt.error.field, updatedAt.error.message)

  if (updatedAt.value < createdAt.value) {
    return invalidRecord('updatedAt', 'must not be earlier than createdAt')
  }

  const idempotencyKey =
    fields.idempotencyKey === undefined
      ? Result.ok<string | undefined>(undefined)
      : validateTextValue(fields.idempotencyKey, 'idempotencyKey')
  const timeout = validateOptionalDurationValue(fields.timeoutMs, 'timeoutMs')
  const processedAt = validateOptionalTimestampValue(fields.processedAt, 'processedAt')
  const finishedAt = validateOptionalTimestampValue(fields.finishedAt, 'finishedAt')
  const cancellationRequestedAt = validateOptionalTimestampValue(
    fields.cancellationRequestedAt,
    'cancellationRequestedAt'
  )
  const leaseExpiresAt = validateOptionalTimestampValue(fields.leaseExpiresAt, 'leaseExpiresAt')

  if (Result.isError(idempotencyKey)) {
    return invalidRecord('idempotencyKey', idempotencyKey.error.message)
  }

  if (Result.isError(timeout)) return invalidRecord(timeout.error.field, timeout.error.message)
  if (Result.isError(processedAt)) {
    return invalidRecord(processedAt.error.field, processedAt.error.message)
  }
  if (Result.isError(finishedAt)) {
    return invalidRecord(finishedAt.error.field, finishedAt.error.message)
  }
  if (Result.isError(cancellationRequestedAt)) {
    return invalidRecord(cancellationRequestedAt.error.field, cancellationRequestedAt.error.message)
  }
  if (Result.isError(leaseExpiresAt)) {
    return invalidRecord(leaseExpiresAt.error.field, leaseExpiresAt.error.message)
  }

  if (
    cancellationRequestedAt.value !== undefined &&
    cancellationRequestedAt.value > updatedAt.value
  ) {
    return invalidRecord('cancellationRequestedAt', 'must not be later than updatedAt')
  }

  const leaseConsistency = validateLeaseConsistency({
    state: state.value,
    leaseOwner: leaseOwner.value,
    leaseToken: leaseToken.value,
    leaseExpiresAt: leaseExpiresAt.value,
    cancellationRequestedAt: cancellationRequestedAt.value
  })

  if (Result.isError(leaseConsistency)) {
    return invalidRecord(leaseConsistency.error.field, leaseConsistency.error.message)
  }

  const payload = parseJsonValue(fields.payload, 'payload')
  const result =
    fields.result === undefined
      ? Result.ok<JsonValue | undefined>(undefined)
      : parseJsonValue(fields.result, 'result')

  if (Result.isError(payload)) return invalidRecord(payload.error.field, payload.error.message)
  if (Result.isError(result)) return invalidRecord(result.error.field, result.error.message)

  const failure = validateFailure(fields.failure)

  if (Result.isError(failure)) {
    return invalidRecord(failure.error.field, failure.error.message)
  }

  if (attemptsMade.value > attemptsMax.value) {
    return invalidRecord('attemptsMade', 'must not exceed attemptsMax')
  }

  if (
    (state.value === 'waiting' || state.value === 'delayed' || state.value === 'active') &&
    attemptsMade.value >= attemptsMax.value
  ) {
    return invalidRecord(
      'attemptsMade',
      'waiting, delayed, and active jobs must retain an attempt slot below attemptsMax'
    )
  }

  const backoff =
    fields.backoff === undefined
      ? Result.ok<PersistedBackoff | undefined>(undefined)
      : validatePersistedBackoff(fields.backoff)

  if (Result.isError(backoff)) {
    return invalidRecord(backoff.error.field, backoff.error.message)
  }

  return Result.ok(
    freezeRecord({
      id: id.value,
      name: name.value,
      version: version.value,
      queue: queue.value,
      state: state.value,
      payload: payload.value,
      metadata: metadata.value,
      priority: priority.value,
      runAt: runAt.value,
      orderingSequence: orderingSequence.value,
      attemptsMax: attemptsMax.value,
      attemptsMade: attemptsMade.value,
      deliveryCount: deliveryCount.value,
      stalledCount: stalledCount.value,
      backoff: backoff.value,
      timeoutMs: timeout.value,
      idempotencyKey: idempotencyKey.value,
      createdAt: createdAt.value,
      updatedAt: updatedAt.value,
      processedAt: processedAt.value,
      finishedAt: finishedAt.value,
      leaseOwner: leaseOwner.value,
      leaseToken: leaseToken.value,
      leaseExpiresAt: leaseExpiresAt.value,
      cancellationRequestedAt: cancellationRequestedAt.value,
      result: result.value,
      failure: failure.value
    })
  )
}

/** Validate a complete storage-neutral job snapshot and return an immutable copy. */
export const validateJobRecord = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- records arrive from an untyped persistence boundary.
  record: unknown
): ResultType<JobRecord, JobDefinitionError> => {
  const fields = readObjectFields(record, jobRecordFields, 'record')

  if (Result.isError(fields)) {
    return Result.err(fields.error)
  }

  return validateJobRecordInternal(fields.value)
}

export const makeJobRecord = validateJobRecord

const freezeAttempt = (attempt: AttemptRecord): AttemptRecord =>
  Object.freeze({
    attempt: attempt.attempt,
    delivery: attempt.delivery,
    startedAt: attempt.startedAt,
    finishedAt: attempt.finishedAt,
    outcome: attempt.outcome,
    result: attempt.result === undefined ? undefined : cloneJsonValue(attempt.result),
    failure: cloneFailure(attempt.failure)
  })

/** Validate an attempt ledger entry and return an immutable canonical copy. */
const validateAttemptRecordInternal = (
  fields: ParsedObjectFields
): ResultType<AttemptRecord, JobDefinitionError> => {
  const attemptNumber = validateCounterValue(fields.attempt, 'attempt')
  const delivery = validatePositiveIntegerValue(fields.delivery, 'delivery')
  const finishedAt = validateTimestampValue(fields.finishedAt, 'finishedAt')
  const startedAt = validateOptionalTimestampValue(fields.startedAt, 'startedAt')
  const outcome = validateAttemptOutcome(fields.outcome)

  if (Result.isError(attemptNumber)) {
    return invalidAttempt(attemptNumber.error.field, attemptNumber.error.message)
  }
  if (Result.isError(delivery)) return invalidAttempt(delivery.error.field, delivery.error.message)
  if (Result.isError(finishedAt)) {
    return invalidAttempt(finishedAt.error.field, finishedAt.error.message)
  }
  if (Result.isError(startedAt)) {
    return invalidAttempt(startedAt.error.field, startedAt.error.message)
  }

  if (Result.isError(outcome)) {
    return invalidAttempt(outcome.error.field, outcome.error.message)
  }

  if (startedAt.value !== undefined && startedAt.value > finishedAt.value) {
    return invalidAttempt('startedAt', 'must not be later than finishedAt')
  }

  const result =
    fields.result === undefined
      ? Result.ok<JsonValue | undefined>(undefined)
      : parseJsonValue(fields.result, 'result')

  if (Result.isError(result)) {
    return invalidAttempt(result.error.field, result.error.message)
  }

  const failure = validateFailure(fields.failure)

  if (Result.isError(failure)) {
    return invalidAttempt(failure.error.field, failure.error.message)
  }

  return Result.ok(
    freezeAttempt({
      attempt: attemptNumber.value,
      delivery: delivery.value,
      startedAt: startedAt.value,
      finishedAt: finishedAt.value,
      outcome: outcome.value,
      result: result.value,
      failure: failure.value
    })
  )
}

export const validateAttemptRecord = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- attempts arrive from an untyped persistence boundary.
  attempt: unknown
): ResultType<AttemptRecord, JobDefinitionError> => {
  const fields = readObjectFields(attempt, attemptRecordFields, 'attempt')

  if (Result.isError(fields)) {
    return Result.err(fields.error)
  }

  return validateAttemptRecordInternal(fields.value)
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
