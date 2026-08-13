import { TaggedError } from 'better-result'

/** Describes a failure encountered while releasing a Resource. */
export class ResourceReleaseFailure extends TaggedError('ResourceReleaseFailure')<{
  readonly resource: string
  readonly cause: unknown
  readonly message: string
}> {}
