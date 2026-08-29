import { TaggedError } from 'better-result'

import type { JobState } from './types'
import type { JobId, LeaseToken } from './brands'

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

export interface JobCodecIssue {
  readonly message: string
  readonly path?: readonly string[]
  readonly code?: string
}

export class JobEncodeFailure extends TaggedError('JobEncodeFailure')<{
  readonly message: string
  readonly path: readonly string[] | undefined
  readonly issues: readonly JobCodecIssue[] | undefined
}> {
  constructor(args: {
    readonly message?: string
    readonly path?: readonly string[]
    readonly issues?: readonly JobCodecIssue[]
  }) {
    super({
      message: messageOr(args.message, 'Job value could not be encoded'),
      path: args.path,
      issues: args.issues
    })
  }
}

export class JobDecodeFailure extends TaggedError('JobDecodeFailure')<{
  readonly message: string
  readonly path: readonly string[] | undefined
  readonly issues: readonly JobCodecIssue[] | undefined
}> {
  constructor(args: {
    readonly message?: string
    readonly path?: readonly string[]
    readonly issues?: readonly JobCodecIssue[]
  }) {
    super({
      message: messageOr(args.message, 'Persisted job value could not be decoded'),
      path: args.path,
      issues: args.issues
    })
  }
}

/** The codec-related error union reserved for the later Codec API. */
export type JobCodecFailure = JobEncodeFailure | JobDecodeFailure

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
