import type { JobId, JobName, LeaseToken, QueueName, WorkerId } from './brands'

export type JsonPrimitive = string | number | boolean | null

export type JsonArray = readonly JsonValue[]

export type JsonObject = {
  readonly [key: string]: JsonValue
}

export type JsonValue = JsonPrimitive | JsonArray | JsonObject

export const protocolVersion = 1 as const

export type ProtocolVersion = typeof protocolVersion

export type JobState = 'waiting' | 'delayed' | 'active' | 'completed' | 'failed' | 'cancelled'

export type AttemptOutcome =
  | 'completed'
  | 'retried'
  | 'failed'
  | 'cancelled'
  | 'stalled'
  | 'released'

export type JobFailureKind =
  | 'typed'
  | 'defect'
  | 'encode'
  | 'timeout'
  | 'decode'
  | 'stalled'
  | 'cancelled'

export type BackoffKind = 'constant' | 'linear' | 'exponential'

export interface PersistedBackoff {
  readonly type: BackoffKind
  readonly delayMs: number
  readonly incrementMs?: number
  readonly factor?: number
  readonly maxDelayMs?: number
  /** Symmetric multiplicative jitter range, from 0 to 1. */
  readonly jitter?: number
}

export interface SerializedJobFailure {
  readonly kind: JobFailureKind
  readonly code?: string
  readonly message: string
  readonly data?: JsonValue
  readonly retryable: boolean
  readonly recordedAt: number
}

export interface JobRecord {
  readonly id: JobId
  readonly name: JobName
  readonly version: number
  readonly queue: QueueName
  readonly state: JobState
  readonly payload: JsonValue
  readonly metadata: Readonly<Record<string, string>>
  readonly priority: number
  readonly runAt: number
  readonly orderingSequence: number
  readonly attemptsMax: number
  readonly attemptsMade: number
  /** Monotonic count of handler settlements, independent of the current retry budget. */
  /** Optional on legacy snapshots; validators derive it from deliveryCount. */
  readonly attemptSequence?: number
  readonly deliveryCount: number
  readonly stalledCount: number
  readonly backoff: PersistedBackoff | undefined
  readonly timeoutMs: number | undefined
  readonly idempotencyKey: string | undefined
  readonly createdAt: number
  readonly updatedAt: number
  readonly processedAt: number | undefined
  readonly finishedAt: number | undefined
  readonly leaseOwner: WorkerId | undefined
  readonly leaseToken: LeaseToken | undefined
  readonly leaseExpiresAt: number | undefined
  readonly cancellationRequestedAt: number | undefined
  readonly result: JsonValue | undefined
  readonly failure: SerializedJobFailure | undefined
}

export interface AttemptRecord {
  /** Handler-attempt number for this delivery; unlike attemptsMade this remains a monotonic ledger number. */
  readonly attempt: number
  /** Present on new entries when the monotonic ledger differs from delivery. */
  readonly attemptSequence?: number
  readonly delivery: number
  readonly startedAt: number | undefined
  readonly finishedAt: number
  readonly outcome: AttemptOutcome
  readonly result: JsonValue | undefined
  readonly failure: SerializedJobFailure | undefined
  /** Exact retry schedule for retried entries. Optional for legacy records. */
  readonly retryAt?: number
  readonly retryDelayMs?: number
}

export interface CompleteOutcome {
  readonly type: 'complete'
  readonly result?: JsonValue
}

export interface RetryOutcome {
  readonly type: 'retry'
  readonly runAt: number
  /** Delay selected before settlement; retained so the ledger reports the exact schedule. */
  readonly retryDelayMs?: number
  readonly failure?: SerializedJobFailure
}

export interface FailOutcome {
  readonly type: 'fail'
  readonly failure: SerializedJobFailure
}

export interface CancelledOutcome {
  readonly type: 'cancelled'
  readonly failure?: SerializedJobFailure
}

export type SettlementOutcome = CompleteOutcome | RetryOutcome | FailOutcome | CancelledOutcome

export interface ClaimCommand {
  readonly type: 'claim'
  readonly jobId: JobId
  readonly workerId: WorkerId
  readonly leaseToken: LeaseToken
  readonly leaseExpiresAt: number
  readonly now: number
}

export interface SettleCommand {
  readonly type: 'settle'
  readonly jobId: JobId
  readonly leaseToken: LeaseToken | undefined
  readonly outcome: SettlementOutcome
  readonly now: number
  readonly startedAt?: number
}

export interface ReleaseCommand {
  readonly type: 'release'
  readonly jobId: JobId
  readonly leaseToken: LeaseToken | undefined
  readonly now: number
}

export interface RequestCancellationCommand {
  readonly type: 'request-cancellation'
  readonly jobId: JobId
  readonly now: number
}

export interface CancelCommand {
  readonly type: 'cancel'
  readonly jobId: JobId
  readonly now: number
}

export interface PromoteCommand {
  readonly type: 'promote'
  readonly jobId: JobId
  readonly now: number
}

export interface RetryCommand {
  readonly type: 'retry'
  readonly jobId: JobId
  readonly runAt: number
  readonly now: number
}

export interface RecoverStalledCommand {
  readonly type: 'recover-stalled'
  readonly jobId: JobId
  readonly now: number
}

export type JobTransitionCommand =
  | ClaimCommand
  | SettleCommand
  | ReleaseCommand
  | RequestCancellationCommand
  | CancelCommand
  | PromoteCommand
  | RetryCommand
  | RecoverStalledCommand

export interface JobTransition {
  readonly record: JobRecord
  readonly attempt: AttemptRecord | undefined
}
