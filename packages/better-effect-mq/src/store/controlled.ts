import { TaggedError } from 'better-result'

import type {
  AnyQueueControlsRegistry,
  ControlsReconcileOptions,
  ControlsReconcileReport,
  QueueControlDefinition
} from '../controls/types'
import type {
  ClaimRequest,
  ClaimResult,
  CancelRequest,
  CancelResult,
  RecoverStalledRequest,
  RecoverStalledResult,
  ReleaseRequest,
  ReleaseResult,
  SettleRequest,
  SettlementResult
} from './types'
import type { JobStoreError } from './errors'
import type { JobId, LeaseToken, QueueName } from '../protocol'

export const controlledProtocolVersion = 3 as const
export const protocolVersionV3 = controlledProtocolVersion
export type ControlledProtocolVersion = typeof controlledProtocolVersion

export const noDispatchKey = '__none__' as const

export interface QueueControlsRecord {
  readonly queue: QueueName
  readonly group: string
  readonly enabled: boolean
  readonly revision: number
  readonly globalConcurrency: number | undefined
  readonly perKeyConcurrency: number | undefined
  readonly rateLimit:
    | {
        readonly max: number
        readonly durationMs: number
      }
    | undefined
  readonly createdAtMs: number
  readonly updatedAtMs: number
}

export interface ControlledClaimOptions {
  readonly controlsRevision: number
}

export type ControlledClaimRequest = ClaimRequest & ControlledClaimOptions

export type ControlledEmptyClaimReason =
  | 'empty'
  | 'paused'
  | 'global-concurrency'
  | 'rate-limited'
  | 'per-key-concurrency'

export interface ControlledEmptyClaim {
  readonly jobs: readonly []
  readonly wakeToken: import('./types').WakeToken
  readonly nextRunAtMs: number | undefined
  readonly nextEligibleAtMs: number | undefined
  readonly reason: ControlledEmptyClaimReason
}

export type ControlledClaimResult = Omit<ClaimResult, 'nextRunAt'> & {
  readonly nextRunAtMs: number | undefined
  readonly nextEligibleAtMs: number | undefined
  readonly reason: ControlledEmptyClaimReason | undefined
}

export type ControlledSettleRequest = SettleRequest & ControlledClaimOptions
export type ControlledSettlementResult = SettlementResult
export type ControlledReleaseRequest = ReleaseRequest & ControlledClaimOptions
export type ControlledRecoverStalledRequest = Omit<RecoverStalledRequest, 'queue'> & {
  readonly queue: QueueName
} & ControlledClaimOptions
export type ControlledCancelRequest = CancelRequest & ControlledClaimOptions

export interface QueueControlsProvider {
  readonly definition: QueueControlDefinition
  readonly record: QueueControlsRecord
}

export interface ControlledJobStoreContract {
  get(
    queue: QueueName
  ): import('./types').JobStoreOperation<QueueControlsRecord | undefined, JobStoreError>
  reconcile(
    registry: AnyQueueControlsRegistry,
    options?: ControlsReconcileOptions
  ): import('./types').JobStoreOperation<ControlsReconcileReport, JobStoreError>
  getControls(request: {
    readonly queue: QueueName
  }): import('./types').JobStoreOperation<QueueControlsRecord | undefined, JobStoreError>
  claimControlled(
    request: ControlledClaimRequest
  ): import('./types').JobStoreOperation<ControlledClaimResult, JobStoreError>
  settleControlled(
    request: ControlledSettleRequest
  ): import('./types').JobStoreOperation<ControlledSettlementResult, JobStoreError>
  releaseControlled(
    request: ControlledReleaseRequest
  ): import('./types').JobStoreOperation<ReleaseResult, JobStoreError>
  recoverStalledControlled(
    request: ControlledRecoverStalledRequest
  ): import('./types').JobStoreOperation<RecoverStalledResult, JobStoreError>
  cancelControlled(
    request: ControlledCancelRequest
  ): import('./types').JobStoreOperation<CancelResult, JobStoreError>
}

export class ControlsRevisionMismatchError extends TaggedError('ControlsRevisionMismatchError')<{
  readonly queue: QueueName
  readonly expected: number
  readonly actual: number | undefined
  readonly message: string
}> {
  constructor(args: {
    readonly queue: QueueName
    readonly expected: number
    readonly actual: number | undefined
  }) {
    super({
      queue: args.queue,
      expected: args.expected,
      actual: args.actual,
      message: `Controls revision mismatch for queue "${args.queue}": expected ${args.expected}, received ${args.actual === undefined ? 'missing' : args.actual}`
    })
  }
}

export type ControlledPermit = {
  readonly jobId: JobId
  readonly queue: QueueName
  readonly dispatchKey: string
  readonly leaseToken: LeaseToken
}

export interface RateWindow {
  readonly startedAtMs: number
  readonly count: number
}

export type ControlledProvider = QueueControlsProvider
