import type { Effect } from 'better-effect'

import type {
  OutboxRecord,
  OutboxRecordInput,
  OutboxState,
  SerializedOutboxFailure
} from './OutboxRecord'
import type {
  OutboxDefinitionError,
  OutboxLeaseLostError,
  OutboxNotFoundError,
  OutboxProtocolMismatchError,
  OutboxStoreError,
  OutboxStoreFailure,
  OutboxConflictError
} from './errors'
import type { OutboxId, OutboxLeaseToken, OutboxWorkerId } from './identity'

export type OutboxEffect<Success, Failure extends OutboxStoreError = OutboxStoreError> = Effect<
  Success,
  Failure,
  never
>

export type OutboxOperation<Success, Failure extends OutboxStoreError = OutboxStoreError> =
  | OutboxEffect<Success, Failure>
  | PromiseLike<OutboxEffect<Success, Failure>>

export interface OutboxStoreDescriptor {
  readonly protocolVersion: 1
  readonly adapter: string
  readonly adapterVersion: string
}

export interface OutboxClaimOptions {
  readonly owner: OutboxWorkerId
  readonly limit: number
  readonly leaseDurationMs: number
  readonly nowMs: number
}

export type LeasedOutboxRecord = OutboxRecord & {
  readonly state: 'active'
  readonly leaseOwner: OutboxWorkerId
  readonly leaseToken: OutboxLeaseToken
  readonly leaseExpiresAtMs: number
}

export interface OutboxLeaseRequest {
  readonly id: OutboxId
  readonly leaseToken: OutboxLeaseToken
  readonly nowMs: number
}

export interface OutboxHeartbeatRequest extends OutboxLeaseRequest {
  readonly leaseDurationMs: number
}

export interface OutboxRetryRequest extends OutboxLeaseRequest {
  readonly runAtMs: number
  readonly failure: SerializedOutboxFailure
}

export interface OutboxFailureRequest extends OutboxLeaseRequest {
  readonly failure: SerializedOutboxFailure
}

export interface OutboxRecoveryOptions {
  readonly maxCount: number
  readonly nowMs: number
}

export interface OutboxListOptions {
  readonly state?: OutboxState | readonly OutboxState[]
  readonly target?: string
  readonly limit?: number
}

export interface OutboxCounts {
  readonly pending: number
  readonly active: number
  readonly published: number
  readonly failed: number
  readonly total: number
}

export interface OutboxAppendResult {
  readonly record: OutboxRecord
  readonly duplicate: boolean
}

export interface OutboxSettlementResult {
  readonly record: OutboxRecord
  readonly status: 'applied' | 'already-applied'
}

export type OutboxAppendError = OutboxDefinitionError | OutboxConflictError | OutboxStoreFailure
export type OutboxClaimError = OutboxDefinitionError | OutboxStoreFailure
export type OutboxReadError = OutboxDefinitionError | OutboxNotFoundError | OutboxStoreFailure
export type OutboxLeaseError =
  | OutboxDefinitionError
  | OutboxNotFoundError
  | OutboxLeaseLostError
  | OutboxStoreFailure
export type OutboxSettlementError = OutboxLeaseError
export type OutboxRecoveryError = OutboxDefinitionError | OutboxStoreFailure
export type OutboxStoreProtocolError = OutboxProtocolMismatchError | OutboxDefinitionError

/** Post-commit operations used by the future publisher and storage adapters. */
export interface OutboxStore {
  readonly descriptor: OutboxStoreDescriptor
  claim(
    options: OutboxClaimOptions
  ): OutboxOperation<readonly LeasedOutboxRecord[], OutboxClaimError>
  heartbeat(request: OutboxHeartbeatRequest): OutboxOperation<LeasedOutboxRecord, OutboxLeaseError>
  markPublished(
    request: OutboxLeaseRequest
  ): OutboxOperation<OutboxSettlementResult, OutboxSettlementError>
  markRetry(request: OutboxRetryRequest): OutboxOperation<OutboxRecord, OutboxSettlementError>
  markFailed(request: OutboxFailureRequest): OutboxOperation<OutboxRecord, OutboxSettlementError>
  release(request: OutboxLeaseRequest): OutboxOperation<OutboxRecord, OutboxSettlementError>
  recoverStalled(
    options: OutboxRecoveryOptions
  ): OutboxOperation<readonly OutboxRecord[], OutboxRecoveryError>
  get(id: OutboxId): OutboxOperation<OutboxRecord | undefined, OutboxReadError>
  list(options?: OutboxListOptions): OutboxOperation<readonly OutboxRecord[], OutboxReadError>
  counts(): OutboxOperation<OutboxCounts, OutboxReadError>
}

/** Reference-only append capability; database adapters expose `appendIn` with their real tx type. */
export interface OutboxAppendStore {
  append(input: OutboxRecordInput): OutboxOperation<OutboxAppendResult, OutboxAppendError>
}
