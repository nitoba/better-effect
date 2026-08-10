import { TaggedError } from 'better-result'

export class ResourceReleaseFailure extends TaggedError('ResourceReleaseFailure')<{
  readonly resource: string
  readonly cause: unknown
  readonly message: string
}> {}
