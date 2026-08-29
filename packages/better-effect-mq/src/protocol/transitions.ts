import { Result, type Result as ResultType } from 'better-result'

import { cloneJsonValue, isJsonValue } from '../internal/json'
import {
  validateCounterValue,
  validateOptionalTimestampValue,
  validateTimestampValue
} from '../internal/validation'

import { makeJobId, makeLeaseToken, makeWorkerId } from './brands'
import type { JobId, LeaseToken } from './brands'
import { validateJobRecord } from './records'
import {
  InvalidJobTransitionError,
  JobDefinitionError,
  JobNotCancellableError,
  JobNotFoundError,
  JobNotPromotableError,
  JobNotRetryableError,
  LeaseLostError
} from './errors'
import { makeSerializedJobFailure, validateSerializedJobFailure } from './failures'
import type {
  AttemptRecord,
  CancelCommand,
  ClaimCommand,
  JobRecord,
  JobTransition,
  JobTransitionCommand,
  PromoteCommand,
  RecoverStalledCommand,
  RedriveCommand,
  ReleaseCommand,
  RequestCancellationCommand,
  SettleCommand,
  SerializedJobFailure
} from './types'

export type JobTransitionFailure =
  | JobDefinitionError
  | InvalidJobTransitionError
  | JobNotCancellableError
  | JobNotFoundError
  | JobNotPromotableError
  | JobNotRetryableError
  | LeaseLostError

type TransitionResult = ResultType<JobTransition, JobTransitionFailure>
type RecordResult = ResultType<JobRecord, JobTransitionFailure>

const invalidFor = (
  record: JobRecord,
  operation: string,
  message?: string
): InvalidJobTransitionError =>
  message === undefined
    ? new InvalidJobTransitionError({
        jobId: record.id,
        from: record.state,
        operation
      })
    : new InvalidJobTransitionError({
        jobId: record.id,
        from: record.state,
        operation,
        message
      })

const prepareRecord = (
  record: JobRecord,
  jobId: JobId
): ResultType<JobRecord, JobTransitionFailure> => {
  const checked = validateJobRecord(record)

  if (Result.isError(checked)) {
    return Result.err(checked.error)
  }

  if (checked.value.id !== jobId) {
    return Result.err(new JobNotFoundError({ jobId }))
  }

  return Result.ok(checked.value)
}

const prepareNow = (
  record: JobRecord,
  jobId: JobId,
  now: number
): ResultType<JobRecord, JobTransitionFailure> => {
  const checkedJobId = makeJobId(jobId)

  if (Result.isError(checkedJobId)) {
    return Result.err(checkedJobId.error)
  }

  const prepared = prepareRecord(record, checkedJobId.value)

  if (Result.isError(prepared)) {
    return prepared
  }

  const checkedNow = validateTimestampValue(now, 'now')

  if (Result.isError(checkedNow)) {
    return Result.err(checkedNow.error)
  }

  if (checkedNow.value < prepared.value.updatedAt) {
    return Result.err(
      new JobDefinitionError({ field: 'now', message: 'must not be earlier than updatedAt' })
    )
  }

  return prepared
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

const transition = (record: JobRecord, attempt?: AttemptRecord): TransitionResult =>
  Result.ok(
    Object.freeze({
      record: freezeRecord(record),
      attempt
    })
  )

const recordOnly = (result: TransitionResult): RecordResult => result.map((value) => value.record)

const clearLease = (): Pick<JobRecord, 'leaseOwner' | 'leaseToken' | 'leaseExpiresAt'> => ({
  leaseOwner: undefined,
  leaseToken: undefined,
  leaseExpiresAt: undefined
})

const assertActiveLease = (
  record: JobRecord,
  leaseToken: LeaseToken | undefined,
  now: number,
  operation: string
): ResultType<void, JobTransitionFailure> => {
  if (record.state !== 'active') {
    return Result.err(invalidFor(record, operation))
  }

  if (leaseToken !== undefined) {
    const checkedToken = makeLeaseToken(leaseToken)

    if (Result.isError(checkedToken)) {
      return Result.err(checkedToken.error)
    }
  }

  if (
    record.leaseOwner === undefined ||
    record.leaseToken === undefined ||
    record.leaseExpiresAt === undefined
  ) {
    if (leaseToken === undefined) {
      return Result.err(new LeaseLostError({ jobId: record.id, reason: 'missing-token' }))
    }

    return Result.err(new LeaseLostError({ jobId: record.id, leaseToken, reason: 'missing-lease' }))
  }

  if (leaseToken === undefined) {
    return Result.err(new LeaseLostError({ jobId: record.id, reason: 'missing-token' }))
  }

  if (leaseToken !== record.leaseToken) {
    return Result.err(
      new LeaseLostError({ jobId: record.id, leaseToken, reason: 'mismatched-token' })
    )
  }

  if (now >= record.leaseExpiresAt) {
    return Result.err(new LeaseLostError({ jobId: record.id, leaseToken, reason: 'expired-lease' }))
  }

  return Result.ok()
}

const validateAttemptStartedAt = (
  command: SettleCommand
): ResultType<number | undefined, JobTransitionFailure> => {
  const startedAt = validateOptionalTimestampValue(command.startedAt, 'startedAt')

  if (Result.isError(startedAt)) {
    return Result.err(startedAt.error)
  }

  if (startedAt.value !== undefined && startedAt.value > command.now) {
    return Result.err(
      new JobDefinitionError({ field: 'startedAt', message: 'must not be later than now' })
    )
  }

  return startedAt
}

const validateOutcomeFailure = (
  failure: SerializedJobFailure | undefined
): ResultType<SerializedJobFailure | undefined, JobTransitionFailure> => {
  if (failure === undefined) {
    return Result.ok(undefined)
  }

  const checked = validateSerializedJobFailure(failure)

  if (Result.isError(checked)) {
    return Result.err(checked.error)
  }

  return Result.ok(checked.value)
}

const nextAttemptNumber = (
  record: JobRecord
): ResultType<number, JobNotRetryableError | JobDefinitionError> => {
  const next = record.attemptsMade + 1

  if (!Number.isSafeInteger(next)) {
    return Result.err(
      new JobDefinitionError({ field: 'attemptsMade', message: 'cannot exceed safe integer range' })
    )
  }

  if (next > record.attemptsMax) {
    return Result.err(
      new JobNotRetryableError({
        jobId: record.id,
        state: record.state,
        message: 'attempt budget is exhausted'
      })
    )
  }

  return Result.ok(next)
}

const makeAttempt = (
  record: JobRecord,
  command: SettleCommand,
  outcome: AttemptRecord['outcome'],
  attempt: number,
  failure: AttemptRecord['failure'],
  result: AttemptRecord['result'],
  startedAt: number | undefined
): AttemptRecord =>
  Object.freeze({
    attempt,
    delivery: record.deliveryCount,
    startedAt,
    finishedAt: command.now,
    outcome,
    result: result === undefined ? undefined : cloneJsonValue(result),
    failure
  })

const settleComplete = (
  record: JobRecord,
  command: SettleCommand,
  attempt: number,
  startedAt: number | undefined
): TransitionResult => {
  if (command.outcome.type !== 'complete') {
    return Result.err(invalidFor(record, 'settle', 'Expected a complete outcome'))
  }

  if (command.outcome.result !== undefined && !isJsonValue(command.outcome.result)) {
    return Result.err(new JobDefinitionError({ field: 'result', message: 'must be JSON-safe' }))
  }

  const next: JobRecord = {
    ...record,
    state: 'completed',
    attemptsMade: attempt,
    updatedAt: command.now,
    processedAt: command.now,
    finishedAt: command.now,
    ...clearLease(),
    cancellationRequestedAt: undefined,
    result: command.outcome.result,
    failure: undefined
  }

  return transition(
    next,
    makeAttempt(record, command, 'completed', attempt, undefined, command.outcome.result, startedAt)
  )
}

const settleRetry = (
  record: JobRecord,
  command: SettleCommand,
  attempt: number,
  startedAt: number | undefined
): TransitionResult => {
  if (command.outcome.type !== 'retry') {
    return Result.err(invalidFor(record, 'settle', 'Expected a retry outcome'))
  }

  if (attempt >= record.attemptsMax) {
    return Result.err(
      new JobNotRetryableError({
        jobId: record.id,
        state: record.state,
        message: 'a retry would exceed attemptsMax'
      })
    )
  }

  const runAt = validateTimestampValue(command.outcome.runAt, 'runAt')

  if (Result.isError(runAt)) {
    return Result.err(runAt.error)
  }

  const failure = validateOutcomeFailure(command.outcome.failure)

  if (Result.isError(failure)) {
    return Result.err(failure.error)
  }

  const next: JobRecord = {
    ...record,
    state: runAt.value <= command.now ? 'waiting' : 'delayed',
    attemptsMade: attempt,
    runAt: runAt.value,
    updatedAt: command.now,
    processedAt: undefined,
    finishedAt: undefined,
    ...clearLease(),
    cancellationRequestedAt: undefined,
    result: undefined,
    failure: failure.value
  }

  return transition(
    next,
    makeAttempt(record, command, 'retried', attempt, failure.value, undefined, startedAt)
  )
}

const settleFail = (
  record: JobRecord,
  command: SettleCommand,
  attempt: number,
  startedAt: number | undefined
): TransitionResult => {
  if (command.outcome.type !== 'fail') {
    return Result.err(invalidFor(record, 'settle', 'Expected a fail outcome'))
  }

  const failure = validateSerializedJobFailure(command.outcome.failure)

  if (Result.isError(failure)) {
    return Result.err(failure.error)
  }

  const next: JobRecord = {
    ...record,
    state: 'failed',
    attemptsMade: attempt,
    updatedAt: command.now,
    processedAt: command.now,
    finishedAt: command.now,
    ...clearLease(),
    cancellationRequestedAt: undefined,
    result: undefined,
    failure: failure.value
  }

  return transition(
    next,
    makeAttempt(record, command, 'failed', attempt, failure.value, undefined, startedAt)
  )
}

const settleCancelled = (
  record: JobRecord,
  command: SettleCommand,
  startedAt: number | undefined
): TransitionResult => {
  if (command.outcome.type !== 'cancelled') {
    return Result.err(invalidFor(record, 'settle', 'Expected a cancelled outcome'))
  }

  const failure = validateOutcomeFailure(command.outcome.failure)

  if (Result.isError(failure)) {
    return Result.err(failure.error)
  }

  const next: JobRecord = {
    ...record,
    state: 'cancelled',
    updatedAt: command.now,
    processedAt: command.now,
    finishedAt: command.now,
    ...clearLease(),
    cancellationRequestedAt: undefined,
    result: undefined,
    failure: failure.value
  }

  return transition(
    next,
    makeAttempt(
      record,
      command,
      'cancelled',
      record.attemptsMade,
      failure.value,
      undefined,
      startedAt
    )
  )
}

const settle = (record: JobRecord, command: SettleCommand): TransitionResult => {
  const prepared = prepareNow(record, command.jobId, command.now)

  if (Result.isError(prepared)) {
    return Result.err(prepared.error)
  }

  const fenced = assertActiveLease(prepared.value, command.leaseToken, command.now, 'settle')

  if (Result.isError(fenced)) {
    return Result.err(fenced.error)
  }

  const startedAt = validateAttemptStartedAt(command)

  if (Result.isError(startedAt)) {
    return Result.err(startedAt.error)
  }

  switch (command.outcome.type) {
    case 'complete':
    case 'retry':
    case 'fail':
    case 'cancelled':
      break
    default:
      return Result.err(
        new JobDefinitionError({ field: 'outcome.type', message: 'unsupported settlement outcome' })
      )
  }

  if (command.outcome.type === 'cancelled') {
    return settleCancelled(prepared.value, command, startedAt.value)
  }

  const attempt = nextAttemptNumber(prepared.value)

  if (Result.isError(attempt)) {
    return Result.err(attempt.error)
  }

  switch (command.outcome.type) {
    case 'complete':
      return settleComplete(prepared.value, command, attempt.value, startedAt.value)
    case 'retry':
      return settleRetry(prepared.value, command, attempt.value, startedAt.value)
    case 'fail':
      return settleFail(prepared.value, command, attempt.value, startedAt.value)
  }
}

const claim = (record: JobRecord, command: ClaimCommand): TransitionResult => {
  const prepared = prepareNow(record, command.jobId, command.now)

  if (Result.isError(prepared)) {
    return Result.err(prepared.error)
  }

  const workerId = makeWorkerId(command.workerId)
  const leaseToken = makeLeaseToken(command.leaseToken)
  const leaseExpiresAt = validateTimestampValue(command.leaseExpiresAt, 'leaseExpiresAt')

  if (Result.isError(workerId)) {
    return Result.err(workerId.error)
  }

  if (Result.isError(leaseToken)) {
    return Result.err(leaseToken.error)
  }

  if (Result.isError(leaseExpiresAt)) {
    return Result.err(leaseExpiresAt.error)
  }

  if (leaseExpiresAt.value <= command.now) {
    return Result.err(
      new JobDefinitionError({
        field: 'leaseExpiresAt',
        message: 'must be strictly later than now'
      })
    )
  }

  if (
    (prepared.value.state === 'waiting' || prepared.value.state === 'delayed') &&
    prepared.value.runAt > command.now
  ) {
    return Result.err(
      new JobNotPromotableError({
        jobId: prepared.value.id,
        state: prepared.value.state,
        message: 'job is not due yet'
      })
    )
  }

  if (prepared.value.state !== 'waiting' && prepared.value.state !== 'delayed') {
    return Result.err(
      new JobNotPromotableError({
        jobId: prepared.value.id,
        state: prepared.value.state,
        message: 'only waiting or due delayed jobs may be claimed'
      })
    )
  }

  const deliveryCount = prepared.value.deliveryCount + 1

  if (!Number.isSafeInteger(deliveryCount)) {
    return Result.err(
      new JobDefinitionError({
        field: 'deliveryCount',
        message: 'cannot exceed safe integer range'
      })
    )
  }

  const next: JobRecord = {
    ...prepared.value,
    state: 'active',
    deliveryCount,
    updatedAt: command.now,
    leaseOwner: workerId.value,
    leaseToken: leaseToken.value,
    leaseExpiresAt: leaseExpiresAt.value,
    cancellationRequestedAt: undefined
  }

  return transition(next)
}

const release = (record: JobRecord, command: ReleaseCommand): TransitionResult => {
  const prepared = prepareNow(record, command.jobId, command.now)

  if (Result.isError(prepared)) {
    return Result.err(prepared.error)
  }

  const fenced = assertActiveLease(prepared.value, command.leaseToken, command.now, 'release')

  if (Result.isError(fenced)) {
    return Result.err(fenced.error)
  }

  const next: JobRecord = {
    ...prepared.value,
    state: 'waiting',
    runAt: command.now,
    updatedAt: command.now,
    processedAt: undefined,
    finishedAt: undefined,
    ...clearLease(),
    cancellationRequestedAt: undefined,
    result: undefined,
    failure: undefined
  }

  const attempt: AttemptRecord = Object.freeze({
    attempt: prepared.value.attemptsMade,
    delivery: prepared.value.deliveryCount,
    startedAt: undefined,
    finishedAt: command.now,
    outcome: 'released',
    result: undefined,
    failure: undefined
  })

  return transition(next, attempt)
}

const requestCancellation = (
  record: JobRecord,
  command: RequestCancellationCommand
): TransitionResult => {
  const prepared = prepareNow(record, command.jobId, command.now)

  if (Result.isError(prepared)) {
    return Result.err(prepared.error)
  }

  if (prepared.value.state !== 'active') {
    return Result.err(
      new JobNotCancellableError({
        jobId: prepared.value.id,
        state: prepared.value.state,
        message: 'only an active job can receive a cancellation request'
      })
    )
  }

  if (prepared.value.cancellationRequestedAt !== undefined) {
    return transition(prepared.value)
  }

  return transition({
    ...prepared.value,
    cancellationRequestedAt: command.now,
    updatedAt: command.now
  })
}

const cancel = (record: JobRecord, command: CancelCommand): TransitionResult => {
  const prepared = prepareNow(record, command.jobId, command.now)

  if (Result.isError(prepared)) {
    return Result.err(prepared.error)
  }

  if (prepared.value.state === 'active') {
    return Result.err(
      new JobNotCancellableError({
        jobId: prepared.value.id,
        state: prepared.value.state,
        message: 'active jobs must be cancelled by a fenced settlement'
      })
    )
  }

  if (prepared.value.state !== 'waiting' && prepared.value.state !== 'delayed') {
    return Result.err(
      new JobNotCancellableError({ jobId: prepared.value.id, state: prepared.value.state })
    )
  }

  const next: JobRecord = {
    ...prepared.value,
    state: 'cancelled',
    updatedAt: command.now,
    processedAt: command.now,
    finishedAt: command.now,
    result: undefined,
    failure: undefined
  }

  return transition(next)
}

const promote = (record: JobRecord, command: PromoteCommand): TransitionResult => {
  const prepared = prepareNow(record, command.jobId, command.now)

  if (Result.isError(prepared)) {
    return Result.err(prepared.error)
  }

  if (prepared.value.state !== 'delayed') {
    return Result.err(
      new JobNotPromotableError({ jobId: prepared.value.id, state: prepared.value.state })
    )
  }

  return transition({
    ...prepared.value,
    state: 'waiting',
    runAt: command.now,
    updatedAt: command.now
  })
}

const redrive = (record: JobRecord, command: RedriveCommand): TransitionResult => {
  const prepared = prepareNow(record, command.jobId, command.now)

  if (Result.isError(prepared)) {
    return Result.err(prepared.error)
  }

  const runAt = validateTimestampValue(command.runAt, 'runAt')

  if (Result.isError(runAt)) {
    return Result.err(runAt.error)
  }

  if (prepared.value.state !== 'failed' && prepared.value.state !== 'cancelled') {
    return Result.err(
      new JobNotRetryableError({
        jobId: prepared.value.id,
        state: prepared.value.state,
        message: 'only failed or cancelled jobs may be explicitly redriven'
      })
    )
  }

  return transition({
    ...prepared.value,
    state: runAt.value <= command.now ? 'waiting' : 'delayed',
    runAt: runAt.value,
    attemptsMade:
      prepared.value.attemptsMade >= prepared.value.attemptsMax ? 0 : prepared.value.attemptsMade,
    updatedAt: command.now,
    processedAt: undefined,
    finishedAt: undefined,
    result: undefined,
    failure: undefined,
    cancellationRequestedAt: undefined
  })
}

const recoverStalled = (record: JobRecord, command: RecoverStalledCommand): TransitionResult => {
  const prepared = prepareNow(record, command.jobId, command.now)

  if (Result.isError(prepared)) {
    return Result.err(prepared.error)
  }

  if (prepared.value.state !== 'active') {
    return Result.err(
      new JobNotPromotableError({ jobId: prepared.value.id, state: prepared.value.state })
    )
  }

  if (prepared.value.leaseExpiresAt === undefined || command.now < prepared.value.leaseExpiresAt) {
    return Result.err(
      new JobNotPromotableError({
        jobId: prepared.value.id,
        state: prepared.value.state,
        message: 'active lease has not expired'
      })
    )
  }

  const maximum =
    command.maxStalledCount === undefined
      ? Result.ok<number | undefined>(undefined)
      : validateCounterValue(command.maxStalledCount, 'maxStalledCount')

  if (Result.isError(maximum)) {
    return Result.err(maximum.error)
  }

  if (maximum.value !== undefined && prepared.value.stalledCount >= maximum.value) {
    return Result.err(
      new JobNotRetryableError({
        jobId: prepared.value.id,
        state: prepared.value.state,
        message: 'stalled recovery budget is exhausted'
      })
    )
  }

  const stalledCount = prepared.value.stalledCount + 1

  if (!Number.isSafeInteger(stalledCount)) {
    return Result.err(
      new JobDefinitionError({ field: 'stalledCount', message: 'cannot exceed safe integer range' })
    )
  }

  const failure = makeSerializedJobFailure({
    kind: 'stalled',
    message: 'Lease expired before settlement',
    retryable: true,
    recordedAt: command.now
  })

  if (Result.isError(failure)) {
    return Result.err(failure.error)
  }

  const next: JobRecord = {
    ...prepared.value,
    state: 'waiting',
    runAt: command.now,
    stalledCount,
    updatedAt: command.now,
    processedAt: undefined,
    finishedAt: undefined,
    ...clearLease(),
    cancellationRequestedAt: undefined,
    result: undefined,
    failure: failure.value
  }

  const attempt: AttemptRecord = Object.freeze({
    attempt: prepared.value.attemptsMade,
    delivery: prepared.value.deliveryCount,
    startedAt: undefined,
    finishedAt: command.now,
    outcome: 'stalled',
    result: undefined,
    failure: failure.value
  })

  return transition(next, attempt)
}

/** Apply a validated command immutably and optionally return its ledger entry. */
export const reduceJob = (record: JobRecord, command: JobTransitionCommand): TransitionResult => {
  switch (command.type) {
    case 'claim':
      return claim(record, command)
    case 'settle':
      return settle(record, command)
    case 'release':
      return release(record, command)
    case 'request-cancellation':
      return requestCancellation(record, command)
    case 'cancel':
      return cancel(record, command)
    case 'promote':
      return promote(record, command)
    case 'redrive':
      return redrive(record, command)
    case 'recover-stalled':
      return recoverStalled(record, command)
  }

  return Result.err(
    new JobDefinitionError({ field: 'command', message: 'unsupported transition command' })
  )
}

/** Apply a command when only the new job snapshot is needed. */
export const transitionJob = (record: JobRecord, command: JobTransitionCommand): RecordResult =>
  recordOnly(reduceJob(record, command))

export const claimJob = (record: JobRecord, command: ClaimCommand): RecordResult =>
  recordOnly(claim(record, command))

export const settleJob = (record: JobRecord, command: SettleCommand): RecordResult =>
  recordOnly(settle(record, command))

export const releaseJob = (record: JobRecord, command: ReleaseCommand): RecordResult =>
  recordOnly(release(record, command))

export const requestJobCancellation = (
  record: JobRecord,
  command: RequestCancellationCommand
): RecordResult => recordOnly(requestCancellation(record, command))

export const cancelJob = (record: JobRecord, command: CancelCommand): RecordResult =>
  recordOnly(cancel(record, command))

export const promoteJob = (record: JobRecord, command: PromoteCommand): RecordResult =>
  recordOnly(promote(record, command))

export const redriveJob = (record: JobRecord, command: RedriveCommand): RecordResult =>
  recordOnly(redrive(record, command))

export const recoverStalledJob = (
  record: JobRecord,
  command: RecoverStalledCommand
): RecordResult => recordOnly(recoverStalled(record, command))
