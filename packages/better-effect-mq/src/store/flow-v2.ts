import type { Result as ResultType } from 'better-result'

import type {
  FlowChildRecord,
  FlowChildReport,
  FlowChildSpec,
  FlowMigration,
  FlowOutboxEntry,
  FlowState,
  JobStateV2,
  ProtocolVersionV2,
  SerializedJobFailure
} from '../protocol'
import type { JobId, LeaseToken } from '../protocol'
import type {
  InvalidJobTransitionError,
  JobDefinitionError,
  JobNotFoundError,
  JobStoreFailure,
  LeaseLostError,
  SettlementConflictError
} from '../protocol'
import type { JsonValue } from '../protocol'

export interface FlowStoreV2Descriptor {
  readonly protocolVersion: ProtocolVersionV2
  readonly layoutVersion: number | string
  readonly migration: FlowMigration
}

export type FlowStoreV2Error =
  | JobStoreFailure
  | JobDefinitionError
  | JobNotFoundError
  | InvalidJobTransitionError
  | LeaseLostError
  | SettlementConflictError

export type FlowStoreV2Operation<Success> = ResultType<Success, FlowStoreV2Error>

export type FlowParentState = Extract<
  JobStateV2,
  'active' | 'waiting-children' | 'waiting' | 'completed' | 'failed' | 'cancelled'
>

export interface FlowParentRecord {
  readonly flowId: JobId
  readonly flowName: string
  readonly parentStoreKey: string
  readonly depth: number
  readonly state: FlowParentState
  readonly leaseToken: LeaseToken
  readonly flow: FlowState
  readonly failure: SerializedJobFailure | undefined
}

export interface FlowFanOutRequest {
  readonly flowId: JobId
  readonly flowName: string
  readonly parentStoreKey: string
  readonly depth: number
  readonly leaseToken: LeaseToken
  readonly failFast: boolean
  readonly children: readonly FlowChildSpec[]
  readonly now: number
  readonly maxChildren?: number
}

export interface FlowFanOutResult {
  readonly status: 'applied' | 'already-applied'
  readonly parent: FlowParentRecord
  readonly children: readonly FlowChildRecord[]
}

export interface RecordChildResultsRequest {
  readonly flowId: JobId
  readonly reports: readonly FlowChildReport[]
  readonly now: number
}

export interface RecordChildResultsResult {
  readonly applied: number
  readonly parentSettled: boolean
  readonly parent: FlowParentRecord
  readonly children: readonly FlowChildRecord[]
}

export interface CancelFlowRequest {
  readonly flowId: JobId
  readonly now: number
}

export interface CancelFlowResult {
  readonly cancelled: number
  readonly parentSettled: boolean
  readonly parent: FlowParentRecord
  readonly children: readonly FlowChildRecord[]
}

export type FlowChildObservationState =
  | 'missing'
  | 'waiting'
  | 'delayed'
  | 'active'
  | 'waiting-children'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface FlowChildObservation {
  readonly childKey: string
  readonly state: FlowChildObservationState
  readonly result?: JsonValue
  readonly failure?: SerializedJobFailure
}

export interface ReconcileFlowRequest {
  readonly flowId: JobId
  readonly observations: readonly FlowChildObservation[]
  readonly now: number
  readonly limit?: number
}

export interface ReconcileFlowResult {
  readonly enqueue: readonly FlowChildSpec[]
  readonly reports: readonly FlowChildReport[]
  readonly cascade: readonly FlowChildSpec[]
}

export interface MarkCascadedRequest {
  readonly flowId: JobId
  readonly childKeys: readonly string[]
}

export interface MarkCascadedResult {
  readonly marked: number
  readonly children: readonly FlowChildRecord[]
}

export interface GetFlowRequest {
  readonly flowId: JobId
}

export interface FlowSnapshot {
  readonly parent: FlowParentRecord
  readonly children: readonly FlowChildRecord[]
  readonly outbox: readonly FlowOutboxEntry[]
}

export interface FlowStoreV2 {
  readonly descriptor: FlowStoreV2Descriptor

  fanOut(request: FlowFanOutRequest): FlowStoreV2Operation<FlowFanOutResult>
  recordChildResults(
    request: RecordChildResultsRequest
  ): FlowStoreV2Operation<RecordChildResultsResult>
  cancel(request: CancelFlowRequest): FlowStoreV2Operation<CancelFlowResult>
  reconcile(request: ReconcileFlowRequest): FlowStoreV2Operation<ReconcileFlowResult>
  markCascaded(request: MarkCascadedRequest): FlowStoreV2Operation<MarkCascadedResult>
  getFlow(request: GetFlowRequest): FlowStoreV2Operation<FlowSnapshot | undefined>
}
