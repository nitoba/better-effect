/** Reasons a WorkerHandle.awaitIdle operation can fail. */
export type WorkerAwaitIdleErrorReason =
  | 'invalid-options'
  | 'invalid-signal'
  | 'invalid-timeout'
  | 'aborted'
  | 'timeout'

/** A focused failure from WorkerHandle.awaitIdle validation or cancellation. */
export class WorkerAwaitIdleError extends Error {
  constructor(
    readonly reason: WorkerAwaitIdleErrorReason,
    message: string,
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'WorkerAwaitIdleError'
  }
}
