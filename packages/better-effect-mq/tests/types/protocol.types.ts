import { expectTypeOf } from 'bun:test'
import { Result, type Result as ResultType } from 'better-result'

import {
  JobDefinitionError,
  JobId,
  JobName,
  LeaseToken,
  QueueName,
  WorkerId,
  claimJob,
  makePersistedBackoff,
  reduceJob,
  settleJob
} from '../../src'
import type {
  AttemptOutcome,
  ClaimCommand,
  JobCodecFailure,
  JobFailureKind,
  JobRecord,
  JobState,
  JobTransition,
  RecoverStalledCommand,
  JobTransitionFailure,
  JsonValue,
  PersistedBackoff,
  SerializedJobFailure,
  SettleCommand,
  SettlementOutcome
} from '../../src'

const jobIdResult = JobId.make('job-1')
const queueResult = QueueName.make('queue')
const jobNameResult = JobName.make('job-name')
const leaseResult = LeaseToken.make('lease')
const workerResult = WorkerId.make('worker')

expectTypeOf(jobIdResult).toEqualTypeOf<ResultType<JobId, JobDefinitionError>>()
expectTypeOf(queueResult).toEqualTypeOf<ResultType<QueueName, JobDefinitionError>>()
expectTypeOf(jobNameResult).toEqualTypeOf<ResultType<JobName, JobDefinitionError>>()
expectTypeOf(leaseResult).toEqualTypeOf<ResultType<LeaseToken, JobDefinitionError>>()
expectTypeOf(workerResult).toEqualTypeOf<ResultType<WorkerId, JobDefinitionError>>()

const rawString: string = ''
// @ts-expect-error Raw strings must not be assignable to nominal identities.
const invalidJobId: JobId = rawString
// @ts-expect-error Queue names have a distinct nominal brand.
const invalidQueue: QueueName = rawString
// @ts-expect-error Lease tokens have a distinct nominal brand.
const invalidToken: LeaseToken = rawString

declare const record: JobRecord
declare const jobId: JobId
declare const workerId: WorkerId
declare const leaseToken: LeaseToken

const command: ClaimCommand = {
  type: 'claim',
  jobId,
  workerId,
  leaseToken,
  leaseExpiresAt: 2,
  now: 1
}

expectTypeOf(claimJob(record, command)).toEqualTypeOf<ResultType<JobRecord, JobTransitionFailure>>()
expectTypeOf(reduceJob(record, command)).toEqualTypeOf<
  ResultType<JobTransition, JobTransitionFailure>
>()

const recoverStalledCommand: RecoverStalledCommand = {
  type: 'recover-stalled',
  jobId,
  now: 1
}
type RecoverStalledCommandHasTerminal = 'terminal' extends keyof RecoverStalledCommand
  ? true
  : false
expectTypeOf<RecoverStalledCommandHasTerminal>().toEqualTypeOf<false>()

const forcedTerminalRecovery: RecoverStalledCommand = {
  type: 'recover-stalled',
  jobId,
  now: 1,
  // @ts-expect-error Terminal recovery policy is private to the store.
  terminal: true
}
void recoverStalledCommand
void forcedTerminalRecovery

declare const outcome: SettlementOutcome
const settleCommand: SettleCommand = {
  type: 'settle',
  jobId,
  leaseToken,
  now: 1,
  outcome
}
expectTypeOf(settleJob(record, settleCommand)).toEqualTypeOf<
  ResultType<JobRecord, JobTransitionFailure>
>()

declare const backoff: PersistedBackoff
expectTypeOf(makePersistedBackoff(backoff)).toEqualTypeOf<
  ResultType<PersistedBackoff, JobDefinitionError>
>()

const unsafeFailure: SerializedJobFailure = {
  kind: 'defect',
  message: 'unsafe',
  retryable: false,
  recordedAt: 1,
  // @ts-expect-error Errors and live Result values cannot be persisted as JSON.
  data: new Error('not JSON')
}
void unsafeFailure

// @ts-expect-error A Result object is not a JSON value.
const unsafePayload: JsonValue = Result.ok('live')
void unsafePayload

const stateIsExhaustive = (state: JobState): string => {
  switch (state) {
    case 'waiting':
    case 'delayed':
    case 'active':
    case 'completed':
    case 'failed':
    case 'cancelled':
      return state
    default: {
      const exhaustive: never = state
      return exhaustive
    }
  }
}

const attemptIsExhaustive = (outcome: AttemptOutcome): string => {
  switch (outcome) {
    case 'completed':
    case 'retried':
    case 'failed':
    case 'cancelled':
    case 'stalled':
    case 'released':
      return outcome
    default: {
      const exhaustive: never = outcome
      return exhaustive
    }
  }
}

const failureIsExhaustive = (kind: JobFailureKind): string => {
  switch (kind) {
    case 'typed':
    case 'defect':
    case 'timeout':
    case 'decode':
    case 'stalled':
    case 'cancelled':
      return kind
    default: {
      const exhaustive: never = kind
      return exhaustive
    }
  }
}

const codecFailureIsTagged = (failure: JobCodecFailure): string => {
  expectTypeOf(failure._tag).toEqualTypeOf<'JobCodecFailure'>()
  return failure.message
}

expectTypeOf(stateIsExhaustive).returns.toEqualTypeOf<string>()
expectTypeOf(attemptIsExhaustive).returns.toEqualTypeOf<string>()
expectTypeOf(failureIsExhaustive).returns.toEqualTypeOf<string>()
expectTypeOf(codecFailureIsTagged).returns.toEqualTypeOf<string>()

void invalidJobId
void invalidQueue
void invalidToken
