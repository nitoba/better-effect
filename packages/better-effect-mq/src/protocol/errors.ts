import { TaggedError } from 'better-result'

import { hasTaggedError } from '../internal/tagged'

import type { JobState } from './types'
import type { JobId, LeaseToken } from './brands'

type TaggedErrorConstructor = abstract new (...args: never[]) => object

const messageOr = (message: string | undefined, fallback: string): string => message ?? fallback

export class JobStoreFailure extends TaggedError('JobStoreFailure')<{
  readonly operation: string
  readonly retryable: boolean
  readonly message: string
}> {
  constructor(args: {
    readonly operation: string
    readonly retryable: boolean
    readonly message?: string
  }) {
    super({
      operation: args.operation,
      retryable: args.retryable,
      message: messageOr(args.message, `Job store operation failed: ${args.operation}`)
    })
  }
}

export class JobNotFoundError extends TaggedError('JobNotFoundError')<{
  readonly jobId: JobId
  readonly message: string
}> {
  constructor(args: { readonly jobId: JobId; readonly message?: string }) {
    super({
      jobId: args.jobId,
      message: messageOr(args.message, `Job "${args.jobId}" was not found`)
    })
  }
}

export type LeaseLossReason =
  | 'missing-token'
  | 'mismatched-token'
  | 'expired-lease'
  | 'missing-lease'

export class LeaseLostError extends TaggedError('LeaseLostError')<{
  readonly jobId: JobId
  readonly leaseToken: LeaseToken | undefined
  readonly reason: LeaseLossReason
  readonly message: string
}> {
  constructor(args: {
    readonly jobId: JobId
    readonly leaseToken?: LeaseToken
    readonly reason: LeaseLossReason
    readonly message?: string
  }) {
    super({
      jobId: args.jobId,
      leaseToken: args.leaseToken,
      reason: args.reason,
      message: messageOr(args.message, `Lease for job "${args.jobId}" is no longer valid`)
    })
  }
}

export class JobNotRetryableError extends TaggedError('JobNotRetryableError')<{
  readonly jobId: JobId
  readonly state: JobState
  readonly message: string
}> {
  constructor(args: {
    readonly jobId: JobId
    readonly state: JobState
    readonly message?: string
  }) {
    super({
      jobId: args.jobId,
      state: args.state,
      message: messageOr(args.message, `Job "${args.jobId}" cannot be retried`)
    })
  }
}

export class JobNotCancellableError extends TaggedError('JobNotCancellableError')<{
  readonly jobId: JobId
  readonly state: JobState
  readonly message: string
}> {
  constructor(args: {
    readonly jobId: JobId
    readonly state: JobState
    readonly message?: string
  }) {
    super({
      jobId: args.jobId,
      state: args.state,
      message: messageOr(args.message, `Job "${args.jobId}" cannot be cancelled`)
    })
  }
}

export class JobNotPromotableError extends TaggedError('JobNotPromotableError')<{
  readonly jobId: JobId
  readonly state: JobState
  readonly message: string
}> {
  constructor(args: {
    readonly jobId: JobId
    readonly state: JobState
    readonly message?: string
  }) {
    super({
      jobId: args.jobId,
      state: args.state,
      message: messageOr(args.message, `Job "${args.jobId}" cannot be promoted`)
    })
  }
}

export class InvalidJobTransitionError extends TaggedError('InvalidJobTransitionError')<{
  readonly jobId: JobId
  readonly from: JobState
  readonly operation: string
  readonly message: string
}> {
  constructor(args: {
    readonly jobId: JobId
    readonly from: JobState
    readonly operation: string
    readonly message?: string
  }) {
    super({
      jobId: args.jobId,
      from: args.from,
      operation: args.operation,
      message: messageOr(
        args.message,
        `Operation "${args.operation}" is invalid for job "${args.jobId}" in state "${args.from}"`
      )
    })
  }
}

/** The single codec error placeholder exposed by the v0.1 protocol. */
export class JobCodecFailure extends TaggedError('JobCodecFailure')<{
  readonly message: string
}> {
  constructor(args: { readonly message?: string } = {}) {
    super({ message: messageOr(args.message, 'Job codec operation failed') })
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- guards accept arbitrary cross-package values.
  static override is<C extends TaggedErrorConstructor>(
    this: C,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- guards accept arbitrary cross-package values.
    value: unknown
  ): value is InstanceType<C> {
    return hasTaggedError(value, 'JobCodecFailure')
  }
}

export class JobDefinitionError extends TaggedError('JobDefinitionError')<{
  readonly field: string
  readonly message: string
}> {
  constructor(args: { readonly field: string; readonly message: string }) {
    super(args)
  }
}

export class UnsupportedJobStoreOperationError extends TaggedError(
  'UnsupportedJobStoreOperationError'
)<{
  readonly operation: string
  readonly message: string
}> {
  constructor(args: { readonly operation: string; readonly message?: string }) {
    super({
      operation: args.operation,
      message: messageOr(args.message, `Job store operation is unsupported: ${args.operation}`)
    })
  }
}
