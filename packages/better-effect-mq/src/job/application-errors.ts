import { TaggedError } from 'better-result'

import type { JobIdentity } from './job'
import type { JobFailureKind, JobId, JobRecord, SerializedJobFailure } from '../protocol'

/** The record found for a Job ID belongs to a different queue/name/version. */
export class JobIdentityMismatchError extends TaggedError('JobIdentityMismatchError')<{
  readonly jobId: JobId
  readonly expected: JobIdentity
  readonly actual: JobIdentity
  readonly message: string
}> {
  constructor(args: {
    readonly jobId: JobId
    readonly expected: JobIdentity
    readonly actual: Pick<JobRecord, 'queue' | 'name' | 'version'>
  }) {
    super({
      jobId: args.jobId,
      expected: args.expected,
      actual: {
        queue: args.actual.queue,
        name: args.actual.name,
        version: args.actual.version
      },
      message: `Job "${args.jobId}" has a different queue, name, or version`
    })
  }
}

/** Waiting for a Job result was aborted by the caller or Runtime. */
export class JobAwaitAbortedError extends TaggedError('JobAwaitAbortedError')<{
  readonly message: string
}> {
  constructor() {
    super({ message: 'Waiting for a Job result was aborted' })
  }
}

/** A persisted non-domain failure (defect, timeout, decode, or stall). */
export class JobExecutionFailureError extends TaggedError('JobExecutionFailureError')<{
  readonly jobId: JobId
  readonly kind: Exclude<JobFailureKind, 'typed' | 'cancelled'>
  readonly failure: SerializedJobFailure
  readonly message: string
}> {
  constructor(args: {
    readonly jobId: JobId
    readonly kind: Exclude<JobFailureKind, 'typed' | 'cancelled'>
    readonly failure: SerializedJobFailure
  }) {
    super({
      jobId: args.jobId,
      kind: args.kind,
      failure: args.failure,
      message: `Job "${args.jobId}" finished with ${args.kind} failure`
    })
  }
}

/** A Job was terminally cancelled rather than failing with its typed domain error. */
export class JobExecutionCancelledError extends TaggedError('JobExecutionCancelledError')<{
  readonly jobId: JobId
  readonly failure: SerializedJobFailure | undefined
  readonly message: string
}> {
  constructor(args: { readonly jobId: JobId; readonly failure?: SerializedJobFailure }) {
    super({
      jobId: args.jobId,
      failure: args.failure,
      message: `Job "${args.jobId}" was cancelled`
    })
  }
}
