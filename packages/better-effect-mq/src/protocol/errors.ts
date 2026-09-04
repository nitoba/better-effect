// oxlint-disable anti-slop/no-unknown-parameters -- tagged-error guards accept arbitrary cross-package values.

import { TaggedError } from 'better-result'

import { hasTaggedError } from '../internal/tagged'

import type { JobState, ProtocolVersion } from './types'
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

  static override is<C extends TaggedErrorConstructor>(
    this: C,
    value: unknown
  ): value is InstanceType<C> {
    return hasTaggedError(value, 'JobStoreFailure')
  }
}

/** Raised before a worker starts when a store does not implement protocol v1. */
export class JobStoreProtocolMismatchError extends TaggedError('JobStoreProtocolMismatchError')<{
  readonly expected: ProtocolVersion
  readonly actual: number | string | undefined
  readonly expectedProtocolVersion: ProtocolVersion
  readonly actualProtocolVersion: number | string | undefined
  readonly adapter: string | undefined
  readonly adapterVersion: string | undefined
  readonly message: string
}> {
  constructor(args: {
    readonly expected?: ProtocolVersion
    readonly actual?: number | string | undefined
    readonly expectedProtocolVersion?: ProtocolVersion | undefined
    readonly actualProtocolVersion?: number | string | undefined
    readonly adapter?: string | undefined
    readonly adapterVersion?: string | undefined
    readonly message?: string | undefined
  }) {
    const expected = args.expectedProtocolVersion ?? args.expected ?? 1
    const actual = args.actualProtocolVersion ?? args.actual
    super({
      expected,
      actual,
      expectedProtocolVersion: expected,
      actualProtocolVersion: actual,
      adapter: args.adapter,
      adapterVersion: args.adapterVersion,
      message:
        args.message ??
        `JobStore protocol mismatch: expected v${expected}, received ${actual === undefined ? 'unknown' : `v${actual}`}`
    })
  }

  static override is<C extends TaggedErrorConstructor>(
    this: C,
    value: unknown
  ): value is InstanceType<C> {
    return hasTaggedError(value, 'JobStoreProtocolMismatchError')
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

  static override is<C extends TaggedErrorConstructor>(
    this: C,
    value: unknown
  ): value is InstanceType<C> {
    return hasTaggedError(value, 'JobNotFoundError')
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

  static override is<C extends TaggedErrorConstructor>(
    this: C,
    value: unknown
  ): value is InstanceType<C> {
    return hasTaggedError(value, 'LeaseLostError')
  }
}

/** A fenced settlement replay used a token with a different canonical outcome. */
export class SettlementConflictError extends TaggedError('SettlementConflictError')<{
  readonly jobId: JobId
  readonly leaseToken: LeaseToken
  readonly reason: 'outcome-mismatch'
  readonly message: string
}> {
  constructor(args: {
    readonly jobId: JobId
    readonly leaseToken: LeaseToken
    readonly message?: string
  }) {
    super({
      jobId: args.jobId,
      leaseToken: args.leaseToken,
      reason: 'outcome-mismatch',
      message: messageOr(
        args.message,
        `Settlement for job "${args.jobId}" conflicts with the recorded outcome`
      )
    })
  }

  static override is<C extends TaggedErrorConstructor>(
    this: C,
    value: unknown
  ): value is InstanceType<C> {
    return hasTaggedError(value, 'SettlementConflictError')
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

  static override is<C extends TaggedErrorConstructor>(
    this: C,
    value: unknown
  ): value is InstanceType<C> {
    return hasTaggedError(value, 'JobNotRetryableError')
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

  static override is<C extends TaggedErrorConstructor>(
    this: C,
    value: unknown
  ): value is InstanceType<C> {
    return hasTaggedError(value, 'JobNotCancellableError')
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

  static override is<C extends TaggedErrorConstructor>(
    this: C,
    value: unknown
  ): value is InstanceType<C> {
    return hasTaggedError(value, 'JobNotPromotableError')
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

  static override is<C extends TaggedErrorConstructor>(
    this: C,
    value: unknown
  ): value is InstanceType<C> {
    return hasTaggedError(value, 'InvalidJobTransitionError')
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

  static override is<C extends TaggedErrorConstructor>(
    this: C,
    value: unknown
  ): value is InstanceType<C> {
    return hasTaggedError(value, 'JobDefinitionError')
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

  static override is<C extends TaggedErrorConstructor>(
    this: C,
    value: unknown
  ): value is InstanceType<C> {
    return hasTaggedError(value, 'UnsupportedJobStoreOperationError')
  }
}
