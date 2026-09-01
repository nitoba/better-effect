import type { AnyService, Effect } from 'better-effect'

import type { AnyJobRegistry, RegisteredJobIdentity } from '../job'
import type { JobIdentity } from '../job'
import type {
  ActiveLease,
  AttemptRecord,
  JobRecord,
  JobState,
  JobTransition,
  JsonValue,
  PersistedBackoff,
  SettlementOutcome
} from '../protocol'
import type {
  JobStoreCancelError,
  JobStoreClaimError,
  JobStoreCountsError,
  JobStoreEnqueueError,
  JobStoreEnqueueManyError,
  JobStoreError,
  JobStoreGetAttemptsError,
  JobStoreGetJobError,
  JobStoreHeartbeatError,
  JobStoreListError,
  JobStorePauseError,
  JobStorePausedQueuesError,
  JobStorePromoteError,
  JobStoreRecoverStalledError,
  JobStoreRetryError,
  JobStoreReleaseError,
  JobStoreRemoveError,
  JobStoreRequestCancellationError,
  JobStoreResumeError,
  JobStoreSettlementError,
  JobStoreWakeError
} from './errors'

/** Opaque version returned by a claim and supplied to the wake boundary. */
declare const WakeTokenBrand: unique symbol
export type WakeToken = string & { readonly [WakeTokenBrand]: 'WakeToken' }

/** A completed better-effect Result facade for one JobStore operation. */
export type JobStoreEffect<
  Success,
  Failure extends JobStoreError = JobStoreError,
  Requirements extends AnyService = never
> = Effect<Success, Failure, Requirements>

/**
 * A JobStore operation may complete immediately or after adapter I/O.
 * `Effect` is a completed Result facade, so the Promise belongs around the
 * Result rather than inside the Effect type.
 */
export type JobStoreOperation<
  Success,
  Failure extends JobStoreError = JobStoreError,
  Requirements extends AnyService = never
> =
  | JobStoreEffect<Success, Failure, Requirements>
  | PromiseLike<JobStoreEffect<Success, Failure, Requirements>>

/**
 * The feature flags exposed by a store. They are immutable hints only: a false
 * flag must not weaken the operation contracts. `queueFilteredNotifications`
 * additionally declares that wake delivery honors the requested queue set.
 */
export interface JobStoreCapabilities {
  readonly notifications: boolean
  readonly queueFilteredNotifications: boolean
  readonly batchClaim: boolean
  readonly transactionalEnqueue: boolean
  readonly changeFeed: boolean
}

/** Input accepted by `enqueue`. The store owns missing IDs and ordering data. */
export type EnqueueRequest = {
  readonly id?: import('../protocol').JobId
  readonly idempotencyKey?: string
  readonly payload: JsonValue
  readonly metadata?: Readonly<Record<string, string>>
  readonly priority?: number
  readonly runAt: number
  readonly attemptsMax: number
  readonly backoff?: PersistedBackoff
  readonly timeoutMs?: number
  readonly now: number
} & (
  | {
      readonly job: JobIdentity
      readonly identity?: never
    }
  | {
      readonly identity: JobIdentity
      readonly job?: never
    }
)

/** The result of one idempotent enqueue attempt. */
export interface EnqueueResult {
  readonly job: JobRecord
  readonly duplicate: boolean
}

/** The output of `enqueueMany`, in exactly the input order. */
export type EnqueueManyResult = readonly EnqueueResult[]

/**
 * An identity accepted by claim. `ClaimRequestFor<Registry>` narrows this to
 * the exact queue/name/version identities held by a local registry; the store
 * still validates the values at its runtime boundary.
 */
export type ClaimIdentity = RegisteredJobIdentity

/** Claim input. `accepted` must come from a `JobRegistry`'s accepted identities. */
export interface ClaimRequest {
  readonly queue: import('../protocol').QueueName
  readonly accepted: readonly ClaimIdentity[]
  readonly limit: number
  readonly workerId: import('../protocol').WorkerId
  readonly leaseDurationMs: number
  readonly now: number
}

/** Claim input narrowed to one concrete local registry. */
export type ClaimRequestFor<Registry extends AnyJobRegistry> = Omit<ClaimRequest, 'accepted'> & {
  readonly accepted: readonly import('../job').JobRegistry.Identity<Registry>[]
}

/** A claimed immutable snapshot with its fencing lease made explicit. */
export type ActiveJobSnapshot = JobRecord & {
  readonly state: 'active'
  readonly leaseOwner: import('../protocol').WorkerId
  readonly leaseToken: import('../protocol').LeaseToken
  readonly leaseExpiresAt: number
}

/** Claim results always contain a wake version and the next known due time. */
export interface ClaimResult {
  readonly jobs: readonly ActiveJobSnapshot[]
  readonly wakeToken: WakeToken
  readonly nextRunAt: number | undefined
}

/** A fenced settlement request. The token is required, unlike the pure reducer command. */
export interface SettleRequest {
  readonly jobId: import('../protocol').JobId
  readonly leaseToken: import('../protocol').LeaseToken
  readonly outcome: SettlementOutcome
  readonly now: number
  readonly startedAt?: number
}

export type SettlementRequest = SettleRequest

/** Settlement always persists one handler attempt with the new snapshot. */
export type SettlementResult = Omit<JobTransition, 'attempt'> & {
  readonly attempt: AttemptRecord
  /** True when the same lease/token already applied this terminal settlement. */
  readonly alreadySettled?: boolean
}

/** A fenced release request; release does not consume an attempt budget. */
export interface ReleaseRequest {
  readonly jobId: import('../protocol').JobId
  readonly leaseToken: import('../protocol').LeaseToken
  readonly now: number
}

export type ReleaseResult = JobTransition

/** One lease presented to heartbeat. */
export interface HeartbeatLease {
  readonly jobId: import('../protocol').JobId
  readonly leaseToken: import('../protocol').LeaseToken
}

/** Renew all leases as one request while reporting each lost lease explicitly. */
export interface HeartbeatRequest {
  readonly leases: readonly HeartbeatLease[]
  readonly leaseDurationMs: number
  readonly now: number
}

export interface LostLease {
  readonly jobId: import('../protocol').JobId
  readonly leaseToken: import('../protocol').LeaseToken
  readonly reason: import('../protocol').LeaseLossReason
}

export interface HeartbeatResult {
  readonly renewed: readonly ActiveLease[]
  readonly lost: readonly LostLease[]
  readonly cancellationRequested: readonly import('../protocol').JobId[]
}

/** Recover expired active leases without accepting a still-valid lease. */
export interface RecoverStalledRequest {
  readonly maxStalledCount: number
  readonly limit?: number
  readonly now: number
}

export interface RecoverStalledResult {
  readonly transitions: readonly JobTransition[]
  readonly recovered: number
}

/**
 * Wait for a store wake/version change. Resolution is only a hint and may be
 * spurious; abort is the one typed failure with deterministic semantics.
 */
export interface AwaitWakeRequest {
  readonly queues: readonly import('../protocol').QueueName[]
  readonly wakeToken: WakeToken
  readonly signal: AbortSignal
}

/** Return one snapshot, or `undefined` when the identity is absent. */
export interface GetJobRequest {
  readonly jobId: import('../protocol').JobId
}

export interface GetAttemptsRequest {
  readonly jobId: import('../protocol').JobId
}

/** The public primary fields supported by encoded-neutral Job listing. */
export type JobListOrderBy = 'enqueuedAt' | 'runAt' | 'finishedAt'
export type JobListOrder = 'asc' | 'desc'
export type JobListOrdering = `${'createdAt' | 'runAt' | 'finishedAt'},orderingSequence,id`

/**
 * Self-contained keyset cursor for a list order. `value` is the primary sort
 * value; `null` represents an unfinished Job when ordering by `finishedAt`.
 * The legacy `createdAt`/`direction` fields remain in the wire shape so older
 * cursors can be diagnosed without silently changing their meaning.
 */
export interface JobListCursor {
  readonly version: 1
  readonly orderBy: JobListOrderBy
  readonly order: JobListOrder
  readonly ordering: JobListOrdering
  readonly direction: JobListOrder
  readonly filterSignature: string
  readonly value: number | null
  readonly createdAt: number
  readonly orderingSequence: number
  readonly id: import('../protocol').JobId
}

/**
 * Portable encoded-neutral inspection query. Unsupported combinations return
 * `UnsupportedJobStoreOperationError`; they never imply a hidden scan.
 */
export interface ListJobsRequest {
  readonly queue?: import('../protocol').QueueName
  readonly name?: import('../protocol').JobName
  readonly version?: number
  readonly state?: JobState | readonly JobState[]
  readonly metadata?: Readonly<Record<string, string>>
  readonly orderBy?: JobListOrderBy
  readonly order?: JobListOrder
  readonly limit: number
  readonly cursor?: JobListCursor
}

export interface ListJobsResult {
  readonly jobs: readonly JobRecord[]
  readonly nextCursor: JobListCursor | undefined
}

export interface CountsRequest {
  readonly queue?: import('../protocol').QueueName
  readonly name?: import('../protocol').JobName
}

export interface JobCounts {
  readonly total: number
  readonly waiting: number
  readonly delayed: number
  readonly active: number
  readonly completed: number
  readonly failed: number
  readonly cancelled: number
}

export interface JobIdRequest {
  readonly jobId: import('../protocol').JobId
  readonly now: number
}

export interface RetryRequest extends JobIdRequest {
  readonly runAt: number
}

export type RetryResult = JobTransition
export type CancelRequest = JobIdRequest
export type CancelResult = JobTransition
export type RequestCancellationRequest = JobIdRequest
export type RequestCancellationResult = JobTransition
export type PromoteRequest = JobIdRequest
export type PromoteResult = JobTransition

/** Remove only when the optional state precondition still matches. */
export interface RemoveRequest extends JobIdRequest {
  readonly expectedState?: JobState
}

export interface RemoveResult {
  readonly job: JobRecord
  readonly removed: true
}

export interface PauseQueueRequest {
  readonly queue: import('../protocol').QueueName
  readonly now: number
}

export interface QueuePauseResult {
  readonly queue: import('../protocol').QueueName
  readonly paused: boolean
}

/** A structural implementation suitable for `Service.of` and Layer providers. */
export interface JobStoreContract {
  readonly protocolVersion: import('../protocol').ProtocolVersion
  readonly capabilities: JobStoreCapabilities

  enqueue(request: EnqueueRequest): JobStoreOperation<EnqueueResult, JobStoreEnqueueError>
  enqueueMany(
    requests: readonly EnqueueRequest[]
  ): JobStoreOperation<EnqueueManyResult, JobStoreEnqueueManyError>
  claim(request: ClaimRequest): JobStoreOperation<ClaimResult, JobStoreClaimError>
  settle(request: SettleRequest): JobStoreOperation<SettlementResult, JobStoreSettlementError>
  release(request: ReleaseRequest): JobStoreOperation<ReleaseResult, JobStoreReleaseError>
  heartbeat(request: HeartbeatRequest): JobStoreOperation<HeartbeatResult, JobStoreHeartbeatError>
  recoverStalled(
    request: RecoverStalledRequest
  ): JobStoreOperation<RecoverStalledResult, JobStoreRecoverStalledError>
  awaitWake(request: AwaitWakeRequest): JobStoreOperation<void, JobStoreWakeError>

  getJob(request: GetJobRequest): JobStoreOperation<JobRecord | undefined, JobStoreGetJobError>
  getAttempts(
    request: GetAttemptsRequest
  ): JobStoreOperation<readonly AttemptRecord[], JobStoreGetAttemptsError>
  list(request: ListJobsRequest): JobStoreOperation<ListJobsResult, JobStoreListError>
  counts(request?: CountsRequest): JobStoreOperation<JobCounts, JobStoreCountsError>

  retry(request: RetryRequest): JobStoreOperation<RetryResult, JobStoreRetryError>
  cancel(request: CancelRequest): JobStoreOperation<CancelResult, JobStoreCancelError>
  requestCancellation(
    request: RequestCancellationRequest
  ): JobStoreOperation<RequestCancellationResult, JobStoreRequestCancellationError>
  promote(request: PromoteRequest): JobStoreOperation<PromoteResult, JobStorePromoteError>
  remove(request: RemoveRequest): JobStoreOperation<RemoveResult, JobStoreRemoveError>
  pause(request: PauseQueueRequest): JobStoreOperation<QueuePauseResult, JobStorePauseError>
  resume(request: PauseQueueRequest): JobStoreOperation<QueuePauseResult, JobStoreResumeError>
  pausedQueues(): JobStoreOperation<
    readonly import('../protocol').QueueName[],
    JobStorePausedQueuesError
  >
}
