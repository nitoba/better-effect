// oxlint-disable anti-slop/no-unknown-parameters -- tagged-error guards accept arbitrary cross-package values.

import { TaggedError } from 'better-result'

import { hasTaggedError } from '../internal/tagged'

import type {
  InvalidJobTransitionError,
  JobDefinitionError,
  JobNotCancellableError,
  JobNotFoundError,
  JobNotPromotableError,
  JobNotRetryableError,
  JobStoreFailure,
  LeaseLostError,
  UnsupportedJobStoreOperationError
} from '../protocol'

/**
 * The only expected failure added by the wake boundary.
 *
 * The signal's reason is deliberately not retained: it may be an arbitrary
 * application object and is not part of the storage-neutral error contract.
 */
type TaggedErrorConstructor = abstract new (...args: never[]) => object

export class JobStoreWakeAbortedError extends TaggedError('JobStoreWakeAbortedError')<{
  readonly message: string
}> {
  constructor() {
    super({ message: 'Waiting for a JobStore wake-up was aborted' })
  }

  static override is<C extends TaggedErrorConstructor>(
    this: C,
    value: unknown
  ): value is InstanceType<C> {
    return hasTaggedError(value, 'JobStoreWakeAbortedError')
  }
}

/** The infrastructure failure shared by operations that cross the storage boundary. */
export type JobStoreInfrastructureError = JobStoreFailure

/** Validation failures shared by operations that accept a request DTO. */
export type JobStoreValidationError = JobDefinitionError

/** Errors for the fixed list/count query shapes that can be unsupported by an adapter. */
export type JobStoreQueryError =
  | JobStoreFailure
  | JobDefinitionError
  | UnsupportedJobStoreOperationError

/** Errors common to state-changing operations without lease fencing. */
export type JobStoreTransitionError =
  | JobStoreFailure
  | JobDefinitionError
  | JobNotFoundError
  | InvalidJobTransitionError

/** Errors common to state-changing operations that require a valid lease. */
export type JobStoreLeaseTransitionError = JobStoreTransitionError | LeaseLostError

export type JobStoreEnqueueError = JobStoreFailure | JobDefinitionError
export type JobStoreClaimError = JobStoreFailure | JobDefinitionError
export type JobStoreEnqueueManyError = JobStoreFailure | JobDefinitionError

export type JobStoreSettlementError = JobStoreLeaseTransitionError | JobNotRetryableError

export type JobStoreReleaseError = JobStoreLeaseTransitionError
export type JobStoreHeartbeatError = JobStoreFailure | JobDefinitionError
export type JobStoreRecoverStalledError =
  | JobStoreFailure
  | JobDefinitionError
  | JobNotFoundError
  | JobNotPromotableError

/** Wake is the only operation that exposes the store's typed abort failure. */
export type JobStoreWakeError = JobStoreFailure | JobStoreWakeAbortedError

export type JobStoreGetJobError = JobStoreFailure | JobDefinitionError
export type JobStoreGetAttemptsError = JobStoreFailure | JobDefinitionError
export type JobStoreListError = JobStoreQueryError
export type JobStoreCountsError = JobStoreQueryError
export type JobStorePausedQueuesError = JobStoreFailure

export type JobStoreRetryError =
  | JobStoreFailure
  | JobDefinitionError
  | JobNotFoundError
  | JobNotRetryableError

export type JobStoreCancelError =
  | JobStoreFailure
  | JobDefinitionError
  | JobNotFoundError
  | JobNotCancellableError

export type JobStoreRequestCancellationError = JobStoreCancelError

export type JobStorePromoteError =
  | JobStoreFailure
  | JobDefinitionError
  | JobNotFoundError
  | JobNotPromotableError

export type JobStoreRemoveError = JobStoreTransitionError
export type JobStorePauseError = JobStoreFailure | JobDefinitionError
export type JobStoreResumeError = JobStorePauseError

/**
 * Compatibility aggregate for callers that need to handle any JobStore error.
 * Contract methods use the focused aliases above rather than this union.
 */
export type JobStoreError =
  | JobStoreFailure
  | UnsupportedJobStoreOperationError
  | JobStoreWakeAbortedError
  | JobDefinitionError
  | JobNotFoundError
  | LeaseLostError
  | JobNotRetryableError
  | JobNotCancellableError
  | JobNotPromotableError
  | InvalidJobTransitionError
