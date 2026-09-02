import type { JobFailureKind, JobId, LeaseLossReason, QueueName, WorkerId } from '../protocol'

/** Stable discriminants emitted by the process-local MQ observer. */
export type JobEventType =
  | 'enqueued'
  | 'claimed'
  | 'started'
  | 'completed'
  | 'retry-scheduled'
  | 'failed'
  | 'cancelled'
  | 'released'
  | 'lease-lost'
  | 'stalled-recovered'
  | 'worker-started'
  | 'worker-stopping'
  | 'worker-stopped'
  | 'store-operation-failed'

/** Common, storage-neutral identity carried by job events. */
export interface JobEventBase {
  readonly type: JobEventType
  /** Wall-clock timestamp supplied by the producer or Worker. */
  readonly recordedAt: number
  readonly workerId?: WorkerId
  readonly jobId?: JobId
  readonly queue?: QueueName
  readonly name?: string
  readonly version?: number
  readonly attempt?: number
  readonly delivery?: number
}

export interface JobEnqueued extends JobEventBase {
  readonly type: 'enqueued'
  readonly workerId?: never
  readonly jobId: JobId
  readonly queue: QueueName
  readonly name: string
  readonly version: number
  readonly duplicate: boolean
}

export interface JobClaimed extends JobEventBase {
  readonly type: 'claimed'
  readonly workerId: WorkerId
  readonly jobId: JobId
  readonly queue: QueueName
  readonly name: string
  readonly version: number
  readonly attempt: number
  readonly delivery: number
  readonly waitDurationMs: number
}

export interface JobStarted extends JobEventBase {
  readonly type: 'started'
  readonly workerId: WorkerId
  readonly jobId: JobId
  readonly queue: QueueName
  readonly name: string
  readonly version: number
  readonly attempt: number
  readonly delivery: number
}

export interface JobCompleted extends JobEventBase {
  readonly type: 'completed'
  readonly workerId: WorkerId
  readonly jobId: JobId
  readonly queue: QueueName
  readonly name: string
  readonly version: number
  readonly attempt: number
  readonly delivery: number
  readonly durationMs: number
}

export interface JobRetryScheduled extends JobEventBase {
  readonly type: 'retry-scheduled'
  readonly workerId?: WorkerId
  readonly jobId: JobId
  readonly queue: QueueName
  readonly name: string
  readonly version: number
  readonly attempt?: number
  readonly delivery?: number
  readonly retryAt: number
  readonly retryDelayMs?: number
  readonly durationMs?: number
  readonly source: 'attempt' | 'admin'
  readonly failureKind?: JobFailureKind
  readonly failureCode?: string
}

/** A terminal failure; retriable failures are represented by `retry-scheduled`. */
export interface JobFailed extends JobEventBase {
  readonly type: 'failed'
  readonly workerId?: WorkerId
  readonly jobId: JobId
  readonly queue: QueueName
  readonly name: string
  readonly version: number
  readonly attempt: number
  readonly delivery: number
  readonly failureKind?: JobFailureKind
  readonly failureCode?: string
  readonly willRetry: boolean
  readonly durationMs?: number
}

export interface JobCancelled extends JobEventBase {
  readonly type: 'cancelled'
  readonly workerId?: WorkerId
  readonly jobId: JobId
  readonly queue: QueueName
  readonly name: string
  readonly version: number
  readonly attempt?: number
  readonly delivery?: number
  readonly source?: 'worker' | 'admin' | 'stalled' | 'release'
  readonly durationMs?: number
}

export interface JobReleased extends JobEventBase {
  readonly type: 'released'
  readonly workerId: WorkerId
  readonly jobId: JobId
  readonly queue: QueueName
  readonly name: string
  readonly version: number
  readonly attempt: number
  readonly delivery: number
}

export interface JobLeaseLost extends JobEventBase {
  readonly type: 'lease-lost'
  readonly workerId: WorkerId
  readonly jobId: JobId
  readonly queue: QueueName
  readonly name: string
  readonly version: number
  readonly attempt: number
  readonly delivery: number
  readonly reason: LeaseLossReason | 'store-timeout'
}

export interface JobStalledRecovered extends JobEventBase {
  readonly type: 'stalled-recovered'
  readonly workerId: WorkerId
  readonly jobId: JobId
  readonly queue: QueueName
  readonly name: string
  readonly version: number
  readonly attempt: number
  readonly delivery: number
  readonly outcome: 'requeued' | 'failed' | 'cancelled'
}

export interface WorkerStarted extends JobEventBase {
  readonly type: 'worker-started'
  readonly workerId: WorkerId
}

export interface WorkerStopping extends JobEventBase {
  readonly type: 'worker-stopping'
  readonly workerId: WorkerId
}

export interface WorkerStopped extends JobEventBase {
  readonly type: 'worker-stopped'
  readonly workerId: WorkerId
}

export interface StoreOperationFailed extends JobEventBase {
  readonly type: 'store-operation-failed'
  readonly operation: string
  readonly retryable: boolean
}

/** The complete storage-neutral event union. */
export type JobEvent =
  | JobEnqueued
  | JobClaimed
  | JobStarted
  | JobCompleted
  | JobRetryScheduled
  | JobFailed
  | JobCancelled
  | JobReleased
  | JobLeaseLost
  | JobStalledRecovered
  | WorkerStarted
  | WorkerStopping
  | WorkerStopped
  | StoreOperationFailed

/** Freeze a freshly-created event before it is handed to user code. */
export const freezeJobEvent = <Event extends JobEvent>(event: Event): Event => Object.freeze(event)
