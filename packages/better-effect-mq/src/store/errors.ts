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

/** All typed failures a JobStore operation may report. */
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
