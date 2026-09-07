import type { Result as ResultType } from 'better-result'

import type { AttemptRecordV2, JobRecordV2, JobStateV2, ProtocolVersionV2 } from '../protocol'
import type { FlowMigration } from '../protocol'
import type {
  AckOutboxRequest,
  AckOutboxResult,
  AppendChildReportRequest,
  AppendChildReportResult,
  CancelFlowRequest,
  CancelFlowResult,
  FlowFanOutRequest,
  FlowFanOutResult,
  FlowOutboxPage,
  FlowSnapshot,
  FlowStoreV2,
  MarkCascadedRequest,
  MarkCascadedResult,
  PeekOutboxRequest,
  ReconcileFlowRequest,
  ReconcileFlowResult,
  RecordChildResultsRequest,
  RecordChildResultsResult
} from './flow-v2'
import type {
  JobCounts,
  JobListCursor,
  JobListOrder,
  JobListOrderBy,
  JobStoreCapabilities
} from './types'
import type { JobStoreError } from './errors'

/** Immutable descriptor for the JobStore state machine with flow support. */
export interface JobStoreV2Descriptor {
  readonly protocolVersion: ProtocolVersionV2
  readonly adapter: string
  readonly adapterVersion: string
  readonly layoutVersion: number | string
  readonly migration: FlowMigration
  readonly capabilities: JobStoreCapabilities
}

export type JobStoreV2Error = JobStoreError

export type JobStoreV2Operation<Success> =
  | ResultType<Success, JobStoreV2Error>
  | PromiseLike<ResultType<Success, JobStoreV2Error>>

export interface GetJobV2Request {
  readonly jobId: import('../protocol').JobId
}

export interface GetAttemptsV2Request {
  readonly jobId: import('../protocol').JobId
}

export interface ListJobsV2Request {
  readonly queue?: import('../protocol').QueueName
  readonly name?: import('../protocol').JobName
  readonly version?: number
  readonly state?: JobStateV2 | readonly JobStateV2[]
  readonly metadata?: Readonly<Record<string, string>>
  readonly orderBy?: JobListOrderBy
  readonly order?: JobListOrder
  readonly limit: number
  readonly cursor?: JobListCursor
}

export interface ListJobsV2Result {
  readonly jobs: readonly JobRecordV2[]
  readonly nextCursor: JobListCursor | undefined
}

export interface JobCountsV2 extends JobCounts {
  readonly waitingChildren: number
}

/**
 * The additive v2 surface of a JobStore.
 *
 * Existing `JobStore.Contract` implementations remain valid. A v2-capable
 * store advertises this contract through its `v2` property and therefore
 * cannot be mistaken for a v1 store during the worker handshake.
 */
export interface JobStoreV2Contract {
  readonly descriptor: JobStoreV2Descriptor
  readonly flow: FlowStoreV2

  readonly fanOut: (request: FlowFanOutRequest) => JobStoreV2Operation<FlowFanOutResult>
  readonly recordChildResults: (
    request: RecordChildResultsRequest
  ) => JobStoreV2Operation<RecordChildResultsResult>
  readonly cancelFlow: (request: CancelFlowRequest) => JobStoreV2Operation<CancelFlowResult>
  readonly reconcile: (request: ReconcileFlowRequest) => JobStoreV2Operation<ReconcileFlowResult>
  readonly markCascaded: (request: MarkCascadedRequest) => JobStoreV2Operation<MarkCascadedResult>
  readonly appendChildReport: (
    request: AppendChildReportRequest
  ) => JobStoreV2Operation<AppendChildReportResult>
  readonly peekOutbox: (request: PeekOutboxRequest) => JobStoreV2Operation<FlowOutboxPage>
  readonly ackOutbox: (request: AckOutboxRequest) => JobStoreV2Operation<AckOutboxResult>
  readonly getFlow: (request: {
    readonly flowId: import('../protocol').JobId
  }) => JobStoreV2Operation<FlowSnapshot | undefined>

  readonly getJob: (request: GetJobV2Request) => JobStoreV2Operation<JobRecordV2 | undefined>
  readonly getAttempts: (
    request: GetAttemptsV2Request
  ) => JobStoreV2Operation<readonly AttemptRecordV2[]>
  readonly list: (request: ListJobsV2Request) => JobStoreV2Operation<ListJobsV2Result>
  readonly counts: (request?: {
    readonly queue?: import('../protocol').QueueName
    readonly name?: import('../protocol').JobName
  }) => JobStoreV2Operation<JobCountsV2>
}

/** Namespace spelling retained for consumers that prefer `JobStore.V2`. */
export type JobStoreV2 = JobStoreV2Contract
