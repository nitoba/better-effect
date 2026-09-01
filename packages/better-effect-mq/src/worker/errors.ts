/** Reasons a WorkerHandle.awaitIdle operation can fail. */
export type WorkerAwaitIdleErrorReason =
  | 'invalid-options'
  | 'invalid-signal'
  | 'invalid-timeout'
  | 'aborted'
  | 'timeout'

/** A store call could not converge because its owning Runtime was disposed first. */
export class WorkerRuntimeOwnershipError extends Error {
  constructor(cause?: unknown) {
    super('Worker Runtime was disposed before the Worker could converge its in-flight jobs', {
      cause
    })
    this.name = 'WorkerRuntimeOwnershipError'
  }
}

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
